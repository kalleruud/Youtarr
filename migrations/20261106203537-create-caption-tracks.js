'use strict';

const {
  createTableIfNotExists,
  dropTableIfExists,
  addIndexIfMissing,
} = require('./helpers');

// Additive: caption provenance per published sidecar and durable delayed
// caption checks. No existing table or column is altered and no foreign key
// is declared, so the migration is independent of the videos table's
// collation history and of MariaDB's foreign-key ALTER restrictions.
module.exports = {
  async up(q, S) {
    const tableOptions = { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' };
    await createTableIfNotExists(q, 'caption_tracks', {
      id: { type: S.INTEGER, allowNull: false, primaryKey: true, autoIncrement: true },
      youtube_id: { type: S.STRING(32), allowNull: false },
      track_code: { type: S.STRING(40), allowNull: false },
      language: { type: S.STRING(16), allowNull: false },
      source: { type: S.STRING(16), allowNull: false, defaultValue: 'unknown' },
      origin: { type: S.STRING(16), allowNull: false, defaultValue: 'download' },
      file_path: { type: S.STRING(1024), allowNull: true },
      media_revision: { type: S.STRING(64), allowNull: true },
      source_sha256: { type: S.STRING(64), allowNull: true },
      result_sha256: { type: S.STRING(64), allowNull: true },
      normalizer_version: { type: S.INTEGER, allowNull: true },
      retrieved_at: { type: S.DATE, allowNull: true },
      protected: { type: S.BOOLEAN, allowNull: false, defaultValue: false },
      updated_at: { type: S.DATE, allowNull: true },
    }, tableOptions);
    await addIndexIfMissing(q, 'caption_tracks', ['youtube_id', 'track_code'], {
      unique: true,
      name: 'caption_tracks_video_code',
    });

    await createTableIfNotExists(q, 'caption_enrichment_jobs', {
      id: { type: S.INTEGER, allowNull: false, primaryKey: true, autoIncrement: true },
      youtube_id: { type: S.STRING(32), allowNull: false },
      status: { type: S.STRING(16), allowNull: false, defaultValue: 'pending' },
      reason: { type: S.STRING(500), allowNull: true },
      wanted: { type: S.TEXT, allowNull: true },
      attempts: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      max_attempts: { type: S.INTEGER, allowNull: false, defaultValue: 3 },
      baseline_at: { type: S.DATE, allowNull: false },
      next_attempt_at: { type: S.DATE, allowNull: true },
      last_attempt_at: { type: S.DATE, allowNull: true },
      lease_until: { type: S.DATE, allowNull: true },
      media_revision: { type: S.STRING(64), allowNull: true },
      created_at: { type: S.DATE, allowNull: true },
      updated_at: { type: S.DATE, allowNull: true },
    }, tableOptions);
    await addIndexIfMissing(q, 'caption_enrichment_jobs', ['youtube_id'], {
      unique: true,
      name: 'caption_enrichment_jobs_video',
    });
    await addIndexIfMissing(q, 'caption_enrichment_jobs', ['status', 'next_attempt_at'], {
      name: 'caption_enrichment_jobs_due',
    });
  },

  async down(q) {
    await dropTableIfExists(q, 'caption_enrichment_jobs');
    await dropTableIfExists(q, 'caption_tracks');
  },
};
