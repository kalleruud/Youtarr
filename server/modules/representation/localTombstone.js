// Identity-checked removal of a local media file (issue #14 eviction).
//
// Checking a file and then removing its path are two steps, and a download
// that publishes without the episode lease can rename a new file onto the
// path in between. So the path is first renamed (atomic, same folder) to a
// tombstone; the tombstone then holds exactly one file, whichever was at the
// path at the rename, and its identity is checked there. Only a tombstone
// that is the previewed file is deleted. Anything else is put back with
// link() + unlink(), which fails instead of overwriting whatever landed at
// the path since; then both files are kept and the conflict is logged.
//
// Crash safety: a process that dies between the rename and the delete or
// put-back leaves a tombstone. Tombstones are never junk: recoverTombstones
// (run before every eviction and by the periodic reconcile pass) puts each
// one back at its original name when that name is free, drops it when the
// original name holds the very same file (a put-back interrupted after the
// link), and otherwise keeps it and logs. The tombstone name is hidden, has
// no media extension and does not end in "[<id>].<ext>", so library scans,
// the TV publisher's stale-file cleanup and Jellyfin all ignore it.
const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');
const logger = require('../../logger');
const { isFileForVideo } = require('../filesystem');

const TOMBSTONE_PATTERN = /^\.(.+) \[youtarr-evicting-[0-9a-f]{16}\]$/;

function tombstoneName(basename) {
  return `.${basename} [youtarr-evicting-${crypto.randomBytes(8).toString('hex')}]`;
}

/** The name a tombstone was moved from, or null when it is not one. */
function originalName(name) {
  const match = TOMBSTONE_PATTERN.exec(name);
  return match ? match[1] : null;
}

/** What identifies a file: a replacement under the same path differs. */
async function fileIdentity(location) {
  try {
    const stat = await fs.lstat(location);
    if (!stat.isFile()) return null;
    return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
  } catch (err) {
    return null;
  }
}

function sameIdentity(a, b) {
  return !!a && !!b && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

function sameFile(a, b) {
  return !!a && !!b && a.dev === b.dev && a.ino === b.ino;
}

// Put a tombstone back at `location` without overwriting anything there.
// @returns {'restored'|'duplicate'|'kept'}
async function putBack(tombstone, location) {
  try {
    await fs.link(tombstone, location);
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    if (sameFile(await fileIdentity(tombstone), await fileIdentity(location))) {
      await fs.unlink(tombstone);
      return 'duplicate';
    }
    return 'kept';
  }
  await fs.unlink(tombstone);
  return 'restored';
}

/**
 * Remove the file at `location` only if it is still `expected` (a
 * fileIdentity result).
 * @returns {Promise<{removed: boolean, reason?: string, keptAt?: string}>}
 *   reason 'missing' (nothing at the path), 'changed' (another file was there
 *   and is back in place), 'conflict' (another file was there and the path
 *   was taken again meanwhile: both are kept, the tombstone at keptAt)
 */
async function removeIfUnchanged(location, expected) {
  const tombstone = path.join(path.dirname(location), tombstoneName(path.basename(location)));
  try {
    await fs.rename(location, tombstone);
  } catch (err) {
    if (err.code === 'ENOENT') return { removed: false, reason: 'missing' };
    throw err;
  }
  if (sameIdentity(expected, await fileIdentity(tombstone))) {
    await fs.unlink(tombstone);
    return { removed: true };
  }
  const outcome = await putBack(tombstone, location);
  if (outcome === 'kept') {
    logger.error({ location, keptAt: tombstone },
      'A different file replaced the media being evicted, and the path was taken again; kept both files');
    return { removed: false, reason: 'conflict', keptAt: tombstone };
  }
  return { removed: false, reason: 'changed' };
}

/**
 * Put back tombstones of youtubeId in dir left by an interrupted eviction.
 * Never deletes a file that is not also at its original name.
 * @returns {Promise<{restored: string[], kept: string[]}>}
 */
async function recoverTombstones(dir, youtubeId) {
  const result = { restored: [], kept: [] };
  let names;
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    return result;
  }
  for (const name of names) {
    const original = originalName(name);
    if (!original || !isFileForVideo(original, youtubeId)) continue;
    const tombstone = path.join(dir, name);
    const location = path.join(dir, original);
    try {
      const outcome = await putBack(tombstone, location);
      if (outcome === 'kept') {
        result.kept.push(tombstone);
        logger.warn({ tombstone, location }, 'Kept a file left by an interrupted eviction: another file has its name');
      } else {
        result.restored.push(location);
        logger.info({ location }, 'Put back a file left by an interrupted eviction');
      }
    } catch (err) {
      result.kept.push(tombstone);
      logger.warn({ err, tombstone }, 'Could not put back a file left by an interrupted eviction');
    }
  }
  return result;
}

module.exports = { fileIdentity, removeIfUnchanged, recoverTombstones, originalName };
