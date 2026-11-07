const { Model, DataTypes } = require('sequelize');
const { sequelize } = require('../db');

// Durable acquisition-health outcome (issue #18): the latest result of one
// processing stage (acquisition, captions, publication, library) for one
// video. Every write bumps `revision`, which per-step retries use as their
// idempotency key. Messages and details are redacted and size-bounded before
// they are stored.
class HealthOutcome extends Model {}
HealthOutcome.init({
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  youtube_id: { type: DataTypes.STRING(20), allowNull: false },
  stage: { type: DataTypes.STRING(16), allowNull: false },
  status: { type: DataTypes.STRING(16), allowNull: false },
  category: { type: DataTypes.STRING(32), allowNull: false },
  reason_code: { type: DataTypes.STRING(64), allowNull: true },
  message: { type: DataTypes.STRING(500), allowNull: true },
  retryable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
  revision: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
  job_id: { type: DataTypes.STRING(36), allowNull: true },
  app_version: { type: DataTypes.STRING(40), allowNull: true },
  tool_version: { type: DataTypes.STRING(40), allowNull: true },
  policy_revision: { type: DataTypes.STRING(40), allowNull: true },
  details: { type: DataTypes.TEXT, allowNull: true },
  created_at: { type: DataTypes.DATE, allowNull: false },
  updated_at: { type: DataTypes.DATE, allowNull: false },
}, { sequelize, tableName: 'health_outcomes', timestamps: false });

module.exports = HealthOutcome;
