/* eslint-env jest */
jest.mock('../../../logger');

const mockConfig = { libraryOutputProfile: 'jellyfinTv' };
const mockPaths = { library: null, jobs: null };
jest.mock('../../configModule', () => ({
  getConfig: jest.fn(() => mockConfig),
  getJobsPath: jest.fn(() => mockPaths.jobs),
  get directoryPath() { return mockPaths.library; },
}));
jest.mock('../../episodeAssignment', () => ({ ensureEpisodeAssignment: jest.fn() }));
jest.mock('../../m3uGenerator', () => ({ generateChannelM3U: jest.fn(), generatePlaylistM3U: jest.fn() }));
jest.mock('../../playlistOutputRefresh', () => ({ refreshForVideos: jest.fn() }));
jest.mock('../../plexModule', () => ({ getBaseUrl: jest.fn(() => null) }));
jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn(), delete: jest.fn() }));

const mockRows = new Map();
jest.mock('../../../models', () => {
  const matches = (row, where) => Object.entries(where).every(([key, value]) => {
    if (key === 'filePath' && value && typeof value === 'object' && !Array.isArray(value)) return row.filePath != null;
    if (Array.isArray(value)) return value.includes(row[key]);
    return row[key] === value;
  });
  return {
    Video: {
      findAll: jest.fn(async ({ where }) => [...mockRows.values()].filter((row) => matches(row, where)).map((row) => ({ ...row }))),
      findOne: jest.fn(async ({ where }) => {
        const row = [...mockRows.values()].find((r) => matches(r, where));
        return row ? { ...row } : null;
      }),
      count: jest.fn(async ({ where } = {}) => [...mockRows.values()].filter((row) => !where || row.removed === where.removed).length),
      update: jest.fn(async (values, { where }) => {
        const rows = [...mockRows.values()].filter((row) => matches(row, where));
        rows.forEach((row) => Object.assign(row, values));
        return [rows.length];
      }),
    },
    Channel: { findOne: jest.fn(async () => ({ title: 'Show', description: 'About the show' })) },
    Playlist: { findAll: jest.fn(async () => []) },
    PlaylistVideo: { findAll: jest.fn(async () => []) },
    PlaylistSyncState: { findAll: jest.fn(async () => []) },
  };
});

const os = require('os');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs-extra');
const axios = require('axios');
const episodeAssignment = require('../../episodeAssignment');
const m3uGenerator = require('../../m3uGenerator');
const { MaintenanceLease } = require('../../maintenanceLease');
const { MigrationStore } = require('../migrationStore');
const { TvMigration } = require('..');

const CHANNEL = 'UCchannel01';
const NESTED = 'nestedvid01';
const FLAT = 'flatvideo02';

let root;
let library;
let lease;
let migration;

async function sha(file) {
  return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

// Every file under dir with its hash: what "nothing changed" means.
async function tree(dir) {
  const out = {};
  async function walk(current) {
    for (const name of (await fs.readdir(current)).sort()) {
      const full = path.join(current, name);
      if ((await fs.stat(full)).isDirectory()) await walk(full);
      else out[path.relative(dir, full)] = await sha(full);
    }
  }
  await walk(dir);
  return out;
}

async function seedLibrary() {
  const channelDir = path.join(library, 'Show');
  const nestedDir = path.join(channelDir, `Show - Nested - ${NESTED}`);
  const nestedStem = path.join(nestedDir, `Show - Nested [${NESTED}]`);
  await fs.outputFile(`${nestedStem}.mp4`, crypto.randomBytes(4096));
  await fs.outputFile(`${nestedStem}.en.srt`, '1\n00:00:01,000 --> 00:00:02,000\nhello\n');
  await fs.outputFile(`${nestedStem}.jpg`, 'thumb');
  await fs.outputFile(`${nestedStem}.nfo`, '<movie/>');
  await fs.outputFile(`${nestedStem}-fanart.jpg`, 'fanart');
  await fs.outputFile(path.join(channelDir, 'poster.jpg'), 'poster');
  const flatStem = path.join(channelDir, `Show - Flat [${FLAT}]`);
  await fs.outputFile(`${flatStem}.mp4`, crypto.randomBytes(2048));
  await fs.outputFile(`${flatStem}.de.vtt`, 'WEBVTT');

  mockRows.clear();
  mockRows.set(NESTED, {
    id: 1, youtubeId: NESTED, channel_id: CHANNEL, youTubeVideoName: 'Nested', youTubeChannelName: 'Show',
    originalDate: '20250301', filePath: `${nestedStem}.mp4`, audioFilePath: null, removed: false,
    last_downloaded_at: '2025-03-02T10:00:00.000Z',
  });
  mockRows.set(FLAT, {
    id: 2, youtubeId: FLAT, channel_id: CHANNEL, youTubeVideoName: 'Flat', youTubeChannelName: 'Show',
    originalDate: '20260105', filePath: `${flatStem}.mp4`, audioFilePath: null, removed: false,
  });
  // The cached info.json wins over the row for the nested video's metadata.
  await fs.outputJson(path.join(mockPaths.jobs, 'info', `${NESTED}.info.json`), {
    id: NESTED, title: 'Nested (cached)', upload_date: '20250301', description: 'plot',
  });
}

const ASSIGNMENTS = {
  [NESTED]: { showKey: CHANNEL, season: 2025, episode: 1, publishedAt: '2025-03-01T00:00:00.000Z', status: 'assigned' },
  [FLAT]: { showKey: CHANNEL, season: 2026, episode: 1, publishedAt: '2026-01-05T00:00:00.000Z', status: 'assigned' },
};

beforeEach(async () => {
  jest.clearAllMocks();
  mockConfig.libraryOutputProfile = 'jellyfinTv';
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'tvmig-'));
  library = path.join(root, 'library');
  mockPaths.library = library;
  mockPaths.jobs = path.join(root, 'jobs');
  await seedLibrary();
  episodeAssignment.ensureEpisodeAssignment.mockImplementation(async ({ youtubeId }) => ASSIGNMENTS[youtubeId] ||
    { showKey: CHANNEL, season: null, episode: null, status: 'date-required' });
  lease = new MaintenanceLease({ leasePath: path.join(root, 'config', 'maintenance-lease.json') });
  migration = new TvMigration({ store: new MigrationStore({ rootDir: path.join(root, 'config', 'tv-migrations') }), lease });
});

afterEach(async () => {
  await migration.waitForIdle();
  await fs.remove(root);
});

async function applyAndWait(planId, options = { confirm: true }) {
  await migration.apply(planId, options);
  await migration.waitForIdle();
  return migration.get(planId);
}

const nestedTarget = () => path.join(library, `Show [${CHANNEL}]`, 'Season 2025', `Show - S2025E001 - Nested (cached) [${NESTED}].mp4`);
const flatTarget = () => path.join(library, `Show [${CHANNEL}]`, 'Season 2026', `Show - S2026E001 - Flat [${FLAT}].mp4`);

describe('preview', () => {
  test('changes nothing in the library', async () => {
    const before = await tree(library);
    await migration.createPlan();
    expect(await tree(library)).toEqual(before);
  });

  test('lists every video to move with its new path', async () => {
    const plan = await migration.createPlan();
    expect(plan.items.map((item) => item.media.target)).toEqual([nestedTarget(), flatTarget()]);
  });

  test('explains a video it cannot move', async () => {
    mockRows.get(FLAT).originalDate = null;
    episodeAssignment.ensureEpisodeAssignment.mockImplementation(async ({ youtubeId, publishedAt }) => (publishedAt
      ? ASSIGNMENTS[youtubeId] : { showKey: CHANNEL, season: null, episode: null, status: 'date-required' }));
    const plan = await migration.createPlan();
    expect(plan.skipped.map((item) => [item.youtubeId, item.code])).toEqual([[FLAT, 'date-required']]);
  });

  test('reports a target that already exists as a conflict', async () => {
    await fs.outputFile(flatTarget().replace('.mp4', '.nfo'), 'someone else');
    const plan = await migration.createPlan();
    expect(plan.skipped.map((item) => item.code)).toEqual(['target-exists']);
  });

  test('keeps files the TV layout has no place for as leftovers', async () => {
    const plan = await migration.createPlan();
    expect(plan.items[0].leftovers.map((file) => file.name)).toEqual([
      `Show - Nested [${NESTED}]-fanart.jpg`, `Show - Nested [${NESTED}].nfo`,
    ]);
  });

  test('says what Jellyfin state cannot be preserved when Jellyfin is not configured', async () => {
    const plan = await migration.createPlan();
    expect(plan.mediaServers.notes.join(' ')).toMatch(/Jellyfin is not configured/);
  });
});

describe('apply', () => {
  test('moves both videos into the TV layout', async () => {
    const plan = await migration.createPlan();
    const result = await applyAndWait(plan.planId);
    expect([result.status, await fs.pathExists(nestedTarget()), await fs.pathExists(flatTarget())]).toEqual(['applied', true, true]);
  });

  test('keeps the media bytes unchanged', async () => {
    const before = [await sha(mockRows.get(NESTED).filePath), await sha(mockRows.get(FLAT).filePath)];
    const plan = await migration.createPlan();
    await applyAndWait(plan.planId);
    expect([await sha(nestedTarget()), await sha(flatTarget())]).toEqual(before);
  });

  test('makes no network request', async () => {
    const plan = await migration.createPlan();
    await applyAndWait(plan.planId);
    expect([axios.get.mock.calls.length, axios.post.mock.calls.length]).toEqual([0, 0]);
  });

  test('points the database rows at the new files', async () => {
    const plan = await migration.createPlan();
    await applyAndWait(plan.planId);
    expect([mockRows.get(NESTED).filePath, mockRows.get(FLAT).filePath]).toEqual([nestedTarget(), flatTarget()]);
  });

  test('renames subtitles and thumbnail with the episode and writes TV NFOs', async () => {
    const plan = await migration.createPlan();
    await applyAndWait(plan.planId);
    expect((await fs.readdir(path.dirname(nestedTarget()))).sort()).toEqual([
      `Show - S2025E001 - Nested (cached) [${NESTED}]-thumb.jpg`,
      `Show - S2025E001 - Nested (cached) [${NESTED}].en.srt`,
      `Show - S2025E001 - Nested (cached) [${NESTED}].mp4`,
      `Show - S2025E001 - Nested (cached) [${NESTED}].nfo`,
      'season.nfo',
    ]);
  });

  test('records the original download time as dateadded', async () => {
    const plan = await migration.createPlan();
    await applyAndWait(plan.planId);
    expect(await fs.readFile(nestedTarget().replace('.mp4', '.nfo'), 'utf8')).toContain('<dateadded>2025-03-02 10:00:00</dateadded>');
  });

  test('removes the emptied per-video folder but keeps the channel folder artwork', async () => {
    const plan = await migration.createPlan();
    await applyAndWait(plan.planId);
    expect(await fs.readdir(path.join(library, 'Show'))).toEqual(['poster.jpg']);
  });

  test('releases the maintenance lease when done', async () => {
    const plan = await migration.createPlan();
    await applyAndWait(plan.planId);
    expect(lease.isActive()).toBe(false);
  });

  test('regenerates the channel playlist file', async () => {
    const plan = await migration.createPlan();
    await applyAndWait(plan.planId);
    expect(m3uGenerator.generateChannelM3U).toHaveBeenCalledWith(CHANNEL);
  });

  test('is refused without confirmation', async () => {
    const plan = await migration.createPlan();
    await expect(migration.apply(plan.planId, {})).rejects.toMatchObject({ code: 'confirmation-required' });
  });

  test('is refused while the library profile is not Jellyfin TV', async () => {
    const plan = await migration.createPlan();
    mockConfig.libraryOutputProfile = 'movie';
    await expect(migration.apply(plan.planId, { confirm: true })).rejects.toMatchObject({ code: 'profile-not-tv' });
  });

  test('is refused while a download runs', async () => {
    const plan = await migration.createPlan();
    migration.setDownloadActivityCheck(() => true);
    await expect(migration.apply(plan.planId, { confirm: true })).rejects.toMatchObject({ code: 'downloads-active' });
  });

  test('rejects a stale plan without moving anything', async () => {
    const plan = await migration.createPlan();
    await fs.appendFile(mockRows.get(FLAT).filePath, 'changed');
    const before = await tree(library);
    await expect(migration.apply(plan.planId, { confirm: true })).rejects.toMatchObject({ code: 'stale' });
    expect([await tree(library), lease.isActive()]).toEqual([before, false]);
  });
});

describe('Jellyfin user state', () => {
  beforeEach(() => {
    Object.assign(mockConfig, { jellyfinEnabled: true, jellyfinUrl: 'http://jf', jellyfinApiKey: 'k', jellyfinUserId: 'u1' });
  });

  afterEach(() => {
    ['jellyfinEnabled', 'jellyfinUrl', 'jellyfinApiKey', 'jellyfinUserId'].forEach((key) => delete mockConfig[key]);
  });

  test('refuses to apply when the snapshot cannot be taken', async () => {
    axios.get.mockRejectedValue(new Error('ECONNREFUSED'));
    const plan = await migration.createPlan();
    await expect(migration.apply(plan.planId, { confirm: true })).rejects.toMatchObject({ code: 'snapshot-failed' });
    expect(lease.isActive()).toBe(false);
  });

  test('applies without the snapshot only when told to, and says so', async () => {
    axios.get.mockRejectedValue(new Error('ECONNREFUSED'));
    const plan = await migration.createPlan();
    const result = await applyAndWait(plan.planId, { confirm: true, acceptUserStateLoss: true });
    expect([result.status, result.userStateSkipped]).toEqual(['applied', 'Jellyfin user state was not snapshotted: ECONNREFUSED']);
  });

  test('saves the watch state of planned videos before moving them', async () => {
    axios.get.mockImplementation(async (url, { params }) => {
      if (url.endsWith('/Users')) return { data: [{ Id: 'u1', Name: 'One' }] };
      if (params.isPlayed) return { data: { Items: [{ Id: 'old', Path: `/media/Show/Show - Flat [${FLAT}].mp4`, UserData: { Played: true, PlayCount: 1 } }] } };
      return { data: { TotalRecordCount: 0, Items: [] } };
    });
    const plan = await migration.createPlan();
    const result = await applyAndWait(plan.planId);
    expect(result.userState.counts).toEqual({ videosWithState: 1, userEntries: 1, playlists: 0 });
  });
});

describe('interruption', () => {
  async function interruptAtFlat() {
    const plan = await migration.createPlan();
    // Something appears at the second video's target after planning.
    await fs.outputFile(flatTarget(), 'obstacle');
    return applyAndWait(plan.planId);
  }

  test('stops at the failing video and keeps the lease', async () => {
    const result = await interruptAtFlat();
    expect([result.status, result.progress.done, result.progress.failed, lease.isActive()]).toEqual(['interrupted', 1, 1, true]);
  });

  test('resumes from the checkpoints once the cause is fixed', async () => {
    const result = await interruptAtFlat();
    await fs.remove(flatTarget());
    await migration.resume(result.planId);
    await migration.waitForIdle();
    const resumed = await migration.get(result.planId);
    expect([resumed.status, mockRows.get(FLAT).filePath, lease.isActive()]).toEqual(['applied', flatTarget(), false]);
  });

  test('is reported as interrupted after a restart', async () => {
    const plan = await migration.createPlan();
    const store = migration.store;
    await store.saveState(plan.planId, { ...(await store.loadState(plan.planId)), status: 'applying' });
    const restartedLease = new MaintenanceLease({ leasePath: lease.leasePath });
    const restarted = new TvMigration({ store, lease: restartedLease });
    await restarted.initialize();
    expect([(await restarted.get(plan.planId)).status, restartedLease.isActive()]).toEqual(['interrupted', true]);
  });

  test('a restart releases the lease of a migration that already finished', async () => {
    const plan = await migration.createPlan();
    await applyAndWait(plan.planId);
    lease.acquire(`tv-migration:${plan.planId}`, 'left behind');
    const restartedLease = new MaintenanceLease({ leasePath: lease.leasePath });
    await new TvMigration({ store: migration.store, lease: restartedLease }).initialize();
    expect(restartedLease.isActive()).toBe(false);
  });

  test('a held lease survives a restart', async () => {
    lease.acquire('tv-migration:x', 'moving');
    expect(new MaintenanceLease({ leasePath: lease.leasePath }).current().owner).toBe('tv-migration:x');
  });
});

describe('rollback', () => {
  test('restores the original files byte for byte', async () => {
    const before = await tree(library);
    const plan = await migration.createPlan();
    await applyAndWait(plan.planId);
    await migration.rollback(plan.planId, { confirm: true });
    await migration.waitForIdle();
    expect(await tree(library)).toEqual(before);
  });

  test('restores the database rows', async () => {
    const before = [mockRows.get(NESTED).filePath, mockRows.get(FLAT).filePath];
    const plan = await migration.createPlan();
    await applyAndWait(plan.planId);
    await migration.rollback(plan.planId, { confirm: true });
    await migration.waitForIdle();
    expect([mockRows.get(NESTED).filePath, mockRows.get(FLAT).filePath]).toEqual(before);
  });

  test('restores a partly applied migration', async () => {
    const before = await tree(library);
    const plan = await migration.createPlan();
    await fs.outputFile(flatTarget(), 'obstacle');
    await applyAndWait(plan.planId);
    await fs.remove(flatTarget());
    await migration.rollback(plan.planId, { confirm: true });
    await migration.waitForIdle();
    expect([(await migration.get(plan.planId)).status, await tree(library), lease.isActive()]).toEqual(['rolled-back', before, false]);
  });

  test('is refused for a plan that was never applied', async () => {
    const plan = await migration.createPlan();
    await expect(migration.rollback(plan.planId, { confirm: true })).rejects.toMatchObject({ code: 'invalid-state' });
  });
});

describe('maintenance lease', () => {
  test('a new plan is refused while another migration holds the lease', async () => {
    lease.acquire('tv-migration:other', 'moving');
    await expect(migration.createPlan()).rejects.toMatchObject({ code: 'maintenance-active' });
  });

  test('an unknown plan id is not found', async () => {
    await expect(migration.get('../../etc')).rejects.toMatchObject({ code: 'not-found' });
  });
});

test.each(['delete', 'subfolder move'])('apply refuses an in-flight %s until its lifetime ends', async () => {
  const plan = await migration.createPlan();
  let finish;
  const writer = lease.runOperation(() => new Promise((resolve) => { finish = resolve; }));
  await expect(migration.apply(plan.planId, { confirm: true })).rejects.toMatchObject({ code: 'maintenance-active' });
  expect(lease.current()).toBeNull();
  finish();
  await writer;
  expect((await applyAndWait(plan.planId)).status).toBe('applied');
});

test('apply refuses a show ancestor replaced by a symlink after preview', async () => {
  const plan = await migration.createPlan();
  const outside = path.join(root, 'outside');
  await fs.ensureDir(outside);
  await fs.symlink(outside, plan.items[0].showDir);
  await expect(migration.apply(plan.planId, { confirm: true })).rejects.toMatchObject({ code: 'unsafe-path' });
  expect(await fs.readdir(outside)).toEqual([]);
  expect(lease.current()).toBeNull();
});

test('preview refuses a source ancestor symlink', async () => {
  const old = path.join(library, 'Show');
  const outside = path.join(root, 'outside-source');
  await fs.rename(old, outside);
  await fs.symlink(outside, old);
  const plan = await migration.createPlan();
  expect(plan.items).toEqual([]);
  expect(plan.skipped.every((item) => item.code === 'unsafe-path')).toBe(true);
});

test('rollback refuses a redirected original folder without writing outside the library', async () => {
  const plan = await migration.createPlan();
  await applyAndWait(plan.planId);
  const outside = path.join(root, 'outside-rollback');
  await fs.ensureDir(outside);
  const nested = plan.items.find((item) => item.youtubeId === NESTED);
  await fs.symlink(outside, nested.oldDir);
  await migration.rollback(plan.planId, { confirm: true });
  await migration.waitForIdle();
  expect((await migration.get(plan.planId)).status).toBe('interrupted');
  expect(await fs.readdir(outside)).toEqual([]);
  expect(lease.isActive()).toBe(true);
});
