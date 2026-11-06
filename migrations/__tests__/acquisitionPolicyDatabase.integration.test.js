'use strict';

const { Sequelize, DataTypes } = require('sequelize');
const migration = require('../20261106104340-create-acquisition-policies');

const database = `youtarr_acquisition_test_${process.pid}`;
const options = { dialect: 'mysql', host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3321), logging: false };
let admin;
let db;
let store;
let databaseCreated = false;

beforeAll(async () => {
  admin = new Sequelize('mysql', process.env.DB_ADMIN_USER || process.env.DB_USER || 'root',
    process.env.DB_ADMIN_PASSWORD || process.env.DB_PASSWORD || '123qweasd', options);
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  databaseCreated = true;
  process.env.DB_NAME = database;
  db = require('../../server/db').sequelize;
  const q = db.getQueryInterface();
  await q.createTable('videos', { id: { type: DataTypes.INTEGER, primaryKey: true }, youtubeId: DataTypes.STRING });
  await db.query("INSERT INTO videos VALUES (1,'kept')");
  await migration.up(q, Sequelize);
  await migration.up(q, Sequelize);
  store = require('../../server/modules/acquisition/acquisitionPolicyStore');
});

afterAll(async () => {
  if (db) await db.close();
  if (admin) {
    if (databaseCreated) await admin.query(`DROP DATABASE \`${database}\``);
    await admin.close();
  }
});

test('additive migration keeps existing rows and persists revisioned, case-sensitive selections', async () => {
  const [videos] = await db.query('SELECT * FROM videos');
  expect(videos).toHaveLength(1);

  await store.set('channel', 'UCabc', { delivery: 'stream' });
  await store.set('channel', 'UCABC', { live: 'ignore' });
  expect(await store.get('channel', 'UCabc')).toMatchObject({ delivery: 'stream', live: null, revision: 1 });
  expect(await store.get('channel', 'UCABC')).toMatchObject({ delivery: null, live: 'ignore', revision: 1 });

  const results = await Promise.allSettled([
    store.set('channel', 'UCabc', { live: 'record' }, { expectedRevision: 1 }),
    store.set('channel', 'UCabc', { live: 'play' }, { expectedRevision: 1 }),
  ]);
  expect(results.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected']);
  expect(await store.get('channel', 'UCabc')).toMatchObject({ revision: 2 });

  const firstWrites = await Promise.allSettled([
    store.set('channel', 'UCnew', { delivery: 'stream' }),
    store.set('channel', 'UCnew', { delivery: 'download' }),
  ]);
  const rejected = firstWrites.filter(r => r.status === 'rejected');
  expect(rejected.every(r => r.reason.code === 'REVISION_CONFLICT')).toBe(true);
  expect((await store.get('channel', 'UCnew')).revision).toBe(2 - rejected.length);

  await store.set('video', 'aaaaaaaaaaa', { delivery: 'download' }, { channelId: 'UCabc' });
  await store.set('video', 'bbbbbbbbbbb', { delivery: null }, { channelId: 'UCabc' });
  expect((await store.getVideoOverridesForChannels(['UCabc'])).map(o => o.youtubeId)).toEqual(['aaaaaaaaaaa']);
  expect(await store.countVideoOverrides()).toBe(1);

  await expect(db.query("INSERT INTO acquisition_policies (scope, subject_id, revision, updated_at) VALUES ('channel','UCabc',9,NOW())")).rejects.toThrow();
});
