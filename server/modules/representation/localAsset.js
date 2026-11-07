// Filesystem checks for local representations. A local copy is usable when it
// is a non-empty regular media file whose name carries the video's
// "[<youtube id>]" token; nothing here contacts YouTube.
const fs = require('fs-extra');
const path = require('path');
const { isFileForVideo, VIDEO_EXTENSIONS } = require('../filesystem');
const { STREAM_ENTRY_EXTENSION } = require('./representationValues');

function belongsTo(location, youtubeId) {
  return typeof location === 'string' && path.isAbsolute(location) && isFileForVideo(path.basename(location), youtubeId);
}

/**
 * @returns {Promise<{usable: boolean, sizeBytes?: number, reason?: string}>}
 */
async function inspectLocalMedia(location, youtubeId) {
  if (!belongsTo(location, youtubeId)) return { usable: false, reason: 'not-this-video' };
  if (!VIDEO_EXTENSIONS.includes(path.extname(location).toLowerCase())) return { usable: false, reason: 'not-media' };
  try {
    const stat = await fs.stat(location);
    if (!stat.isFile()) return { usable: false, reason: 'not-a-file' };
    if (stat.size <= 0) return { usable: false, reason: 'empty' };
    return { usable: true, sizeBytes: stat.size };
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return { usable: false, reason: 'missing' };
    return { usable: false, reason: 'unreadable' };
  }
}

function isStreamEntryFor(location, youtubeId) {
  return belongsTo(location, youtubeId) && path.extname(location).toLowerCase() === STREAM_ENTRY_EXTENSION;
}

/** STRM entries of youtubeId in dir (none when the folder is unreadable). */
async function findStreamEntries(dir, youtubeId) {
  let names;
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    return [];
  }
  return names.map(name => path.join(dir, name)).filter(location => isStreamEntryFor(location, youtubeId));
}

/**
 * Sidecars kept when only the media is evicted: everything in the media's
 * folder that belongs to the video, except the media itself.
 */
async function listEpisodeSidecars(mediaLocation, youtubeId) {
  const dir = path.dirname(mediaLocation);
  let names;
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    return [];
  }
  return names
    .filter(name => !name.startsWith('.') && isFileForVideo(name, youtubeId) && name !== path.basename(mediaLocation))
    .filter(name => !VIDEO_EXTENSIONS.includes(path.extname(name).toLowerCase()))
    .sort()
    .map(name => path.join(dir, name));
}

module.exports = { inspectLocalMedia, isStreamEntryFor, findStreamEntries, listEpisodeSidecars };
