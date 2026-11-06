/* eslint-env jest */
jest.mock('../../../logger');
jest.mock('../../plexModule', () => ({ getBaseUrl: jest.fn(() => null) }));
jest.mock('../../../models', () => ({ PlaylistSyncState: { findAll: jest.fn(async () => []) } }));

const { PlaylistSyncState } = require('../../../models');
const plexModule = require('../../plexModule');
const userState = require('../userState');

const A = 'aaaaaaaaaaa';
const B = 'bbbbbbbbbbb';
const plan = {
  items: [
    { youtubeId: A, media: { target: `/lib/Show [UC1]/Season 2025/Show - S2025E001 - A [${A}].mp4` } },
    { youtubeId: B, media: { target: `/lib/Show [UC1]/Season 2026/Show - S2026E001 - B [${B}].mp4` } },
  ],
};
const jellyfinConfig = { jellyfinEnabled: true, jellyfinUrl: 'http://jf', jellyfinApiKey: 'k', jellyfinUserId: 'u1' };

function fakeAdapter(overrides = {}) {
  return {
    userId: 'u1',
    fetchWatchStates: jest.fn(async () => ({
      users: [{ id: 'u1', name: 'One' }, { id: 'u2', name: 'Two' }],
      entries: [
        { path: `/movies/Show/Show - A [${A}].mp4`, serverUserId: 'u1', played: true, playCount: 2, positionMs: 0, lastWatchedAt: new Date('2026-01-01T00:00:00Z') },
        { path: `/movies/Show/Show - A [${A}].mp4`, serverUserId: 'u2', played: false, playCount: 0, positionMs: 61000, lastWatchedAt: null },
        { path: '/movies/Other/Other [zzzzzzzzzzz].mp4', serverUserId: 'u1', played: true, playCount: 1 },
      ],
    })),
    listUserPlaylists: jest.fn(async () => [
      { id: 'p1', name: 'Mine', userId: 'u1', entries: [{ itemId: 'old-b', path: `/movies/Show/Show - B [${B}].mp4` }, { itemId: 'x', path: '/music/song.mp3' }] },
      { id: 'p2', name: 'Unrelated', userId: 'u1', entries: [{ itemId: 'x', path: '/music/song.mp3' }] },
      { id: 'managed', name: 'Youtarr', userId: 'u1', entries: [{ itemId: 'old-a', path: `/movies/Show/Show - A [${A}].mp4` }] },
    ]),
    listEpisodePaths: jest.fn(async () => [
      { id: 'new-a', path: `/tv/Show [UC1]/Season 2025/Show - S2025E001 - A [${A}].mp4` },
      { id: 'new-b', path: `/tv/Show [UC1]/Season 2026/Show - S2026E001 - B [${B}].mp4` },
    ]),
    setUserData: jest.fn(async () => {}),
    listPlaylistItemIds: jest.fn(async () => ['x']),
    addPlaylistItems: jest.fn(async () => {}),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  PlaylistSyncState.findAll.mockResolvedValue([{ server_playlist_id: 'managed' }]);
});

describe('describeMediaServers', () => {
  test('lists what Jellyfin restores and what it cannot', () => {
    expect(userState.describeMediaServers(jellyfinConfig).jellyfin.unsupported.join(' ')).toMatch(/favorites/);
  });

  test('notes that Plex state is not migrated', () => {
    plexModule.getBaseUrl.mockReturnValueOnce('http://plex');
    expect(userState.describeMediaServers({ plexApiKey: 'x' }).notes.join(' ')).toMatch(/Plex watch state/);
  });
});

describe('snapshot', () => {
  test('keeps watch state only for the plan videos, per user', async () => {
    const snap = await userState.snapshot(plan, jellyfinConfig, { adapter: fakeAdapter() });
    expect(snap.watch[A].map((entry) => [entry.serverUserId, entry.played, entry.positionMs])).toEqual([['u1', true, 0], ['u2', false, 61000]]);
  });

  test('keeps user playlists that contain plan videos, but not Youtarr-managed ones', async () => {
    const snap = await userState.snapshot(plan, jellyfinConfig, { adapter: fakeAdapter() });
    expect(snap.playlists.map((playlist) => playlist.id)).toEqual(['p1']);
  });

  test('is null without Jellyfin', async () => {
    expect(await userState.snapshot(plan, {})).toBeNull();
  });
});

describe('restore', () => {
  async function restoreOnce(adapter, progress = null) {
    const snap = await userState.snapshot(plan, jellyfinConfig, { adapter: fakeAdapter() });
    return userState.restore(plan, snap, progress, jellyfinConfig, { adapter, doneIds: new Set([A, B]) });
  }

  test('writes each user\'s state onto the new episode item', async () => {
    const adapter = fakeAdapter();
    await restoreOnce(adapter);
    expect(adapter.setUserData.mock.calls.map(([itemId, userId, state]) => [itemId, userId, state.positionMs]))
      .toEqual([['new-a', 'u1', 0], ['new-a', 'u2', 61000]]);
  });

  test('adds the new episode to the user playlist', async () => {
    const adapter = fakeAdapter();
    await restoreOnce(adapter);
    expect(adapter.addPlaylistItems).toHaveBeenCalledWith('p1', ['new-b'], 'u1');
  });

  test('leaves a video Jellyfin has not scanned yet pending', async () => {
    const adapter = fakeAdapter({ listEpisodePaths: jest.fn(async () => []) });
    const { report } = await restoreOnce(adapter);
    expect([report.pending, report.playlistsPending]).toEqual([[A], 1]);
  });

  test('does not write the same state twice', async () => {
    const adapter = fakeAdapter();
    const first = await restoreOnce(adapter);
    adapter.setUserData.mockClear();
    await restoreOnce(adapter, first.progress);
    expect(adapter.setUserData).not.toHaveBeenCalled();
  });

  test('reports a failed write without stopping', async () => {
    const adapter = fakeAdapter({ setUserData: jest.fn(async (itemId, userId) => { if (userId === 'u1') throw new Error('boom'); }) });
    const { report } = await restoreOnce(adapter);
    expect([report.restored, report.failed.map((f) => f.serverUserId)]).toEqual([1, ['u1']]);
  });
});

test('youtubeIdOf reads the trailing [id] token', () => {
  expect([userState.youtubeIdOf(`C:\\x\\Show - A [${A}].mp4`), userState.youtubeIdOf('/x/no-id.mp4')]).toEqual([A, null]);
});
