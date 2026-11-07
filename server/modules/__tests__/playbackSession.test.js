jest.mock('../ytdlpProcess', () => ({ spawnYtDlp: jest.fn() }));
jest.mock('../configModule', () => ({ getConfig: () => ({ useTmpForDownloads: true, tmpFilePath: '/tmp' }), getCookiesPath: jest.fn(() => null), getYtdlpCacheDir: () => '/tmp/cache' }));
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
  const extra = Array.from({ length: 6 }, () => playback.getSessionAsset(session.sessionId, 'media'));
  expect(() => playback.getSessionAsset(session.sessionId, 'media')).toThrow('capacity');
  extra.forEach(lease => lease.release());
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
  await expect(playback.openPlayback(ID)).rejects.toMatchObject({ status: 422 });
  expect(await fs.pathExists(output)).toBe(false);
});
test('normal application exit cleanup removes only disposable media', async () => {
  const cached = await playback.openPlayback(ID);
  const lease = playback.getSessionAsset(cached.sessionId, 'media');
  lease.release();
  const local = path.join(fixture, 'local.mp4');
  await fs.writeFile(local, 'local');
  Video.findOne.mockResolvedValue({ filePath: local, removed: false });
  await playback.openPlayback('bcdefghijkl');
  playback.stopProcesses();
  expect(await fs.pathExists(lease.filePath)).toBe(false);
  expect(await fs.readFile(local, 'utf8')).toBe('local');
});

test('concurrent preparation and a disconnected waiter reuse one process', async () => {
  let finish;
  spawnYtDlp.mockImplementation(args => {
    const child = new EventEmitter();
    finish = async () => {
      await fs.writeFile(args[args.indexOf('-o') + 1].replace('%(ext)s', 'mp4'), 'media');
      child.emit('close', 0);
    };
    return child;
  });
  const controller = new AbortController();
  const first = playback.openPlayback(ID, { signal: controller.signal }).catch(e => e.status);
  const second = playback.openPlayback(ID);
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  expect(await first).toBe(499);
  const retry = playback.openPlayback(ID);
  await finish();
  expect(await retry).toEqual(await second);
  expect(spawnYtDlp).toHaveBeenCalledTimes(1);
});
test('local media does not consume upstream capacity', async () => {
  const filePath = path.join(fixture, 'local.mp4');
  await fs.writeFile(filePath, 'local');
  Video.findOne.mockResolvedValueOnce({ filePath }).mockResolvedValueOnce({ filePath });
  await playback.openPlayback(ID);
  await playback.openPlayback('bcdefghijkl');
  expect((await playback.openPlayback('cdefghijklm')).source).toBe('cache');
});
test('filtered successful process is nonretryable', async () => {
  spawnYtDlp.mockImplementation(() => {
    const child = new EventEmitter();
    process.nextTick(() => child.emit('close', 0));
    return child;
  });
  await expect(playback.openPlayback(ID)).rejects.toMatchObject({ status: 422 });
});
test('private sources return a safe permanent error without raw diagnostics', async () => {
  spawnYtDlp.mockImplementation(() => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    process.nextTick(() => { child.stderr.emit('data', 'Private video secret-url'); child.emit('close', 1); });
    return child;
  });
  await expect(playback.openPlayback(ID)).rejects.toMatchObject({ status: 422, message: 'Playback source unavailable or unsupported' });
});
test('vanished staging entries during mux do not kill healthy preparation', async () => {
  const realStat = fs.statSync.bind(fs);
  const realRead = fs.readdirSync.bind(fs);
  let finish;
  spawnYtDlp.mockImplementation(args => {
    const child = new EventEmitter();
    finish = async () => {
      await fs.writeFile(args[args.indexOf('-o') + 1].replace('%(ext)s', 'mp4'), 'media');
      child.emit('close', 0);
    };
    return child;
  });
  const read = jest.spyOn(fs, 'readdirSync').mockImplementation(dir => [...realRead(dir), 'vanished.part']);
  const stat = jest.spyOn(fs, 'statSync').mockImplementation(file => {
    if (String(file).endsWith('vanished.part')) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
    return realStat(file);
  });
  try {
    const opened = playback.openPlayback(ID);
    while (!finish) await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setTimeout(resolve, 1100));
    await finish();
    expect((await opened).source).toBe('cache');
  } finally { read.mockRestore(); stat.mockRestore(); }
});
test('failed cache root allocation can be retried', async () => {
  const mkdir = jest.spyOn(fs, 'mkdtemp').mockRejectedValueOnce(new Error('storage failure'));
  try {
    await expect(playback.openPlayback(ID)).rejects.toMatchObject({ status: 503 });
    expect((await playback.openPlayback(ID)).source).toBe('cache');
  } finally { mkdir.mockRestore(); }
});
test('playback arguments exclude configured cuts and arbitrary custom arguments', () => {
  const args = builder.buildPlaybackArgs(ID, fixture, 1024);
  expect(args.join(' ')).not.toMatch(/sponsorblock|force-keyframes|recode-video/);
  expect(args[args.indexOf('-f') + 1]).toContain('filesize_approx<=256');
});
test('abandoned preparation is bounded by a grace period', async () => {
  const child = new EventEmitter();
  child.pid = 123456;
  spawnYtDlp.mockReturnValue(child);
  const kill = jest.spyOn(process, 'kill').mockImplementation(() => { process.nextTick(() => child.emit('close', null)); return true; });
  const timer = jest.spyOn(global, 'setTimeout').mockImplementation((callback, delay, ...args) => require('timers').setTimeout(callback, delay === 30000 ? 20 : delay, ...args));
  try {
    const controller = new AbortController();
    const opened = playback.openPlayback(ID, { signal: controller.signal }).catch(e => e.status);
    while (!spawnYtDlp.mock.calls.length) await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    expect(await opened).toBe(499);
    await new Promise(resolve => require('timers').setTimeout(resolve, 100));
    expect(kill).toHaveBeenCalledWith(-child.pid, 'SIGTERM');
  } finally { timer.mockRestore(); kill.mockRestore(); }
});

test('cookie playback uses the managed SABR player clients', () => {
  const cookies = require('../configModule').getCookiesPath;
  cookies.mockReturnValue('/private/cookies');
  try { expect(builder.buildPlaybackArgs(ID, fixture, 1024)).toContain('youtube:player_client=default,mweb,web_safari'); }
  finally { cookies.mockReturnValue(null); }
});
