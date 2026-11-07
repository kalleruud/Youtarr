const { Op, UniqueConstraintError } = require('sequelize');
const { sequelize } = require('../../db');
const AcquisitionPolicy = require('../../models/acquisitionPolicy');
const { POLICY_SCOPES } = require('./policyValues');

const GLOBAL_SUBJECT = 'global';
const ER_LOCK_DEADLOCK = 1213;
// db.js retries every failed query (retry.max with no match). Inside a
// transaction that hides the real error: a deadlock rolls the transaction back,
// so the retried query fails with "rollback has been called on this transaction".
const SINGLE_ATTEMPT = { max: 1 };

class PolicyRevisionConflictError extends Error {
  constructor(currentRevision) {
    super('The policy was changed by someone else. Reload it and try again.');
    this.name = 'PolicyRevisionConflictError';
    this.code = 'REVISION_CONFLICT';
    this.currentRevision = currentRevision;
  }
}

// Two first-time writers raced on the unique (scope, subject_id) key. InnoDB
// reports that either as a duplicate or, when both held the gap lock of the
// missing row, as a deadlock for the loser.
function isCreationRace(err) {
  if (err instanceof UniqueConstraintError) return true;
  const original = err && err.original;
  return Boolean(original) && (original.code === 'ER_LOCK_DEADLOCK' || original.errno === ER_LOCK_DEADLOCK);
}

function toPolicy(row) {
  if (!row) return { delivery: null, live: null, revision: 0, updatedAt: null };
  return {
    delivery: row.delivery_policy ?? null,
    live: row.live_policy ?? null,
    revision: row.revision || 0,
    updatedAt: row.updated_at || null,
  };
}

/**
 * Persistence for explicit acquisition-policy selections. Every change bumps
 * the subject's revision, so callers can detect concurrent edits
 * (expectedRevision) and failures can record which policy they ran under.
 */
class AcquisitionPolicyStore {
  async get(scope, subjectId) {
    const row = await AcquisitionPolicy.findOne({ where: { scope, subject_id: subjectId } });
    return toPolicy(row);
  }

  getGlobal() {
    return this.get(POLICY_SCOPES.GLOBAL, GLOBAL_SUBJECT);
  }

  /**
   * Apply `changes` ({ delivery?, live? }; null clears to inherit, undefined
   * leaves a field alone) and bump the revision, atomically. A write that
   * loses the race to create the row is tried once more against that row.
   * @throws {PolicyRevisionConflictError} when expectedRevision is stale
   */
  async set(scope, subjectId, changes, options = {}) {
    try {
      return await this._write(scope, subjectId, changes, options);
    } catch (err) {
      if (!isCreationRace(err)) throw err;
    }
    // Another writer created the row first; it exists now, so this attempt
    // updates it, or reports a conflict when expectedRevision is now stale.
    try {
      return await this._write(scope, subjectId, changes, options);
    } catch (err) {
      if (isCreationRace(err)) throw new PolicyRevisionConflictError(0);
      throw err;
    }
  }

  _write(scope, subjectId, changes, { expectedRevision, channelId = null }) {
    return sequelize.transaction(async (transaction) => {
      const queryOptions = { transaction, retry: SINGLE_ATTEMPT };
      const where = { scope, subject_id: subjectId };
      const row = await AcquisitionPolicy.findOne({ where, ...queryOptions, lock: transaction.LOCK.UPDATE });
      const currentRevision = row ? row.revision : 0;
      if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
        throw new PolicyRevisionConflictError(currentRevision);
      }
      const values = { updated_at: new Date(), revision: currentRevision + 1 };
      if (changes.delivery !== undefined) values.delivery_policy = changes.delivery;
      if (changes.live !== undefined) values.live_policy = changes.live;
      if (channelId) values.channel_id = channelId;
      if (row) {
        await row.update(values, queryOptions);
        return toPolicy(row);
      }
      const created = await AcquisitionPolicy.create({ ...where, ...values }, queryOptions);
      return toPolicy(created);
    });
  }

  async getChannelPolicies(channelIds) {
    const policies = new Map();
    const ids = [...new Set((channelIds || []).filter(Boolean))];
    if (ids.length === 0) return policies;
    const rows = await AcquisitionPolicy.findAll({
      where: { scope: POLICY_SCOPES.CHANNEL, subject_id: { [Op.in]: ids } },
    });
    for (const row of rows) policies.set(row.subject_id, toPolicy(row));
    return policies;
  }

  async getVideoOverridesForChannels(channelIds) {
    const ids = [...new Set((channelIds || []).filter(Boolean))];
    if (ids.length === 0) return [];
    const rows = await AcquisitionPolicy.findAll({
      where: {
        scope: POLICY_SCOPES.VIDEO,
        channel_id: { [Op.in]: ids },
        [Op.or]: [{ delivery_policy: { [Op.ne]: null } }, { live_policy: { [Op.ne]: null } }],
      },
    });
    return rows.map(row => ({ youtubeId: row.subject_id, channelId: row.channel_id, ...toPolicy(row) }));
  }

  countVideoOverrides() {
    return AcquisitionPolicy.count({
      where: {
        scope: POLICY_SCOPES.VIDEO,
        [Op.or]: [{ delivery_policy: { [Op.ne]: null } }, { live_policy: { [Op.ne]: null } }],
      },
    });
  }
}

const store = new AcquisitionPolicyStore();
store.PolicyRevisionConflictError = PolicyRevisionConflictError;
store.GLOBAL_SUBJECT = GLOBAL_SUBJECT;

module.exports = store;
