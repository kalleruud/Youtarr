const { Model, DataTypes } = require('sequelize');
const { sequelize } = require('../db');

// Watch state to restore on a media server after an episode's published file
// changed (issue #14). One row per (video, server, user); status: 'pending' |
// 'restored' | 'superseded' | 'unsupported' | 'failed'. See
// modules/representation/watchContinuity.js.
class WatchStateCarryover extends Model {}
WatchStateCarryover.init({
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  video_id: { type: DataTypes.INTEGER, allowNull: false },
  youtube_id: { type: DataTypes.STRING(64), allowNull: false },
  server_type: { type: DataTypes.STRING(16), allowNull: false },
  server_user_id: { type: DataTypes.STRING(191), allowNull: false },
  played: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  play_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  position_ms: { type: DataTypes.BIGINT, allowNull: true },
  percent_watched: { type: DataTypes.FLOAT, allowNull: true },
  last_watched_at: { type: DataTypes.DATE, allowNull: true },
  from_location: { type: DataTypes.STRING(1024), allowNull: true },
  to_location: { type: DataTypes.STRING(1024), allowNull: false },
  status: { type: DataTypes.STRING(16), allowNull: false },
  attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  last_error: { type: DataTypes.STRING(255), allowNull: true },
  created_at: { type: DataTypes.DATE, allowNull: false },
  updated_at: { type: DataTypes.DATE, allowNull: false },
}, { sequelize, tableName: 'watch_state_carryovers', timestamps: false });

module.exports = WatchStateCarryover;
