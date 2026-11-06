const fs = require('fs');
const path = require('path');
const files = require('../captionFiles');
const { createSandbox } = require('./sandbox');
const { SRT } = require('./fixtures');

let sandbox;
beforeEach(() => { sandbox = createSandbox(); });
afterEach(() => sandbox.cleanup());

const backupRoot = () => path.join(sandbox.jobsPath, 'caption-originals');

test('lists the video sidecars with their codes', async () => {
  fs.writeFileSync(sandbox.sidecar('en-GB'), SRT);
  fs.writeFileSync(sandbox.sidecar('zh-Hans'), SRT);
  expect((await files.listSidecars(sandbox.filePath)).map((item) => item.code)).toEqual(['en-GB', 'zh-Hans']);
});

test('installing over a track keeps the replaced bytes in the backup folder', async () => {
  fs.writeFileSync(sandbox.sidecar('en'), 'old caption');
  const { backupPath } = await files.installCaption({
    targetPath: sandbox.sidecar('en'), bytes: Buffer.from(SRT), backupRoot: backupRoot(), mediaRoot: sandbox.mediaRoot,
  });
  expect(fs.readFileSync(backupPath, 'utf8')).toBe('old caption');
});

test('installing writes the new bytes and leaves no temporary file', async () => {
  await files.installCaption({ targetPath: sandbox.sidecar('en'), bytes: Buffer.from(SRT), backupRoot: backupRoot(), mediaRoot: sandbox.mediaRoot });
  expect(fs.readdirSync(sandbox.videoDir).sort()).toEqual(['Video [abcdefghijk].en.srt', 'Video [abcdefghijk].mp4']);
});

test('a target outside the media root is refused', async () => {
  await expect(files.installCaption({
    targetPath: path.join(sandbox.jobsPath, 'x.srt'), bytes: Buffer.from(SRT), backupRoot: backupRoot(), mediaRoot: sandbox.mediaRoot,
  })).rejects.toThrow('outside the media root');
});

test('a backup folder inside the media root is refused', async () => {
  await expect(files.installCaption({
    targetPath: sandbox.sidecar('en'), bytes: Buffer.from(SRT), backupRoot: path.join(sandbox.mediaRoot, 'backups'), mediaRoot: sandbox.mediaRoot,
  })).rejects.toThrow('inside media root');
});

test('retiring keeps the bytes and removes the sidecar', async () => {
  fs.writeFileSync(sandbox.sidecar('en'), SRT);
  const { backupPath } = await files.retireCaption({ targetPath: sandbox.sidecar('en'), backupRoot: backupRoot(), mediaRoot: sandbox.mediaRoot });
  expect([fs.existsSync(sandbox.sidecar('en')), fs.readFileSync(backupPath, 'utf8')]).toEqual([false, SRT]);
});

test('the media revision changes when the media file is replaced', async () => {
  const before = await files.mediaRevision(sandbox.filePath);
  fs.writeFileSync(sandbox.filePath, 'a different, longer synthetic video');
  expect(await files.mediaRevision(sandbox.filePath)).not.toBe(before);
});
