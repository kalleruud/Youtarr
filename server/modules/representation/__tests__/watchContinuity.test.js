jest.mock('../../../logger');
jest.mock('../../../models/video', () => ({ findOne: jest.fn() }));
jest.mock('../../../models/videowatchstatus', () => ({ findAll: jest.fn() }));
jest.mock('../../../models/watchStateCarryover', () => ({ bulkCreate: jest.fn(), findAll: jest.fn(), update: jest.fn() }));

const Video = require('../../../models/video');
const VideoWatchStatus = require('../../../models/videowatchstatus');
const Carryover = require('../../../models/watchStateCarryover');
const { MediaServerUnavailableError } = require('../../mediaServers/adapters/baseAdapter');
const watchContinuity = require('../watchContinuity');

const strm = '/data/Show [UC1]/Season 2026/Show - S2026E001 - A [vid12345678].strm';
const mp4 = strm.replace('.strm', '.mp4');
const carryover = (extra = {}) => ({
  id: 1, video_id: 7, youtube_id: 'vid12345678', server_type: 'jellyfin', server_user_id: 'u1',
  played: 0, play_count: 1, position_ms: '90000', percent_watched: 20, last_watched_at: null,
  to_location: mp4, status: 'pending', attempts: 0, ...extra,
});
const adapter = (restoreWatchStates) => ({ serverType: 'jellyfin', restoreWatchStates });
const statusWrites = () => Carryover.update.mock.calls.map(([values]) => values.status);

beforeEach(() => {
  jest.clearAllMocks();
  Carryover.update.mockResolvedValue([1]);
});

describe('recordCarryovers', () => {
  test('snapshots every stored row that holds watch state', async () => {
    Video.findOne.mockResolvedValue({ id: 7 });
    VideoWatchStatus.findAll.mockResolvedValue([
      { server_type: 'jellyfin', server_user_id: 'u1', played: 1, play_count: 1, position_ms: 0 },
      { server_type: 'jellyfin', server_user_id: 'u2', played: 0, play_count: 0, position_ms: 0, percent_watched: null, last_watched_at: null },
    ]);
    const count = await watchContinuity.recordCarryovers({ youtubeId: 'vid12345678', fromLocation: strm, toLocation: mp4 });
    expect([count, Carryover.bulkCreate.mock.calls[0][0].map(r => [r.server_user_id, r.status, r.to_location])])
      .toEqual([1, [['u1', 'pending', mp4]]]);
  });

  test('records nothing when the location did not change', async () => {
    expect(await watchContinuity.recordCarryovers({ youtubeId: 'vid12345678', fromLocation: mp4, toLocation: mp4 })).toBe(0);
  });

  test('records nothing for a video without a library row', async () => {
    Video.findOne.mockResolvedValue(null);
    expect(await watchContinuity.recordCarryovers({ youtubeId: 'vid12345678', fromLocation: strm, toLocation: mp4 })).toBe(0);
  });
});

describe('prepareServer', () => {
  test('holds restored state until the listing confirms it', async () => {
    Carryover.findAll.mockResolvedValue([carryover()]);
    const restore = jest.fn().mockResolvedValue(new Map([['1', { status: 'restored' }]]));
    const prepared = await watchContinuity.prepareServer(adapter(restore));
    expect([prepared.held.size, prepared.restoredYoutubeIds, statusWrites()]).toEqual([1, ['vid12345678'], ['restored']]);
  });

  test('keeps a restored row held across a stale listing and later settles it', async () => {
    Carryover.findAll.mockResolvedValue([carryover({ status: 'restored' })]);
    const restore = jest.fn();
    const prepared = await watchContinuity.prepareServer(adapter(restore));
    await watchContinuity.settleListed(prepared, []);
    expect([...prepared.held]).toEqual(['7:u1']);
    expect(restore).not.toHaveBeenCalled();
    await watchContinuity.settleListed(prepared, [{ video: { id: 7 }, entry: { serverUserId: 'u1', path: mp4 } }]);
    expect(prepared.held.size).toBe(0);
  });

  test('passes the stored state to the adapter', async () => {
    Carryover.findAll.mockResolvedValue([carryover()]);
    const restore = jest.fn().mockResolvedValue(new Map());
    await watchContinuity.prepareServer(adapter(restore));
    expect(restore.mock.calls[0][0]).toEqual([{ key: '1', path: mp4, serverUserId: 'u1',
      state: { played: false, playCount: 1, positionMs: 90000, percentWatched: 20, lastWatchedAt: null } }]);
  });

  test('keeps holding while the server has not scanned the new file', async () => {
    Carryover.findAll.mockResolvedValue([carryover()]);
    const prepared = await watchContinuity.prepareServer(adapter(jest.fn().mockResolvedValue(new Map([['1', { status: 'not-found' }]]))));
    expect([[...prepared.held], Carryover.update.mock.calls[0][0].attempts]).toEqual([['7:u1'], 1]);
  });

  test('marks a carryover failed after the last attempt but keeps holding it', async () => {
    Carryover.findAll.mockResolvedValue([carryover({ attempts: watchContinuity.MAX_RESTORE_ATTEMPTS - 1 })]);
    const prepared = await watchContinuity.prepareServer(adapter(jest.fn().mockResolvedValue(new Map([['1', { status: 'not-found' }]]))));
    expect([statusWrites(), [...prepared.held]]).toEqual([['failed'], ['7:u1']]);
  });

  test('lets the user state on the new item win', async () => {
    Carryover.findAll.mockResolvedValue([carryover()]);
    const prepared = await watchContinuity.prepareServer(adapter(jest.fn().mockResolvedValue(new Map([['1', { status: 'superseded' }]]))));
    expect([statusWrites(), prepared.held.size]).toEqual([['restored'], 1]);
  });

  test('keeps the stored state for a server that cannot restore it', async () => {
    Carryover.findAll.mockResolvedValue([carryover({ server_type: 'emby' })]);
    const prepared = await watchContinuity.prepareServer({ serverType: 'emby' });
    expect([statusWrites(), [...prepared.held]]).toEqual([['unsupported'], ['7:u1']]);
  });

  test('keeps holding unsupported and failed carryovers without retrying them', async () => {
    Carryover.findAll.mockResolvedValue([carryover({ status: 'failed' }), carryover({ id: 2, server_user_id: 'u2', status: 'unsupported' })]);
    const restore = jest.fn();
    const prepared = await watchContinuity.prepareServer(adapter(restore));
    expect([restore.mock.calls.length, [...prepared.held].sort()]).toEqual([0, ['7:u1', '7:u2']]);
  });

  test('rethrows an unreachable server so the sync skips it', async () => {
    Carryover.findAll.mockResolvedValue([carryover()]);
    await expect(watchContinuity.prepareServer(adapter(jest.fn().mockRejectedValue(new MediaServerUnavailableError()))))
      .rejects.toBeInstanceOf(MediaServerUnavailableError);
  });

  test('counts any other restore failure as a failed attempt', async () => {
    Carryover.findAll.mockResolvedValue([carryover()]);
    const prepared = await watchContinuity.prepareServer(adapter(jest.fn().mockRejectedValue(new Error('boom'))));
    expect([[...prepared.held], Carryover.update.mock.calls[0][0].last_error]).toEqual([['7:u1'], 'restore request failed']);
  });
});

describe('settleListed', () => {
  test('stops holding once the server lists the new item for that user', async () => {
    const row = carryover();
    const prepared = { held: new Set(['7:u1']), carryovers: [row] };
    await watchContinuity.settleListed(prepared, [{ video: { id: 7 }, entry: { serverUserId: 'u1', path: `/media/x/${mp4.split('/').pop()}` } }]);
    expect([prepared.held.size, statusWrites()]).toEqual([0, ['superseded']]);
  });

  test('keeps holding while the server only lists the old STRM item', async () => {
    const prepared = { held: new Set(['7:u1']), carryovers: [carryover()] };
    await watchContinuity.settleListed(prepared, [{ video: { id: 7 }, entry: { serverUserId: 'u1', path: strm } }]);
    expect(prepared.held.size).toBe(1);
  });
});
