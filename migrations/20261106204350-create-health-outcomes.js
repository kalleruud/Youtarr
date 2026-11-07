'use strict';

const { createTableIfNotExists, dropTableIfExists, addIndexIfMissing } = require('./helpers');

// Additive: one new table holding the latest acquisition-health outcome per
// video and processing stage (issue #18). No existing table or row changes,
// and no foreign keys are added, so it applies the same way on MariaDB 10.3
// and 12.x. Rolling back only drops the diagnostics.
module.exports = {
  async up(q, S) {
    // Binary collation: YouTube video ids are case-sensitive.
    const options = { charset: 'utf8mb4', collate: 'utf8mb4_bin' };
    await createTableIfNotExists(q, 'health_outcomes', {
      id: { type: S.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      youtube_id: { type: S.STRING(20), allowNull: false },
      stage: { type: S.STRING(16), allowNull: false },
      status: { type: S.STRING(16), allowNull: false },
      category: { type: S.STRING(32), allowNull: false },
      reason_code: { type: S.STRING(64), allowNull: true },
      message: { type: S.STRING(500), allowNull: true },
      retryable: { type: S.BOOLEAN, allowNull: false, defaultValue: false },
      attempts: { type: S.INTEGER, allowNull: false, defaultValue: 1 },
      revision: { type: S.INTEGER, allowNull: false, defaultValue: 1 },
      job_id: { type: S.STRING(36), allowNull: true },
      app_version: { type: S.STRING(40), allowNull: true },
      tool_version: { type: S.STRING(40), allowNull: true },
      policy_revision: { type: S.STRING(40), allowNull: true },
      details: { type: S.TEXT, allowNull: true },
      created_at: { type: S.DATE, allowNull: false },
      updated_at: { type: S.DATE, allowNull: false },
    }, options);
    await addIndexIfMissing(q, 'health_outcomes', ['youtube_id', 'stage'], {
      name: 'health_outcome_video_stage_uq', unique: true,
    });
    await addIndexIfMissing(q, 'health_outcomes', ['status', 'updated_at'], {
      name: 'health_outcome_status_updated_idx',
    });
  },
  async down(q) {
    await dropTableIfExists(q, 'health_outcomes');
  },
};
