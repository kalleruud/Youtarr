jest.mock('../../../db', () => ({ sequelize: { define: jest.fn() } }));
jest.mock('../../../models/channelvideo', () => ({ findAll: jest.fn() }));
jest.mock('../../../models/video', () => ({ findAll: jest.fn() }));
jest.mock('../../archiveModule', () => ({ filterArchivedVideoIds: jest.fn() }));
jest.mock('../../channel/channelIdentity', () => ({ resolveChannelUrlFromId: jest.fn(id => `https://www.youtube.com/channel/${id}`) }));
jest.mock('../acquisitionPolicyStore', () => ({
  getGlobal: jest.fn(),
  getChannelPolicies: jest.fn(),
  getVideoOverridesForChannels: jest.fn(),
}));

const ChannelVideo = require('../../../models/channelvideo');
const Video = require('../../../models/video');
const archiveModule = require('../../archiveModule');
const store = require('../acquisitionPolicyStore');
const { planChannelSweep, loadChannelSweepPlan } = require('../channelSweepPlanner');

const URL = id => `https://www.youtube.com/channel/${id}`;
const channel = (id, tabs = 'video,short,livestream') => ({ channel_id: id, url: URL(id), auto_download_enabled_tabs: tabs });
const plan = (input) => planChannelSweep({ resolveChannelUrl: URL, ...input });

describe('planChannelSweep', () => {
  test('without any policy every enabled tab is fetched, as before policies existed', () => {
    expect(plan({ channels: [channel('UC1')] }).urls).toEqual([`${URL('UC1')}/videos`, `${URL('UC1')}/shorts`, `${URL('UC1')}/streams`]);
  });

  test('a stream channel queues nothing and says why', () => {
    const result = plan({ channels: [channel('UC1', 'video')], channelPolicies: new Map([['UC1', { delivery: 'stream' }]]) });
    expect(result.urls).toEqual([]);
    expect(result.skipped).toEqual([expect.objectContaining({ channelId: 'UC1', contentKind: 'video', reasons: [expect.objectContaining({ code: 'capability_unavailable', action: 'stream' })] })]);
  });

  test('ignoring livestreams drops only the streams tab', () => {
    const result = plan({ channels: [channel('UC1')], channelPolicies: new Map([['UC1', { live: 'ignore' }]]) });
    expect(result.urls).toEqual([`${URL('UC1')}/videos`, `${URL('UC1')}/shorts`]);
  });

  test('a global stream default with a channel download policy fetches that channel only', () => {
    const result = plan({
      channels: [channel('UC1', 'video'), channel('UC2', 'video')],
      globalPolicy: { delivery: 'stream' },
      channelPolicies: new Map([['UC2', { delivery: 'download' }]]),
    });
    expect(result.urls).toEqual([`${URL('UC2')}/videos`]);
  });

  test('a stream override on a downloading channel excludes that video', () => {
    const result = plan({ channels: [channel('UC1', 'video')], videoOverrides: [{ youtubeId: 'aaaaaaaaaaa', channelId: 'UC1', delivery: 'stream' }] });
    expect(result.excludedVideoIds).toEqual(['aaaaaaaaaaa']);
  });

  test('a download override on a stream channel adds that single video', () => {
    const result = plan({
      channels: [channel('UC1', 'video')],
      channelPolicies: new Map([['UC1', { delivery: 'stream' }]]),
      videoOverrides: [{ youtubeId: 'bbbbbbbbbbb', channelId: 'UC1', delivery: 'download' }],
    });
    expect(result.urls).toEqual(['https://www.youtube.com/watch?v=bbbbbbbbbbb']);
  });

  test('an already acquired (kept or deleted) video is never fetched again by an override', () => {
    const result = plan({
      channels: [channel('UC1', 'video')],
      channelPolicies: new Map([['UC1', { delivery: 'stream' }]]),
      videoOverrides: [{ youtubeId: 'bbbbbbbbbbb', channelId: 'UC1', delivery: 'download' }],
      acquiredIds: new Set(['bbbbbbbbbbb']),
    });
    expect(result.urls).toEqual([]);
  });

  test('a livestream override uses the listing media type', () => {
    const result = plan({
      channels: [channel('UC1', 'video,livestream')],
      videoOverrides: [{ youtubeId: 'ccccccccccc', channelId: 'UC1', live: 'ignore' }],
      mediaTypes: new Map([['ccccccccccc', 'livestream']]),
    });
    expect(result.excludedVideoIds).toEqual(['ccccccccccc']);
  });

  test('legacy channels without an id follow the global policy', () => {
    const legacy = { channel_id: null, url: 'https://www.youtube.com/@legacy' };
    expect(plan({ channels: [legacy] }).urls).toEqual(['https://www.youtube.com/@legacy']);
    expect(plan({ channels: [legacy], globalPolicy: { delivery: 'stream' } }).urls).toEqual([]);
  });

  test('grouped runs can leave legacy URLs out', () => {
    const legacy = { channel_id: null, url: 'https://www.youtube.com/@legacy' };
    expect(plan({ channels: [legacy], includeLegacyUrls: false }).urls).toEqual([]);
  });

  test('a channel with no enabled tabs fetches nothing', () => {
    expect(plan({ channels: [channel('UC1', '')] }).urls).toEqual([]);
  });
});

describe('loadChannelSweepPlan', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    store.getGlobal.mockResolvedValue({ delivery: null, live: null });
    store.getChannelPolicies.mockResolvedValue(new Map([['UC1', { delivery: 'stream' }]]));
    store.getVideoOverridesForChannels.mockResolvedValue([
      { youtubeId: 'bbbbbbbbbbb', channelId: 'UC1', delivery: 'download' },
      { youtubeId: 'ddddddddddd', channelId: 'UC1', delivery: 'download' },
    ]);
    ChannelVideo.findAll.mockResolvedValue([]);
    Video.findAll.mockResolvedValue([{ youtubeId: 'ddddddddddd' }]);
    archiveModule.filterArchivedVideoIds.mockReturnValue(new Set());
  });

  test('skips override videos that already have a Videos row', async () => {
    const result = await loadChannelSweepPlan([channel('UC1', 'video')]);
    expect(result.urls).toEqual(['https://www.youtube.com/watch?v=bbbbbbbbbbb']);
  });

  test('skips override videos listed in the download archive', async () => {
    archiveModule.filterArchivedVideoIds.mockReturnValue(new Set(['bbbbbbbbbbb']));
    const result = await loadChannelSweepPlan([channel('UC1', 'video')]);
    expect(result.urls).toEqual([]);
  });

  test('loads policies only for the channels being swept', async () => {
    await loadChannelSweepPlan([channel('UC1', 'video'), { channel_id: null, url: 'x' }]);
    expect(store.getChannelPolicies).toHaveBeenCalledWith(['UC1']);
  });
});
