// Idempotent, verified single-file moves for the TV library migration.
// Same filesystem: one rename, which never rewrites the bytes. Across
// filesystems: copy to a hidden staging file beside the target, compare
// SHA-256 of source and copy, rename into place, and only then remove the
// source. A move that already happened (source gone, target present) is a
// no-op, so a resumed or repeated step is safe. An existing target is never
// overwritten.
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { STAGING_PREFIX } = require('../tvPublication/tvPublisher');

class MoveError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'MoveError';
    this.code = code;
    this.details = details;
  }
}

async function statOrNull(filePath) {
  try {
    return await fs.stat(filePath);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
}

/** { size, mtimeMs, ino, dev } of a regular file, or null when it does not exist. */
async function fingerprint(filePath) {
  const stat = await statOrNull(filePath);
  if (!stat) return null;
  if (!stat.isFile()) throw new MoveError('not-a-file', `Not a regular file: ${filePath}`);
  return { size: stat.size, mtimeMs: Math.round(stat.mtimeMs), ino: stat.ino, dev: stat.dev };
}

function sameContentFingerprint(a, b) {
  return Boolean(a && b && a.size === b.size && a.mtimeMs === b.mtimeMs);
}

async function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest('hex');
}

async function copyVerified(source, target) {
  const staged = path.join(path.dirname(target), `${STAGING_PREFIX}${crypto.randomBytes(6).toString('hex')}${path.extname(target)}`);
  try {
    await fs.copyFile(source, staged, fs.constants.COPYFILE_EXCL);
    const [sourceHash, copyHash] = await Promise.all([sha256(source), sha256(staged)]);
    if (sourceHash !== copyHash) {
      throw new MoveError('checksum-mismatch', `The copy of ${source} does not match the original`);
    }
    if (await statOrNull(target)) {
      throw new MoveError('target-exists', `A file already exists at ${target}`);
    }
    await fs.rename(staged, target);
    await fs.unlink(source);
    return sourceHash;
  } catch (err) {
    await fs.remove(staged).catch(() => {});
    throw err;
  }
}

/**
 * Move source to target.
 * @param {string} source
 * @param {string} target
 * @param {{expectedSize?: number}} [options] - when set, an already-moved
 *   target of another size is reported instead of accepted
 * @returns {Promise<{action: 'moved'|'already-moved', method?: 'rename'|'copy', sha256?: string}>}
 */
async function moveFile(source, target, { expectedSize } = {}) {
  if (path.resolve(source) === path.resolve(target)) return { action: 'already-moved' };
  const [src, dst] = await Promise.all([statOrNull(source), statOrNull(target)]);
  if (!src && dst) {
    if (Number.isFinite(expectedSize) && dst.size !== expectedSize) {
      throw new MoveError('size-mismatch', `${target} is not the expected size`, { expectedSize, actualSize: dst.size });
    }
    return { action: 'already-moved' };
  }
  if (!src) throw new MoveError('source-missing', `Neither ${source} nor ${target} exists`);
  if (dst) throw new MoveError('target-exists', `A file already exists at ${target}`);
  if (!src.isFile()) throw new MoveError('not-a-file', `Not a regular file: ${source}`);

  await fs.ensureDir(path.dirname(target));
  try {
    await fs.rename(source, target);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    return { action: 'moved', method: 'copy', sha256: await copyVerified(source, target) };
  }
  const moved = await statOrNull(target);
  if (!moved || moved.size !== src.size) {
    throw new MoveError('size-mismatch', `${target} changed size during the move`, { expectedSize: src.size });
  }
  return { action: 'moved', method: 'rename' };
}

/** Remove dir only when it is empty; never recursive. Resolves true when removed. */
async function removeDirIfEmpty(dir) {
  try {
    await fs.rmdir(dir);
    return true;
  } catch (err) {
    if (['ENOTEMPTY', 'EEXIST', 'ENOENT', 'ENOTDIR'].includes(err.code)) return false;
    throw err;
  }
}

module.exports = { MoveError, fingerprint, sameContentFingerprint, sha256, moveFile, removeDirIfEmpty, statOrNull };
