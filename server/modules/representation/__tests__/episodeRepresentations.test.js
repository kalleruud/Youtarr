/* eslint-env jest */
// The facade against real files in a temp dir and an in-memory store with the
// real lease rules: promotion, STRM publication, eviction and convergence.
jest.mock('../../../logger');
jest.mock('../representationStore', () => require('./fakeRepresentationStore').createFakeStore());
jest.mock('../watchContinuity', () => ({ ensureCarryovers: jest.fn().mockResolvedValue(0), listForYoutubeId: jest.fn().mockResolvedValue([]) }));
jest.mock('../../configModule', () => ({ directoryPath: '' }));
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
const configModule = require('../../configModule');
const logger = require('../../../logger');
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
  watchContinuity.ensureCarryovers.mockResolvedValue(0);
  configModule.directoryPath = root;
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
    expect(watchContinuity.ensureCarryovers).toHaveBeenCalledWith({ youtubeId: ID, fromLocation: strmPath, toLocation: mediaPath });
  });

  test('leaves the STRM published when its durable watch snapshot fails and repairs on retry', async () => {
    await landDownload();
    watchContinuity.ensureCarryovers.mockRejectedValueOnce(new Error('snapshot unavailable'));
    await expect(representations.promoteDownloadedAsset(ID, { location: mediaPath })).rejects.toThrow('snapshot unavailable');
    expect(store.rows.map(r => [r.kind, r.state])).toEqual([['strm', 'published']]);
    expect(await fs.pathExists(strmPath)).toBe(true);
    await representations.promoteDownloadedAsset(ID, { location: mediaPath });
    expect(await visibleEntries()).toEqual([`${stem}.mp4`]);
  });

  test('is idempotent', async () => {
    await landDownload();
    await representations.promoteDownloadedAsset(ID, { location: mediaPath });
    const snapshots = watchContinuity.ensureCarryovers.mock.calls.length;
    const again = await representations.promoteDownloadedAsset(ID, { location: mediaPath });
    expect([again.changed, watchContinuity.ensureCarryovers.mock.calls.length]).toEqual([false, snapshots]);
  });

  test('records the watch state while the STRM entry is still visible', async () => {
    await landDownload();
    const visibleAtSnapshot = [];
    watchContinuity.ensureCarryovers.mockImplementation(async () => { visibleAtSnapshot.push(...await visibleEntries()); return 1; });
    await representations.promoteDownloadedAsset(ID, { location: mediaPath });
    expect(visibleAtSnapshot).toContain(`${stem}.strm`);
  });

  test('a retried promotion repairs a snapshot an interrupted run left out', async () => {
    // An earlier run retired the STRM entry but crashed before recording the local copy.
    await landDownload();
    await fs.remove(strmPath);
    store.rows[0].state = 'retired';
    await representations.promoteDownloadedAsset(ID, { location: mediaPath });
    expect(watchContinuity.ensureCarryovers).toHaveBeenCalledWith({ youtubeId: ID, fromLocation: strmPath, toLocation: mediaPath });
  });

  test('a later STRM refresh retries the removal of an entry whose snapshot failed', async () => {
    await landDownload();
    watchContinuity.ensureCarryovers.mockRejectedValueOnce(new Error('snapshot unavailable'));
    await representations.promoteDownloadedAsset(ID, { location: mediaPath }).catch(() => {});
    video.filePath = mediaPath;
    await publishStream();
    expect(await visibleEntries()).toEqual([`${stem}.mp4`]);
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
    // The promotion may find the lease busy (a video without a STRM entry
    // never waits for it); the STRM writer holding it then yields.
    await Promise.allSettled([
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

  test('a STRM entry is kept beside a partial recording', async () => {
    const recordingPath = path.join(seasonDir, `${stem}.mkv`);
    await fs.outputFile(recordingPath, 'gappy');
    const lease = await store.acquireLease(ID, 'download-promotion');
    await store.record(lease, { kind: 'recording', variant: 'r1', state: 'partial', location: recordingPath });
    await store.releaseLease(lease);
    const result = await publishStream();
    expect([result.status, await visibleEntries()]).toEqual(['published', [`${stem}.strm`]]);
  });

  test('a busy lease turns a STRM refresh into a retry later, not a second entry', async () => {
    const lease = await store.acquireLease(ID, 'download-promotion');
    const refresh = await publishStream();
    await store.releaseLease(lease);
    expect([refresh.status, await fs.pathExists(strmPath)]).toEqual(['busy', false]);
  });

  test('two promotions of the same file record one local copy', async () => {
    await landDownload();
    await Promise.allSettled([
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
    expect(watchContinuity.ensureCarryovers).toHaveBeenLastCalledWith({ youtubeId: ID, fromLocation: mediaPath, toLocation: strmPath });
  });

  test('records the watch state before anything visible changes', async () => {
    watchContinuity.ensureCarryovers.mockImplementation(async () => {
      expect(await visibleEntries()).toEqual([`${stem}.mp4`]);
      return 1;
    });
    await representations.evictLocalCopy(ID);
    expect(watchContinuity.ensureCarryovers).toHaveBeenCalledWith({ youtubeId: ID, fromLocation: mediaPath, toLocation: strmPath });
  });

  test('changes nothing when the watch state cannot be recorded', async () => {
    watchContinuity.ensureCarryovers.mockRejectedValueOnce(new Error('snapshot unavailable'));
    await expect(representations.evictLocalCopy(ID)).rejects.toThrow('snapshot unavailable');
    expect([await visibleEntries(), Video.update.mock.calls.length]).toEqual([[`${stem}.mp4`], 0]);
  });

  test('a retried eviction after a failed snapshot completes', async () => {
    watchContinuity.ensureCarryovers.mockRejectedValueOnce(new Error('snapshot unavailable'));
    await representations.evictLocalCopy(ID).catch(() => {});
    await representations.evictLocalCopy(ID);
    expect(await visibleEntries()).toEqual([`${stem}.strm`]);
  });

  test('keeps a local file that a download replaced during the eviction', async () => {
    representations.registerStreamPublisher({
      write: async () => {
        await fs.remove(mediaPath);
        await fs.outputFile(mediaPath, 'a newer, longer download');
        return writeStreamEntry();
      },
    });
    await expect(representations.evictLocalCopy(ID)).rejects.toMatchObject({ code: 'local-copy-changed' });
    expect([await visibleEntries(), await fs.readFile(mediaPath, 'utf8')]).toEqual([[`${stem}.mp4`], 'a newer, longer download']);
  });

  test('stops before removing the local file when the lease was taken over', async () => {
    representations.registerStreamPublisher({
      write: async () => {
        const written = await writeStreamEntry();
        store.expireLease(ID);
        await store.acquireLease(ID, 'download-promotion');
        return written;
      },
    });
    await expect(representations.evictLocalCopy(ID)).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect(await visibleEntries()).toEqual([`${stem}.mp4`]);
  });

  test('refuses while the downloads folder looks unmounted', async () => {
    configModule.directoryPath = path.join(root, 'unmounted');
    expect((await representations.previewLocalEviction(ID)).reasons.map(r => r.code)).toEqual(['library_unavailable']);
  });

  test('a refused eviction of an unmounted library deletes nothing', async () => {
    configModule.directoryPath = path.join(root, 'unmounted');
    await expect(representations.evictLocalCopy(ID)).rejects.toMatchObject({ status: 409, code: 'eviction-refused' });
    expect(await fs.pathExists(mediaPath)).toBe(true);
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

describe('publishDownloadedEpisode (TV publication of a download)', () => {
  // Stands in for tvPublication.publishDownload: lands the media and, like
  // the TV publisher, removes the STRM entry unless asked to keep it.
  const publisher = () => jest.fn(async ({ keepStreamEntries }) => {
    await landDownload();
    if (!keepStreamEntries) await fs.remove(strmPath);
    return { mediaPath };
  });

  describe('a streamed episode', () => {
    beforeEach(async () => {
      getCapabilities().stream.available = true;
      await publishStream();
    });

    test('records the watch state before the publisher replaces the STRM entry', async () => {
      const publish = publisher();
      watchContinuity.ensureCarryovers.mockImplementation(async () => {
        expect(publish).not.toHaveBeenCalled();
        return 1;
      });
      await representations.publishDownloadedEpisode(ID, { plannedLocation: mediaPath, publish });
      expect(watchContinuity.ensureCarryovers).toHaveBeenCalledWith({ youtubeId: ID, fromLocation: strmPath, toLocation: mediaPath });
    });

    test('leaves one visible entry, the local file', async () => {
      await representations.publishDownloadedEpisode(ID, { plannedLocation: mediaPath, publish: publisher() });
      expect([await visibleEntries(), store.rows.map(r => [r.kind, r.state])])
        .toEqual([[`${stem}.mp4`], [['strm', 'retired'], ['local', 'verified']]]);
    });

    test('keeps the STRM entry when its watch state cannot be recorded, and still publishes', async () => {
      watchContinuity.ensureCarryovers.mockRejectedValue(new Error('snapshot unavailable'));
      const publish = publisher();
      const result = await representations.publishDownloadedEpisode(ID, { plannedLocation: mediaPath, publish });
      expect([result.mediaPath, publish.mock.calls[0][0], await fs.pathExists(strmPath)])
        .toEqual([mediaPath, { keepStreamEntries: true }, true]);
    });

    test('the next promotion repairs the snapshot and removes the kept STRM entry', async () => {
      watchContinuity.ensureCarryovers.mockRejectedValueOnce(new Error('snapshot unavailable'))
        .mockRejectedValueOnce(new Error('snapshot unavailable'));
      await representations.publishDownloadedEpisode(ID, { plannedLocation: mediaPath, publish: publisher() });
      watchContinuity.ensureCarryovers.mockResolvedValue(1);
      await representations.promoteDownloadedAsset(ID, { location: mediaPath });
      expect(await visibleEntries()).toEqual([`${stem}.mp4`]);
    });
  });

  describe('a video without a STRM entry', () => {
    test('publishes without waiting for the lease or recording watch state', async () => {
      const acquire = jest.spyOn(store, 'acquireLease');
      const publish = publisher();
      await representations.publishDownloadedEpisode(ID, { plannedLocation: mediaPath, publish });
      expect([acquire.mock.calls[0][2], publish.mock.calls[0][0], watchContinuity.ensureCarryovers.mock.calls.length])
        .toEqual([{ waitMs: 0 }, { keepStreamEntries: false }, 0]);
      acquire.mockRestore();
    });

    test('a busy lease does not delay the download', async () => {
      const lease = await store.acquireLease(ID, 'selection');
      const started = Date.now();
      await representations.publishDownloadedEpisode(ID, { plannedLocation: mediaPath, publish: publisher() });
      await store.releaseLease(lease);
      expect([Date.now() - started < 1000, await visibleEntries()]).toEqual([true, [`${stem}.mp4`]]);
    });

    test('a representation database error never fails the download', async () => {
      const list = jest.spyOn(store, 'list').mockRejectedValue(new Error('database down'));
      const acquire = jest.spyOn(store, 'acquireLease').mockRejectedValue(new Error('database down'));
      const result = await representations.publishDownloadedEpisode(ID, { plannedLocation: mediaPath, publish: publisher() });
      list.mockRestore();
      acquire.mockRestore();
      expect([result.mediaPath, await fs.pathExists(mediaPath)]).toEqual([mediaPath, true]);
    });

    test('a representation database error is logged', async () => {
      const list = jest.spyOn(store, 'list').mockRejectedValue(new Error('database down'));
      await representations.publishDownloadedEpisode(ID, { plannedLocation: mediaPath, publish: publisher() });
      list.mockRestore();
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ youtubeId: ID }), expect.stringContaining('representation'));
    });

    test('touches no representation record before the file is published', async () => {
      const list = jest.spyOn(store, 'list');
      const acquire = jest.spyOn(store, 'acquireLease');
      let touchedBeforePublish = null;
      await representations.publishDownloadedEpisode(ID, {
        plannedLocation: mediaPath,
        publish: async () => {
          touchedBeforePublish = list.mock.calls.length + acquire.mock.calls.length;
          await landDownload();
          return { mediaPath };
        },
      });
      list.mockRestore();
      acquire.mockRestore();
      expect(touchedBeforePublish).toBe(0);
    });

    test('a publication failure is the download\'s own error', async () => {
      const publish = jest.fn().mockRejectedValue(new Error('disk full'));
      await expect(representations.publishDownloadedEpisode(ID, { plannedLocation: mediaPath, publish })).rejects.toThrow('disk full');
    });
  });

  test('promoting a download of a video without a STRM entry does not wait for a busy lease', async () => {
    await landDownload();
    const lease = await store.acquireLease(ID, 'selection');
    const started = Date.now();
    await expect(representations.promoteDownloadedAsset(ID, { location: mediaPath })).rejects.toMatchObject({ code: 'LEASE_BUSY' });
    await store.releaseLease(lease);
    expect(Date.now() - started < 1000).toBe(true);
  });
});

describe('lease takeover', () => {
  beforeEach(() => {
    getCapabilities().stream.available = true;
  });

  const deferred = () => {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
  };

  test('a STRM writer that lost its lease while writing leaves the downloaded file as the only entry', async () => {
    const download = representations.publishDownloadedEpisode.bind(representations, ID, {
      plannedLocation: mediaPath, publish: async () => { await landDownload(); return { mediaPath }; },
    });
    const result = await representations.publishStreamEntry(ID, {
      write: async () => {
        // The writer pauses past its lease; a download takes over and publishes.
        store.expireLease(ID);
        await download();
        return writeStreamEntry();
      },
    }).catch(err => err);
    expect([result.code, await visibleEntries()]).toEqual(['LEASE_LOST', [`${stem}.mp4`]]);
  });

  test('a STRM writer taken over before it writes changes no file', async () => {
    const write = jest.fn(writeStreamEntry);
    const lease = await store.acquireLease(ID, 'stream-publication');
    store.expireLease(ID);
    const takeover = await store.acquireLease(ID, 'download-promotion');
    await expect(representations._writeStreamEntry(lease, ID, write)).rejects.toMatchObject({ code: 'LEASE_LOST' });
    await store.releaseLease(takeover);
    expect([write.mock.calls.length, await fs.pathExists(strmPath)]).toEqual([0, false]);
  });

  test('a download that published without the lease wins over the STRM entry its holder writes', async () => {
    const paused = deferred();
    const writing = deferred();
    const publication = representations.publishStreamEntry(ID, {
      write: async () => { writing.resolve(); await paused.promise; return writeStreamEntry(); },
    });
    await writing.promise;
    await representations.publishDownloadedEpisode(ID, {
      plannedLocation: mediaPath, publish: async () => { await landDownload(); return { mediaPath }; },
    });
    paused.resolve();
    const result = await publication;
    expect([result.status, await visibleEntries()]).toEqual(['skipped', [`${stem}.mp4`]]);
  });

  test('the next promotion records the download that published without the lease', async () => {
    const paused = deferred();
    const writing = deferred();
    const publication = representations.publishStreamEntry(ID, {
      write: async () => { writing.resolve(); await paused.promise; return writeStreamEntry(); },
    });
    await writing.promise;
    await representations.publishDownloadedEpisode(ID, {
      plannedLocation: mediaPath, publish: async () => { await landDownload(); return { mediaPath }; },
    });
    paused.resolve();
    await publication;
    await representations.promoteDownloadedAsset(ID, { location: mediaPath });
    expect((await representations.resolvePlayableRepresentation(ID)).representation.location).toBe(mediaPath);
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
