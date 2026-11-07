'use strict';

const { Sequelize, DataTypes } = require('sequelize');
const migration = require('../20261106204350-create-health-outcomes');

// Only the database is under test; outcome text redaction reads the config.
jest.mock('../../server/modules/configModule', () => ({ getConfig: () => ({}) }));

const database = `youtarr_health_test_${process.pid}`;
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
  store = require('../../server/modules/health/outcomeStore');
});

afterAll(async () => {
  if (db) await db.close();
  if (admin) {
    if (databaseCreated) await admin.query(`DROP DATABASE \`${database}\``);
    await admin.close();
  }
});

test('additive migration keeps existing rows and stores one revisioned, case-sensitive outcome per stage', async () => {
  const [videos] = await db.query('SELECT * FROM videos');
  expect(videos).toHaveLength(1);

  await store.record({ youtubeId: 'abcdefghijk', stage: 'library', status: 'pending', category: 'scan-pending', retryable: true });
  await store.record({ youtubeId: 'ABCDEFGHIJK', stage: 'library', status: 'ok', category: 'ok' });
  await store.record({ youtubeId: 'abcdefghijk', stage: 'library', status: 'failed', category: 'application-failure', retryable: true });
  expect(await store.getOne('abcdefghijk', 'library')).toMatchObject({ status: 'failed', revision: 2, attempts: 1 });
  expect(await store.getOne('ABCDEFGHIJK', 'library')).toMatchObject({ status: 'ok', revision: 1 });

  await expect(db.query(
    "INSERT INTO health_outcomes (youtube_id, stage, status, category, created_at, updated_at) VALUES ('abcdefghijk','library','ok','ok',NOW(),NOW())"
  )).rejects.toThrow();
});

test('concurrent retries with the same revision are claimed exactly once', async () => {
  await store.record({ youtubeId: 'zzzzzzzzzzz', stage: 'acquisition', status: 'failed', category: 'abandoned', retryable: true });
  const { revision } = await store.getOne('zzzzzzzzzzz', 'acquisition');
  const claims = await Promise.all([1, 2, 3].map(() => store.claimRetry({ youtubeId: 'zzzzzzzzzzz', stage: 'acquisition', expectedRevision: revision })));
  expect(claims.filter(Boolean)).toHaveLength(1);
  // A claimed retry cannot be claimed again during its cooldown, even with the new revision.
  await expect(store.claimRetry({ youtubeId: 'zzzzzzzzzzz', stage: 'acquisition', expectedRevision: revision + 1 })).resolves.toBeNull();
});

test('non-retryable outcomes cannot be claimed', async () => {
  await store.record({ youtubeId: 'yyyyyyyyyyy', stage: 'acquisition', status: 'failed', category: 'source-unavailable', retryable: false });
  await expect(store.claimRetry({ youtubeId: 'yyyyyyyyyyy', stage: 'acquisition', expectedRevision: 1 })).resolves.toBeNull();
});

test('problem counts and listing exclude resolved outcomes', async () => {
  const counts = await store.countProblems();
  expect(counts.find((c) => c.category === 'scan-pending')).toBeUndefined();
  const { outcomes } = await store.list({ limit: 10 });
  expect(outcomes.every((o) => o.status !== 'ok')).toBe(true);
});
