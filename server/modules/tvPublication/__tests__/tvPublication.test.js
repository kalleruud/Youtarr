/* eslint-env jest */
jest.mock('../../../logger');

const mockConfig = { libraryOutputProfile: 'jellyfinTv' };
let mockJobsPath;
jest.mock('../../configModule', () => ({
  getConfig: jest.fn(() => mockConfig),
  getJobsPath: jest.fn(() => mockJobsPath),
}));
jest.mock('../../episodeAssignment', () => ({ ensureEpisodeAssignment: jest.fn() }));
jest.mock('../../../models', () => ({
  Video: { findOne: jest.fn() },
  Channel: { findOne: jest.fn() },
}));

const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const episodeAssignment = require('../../episodeAssignment');
const { Video, Channel } = require('../../../models');
const tvPublication = require('..');

const ID = 'vid12345678';
const CHANNEL = 'UCchannel01';
const info = { id: ID, title: 'First', upload_date: '20260105', channel: 'Show', description: 'plot', duration: 90 };
const assigned = { showKey: CHANNEL, season: 2026, episode: 1, publishedAt: '2026-01-05T00:00:00.000Z', status: 'assigned' };

let root;
let library;
let tempDir;

beforeEach(async () => {
  jest.clearAllMocks();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'tvpub-index-'));
  library = path.join(root, 'library');
  tempDir = path.join(root, 'temp');
  mockJobsPath = path.join(root, 'jobs');
  await fs.ensureDir(library);
  episodeAssignment.ensureEpisodeAssignment.mockResolvedValue(assigned);
  Channel.findOne.mockResolvedValue({ title: 'Show', description: 'channel about' });
});

afterEach(async () => {
  await fs.remove(root);
});

async function downloadAndPublish() {
  const media = path.join(tempDir, `Show - First [${ID}].mp4`);
  await fs.outputFile(media, 'media');
  await fs.outputFile(path.join(tempDir, `Show - First [${ID}].de.vtt`), 'WEBVTT');
  const prepared = await tvPublication.prepareDownload({
    info, channelId: CHANNEL, channelRecord: { title: 'Show' }, mediaPath: media, baseDir: library, subfolder: null,
  });
  // The post-processor converts/prunes subtitles between planning and publishing.
  await fs.remove(path.join(tempDir, `Show - First [${ID}].de.vtt`));
  await fs.outputFile(path.join(tempDir, `Show - First [${ID}].de.srt`), 'srt');
  return { prepared, published: await tvPublication.publishDownload(prepared) };
}

describe('tvPublication', () => {
  test('is enabled only by the jellyfinTv profile', () => {
    expect([tvPublication.isEnabled({ libraryOutputProfile: 'jellyfinTv' }), tvPublication.isEnabled({}), tvPublication.profileOf({})])
      .toEqual([true, false, 'movie']);
  });

  test('assigns the episode with the exact upload date', async () => {
    await downloadAndPublish();
    expect(episodeAssignment.ensureEpisodeAssignment).toHaveBeenCalledWith({
      channelId: CHANNEL, youtubeId: ID, publishedAt: '2026-01-05T00:00:00.000Z', source: 'exact',
    });
  });

  test('publishes the subtitles present at publish time, not at planning time', async () => {
    const { published } = await downloadAndPublish();
    expect((await fs.readdir(path.dirname(published.mediaPath))).filter((n) => n.endsWith('.srt') || n.endsWith('.vtt')))
      .toEqual([`Show - S2026E001 - First [${ID}].de.srt`]);
  });

  test('places a subfoldered channel under its __subfolder', async () => {
    const media = path.join(tempDir, `x [${ID}].mp4`);
    await fs.outputFile(media, 'media');
    const { plan } = await tvPublication.prepareDownload({ info, channelId: CHANNEL, channelRecord: null, mediaPath: media, baseDir: library, subfolder: 'Kids' });
    expect(plan.showDir).toBe(path.join(library, '__Kids', `Show [${CHANNEL}]`));
  });

  test('skips publication (no invented season) when the date is unknown', async () => {
    episodeAssignment.ensureEpisodeAssignment.mockResolvedValue({ showKey: CHANNEL, season: null, episode: null, status: 'date-required' });
    const result = await tvPublication.prepareDownload({
      info: { ...info, upload_date: null }, channelId: CHANNEL, channelRecord: null, mediaPath: path.join(tempDir, 'a.mp4'), baseDir: library,
    });
    expect(result).toEqual(expect.objectContaining({ skipped: 'date-required' }));
  });

  test('a repeat download of the same video reuses its published stem', async () => {
    const first = await downloadAndPublish();
    const second = await downloadAndPublish();
    expect(second.published.mediaPath).toBe(first.published.mediaPath);
  });

  describe('regenerateMetadata', () => {
    async function publishedVideo() {
      const { published } = await downloadAndPublish();
      await fs.outputJson(path.join(mockJobsPath, 'info', `${ID}.info.json`), { ...info, title: 'Corrected title' });
      Video.findOne.mockResolvedValue({ youtubeId: ID, channel_id: CHANNEL, filePath: published.mediaPath, removed: false, normalized_rating: null });
      return published;
    }

    test('rewrites the episode NFO without moving or rewriting the media', async () => {
      const published = await publishedVideo();
      const before = await fs.stat(published.mediaPath);
      const result = await tvPublication.regenerateMetadata(ID);
      const nfo = await fs.readFile(published.mediaPath.replace(/\.mp4$/, '.nfo'), 'utf8');
      expect([result.mediaPath, (await fs.stat(published.mediaPath)).mtimeMs, nfo.includes('<title>Corrected title</title>')])
        .toEqual([published.mediaPath, before.mtimeMs, true]);
    });

    test('keeps the published subtitles and thumbnail', async () => {
      const published = await publishedVideo();
      const before = (await fs.readdir(path.dirname(published.mediaPath))).sort();
      await tvPublication.regenerateMetadata(ID);
      expect((await fs.readdir(path.dirname(published.mediaPath))).sort()).toEqual(before);
    });

    test('refuses a file still in the movie layout', async () => {
      Video.findOne.mockResolvedValue({ youtubeId: ID, channel_id: CHANNEL, filePath: `/library/Show/Show - First - ${ID}/Show - First [${ID}].mp4`, removed: false });
      await expect(tvPublication.regenerateMetadata(ID)).rejects.toMatchObject({ code: 'not-published' });
    });

    test('refuses a video with no downloaded file', async () => {
      Video.findOne.mockResolvedValue(null);
      await expect(tvPublication.regenerateMetadata(ID)).rejects.toMatchObject({ code: 'not-found' });
    });

    test('refuses when the cached metadata is missing', async () => {
      const published = await publishedVideo();
      await fs.remove(path.join(mockJobsPath, 'info'));
      Video.findOne.mockResolvedValue({ youtubeId: ID, channel_id: CHANNEL, filePath: published.mediaPath, removed: false });
      await expect(tvPublication.regenerateMetadata(ID)).rejects.toMatchObject({ code: 'metadata-missing' });
    });

    test('refuses when the assignment points at another season', async () => {
      await publishedVideo();
      episodeAssignment.ensureEpisodeAssignment.mockResolvedValue({ ...assigned, season: 2025 });
      await expect(tvPublication.regenerateMetadata(ID)).rejects.toMatchObject({ code: 'layout-mismatch' });
    });
  });
});
