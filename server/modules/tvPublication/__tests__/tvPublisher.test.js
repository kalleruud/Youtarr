/* eslint-env jest */
jest.mock('../../../logger');
const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const { planPublication } = require('../tvPlanner');
const tvPublisher = require('../tvPublisher');

const ID = 'vid12345678';
const CHANNEL = 'UCchannel01';
const video = { youtubeId: ID, channelId: CHANNEL, title: 'First', showTitle: 'Show', description: 'plot' };
const assignment = { season: 2026, episode: 1, publishedAt: '2026-01-05T00:00:00.000Z', status: 'assigned' };

let root;
let tempDir;
let library;

async function downloadFixture() {
  const stem = `Show - First [${ID}]`;
  await fs.outputFile(path.join(tempDir, `${stem}.mp4`), 'media-bytes');
  await fs.outputFile(path.join(tempDir, `${stem}.en.srt`), '1\n00:00:00,000 --> 00:00:01,000\nhi\n');
  await fs.outputFile(path.join(tempDir, `${stem}.jpg`), 'jpg');
  return tvPublisher.collectAssets(path.join(tempDir, `${stem}.mp4`));
}

function plan(assets, overrides = {}) {
  return planPublication({ video, assignment, assets, layout: { parentDir: library }, now: new Date('2026-02-01T00:00:00Z'), ...overrides });
}

async function listTree(dir) {
  const out = [];
  for (const name of (await fs.readdir(dir)).sort()) {
    const full = path.join(dir, name);
    if ((await fs.stat(full)).isDirectory()) out.push(...(await listTree(full)).map((n) => `${name}/${n}`));
    else out.push(name);
  }
  return out;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'tvpub-'));
  tempDir = path.join(root, 'temp');
  library = path.join(root, 'library');
  await fs.ensureDir(library);
});

afterEach(async () => {
  await fs.remove(root);
});

describe('tvPublisher', () => {
  test('collectAssets finds language-tagged subtitles and the thumbnail beside the media', async () => {
    const assets = await downloadFixture();
    expect([assets.subtitles.map((s) => s.language), path.basename(assets.thumbnail)]).toEqual([['en'], `Show - First [${ID}].jpg`]);
  });

  test('publishes show, season, episode, caption and thumbnail files with no staging leftovers', async () => {
    await tvPublisher.publish(plan(await downloadFixture()));
    expect(await listTree(library)).toEqual([
      `Show [${CHANNEL}]/Season 2026/Show - S2026E001 - First [${ID}]-thumb.jpg`,
      `Show [${CHANNEL}]/Season 2026/Show - S2026E001 - First [${ID}].en.srt`,
      `Show [${CHANNEL}]/Season 2026/Show - S2026E001 - First [${ID}].mp4`,
      `Show [${CHANNEL}]/Season 2026/Show - S2026E001 - First [${ID}].nfo`,
      `Show [${CHANNEL}]/Season 2026/season.nfo`,
      `Show [${CHANNEL}]/tvshow.nfo`,
    ]);
  });

  test('moves the media out of temp and removes published sidecar sources', async () => {
    await tvPublisher.publish(plan(await downloadFixture()));
    expect(await fs.readdir(tempDir)).toEqual([]);
  });

  test('a failed publication exposes no episode and restores the media to temp', async () => {
    const assets = await downloadFixture();
    const p = plan(assets);
    p.sidecars[0].source = path.join(tempDir, 'missing.en.srt');
    await expect(tvPublisher.publish(p)).rejects.toThrow();
    const seasonFiles = await fs.readdir(p.seasonDir);
    expect([
      await fs.pathExists(assets.media),
      seasonFiles.some((name) => name.endsWith('.mp4') || name.endsWith(`[${ID}].nfo`) || name.startsWith(tvPublisher.STAGING_PREFIX)),
    ]).toEqual([true, false]);
  });

  test('republishing the same plan rewrites nothing', async () => {
    const assets = await downloadFixture();
    const first = plan(assets);
    await tvPublisher.publish(first);
    const again = plan({ media: first.media.target, subtitles: [], thumbnail: null });
    const result = await tvPublisher.publish(again);
    expect(result.written).toEqual([]);
  });

  test('findExistingEpisode returns the published stem and its dateadded', async () => {
    const p = plan(await downloadFixture());
    await tvPublisher.publish(p);
    expect(await tvPublisher.findExistingEpisode(p.seasonDir, ID)).toEqual({
      stem: p.stem, mediaName: `${p.stem}.mp4`, dateAdded: '2026-02-01 00:00:00',
    });
  });

  test('a second copy under another stem is removed so the episode is not duplicated', async () => {
    const p = plan(await downloadFixture());
    await fs.outputFile(path.join(p.seasonDir, `Show - S2026E001 - Old [${ID}].mp4`), 'old');
    await fs.outputFile(path.join(p.seasonDir, 'Show - S2026E002 - Other [otherVid01].mp4'), 'other');
    const result = await tvPublisher.publish(p);
    expect([result.removed.map((f) => path.basename(f)), (await fs.readdir(p.seasonDir)).filter((n) => n.endsWith('.mp4'))])
      .toEqual([[`Show - S2026E001 - Old [${ID}].mp4`], [`Show - S2026E001 - First [${ID}].mp4`, 'Show - S2026E002 - Other [otherVid01].mp4'].sort()]);
  });

  test('a re-download in another container replaces the old media and keeps sidecars and show artwork', async () => {
    const p = plan(await downloadFixture());
    await fs.outputFile(path.join(p.seasonDir, `${p.stem}.mkv`), 'old');
    await fs.outputFile(path.join(p.showDir, 'poster.jpg'), 'poster');
    await fs.outputFile(path.join(p.showDir, 'backdrop.jpg'), 'backdrop');
    await tvPublisher.publish(p);
    expect(await listTree(p.showDir)).toEqual([
      `Season 2026/${p.stem}-thumb.jpg`,
      `Season 2026/${p.stem}.en.srt`,
      `Season 2026/${p.stem}.mp4`,
      `Season 2026/${p.stem}.nfo`,
      'Season 2026/season.nfo',
      'backdrop.jpg',
      'poster.jpg',
      'tvshow.nfo',
    ]);
  });

  test('findShowFolderName finds the show folder by channel ID only', async () => {
    await fs.ensureDir(path.join(library, `Renamed [${CHANNEL}]`));
    await fs.ensureDir(path.join(library, 'Other [UCother]'));
    expect(await tvPublisher.findShowFolderName(library, CHANNEL)).toBe(`Renamed [${CHANNEL}]`);
  });

  test('findShowFolderName returns null for a missing library folder', async () => {
    expect(await tvPublisher.findShowFolderName(path.join(root, 'nope'), CHANNEL)).toBeNull();
  });

  describe('streamed episode entries (#14)', () => {
    const seasonDir = () => path.join(library, `Show [${CHANNEL}]`, 'Season 2026');
    const streamStem = `Show - S2026E001 - Old Title [${ID}]`;

    async function publishStreamFixture() {
      await fs.outputFile(path.join(seasonDir(), `${streamStem}.strm`), 'http://youtarr/play/x');
      await fs.outputFile(path.join(seasonDir(), `${streamStem}.nfo`), '<episodedetails><dateadded>2026-01-06 08:00:00</dateadded></episodedetails>');
      await fs.outputFile(path.join(seasonDir(), `${streamStem}.en.srt`), '1\n00:00:00,000 --> 00:00:01,000\nhi\n');
    }

    test('findExistingEpisode returns a STRM entry so a download keeps its stem', async () => {
      await publishStreamFixture();
      expect(await tvPublisher.findExistingEpisode(seasonDir(), ID)).toEqual({
        stem: streamStem, mediaName: `${streamStem}.strm`, dateAdded: '2026-01-06 08:00:00',
      });
    });

    test('findExistingEpisode prefers a media file over a STRM entry', async () => {
      await publishStreamFixture();
      await fs.outputFile(path.join(seasonDir(), `${streamStem}.mp4`), 'media');
      expect((await tvPublisher.findExistingEpisode(seasonDir(), ID)).mediaName).toBe(`${streamStem}.mp4`);
    });

    test('a download published under the STRM stem leaves one visible episode entry', async () => {
      await publishStreamFixture();
      const existing = await tvPublisher.findExistingEpisode(seasonDir(), ID);
      const assets = await downloadFixture();
      await tvPublisher.publish(plan(assets, {
        layout: { parentDir: library, showFolderName: `Show [${CHANNEL}]`, existingStem: existing.stem, dateAdded: existing.dateAdded },
      }));
      const entries = (await fs.readdir(seasonDir())).filter((name) => /\.(mp4|strm)$/.test(name));
      expect(entries).toEqual([`${streamStem}.mp4`]);
    });

    test('a failed download publication leaves the STRM entry in place', async () => {
      await publishStreamFixture();
      const assets = await downloadFixture();
      const failing = plan(assets, { layout: { parentDir: library, showFolderName: `Show [${CHANNEL}]`, existingStem: streamStem } });
      failing.sidecars.push({ role: 'subtitle', source: path.join(tempDir, 'missing.en.srt'), target: path.join(seasonDir(), `${streamStem}.de.srt`) });
      await expect(tvPublisher.publish(failing)).rejects.toThrow();
      expect([await fs.pathExists(path.join(seasonDir(), `${streamStem}.strm`)), await fs.pathExists(assets.media)]).toEqual([true, true]);
    });

    test('a STRM publication never removes a local media file', async () => {
      const mediaStem = `Show - S2026E001 - First [${ID}]`;
      await fs.outputFile(path.join(seasonDir(), `${mediaStem}.mp4`), 'media');
      const strmSource = path.join(tempDir, `${mediaStem}.strm`);
      await fs.outputFile(strmSource, 'http://youtarr/play/x');
      await tvPublisher.publish(plan({ media: strmSource, subtitles: [], thumbnail: null }, {
        layout: { parentDir: library, showFolderName: `Show [${CHANNEL}]`, existingStem: mediaStem },
      }));
      expect(await fs.pathExists(path.join(seasonDir(), `${mediaStem}.mp4`))).toBe(true);
    });
  });
});
