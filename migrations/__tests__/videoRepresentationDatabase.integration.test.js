'use strict';

const { Sequelize, DataTypes } = require('sequelize');
const migration = require('../20261106204303-create-video-representations');

const database = `youtarr_representation_test_${process.pid}`;
const options = { dialect: 'mysql', host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3321), logging: false };
let admin;
let db;
let store;
let WatchStateCarryover;
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
  store = require('../../server/modules/representation/representationStore');
  WatchStateCarryover = require('../../server/models/watchStateCarryover');
});

afterAll(async () => {
  if (db) await db.close();
  if (admin) {
    if (databaseCreated) await admin.query(`DROP DATABASE \`${database}\``);
    await admin.close();
  }
});

test('additive, repeatable migration keeps existing rows', async () => {
  const [videos] = await db.query('SELECT * FROM videos');
  expect(videos).toHaveLength(1);
});

test('one lease holder at a time, released and expired leases are taken over', async () => {
  const results = await Promise.allSettled([
    store.acquireLease('vidAAAAAAAA', 'download-promotion'),
    store.acquireLease('vidAAAAAAAA', 'stream-publication'),
  ]);
  expect(results.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected']);
  const held = results.find(r => r.status === 'fulfilled').value;
  await store.releaseLease(held);
  const expiring = await store.acquireLease('vidAAAAAAAA', 'eviction', { ttlMs: 1 });
  await new Promise(resolve => setTimeout(resolve, 1100));
  await expect(store.acquireLease('vidAAAAAAAA', 'reconcile')).resolves.toMatchObject({ operation: 'reconcile' });
  await expect(store.record(expiring, { kind: 'local', state: 'verified' })).rejects.toMatchObject({ code: 'LEASE_LOST' });
});

test('revisioned, idempotent and case-sensitive representations', async () => {
  const lower = await store.acquireLease('vidbbbbbbbb', 'download-promotion');
  const upper = await store.acquireLease('vidBBBBBBBB', 'download-promotion');
  const asset = { kind: 'local', state: 'verified', location: '/media/A [vidbbbbbbbb].mp4', sizeBytes: 3000000000, verified: true };
  const first = await store.record(lower, asset);
  const again = await store.record(lower, asset);
  await store.record(upper, { ...asset, location: '/media/A [vidBBBBBBBB].mp4' });
  expect([first.changed, again.changed, again.revision]).toEqual([true, false, 1]);
  expect((await store.list('vidbbbbbbbb')).map(r => [r.kind, r.sizeBytes])).toEqual([['local', 3000000000]]);
  await expect(store.record(lower, { kind: 'strm', state: 'published' }, { expectedRevision: 0 }))
    .rejects.toMatchObject({ code: 'REVISION_CONFLICT', currentRevision: 1 });
  await expect(db.query("INSERT INTO video_representations (youtube_id, kind, variant, state, revision, created_at, updated_at) VALUES ('vidbbbbbbbb','local','','verified',1,NOW(),NOW())"))
    .rejects.toThrow();
});

test('one carryover per video, server and user', async () => {
  const now = new Date();
  const row = { video_id: 1, youtube_id: 'kept', server_type: 'jellyfin', server_user_id: 'u1',
    to_location: '/a.mp4', status: 'pending', created_at: now, updated_at: now };
  await WatchStateCarryover.bulkCreate([row], { updateOnDuplicate: ['status', 'updated_at'] });
  await WatchStateCarryover.bulkCreate([{ ...row, status: 'restored' }], { updateOnDuplicate: ['status', 'updated_at'] });
  expect((await WatchStateCarryover.findAll({ raw: true })).map(r => r.status)).toEqual(['restored']);
});

test('lease expiry follows the database clock', async () => {
  const lease = await store.acquireLease('vidCCCCCCCC', 'eviction');
  const [[{ remaining }]] = await db.query(
    "SELECT TIMESTAMPDIFF(MICROSECOND, UTC_TIMESTAMP(3), lease_expires_at) AS remaining FROM video_representation_heads WHERE youtube_id = 'vidCCCCCCCC'");
  expect(Number(remaining) > 290e6 && Number(remaining) <= 300e6).toBe(true);
  // A lease the database clock says is still valid is busy, whatever this
  // process's clock says; one it says has expired is taken over.
  await db.query("UPDATE video_representation_heads SET lease_expires_at = UTC_TIMESTAMP(3) + INTERVAL 60 SECOND WHERE youtube_id = 'vidCCCCCCCC'");
  await expect(store.acquireLease('vidCCCCCCCC', 'reconcile')).rejects.toMatchObject({ code: 'LEASE_BUSY' });
  await db.query("UPDATE video_representation_heads SET lease_expires_at = UTC_TIMESTAMP(3) - INTERVAL 1 SECOND WHERE youtube_id = 'vidCCCCCCCC'");
  await expect(store.acquireLease('vidCCCCCCCC', 'reconcile')).resolves.toMatchObject({ operation: 'reconcile' });
  await expect(store.renewLease(lease)).rejects.toMatchObject({ code: 'LEASE_LOST' });
});

test('duplicate candidates: published STRM entries with a recorded local copy', async () => {
  const lease = await store.acquireLease('vidDDDDDDDD', 'download-promotion');
  await store.record(lease, { kind: 'strm', state: 'published', location: '/m/A [vidDDDDDDDD].strm' });
  await store.record(lease, { kind: 'local', state: 'verified', location: '/m/A [vidDDDDDDDD].mp4' });
  await store.releaseLease(lease);
  const candidates = await store.listDuplicateCandidates({ findLibraryFiles: async () => new Map() });
  expect(candidates).toEqual([{ youtubeId: 'vidDDDDDDDD', localLocations: ['/m/A [vidDDDDDDDD].mp4'] }]);
});
