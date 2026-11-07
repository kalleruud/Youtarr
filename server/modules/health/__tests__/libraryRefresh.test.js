jest.mock('../../../logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() }));
jest.mock('../../configModule', () => ({ getConfig: jest.fn(() => ({})) }));
jest.mock('../../mediaServers/serverRegistry', () => ({ getEnabledAdapters: jest.fn(() => []) }));
jest.mock('../outcomeStore', () => ({ getStageForVideos: jest.fn(), record: jest.fn() }));

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
