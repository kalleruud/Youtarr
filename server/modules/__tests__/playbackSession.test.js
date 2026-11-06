jest.mock('../ytdlpProcess', () => ({ spawnYtDlp: jest.fn() }));
jest.mock('../configModule', () => ({ getConfig: () => ({ useTmpForDownloads: true, tmpFilePath: '/tmp' }), getCookiesPath: () => null, getYtdlpCacheDir: () => '/tmp/cache' }));
jest.mock('../../models', () => ({ Video: { findOne: jest.fn() }, ChannelVideo: { findOne: jest.fn() } }));
jest.mock('../../logger', () => ({ info: jest.fn(), warn: jest.fn() }));
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { Video, ChannelVideo } = require('../../models');
const { spawnYtDlp } = require('../ytdlpProcess');
const playback = require('../playbackSession');
const builder = require('../download/ytdlpCommandBuilder');
const ID = 'abcdefghijk';
let fixture;
beforeEach(async () => {
  jest.clearAllMocks();
  fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'playback-test-'));
  Video.findOne.mockResolvedValue(null);
  ChannelVideo.findOne.mockResolvedValue({});
  spawnYtDlp.mockImplementation(args => {
    const child = new EventEmitter();
    process.nextTick(async () => {
      const output = args[args.indexOf('-o') + 1].replace('%(ext)s', 'mp4');
      await fs.writeFile(output, 'fixture-media');
      child.emit('close', 0);
    });
    return child;
  });
});
afterEach(async () => {
  await Promise.all([...playback.sessions.keys()].map(id => playback.closePlayback(id)));
  await fs.remove(fixture);
});
test('rejects arbitrary URLs before any lookup or process', async () => {
  await expect(playback.openPlayback('https://evil.test')).rejects.toMatchObject({ status: 400 });
  expect(Video.findOne).not.toHaveBeenCalled();
});
test('unknown identity does not contact upstream', async () => {
  ChannelVideo.findOne.mockResolvedValue(null);
  await expect(playback.openPlayback(ID)).rejects.toMatchObject({ status: 404 });
  expect(spawnYtDlp).not.toHaveBeenCalled();
});
test('prefers verified local media without contacting upstream', async () => {
  const filePath = path.join(fixture, 'local.mp4');
  await fs.writeFile(filePath, 'local');
  Video.findOne.mockResolvedValue({ filePath, removed: false });
  const session = await playback.openPlayback(ID);
  expect(session.source).toBe('local');
  expect(spawnYtDlp).not.toHaveBeenCalled();
});
test('fresh sessions resolve independently and closed cache is removed', async () => {
  const first = await playback.openPlayback(ID);
  const lease = playback.getSessionAsset(first.sessionId, 'media');
  lease.release();
  await playback.closePlayback(first.sessionId);
  expect(await fs.pathExists(lease.filePath)).toBe(false);
  await playback.openPlayback(ID);
  expect(spawnYtDlp).toHaveBeenCalledTimes(2);
});
test('two viewers bound capacity and reject a third', async () => {
  await playback.openPlayback(ID);
  await playback.openPlayback('bcdefghijkl');
  await expect(playback.openPlayback('cdefghijklm')).rejects.toMatchObject({ status: 503 });
});
test('rejects traversal assets', async () => {
  const session = await playback.openPlayback(ID);
  expect(() => playback.getSessionAsset(session.sessionId, '../secret')).toThrow('unavailable');
});
test('upstream failure releases capacity with a safe retryable error', async () => {
  spawnYtDlp.mockImplementation(() => {
    const child = new EventEmitter();
    process.nextTick(() => child.emit('close', 1));
    return child;
  });
  await expect(playback.openPlayback(ID)).rejects.toMatchObject({ status: 503 });
  expect(playback.sessions.size).toBe(0);
});
test('command uses remux rather than CPU-heavy re-encoding', () => {
  const args = builder.buildPlaybackArgs(ID, fixture, 1000);
  expect(args).toContain('--remux-video');
  expect(args).not.toContain('--recode-video');
  expect(args.slice(-2)).toEqual(['--', `https://www.youtube.com/watch?v=${ID}`]);
});
test('expired idle session removes its disposable cache', async () => {
  const session = await playback.openPlayback(ID);
  const now = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60 * 1000);
  await new Promise(resolve => setTimeout(resolve, 1200));
  now.mockRestore();
  expect(() => playback.getSessionAsset(session.sessionId, 'media')).toThrow('unavailable');
});
test('aborted requests never begin resolution', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(playback.openPlayback(ID, { signal: controller.signal })).rejects.toMatchObject({ status: 499 });
  expect(spawnYtDlp).not.toHaveBeenCalled();
});
test('multiple same-video range opens reuse ready media', async () => {
  const first = await playback.openPlayback(ID);
  expect(await playback.openPlayback(ID)).toEqual(first);
  expect(spawnYtDlp).toHaveBeenCalledTimes(1);
});
test('preparation deadline terminates the process group and frees capacity', async () => {
  const child = new EventEmitter();
  child.pid = 123456;
  spawnYtDlp.mockImplementation(() => child);
  const kill = jest.spyOn(process, 'kill').mockImplementation(() => {
    process.nextTick(() => child.emit('close', null));
    return true;
  });
  const timeout = jest.spyOn(global, 'setTimeout').mockImplementation((callback, delay, ...args) => {
    return require('timers').setTimeout(callback, delay === 600000 ? 20 : delay, ...args);
  });
  try {
    await expect(playback.openPlayback(ID)).rejects.toMatchObject({ status: 503, message: expect.stringContaining('timed out') });
    expect(kill).toHaveBeenCalledWith(-child.pid, 'SIGTERM');
    expect(playback.sessions.size).toBe(0);
  } finally {
    await new Promise(resolve => require('timers').setTimeout(resolve, 1100));
    timeout.mockRestore();
    kill.mockRestore();
  }
});
test('closure aborts active readers and release is idempotent', async () => {
  const session = await playback.openPlayback(ID);
  const lease = playback.getSessionAsset(session.sessionId, 'media');
  await playback.closePlayback(session.sessionId);
  expect(lease.signal.aborted).toBe(true);
  lease.release();
  lease.release();
});
test('simultaneous range readers have a bounded lease count', async () => {
  const session = await playback.openPlayback(ID);
  const first = playback.getSessionAsset(session.sessionId, 'media');
  const second = playback.getSessionAsset(session.sessionId, 'media');
  expect(() => playback.getSessionAsset(session.sessionId, 'media')).toThrow('capacity');
  first.release();
  const third = playback.getSessionAsset(session.sessionId, 'media');
  second.release();
  third.release();
});
test('rejects an oversized completed cache without retaining it', async () => {
  let output;
  spawnYtDlp.mockImplementation(args => {
    const child = new EventEmitter();
    process.nextTick(async () => {
      output = args[args.indexOf('-o') + 1].replace('%(ext)s', 'mp4');
      await fs.writeFile(output, '');
      await require('fs').promises.truncate(output, 1024 * 1024 * 1024 + 1);
      child.emit('close', 0);
    });
    return child;
  });
  await expect(playback.openPlayback(ID)).rejects.toMatchObject({ status: 503 });
  expect(await fs.pathExists(output)).toBe(false);
});
