const crypto = require('crypto');
const { Op, UniqueConstraintError, literal } = require('sequelize');
const { sequelize } = require('../../db');
const VideoRepresentation = require('../../models/videoRepresentation');
const VideoRepresentationHead = require('../../models/videoRepresentationHead');
const { KINDS, STATES, LEASE_TTL_MS } = require('./representationValues');

// db.js retries every failed query; inside a transaction that hides the real
// error (see acquisitionPolicyStore), so these queries run once.
const SINGLE_ATTEMPT = { max: 1 };
const LEASE_POLL_MS = 250;
const DEFAULT_LEASE_TTL_MS = 2 * 60 * 1000;

class RepresentationLeaseError extends Error {
  constructor(code, message, holder = null) {
    super(message);
    this.name = 'RepresentationLeaseError';
    this.code = code;
    this.holder = holder;
  }
}

class RepresentationRevisionError extends Error {
  constructor(currentRevision) {
    super('The episode changed since it was previewed. Preview it again and retry.');
    this.name = 'RepresentationRevisionError';
    this.code = 'REVISION_CONFLICT';
    this.currentRevision = currentRevision;
  }
}

// Lease expiry is computed and compared by the database clock, so the server
// and the yt-dlp post-processor (separate processes, possibly with drifting
// clocks) agree on when a lease ran out. UTC_TIMESTAMP does not depend on the
// session time zone (Sequelize sets it to +00:00 anyway).
const DB_NOW = 'UTC_TIMESTAMP(3)';
function dbExpiry(ttlMs) {
  const micros = Math.max(1, Math.round(Number(ttlMs))) * 1000;
  if (!Number.isSafeInteger(micros)) throw new Error('Invalid lease TTL');
  return literal(`${DB_NOW} + INTERVAL ${micros} MICROSECOND`);
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function toRepresentation(row) {
  return {
    id: row.id,
    youtubeId: row.youtube_id,
    kind: row.kind,
    variant: row.variant || '',
    state: row.state,
    location: row.location || null,
    sizeBytes: row.size_bytes == null ? null : Number(row.size_bytes),
    revision: row.revision,
    detail: row.detail || null,
    verifiedAt: row.verified_at || null,
    updatedAt: row.updated_at || null,
  };
}

function sameValues(row, values) {
  return row.state === values.state
    && (row.location || null) === (values.location || null)
    && (row.size_bytes == null ? null : Number(row.size_bytes)) === (values.size_bytes == null ? null : Number(values.size_bytes))
    && (row.detail || null) === (values.detail || null);
}

/**
 * Persistence for episode representations. Every write happens under the
 * episode's publication lease and bumps the episode's revision, so a preview
 * can be checked against what changed since (expectedRevision).
 */
class RepresentationStore {
  // `lease` is informational (status API, LEASE_BUSY holder); lease decisions
  // are made by the conditional updates below, on the database clock.
  async getHead(youtubeId) {
    const head = await VideoRepresentationHead.findByPk(youtubeId);
    return {
      revision: head ? head.revision : 0,
      selectedRepresentationId: head ? head.selected_representation_id : null,
      lease: head && head.lease_owner && head.lease_expires_at > new Date()
        ? { operation: head.lease_operation, expiresAt: head.lease_expires_at }
        : null,
    };
  }

  async list(youtubeId) {
    const rows = await VideoRepresentation.findAll({ where: { youtube_id: youtubeId }, order: [['id', 'ASC']] });
    return rows.map(toRepresentation);
  }

  /**
   * One query over every STRM record. `published`: youtubeId -> location of
   * each published STRM entry. `youtubeIds`: every video that ever had a STRM
   * entry; watch-state carryovers are only ever recorded for these videos.
   * @returns {Promise<{published: Map<string, string>, youtubeIds: Set<string>}>}
   */
  async listStreamEntries() {
    const rows = await VideoRepresentation.findAll({
      where: { kind: KINDS.STRM },
      attributes: ['youtube_id', 'state', 'location'],
      raw: true,
    });
    const published = new Map(rows.filter(row => row.state === STATES.PUBLISHED && row.location)
      .map(row => [row.youtube_id, row.location]));
    return { published, youtubeIds: new Set(rows.map(row => row.youtube_id)) };
  }

  /**
   * Videos that may show two visible entries: a published STRM record and a
   * recorded verified local copy, or a library row with a file that is not
   * marked removed (a download recorded only through the videos table).
   * Two queries over the representation table plus one over the candidate
   * videos; none beyond the first when no STRM entry is published.
   * @param {{findLibraryFiles: function(string[]): Promise<Map<string, string>>}} deps
   *   youtubeId -> filePath of library rows with a file that is not removed
   * @returns {Promise<Array<{youtubeId: string, localLocations: string[]}>>}
   */
  async listDuplicateCandidates({ findLibraryFiles }) {
    const published = await VideoRepresentation.findAll({
      where: { kind: KINDS.STRM, state: STATES.PUBLISHED }, attributes: ['youtube_id'], raw: true,
    });
    const ids = [...new Set(published.map(row => row.youtube_id))];
    if (ids.length === 0) return [];
    const locals = await VideoRepresentation.findAll({
      where: { kind: KINDS.LOCAL, state: STATES.VERIFIED, youtube_id: { [Op.in]: ids } },
      attributes: ['youtube_id', 'location'], raw: true,
    });
    const library = await findLibraryFiles(ids);
    const byId = new Map();
    const add = (youtubeId, location) => {
      if (!location) return;
      if (!byId.has(youtubeId)) byId.set(youtubeId, new Set());
      byId.get(youtubeId).add(location);
    };
    for (const row of locals) add(row.youtube_id, row.location);
    for (const [youtubeId, location] of library) add(youtubeId, location);
    return ids.filter(id => byId.has(id)).map(id => ({ youtubeId: id, localLocations: [...byId.get(id)] }));
  }

  // INSERT IGNORE: a concurrent first caller may create the row too. Outside a
  // transaction, so a lost race is a duplicate (ignored), not a deadlock; one
  // that still deadlocks is tried once more.
  async _ensureHead(youtubeId) {
    const insert = () => VideoRepresentationHead.bulkCreate(
      [{ youtube_id: youtubeId, revision: 0, updated_at: new Date() }],
      { ignoreDuplicates: true, retry: SINGLE_ATTEMPT }
    );
    try {
      await insert();
    } catch (err) {
      if (err instanceof UniqueConstraintError) return;
      if (err.original?.code !== 'ER_LOCK_DEADLOCK') throw err;
      await insert();
    }
  }

  /**
   * Take the episode's publication lease. Waits up to waitMs for another
   * holder; an expired lease (a crashed holder) is taken over.
   * @returns {Promise<{youtubeId: string, owner: string, operation: string}>}
   * @throws {RepresentationLeaseError} code LEASE_BUSY when still held after waitMs
   */
  async acquireLease(youtubeId, operation, { waitMs = 0, ttlMs } = {}) {
    const ttl = ttlMs || LEASE_TTL_MS[operation] || DEFAULT_LEASE_TTL_MS;
    const owner = crypto.randomBytes(16).toString('hex');
    const deadline = Date.now() + waitMs;
    await this._ensureHead(youtubeId);
    for (;;) {
      // lease_owner is new on every attempt, so a successful claim always
      // changes the row (mysql2 counts changed rows, not matched ones).
      const [claimed] = await VideoRepresentationHead.update(
        { lease_owner: owner, lease_operation: operation, lease_expires_at: dbExpiry(ttl), updated_at: literal(DB_NOW) },
        {
          where: {
            youtube_id: youtubeId,
            [Op.or]: [{ lease_owner: null }, { lease_expires_at: null }, { lease_expires_at: { [Op.lt]: literal(DB_NOW) } }],
          },
          retry: SINGLE_ATTEMPT,
        }
      );
      if (claimed === 1) return { youtubeId, owner, operation };
      if (Date.now() >= deadline) {
        const head = await this.getHead(youtubeId);
        throw new RepresentationLeaseError('LEASE_BUSY',
          'Another operation is changing this episode right now. Try again shortly.', head.lease);
      }
      await sleep(LEASE_POLL_MS);
    }
  }

  /**
   * Confirm the caller still owns the lease and extend it, right before a
   * filesystem change: a holder that paused past its lease must not change
   * files after another operation took the episode over.
   *
   * Conditional on the owner only, deliberately not on expiry: an expired
   * lease that nobody took over is still exclusively ours (a takeover writes
   * a new random owner, which this update then no longer matches), so
   * renewing it is as safe as renewing in time. Expiry only decides whether
   * someone else MAY take the lease, in acquireLease.
   * @throws {RepresentationLeaseError} code LEASE_LOST
   */
  async renewLease(lease) {
    const ttl = LEASE_TTL_MS[lease.operation] || DEFAULT_LEASE_TTL_MS;
    const [renewed] = await VideoRepresentationHead.update(
      { lease_expires_at: dbExpiry(ttl), updated_at: literal(DB_NOW) },
      { where: { youtube_id: lease.youtubeId, lease_owner: lease.owner }, retry: SINGLE_ATTEMPT }
    );
    if (renewed === 1) return;
    // mysql2 counts changed rows: a renewal within the same millisecond as
    // the last one changes nothing, so confirm ownership directly.
    const head = await VideoRepresentationHead.findByPk(lease.youtubeId, { retry: SINGLE_ATTEMPT });
    if (!head || head.lease_owner !== lease.owner) {
      throw new RepresentationLeaseError('LEASE_LOST', 'The publication lease was taken over by another operation.');
    }
  }

  async releaseLease(lease) {
    if (!lease) return;
    await VideoRepresentationHead.update(
      { lease_owner: null, lease_operation: null, lease_expires_at: null, updated_at: new Date() },
      { where: { youtube_id: lease.youtubeId, lease_owner: lease.owner }, retry: SINGLE_ATTEMPT }
    );
  }

  // Runs work in a transaction holding the head row, after checking the
  // caller still owns the lease (it may have expired and been taken over).
  // Ownership, not expiry, is checked (as in renewLease): the row lock held
  // until commit blocks a takeover's conditional update, so an owner match
  // here stays true for the whole transaction.
  async _underLease(lease, work, { expectedRevision } = {}) {
    return sequelize.transaction(async (transaction) => {
      const options = { transaction, retry: SINGLE_ATTEMPT };
      const head = await VideoRepresentationHead.findByPk(lease.youtubeId, { ...options, lock: transaction.LOCK.UPDATE });
      if (!head || head.lease_owner !== lease.owner) {
        throw new RepresentationLeaseError('LEASE_LOST', 'The publication lease expired before the change was saved.');
      }
      if (expectedRevision !== undefined && expectedRevision !== head.revision) {
        throw new RepresentationRevisionError(head.revision);
      }
      return work({ head, options });
    });
  }

  /**
   * Create or update one representation. A write that changes nothing keeps
   * both revisions, so repeating a promotion or publication is a no-op.
   * @returns {Promise<{changed: boolean, representation: Object, revision: number}>}
   */
  async record(lease, { kind, variant = '', state, location = null, sizeBytes = null, detail = null, verified = false },
    { expectedRevision } = {}) {
    return this._underLease(lease, async ({ head, options }) => {
      const now = new Date();
      const values = { state, location, size_bytes: sizeBytes, detail };
      const existing = await VideoRepresentation.findOne({
        where: { youtube_id: lease.youtubeId, kind, variant }, ...options, lock: options.transaction.LOCK.UPDATE,
      });
      if (existing && sameValues(existing, values)) {
        return { changed: false, representation: toRepresentation(existing), revision: head.revision };
      }
      const stamp = { ...values, updated_at: now, ...(verified ? { verified_at: now } : {}) };
      let row;
      if (existing) {
        await existing.update({ ...stamp, revision: existing.revision + 1 }, options);
        row = existing;
      } else {
        row = await VideoRepresentation.create({
          youtube_id: lease.youtubeId, kind, variant, revision: 1, created_at: now, ...stamp,
        }, options);
      }
      await head.update({ revision: head.revision + 1, updated_at: now }, options);
      return { changed: true, representation: toRepresentation(row), revision: head.revision };
    }, { expectedRevision });
  }

  /** Explicitly select a representation (or clear the selection with null). */
  async select(lease, representationId, { expectedRevision } = {}) {
    return this._underLease(lease, async ({ head, options }) => {
      if (representationId != null) {
        const row = await VideoRepresentation.findOne({ where: { id: representationId, youtube_id: lease.youtubeId }, ...options });
        if (!row) {
          const err = new Error('That version does not belong to this video.');
          err.code = 'NOT_FOUND';
          throw err;
        }
      }
      if (head.selected_representation_id === representationId) return { changed: false, revision: head.revision };
      await head.update({
        selected_representation_id: representationId, revision: head.revision + 1, updated_at: new Date(),
      }, options);
      return { changed: true, revision: head.revision };
    }, { expectedRevision });
  }
}

const store = new RepresentationStore();
store.RepresentationLeaseError = RepresentationLeaseError;
store.RepresentationRevisionError = RepresentationRevisionError;
store.LEASE_POLL_MS = LEASE_POLL_MS;

module.exports = store;
