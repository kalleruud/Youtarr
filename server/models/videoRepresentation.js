const { Model, DataTypes } = require('sequelize');
const { sequelize } = require('../db');

// One playable copy of a logical episode (issue #14), keyed by the YouTube id
// (#6's stable identity) rather than a second videos row. kind: 'local' |
// 'strm' | 'cache' | 'recording'; variant tells apart several copies of one
// kind (recording revisions). See modules/representation.
class VideoRepresentation extends Model {}
VideoRepresentation.init({
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  youtube_id: { type: DataTypes.STRING(64), allowNull: false },
  kind: { type: DataTypes.STRING(16), allowNull: false },
  variant: { type: DataTypes.STRING(64), allowNull: false, defaultValue: '' },
  state: { type: DataTypes.STRING(16), allowNull: false },
  location: { type: DataTypes.STRING(1024), allowNull: true },
  size_bytes: { type: DataTypes.BIGINT, allowNull: true },
  revision: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
  detail: { type: DataTypes.STRING(255), allowNull: true },
  verified_at: { type: DataTypes.DATE, allowNull: true },
  created_at: { type: DataTypes.DATE, allowNull: false },
  updated_at: { type: DataTypes.DATE, allowNull: false },
}, { sequelize, tableName: 'video_representations', timestamps: false });

module.exports = VideoRepresentation;
