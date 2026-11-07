const { Model, DataTypes } = require('sequelize');
const { sequelize } = require('../db');

// Per logical episode (issue #14): the representation revision, an explicitly
// selected representation, and the publication lease that serializes
// promotion, STRM publication and eviction across processes.
class VideoRepresentationHead extends Model {}
VideoRepresentationHead.init({
  youtube_id: { type: DataTypes.STRING(64), primaryKey: true },
  revision: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  selected_representation_id: { type: DataTypes.INTEGER, allowNull: true },
  lease_owner: { type: DataTypes.STRING(64), allowNull: true },
  lease_operation: { type: DataTypes.STRING(32), allowNull: true },
  lease_expires_at: { type: DataTypes.DATE, allowNull: true },
  updated_at: { type: DataTypes.DATE, allowNull: false },
}, { sequelize, tableName: 'video_representation_heads', timestamps: false });

module.exports = VideoRepresentationHead;
