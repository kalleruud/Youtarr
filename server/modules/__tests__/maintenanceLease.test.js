/* eslint-env jest */
jest.mock('../../logger');

const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const { MaintenanceLease } = require('../maintenanceLease');

let root;
let leasePath;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'lease-'));
  leasePath = path.join(root, 'config', 'maintenance-lease.json');
});

afterEach(async () => {
  await fs.remove(root);
});

test('starts inactive', () => {
  expect(new MaintenanceLease({ leasePath }).isActive()).toBe(false);
});

test('is persisted and read back by a new instance', () => {
  new MaintenanceLease({ leasePath }).acquire('owner-a', 'moving files');
  expect(new MaintenanceLease({ leasePath }).current()).toMatchObject({ owner: 'owner-a', reason: 'moving files' });
});

test('refuses another owner', () => {
  const lease = new MaintenanceLease({ leasePath });
  lease.acquire('owner-a', 'moving files');
  expect(() => lease.acquire('owner-b', 'other')).toThrow(expect.objectContaining({ code: 'MAINTENANCE_ACTIVE' }));
});

test('gives the same owner its token back', () => {
  const lease = new MaintenanceLease({ leasePath });
  expect(lease.acquire('owner-a', 'x')).toBe(lease.acquire('owner-a', 'x'));
});

test('release removes the file and emits released', () => {
  const lease = new MaintenanceLease({ leasePath });
  const released = jest.fn();
  lease.on('released', released);
  lease.acquire('owner-a', 'x');
  lease.release('owner-a');
  expect([fs.existsSync(leasePath), released.mock.calls.length]).toEqual([false, 1]);
});

test('release by another owner keeps the lease', () => {
  const lease = new MaintenanceLease({ leasePath });
  lease.acquire('owner-a', 'x');
  expect([lease.release('owner-b'), lease.isActive()]).toEqual([false, true]);
});

test('describe names the reason', () => {
  const lease = new MaintenanceLease({ leasePath });
  lease.acquire('owner-a', 'TV library migration is moving files');
  expect(lease.describe()).toBe('A library maintenance task is running: TV library migration is moving files');
});

test('refuses migration throughout a suspended writer and allows retry after failure', async () => {
  const lease = new MaintenanceLease({ leasePath });
  let reject;
  const pending = lease.runOperation(() => new Promise((resolve, fail) => { reject = fail; }));
  expect(() => lease.acquire('migration', 'move')).toThrow(/writes are in progress/);
  reject(new Error('delete failed'));
  await expect(pending).rejects.toThrow('delete failed');
  expect(lease.acquire('migration', 'move')).toBeTruthy();
});

test('held migration rejects writer before it starts and release permits entry', async () => {
  const lease = new MaintenanceLease({ leasePath });
  const write = jest.fn();
  lease.acquire('migration', 'move');
  await expect(lease.runOperation(write)).rejects.toThrow(/maintenance/);
  expect(write).not.toHaveBeenCalled();
  lease.release('migration');
  await lease.runOperation(write);
  expect(write).toHaveBeenCalledTimes(1);
});

test('nested detached work remains tracked after its parent returns', async () => {
  const lease = new MaintenanceLease({ leasePath });
  let finish;
  let child;
  await lease.runOperation(async () => {
    child = lease.runOperation(() => new Promise((resolve) => { finish = resolve; }));
  });
  expect(() => lease.acquire('migration', 'move')).toThrow(/writes are in progress/);
  finish();
  await child;
  expect(lease.acquire('migration', 'move')).toBeTruthy();
});

test('only the current owner can publish within its held lease', async () => {
  const lease = new MaintenanceLease({ leasePath });
  lease.acquire('migration', 'moving');
  await expect(lease.runAsOwner('migration', () => lease.runOperation(async () => 'published'))).resolves.toBe('published');
  expect(() => lease.runAsOwner('other', () => {})).toThrow(/ownership/);
});
