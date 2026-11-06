const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { normalizeCaptionTrack } = require('./captionNormalizer');

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

async function publishCaption({ subtitlePath, backupRoot, mediaRoot, provenance, timeline, timingMap }) {
  if (provenance !== 'automatic') return { status: 'skipped', reason: 'caption provenance is not known to be automatic' };
  if (timeline !== 'final' && !(timeline === 'source' && timingMap)) {
    return { status: 'skipped', reason: 'final media timeline is not verified' };
  }
  let temporaryPath;
  try {
    const originalStat = await fs.stat(subtitlePath);
    if (!originalStat.isFile()) throw new Error('Caption path is not a regular file');
    const originalBytes = await fs.readFile(subtitlePath);
    const original = new TextDecoder('utf-8', { fatal: true }).decode(originalBytes);
    const result = normalizeCaptionTrack({ rawTrack: original, format: 'srt', provenance, timingMap: timeline === 'source' ? timingMap : undefined });
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
    await fs.mkdir(backupRoot, { recursive: true, mode: 0o700 });
    const realBackup = await fs.realpath(backupRoot);
    if (isWithin(realMedia, realBackup)) throw new Error('Caption backup directory is inside media root');
    const hash = crypto.createHash('sha256').update(originalBytes).digest('hex');
    const backupPath = path.join(realBackup, `${hash}.srt`);
    try {
      await fs.writeFile(backupPath, originalBytes, { flag: 'wx', mode: 0o600 });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (!(await fs.readFile(backupPath)).equals(originalBytes)) throw new Error('Caption backup content mismatch');
    }
    temporaryPath = path.join(path.dirname(subtitlePath), `.caption-${crypto.randomBytes(16).toString('hex')}.tmp`);
    await fs.writeFile(temporaryPath, serialized, { flag: 'wx', mode: originalStat.mode & 0o777 });
    await fs.chmod(temporaryPath, originalStat.mode & 0o777);
    await fs.rename(temporaryPath, subtitlePath);
    temporaryPath = null;
    return { status: 'published', backupPath, diagnostics: result.diagnostics };
  } catch (err) {
    return { status: 'warning', reason: 'caption normalization or publication failed', error: err };
  } finally {
    if (temporaryPath) await fs.unlink(temporaryPath).catch(() => {});
  }
}

module.exports = { publishCaption };
