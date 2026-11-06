'use strict';

const { Sequelize } = require('sequelize');
const migration = require('../20261106203537-create-caption-tracks');
const database = `youtarr_captions_test_${process.pid}`;
const options = { dialect: 'mysql', host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3321), logging: false };

test('caption migration creates, preserves and removes its tables', async () => {
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
    await db.query("INSERT INTO caption_tracks (youtube_id, track_code, language) VALUES ('abcdefghijk', 'en-GB', 'en')");
    await db.query("INSERT INTO caption_enrichment_jobs (youtube_id, baseline_at) VALUES ('abcdefghijk', NOW())");
    await migration.up(q, Sequelize);
    const [tracks] = await db.query('SELECT source, protected FROM caption_tracks');
    const [jobs] = await db.query('SELECT status, attempts, max_attempts FROM caption_enrichment_jobs');
    expect([tracks, jobs]).toEqual([
      [expect.objectContaining({ source: 'unknown', protected: 0 })],
      [expect.objectContaining({ status: 'pending', attempts: 0, max_attempts: 3 })],
    ]);
    await expect(db.query("INSERT INTO caption_tracks (youtube_id, track_code, language) VALUES ('abcdefghijk', 'en-GB', 'en')"))
      .rejects.toThrow();
    await migration.down(q);
    expect(await q.showAllTables()).not.toEqual(expect.arrayContaining(['caption_tracks']));
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
