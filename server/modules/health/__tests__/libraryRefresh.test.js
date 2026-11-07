jest.mock('../../../logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() }));
jest.mock('../../configModule', () => ({ getConfig: jest.fn(() => ({})) }));
jest.mock('../../mediaServers/serverRegistry', () => ({ getEnabledAdapters: jest.fn(() => []) }));
jest.mock('../outcomeStore', () => ({ getStageForVideos: jest.fn(), record: jest.fn(), renewRetry: jest.fn().mockResolvedValue(true) }));

const configModule = require('../../configModule');
const serverRegistry = require('../../mediaServers/serverRegistry');
const outcomeStore = require('../outcomeStore');
const { LibraryRefresh } = require('../libraryRefresh');

const pending = (youtubeId, file) => ({
  youtubeId, status: 'pending', jobId: 'job-1',
  details: { showDir: '/data/Show [UC1]', mediaPath: `/data/Show [UC1]/Season 2026/${file}` },
});

function adapterWith(responses) {
  const adapter = { serverType: 'jellyfin', checkShowPublication: jest.fn() };
  responses.forEach((response) => {
    if (response instanceof Error) adapter.checkShowPublication.mockRejectedValueOnce(response);
    else adapter.checkShowPublication.mockResolvedValueOnce(response);
  });
  serverRegistry.getEnabledAdapters.mockReturnValue([adapter]);
  return adapter;
}

const recorded = () => outcomeStore.record.mock.calls.map(([o]) => [o.youtubeId, o.status, o.category, o.reasonCode]);

beforeEach(() => {
  jest.clearAllMocks();
  configModule.getConfig.mockReturnValue({});
  outcomeStore.getStageForVideos.mockResolvedValue(new Map([['aaaaaaaaaaa', pending('aaaaaaaaaaa', 'ep1.mp4')]]));
});

const refresh = () => new LibraryRefresh({ sleep: jest.fn().mockResolvedValue(), delays: [0, 1, 1] });

test('an episode Jellyfin already lists is confirmed without a refresh', async () => {
  const adapter = adapterWith([{ status: 'listed', files: new Set(['ep1.mp4']) }]);
  await refresh().enqueue(['aaaaaaaaaaa']);
  expect(adapter.checkShowPublication).toHaveBeenCalledWith('/data/Show [UC1]', { refresh: false });
  expect(recorded()).toEqual([['aaaaaaaaaaa', 'ok', 'ok', 'listed-in-jellyfin']]);
});

test('an unlisted episode triggers one show refresh and is confirmed on a re-check', async () => {
  const adapter = adapterWith([
    { status: 'listed', files: new Set() },
    { status: 'listed', files: new Set(), refreshed: true },
    { status: 'listed', files: new Set(['ep1.mp4']) },
  ]);
  await refresh().enqueue(['aaaaaaaaaaa']);
  expect(adapter.checkShowPublication.mock.calls.filter(([, o]) => o.refresh)).toHaveLength(1);
  expect(recorded()).toEqual([['aaaaaaaaaaa', 'ok', 'ok', 'listed-in-jellyfin']]);
});

test('a show Jellyfin has not scanned stays scan-pending and retryable', async () => {
  adapterWith([{ status: 'show-not-found' }, { status: 'show-not-found' }, { status: 'show-not-found' }]);
  await refresh().enqueue(['aaaaaaaaaaa']);
  expect(recorded()).toEqual([['aaaaaaaaaaa', 'pending', 'scan-pending', 'show-not-found']]);
  expect(outcomeStore.record.mock.calls[0][0].retryable).toBe(true);
});

test('a Jellyfin error is recorded on the library step only', async () => {
  adapterWith([Object.assign(new Error('Jellyfin rejected the API key'), { retryable: false })]);
  await refresh().enqueue(['aaaaaaaaaaa']);
  const [outcome] = outcomeStore.record.mock.calls[0];
  expect(outcome).toMatchObject({ stage: 'library', status: 'failed', retryable: false });
});

test('without Jellyfin the check is skipped with an explanation', async () => {
  serverRegistry.getEnabledAdapters.mockReturnValue([]);
  await refresh().enqueue(['aaaaaaaaaaa']);
  expect(recorded()).toEqual([['aaaaaaaaaaa', 'skipped', 'scan-pending', 'refresh-disabled']]);
});

test('the setting turns the targeted refresh off', async () => {
  const adapter = adapterWith([]);
  configModule.getConfig.mockReturnValue({ jellyfinPublishRefresh: false });
  await refresh().enqueue(['aaaaaaaaaaa']);
  expect(adapter.checkShowPublication).not.toHaveBeenCalled();
});

test('videos without a pending library outcome are left alone', async () => {
  outcomeStore.getStageForVideos.mockResolvedValue(new Map());
  const adapter = adapterWith([]);
  await refresh().enqueue(['aaaaaaaaaaa']);
  expect(adapter.checkShowPublication).not.toHaveBeenCalled();
});

test('a failing batch never rejects', async () => {
  outcomeStore.getStageForVideos.mockRejectedValue(new Error('db down'));
  await expect(refresh().enqueue(['aaaaaaaaaaa'])).resolves.toBeUndefined();
});

test('admission coalesces duplicates and bounds retained videos behind sleeping work', async () => {
  let release;
  const asleep = new Promise((resolve) => { release = resolve; });
  outcomeStore.getStageForVideos.mockImplementation(async (ids) => new Map(ids.map((id) => [id, pending(id, 'ep1.mp4')])));
  const adapter = adapterWith([]);
  adapter.checkShowPublication.mockResolvedValue({ status: 'show-not-found' });
  const worker = new LibraryRefresh({ sleep: () => asleep, delays: [0, 1] });
  const first = worker.enqueue(['aaaaaaaaaaa']);
  const duplicate = worker.enqueue(['aaaaaaaaaaa']);
  await Promise.resolve();
  expect(outcomeStore.getStageForVideos).toHaveBeenCalledTimes(1);
  const extra = worker.enqueue(Array.from({ length: 300 }, (_, i) => String(i).padStart(11, '0')));
  expect(worker.videos.size).toBe(200);
  expect(worker.canAccept('zzzzzzzzzzz')).toBe(false);
  release();
  await Promise.all([first, duplicate, extra]);
  expect(worker.videos.size).toBe(0);
});

test('a delayed show does not block a different show', async () => {
  let release;
  const asleep = new Promise((resolve) => { release = resolve; });
  const second = pending('bbbbbbbbbbb', 'ep2.mp4');
  second.details.showDir = '/data/Other';
  outcomeStore.getStageForVideos.mockResolvedValue(new Map([
    ['aaaaaaaaaaa', pending('aaaaaaaaaaa', 'ep1.mp4')], ['bbbbbbbbbbb', second],
  ]));
  const adapter = adapterWith([]);
  adapter.checkShowPublication.mockImplementation(async (show) => show === '/data/Other'
    ? { status: 'listed', files: new Set(['ep2.mp4']) } : { status: 'show-not-found' });
  const worker = new LibraryRefresh({ sleep: () => asleep, delays: [0, 1] });
  const run = worker.enqueue(['aaaaaaaaaaa', 'bbbbbbbbbbb']);
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  expect(recorded()).toContainEqual(['bbbbbbbbbbb', 'ok', 'ok', 'listed-in-jellyfin']);
  release();
  await run;
});

test('settlement carries the generation admitted by the worker', async () => {
  const item = { ...pending('aaaaaaaaaaa', 'ep1.mp4'), revision: 6, reasonCode: 'retry-requested' };
  outcomeStore.getStageForVideos.mockResolvedValue(new Map([[item.youtubeId, item]]));
  adapterWith([{ status: 'listed', files: new Set(['ep1.mp4']) }]);
  await refresh().enqueue([item.youtubeId]);
  expect(outcomeStore.record).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 6 }));
});

test('an active retry renews ownership during delayed checks and stops after completion', async () => {
  jest.useFakeTimers();
  let release;
  const asleep = new Promise((resolve) => { release = resolve; });
  const item = { ...pending('aaaaaaaaaaa', 'ep1.mp4'), revision: 6, reasonCode: 'retry-requested' };
  outcomeStore.getStageForVideos.mockResolvedValue(new Map([[item.youtubeId, item]]));
  const adapter = adapterWith([]);
  adapter.checkShowPublication.mockResolvedValue({ status: 'show-not-found' });
  const worker = new LibraryRefresh({ sleep: () => asleep, delays: [0, 1] });
  try {
    const run = worker.enqueue([item.youtubeId]);
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    await jest.advanceTimersByTimeAsync(11 * 60 * 1000);
    expect(outcomeStore.renewRetry).toHaveBeenCalledWith(item.youtubeId, 'library', 6);
    release();
    await run;
    const calls = outcomeStore.renewRetry.mock.calls.length;
    await jest.advanceTimersByTimeAsync(60 * 1000);
    expect(outcomeStore.renewRetry).toHaveBeenCalledTimes(calls);
  } finally {
    release();
    jest.useRealTimers();
  }
});

test('show capacity overflow is explicitly deferred without another Jellyfin request', async () => {
  let release;
  const asleep = new Promise((resolve) => { release = resolve; });
  const items = Array.from({ length: 26 }, (_, i) => {
    const item = pending(String(i).padStart(11, '0'), 'ep.mp4');
    item.details.showDir = `/data/Show${i}`;
    return item;
  });
  outcomeStore.getStageForVideos.mockResolvedValue(new Map(items.map((item) => [item.youtubeId, item])));
  const adapter = adapterWith([]);
  adapter.checkShowPublication.mockResolvedValue({ status: 'show-not-found' });
  const worker = new LibraryRefresh({ sleep: () => asleep, delays: [0, 1] });
  const run = worker.enqueue(items.map((item) => item.youtubeId));
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  expect(adapter.checkShowPublication).toHaveBeenCalledTimes(25);
  expect(recorded()).toContainEqual([items[25].youtubeId, 'pending', 'scan-pending', 'refresh-deferred']);
  release();
  await run;
});
