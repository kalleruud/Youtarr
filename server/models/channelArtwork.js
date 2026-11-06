const { Model, DataTypes } = require('sequelize');
const { sequelize } = require('../db');

class ChannelArtwork extends Model {}
ChannelArtwork.init({
  channel_id: { type: DataTypes.STRING(191), primaryKey: true },
  poster_source: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'auto' },
  poster_protected: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  poster_origin: { type: DataTypes.STRING(16), allowNull: true },
  poster_width: { type: DataTypes.INTEGER, allowNull: true },
  poster_height: { type: DataTypes.INTEGER, allowNull: true },
  poster_revision: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  poster_sha256: { type: DataTypes.STRING(64), allowNull: true },
  input_fingerprint: { type: DataTypes.STRING(64), allowNull: true },
  published_sha256: { type: DataTypes.STRING(64), allowNull: true },
  published_at: { type: DataTypes.DATE, allowNull: true },
  publish_note: { type: DataTypes.STRING(255), allowNull: true },
  refresh_status: { type: DataTypes.STRING(20), allowNull: true },
  refresh_message: { type: DataTypes.STRING(500), allowNull: true },
  refresh_attempted_at: { type: DataTypes.DATE, allowNull: true },
  updated_at: { type: DataTypes.DATE, allowNull: true },
}, { sequelize, tableName: 'channel_artworks', timestamps: false });
module.exports = ChannelArtwork;
