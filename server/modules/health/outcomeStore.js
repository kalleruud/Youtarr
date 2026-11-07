// Persistence for acquisition-health outcomes (issue #18): one row per
// (video, stage) holding that stage's latest result. Writes are best-effort
// (a database problem is logged, never thrown into a download), redacted and
// size-bounded. Each write bumps `revision`; claimRetry uses it as the
// idempotency key so a double-clicked or replayed retry runs once.
const { Op } = require('sequelize');
const logger = require('../../logger');
const configModule = require('../configModule');
const HealthOutcome = require('../../models/healthOutcome');
const { getVersions } = require('./runtimeVersions');
const { boundMessage, boundReasonCode, boundDetails, parseDetails } = require('./outcomeText');
const {
  STAGE_ORDER, STATUSES, CATEGORIES, CATEGORY_LABELS, YOUTUBE_ID_PATTERN,
} = require('./constants');

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const RETRYABLE_STATUSES = [STATUSES.FAILED, STATUSES.WARNING, STATUSES.PENDING];
const PROBLEM_STATUSES = [STATUSES.FAILED, STATUSES.WARNING, STATUSES.PENDING];
// A retry still waiting to run cannot be claimed again until this long has
// passed, so repeated clicks or a replayed request never queue a storm.
const RETRY_CLAIM_COOLDOWN_MS = 10 * 60 * 1000;

function currentConfig() {
  try {
    return configModule.getConfig() || {};
  } catch {
    return {};
  }
}

function serialize(row) {
  if (!row) return null;
  const value = typeof row.get === 'function' ? row.get({ plain: true }) : row;
  return {
    youtubeId: value.youtube_id,
    stage: value.stage,
    status: value.status,
    category: value.category,
    categoryLabel: CATEGORY_LABELS[value.category] || value.category,
    reasonCode: value.reason_code,
    message: value.message,
    retryable: Boolean(value.retryable),
    attempts: value.attempts,
    revision: value.revision,
    jobId: value.job_id,
    appVersion: value.app_version,
    toolVersion: value.tool_version,
    policyRevision: value.policy_revision,
    details: parseDetails(value.details),
    createdAt: value.created_at,
    updatedAt: value.updated_at,
  };
}

function validate({ youtubeId, stage, status, category }) {
  if (!YOUTUBE_ID_PATTERN.test(String(youtubeId || ''))) return 'invalid youtubeId';
  if (!STAGE_ORDER.includes(stage)) return 'invalid stage';
  if (!Object.values(STATUSES).includes(status)) return 'invalid status';
  if (!Object.values(CATEGORIES).includes(category)) return 'invalid category';
  return null;
}

class OutcomeStore {
  /**
   * Record a stage's latest outcome. Never throws.
   * @returns {Promise<object|null>} The stored outcome, or null when not stored.
   */
  async record(input) {
    const problem = validate(input || {});
    if (problem) {
      logger.warn({ problem, stage: input && input.stage }, 'Health outcome not recorded');
      return null;
    }
    try {
      return await this._upsert(input);
    } catch (err) {
      if (err && err.name === 'SequelizeUniqueConstraintError') {
        // A concurrent writer created the row first; write over it once.
        try {
          return await this._upsert(input);
        } catch (retryErr) {
          logger.warn({ err: retryErr, youtubeId: input.youtubeId, stage: input.stage }, 'Health outcome not recorded');
          return null;
        }
      }
      logger.warn({ err, youtubeId: input.youtubeId, stage: input.stage }, 'Health outcome not recorded');
      return null;
    }
  }

  async _upsert({
    youtubeId, stage, status, category, reasonCode = null, message = null,
    retryable = false, jobId = null, policyRevision = null, details = null,
  }) {
    const config = currentConfig();
    const { appVersion, toolVersion } = getVersions();
    const now = new Date();
    const values = {
      status,
      category,
      reason_code: boundReasonCode(reasonCode),
      message: boundMessage(message, config),
      retryable: Boolean(retryable),
      job_id: jobId ? String(jobId).slice(0, 36) : null,
      app_version: appVersion,
      tool_version: toolVersion,
      policy_revision: policyRevision ? String(policyRevision).slice(0, 40) : null,
      details: boundDetails(details, config),
      updated_at: now,
    };
    const existing = await HealthOutcome.findOne({ where: { youtube_id: youtubeId, stage } });
    if (!existing) {
      const created = await HealthOutcome.create({
        ...values, youtube_id: youtubeId, stage, attempts: status === STATUSES.OK ? 0 : 1, revision: 1, created_at: now,
      });
      return serialize(created);
    }
    // attempts counts consecutive unsuccessful results; success resets it.
    const unsuccessful = status === STATUSES.FAILED || status === STATUSES.WARNING;
    const wasUnsuccessful = existing.status === STATUSES.FAILED || existing.status === STATUSES.WARNING
      || (existing.status === STATUSES.PENDING && existing.reason_code === 'retry-requested');
    values.attempts = unsuccessful ? (wasUnsuccessful ? existing.attempts + 1 : 1) : 0;
    values.revision = existing.revision + 1;
    await existing.update(values);
    return serialize(existing);
  }

  /** Every recorded stage of one video, in pipeline order. */
  async getForVideo(youtubeId) {
    const rows = await HealthOutcome.findAll({ where: { youtube_id: youtubeId } });
    return rows.map(serialize).sort((a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage));
  }

  async getOne(youtubeId, stage) {
    return serialize(await HealthOutcome.findOne({ where: { youtube_id: youtubeId, stage } }));
  }

  /**
   * Most recent outcomes, newest first.
   * @param {object} filters - stage, statuses (array), category, limit, offset
   */
  async list({ stage, statuses, category, limit = DEFAULT_LIST_LIMIT, offset = 0 } = {}) {
    const where = {};
    if (stage) where.stage = stage;
    if (category) where.category = category;
    where.status = { [Op.in]: Array.isArray(statuses) && statuses.length ? statuses : PROBLEM_STATUSES };
    const boundedLimit = Math.min(Math.max(Number(limit) || DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);
    const { rows, count } = await HealthOutcome.findAndCountAll({
      where,
      order: [['updated_at', 'DESC'], ['id', 'DESC']],
      limit: boundedLimit,
      offset: Math.max(Number(offset) || 0, 0),
    });
    return { outcomes: rows.map(serialize), total: count };
  }

  /** Counts of unresolved outcomes per stage, status and category. */
  async countProblems() {
    const rows = await HealthOutcome.findAll({
      attributes: ['stage', 'status', 'category', [HealthOutcome.sequelize.fn('COUNT', HealthOutcome.sequelize.col('id')), 'count']],
      where: { status: { [Op.in]: PROBLEM_STATUSES } },
      group: ['stage', 'status', 'category'],
      raw: true,
    });
    return rows.map((row) => ({ stage: row.stage, status: row.status, category: row.category, count: Number(row.count) || 0 }));
  }

  /** Outcomes of one stage for the given videos, keyed by YouTube id. */
  async getStageForVideos(youtubeIds, stage) {
    const ids = [...new Set((youtubeIds || []).filter((id) => YOUTUBE_ID_PATTERN.test(String(id))))];
    if (!ids.length) return new Map();
    const rows = await HealthOutcome.findAll({ where: { youtube_id: { [Op.in]: ids }, stage } });
    return new Map(rows.map((row) => [row.youtube_id, serialize(row)]));
  }

  /**
   * Compare-and-set claim for a per-step retry: succeeds for exactly one
   * caller holding the current revision of a retryable, unresolved outcome.
   * @returns {Promise<object|null>} The claimed outcome, or null.
   */
  async claimRetry({ youtubeId, stage, expectedRevision }) {
    const [affected] = await HealthOutcome.update({
      status: STATUSES.PENDING,
      reason_code: 'retry-requested',
      message: 'Retry requested; waiting for the step to run again.',
      revision: HealthOutcome.sequelize.literal('revision + 1'),
      updated_at: new Date(),
    }, {
      where: {
        youtube_id: youtubeId,
        stage,
        revision: expectedRevision,
        retryable: true,
        status: { [Op.in]: RETRYABLE_STATUSES },
        [Op.or]: [
          { reason_code: null },
          { reason_code: { [Op.ne]: 'retry-requested' } },
          { updated_at: { [Op.lt]: new Date(Date.now() - RETRY_CLAIM_COOLDOWN_MS) } },
        ],
      },
    });
    if (affected !== 1) return null;
    return this.getOne(youtubeId, stage);
  }
}

const store = new OutcomeStore();
store.serialize = serialize;
store.PROBLEM_STATUSES = PROBLEM_STATUSES;
store.RETRY_CLAIM_COOLDOWN_MS = RETRY_CLAIM_COOLDOWN_MS;
module.exports = store;
