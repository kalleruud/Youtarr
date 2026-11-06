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

  async openPlayback(videoId, { signal } = {}) {
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw fail(400, 'Invalid video identity');
    if (signal?.aborted) throw fail(499, 'Playback cancelled');
    const existing = [...this.sessions.values()].find(s => s.videoId === videoId && s.file && !s.closing);
    if (existing) {
      existing.touched = Date.now();
      return { sessionId: existing.id, asset: 'media', source: existing.dir ? 'cache' : 'local' };
    }
    if (this.sessions.size >= MAX_SESSIONS) throw fail(503, 'Playback capacity reached; retry later');
    const session = { id: crypto.randomUUID(), videoId, controller: new AbortController(), created: Date.now(), touched: Date.now(), leases: 0 };
    this.sessions.set(session.id, session);
    const abort = () => this.closePlayback(session.id).catch(() => logger.warn({ sessionId: session.id }, 'Playback cleanup failed'));
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const video = await Video.findOne({ where: { youtubeId: videoId } });
      const known = video || await ChannelVideo.findOne({ where: { youtube_id: videoId } });
      if (!known) throw fail(404, 'Unknown video');
      if (!this.sessions.has(session.id)) throw fail(499, 'Playback cancelled');
      if (video && !video.removed && video.filePath) {
        const stat = await fs.stat(video.filePath).catch(() => null);
        if (stat?.isFile() && stat.size > 0) session.file = video.filePath;
      }
      if (!session.file) {
        this.root ||= fs.mkdtemp(path.join(os.tmpdir(), 'youtarr-playback-'));
        session.dir = path.join(await this.root, session.id);
        await fs.ensureDir(session.dir, { mode: 0o700 });
        if (!this.sessions.has(session.id)) throw fail(499, 'Playback cancelled');
        await this.prepare(session);
        session.file = path.join(session.dir, 'media.mp4');
        const stat = await fs.stat(session.file);
        if (!stat.isFile() || !stat.size || stat.size > MAX_BYTES) throw fail(503, 'Playback cache limit exceeded');
      }
      if (signal?.aborted) throw fail(499, 'Playback cancelled');
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
      logger.warn({ sessionId: session.id, videoId, status: error.status || 503 }, 'Playback preparation failed');
      throw fail(error.status || 503, error.status ? error.message : 'Playback unavailable; retry later');
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  prepare(session) {
    const args = builder.buildPlaybackArgs(session.videoId, session.dir, MAX_BYTES);
    return new Promise((resolve, reject) => {
      const child = spawnYtDlp(args, { shell: false, detached: true, stdio: ['ignore', 'ignore', 'ignore'] });
      session.child = child;
      let failure;
      const stop = message => {
        if (failure) return;
        failure = fail(503, message);
        this.kill(session);
      };
      const timeout = setTimeout(() => stop('Playback preparation timed out; retry later'), PREPARE_MS);
      const monitor = setInterval(() => {
        try {
          const bytes = fs.readdirSync(session.dir).reduce((total, name) => total + fs.statSync(path.join(session.dir, name)).size, 0);
          if (bytes > MAX_BYTES) stop('Playback cache limit exceeded');
        } catch { stop('Playback cache unavailable'); }
      }, CHECK_MS);
      const cleanup = () => { clearTimeout(timeout); clearInterval(monitor); };
      child.once('error', () => { cleanup(); reject(fail(503, 'Playback tools unavailable')); });
      child.once('close', code => {
        cleanup();
        session.child = null;
        if (failure || code !== 0 || !this.sessions.has(session.id)) reject(failure || fail(503, 'Playback preparation failed; retry later'));
        else resolve();
      });
    });
  }

  stopProcesses() {
    for (const session of this.sessions.values()) {
      if (!session.child?.pid) continue;
      try { process.kill(-session.child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
    }
  }

  kill(session) {
    const child = session.child;
    if (!child) return;
    const send = signal => {
      try { process.kill(-child.pid, signal); } catch { /* Already exited. */ }
    };
    send('SIGTERM');
    const timer = setTimeout(() => send('SIGKILL'), KILL_GRACE_MS);
    timer.unref();
  }

  getSessionAsset(sessionId, asset) {
    const session = this.sessions.get(sessionId);
    if (!session?.file || session.closing || asset !== 'media') throw fail(404, 'Playback asset unavailable');
    if (session.leases >= MAX_SESSIONS) throw fail(503, 'Playback reader capacity reached; retry later');
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
    this.kill(session);
    // Wait for the process group to stop before removing its disposable files.
    if (session.child) await new Promise(resolve => setTimeout(resolve, KILL_GRACE_MS + CHECK_MS));
    if (session.dir) await fs.remove(session.dir);
    this.sessions.delete(session.id);
    logger.info({ sessionId: session.id, videoId: session.videoId }, 'Playback closed');
  }
}

module.exports = new PlaybackSession();
