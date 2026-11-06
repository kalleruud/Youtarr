const { acquireCaptionLease } = require('./download/captionLease');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { normalizeCaptionTrack } = require('./download/captionNormalizer');
const { serializeSrt, retainCaption, replaceCaption, isWithin } = require('./download/captionPublication');
const MAX_TRACK_BYTES = 5 * 1024 * 1024;
const MAX_BATCH = 100;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

class SubtitleRepair {
  configure(deps) { Object.assign(this, deps); return this; }

  async directory() {
    const media = await fs.realpath(this.mediaRoot());
    const root = path.resolve(this.stateRoot());
    // Validate before creating anything, including when the directory does not exist.
    let ancestor = root;
    for (;;) {
      try {
        if (isWithin(media, await fs.realpath(ancestor))) throw new Error('Repair state must be outside media root');
        break;
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        ancestor = path.dirname(ancestor);
      }
    }
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const real = await fs.realpath(root);
    if (isWithin(media, real)) throw new Error('Repair state must be outside media root');
    return real;
  }

  async save(record) {
    const root = await this.directory();
    const file = path.join(root, `${record.id}.json`);
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
      await fs.rename(temp, file);
    } finally { await fs.unlink(temp).catch(() => {}); }
    this.notify?.();
  }

  async get(id) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw Object.assign(new Error('Invalid repair id'), { status: 400 });
    try { return JSON.parse(await fs.readFile(path.join(await this.directory(), `${id}.json`), 'utf8')); }
    catch (err) { if (err.code === 'ENOENT') err.status = 404; throw err; }
  }

  async list() {
    const root = await this.directory();
    const files = (await fs.readdir(root)).filter(name => /^[0-9a-f-]{36}\.json$/.test(name));
    const records = await Promise.all(files.map(name => this.get(name.slice(0, -5))));
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async track(file) {
    const real = await fs.realpath(file);
    if (!isWithin(await fs.realpath(this.mediaRoot()), real) || (await fs.lstat(file)).isSymbolicLink()) throw new Error('Unsafe caption path');
    const stat = await fs.stat(real);
    if (!stat.isFile() || stat.size > MAX_TRACK_BYTES) throw new Error('Caption is not a bounded regular file');
    return fs.readFile(real);
  }

  async previewRepair(videoIds, options = {}) {
    if (!Array.isArray(videoIds) || !videoIds.length || videoIds.length > MAX_BATCH || videoIds.some(id => !Number.isSafeInteger(id) || id <= 0)) throw Object.assign(new Error('Choose 1–100 numeric video ids'), { status: 400 });
    if (typeof options.automaticFinal !== 'boolean') throw Object.assign(new Error('Confirm caption provenance and final timeline'), { status: 400 });
    const record = { id: crypto.randomUUID(), kind: 'subtitle-repair', provenance: options.automaticFinal ? 'owner-confirmed-automatic-final' : 'unknown', createdAt: new Date().toISOString(), status: 'preview', items: [], warnings: ['Only confirm automatic captions already synchronized to the final media. Unknown/human or unverified cut timelines must be skipped.'] };
    for (const videoId of [...new Set(videoIds)]) {
      try {
        const video = await this.resolveVideo(videoId);
        if (!video?.filePath || video.removed) throw new Error('No downloaded video');
        const media = await fs.realpath(video.filePath);
        if (!isWithin(await fs.realpath(this.mediaRoot()), media)) throw new Error('Media outside configured root');
        const base = path.basename(media, path.extname(media));
        const names = (await fs.readdir(path.dirname(media))).filter(name => name.startsWith(`${base}.`) && name.endsWith('.srt'));
        if (!names.length) record.items.push({ videoId, status: 'skipped', reason: 'No external SRT captions' });
        for (const name of names) {
          const file = path.join(path.dirname(media), name);
          try {
            const bytes = await this.track(file);
            const original = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            const result = normalizeCaptionTrack({ rawTrack: original, format: 'srt', provenance: options.automaticFinal ? 'automatic' : 'unknown' });
            const output = result.diagnostics.transitionsRemoved ? serializeSrt(result.cues) : original;
            record.items.push({ videoId, youtubeId: video.youtubeId || String(videoId), media, file, sourceHash: hash(bytes), resultHash: hash(Buffer.from(output)), output, normalizerVersion: result.normalizerVersion, changed: result.diagnostics.transitionsRemoved, examples: { before: original.slice(0, 1200), after: output.slice(0, 1200) }, status: options.automaticFinal ? 'pending' : 'skipped', reason: options.automaticFinal ? undefined : 'Provenance/timeline unconfirmed' });
          } catch (err) { record.items.push({ videoId, status: 'failed', reason: err.message }); }
        }
      } catch (err) { record.items.push({ videoId, status: 'skipped', reason: err.message }); }
    }
    await this.save(record);
    return record;
  }

  async startRepair(id) {
    const record = await this.get(id);
    if (record.status !== 'preview') throw Object.assign(new Error('Preview already started; create a new preview'), { status: 409 });
    if (this.active) throw Object.assign(new Error('A repair or restore is running'), { status: 409 });
    this.active = id;
    try { record.status = 'running'; await this.save(record); }
    catch (err) { this.active = null; throw err; }
    this.run(record).catch(err => this.onError?.(err)).finally(() => { this.active = null; });
    return record;
  }

  async run(record) {
    for (const item of record.items) {
      if (item.status !== 'pending') continue;
      if (this.cancelled === record.id) { item.status = 'skipped'; item.reason = 'Cancelled before publication'; await this.save(record); continue; }
      let release;
      try {
        release = await acquireCaptionLease(this.leaseRoot ? this.leaseRoot() : path.dirname(await this.directory()), item.youtubeId);
        const video = await this.resolveVideo(item.videoId);
        if (video?.filePath !== item.media || video.removed) throw new Error('Video record changed since preview');
        const bytes = await this.track(item.file);
        const version = normalizeCaptionTrack({ rawTrack: bytes.toString('utf8'), format: 'srt', provenance: 'automatic' }).normalizerVersion;
        if (hash(bytes) !== item.sourceHash || version !== item.normalizerVersion) throw new Error('Stale preview; preview again');
        if (!item.changed) { item.status = 'unchanged'; await this.save(record); continue; }
        item.backupPath = await retainCaption(await this.directory(), bytes);
        item.status = 'publishing';
        await this.save(record); // write-ahead: recovery distinguishes before/after rename by hash
        await replaceCaption({ subtitlePath: item.file, bytes: Buffer.from(item.output), expectedHash: item.sourceHash });
        item.status = 'repaired';
        await this.save(record);
        await release();
        release = null;
        item.refresh = await this.refreshItem(item.media);
      } catch (err) { item.status = 'failed'; item.reason = err.message; }
      finally { await release?.(); }
      await this.save(record);
    }
    record.status = this.cancelled === record.id ? 'cancelled' : 'completed';
    this.cancelled = null;
    await this.save(record);
  }

  async refreshItem(media) {
    try { return await this.refresh?.(media) || { status: 'not-configured' }; }
    catch { return { status: 'pending', reason: 'Media server refresh unavailable' }; }
  }

  async cancel(id) {
    const record = await this.get(id);
    if (this.active !== id) throw Object.assign(new Error('Repair is not running'), { status: 409 });
    this.cancelled = id;
    return record;
  }

  async recover() {
    for (const record of await this.list()) {
      if (record.status !== 'running') continue;
      for (const item of record.items) {
        if (item.status === 'publishing') {
          try { item.status = hash(await this.track(item.file)) === item.resultHash ? 'repaired' : 'failed'; }
          catch { item.status = 'failed'; }
          item.reason = 'Interrupted publication; original retained';
        } else if (item.status === 'pending') { item.status = 'skipped'; item.reason = 'Interrupted before publication; preview again'; }
      }
      record.status = 'interrupted';
      await this.save(record);
    }
  }

  async restoreRepair(id) {
    if (this.active) throw Object.assign(new Error('A repair or restore is running'), { status: 409 });
    this.active = id;
    try {
      const record = await this.get(id);
      for (const item of record.items.filter(item => item.backupPath && item.status !== 'restored')) {
        let release;
        try {
          release = await acquireCaptionLease(this.leaseRoot ? this.leaseRoot() : path.dirname(await this.directory()), item.youtubeId);
          const video = await this.resolveVideo(item.videoId);
          if (video?.filePath !== item.media || video.removed) throw new Error('Video record changed since repair');
          const bytes = await fs.readFile(path.join(await this.directory(), `${item.sourceHash}.srt`));
          if (hash(bytes) !== item.sourceHash) throw new Error('Original backup verification failed');
          const current = hash(await this.track(item.file));
          if (current !== item.sourceHash) await replaceCaption({ subtitlePath: item.file, bytes, expectedHash: item.resultHash });
          item.status = 'restored';
          delete item.reason;
          await this.save(record);
          await release();
          release = null;
          item.refresh = await this.refreshItem(item.media);
        } catch (err) { item.reason = err.message; }
        finally { await release?.(); }
      }
      await this.save(record);
      return record;
    } finally { this.active = null; }
  }
}
module.exports = new SubtitleRepair();
module.exports.SubtitleRepair = SubtitleRepair;
