// Plans one episode's TV publication: every target path and every metadata
// document, with no filesystem effects. tvPublisher carries the plan out.
const path = require('path');
const nfoGenerator = require('../nfoGenerator');
const {
  isYoutubeIdentity,
  buildShowFolderName,
  showNameFromFolder,
  buildSeasonFolderName,
  buildEpisodeStem,
} = require('./tvNaming');

const PUBLISHABLE_STATUSES = new Set(['assigned', 'date-correction-review']);
// "en", "en-GB", "zh-Hans", "en-orig", "pt-PT" ... as yt-dlp names tracks.
const SUBTITLE_LANGUAGE_PATTERN = /^[A-Za-z0-9]{1,8}(?:-[A-Za-z0-9]{1,8}){0,3}$/;
const SUBTITLE_EXTENSIONS = new Set(['.srt', '.vtt', '.ass', '.ssa']);
const THUMBNAIL_SUFFIX = '-thumb.jpg';

class TvPublicationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TvPublicationError';
    this.code = code;
  }
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function formatDateAdded(date) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

function airedDate(publishedAt) {
  if (typeof publishedAt !== 'string') return null;
  const day = publishedAt.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

function requireAssignment(assignment) {
  if (!assignment || !PUBLISHABLE_STATUSES.has(assignment.status) ||
      !Number.isInteger(assignment.season) || !Number.isInteger(assignment.episode) ||
      assignment.season < 1 || assignment.episode < 1) {
    throw new TvPublicationError(
      'date-required',
      'The video has no episode assignment yet (its publication date is unknown)'
    );
  }
}

/**
 * @param {object} input
 * @param {object} input.video - { youtubeId, channelId, title, showTitle, showPlot, description,
 *   durationSeconds, genres, tags, rating }
 * @param {object} input.assignment - episodeAssignment.ensureEpisodeAssignment result
 * @param {object} input.assets - { media, subtitles: [{ path, language }], thumbnail }
 * @param {object} input.layout - { parentDir, showFolderName?, existingStem?, dateAdded? }:
 *   parentDir is the downloads folder or its __subfolder; the rest describes what is
 *   already published, so republishing keeps the same folder and file names
 * @param {Date} [input.now]
 * @returns {object} plan
 */
function planPublication({ video, assignment, assets, layout, now = new Date() }) {
  if (!video || !isYoutubeIdentity(video.youtubeId) || !isYoutubeIdentity(video.channelId)) {
    throw new TvPublicationError('invalid-identity', 'A valid YouTube video ID and channel ID are required');
  }
  requireAssignment(assignment);
  if (!assets || typeof assets.media !== 'string' || !assets.media) {
    throw new TvPublicationError('missing-media', 'A media file is required');
  }
  if (!layout || typeof layout.parentDir !== 'string' || !path.isAbsolute(layout.parentDir)) {
    throw new TvPublicationError('invalid-layout', 'An absolute library folder is required');
  }

  const { youtubeId, channelId } = video;
  const existingShowName = showNameFromFolder(layout.showFolderName, channelId);
  const showFolderName = existingShowName ? layout.showFolderName : buildShowFolderName(video.showTitle, channelId);
  const showName = existingShowName || showNameFromFolder(showFolderName, channelId);
  const showDir = path.join(layout.parentDir, showFolderName);
  const seasonDir = path.join(showDir, buildSeasonFolderName(assignment.season));

  const stem = layout.existingStem && layout.existingStem.endsWith(` [${youtubeId}]`)
    ? layout.existingStem
    : buildEpisodeStem({ showName, season: assignment.season, episode: assignment.episode, title: video.title, youtubeId });

  const mediaExt = path.extname(assets.media).toLowerCase() || '.mp4';
  const mediaPath = path.join(seasonDir, `${stem}${mediaExt}`);

  const sidecars = [];
  const seenSubtitles = new Set();
  for (const subtitle of assets.subtitles || []) {
    const ext = path.extname(subtitle.path || '').toLowerCase();
    if (!SUBTITLE_LANGUAGE_PATTERN.test(subtitle.language || '') || !SUBTITLE_EXTENSIONS.has(ext)) continue;
    const target = path.join(seasonDir, `${stem}.${subtitle.language}${ext}`);
    if (seenSubtitles.has(target)) continue;
    seenSubtitles.add(target);
    sidecars.push({ role: 'subtitle', language: subtitle.language, source: subtitle.path, target });
  }
  if (assets.thumbnail) {
    sidecars.push({ role: 'thumbnail', source: assets.thumbnail, target: path.join(seasonDir, `${stem}${THUMBNAIL_SUFFIX}`) });
  }

  const showTitle = video.showTitle || showName;
  const documents = [
    {
      role: 'show',
      target: path.join(showDir, 'tvshow.nfo'),
      content: nfoGenerator.buildTvShowNfo({ title: showTitle, plot: video.showPlot, channelId }),
    },
    {
      role: 'season',
      target: path.join(seasonDir, 'season.nfo'),
      content: nfoGenerator.buildSeasonNfo({ season: assignment.season }),
    },
  ];
  const episodeNfo = {
    role: 'episode',
    target: path.join(seasonDir, `${stem}.nfo`),
    content: nfoGenerator.buildEpisodeNfo({
      title: video.title,
      showTitle,
      season: assignment.season,
      episode: assignment.episode,
      aired: airedDate(assignment.publishedAt),
      plot: video.description,
      youtubeId,
      durationSeconds: video.durationSeconds,
      genres: video.genres || [],
      tags: video.tags || [],
      rating: video.rating || null,
      dateAdded: layout.dateAdded || formatDateAdded(now),
    }),
  };

  return {
    youtubeId,
    channelId,
    season: assignment.season,
    episode: assignment.episode,
    showDir,
    seasonDir,
    stem,
    media: { role: 'media', source: assets.media, target: mediaPath },
    sidecars,
    documents,
    episodeNfo,
  };
}

module.exports = { planPublication, TvPublicationError, THUMBNAIL_SUFFIX, SUBTITLE_EXTENSIONS };
