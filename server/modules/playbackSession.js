const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnYtDlp } = require('./ytdlpProcess');
const builder = require('./download/ytdlpCommandBuilder');
const { Video, ChannelVideo } = require('../models');
const logger = require('../logger');

const MAX_SESSIONS = 2;
const MAX_BYTES = 1024 * 1024 * 1024;
const PREPARE_MS = 10 * 60 * 1000;
const IDLE_MS = 10 * 60 * 1000;
const MAX_AGE_MS = 4 * 60 * 60 * 1000;
const CHECK_MS = 1000;
const KILL_GRACE_MS = 1000;
const fail = (status, message) => Object.assign(new Error(message), { status });

class PlaybackSession {
  constructor() {
    this.sessions = new Map();
    this.root = null;
    process.once('exit', () => this.stopProcesses());
  }

  hasReadyPlayback(videoId) {
    return [...this.sessions.values()].some(s => s.videoId === videoId && s.file && !s.closing);
  }

  async openPlayback(videoId, { signal } = {}) {
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw fail(400, 'Invalid video identity');
    if (signal?.aborted) throw fail(499, 'Playback cancelled');
    let session = [...this.sessions.values()].find(s => s.videoId === videoId && !s.closing);
    if (!session) {
      if (this.sessions.size >= 64) throw fail(503, 'Playback metadata capacity reached; retry later');
      session = { id: crypto.randomUUID(), videoId, controller: new AbortController(), created: Date.now(), touched: Date.now(), leases: 0, waiters: 0 };
      this.sessions.set(session.id, session);
      session.ready = this.initialize(session);
    }
    if (session.waiters >= 32) throw fail(503, 'Playback waiter capacity reached; retry later');
    clearTimeout(session.abandon);
    session.waiters++;
    let abort;
    try {
      await Promise.race([session.ready, new Promise((resolve, reject) => {
        abort = () => reject(fail(499, 'Playback cancelled'));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      })]);
      session.touched = Date.now();
      return { sessionId: session.id, asset: 'media', source: session.dir ? 'cache' : 'local' };
    } finally {
      signal?.removeEventListener('abort', abort);
      session.waiters--;
      if (!session.waiters && !session.file && !session.closing) {
        session.abandon = setTimeout(() => this.closePlayback(session.id).catch(() => {}), 30000);
        session.abandon.unref();
      }
    }
  }

  async initialize(session) {
    const { videoId } = session;
    try {
      const video = await Video.findOne({ where: { youtubeId: videoId } });
      const known = video || await ChannelVideo.findOne({ where: { youtube_id: videoId } });
      if (!known) throw fail(404, 'Unknown video');
      if (session.closing || !this.sessions.has(session.id)) throw fail(499, 'Playback cancelled');
      if (video && !video.removed && video.filePath) {
        const stat = await fs.stat(video.filePath).catch(() => null);
        if (stat?.isFile() && stat.size > 0) session.file = video.filePath;
      }
      if (!session.file) {
        if ([...this.sessions.values()].filter(s => s.upstream).length >= MAX_SESSIONS) throw fail(503, 'Playback capacity reached; retry later');
        session.upstream = true;
        this.root ||= fs.mkdtemp(path.join(os.tmpdir(), 'youtarr-playback-')).catch(error => { this.root = null; throw error; });
        session.storage = (async () => {
          this.rootPath = await this.root;
          session.dir = path.join(this.rootPath, session.id);
          await fs.ensureDir(session.dir, { mode: 0o700 });
        })();
        await session.storage;
        if (session.closing || !this.sessions.has(session.id)) throw fail(499, 'Playback cancelled');
        await this.prepare(session);
        session.file = path.join(session.dir, 'media.mp4');
        const stat = await fs.stat(session.file).catch(error => { if (error.code === 'ENOENT') throw fail(422, 'Playback unsupported or filtered'); throw error; });
        if (!stat.isFile() || !stat.size || stat.size > MAX_BYTES) throw fail(422, 'Playback unsupported or exceeds cache budget');
      }
      if (session.controller.signal.aborted) throw fail(499, 'Playback cancelled');
      clearTimeout(session.abandon);
      session.timer = setInterval(() => {
        if (Date.now() - session.created > MAX_AGE_MS || (!session.leases && Date.now() - session.touched > IDLE_MS)) {
          this.closePlayback(session.id).catch(() => logger.warn({ sessionId: session.id }, 'Playback cleanup failed'));
        }
      }, CHECK_MS);
      session.timer.unref();
      logger.info({ sessionId: session.id, videoId }, 'Playback ready');
      return { sessionId: session.id, asset: 'media', source: session.dir ? 'cache' : 'local' };
    } catch (error) {
      await this.closePlayback(session.id);
      logger.warn({ sessionId: session.id, videoId, status: error.status || 503, reason: error.status === 422 ? 'unsupported-or-budget' : error.status === 404 ? 'unknown-video' : 'transient-preparation' }, 'Playback preparation failed');
      throw fail(error.status || 503, error.status ? error.message : 'Playback unavailable; retry later');
    }
  }

  prepare(session) {
    const args = builder.buildPlaybackArgs(session.videoId, session.dir, MAX_BYTES);
    return new Promise((resolve, reject) => {
      const child = spawnYtDlp(args, { shell: false, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
      session.child = child;
      let failure;
      let diagnostic = '';
      child.stderr?.on('data', chunk => { diagnostic = (diagnostic + String(chunk).slice(0, 8192)).slice(-8192); });
      const stop = message => {
        if (failure) return;
        failure = fail(message.includes('limit') ? 422 : 503, message);
        this.kill(session);
      };
      const timeout = setTimeout(() => stop('Playback preparation timed out; retry later'), PREPARE_MS);
      const monitor = setInterval(() => {
        try {
          const bytes = fs.readdirSync(session.dir).reduce((total, name) => total + (() => { try { return fs.statSync(path.join(session.dir, name)).size; } catch (error) { if (error.code === 'ENOENT') return 0; throw error; } })(), 0);
          if (bytes > MAX_BYTES) stop('Playback cache limit exceeded');
        } catch { stop('Playback cache unavailable'); }
      }, CHECK_MS);
      const cleanup = () => { clearTimeout(timeout); clearInterval(monitor); clearTimeout(session.killTimer); };
      child.once('error', () => { cleanup(); reject(fail(503, 'Playback tools unavailable')); });
      child.once('close', code => {
        cleanup();
        session.child = null;
        const permanent = /private video|video unavailable|has been removed|requested format.*not available|larger than max|does not pass filter/i.test(diagnostic);
        logger.info({ sessionId: session.id, exitCode: code, reason: failure ? 'resource-limit' : permanent ? 'unsupported-source' : code === 0 ? 'completed' : 'transient-upstream' }, 'Playback process finished');
        if (!failure && permanent && code !== 0) failure = fail(422, 'Playback source unavailable or unsupported');
        if (failure || code !== 0 || !this.sessions.has(session.id)) reject(failure || fail(503, 'Playback preparation failed; retry later'));
        else resolve();
      });
    });
  }

  stopProcesses() {
    for (const session of this.sessions.values()) {
      if (session.child?.pid) {
        try { process.kill(-session.child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
      }
      if (session.dir) {
        try { fs.removeSync(session.dir); } catch { /* Host temporary cleanup remains the fallback. */ }
      }
    }
    // Root contains only this process's disposable playback directories.
    if (this.rootPath) { try { fs.removeSync(this.rootPath); } catch { /* Best effort on exit. */ } }
  }

  kill(session) {
    const child = session.child;
    if (!child) return;
    const send = signal => {
      try { process.kill(-child.pid, signal); } catch { /* Already exited. */ }
    };
    send('SIGTERM');
    session.killTimer = setTimeout(() => { if (session.child === child) send('SIGKILL'); }, KILL_GRACE_MS);
    session.killTimer.unref();
  }

  getSessionAsset(sessionId, asset) {
    const session = this.sessions.get(sessionId);
    if (!session?.file || session.closing || asset !== 'media') throw fail(404, 'Playback asset unavailable');
    if (session.leases >= 8) throw fail(503, 'Playback reader capacity reached; retry later');
    session.touched = Date.now();
    session.leases++;
    let released = false;
    return { filePath: path.resolve(session.file), signal: session.controller.signal, release: () => {
      if (released) return;
      released = true;
      session.leases--;
      session.touched = Date.now();
    } };
  }

  async closePlayback(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.closing) return session.closing;
    session.closing = this.dispose(session);
    return session.closing;
  }

  async dispose(session) {
    session.controller.abort();
    clearInterval(session.timer);
    clearTimeout(session.abandon);
    this.kill(session);
    // Wait for the process group to stop before removing its disposable files.
    if (session.child) await new Promise(resolve => setTimeout(resolve, KILL_GRACE_MS + CHECK_MS));
    await session.storage?.catch(() => {});
    if (session.dir) await fs.remove(session.dir);
    this.sessions.delete(session.id);
    if (!this.sessions.size && this.root) {
      const root = this.root;
      this.root = null;
      await fs.remove(await root).catch(() => {});
    }
    logger.info({ sessionId: session.id, videoId: session.videoId }, 'Playback closed');
  }
}

module.exports = new PlaybackSession();
