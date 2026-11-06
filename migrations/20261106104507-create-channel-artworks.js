'use strict';

const { createTableIfNotExists, dropTableIfExists } = require('./helpers');

// Additive: one row per channel describing its show poster. Nothing existing
// is altered; a missing row means "automatic, never resolved yet".
module.exports = {
  async up(q, S) {
    await createTableIfNotExists(q, 'channel_artworks', {
      channel_id: { type: S.STRING(191), allowNull: false, primaryKey: true },
      poster_source: { type: S.STRING(16), allowNull: false, defaultValue: 'auto' },
      poster_protected: { type: S.BOOLEAN, allowNull: false, defaultValue: false },
      poster_origin: { type: S.STRING(16), allowNull: true },
      poster_width: { type: S.INTEGER, allowNull: true },
      poster_height: { type: S.INTEGER, allowNull: true },
      poster_revision: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      poster_sha256: { type: S.STRING(64), allowNull: true },
      input_fingerprint: { type: S.STRING(64), allowNull: true },
      published_sha256: { type: S.STRING(64), allowNull: true },
      published_at: { type: S.DATE, allowNull: true },
      publish_note: { type: S.STRING(255), allowNull: true },
      refresh_status: { type: S.STRING(20), allowNull: true },
      refresh_message: { type: S.STRING(500), allowNull: true },
      refresh_attempted_at: { type: S.DATE, allowNull: true },
      updated_at: { type: S.DATE, allowNull: true },
    }, { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' });
  },
  async down(q) {
    await dropTableIfExists(q, 'channel_artworks');
  },
};
