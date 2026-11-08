jest.mock('../../ytDlpRunner', () => ({ run: jest.fn() }));
jest.mock('../../configModule', () => ({ getConfig: jest.fn(() => ({})), getCookiesPath: jest.fn(() => null), getYtdlpCacheDir: jest.fn(() => '/cache') }));
jest.mock('../../download/ytdlpCommandBuilder', () => ({ buildCaptionEnrichmentArgs: jest.fn(() => ['--skip-download']) }));

const fs = require('fs');
const os = require('os');
const path = require('path');
const ytDlpRunner = require('../../ytDlpRunner');
const { fetchCaptions, classifyFetchError } = require('../captionFetcher');

const ID = 'abcdefghijk';
let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caption-fetch-')); jest.clearAllMocks(); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

test.each([
  ['ERROR: HTTP Error 429: Too Many Requests', 'throttled'],
  ['Sign in to confirm you\'re not a bot', 'throttled'],
  ['ERROR: [youtube] abc: Video unavailable', 'unavailable'],
  ['ERROR: something else', 'failed'],
])('classifies %p as %s', (message, kind) => {
  expect(classifyFetchError(new Error(message)).kind).toBe(kind);
});

test('a failure reason never carries URLs', () => {
  expect(classifyFetchError(new Error('ERROR: unable to fetch https://example.invalid/x?sig=secret')).message).not.toContain('secret');
});

test('returns the metadata and the fetched caption files', async () => {
  ytDlpRunner.run.mockImplementation(async () => {
    fs.writeFileSync(path.join(dir, `${ID}.info.json`), JSON.stringify({ id: ID }));
    fs.writeFileSync(path.join(dir, `${ID}.en-GB.srt`), 'x');
  });
  const result = await fetchCaptions({ youtubeId: ID, languages: ['en'], outputDir: dir });
  expect([...result.captions.keys()]).toEqual(['en-GB']);
});

test('a non-zero exit with metadata still returns what was fetched', async () => {
  ytDlpRunner.run.mockImplementation(async () => {
    fs.writeFileSync(path.join(dir, `${ID}.info.json`), JSON.stringify({ id: ID }));
    throw new Error('ERROR: Unable to download video subtitles for \'en\'');
  });
  expect((await fetchCaptions({ youtubeId: ID, languages: ['en'], outputDir: dir })).info.id).toBe(ID);
});

test('a throttle is raised even when metadata was written', async () => {
  ytDlpRunner.run.mockRejectedValue(new Error('HTTP Error 429'));
  await expect(fetchCaptions({ youtubeId: ID, languages: ['en'], outputDir: dir })).rejects.toMatchObject({ kind: 'throttled' });
});

test('metadata for another video is rejected', async () => {
  ytDlpRunner.run.mockImplementation(async () => {
    fs.writeFileSync(path.join(dir, `${ID}.info.json`), JSON.stringify({ id: 'zzzzzzzzzzz' }));
  });
  await expect(fetchCaptions({ youtubeId: ID, languages: ['en'], outputDir: dir })).rejects.toMatchObject({ kind: 'failed' });
});

test('the abort signal is handed to the yt-dlp run', async () => {
  ytDlpRunner.run.mockRejectedValue(Object.assign(new Error('yt-dlp run aborted'), { name: 'AbortError' }));
  const controller = new AbortController();
  await fetchCaptions({ youtubeId: ID, languages: ['en'], outputDir: dir, signal: controller.signal }).catch(() => {});
  expect(ytDlpRunner.run.mock.calls[0][1].signal).toBe(controller.signal);
});

test('an aborted run is reported as aborted', async () => {
  ytDlpRunner.run.mockRejectedValue(Object.assign(new Error('yt-dlp run aborted'), { name: 'AbortError' }));
  await expect(fetchCaptions({ youtubeId: ID, languages: ['en'], outputDir: dir })).rejects.toMatchObject({ kind: 'aborted' });
});
