const { Model, DataTypes } = require('sequelize');
const { sequelize } = require('../db');

class EpisodeAssignment extends Model {}
EpisodeAssignment.init({
  youtube_id: { type: DataTypes.STRING(191), primaryKey: true },
  channel_id: { type: DataTypes.STRING(191), allowNull: false },
  season: { type: DataTypes.INTEGER, allowNull: false },
  episode: { type: DataTypes.INTEGER, allowNull: false },
  published_at: { type: DataTypes.STRING(64), allowNull: false },
  published_at_source: { type: DataTypes.STRING(20), allowNull: true },
  assignment_version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
}, { sequelize, tableName: 'episode_assignments', timestamps: false });
module.exports = EpisodeAssignment;
