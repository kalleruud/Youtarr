const { Model, DataTypes } = require('sequelize');
const { sequelize } = require('../db');

// One durable delayed-caption check per video (see modules/captions).
class CaptionEnrichmentJob extends Model {}
CaptionEnrichmentJob.init({
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  youtube_id: { type: DataTypes.STRING(32), allowNull: false },
  status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'pending' },
  reason: { type: DataTypes.STRING(500), allowNull: true },
  wanted: { type: DataTypes.TEXT, allowNull: true },
  attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  max_attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 3 },
  baseline_at: { type: DataTypes.DATE, allowNull: false },
  next_attempt_at: { type: DataTypes.DATE, allowNull: true },
  last_attempt_at: { type: DataTypes.DATE, allowNull: true },
  lease_until: { type: DataTypes.DATE, allowNull: true },
  media_revision: { type: DataTypes.STRING(64), allowNull: true },
  created_at: { type: DataTypes.DATE, allowNull: true },
  updated_at: { type: DataTypes.DATE, allowNull: true },
}, { sequelize, tableName: 'caption_enrichment_jobs', timestamps: false });
module.exports = CaptionEnrichmentJob;
