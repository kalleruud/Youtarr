// Carries out a tvPlanner plan. Every file reaches its final name through a
// rename from a hidden staging file in the same folder, so a scanner never sees
// a half-written NFO, subtitle or media file. Order matters: show/season
// documents and sidecars first, then the episode NFO, and the media rename
// last. The media file is what makes an episode exist for a media server, so
// until it lands nothing is exposed as a completed item, and once it lands its
// metadata, captions and thumbnail are already there.
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const logger = require('../../logger');
const { isFileForVideo, moveWithRetries, VIDEO_EXTENSIONS } = require('../filesystem');
const { showNameFromFolder } = require('./tvNaming');
const { THUMBNAIL_SUFFIX, SUBTITLE_EXTENSIONS } = require('./tvPlanner');

const STAGING_PREFIX = '.youtarr-partial-';
// Staging names are random and ours, so a retry may replace a partial copy.
const MOVE_RETRY = { retries: 5, delayMs: 500, overwrite: true };
const DATE_ADDED_PATTERN = /<dateadded>([^<]{1,40})<\/dateadded>/;

function stagingPath(dir, ext = '') {
  return path.join(dir, `${STAGING_PREFIX}${crypto.randomBytes(6).toString('hex')}${ext}`);
}

function isStagingFile(name) {
  return name.startsWith(STAGING_PREFIX);
}

async function readdirSafe(dir) {
  try {
    return await fs.readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return [];
    throw err;
  }
}

async function writeFileAtomic(target, content) {
  const staged = stagingPath(path.dirname(target));
  try {
    const handle = await fs.promises.open(staged, 'w');
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(staged, target);
  } catch (err) {
    await fs.remove(staged).catch(() => {});
    throw err;
  }
}

// Rewrite a document only when its content changed, so republishing does not
// touch files a media server is watching.
async function writeDocumentIfChanged(target, content) {
  try {
    if ((await fs.readFile(target, 'utf8')) === content) return false;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  await writeFileAtomic(target, content);
  return true;
}

async function copyFileAtomic(source, target) {
  const staged = stagingPath(path.dirname(target), path.extname(target));
  try {
    await fs.copy(source, staged, { overwrite: true });
    await fs.rename(staged, target);
  } catch (err) {
    await fs.remove(staged).catch(() => {});
    throw err;
  }
}

/** Existing show folder for channelId under parentDir ("Name [<channelId>]"), or null. */
async function findShowFolderName(parentDir, channelId) {
  const entries = (await readdirSafe(parentDir))
    .filter((name) => showNameFromFolder(name, channelId))
    .sort();
  for (const name of entries) {
    if ((await fs.stat(path.join(parentDir, name)).catch(() => null))?.isDirectory()) return name;
  }
  return null;
}

/**
 * The already-published episode for youtubeId in seasonDir: its stem and the
 * dateadded its NFO recorded (so a republish keeps the media server's "date
 * added"). Null when nothing is published there yet.
 */
async function findExistingEpisode(seasonDir, youtubeId) {
  const media = (await readdirSafe(seasonDir))
    .filter((name) => !isStagingFile(name) && isFileForVideo(name, youtubeId))
    .filter((name) => VIDEO_EXTENSIONS.includes(path.extname(name).toLowerCase()))
    .sort();
  if (media.length === 0) return null;
  const stem = path.parse(media[0]).name;
  let dateAdded = null;
  try {
    const match = (await fs.readFile(path.join(seasonDir, `${stem}.nfo`), 'utf8')).match(DATE_ADDED_PATTERN);
    dateAdded = match ? match[1] : null;
  } catch (err) {
    if (err.code !== 'ENOENT') logger.warn({ err, seasonDir }, 'Could not read the existing episode NFO');
  }
  return { stem, mediaName: media[0], dateAdded };
}

/**
 * Subtitles ("<stem>.<lang>.<ext>") and thumbnail sidecars of a media file.
 * @param {string} mediaPath
 * @param {{thumbnailNames?: string[]}} [options] - file names (relative to the
 *   stem) to try for the thumbnail, first match wins
 */
async function collectAssets(mediaPath, { thumbnailNames = ['.jpg'] } = {}) {
  const dir = path.dirname(mediaPath);
  const stem = path.parse(mediaPath).name;
  const names = await readdirSafe(dir);
  const subtitles = [];
  for (const name of names.sort()) {
    if (!name.startsWith(`${stem}.`)) continue;
    const ext = path.extname(name).toLowerCase();
    if (!SUBTITLE_EXTENSIONS.has(ext)) continue;
    const language = name.slice(stem.length + 1, name.length - ext.length);
    if (language) subtitles.push({ path: path.join(dir, name), language });
  }
  const thumbnailName = thumbnailNames.map((suffix) => `${stem}${suffix}`).find((name) => names.includes(name));
  return {
    media: mediaPath,
    subtitles,
    thumbnail: thumbnailName ? path.join(dir, thumbnailName) : null,
  };
}

async function removeStaleEpisodeFiles(plan) {
  const removed = [];
  for (const name of await readdirSafe(plan.seasonDir)) {
    if (isStagingFile(name) || !isFileForVideo(name, plan.youtubeId) || name.startsWith(`${plan.stem}.`) ||
        name === `${plan.stem}${THUMBNAIL_SUFFIX}`) continue;
    const stalePath = path.join(plan.seasonDir, name);
    try {
      await fs.remove(stalePath);
      removed.push(stalePath);
    } catch (err) {
      logger.warn({ err, stalePath }, 'Could not remove a stale file of a republished episode');
    }
  }
  return removed;
}

/**
 * Publish a plan. Sources that already are their target (a metadata-only
 * republish) are left in place. On failure, staging files are removed and a
 * staged media file is moved back to its source, then the error is rethrown.
 * @returns {Promise<{mediaPath: string, written: string[], removed: string[]}>}
 */
async function publish(plan) {
  await fs.ensureDir(plan.seasonDir);
  const written = [];
  const mediaInPlace = path.resolve(plan.media.source) === path.resolve(plan.media.target);
  let stagedMedia = null;

  try {
    if (!mediaInPlace) {
      stagedMedia = stagingPath(plan.seasonDir, path.extname(plan.media.target));
      await moveWithRetries(plan.media.source, stagedMedia, MOVE_RETRY);
    }
    for (const doc of plan.documents) {
      if (await writeDocumentIfChanged(doc.target, doc.content)) written.push(doc.target);
    }
    for (const sidecar of plan.sidecars) {
      if (path.resolve(sidecar.source) === path.resolve(sidecar.target)) continue;
      await copyFileAtomic(sidecar.source, sidecar.target);
      written.push(sidecar.target);
    }
    if (await writeDocumentIfChanged(plan.episodeNfo.target, plan.episodeNfo.content)) {
      written.push(plan.episodeNfo.target);
    }
    if (stagedMedia) {
      await fs.rename(stagedMedia, plan.media.target);
      stagedMedia = null;
      written.push(plan.media.target);
    }
  } catch (err) {
    if (stagedMedia) {
      try {
        await moveWithRetries(stagedMedia, plan.media.source, MOVE_RETRY);
      } catch (restoreErr) {
        logger.error({ err: restoreErr, stagedMedia, source: plan.media.source }, 'Could not restore media after a failed TV publication');
      }
    }
    throw err;
  }

  for (const sidecar of plan.sidecars) {
    if (path.resolve(sidecar.source) === path.resolve(sidecar.target)) continue;
    await fs.remove(sidecar.source).catch((err) => {
      logger.warn({ err, source: sidecar.source }, 'Could not remove a published sidecar source');
    });
  }
  const removed = await removeStaleEpisodeFiles(plan);
  return { mediaPath: plan.media.target, written, removed };
}

module.exports = {
  STAGING_PREFIX,
  publish,
  findShowFolderName,
  findExistingEpisode,
  collectAssets,
  writeFileAtomic,
};
