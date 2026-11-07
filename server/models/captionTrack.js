const { Model, DataTypes } = require('sequelize');
const { sequelize } = require('../db');

// One row per published caption sidecar (see modules/captions). Required
// directly, not through the models index, like channelArtwork.
class CaptionTrack extends Model {}
CaptionTrack.init({
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  youtube_id: { type: DataTypes.STRING(32), allowNull: false },
  track_code: { type: DataTypes.STRING(40), allowNull: false },
  language: { type: DataTypes.STRING(16), allowNull: false },
  source: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'unknown' },
  origin: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'download' },
  file_path: { type: DataTypes.STRING(1024), allowNull: true },
  media_revision: { type: DataTypes.STRING(64), allowNull: true },
  source_sha256: { type: DataTypes.STRING(64), allowNull: true },
  result_sha256: { type: DataTypes.STRING(64), allowNull: true },
  normalizer_version: { type: DataTypes.INTEGER, allowNull: true },
  retrieved_at: { type: DataTypes.DATE, allowNull: true },
  protected: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  updated_at: { type: DataTypes.DATE, allowNull: true },
}, { sequelize, tableName: 'caption_tracks', timestamps: false });
module.exports = CaptionTrack;
