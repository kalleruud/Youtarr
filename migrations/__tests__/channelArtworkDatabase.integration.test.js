'use strict';

const { Sequelize } = require('sequelize');
const migration = require('../20261106104507-create-channel-artworks');
const database = `youtarr_artwork_test_${process.pid}`;
const options = { dialect: 'mysql', host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3321), logging: false };

test('channel artwork migration creates, preserves and removes its table', async () => {
  const admin = new Sequelize('mysql', process.env.DB_ADMIN_USER || process.env.DB_USER || 'root',
    process.env.DB_ADMIN_PASSWORD || process.env.DB_PASSWORD || '123qweasd', options);
  let db;
  let databaseCreated = false;
  try {
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    databaseCreated = true;
    db = new Sequelize(database, process.env.DB_USER || 'root', process.env.DB_PASSWORD || '123qweasd', options);
    const q = db.getQueryInterface();
    await migration.up(q, Sequelize);
    await db.query("INSERT INTO channel_artworks (channel_id) VALUES ('UC1')");
    await migration.up(q, Sequelize);
    const [rows] = await db.query("SELECT poster_source, poster_revision FROM channel_artworks WHERE channel_id = 'UC1'");
    expect(rows).toEqual([expect.objectContaining({ poster_source: 'auto', poster_revision: 0 })]);
    await migration.down(q);
    expect(await q.showAllTables()).not.toContain('channel_artworks');
    await migration.down(q);
  } finally {
    if (db) await db.close();
    try {
      if (databaseCreated) await admin.query(`DROP DATABASE \`${database}\``);
    } finally {
      await admin.close();
    }
  }
});
