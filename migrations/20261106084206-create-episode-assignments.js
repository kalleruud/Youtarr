'use strict';

const { createTableIfNotExists, dropTableIfExists, addIndexIfMissing } = require('./helpers');

module.exports = {
  async up(q, S) {
    const identity = { type: S.STRING(191), allowNull: false };
    const options = { charset: 'utf8mb4', collate: 'utf8mb4_bin' };
    await createTableIfNotExists(q, 'episode_shows', {
      channel_id: { ...identity, primaryKey: true },
    }, options);
    await createTableIfNotExists(q, 'episode_assignments', {
      youtube_id: { ...identity, primaryKey: true },
      channel_id: identity,
      season: { type: S.INTEGER, allowNull: false },
      episode: { type: S.INTEGER, allowNull: false },
      published_at: { type: S.STRING(64), allowNull: false },
      published_at_source: { type: S.STRING(20), allowNull: true },
      assignment_version: { type: S.INTEGER, allowNull: false, defaultValue: 1 },
    }, options);
    await addIndexIfMissing(q, 'episode_assignments', ['channel_id', 'season', 'episode'], {
      name: 'episode_assignment_number_uq', unique: true,
    });
  },
  async down(q) {
    await dropTableIfExists(q, 'episode_assignments');
    await dropTableIfExists(q, 'episode_shows');
  },
};
