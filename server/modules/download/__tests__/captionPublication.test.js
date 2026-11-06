const fs = require('fs').promises;
const os = require('os');
const path = require('path');
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


test('copies human captions without removing rolling-shaped speech', async () => {
  const destinationPath = path.join(mediaRoot, 'destination.srt');
  expect((await publish({ provenance: 'human', destinationPath })).status).toBe('published');
  expect((await fs.readFile(destinationPath, 'utf8')).trim()).toBe(original.trim());
});

test('atomically replaces an existing destination and retains both originals', async () => {
  const destinationPath = path.join(mediaRoot, 'destination.srt');
  await fs.writeFile(destinationPath, 'prior playable captions');
  expect((await publish({ destinationPath })).status).toBe('published');
  const backups = await Promise.all((await fs.readdir(backupRoot)).map(file => fs.readFile(path.join(backupRoot, file), 'utf8')));
  expect(backups.sort()).toEqual([original, 'prior playable captions'].sort());
  expect(await fs.readFile(destinationPath, 'utf8')).toContain('Two');
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

test.each(['malformed', 'backup', 'rename'])('preserves an existing destination after %s failure', async failure => {
  const destinationPath = path.join(mediaRoot, 'destination.srt');
  await fs.writeFile(destinationPath, 'prior playable captions');
  if (failure === 'malformed') await fs.writeFile(subtitlePath, 'invalid');
  if (failure === 'backup') await fs.writeFile(backupRoot, 'not a directory');
  const rename = failure === 'rename' ? jest.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('rename failed')) : null;
  try {
    expect((await publish({ destinationPath })).status).toBe('warning');
    expect(await fs.readFile(destinationPath, 'utf8')).toBe('prior playable captions');
  } finally { if (rename) rename.mockRestore(); }
});
