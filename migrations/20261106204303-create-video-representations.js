'use strict';

const { createTableIfNotExists, dropTableIfExists, addIndexIfMissing } = require('./helpers');

// Additive (issue #14): three new tables around the existing videos row. No
// existing table or row is changed. A video without representation rows keeps
// its pre-#14 behavior: its Videos.filePath (when present) is its local copy.
//
// - video_representations: the playable copies of one logical episode (the
//   YouTube id, #6's stable identity): a verified local file, a STRM entry,
//   a cache or a recording, each with its own state and revision.
// - video_representation_heads: one row per logical episode holding its
//   revision, an explicitly selected representation and the per-video
//   publication lease that serializes download promotion, STRM publication
//   and local eviction across the server and the post-processor processes.
// - watch_state_carryovers: watch state to restore onto a media server's new
//   item after the episode's published file changed (stream -> download).
module.exports = {
  async up(q, S) {
    // Match the database-wide collation convention.
    const options = { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci', rowFormat: 'DYNAMIC' };
    // Only YouTube identities need case-sensitive comparison.
    const youtubeId = { type: S.STRING(64).BINARY, allowNull: false };

    await createTableIfNotExists(q, 'video_representations', {
      id: { type: S.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      youtube_id: youtubeId,
      kind: { type: S.STRING(16), allowNull: false },
      variant: { type: S.STRING(64), allowNull: false, defaultValue: '' },
      state: { type: S.STRING(16), allowNull: false },
      location: { type: S.STRING(1024), allowNull: true },
      size_bytes: { type: S.BIGINT, allowNull: true },
      revision: { type: S.INTEGER, allowNull: false, defaultValue: 1 },
      detail: { type: S.STRING(255), allowNull: true },
      verified_at: { type: S.DATE(3), allowNull: true },
      created_at: { type: S.DATE(3), allowNull: false },
      updated_at: { type: S.DATE(3), allowNull: false },
    }, options);
    await addIndexIfMissing(q, 'video_representations', ['youtube_id', 'kind', 'variant'], {
      name: 'video_representation_kind_uq', unique: true,
    });
    await addIndexIfMissing(q, 'video_representations', ['kind', 'state'], {
      name: 'video_representation_state_idx',
    });

    await createTableIfNotExists(q, 'video_representation_heads', {
      youtube_id: { ...youtubeId, primaryKey: true },
      revision: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      selected_representation_id: { type: S.INTEGER, allowNull: true },
      lease_owner: { type: S.STRING(64), allowNull: true },
      lease_operation: { type: S.STRING(32), allowNull: true },
      lease_expires_at: { type: S.DATE(3), allowNull: true },
      updated_at: { type: S.DATE(3), allowNull: false },
    }, options);

    await createTableIfNotExists(q, 'watch_state_carryovers', {
      id: { type: S.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      video_id: { type: S.INTEGER, allowNull: false },
      youtube_id: youtubeId,
      server_type: { type: S.STRING(16), allowNull: false },
      server_user_id: { type: S.STRING(191), allowNull: false },
      played: { type: S.BOOLEAN, allowNull: false, defaultValue: false },
      play_count: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      position_ms: { type: S.BIGINT, allowNull: true },
      percent_watched: { type: S.FLOAT, allowNull: true },
      last_watched_at: { type: S.DATE(3), allowNull: true },
      from_location: { type: S.STRING(1024), allowNull: true },
      to_location: { type: S.STRING(1024), allowNull: false },
      status: { type: S.STRING(16), allowNull: false },
      attempts: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      last_error: { type: S.STRING(255), allowNull: true },
      created_at: { type: S.DATE(3), allowNull: false },
      updated_at: { type: S.DATE(3), allowNull: false },
    }, options);
    await addIndexIfMissing(q, 'watch_state_carryovers', ['video_id', 'server_type', 'server_user_id'], {
      name: 'watch_state_carryover_subject_uq', unique: true,
    });
    await addIndexIfMissing(q, 'watch_state_carryovers', ['server_type', 'status'], {
      name: 'watch_state_carryover_status_idx',
    });
  },

  async down(q) {
    await dropTableIfExists(q, 'watch_state_carryovers');
    await dropTableIfExists(q, 'video_representation_heads');
    await dropTableIfExists(q, 'video_representations');
  },
};
