jest.mock('axios');
jest.mock('../../../../logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const axios = require('axios');
const JellyfinAdapter = require('../jellyfinAdapter');
const { MediaServerUnavailableError } = require('../baseAdapter');

const cfg = { jellyfinUrl: 'http://jf:8096', jellyfinApiKey: 'KEY', jellyfinUserId: 'USR' };
const newPath = '/data/Chan [UC1]/Season 2024/Chan - S2024E001 - A [id1].mp4';
const request = (state = {}) => ({
  key: '1', path: newPath, serverUserId: 'u1',
  state: { played: false, playCount: 1, positionMs: 90000, percentWatched: 20, lastWatchedAt: new Date('2026-11-01T10:00:00Z'), ...state },
});
const listing = (items) => ({ data: { Items: items } });
const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { isAxiosError: true, response: { status } });
const newItem = { Id: 'NEW', Path: '/media/Chan [UC1]/Season 2024/Chan - S2024E001 - A [id1].mp4' };

describe('JellyfinAdapter.restoreWatchStates', () => {
  let adapter;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new JellyfinAdapter(cfg);
  });

  test('reports not-found until the server has scanned the new file', async () => {
    axios.get.mockResolvedValueOnce(listing([{ Id: 'OLD', Path: newPath.replace('.mp4', '.strm') }]));
    const results = await adapter.restoreWatchStates([request()]);
    expect(results.get('1')).toEqual({ status: 'not-found' });
  });

  test('writes the carried-over resume position to the new item', async () => {
    axios.get.mockResolvedValueOnce(listing([newItem])).mockResolvedValueOnce({ data: { Played: false, PlaybackPositionTicks: 0 } });
    axios.post.mockResolvedValue({});
    await adapter.restoreWatchStates([request()]);
    expect(axios.post).toHaveBeenCalledWith('http://jf:8096/UserItems/NEW/UserData',
      { Played: false, PlayCount: 1, PlaybackPositionTicks: 900000000, LastPlayedDate: '2026-11-01T10:00:00.000Z' },
      expect.objectContaining({ params: { userId: 'u1' } }));
  });

  test('marks a watched episode played without a resume position', async () => {
    axios.get.mockResolvedValueOnce(listing([newItem])).mockResolvedValueOnce({ data: {} });
    axios.post.mockResolvedValue({});
    const results = await adapter.restoreWatchStates([request({ played: true, positionMs: 0 })]);
    expect([results.get('1'), axios.post.mock.calls[0][1].Played, axios.post.mock.calls[0][1].PlaybackPositionTicks])
      .toEqual([{ status: 'restored' }, true, 0]);
  });

  test('never overwrites state the user already has on the new item', async () => {
    axios.get.mockResolvedValueOnce(listing([newItem])).mockResolvedValueOnce({ data: { Played: false, PlaybackPositionTicks: 5 } });
    const results = await adapter.restoreWatchStates([request()]);
    expect([results.get('1'), axios.post.mock.calls.length]).toEqual([{ status: 'superseded' }, 0]);
  });

  test('falls back to the pre-10.9 user data routes', async () => {
    axios.get.mockResolvedValueOnce(listing([newItem]))
      .mockRejectedValueOnce(httpError(404))
      .mockResolvedValueOnce({ data: { UserData: { Played: false } } });
    axios.post.mockRejectedValueOnce(httpError(404)).mockResolvedValueOnce({});
    await adapter.restoreWatchStates([request()]);
    expect(axios.post.mock.calls[1][0]).toBe('http://jf:8096/Users/u1/Items/NEW/UserData');
  });

  test('picks the item whose path best matches when a basename repeats', async () => {
    const other = { Id: 'OTHER', Path: '/elsewhere/Chan - S2024E001 - A [id1].mp4' };
    axios.get.mockResolvedValueOnce(listing([other, newItem])).mockResolvedValueOnce({ data: {} });
    axios.post.mockResolvedValue({});
    await adapter.restoreWatchStates([request()]);
    expect(axios.post.mock.calls[0][0]).toBe('http://jf:8096/UserItems/NEW/UserData');
  });

  test('reports a failed write without failing the other requests', async () => {
    axios.get.mockResolvedValueOnce(listing([newItem])).mockResolvedValueOnce({ data: {} });
    axios.post.mockRejectedValueOnce(httpError(400));
    const results = await adapter.restoreWatchStates([request()]);
    expect(results.get('1')).toEqual({ status: 'error', message: 'request failed (HTTP 400)' });
  });

  test('throws MediaServerUnavailableError when the server cannot be reached', async () => {
    axios.get.mockRejectedValueOnce(Object.assign(new Error('ECONNREFUSED'), { isAxiosError: true, code: 'ECONNREFUSED' }));
    await expect(adapter.restoreWatchStates([request()])).rejects.toBeInstanceOf(MediaServerUnavailableError);
  });

  test('does nothing for no requests', async () => {
    await adapter.restoreWatchStates([]);
    expect(axios.get).not.toHaveBeenCalled();
  });
});
