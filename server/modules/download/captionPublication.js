const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { normalizeCaptionTrack } = require('./captionNormalizer');
const logger = require('../../logger');

function formatTime(ms) {
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor(ms / 60000) % 60;
  const seconds = Math.floor(ms / 1000) % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}

function serializeSrt(cues) {
  if (!cues.length) throw new Error('Cannot publish an empty caption track');
  return cues.map((cue, i) => `${i + 1}\n${formatTime(cue.start)} --> ${formatTime(cue.end)}\n${cue.text}\n`).join('\n');
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

// Fail closed if the filesystem cannot provide the required durability barriers.
async function syncPath(file) {
  const handle = await fs.open(file, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function durableDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  // Sync every ancestor: recursive mkdir may have created more than one entry.
  for (let current = path.resolve(directory);;) {
    await syncPath(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

async function durableWrite(file, bytes, mode = 0o600) {
  const handle = await fs.open(file, 'wx', mode);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
}

async function durableReplace(file, bytes) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await durableWrite(temp, bytes);
    await fs.rename(temp, file);
    await syncPath(path.dirname(file));
  } finally { await fs.unlink(temp).catch(() => {}); }
}

async function retainCaption(realBackup, bytes) {
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const retainedPath = path.join(realBackup, `${hash}.srt`);
  try {
    await durableWrite(retainedPath, bytes);
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    if (!(await fs.readFile(retainedPath)).equals(bytes)) throw new Error('Caption backup content mismatch');
  }
  if (!(await fs.readFile(retainedPath)).equals(bytes)) throw new Error('Caption backup content mismatch');
  await syncPath(retainedPath);
  await syncPath(realBackup);
  return retainedPath;
}

// Publishes in place: the caller moves the file to the library with the
// rest of the download, so a skipped or failed run leaves yt-dlp's track.
async function publishCaption({ subtitlePath, backupRoot, mediaRoot, provenance, timeline, timingMap, source, youtubeId }) {
  if (!['automatic', 'human'].includes(provenance)) return { status: 'skipped', reason: 'caption provenance is not known to be automatic' };
  if (timeline !== 'final' && !(timeline === 'source' && timingMap)) {
    return { status: 'skipped', reason: 'final media timeline is not verified' };
  }
  try {
    const originalStat = await fs.stat(subtitlePath);
    if (!originalStat.isFile()) throw new Error('Caption path is not a regular file');
    const originalBytes = await fs.readFile(subtitlePath);
    const original = new TextDecoder('utf-8', { fatal: true }).decode(originalBytes);
    const result = normalizeCaptionTrack({ rawTrack: source ?? original, format: 'srt', provenance, timingMap: timeline === 'source' ? timingMap : undefined });
    if (!result.diagnostics.transitionsRemoved && timeline === 'final') return { status: 'unchanged', diagnostics: result.diagnostics };
    const serialized = serializeSrt(result.cues);
    normalizeCaptionTrack({ rawTrack: serialized, format: 'srt', provenance: 'unknown' });
    const realMedia = await fs.realpath(mediaRoot);
    let ancestor = path.resolve(backupRoot);
    const suffix = [];
    while (ancestor) {
      try { ancestor = await fs.realpath(ancestor); break; } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw err;
        suffix.unshift(path.basename(ancestor));
        ancestor = parent;
      }
    }
    if (isWithin(realMedia, path.join(ancestor, ...suffix))) throw new Error('Caption backup directory is inside media root');
    await durableDirectory(backupRoot);
    const realBackup = await fs.realpath(backupRoot);
    if (isWithin(realMedia, realBackup)) throw new Error('Caption backup directory is inside media root');
    const backupPath = await retainCaption(realBackup, originalBytes);
    if (source != null) await retainCaption(realBackup, Buffer.from(source, 'utf8'));
    await replaceCaption({ subtitlePath, bytes: Buffer.from(serialized), expectedHash: crypto.createHash('sha256').update(originalBytes).digest('hex') });
    logger.info({ youtubeId, subtitlePath, backupPath }, '[Post-Process] Published normalized caption; original retained');
    return { status: 'published', backupPath, diagnostics: result.diagnostics };
  } catch (err) {
    return { status: 'warning', reason: 'caption normalization or publication failed', error: err };
  }
}

async function replaceCaption({ subtitlePath, bytes, expectedHash, beforeCommit }) {
  const current = await fs.readFile(subtitlePath);
  if (crypto.createHash('sha256').update(current).digest('hex') !== expectedHash) throw new Error('Caption changed since preview');
  const stat = await fs.stat(subtitlePath);
  const temporary = path.join(path.dirname(subtitlePath), `.caption-${crypto.randomUUID()}.tmp`);
  try {
    await durableWrite(temporary, bytes, stat.mode & 0o777);
    await fs.chmod(temporary, stat.mode & 0o777);
    if (!(await fs.readFile(temporary)).equals(bytes)) throw new Error('Caption verification failed');
    const latest = await fs.readFile(subtitlePath);
    if (!latest.equals(current)) throw new Error('Caption changed during publication');
    await syncPath(temporary);
    await beforeCommit?.();
    await fs.rename(temporary, subtitlePath);
    await syncPath(path.dirname(subtitlePath));
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

module.exports = { publishCaption, serializeSrt, retainCaption, replaceCaption, isWithin, durableDirectory, durableReplace, syncPath };
