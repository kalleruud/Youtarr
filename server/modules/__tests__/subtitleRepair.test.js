jest.mock('../../logger', () => ({ info: jest.fn() }));
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { SubtitleRepair } = require('../subtitleRepair');
const original = '1\n00:00:00,000 --> 00:00:01,000\nHello\n\n2\n00:00:01,000 --> 00:00:01,010\nHello\n\n3\n00:00:01,010 --> 00:00:02,000\nHello\nworld\n';
let root, media, file, service;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'repair-test-'));
  media = path.join(root, 'media');
  await fs.mkdir(media);
  file = path.join(media, 'episode.en.srt');
  await fs.writeFile(file, original);
  await fs.writeFile(path.join(media, 'episode.mp4'), 'media bytes');
  service = new SubtitleRepair().configure({ mediaRoot: () => media, stateRoot: () => path.join(root, 'state'), resolveVideo: async () => ({ filePath: path.join(media, 'episode.mp4'), removed: false }) });
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
async function run() {
  const preview = await service.previewRepair([1], { automaticFinal: true });
  preview.status = 'running';
  await service.run(preview);
  return service.get(preview.id);
}
test('preview shows examples and leaves original bytes untouched', async () => {
  const preview = await service.previewRepair([1], { automaticFinal: true });
  expect(preview.items[0].changed).toBe(1);
  expect(await fs.readFile(file, 'utf8')).toBe(original);
});
test('repair is idempotent and restore reproduces original bytes without touching media', async () => {
  const record = await run();
  expect(record.items[0].status).toBe('repaired');
  const again = await run();
  expect(again.items[0].status).toBe('unchanged');
  await service.restoreRepair(record.id);
  expect(await fs.readFile(file, 'utf8')).toBe(original);
  expect(await fs.readFile(path.join(media, 'episode.mp4'), 'utf8')).toBe('media bytes');
});
test('stale previews never overwrite changed captions', async () => {
  const preview = await service.previewRepair([1], { automaticFinal: true });
  await fs.writeFile(file, original + '\n');
  await service.run(preview);
  expect(preview.items[0].reason).toMatch('Stale preview');
  expect(await fs.readFile(file, 'utf8')).toBe(original + '\n');
});
test('restore refuses newer track content', async () => {
  const record = await run();
  await fs.writeFile(file, 'new track');
  await service.restoreRepair(record.id);
  expect(await fs.readFile(file, 'utf8')).toBe('new track');
});
test('unknown provenance is skipped', async () => {
  const preview = await service.previewRepair([1], { automaticFinal: false });
  expect(preview.items[0].status).toBe('skipped');
});
test('partial batch continues after malformed captions', async () => {
  await fs.writeFile(path.join(media, 'episode.fr.srt'), 'malformed');
  const record = await run();
  expect(record.items.map(item => item.status).sort()).toEqual(['failed', 'repaired']);
});
test('restart preserves completed results and marks unfinished tracks intact', async () => {
  const record = await service.previewRepair([1], { automaticFinal: true });
  record.status = 'running';
  await service.save(record);
  await service.recover();
  expect((await service.get(record.id)).status).toBe('interrupted');
  expect(await fs.readFile(file, 'utf8')).toBe(original);
});
test('cancel leaves unfinished tracks intact', async () => {
  const record = await service.previewRepair([1], { automaticFinal: true });
  service.cancelled = record.id;
  await service.run(record);
  expect(record.items[0].status).toBe('skipped');
});
test('symlink captions cannot escape media root', async () => {
  await fs.unlink(file);
  await fs.writeFile(path.join(root, 'outside.srt'), original);
  await fs.symlink(path.join(root, 'outside.srt'), file);
  expect((await service.previewRepair([1], { automaticFinal: true })).items[0].status).toBe('failed');
});
test('state directories inside media root are rejected', async () => {
  service.stateRoot = () => path.join(media, 'backups');
  await expect(service.directory()).rejects.toThrow('outside media');
});
test('repairs TV episode captions resolved from the stored media path', async () => {
  const season = path.join(media, 'Channel', 'Season 2026');
  await fs.mkdir(season, { recursive: true });
  const episode = path.join(season, 'S2026E001 - Title [abc].mp4');
  file = path.join(season, 'S2026E001 - Title [abc].en.srt');
  await fs.writeFile(episode, 'tv media');
  await fs.writeFile(file, original);
  service.resolveVideo = async () => ({ filePath: episode, youtubeId: 'abc', removed: false });
  const record = await run();
  expect(record.items[0].status).toBe('repaired');
  await service.restoreRepair(record.id);
  expect(await fs.readFile(file, 'utf8')).toBe(original);
});
test('refresh failure does not invalidate a published caption', async () => {
  service.refresh = async () => { throw new Error('offline'); };
  const record = await run();
  expect(record.items[0].status).toBe('repaired');
  expect(record.items[0].refresh.status).toBe('pending');
});
test('rejects concurrent starts', async () => {
  const record = await service.previewRepair([1], { automaticFinal: true });
  service.active = 'another-job';
  await expect(service.startRepair(record.id)).rejects.toMatchObject({ status: 409 });
});
test('reconciles a rename completed before journal completion', async () => {
  const record = await run();
  record.status = 'running';
  record.items[0].status = 'publishing';
  await service.save(record);
  await service.recover();
  expect((await service.get(record.id)).items[0].status).toBe('repaired');
  await service.restoreRepair(record.id);
  expect(await fs.readFile(file, 'utf8')).toBe(original);
});
test('publication failure retains the original and durable failure result', async () => {
  const originalRename = fs.rename.bind(fs);
  const fail = jest.spyOn(fs, 'rename').mockImplementation((source, target) => target === file ? Promise.reject(new Error('disk failure')) : originalRename(source, target));
  try {
    const record = await run();
    expect(record.items[0].status).toBe('failed');
    expect(await fs.readFile(file, 'utf8')).toBe(original);
  } finally { fail.mockRestore(); }
});
