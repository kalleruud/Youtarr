const { Model, DataTypes } = require('sequelize');
const { sequelize } = require('../db');

class EpisodeShow extends Model {}
EpisodeShow.init({
  channel_id: { type: DataTypes.STRING(191), primaryKey: true },
}, { sequelize, tableName: 'episode_shows', timestamps: false });
module.exports = EpisodeShow;
