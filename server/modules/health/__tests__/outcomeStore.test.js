jest.mock('../../../logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() }));
jest.mock('../../configModule', () => ({ getConfig: jest.fn(() => ({ embyApiKey: 'emby-secret-12345' })) }));
jest.mock('../runtimeVersions', () => ({ getVersions: jest.fn(() => ({ appVersion: '1.90.2', toolVersion: '2026.10.01' })) }));
jest.mock('../../../models/healthOutcome', () => ({
  findOne: jest.fn(),
  create: jest.fn(),
  findAll: jest.fn(),
  findAndCountAll: jest.fn(),
  update: jest.fn(),
  sequelize: { literal: jest.fn((v) => v), fn: jest.fn(), col: jest.fn() },
}));

const HealthOutcome = require('../../../models/healthOutcome');
const store = require('../outcomeStore');

const base = { youtubeId: 'abcdefghijk', stage: 'captions', status: 'warning', category: 'application-failure', message: 'failed with emby-secret-12345' };

function existingRow(values) {
  const row = { ...values, update: jest.fn(async (changes) => Object.assign(row, changes)) };
  row.get = () => row;
  return row;
}

beforeEach(() => {
  jest.clearAllMocks();
  HealthOutcome.create.mockImplementation(async (values) => ({ ...values }));
});

test('a first outcome is created with revision 1, versions and a redacted message', async () => {
  HealthOutcome.findOne.mockResolvedValue(null);
  const stored = await store.record(base);
  expect(stored).toMatchObject({ revision: 1, attempts: 1, appVersion: '1.90.2', toolVersion: '2026.10.01' });
  expect(stored.message).not.toContain('emby-secret-12345');
});

test('a repeated failure bumps the revision and counts attempts', async () => {
  const row = existingRow({ youtube_id: base.youtubeId, stage: 'captions', status: 'warning', attempts: 2, revision: 4 });
  HealthOutcome.findOne.mockResolvedValue(row);
  const stored = await store.record(base);
  expect([stored.revision, stored.attempts]).toEqual([5, 3]);
});

test('success resets the attempt count', async () => {
  const row = existingRow({ youtube_id: base.youtubeId, stage: 'captions', status: 'warning', attempts: 2, revision: 4 });
  HealthOutcome.findOne.mockResolvedValue(row);
  const stored = await store.record({ ...base, status: 'ok', category: 'ok' });
  expect(stored.attempts).toBe(0);
});

test('invalid input is not stored', async () => {
  await expect(store.record({ ...base, stage: 'bogus' })).resolves.toBeNull();
  expect(HealthOutcome.findOne).not.toHaveBeenCalled();
});

test('a database error never reaches the caller', async () => {
  HealthOutcome.findOne.mockRejectedValue(new Error('db down'));
  await expect(store.record(base)).resolves.toBeNull();
});

test('a concurrent create is written over once', async () => {
  HealthOutcome.findOne.mockResolvedValueOnce(null)
    .mockResolvedValueOnce(existingRow({ youtube_id: base.youtubeId, stage: 'captions', status: 'ok', attempts: 0, revision: 1 }));
  HealthOutcome.create.mockRejectedValueOnce(Object.assign(new Error('dup'), { name: 'SequelizeUniqueConstraintError' }));
  const stored = await store.record(base);
  expect(stored.revision).toBe(2);
});

test('claimRetry succeeds only when exactly one row matched the revision', async () => {
  HealthOutcome.update.mockResolvedValueOnce([0]);
  await expect(store.claimRetry({ youtubeId: base.youtubeId, stage: 'library', expectedRevision: 3 })).resolves.toBeNull();
  const where = HealthOutcome.update.mock.calls[0][1].where;
  expect(where).toMatchObject({ youtube_id: base.youtubeId, stage: 'library', revision: 3, retryable: true });
});

test('claimRetry returns the claimed outcome', async () => {
  HealthOutcome.update.mockResolvedValueOnce([1]);
  HealthOutcome.findOne.mockResolvedValue(existingRow({ youtube_id: base.youtubeId, stage: 'library', status: 'pending', revision: 4 }));
  await expect(store.claimRetry({ youtubeId: base.youtubeId, stage: 'library', expectedRevision: 3 })).resolves.toMatchObject({ revision: 4, status: 'pending' });
});

test('getForVideo lists stages in pipeline order', async () => {
  HealthOutcome.findAll.mockResolvedValue(['library', 'acquisition', 'captions'].map((stage) => existingRow({ stage })));
  expect((await store.getForVideo(base.youtubeId)).map((o) => o.stage)).toEqual(['acquisition', 'captions', 'library']);
});
