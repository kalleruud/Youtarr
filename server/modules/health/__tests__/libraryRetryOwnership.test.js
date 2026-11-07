jest.mock('../../../logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() }));
jest.mock('../../../models/video', () => ({ findOne: jest.fn() }));
jest.mock('../../../models/channelvideo', () => ({ findOne: jest.fn() }));
jest.mock('../../../models/jobvideodownload', () => ({ count: jest.fn() }));
jest.mock('../../storageGuard', () => ({
  getStatus: jest.fn(() => ({ paused: false, reasons: [] })),
  refresh: jest.fn(async () => ({ paused: false, reasons: [] })),
  isPausedError: jest.fn(() => false),
  describe: jest.fn(() => 'Downloads are paused: x'),
}));
jest.mock('../../download/videoActivity', () => ({ isActive: jest.fn(() => false) }));
jest.mock('../../acquisition/acquisitionPolicyService', () => ({ getVideo: jest.fn() }));
jest.mock('../../configModule', () => ({ getConfig: jest.fn(() => ({})) }));
jest.mock('../../mediaServers/serverRegistry', () => ({ getEnabledAdapters: jest.fn() }));
jest.mock('../runtimeVersions', () => ({ getVersions: () => ({}) }));
jest.mock('../../../models/healthOutcome', () => ({
  findOne: jest.fn(), findAll: jest.fn(), update: jest.fn(),
  sequelize: { literal: () => 'increment' },
}));
jest.mock('../healthNotifier', () => ({}));
jest.mock('../healthSummary', () => ({}));

const model = require('../../../models/healthOutcome');
const registry = require('../../mediaServers/serverRegistry');
const refresh = require('../libraryRefresh');
const health = require('../index');
const ID = 'abcdefghijk';
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
let row;
beforeEach(() => {
  jest.clearAllMocks();
  row = { youtube_id: ID, stage: 'library', revision: 5, status: 'pending',
    category: 'scan-pending', retryable: true, reason_code: 'show-not-found',
    details: JSON.stringify({ showDir: '/show', mediaPath: '/show/ep.mp4' }) };
  model.findOne.mockImplementation(async () => ({ ...row, get: () => ({ ...row }) }));
  model.findAll.mockImplementation(async () => [{ ...row }]);
  model.update.mockImplementation(async (values, { where }) => {
    if (row.revision !== where.revision) return [0];
    Object.assign(row, values, { revision: values.revision === 'increment' ? row.revision + 1 : values.revision || row.revision });
    return [1];
  });
});
const retry = () => health.retryStep({ youtubeId: ID, stage: 'library', revision: 5 });

test('automatic revision 5 worker between checks refuses a retry before claiming revision 6', async () => {
  const paused = deferred();
  const sleeping = deferred();
  const oldSleep = refresh.sleep;
  const oldDelays = refresh.delays;
  refresh.delays = [0, 1];
  refresh.sleep = () => { sleeping.resolve(); return paused.promise; };
  const adapter = { serverType: 'jellyfin', checkShowPublication: jest.fn()
    .mockResolvedValueOnce({ status: 'show-not-found' })
    .mockResolvedValue({ status: 'listed', files: new Set(['ep.mp4']) }) };
  registry.getEnabledAdapters.mockReturnValue([adapter]);
  const work = refresh.enqueue([ID]);
  try {
    await sleeping.promise;
    await expect(retry()).rejects.toMatchObject({ code: 'refresh-capacity' });
    expect(row.revision).toBe(5);
    expect(model.update).not.toHaveBeenCalled();
  } finally {
    paused.resolve();
    await work;
    refresh.sleep = oldSleep;
    refresh.delays = oldDelays;
  }
  expect(row).toMatchObject({ revision: 6, status: 'ok', reason_code: 'listed-in-jellyfin' });
  expect(refresh.videos.size).toBe(0);
});

test('retry reserves before claim awaits; automatic admission waits for the claimed generation', async () => {
  const paused = deferred();
  const entered = deferred();
  const update = model.update.getMockImplementation();
  model.update.mockImplementationOnce(async (...args) => {
    entered.resolve();
    await paused.promise;
    return update(...args);
  });
  const adapter = { serverType: 'jellyfin', checkShowPublication: jest.fn()
    .mockResolvedValue({ status: 'listed', files: new Set(['ep.mp4']) }) };
  registry.getEnabledAdapters.mockReturnValue([adapter]);
  const request = retry();
  await entered.promise;
  const automatic = refresh.enqueue([ID]);
  await expect(retry()).rejects.toMatchObject({ code: 'refresh-capacity' });
  expect(adapter.checkShowPublication).not.toHaveBeenCalled();
  paused.resolve();
  await expect(request).resolves.toMatchObject({ queued: true, outcome: { revision: 6 } });
  await automatic;
  expect(row).toMatchObject({ revision: 7, status: 'ok', reason_code: 'listed-in-jellyfin' });
  expect(adapter.checkShowPublication).toHaveBeenCalledTimes(1);
  expect(refresh.videos.size).toBe(0);
});

test.each(['stale', 'throw'])('failed %s claim releases reserved capacity', async (failure) => {
  if (failure === 'stale') model.update.mockResolvedValueOnce([0]);
  else model.update.mockRejectedValueOnce(new Error('database unavailable'));
  await expect(retry()).rejects.toThrow();
  expect(refresh.videos.size).toBe(0);
  expect(row.revision).toBe(5);
});

test('a full admission map refuses without claiming', async () => {
  const release = deferred();
  model.findAll.mockImplementationOnce(() => release.promise);
  const work = refresh.enqueue(Array.from({ length: 200 }, (_, i) => `v${String(i).padStart(10, '0')}`));
  try {
    await expect(retry()).rejects.toMatchObject({ code: 'refresh-capacity' });
    expect(model.update).not.toHaveBeenCalled();
  } finally {
    release.resolve([]);
    await work;
  }
  expect(refresh.videos.size).toBe(0);
});

test('a worker read error releases its claimed generation and capacity', async () => {
  model.findAll.mockRejectedValueOnce(new Error('read unavailable'));
  await expect(retry()).resolves.toMatchObject({ queued: true });
  await refresh.enqueue([ID]);
  expect(row).toMatchObject({ revision: 7, reason_code: 'refresh-deferred', retryable: true });
  expect(refresh.videos.size).toBe(0);
});

test('an outcome without publication details releases its claim as deferred', async () => {
  row.details = null;
  await expect(retry()).resolves.toMatchObject({ queued: true });
  await refresh.enqueue([ID]);
  expect(row).toMatchObject({ revision: 7, reason_code: 'refresh-deferred', retryable: true });
  expect(refresh.videos.size).toBe(0);
});
