'use strict';

const { createTableIfNotExists, dropTableIfExists, addIndexIfMissing } = require('./helpers');

// Additive: one new table holding explicit acquisition-policy selections
// (issue #10). No existing table or row is changed; channels and videos
// without a row keep the pre-policy behavior (download, wait for replay).
module.exports = {
  async up(q, S) {
    // Binary collation: YouTube channel and video ids are case-sensitive.
    const options = { charset: 'utf8mb4', collate: 'utf8mb4_bin' };
    await createTableIfNotExists(q, 'acquisition_policies', {
      id: { type: S.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      scope: { type: S.STRING(16), allowNull: false },
      subject_id: { type: S.STRING(191), allowNull: false },
      channel_id: { type: S.STRING(191), allowNull: true },
      delivery_policy: { type: S.STRING(32), allowNull: true },
      live_policy: { type: S.STRING(32), allowNull: true },
      revision: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      updated_at: { type: S.DATE, allowNull: false },
    }, options);
    await addIndexIfMissing(q, 'acquisition_policies', ['scope', 'subject_id'], {
      name: 'acquisition_policy_subject_uq', unique: true,
    });
    await addIndexIfMissing(q, 'acquisition_policies', ['scope', 'channel_id'], {
      name: 'acquisition_policy_channel_idx',
    });
  },
  async down(q) {
    await dropTableIfExists(q, 'acquisition_policies');
  },
};
