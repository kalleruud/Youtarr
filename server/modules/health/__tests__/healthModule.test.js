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
jest.mock('../outcomeStore', () => ({
  record: jest.fn(async (o) => o), getForVideo: jest.fn(async () => []), getStageForVideos: jest.fn(async () => new Map()),
  claimRetry: jest.fn(), getOne: jest.fn(), list: jest.fn(),
}));
jest.mock('../libraryRefresh', () => ({ enqueueRetry: jest.fn(async (id, claim) => ({ outcome: await claim() })), enqueue: jest.fn(async () => {}) }));
jest.mock('../healthNotifier', () => ({ report: jest.fn(), reportAbandoned: jest.fn() }));
jest.mock('../healthSummary', () => ({ build: jest.fn() }));

const Video = require('../../../models/video');
const JobVideoDownload = require('../../../models/jobvideodownload');
const storageGuard = require('../../storageGuard');
const videoActivity = require('../../download/videoActivity');
const acquisitionPolicyService = require('../../acquisition/acquisitionPolicyService');
const outcomeStore = require('../outcomeStore');
const libraryRefresh = require('../libraryRefresh');
const healthNotifier = require('../healthNotifier');
const health = require('../index');

const ID = 'abcdefghijk';
const downloadModule = { doSpecificDownloads: jest.fn(async () => ({ acceptedIds: [ID], alreadyActiveIds: [] })) };

beforeEach(() => {
  jest.clearAllMocks();
  Video.findOne.mockResolvedValue(null);
  JobVideoDownload.count.mockResolvedValue(0);
  videoActivity.isActive.mockReturnValue(false);
  storageGuard.refresh.mockResolvedValue({ paused: false, reasons: [] });
  outcomeStore.claimRetry.mockResolvedValue({ youtubeId: ID, stage: 'acquisition', category: 'abandoned', revision: 3 });
  acquisitionPolicyService.getVideo.mockResolvedValue({ globalRevision: 1, channelRevision: 0, revision: 0 });
});

describe('recordAcquisitionResults', () => {
  test('records successes and classified failures with the policy revision', async () => {
    await health.recordAcquisitionResults({
      jobId: 'j1',
      succeeded: [{ youtubeId: ID }],
      failed: [{ youtubeId: 'bbbbbbbbbbb', error: 'Video unavailable' }],
    });
    const calls = outcomeStore.record.mock.calls.map(([o]) => [o.youtubeId, o.status, o.category, o.policyRevision || null]);
    expect(calls).toEqual([[ID, 'ok', 'ok', null], ['bbbbbbbbbbb', 'failed', 'source-unavailable', '1.0.0']]);
  });

  test('a recording failure never throws into the finalizer', async () => {
    outcomeStore.record.mockRejectedValueOnce(new Error('db'));
    await expect(health.recordAcquisitionResults({ succeeded: [{ youtubeId: ID }] })).resolves.toBeUndefined();
  });
});

describe('recordAbandoned', () => {
  test('unfinished leases become retryable abandoned outcomes', async () => {
    const result = await health.recordAbandoned([{ jobId: 'j1', jobType: 'Channel Downloads', youtubeIds: [ID] }]);
    expect(result).toEqual({ jobCount: 1, videoCount: 1 });
    expect(outcomeStore.record.mock.calls[0][0]).toMatchObject({ category: 'abandoned', retryable: true, jobId: 'j1' });
  });

  test('a video already on disk is not reported as abandoned', async () => {
    Video.findOne.mockResolvedValue({ removed: false });
    const result = await health.recordAbandoned([{ jobId: 'j1', youtubeIds: [ID] }]);
    expect(result.videoCount).toBe(0);
  });

  test('alerts only when notifications are enabled (server process)', async () => {
    await health.recordAbandoned([{ jobId: 'j1', youtubeIds: [] }]);
    expect(healthNotifier.reportAbandoned).not.toHaveBeenCalled();
    health.enableNotifications();
    await health.recordAbandoned([{ jobId: 'j1', youtubeIds: [] }]);
    expect(healthNotifier.reportAbandoned).toHaveBeenCalledWith({ jobCount: 1, videoCount: 0 });
  });
});

describe('retryStep', () => {
  const retry = (overrides = {}) => health.retryStep({ youtubeId: ID, stage: 'acquisition', revision: 2, ...overrides }, { downloadModule });

  test('an acquisition retry queues one download of just this video', async () => {
    await retry();
    expect(downloadModule.doSpecificDownloads).toHaveBeenCalledWith({ body: { urls: [`https://www.youtube.com/watch?v=${ID}`], overrideSettings: { allowRedownload: true } } });
  });

  test('a stale or repeated retry is refused and queues nothing', async () => {
    outcomeStore.claimRetry.mockResolvedValue(null);
    await expect(retry()).rejects.toMatchObject({ status: 409, code: 'stale-or-duplicate' });
    expect(downloadModule.doSpecificDownloads).not.toHaveBeenCalled();
  });

  test('an active download lease blocks the retry', async () => {
    JobVideoDownload.count.mockResolvedValue(1);
    await expect(retry()).rejects.toMatchObject({ status: 409, code: 'in-progress' });
    expect(outcomeStore.claimRetry).not.toHaveBeenCalled();
  });

  test('a queued claim in this process blocks the retry', async () => {
    videoActivity.isActive.mockReturnValue(true);
    await expect(retry()).rejects.toMatchObject({ code: 'in-progress' });
  });

  test('an already downloaded video is refused', async () => {
    Video.findOne.mockResolvedValue({ removed: false });
    await expect(retry()).rejects.toMatchObject({ code: 'already-downloaded' });
  });

  test('paused downloads refuse the retry with how to resume', async () => {
    storageGuard.refresh.mockResolvedValue({ paused: true, reasons: [{ text: 'low', resumeHint: 'Free up 2 GB.' }] });
    await expect(retry()).rejects.toMatchObject({ status: 409, code: 'downloads-paused', message: expect.stringContaining('Free up 2 GB.') });
  });

  test('a library retry re-runs only the targeted Jellyfin check', async () => {
    outcomeStore.claimRetry.mockResolvedValue({ stage: 'library', revision: 5 });
    await retry({ stage: 'library' });
    expect(libraryRefresh.enqueueRetry).toHaveBeenCalledWith(ID, expect.any(Function));
    expect(downloadModule.doSpecificDownloads).not.toHaveBeenCalled();
  });

  test('busy library admission refuses before claiming', async () => {
    libraryRefresh.enqueueRetry.mockResolvedValueOnce(null);
    await expect(retry({ stage: 'library' })).rejects.toMatchObject({ status: 503, code: 'refresh-capacity' });
    expect(outcomeStore.claimRetry).not.toHaveBeenCalled();
  });

  test('captions cannot be retried on their own', async () => {
    await expect(retry({ stage: 'captions' })).rejects.toMatchObject({ status: 422 });
  });

  test('a missing revision is a bad request', async () => {
    await expect(retry({ revision: undefined })).rejects.toMatchObject({ status: 400, code: 'invalid-revision' });
  });

  test('a download the queue refuses as active is a conflict and the outcome stays retryable', async () => {
    downloadModule.doSpecificDownloads.mockResolvedValueOnce({ acceptedIds: [], alreadyActiveIds: [ID] });
    await expect(retry()).rejects.toMatchObject({ code: 'in-progress' });
    expect(outcomeStore.record.mock.calls[0][0]).toMatchObject({ status: 'failed', retryable: true, reasonCode: 'retry-not-queued' });
  });
});

describe('afterDownloadCompleted', () => {
  test('runs the targeted library check for the downloaded videos', async () => {
    await health.afterDownloadCompleted([ID, 'not-an-id']);
    expect(libraryRefresh.enqueue).toHaveBeenCalledWith([ID]);
  });
});

describe('explainVideo', () => {
  test('rejects an invalid id', async () => {
    await expect(health.explainVideo('nope')).rejects.toMatchObject({ status: 400 });
  });

  test('explains an unknown video', async () => {
    acquisitionPolicyService.getVideo.mockRejectedValue(Object.assign(new Error('nf'), { status: 404 }));
    const result = await health.explainVideo(ID);
    expect(result.explanation.state).toBe('unknown');
  });
});
