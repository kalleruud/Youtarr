// Jellyfin TV publication (the `libraryOutputProfile: "jellyfinTv"` setting):
// a channel is a show, its publication years are seasons, and each video is
// the stable episode episodeAssignment numbered. planPublication has no
// filesystem effects; publish stages and atomically commits a plan.
const fs = require('fs-extra');
const path = require('path');
const logger = require('../../logger');
const configModule = require('../configModule');
const episodeAssignment = require('../episodeAssignment');
const { buildChannelPath } = require('../filesystem');
const { Video, Channel } = require('../../models');
const { PUBLISHED_AT_SOURCE } = require('../constants/publishedAtSource');
const { planPublication, TvPublicationError, THUMBNAIL_SUFFIX } = require('./tvPlanner');
const tvPublisher = require('./tvPublisher');
const { buildShowFolderName, buildSeasonFolderName, showNameFromFolder } = require('./tvNaming');

const TV_PROFILE = 'jellyfinTv';
const MOVIE_PROFILE = 'movie';

function uploadDateToIso(uploadDate) {
  const value = uploadDate == null ? '' : String(uploadDate);
  if (!/^\d{8}$/.test(value)) return null;
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00.000Z`;
  return Number.isFinite(Date.parse(iso)) && new Date(iso).toISOString() === iso ? iso : null;
}

function stringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()) : [];
}

class TvPublication {
  get TV_PROFILE() { return TV_PROFILE; }

  /** True when the configured library output profile is Jellyfin TV. */
  isEnabled(config = configModule.getConfig() || {}) {
    return config.libraryOutputProfile === TV_PROFILE;
  }

  /** The profile name the settings describe ('movie' unless set to Jellyfin TV). */
  profileOf(config = configModule.getConfig() || {}) {
    return this.isEnabled(config) ? TV_PROFILE : MOVIE_PROFILE;
  }

  planPublication(input) {
    return planPublication(input);
  }

  publish(plan) {
    return tvPublisher.publish(plan);
  }

  // Episode fields from a yt-dlp .info.json (the cached jobs/info copy or the
  // one written beside a fresh download).
  videoFromInfo(info, { channelId, showTitle, showPlot }) {
    return {
      youtubeId: info.id,
      channelId,
      title: info.title || info.fulltitle || 'Untitled',
      description: info.description || '',
      showTitle: showTitle || info.channel || info.uploader || channelId,
      showPlot: showPlot || '',
      durationSeconds: Number.isFinite(info.duration) ? info.duration : 0,
      genres: stringList(info.categories),
      tags: stringList(info.tags),
      rating: info.normalized_rating || null,
    };
  }

  // The downloads folder, or its __subfolder: the folder show folders live in.
  libraryParentDir(baseDir, subfolder) {
    return subfolder ? path.dirname(buildChannelPath(baseDir, subfolder, '_')) : baseDir;
  }

  async assign(channelId, info) {
    const publishedAt = uploadDateToIso(info.upload_date);
    return episodeAssignment.ensureEpisodeAssignment({
      channelId,
      youtubeId: info.id,
      publishedAt,
      source: publishedAt ? PUBLISHED_AT_SOURCE.EXACT : null,
    });
  }

  /**
   * Plan the publication of a freshly downloaded video (still in temp).
   * Returns { plan, input } or { skipped: code, message } when the video
   * cannot be published as an episode yet (for example, no known publication
   * date); the caller then keeps the regular layout. The plan fixes the final
   * media path; publishDownload re-reads the sidecars, because the caller
   * still converts and prunes subtitles after planning.
   */
  async prepareDownload({ info, channelId, channelRecord, mediaPath, baseDir, subfolder }) {
    try {
      const assignment = await this.assign(channelId, info);
      const parentDir = this.libraryParentDir(baseDir, subfolder);
      const showTitle = (channelRecord && (channelRecord.title || channelRecord.uploader)) || null;
      const video = this.videoFromInfo(info, {
        channelId,
        showTitle,
        showPlot: channelRecord && channelRecord.description,
      });
      const showFolderName = await tvPublisher.findShowFolderName(parentDir, channelId) ||
        buildShowFolderName(video.showTitle, channelId);
      const existing = Number.isInteger(assignment.season)
        ? await tvPublisher.findExistingEpisode(
          path.join(parentDir, showFolderName, buildSeasonFolderName(assignment.season)), info.id)
        : null;
      const input = {
        video,
        assignment,
        mediaPath,
        layout: { parentDir, showFolderName, existingStem: existing?.stem, dateAdded: existing?.dateAdded },
      };
      return { plan: await this.planDownload(input), input };
    } catch (err) {
      if (err instanceof TvPublicationError) return { skipped: err.code, message: err.message };
      throw err;
    }
  }

  async planDownload({ video, assignment, mediaPath, layout }) {
    const assets = await tvPublisher.collectAssets(mediaPath);
    return planPublication({ video, assignment, assets, layout });
  }

  /** Publish a prepareDownload result with the sidecars present right now. */
  async publishDownload(prepared) {
    const plan = await this.planDownload(prepared.input);
    const result = await tvPublisher.publish(plan);
    logger.info({ youtubeId: plan.youtubeId, season: plan.season, episode: plan.episode, mediaPath: result.mediaPath },
      'Published TV episode');
    return { ...result, plan };
  }

  // A published episode's location parts, or null if filePath is not in the
  // "<Show> [<channelId>]/Season <n>/<file>" layout.
  publishedLocation(filePath, channelId) {
    if (!filePath || !channelId) return null;
    const seasonDir = path.dirname(filePath);
    const showDir = path.dirname(seasonDir);
    const season = /^Season (\d{1,5})$/.exec(path.basename(seasonDir));
    if (!season || !showNameFromFolder(path.basename(showDir), channelId)) return null;
    return { seasonDir, showDir, parentDir: path.dirname(showDir), season: Number(season[1]) };
  }

  /**
   * Rewrite the show, season and episode metadata of an already published
   * episode from its cached .info.json and stored assignment. The media file,
   * subtitles and thumbnail stay where they are and nothing is downloaded.
   * Files still in the regular (movie) layout are refused: moving existing
   * downloads into the TV layout is the library migration's job.
   * @returns {Promise<{mediaPath: string, written: string[], removed: string[]}>}
   */
  async regenerateMetadata(youtubeId) {
    const video = await Video.findOne({ where: { youtubeId } });
    if (!video || video.removed || !video.filePath) {
      throw new TvPublicationError('not-found', 'No downloaded video file is recorded for this video');
    }
    const channelId = video.channel_id;
    const location = this.publishedLocation(video.filePath, channelId);
    if (!location) {
      throw new TvPublicationError('not-published', 'This video is not stored in the TV library layout');
    }
    if (!(await fs.pathExists(video.filePath))) {
      throw new TvPublicationError('missing-media', 'The video file is missing on disk');
    }
    let info;
    try {
      info = JSON.parse(await fs.readFile(path.join(configModule.getJobsPath(), 'info', `${youtubeId}.info.json`), 'utf8'));
    } catch (err) {
      throw new TvPublicationError('metadata-missing', 'The cached video metadata (.info.json) is missing or unreadable');
    }
    info.id = youtubeId;
    if (video.normalized_rating !== undefined) info.normalized_rating = video.normalized_rating;

    const assignment = await this.assign(channelId, info);
    if (assignment.season !== location.season) {
      throw new TvPublicationError('layout-mismatch', 'The file is in a different season folder than its episode assignment');
    }
    const channelRecord = await Channel.findOne({ where: { channel_id: channelId }, attributes: ['title', 'uploader', 'description'] });
    const existing = await tvPublisher.findExistingEpisode(location.seasonDir, youtubeId);
    const stem = path.parse(video.filePath).name;
    const assets = await tvPublisher.collectAssets(video.filePath, { thumbnailNames: [THUMBNAIL_SUFFIX] });
    const plan = planPublication({
      video: this.videoFromInfo(info, {
        channelId,
        showTitle: channelRecord && (channelRecord.title || channelRecord.uploader),
        showPlot: channelRecord && channelRecord.description,
      }),
      assignment,
      assets,
      layout: {
        parentDir: location.parentDir,
        showFolderName: path.basename(location.showDir),
        existingStem: stem,
        dateAdded: existing?.dateAdded,
      },
    });
    const result = await tvPublisher.publish(plan);
    logger.info({ youtubeId, written: result.written.length }, 'Regenerated TV episode metadata');
    return result;
  }
}

module.exports = new TvPublication();
module.exports.TvPublicationError = TvPublicationError;
