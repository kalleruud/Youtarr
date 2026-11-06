const fs = require('fs-extra');
const path = require('path');
const { EPISODE_THUMB_SUFFIX } = require('./constants');
const { copySyncWithFallback } = require('../filesystem');

/** The episode thumbnail name for a media file stem (`<stem>-thumb.jpg`). */
function episodeThumbName(mediaStem) {
  return `${mediaStem}${EPISODE_THUMB_SUFFIX}`;
}

/**
 * Plan an episode's landscape thumbnail. The thumbnail yt-dlp wrote beside
 * the media (`<stem>.jpg`, the original 16:9 YouTube image) is copied byte
 * for byte to `<stem>-thumb.jpg`, the name Jellyfin reads as an episode's
 * thumb; it is never cropped or resized. Pure.
 * @param {Object} video - { filePath }
 * @returns {{ sourcePath: string, targetPath: string } | null}
 */
function prepareEpisodeArtwork(video) {
  if (!video || !video.filePath) return null;
  const dir = path.dirname(video.filePath);
  const stem = path.parse(video.filePath).name;
  return {
    sourcePath: path.join(dir, `${stem}.jpg`),
    targetPath: path.join(dir, episodeThumbName(stem)),
  };
}

/**
 * Write a planned episode thumbnail. Never overwrites an existing one and
 * never throws.
 * @returns {'written'|'exists'|'no-source'|'failed'}
 */
function publishEpisodeArtwork(plan, { logger } = {}) {
  if (!plan) return 'no-source';
  try {
    if (fs.existsSync(plan.targetPath)) return 'exists';
    if (!fs.existsSync(plan.sourcePath)) return 'no-source';
    copySyncWithFallback(plan.sourcePath, plan.targetPath, { overwrite: false });
    return 'written';
  } catch (err) {
    if (logger) logger.warn({ err, targetPath: plan.targetPath }, 'Could not write episode thumbnail');
    return 'failed';
  }
}

module.exports = { episodeThumbName, prepareEpisodeArtwork, publishEpisodeArtwork };
