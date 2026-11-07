jest.mock('../../../db', () => ({ sequelize: {} }));
jest.mock('../../../models/channel', () => ({ findOne: jest.fn() }));
jest.mock('../../../models/channelvideo', () => ({ findOne: jest.fn() }));
jest.mock('../../../models/video', () => ({ findOne: jest.fn(), update: jest.fn(), destroy: jest.fn() }));
jest.mock('../acquisitionPolicyStore', () => {
  class PolicyRevisionConflictError extends Error {
    constructor(currentRevision) { super('conflict'); this.currentRevision = currentRevision; }
  }
  return {
    get: jest.fn(),
    getGlobal: jest.fn(),
    set: jest.fn(),
    countVideoOverrides: jest.fn(),
    PolicyRevisionConflictError,
    GLOBAL_SUBJECT: 'global',
  };
});

const Channel = require('../../../models/channel');
const ChannelVideo = require('../../../models/channelvideo');
const Video = require('../../../models/video');
const store = require('../acquisitionPolicyStore');
const service = require('../acquisitionPolicyService');

const EMPTY = { delivery: null, live: null, revision: 0 };

beforeEach(() => {
  jest.clearAllMocks();
  store.getGlobal.mockResolvedValue(EMPTY);
  store.get.mockResolvedValue(EMPTY);
  store.set.mockResolvedValue(EMPTY);
  store.countVideoOverrides.mockResolvedValue(0);
  Channel.findOne.mockResolvedValue({ channel_id: 'UC1', enabled: true, auto_download_enabled_tabs: 'video,livestream' });
  ChannelVideo.findOne.mockResolvedValue({ youtube_id: 'aaaaaaaaaaa', channel_id: 'UC1', media_type: 'video' });
  Video.findOne.mockResolvedValue(null);
});

describe('parsePolicyUpdate', () => {
  test.each([
    [{ delivery: 'teleport' }, 'invalid-policy'],
    [{ live: 'sometimes' }, 'invalid-policy'],
    [{}, 'invalid-body'],
    [[], 'invalid-body'],
    [{ delivery: 'stream', expectedRevision: -1 }, 'invalid-revision'],
    [{ delivery: 'stream', expectedRevision: '2' }, 'invalid-revision'],
  ])('rejects %j with %s', (body, code) => {
    expect(() => service.parsePolicyUpdate(body)).toThrow(expect.objectContaining({ status: 400, code }));
  });

  test('null clears a field and unknown fields are ignored', () => {
    expect(service.parsePolicyUpdate({ delivery: null, other: 1 })).toEqual({ changes: { delivery: null }, expectedRevision: undefined });
  });
});

describe('channel policy', () => {
  test('unknown channel is a 404', async () => {
    Channel.findOne.mockResolvedValue(null);
    await expect(service.getChannel('UCX')).rejects.toMatchObject({ status: 404 });
  });

  test('switching to stream only writes the policy, keeping existing downloads and protected videos', async () => {
    await service.updateChannel('UC1', { delivery: 'stream' });
    expect(store.set).toHaveBeenCalledWith('channel', 'UC1', { delivery: 'stream' }, { expectedRevision: undefined });
    expect([Video.update.mock.calls.length, Video.destroy.mock.calls.length]).toEqual([0, 0]);
  });

  test('explains the unavailable stream mode for the channel', async () => {
    store.get.mockResolvedValue({ delivery: 'stream', live: null, revision: 1 });
    const summary = await service.getChannel('UC1');
    const video = summary.decisions.find(d => d.contentKind === 'video');
    expect(video.reasons).toEqual([expect.objectContaining({ code: 'capability_unavailable', action: 'stream' })]);
  });

  test('applies the channel tab filter to its decisions', async () => {
    const summary = await service.getChannel('UC1');
    expect(summary.decisions.find(d => d.contentKind === 'short').reasons.map(r => r.code)).toEqual(['content_kind_filtered']);
  });

  test('a stale revision is a 409 with the current revision', async () => {
    store.set.mockRejectedValue(new store.PolicyRevisionConflictError(5));
    await expect(service.updateChannel('UC1', { delivery: 'stream', expectedRevision: 4 }))
      .rejects.toMatchObject({ status: 409, code: 'revision-conflict', currentRevision: 5 });
  });
});

describe('video override', () => {
  test('an unknown video is a 404', async () => {
    ChannelVideo.findOne.mockResolvedValue(null);
    await expect(service.getVideo('zzzzzzzzzzz')).rejects.toMatchObject({ status: 404 });
  });

  test('stores the override against the video channel', async () => {
    await service.updateVideo('aaaaaaaaaaa', { delivery: 'stream' });
    expect(store.set).toHaveBeenCalledWith('video', 'aaaaaaaaaaa', { delivery: 'stream' }, { expectedRevision: undefined, channelId: 'UC1' });
  });

  test('refuses a new override beyond the limit', async () => {
    store.countVideoOverrides.mockResolvedValue(service.MAX_VIDEO_OVERRIDES);
    await expect(service.updateVideo('aaaaaaaaaaa', { delivery: 'stream' })).rejects.toMatchObject({ status: 409, code: 'override-limit' });
  });

  test('clearing an override is always allowed', async () => {
    store.countVideoOverrides.mockResolvedValue(service.MAX_VIDEO_OVERRIDES);
    store.get.mockResolvedValue({ delivery: 'stream', live: null, revision: 1 });
    await service.clearVideo('aaaaaaaaaaa');
    expect(store.set).toHaveBeenCalledWith('video', 'aaaaaaaaaaa', { delivery: null, live: null }, expect.anything());
  });

  test('a stream-only video stays eligible for a manual download', async () => {
    store.get.mockImplementation(async scope => (scope === 'video' ? { delivery: 'stream', live: null, revision: 1 } : EMPTY));
    const summary = await service.getVideo('aaaaaaaaaaa');
    expect([summary.automatic.jobAction, summary.manual.jobAction]).toEqual([null, 'download']);
  });

  test('reports a kept local copy and its protection', async () => {
    Video.findOne.mockResolvedValue({ channel_id: 'UC1', removed: false, protected: true });
    const summary = await service.getVideo('aaaaaaaaaaa');
    expect([summary.hasLocalCopy, summary.protected]).toEqual([true, true]);
  });

  test.each([
    ['is_live', 'live'],
    ['is_upcoming', 'upcoming'],
    ['was_live', 'replay'],
    [null, 'replay'],
  ])('maps livestream live_status %s to %s', async (liveStatus, sourceState) => {
    ChannelVideo.findOne.mockResolvedValue({ youtube_id: 'aaaaaaaaaaa', channel_id: 'UC1', media_type: 'livestream', live_status: liveStatus });
    expect((await service.getVideo('aaaaaaaaaaa')).sourceState).toBe(sourceState);
  });

  test('a video removed from YouTube is reported as unavailable', async () => {
    ChannelVideo.findOne.mockResolvedValue({ youtube_id: 'aaaaaaaaaaa', channel_id: 'UC1', media_type: 'video', youtube_removed: true });
    const summary = await service.getVideo('aaaaaaaaaaa');
    expect(summary.automatic.reasons.map(r => r.code)).toEqual(['source_unavailable']);
  });
});
