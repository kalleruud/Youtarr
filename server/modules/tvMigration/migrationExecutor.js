// Moves one planned video into the TV layout, or back. Every step is
// idempotent, so an interrupted run resumes by repeating the video it stopped
// in. Order on apply: show/season/episode NFOs, subtitles and thumbnail, the
// leftover files into the plan's leftovers folder, then the media file, then
// the Videos row. The media file is what makes an episode exist for a media
// server, so it lands last. Rollback runs the same steps in reverse.
const fs = require('fs-extra');
const path = require('path');
const { Video } = require('../../models');
const { writeFileAtomic } = require('../tvPublication/tvPublisher');
const { VIDEO_EXTENSIONS } = require('../filesystem');
const { moveFile, removeDirIfEmpty, sha256, statOrNull, fingerprint, sameContentFingerprint, MoveError } = require('./fileMover');

class MigrationStepError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MigrationStepError';
    this.code = code;
  }
}

/**
 * Has anything the plan relies on changed since planning? Only for videos
 * that have not started; a started video is resumed from its checkpoints.
 * @returns {Promise<string|null>} why the plan is stale, or null
 */
async function staleReason(item) {
  const row = await Video.findOne({ where: { youtubeId: item.youtubeId }, attributes: ['filePath', 'removed'] });
  if (!row || row.removed || row.filePath !== item.media.source) return 'its database row changed';
  if (!sameContentFingerprint(await fingerprint(item.media.source).catch(() => null), item.media.fingerprint)) {
    return 'its video file changed';
  }
  for (const file of [...item.files, ...item.leftovers]) {
    if (!sameContentFingerprint(await fingerprint(file.source).catch(() => null), file.fingerprint)) {
      return `${path.basename(file.source)} changed`;
    }
  }
  return null;
}

function leftoverTarget(leftoversDir, leftover) {
  return path.join(leftoversDir, leftover.name);
}

/**
 * Apply one item. `checkpoint(patch)` persists progress before the call
 * returns, so a crash never loses a finished step.
 */
async function applyItem(item, { itemState, leftoversDir, createdDocuments, verifyChecksums, checkpoint }) {
  const state = itemState;
  if (verifyChecksums && !state.sha256Before && await statOrNull(item.media.source)) {
    state.sha256Before = await sha256(item.media.source);
    await checkpoint();
  }

  for (const doc of item.documents) {
    const exists = Boolean(await statOrNull(doc.target));
    if (doc.role === 'episode') {
      if (!exists || state.episodeNfoWritten) {
        // Recorded before writing, so a crash in between still lets a
        // rollback remove it.
        state.episodeNfoWritten = true;
        await checkpoint();
        await fs.ensureDir(path.dirname(doc.target));
        await writeFileAtomic(doc.target, doc.content);
      }
      continue;
    }
    // Show and season NFOs are shared; an existing one (from a download or an
    // earlier video in this plan) is left as it is.
    if (exists) continue;
    createdDocuments.add(doc.target);
    await checkpoint();
    await fs.ensureDir(path.dirname(doc.target));
    await writeFileAtomic(doc.target, doc.content);
  }

  for (const file of item.files) {
    await moveFile(file.source, file.target, { expectedSize: file.fingerprint?.size });
  }
  for (const leftover of item.leftovers) {
    await moveFile(leftover.source, leftoverTarget(leftoversDir, leftover), { expectedSize: leftover.fingerprint.size });
  }
  state.step = 'sidecars-moved';
  await checkpoint();

  const moved = await moveFile(item.media.source, item.media.target, { expectedSize: item.media.fingerprint.size });
  if (moved.method) state.mediaMethod = moved.method;
  if (verifyChecksums && state.sha256Before) {
    state.sha256After = await sha256(item.media.target);
    if (state.sha256After !== state.sha256Before) {
      throw new MigrationStepError('checksum-mismatch', `The moved video file of ${item.youtubeId} does not match the original`);
    }
  }
  state.step = 'media-moved';
  await checkpoint();

  const [affected] = await Video.update(
    { filePath: item.media.target },
    { where: { youtubeId: item.youtubeId, filePath: item.media.source } }
  );
  if (affected === 0) {
    const row = await Video.findOne({ where: { youtubeId: item.youtubeId }, attributes: ['filePath'] });
    if (!row || row.filePath !== item.media.target) {
      throw new MigrationStepError('row-changed', `The database row of ${item.youtubeId} changed during the migration`);
    }
  }
  state.step = 'row-updated';
  await checkpoint();

  if (item.perVideoFolder) await removeDirIfEmpty(item.oldDir);
}

/** Put one item back where planning found it. */
async function rollbackItem(item, { leftoversDir, checkpoint, itemState }) {
  // Deleted in Youtarr after the migration: there is no file to put back.
  const current = await Video.findOne({ where: { youtubeId: item.youtubeId }, attributes: ['filePath', 'removed'] });
  if (current && current.removed && !(await statOrNull(item.media.target)) && !(await statOrNull(item.media.source))) {
    itemState.note = 'The video was deleted after the migration; nothing to move back.';
    await checkpoint();
    return;
  }
  const [affected] = await Video.update(
    { filePath: item.media.source },
    { where: { youtubeId: item.youtubeId, filePath: item.media.target } }
  );
  if (affected === 0) {
    const row = await Video.findOne({ where: { youtubeId: item.youtubeId }, attributes: ['filePath'] });
    if (row && row.filePath && row.filePath !== item.media.source && row.filePath !== item.media.target) {
      throw new MigrationStepError('row-changed', `The database row of ${item.youtubeId} no longer points at either location`);
    }
  }
  itemState.step = 'row-restored';
  await checkpoint();

  await fs.ensureDir(item.oldDir);
  await moveFileBack(item.media.target, item.media.source, item.media.fingerprint.size);
  for (const leftover of item.leftovers) {
    await moveFileBack(leftoverTarget(leftoversDir, leftover), leftover.source, leftover.fingerprint.size);
  }
  for (const file of item.files) {
    await moveFileBack(file.target, file.source, file.fingerprint?.size);
  }
  const episodeNfo = item.documents.find((doc) => doc.role === 'episode');
  if (episodeNfo && itemState.episodeNfoWritten) await fs.remove(episodeNfo.target);
  itemState.step = 'files-restored';
  await checkpoint();
}

// A file that never moved (the run stopped before it) is already back.
async function moveFileBack(from, to, expectedSize) {
  try {
    await moveFile(from, to, { expectedSize });
  } catch (err) {
    if (!(err instanceof MoveError) || err.code !== 'source-missing') throw err;
    throw new MigrationStepError('file-lost', `Neither ${from} nor ${to} exists`);
  }
}

async function hasMedia(dir) {
  const names = await fs.readdir(dir).catch(() => []);
  return names.some((name) => VIDEO_EXTENSIONS.includes(path.extname(name).toLowerCase()));
}

/**
 * After a rollback: remove the show and season NFOs the migration created when
 * no episode is left beside them, then their folders if they are empty.
 */
async function removeCreatedDocuments(createdDocuments) {
  const removed = [];
  const dirs = new Set();
  for (const target of createdDocuments) {
    const dir = path.dirname(target);
    const isShowNfo = path.basename(target) === 'tvshow.nfo';
    const occupied = isShowNfo
      ? (await Promise.all((await fs.readdir(dir).catch(() => [])).map((name) => hasMedia(path.join(dir, name))))).some(Boolean)
      : await hasMedia(dir);
    if (occupied) continue;
    await fs.remove(target);
    removed.push(target);
    dirs.add(dir);
  }
  // Season folders first, then show folders.
  for (const dir of [...dirs].sort((a, b) => b.length - a.length)) await removeDirIfEmpty(dir);
  return removed;
}

module.exports = { applyItem, rollbackItem, staleReason, removeCreatedDocuments, MigrationStepError };
