/* eslint-env jest */
// The facade against real files in a temp dir and an in-memory store with the
// real lease rules: promotion, STRM publication, eviction and convergence.
jest.mock('../../../logger');
jest.mock('../representationStore', () => require('./fakeRepresentationStore').createFakeStore());
jest.mock('../watchContinuity', () => ({ recordCarryovers: jest.fn().mockResolvedValue(0), listForYoutubeId: jest.fn().mockResolvedValue([]) }));
jest.mock('../../../models/video', () => ({ findOne: jest.fn(), update: jest.fn() }));
jest.mock('../../../models/channel', () => ({ findOne: jest.fn() }));
jest.mock('../../acquisition/capabilities', () => {
  const capabilities = { stream: { available: false } };
  return { getCapabilities: () => capabilities };
});

const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const store = require('../representationStore');
const watchContinuity = require('../watchContinuity');
const Video = require('../../../models/video');
const Channel = require('../../../models/channel');
const { getCapabilities } = require('../../acquisition/capabilities');
const representations = require('..');

const ID = 'vid12345678';
let root;
let seasonDir;
let stem;
let mediaPath;
let strmPath;
let video;

async function writeStreamEntry() {
  await fs.outputFile(strmPath, 'http://youtarr/play/vid12345678');
  return { location: strmPath };
}

async function publishStream() {
  return representations.publishStreamEntry(ID, { write: writeStreamEntry });
}

async function landDownload() {
  await fs.outputFile(mediaPath, 'media-bytes');
}

async function visibleEntries() {
  return (await fs.readdir(seasonDir)).filter(name => /\.(mp4|strm)$/.test(name)).sort();
}

beforeEach(async () => {
  jest.clearAllMocks();
  store.rows.length = 0;
  store.heads.clear();
  representations.registerStreamPublisher(null);
  getCapabilities().stream.available = false;
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'reps-'));
  seasonDir = path.join(root, 'Show [UCchannel01]', 'Season 2026');
  stem = `Show - S2026E001 - First [${ID}]`;
  mediaPath = path.join(seasonDir, `${stem}.mp4`);
  strmPath = path.join(seasonDir, `${stem}.strm`);
  await fs.outputFile(path.join(seasonDir, `${stem}.nfo`), '<episodedetails/>');
  await fs.outputFile(path.join(seasonDir, `${stem}.en.srt`), 'captions');
  video = { id: 7, youtubeId: ID, channel_id: 'UCchannel01', filePath: null, removed: false, youtube_removed: false, protected: false };
  Video.findOne.mockImplementation(async () => video);
  Channel.findOne.mockResolvedValue({ auto_removal_protected: false });
  watchContinuity.recordCarryovers.mockResolvedValue(0);
});

afterEach(async () => {
  await fs.remove(root);
});

describe('resolvePlayableRepresentation', () => {
  test('selects the local file even when YouTube no longer has the video', async () => {
    await landDownload();
    await representations.promoteDownloadedAsset(ID, { location: mediaPath });
    video.youtube_removed = true;
    const result = await representations.resolvePlayableRepresentation(ID);
    expect([result.mode, result.representation.location]).toEqual(['local', mediaPath]);
  });

  test('uses a download from before representations existed', async () => {
    await landDownload();
    video.filePath = mediaPath;
    const result = await representations.resolvePlayableRepresentation(ID);
    expect([result.mode, result.representation.legacy]).toEqual(['local', true]);
  });

  test('streams when the recorded local file is gone', async () => {
    getCapabilities().stream.available = true;
    await landDownload();
    await representations.promoteDownloadedAsset(ID, { location: mediaPath });
    await fs.remove(mediaPath);
    expect((await representations.resolvePlayableRepresentation(ID)).mode).toBe('upstream');
  });

  test('is unavailable without a local copy while streaming is not available', async () => {
    expect((await representations.resolvePlayableRepresentation(ID)).mode).toBe('unavailable');
  });

  test('refuses an invalid video id', async () => {
    await expect(representations.resolvePlayableRepresentation('../etc')).rejects.toMatchObject({ status: 400 });
  });
});

describe('stream -> download promotion', () => {
  beforeEach(async () => {
    getCapabilities().stream.available = true;
    await publishStream();
  });

  test('leaves one visible episode entry, the local file', async () => {
    await landDownload();
    await representations.promoteDownloadedAsset(ID, { location: mediaPath });
    expect(await visibleEntries()).toEqual([`${stem}.mp4`]);
  });

  test('keeps the episode metadata and captions', async () => {
    await landDownload();
    await representations.promoteDownloadedAsset(ID, { location: mediaPath });
    expect((await fs.readdir(seasonDir)).sort()).toEqual([`${stem}.en.srt`, `${stem}.mp4`, `${stem}.nfo`]);
  });

  test('retires the STRM record instead of deleting it', async () => {
    await landDownload();
    await representations.promoteDownloadedAsset(ID, { location: mediaPath });
    expect(store.rows.map(r => [r.kind, r.state])).toEqual([['strm', 'retired'], ['local', 'verified']]);
  });

  test('records watch state to carry from the STRM entry to the local file', async () => {
    await landDownload();
    await representations.promoteDownloadedAsset(ID, { location: mediaPath });
    expect(watchContinuity.recordCarryovers).toHaveBeenCalledWith({ youtubeId: ID, fromLocation: strmPath, toLocation: mediaPath });
  });

  test('leaves the STRM published when its durable watch snapshot fails and repairs on retry', async () => {
    await landDownload();
    watchContinuity.recordCarryovers.mockRejectedValueOnce(new Error('snapshot unavailable'));
    await expect(representations.promoteDownloadedAsset(ID, { location: mediaPath })).rejects.toThrow('snapshot unavailable');
    expect(store.rows.map(r => [r.kind, r.state])).toEqual([['strm', 'published']]);
    expect(await fs.pathExists(strmPath)).toBe(true);
    await representations.promoteDownloadedAsset(ID, { location: mediaPath });
    expect(await visibleEntries()).toEqual([`${stem}.mp4`]);
  });

  test('is idempotent', async () => {
    await landDownload();
    await representations.promoteDownloadedAsset(ID, { location: mediaPath });
    const again = await representations.promoteDownloadedAsset(ID, { location: mediaPath });
    expect([again.changed, watchContinuity.recordCarryovers.mock.calls.length]).toEqual([false, 1]);
  });

  test('a failed download leaves the streamable entry usable', async () => {
    await expect(representations.promoteDownloadedAsset(ID, { location: mediaPath })).rejects.toMatchObject({ code: 'unverified-asset' });
    const result = await representations.resolvePlayableRepresentation(ID);
    expect([result.mode, result.representation.location, await visibleEntries()]).toEqual(['upstream', strmPath, [`${stem}.strm`]]);
  });

  test('refuses an empty file', async () => {
    await fs.outputFile(mediaPath, '');
    await expect(representations.promoteDownloadedAsset(ID, { location: mediaPath })).rejects.toMatchObject({ code: 'unverified-asset' });
  });

  test('refuses a file that is not this video\'s', async () => {
    const other = path.join(seasonDir, 'Show - S2026E002 - Other [othervideo1].mp4');
    await fs.outputFile(other, 'media');
    await expect(representations.promoteDownloadedAsset(ID, { location: other })).rejects.toMatchObject({ code: 'unverified-asset' });
  });

  test('a later STRM refresh does not bring the entry back', async () => {
    await landDownload();
    await representations.promoteDownloadedAsset(ID, { location: mediaPath });
    const refresh = await publishStream();
    expect([refresh.status, await visibleEntries()]).toEqual(['skipped', [`${stem}.mp4`]]);
  });
});

describe('concurrent events', () => {
  beforeEach(() => {
    getCapabilities().stream.available = true;
  });

  test('a STRM refresh racing a download converges to the local file', async () => {
    await landDownload();
    await Promise.all([
      publishStream(),
      representations.promoteDownloadedAsset(ID, { location: mediaPath }),
      publishStream(),
    ]);
    const result = await representations.resolvePlayableRepresentation(ID);
    expect([await visibleEntries(), result.mode]).toEqual([[`${stem}.mp4`], 'local']);
  });

  test('a STRM entry written without the lease is cleaned up by the next event', async () => {
    await landDownload();
    await representations.promoteDownloadedAsset(ID, { location: mediaPath });
    await fs.outputFile(strmPath, 'stray');
    await publishStream();
    expect(await visibleEntries()).toEqual([`${stem}.mp4`]);
  });

  test('a busy lease turns a STRM refresh into a retry later, not a second entry', async () => {
    const lease = await store.acquireLease(ID, 'download-promotion');
    const refresh = await publishStream();
    await store.releaseLease(lease);
    expect([refresh.status, await fs.pathExists(strmPath)]).toEqual(['busy', false]);
  });

  test('two promotions of the same file record one local copy', async () => {
    await landDownload();
    await Promise.all([
      representations.promoteDownloadedAsset(ID, { location: mediaPath }),
      representations.promoteDownloadedAsset(ID, { location: mediaPath }),
    ]);
    expect(store.rows.filter(r => r.kind === 'local')).toHaveLength(1);
  });
});

describe('local eviction', () => {
  beforeEach(async () => {
    getCapabilities().stream.available = true;
    representations.registerStreamPublisher({ write: writeStreamEntry });
    await landDownload();
    await representations.promoteDownloadedAsset(ID, { location: mediaPath });
  });

  test('previews removing only the media and keeping metadata and captions', async () => {
    const preview = await representations.previewLocalEviction(ID);
    expect([preview.allowed, preview.remove, preview.keep.map(p => path.basename(p))])
      .toEqual([true, [mediaPath], [`${stem}.en.srt`, `${stem}.nfo`]]);
  });

  test('refuses a protected video', async () => {
    video.protected = true;
    expect((await representations.previewLocalEviction(ID)).reasons.map(r => r.code)).toEqual(['protected']);
  });

  test('refuses a video of a protected channel', async () => {
    Channel.findOne.mockResolvedValue({ auto_removal_protected: true });
    expect((await representations.previewLocalEviction(ID)).reasons.map(r => r.code)).toEqual(['channel_protected']);
  });

  test('refuses while streaming is not available', async () => {
    getCapabilities().stream.available = false;
    expect((await representations.previewLocalEviction(ID)).reasons.map(r => r.code)).toContain('stream_unavailable');
  });

  test('refuses without a STRM publisher', async () => {
    representations.registerStreamPublisher(null);
    expect((await representations.previewLocalEviction(ID)).reasons.map(r => r.code)).toEqual(['stream_publisher_unavailable']);
  });

  test('refuses when YouTube no longer has the video', async () => {
    video.youtube_removed = true;
    expect((await representations.previewLocalEviction(ID)).reasons.map(r => r.code)).toEqual(['source_removed']);
  });

  test('a refused eviction deletes nothing', async () => {
    video.protected = true;
    await expect(representations.evictLocalCopy(ID)).rejects.toMatchObject({ status: 409, code: 'eviction-refused' });
    expect(await fs.pathExists(mediaPath)).toBe(true);
  });

  test('replaces the media with the STRM entry and keeps the sidecars', async () => {
    const { revision } = await representations.previewLocalEviction(ID);
    await representations.evictLocalCopy(ID, { expectedRevision: revision });
    expect((await fs.readdir(seasonDir)).sort()).toEqual([`${stem}.en.srt`, `${stem}.nfo`, `${stem}.strm`]);
  });

  test('marks the video row deleted with a plain-language detail', async () => {
    await representations.evictLocalCopy(ID);
    expect(Video.update).toHaveBeenCalledWith(expect.objectContaining({ removed: true, removed_reason: 'user_deleted' }), { where: { youtubeId: ID } });
  });

  test('carries watch state from the local file to the STRM entry', async () => {
    await representations.evictLocalCopy(ID);
    expect(watchContinuity.recordCarryovers).toHaveBeenLastCalledWith({ youtubeId: ID, fromLocation: mediaPath, toLocation: strmPath });
  });

  test('refuses an eviction previewed before the episode changed', async () => {
    const { revision } = await representations.previewLocalEviction(ID);
    await representations.selectVersion(ID, store.rows[0].id);
    await expect(representations.evictLocalCopy(ID, { expectedRevision: revision })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  });

  test('a later download promotes the episode back to the local file', async () => {
    await representations.evictLocalCopy(ID);
    await landDownload();
    await representations.promoteDownloadedAsset(ID, { location: mediaPath });
    expect([await visibleEntries(), (await representations.resolvePlayableRepresentation(ID)).mode]).toEqual([[`${stem}.mp4`], 'local']);
  });
});

describe('selectVersion', () => {
  test('rejects a representation of another video', async () => {
    await expect(representations.selectVersion(ID, 999)).rejects.toMatchObject({ status: 404 });
  });

  test('rejects a non-integer id', async () => {
    await expect(representations.selectVersion(ID, 'x')).rejects.toMatchObject({ status: 400 });
  });
});

describe('getStatus', () => {
  test('reports playback, representations, carryovers and the eviction preview', async () => {
    await landDownload();
    await representations.promoteDownloadedAsset(ID, { location: mediaPath });
    const status = await representations.getStatus(ID);
    expect([status.playback.mode, status.representations.length, status.eviction.allowed]).toEqual(['local', 1, false]);
  });
});
