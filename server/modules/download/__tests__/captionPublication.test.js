const fs = require('fs').promises;
const os = require('os');
const path = require('path');
jest.mock('../../../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const logger = require('../../../logger');
const { publishCaption } = require('../captionPublication');

const original = '1\n00:00:00,000 --> 00:00:01,000\nOne\n\n2\n00:00:01,000 --> 00:00:01,010\nOne\n\n3\n00:00:01,010 --> 00:00:02,000\nOne\nTwo\n';
let root;
let mediaRoot;
let subtitlePath;
let backupRoot;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'caption-publication-'));
  mediaRoot = path.join(root, 'media');
  backupRoot = path.join(root, 'backups');
  await fs.mkdir(mediaRoot);
  subtitlePath = path.join(mediaRoot, 'track.srt');
  await fs.writeFile(subtitlePath, original);
});

afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

const publish = extra => publishCaption({ subtitlePath, backupRoot, mediaRoot, provenance: 'automatic', timeline: 'final', ...extra });

test('publishes validated captions and retains a recoverable original outside media', async () => {
  const result = await publish();
  expect(result.status).toBe('published');
  expect(await fs.readFile(result.backupPath, 'utf8')).toBe(original);
  expect(await fs.readFile(subtitlePath, 'utf8')).toContain('00:00:01,010 --> 00:00:02,000\nTwo');
  expect((await fs.readdir(mediaRoot)).sort()).toEqual(['track.srt']);
});

test('is idempotent on repeated publication', async () => {
  await publish();
  const first = await fs.readFile(subtitlePath, 'utf8');
  expect((await publish()).status).toBe('unchanged');
  expect(await fs.readFile(subtitlePath, 'utf8')).toBe(first);
});

test.each([{ provenance: 'unknown' }, { timeline: 'unknown' }, { timeline: 'source' }])('keeps original when evidence is missing: %j', async options => {
  expect((await publish(options)).status).toBe('skipped');
  expect(await fs.readFile(subtitlePath, 'utf8')).toBe(original);
});

test('keeps original on malformed input', async () => {
  await fs.writeFile(subtitlePath, 'invalid');
  expect((await publish()).status).toBe('warning');
  expect(await fs.readFile(subtitlePath, 'utf8')).toBe('invalid');
});

test('keeps original when backup location is inside media', async () => {
  expect((await publish({ backupRoot: path.join(mediaRoot, 'backup') })).status).toBe('warning');
  expect(await fs.readFile(subtitlePath, 'utf8')).toBe(original);
});

test('keeps original when backup creation fails', async () => {
  await fs.writeFile(backupRoot, 'not a directory');
  expect((await publish()).status).toBe('warning');
  expect(await fs.readFile(subtitlePath, 'utf8')).toBe(original);
});

test('keeps original on invalid timing map', async () => {
  expect((await publish({ timeline: 'source', timingMap: [] })).status).toBe('warning');
  expect(await fs.readFile(subtitlePath, 'utf8')).toBe(original);
});

test('keeps the original and removes the temporary file if rename fails', async () => {
  const rename = jest.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('rename failed'));
  try {
    expect((await publish()).status).toBe('warning');
    expect(await fs.readFile(subtitlePath, 'utf8')).toBe(original);
    expect(await fs.readdir(mediaRoot)).toEqual(['track.srt']);
    expect(await fs.readdir(backupRoot)).toHaveLength(1);
  } finally {
    rename.mockRestore();
  }
});

test('preserves the sidecar permissions for media-server readers', async () => {
  await fs.chmod(subtitlePath, 0o644);
  expect((await publish()).status).toBe('published');
  expect((await fs.stat(subtitlePath)).mode & 0o777).toBe(0o644);
});


test('leaves human captions with rolling-shaped speech unchanged', async () => {
  expect((await publish({ provenance: 'human' })).status).toBe('unchanged');
  expect(await fs.readFile(subtitlePath, 'utf8')).toBe(original);
});

test('logs the retained original with the YouTube id', async () => {
  const result = await publish({ youtubeId: 'abc123' });
  expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ youtubeId: 'abc123', backupPath: result.backupPath }), expect.any(String));
});

test('uses the pre-cut captions with the verified cut map', async () => {
  const source = '1\n00:00:00,200 --> 00:00:00,600\none\n\n2\n00:00:02,500 --> 00:00:02,900\nremoved\n\n3\n00:00:04,200 --> 00:00:04,600\ntwo\n';
  const timingMap = [{ sourceStart: 0, sourceEnd: 2000, destStart: 0 }, { sourceStart: 4000, sourceEnd: 6000, destStart: 2000 }];
  const result = await publish({ source, timeline: 'source', timingMap });
  expect(result.status).toBe('published');
  const output = await fs.readFile(subtitlePath, 'utf8');
  expect(output).not.toContain('removed');
  expect(output).toContain('00:00:02,200 --> 00:00:02,600\ntwo');
});
