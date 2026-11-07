jest.mock('../../../logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() }));
jest.mock('../../configModule', () => ({ getConfig: jest.fn(() => ({ channelAutoDownload: true })) }));
jest.mock('../../../models/channel', () => ({ findAll: jest.fn() }));
jest.mock('../../../models/jobvideodownload', () => ({ count: jest.fn(async () => 2) }));
jest.mock('../../storageGuard', () => ({
  refresh: jest.fn(async () => ({ paused: true, reasons: [{ type: 'tempFreeSpace', text: 't', resumeHint: 'h' }], tempFreeSpace: { availableBytes: 5 } })),
  getStatus: jest.fn(() => ({ paused: false, reasons: [] })),
}));
jest.mock('../../download/videoActivity', () => ({ snapshot: jest.fn(() => ({ videos: { a: {}, b: {} } })) }));
jest.mock('../../scheduledTaskRuns', () => ({ getLatestRun: jest.fn(async () => null) }));
jest.mock('../outcomeStore', () => ({
  countProblems: jest.fn(async () => [{ stage: 'library', status: 'pending', category: 'scan-pending', count: 3 }]),
  list: jest.fn(async () => ({ outcomes: [], total: 3 })),
}));
jest.mock('../runtimeVersions', () => ({ getVersions: jest.fn(() => ({ appVersion: '1', toolVersion: '2' })) }));

const Channel = require('../../../models/channel');
const outcomeStore = require('../outcomeStore');
const { build, newestFetch } = require('../healthSummary');

const NOW = Date.parse('2026-11-06T12:00:00Z');

beforeEach(() => {
  Channel.findAll.mockResolvedValue([
    { channel_id: 'UC1', title: 'Fresh', lastFetchedByTab: JSON.stringify({ videos: '2026-11-05T12:00:00Z' }) },
    { channel_id: 'UC2', title: 'Old', lastFetchedByTab: JSON.stringify({ videos: '2026-10-01T12:00:00Z' }) },
    { channel_id: 'UC3', title: 'Never', lastFetchedByTab: null },
  ]);
});

test('reports stale channels oldest first', async () => {
  const summary = await build({ now: NOW });
  expect(summary.channels.channels.map((c) => c.channelId)).toEqual(['UC3', 'UC2']);
});

test('includes the storage pause with resume hints and temp free space', async () => {
  const summary = await build({ now: NOW });
  expect(summary.storage).toMatchObject({ paused: true, reasons: [{ resumeHint: 'h' }], tempFreeSpace: { availableBytes: 5 } });
});

test('counts problems with labels, leases and versions', async () => {
  const summary = await build({ now: NOW });
  expect([summary.problems[0].categoryLabel, summary.leases, summary.versions]).toEqual([
    'Library scan pending', { activeVideos: 2, inProgressDownloads: 2 }, { appVersion: '1', toolVersion: '2' },
  ]);
});

test('a failing part degrades to empty rather than failing the summary', async () => {
  outcomeStore.countProblems.mockRejectedValueOnce(new Error('db'));
  await expect(build({ now: NOW })).resolves.toMatchObject({ problems: [] });
});

test('says live capture is not tracked yet', async () => {
  expect((await build({ now: NOW })).live.tracked).toBe(false);
});

test('newestFetch ignores unreadable values', () => {
  expect(newestFetch('not json')).toBeNull();
});
