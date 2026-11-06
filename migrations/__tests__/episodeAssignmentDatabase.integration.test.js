'use strict';

const { Sequelize, DataTypes } = require('sequelize');
const migration = require('../20261106084206-create-episode-assignments');
const database = `youtarr_episode_test_${process.pid}`;
const options = { dialect: 'mysql', host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3321), logging: false };
let admin;
let db;
let allocator;
let databaseCreated = false;

beforeAll(async () => {
  admin = new Sequelize('mysql', process.env.DB_ADMIN_USER || process.env.DB_USER || 'root',
    process.env.DB_ADMIN_PASSWORD || process.env.DB_PASSWORD || '123qweasd', options);
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  databaseCreated = true;
  process.env.DB_NAME = database;
  db = require('../../server/db').sequelize;
  const q = db.getQueryInterface();
  await q.createTable('channels', { id: { type: DataTypes.INTEGER, primaryKey: true }, channel_id: DataTypes.STRING, title: DataTypes.STRING });
  await q.createTable('channelvideos', { id: { type: DataTypes.INTEGER, primaryKey: true }, youtube_id: DataTypes.STRING,
    channel_id: DataTypes.STRING, published_at: DataTypes.STRING, published_at_source: DataTypes.STRING });
  await q.createTable('videos', { id: { type: DataTypes.INTEGER, primaryKey: true }, youtubeId: DataTypes.STRING });
  await q.createTable('jobvideos', { id: { type: DataTypes.INTEGER, primaryKey: true }, video_id: DataTypes.INTEGER });
  await db.query("INSERT INTO channels VALUES (1,'UC1','old'),(2,'UC1','new')");
  await db.query("INSERT INTO videos VALUES (1,'a')");
  await db.query('INSERT INTO jobvideos VALUES (1,1)');
  await db.query("INSERT INTO channelvideos VALUES (1,'b','UC1','2021-01-01','exact'),(2,'a','UC1','2021-01-01','exact'),(3,'a','UC1','2021-01-01','exact'),(4,'other-case','uc1','2020-01-01','exact')");
  await migration.up(q, Sequelize);
  await migration.up(q, Sequelize);
  allocator = require('../../server/modules/episodeAssignment');
});

afterAll(async () => {
  if (db) await db.close();
  if (admin) {
    if (databaseCreated) await admin.query(`DROP DATABASE \`${database}\``);
    await admin.close();
  }
});

test('additive migration preserves legacy data and concurrent allocations serialize across duplicate channel rows', async () => {
  const get = youtubeId => allocator.ensureEpisodeAssignment({ channelId: 'UC1', youtubeId });
  const results = await Promise.all([get('a'), get('b'), get('a'), get('b')]);
  expect(results.map(x => x.episode)).toEqual([1, 2, 1, 2]);
  const [otherCase] = await db.query("SELECT * FROM episode_assignments WHERE youtube_id='other-case'");
  expect(otherCase).toHaveLength(0);
  const [rows] = await db.query('SELECT * FROM videos');
  const [history] = await db.query('SELECT * FROM jobvideos');
  expect(rows).toHaveLength(1);
  expect(history).toHaveLength(1);
  await db.query("UPDATE channels SET title='renamed'");
  expect((await get('a')).episode).toBe(1);
  await db.query("UPDATE channelvideos SET published_at='2022-02-01' WHERE youtube_id='a'");
  expect(await allocator.getStatus('a')).toMatchObject({ status: 'date-correction-review', season: 2021, episode: 1 });
  expect(await allocator.ensureEpisodeAssignment({ channelId: 'UC1', youtubeId: 'live', publishedAt: '2021-03-01', source: 'estimated' })).toMatchObject({ status: 'date-required' });
  const live = await allocator.ensureEpisodeAssignment({ channelId: 'UC1', youtubeId: 'live', publishedAt: '2021-03-01', source: 'exact' });
  const replay = await allocator.ensureEpisodeAssignment({ channelId: 'UC1', youtubeId: 'live', publishedAt: '2021-03-01', source: 'exact' });
  expect(replay).toMatchObject({ season: live.season, episode: live.episode });
  await expect(db.query("INSERT INTO episode_assignments (youtube_id, channel_id, season, episode, published_at, assignment_version) VALUES ('other','UC1',2021,1,'2021-01-01',1)")).rejects.toThrow();
});
