/**
 * Caption sidecar files next to a media file: listing, hashing, media
 * revision, and atomic install/retire with the replaced bytes retained under
 * the caption backup folder (outside the media root), through #3's
 * `retainCaption`. Never opens the media file for writing.
 */
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { retainCaption, isWithin } = require('../download/captionPublication');
const { TRACK_CODE } = require('./captionSources');

const SIDECAR_EXTENSION = '.srt';

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/**
 * Identity of the media bytes as stored: size and modification time. A
 * re-download or replacement changes it; caption writes never do.
 * @param {string} mediaPath
 * @returns {Promise<string|null>}
 */
async function mediaRevision(mediaPath) {
  try {
    const stat = await fs.stat(mediaPath);
    if (!stat.isFile()) return null;
    return `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
}

function sidecarPath(mediaPath, code) {
  const parsed = path.parse(mediaPath);
  return path.join(parsed.dir, `${parsed.name}.${code}${SIDECAR_EXTENSION}`);
}

/**
 * The SRT sidecars of a media file ("<stem>.<code>.srt"), both layouts.
 * @param {string} mediaPath
 * @returns {Promise<{code: string, path: string}[]>}
 */
async function listSidecars(mediaPath) {
  const parsed = path.parse(mediaPath);
  let names;
  try {
    names = await fs.readdir(parsed.dir);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return [];
    throw err;
  }
  const prefix = `${parsed.name}.`;
  return names
    .filter((name) => name.startsWith(prefix) && name.toLowerCase().endsWith(SIDECAR_EXTENSION))
    .map((name) => ({ code: name.slice(prefix.length, name.length - SIDECAR_EXTENSION.length), path: path.join(parsed.dir, name) }))
    .filter((sidecar) => TRACK_CODE.test(sidecar.code))
    .sort((a, b) => a.code.localeCompare(b.code));
}

async function prepareBackupRoot(backupRoot, mediaRoot) {
  await fs.mkdir(backupRoot, { recursive: true, mode: 0o700 });
  const realBackup = await fs.realpath(backupRoot);
  if (isWithin(await fs.realpath(mediaRoot), realBackup)) throw new Error('Caption backup directory is inside media root');
  return realBackup;
}

async function assertInsideMediaRoot(targetPath, mediaRoot) {
  const realMedia = await fs.realpath(mediaRoot);
  const realDir = await fs.realpath(path.dirname(targetPath));
  if (!isWithin(realMedia, realDir)) throw new Error('Caption target is outside the media root');
}

async function readIfPresent(filePath) {
  try {
    return await fs.readFile(filePath);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Write `bytes` to `targetPath` through a temporary file in the same folder
 * and a rename, keeping the replaced track's bytes in the backup folder.
 * @returns {Promise<{backupPath: string|null, resultSha256: string}>}
 */
async function installCaption({ targetPath, bytes, backupRoot, mediaRoot, beforeMutation = async () => null }) {
  await assertInsideMediaRoot(targetPath, mediaRoot);
  const realBackup = await prepareBackupRoot(backupRoot, mediaRoot);
  const previous = await readIfPresent(targetPath);
  const backupPath = previous ? await retainCaption(realBackup, previous) : null;
  const temporaryPath = path.join(path.dirname(targetPath), `.caption-${crypto.randomBytes(16).toString('hex')}.tmp`);
  try {
    await fs.writeFile(temporaryPath, bytes, { flag: 'wx', mode: 0o644 });
    const blocked = await beforeMutation();
    if (blocked) {
      await fs.unlink(temporaryPath);
      return { blocked };
    }
    await fs.rename(temporaryPath, targetPath);
  } catch (err) {
    await fs.unlink(temporaryPath).catch(() => {});
    throw err;
  }
  return { backupPath, resultSha256: sha256(bytes) };
}

/** Remove a superseded sidecar after keeping its bytes in the backup folder. */
async function retireCaption({ targetPath, backupRoot, mediaRoot, beforeMutation = async () => null }) {
  await assertInsideMediaRoot(targetPath, mediaRoot);
  const realBackup = await prepareBackupRoot(backupRoot, mediaRoot);
  const previous = await readIfPresent(targetPath);
  if (!previous) return { backupPath: null };
  const backupPath = await retainCaption(realBackup, previous);
  const blocked = await beforeMutation();
  if (blocked) return { blocked };
  await fs.unlink(targetPath);
  return { backupPath };
}

module.exports = { sha256, mediaRevision, sidecarPath, listSidecars, installCaption, retireCaption };
