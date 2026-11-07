const { Model, DataTypes } = require('sequelize');
const { sequelize } = require('../db');

// Explicit acquisition-policy selections (issue #10). One row per scope
// subject: scope 'global' (subject_id 'global'), 'channel' (subject_id =
// channel id) or 'video' (subject_id = YouTube id, channel_id = its channel).
// A null policy column means "inherit from the next layer".
class AcquisitionPolicy extends Model {}
AcquisitionPolicy.init({
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  scope: { type: DataTypes.STRING(16), allowNull: false },
  subject_id: { type: DataTypes.STRING(191), allowNull: false },
  channel_id: { type: DataTypes.STRING(191), allowNull: true },
  delivery_policy: { type: DataTypes.STRING(32), allowNull: true },
  live_policy: { type: DataTypes.STRING(32), allowNull: true },
  revision: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  updated_at: { type: DataTypes.DATE, allowNull: false },
}, { sequelize, tableName: 'acquisition_policies', timestamps: false });

module.exports = AcquisitionPolicy;
