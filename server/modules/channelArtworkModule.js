const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const configModule = require('./configModule');
const logger = require('../logger');
const ChannelArtwork = require('../models/channelArtwork');
const Channel = require('../models/channel');
const Video = require('../models/video');
const serverRegistry = require('./mediaServers/serverRegistry');
const { resolveEffectiveSubfolder, buildChannelPath, resolveChannelFolderName } = require('./filesystem');
const { detectImageType, probeImage, sha256File } = require('./artwork/imageInspector');
const { composePoster, normalizeUpload } = require('./artwork/posterComposer');
const { resolveShowArtwork } = require('./artwork/showArtwork');
const { prepareEpisodeArtwork, publishEpisodeArtwork } = require('./artwork/episodeArtwork');
const {
  UPLOAD_MIN_WIDTH,
  UPLOAD_MIN_HEIGHT,
  UPLOAD_MAX_DIMENSION,
  UPLOAD_MIN_ASPECT,
  UPLOAD_MAX_ASPECT,
  SHOW_POSTER_FILENAME,
  POSTER_SOURCES,
  REFRESH_STATUSES,
} = require('./artwork/constants');

const MAX_MESSAGE_LENGTH = 500;
const AUDIO_ONLY_EXTENSION = /\.mp3$/i;

class ArtworkValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ArtworkValidationError';
    this.statusCode = 400;
  }
}

function stagingPath(target) {
  return `${target}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}.jpg`;
}

function removeQuietly(filePath) {
  try {
    fs.removeSync(filePath);
  } catch (err) {
    logger.debug({ err, filePath }, 'Could not remove staged artwork file');
  }
}

class ChannelArtworkModule {
  constructor() {
    this.ArtworkValidationError = ArtworkValidationError;
  }

  /** Portrait posters and episode thumbs are written only with this on. */
  isEnabled(config = configModule.getConfig() || {}) {
    return config.tvShowArtwork === true && config.writeChannelPosters !== false;
  }

  posterCachePath(channelId) {
    return path.join(configModule.getImagePath(), `channelposter-${channelId}.jpg`);
  }

  manualPosterPath(channelId) {
    return path.join(configModule.getImagePath(), `channelposter-manual-${channelId}.jpg`);
  }

  // The full-size avatar when it was kept, else the resized one every
  // channel already has.
  upstreamImagePath(channelId) {
    const imageDir = configModule.getImagePath();
    const full = path.join(imageDir, `channelavatar-${channelId}.jpg`);
    if (fs.existsSync(full)) return full;
    const small = path.join(imageDir, `channelthumb-${channelId}.jpg`);
    return fs.existsSync(small) ? small : null;
  }

  async getRecord(channelId) {
    const [record] = await ChannelArtwork.findOrCreate({
      where: { channel_id: channelId },
      defaults: { channel_id: channelId, poster_source: POSTER_SOURCES.AUTO, poster_protected: false, poster_revision: 0 },
    });
    return record;
  }

  async findChannel(channelId) {
    return Channel.findOne({ where: { channel_id: channelId } });
  }

  /** The channel's folder in the library, or null when it cannot be resolved. */
  resolveChannelFolder(channel) {
    const outputDir = configModule.directoryPath;
    const folderName = channel && resolveChannelFolderName(channel);
    if (!outputDir || !folderName) return null;
    try {
      const subfolder = resolveEffectiveSubfolder(channel.sub_folder, configModule.getDefaultSubfolder());
      return buildChannelPath(outputDir, subfolder, folderName);
    } catch (err) {
      logger.warn({ err, channelId: channel.channel_id }, 'Could not resolve channel folder for artwork');
      return null;
    }
  }

  /**
   * Bring the cached show poster up to date with the current preference
   * and upstream images. Regeneration is deterministic: the same inputs
   * produce the same bytes, which keep the same revision. Unchanged inputs
   * (a fingerprint of the selection, both source images and the title)
   * return early without running ffprobe or ffmpeg, so the channel-listing
   * backfill stays cheap.
   * @param {string} channelId
   * @param {Object} opts - { force: recompose even when inputs are unchanged and the poster is pinned }
   */
  async resolvePoster(channelId, { force = false } = {}) {
    const channel = await this.findChannel(channelId);
    const record = await this.getRecord(channelId);
    const cachePath = this.posterCachePath(channelId);
    const cacheExists = fs.existsSync(cachePath);
    const pinnedAuto = record.poster_protected && record.poster_source !== POSTER_SOURCES.MANUAL;
    if (pinnedAuto && cacheExists && !force) return record;

    const title = channel ? channel.title || channel.uploader || '' : '';
    const manualPath = this.manualPosterPath(channelId);
    const manualSha = fs.existsSync(manualPath) ? sha256File(manualPath) : null;
    const upstreamPath = this.upstreamImagePath(channelId);
    const upstreamSha = upstreamPath ? sha256File(upstreamPath) : null;
    const fingerprint = crypto.createHash('sha256')
      .update(JSON.stringify([record.poster_source, manualSha, upstreamSha, title]))
      .digest('hex');
    if (cacheExists && !force && record.input_fingerprint === fingerprint && record.poster_sha256 === sha256File(cachePath)) {
      return record;
    }

    const decision = resolveShowArtwork(
      { channelId, title },
      {
        source: record.poster_source,
        protected: record.poster_protected && !force,
        current: { exists: cacheExists, origin: record.poster_origin },
      },
      {
        manual: manualSha ? { path: manualPath, sha256: manualSha } : null,
        upstream: upstreamPath ? { path: upstreamPath, sha256: upstreamSha, dimensions: await probeImage(upstreamPath) } : null,
      }
    );
    if (decision.action === 'keep') return record;

    const staged = stagingPath(cachePath);
    try {
      if (decision.action === 'copy') {
        fs.copySync(decision.sourcePath, staged);
      } else {
        await composePoster(
          { sourcePath: decision.sourcePath, outputPath: staged, channelId, title: decision.title },
          { ffmpegPath: configModule.ffmpegPath }
        );
      }
      const dimensions = await probeImage(staged);
      if (!dimensions) throw new Error('Prepared poster is not a readable image');
      const sha = sha256File(staged);
      const changed = sha !== record.poster_sha256 || !cacheExists;
      fs.renameSync(staged, cachePath);
      await record.update({
        poster_origin: decision.origin,
        poster_width: dimensions.width,
        poster_height: dimensions.height,
        poster_sha256: sha,
        input_fingerprint: fingerprint,
        poster_revision: changed ? record.poster_revision + 1 : record.poster_revision,
        updated_at: new Date(),
      });
      return record;
    } finally {
      removeQuietly(staged);
    }
  }

  // A poster.jpg already in the folder is replaced only when Youtarr wrote
  // it (our last publication, or the old square avatar copy) or the owner
  // chose a manual poster. Anything else was put there by hand and is kept.
  async canReplaceFolderPoster(targetPath, record, channelId) {
    if (!fs.existsSync(targetPath)) return true;
    if (record.poster_source === POSTER_SOURCES.MANUAL) return true;
    const sha = sha256File(targetPath);
    if (sha && sha === record.published_sha256) return true;
    const squareCache = path.join(configModule.getImagePath(), `channelthumb-${channelId}.jpg`);
    if (sha && sha === sha256File(squareCache)) return true;
    const dims = await probeImage(targetPath);
    return Boolean(dims && dims.width === dims.height);
  }

  /**
   * Resolve the poster and write it as poster.jpg in the channel folder
   * (temp file + rename, so a reader never sees half an image). Requests a
   * targeted Jellyfin refresh when the published image changed. Never
   * touches media files.
   * @returns {Promise<{ published: boolean, note: string|null }>}
   */
  async publishPoster(channelId, { folderPath = null, force = false, refresh = true } = {}) {
    if (!this.isEnabled()) return { published: false, note: 'Portrait show artwork is turned off.' };
    await this.resolvePoster(channelId, { force });
    const record = await this.getRecord(channelId);
    const cachePath = this.posterCachePath(channelId);
    const folder = folderPath || this.resolveChannelFolder(await this.findChannel(channelId));
    if (!folder || !fs.existsSync(folder) || !fs.existsSync(cachePath)) {
      return { published: false, note: null };
    }
    const target = path.join(folder, SHOW_POSTER_FILENAME);
    if (fs.existsSync(target) && sha256File(target) === record.poster_sha256) {
      return { published: false, note: null };
    }
    if (!(await this.canReplaceFolderPoster(target, record, channelId))) {
      const note = 'The channel folder has a poster.jpg that Youtarr did not write; it was kept. Upload it here to manage it.';
      if (record.publish_note !== note) await record.update({ publish_note: note });
      return { published: false, note };
    }
    const staged = stagingPath(target);
    try {
      fs.copySync(cachePath, staged);
      fs.renameSync(staged, target);
    } finally {
      removeQuietly(staged);
    }
    await record.update({ published_sha256: record.poster_sha256, published_at: new Date(), publish_note: null });
    logger.info({ channelId, revision: record.poster_revision, origin: record.poster_origin }, 'Published show poster');
    if (refresh) await this.requestRefresh(channelId, folder);
    return { published: true, note: null };
  }

  /** Ask Jellyfin to re-read this channel's images; the outcome is stored for display and retry. */
  async requestRefresh(channelId, folderPath = null) {
    const record = await this.getRecord(channelId);
    const folder = folderPath || this.resolveChannelFolder(await this.findChannel(channelId));
    const adapters = serverRegistry.getEnabledAdapters(configModule.getConfig() || {})
      .filter((adapter) => typeof adapter.refreshFolderImages === 'function');
    let result;
    if (!adapters.length) {
      result = { status: REFRESH_STATUSES.NOT_CONFIGURED, message: 'No Jellyfin server is configured; the new poster is picked up on its next library scan.' };
    } else if (!folder) {
      result = { status: REFRESH_STATUSES.FAILED, message: 'The channel folder could not be resolved.' };
    } else {
      result = await adapters[0].refreshFolderImages(folder);
    }
    await record.update({
      refresh_status: result.status,
      refresh_message: String(result.message || '').slice(0, MAX_MESSAGE_LENGTH),
      refresh_attempted_at: new Date(),
    });
    return result;
  }

  /**
   * Validate and store an owner-uploaded poster, then select and pin it.
   * The upload is checked by content (JPEG/PNG/WebP), dimensions and
   * shape, and re-encoded before it replaces anything; a rejected upload
   * leaves the current artwork untouched.
   */
  async uploadManualPoster(channelId, buffer) {
    if (!(await this.findChannel(channelId))) return null;
    if (!detectImageType(buffer)) throw new ArtworkValidationError('Upload a JPEG, PNG or WebP image.');
    const manualPath = this.manualPosterPath(channelId);
    const rawPath = stagingPath(manualPath);
    const normalizedPath = stagingPath(manualPath);
    try {
      fs.writeFileSync(rawPath, buffer);
      const dims = await probeImage(rawPath);
      if (!dims) throw new ArtworkValidationError('The file could not be read as an image.');
      if (dims.width > UPLOAD_MAX_DIMENSION || dims.height > UPLOAD_MAX_DIMENSION) {
        throw new ArtworkValidationError(`Images larger than ${UPLOAD_MAX_DIMENSION} pixels on a side are not accepted.`);
      }
      if (dims.width < UPLOAD_MIN_WIDTH || dims.height < UPLOAD_MIN_HEIGHT) {
        throw new ArtworkValidationError(`The poster must be at least ${UPLOAD_MIN_WIDTH}x${UPLOAD_MIN_HEIGHT} pixels.`);
      }
      const aspect = dims.width / dims.height;
      if (aspect < UPLOAD_MIN_ASPECT || aspect > UPLOAD_MAX_ASPECT) {
        throw new ArtworkValidationError('The poster must be portrait (about 2:3, width divided by height between 0.5 and 0.8).');
      }
      await normalizeUpload({ inputPath: rawPath, outputPath: normalizedPath }, { ffmpegPath: configModule.ffmpegPath });
      if (!(await probeImage(normalizedPath))) throw new ArtworkValidationError('The image could not be converted.');
      fs.renameSync(normalizedPath, manualPath);
    } finally {
      removeQuietly(rawPath);
      removeQuietly(normalizedPath);
    }
    const record = await this.getRecord(channelId);
    await record.update({ poster_source: POSTER_SOURCES.MANUAL, poster_protected: true, updated_at: new Date() });
    await this.applyChange(channelId);
    return this.getStatus(channelId);
  }

  /** Change the selection ('auto' | 'manual') or the pin. */
  async updatePreference(channelId, { source, protected: pinned } = {}) {
    if (!(await this.findChannel(channelId))) return null;
    const record = await this.getRecord(channelId);
    const changes = {};
    if (source !== undefined) {
      if (!Object.values(POSTER_SOURCES).includes(source)) throw new ArtworkValidationError('source must be "auto" or "manual".');
      if (source === POSTER_SOURCES.MANUAL && !fs.existsSync(this.manualPosterPath(channelId))) {
        throw new ArtworkValidationError('Upload a poster before selecting it.');
      }
      changes.poster_source = source;
    }
    if (pinned !== undefined) {
      if (typeof pinned !== 'boolean') throw new ArtworkValidationError('protected must be true or false.');
      changes.poster_protected = pinned;
    }
    await record.update({ ...changes, updated_at: new Date() });
    await this.applyChange(channelId);
    return this.getStatus(channelId);
  }

  /** Forget the uploaded poster and the pin; go back to automatic artwork. */
  async resetPoster(channelId) {
    if (!(await this.findChannel(channelId))) return null;
    removeQuietly(this.manualPosterPath(channelId));
    const record = await this.getRecord(channelId);
    await record.update({ poster_source: POSTER_SOURCES.AUTO, poster_protected: false, updated_at: new Date() });
    await this.applyChange(channelId);
    return this.getStatus(channelId);
  }

  /**
   * Regenerate the poster from the current upstream image and republish
   * poster.jpg plus every downloaded episode's -thumb.jpg. Metadata only:
   * no video is downloaded or rewritten.
   */
  async regenerate(channelId) {
    const channel = await this.findChannel(channelId);
    if (!channel) return null;
    await this.applyChange(channelId, { force: true });
    const episodes = this.isEnabled() ? await this.republishEpisodeThumbs(channelId) : { written: 0, existing: 0, missing: 0, failed: 0 };
    return { ...(await this.getStatus(channelId)), episodes };
  }

  async applyChange(channelId, { force = false } = {}) {
    if (this.isEnabled()) {
      await this.publishPoster(channelId, { force });
    } else {
      await this.resolvePoster(channelId, { force });
    }
  }

  async republishEpisodeThumbs(channelId) {
    const videos = await Video.findAll({ where: { channel_id: channelId, removed: false }, attributes: ['filePath'] });
    const counts = { written: 0, existing: 0, missing: 0, failed: 0 };
    const outcomeKeys = { written: 'written', exists: 'existing', 'no-source': 'missing', failed: 'failed' };
    for (const video of videos) {
      if (!video.filePath || AUDIO_ONLY_EXTENSION.test(video.filePath)) continue;
      counts[outcomeKeys[publishEpisodeArtwork(prepareEpisodeArtwork(video), { logger })]] += 1;
    }
    return counts;
  }

  /** Best-effort hook for channel refreshes and downloads; never throws. */
  async syncChannel(channelId, opts = {}) {
    try {
      return await this.publishPoster(channelId, opts);
    } catch (err) {
      logger.warn({ err, channelId }, 'Could not update show poster');
      return { published: false, note: null };
    }
  }

  async getStatus(channelId) {
    const channel = await this.findChannel(channelId);
    if (!channel) return null;
    const record = (await ChannelArtwork.findByPk(channelId)) || {
      poster_source: POSTER_SOURCES.AUTO, poster_protected: false, poster_revision: 0,
    };
    const cacheExists = fs.existsSync(this.posterCachePath(channelId));
    return {
      enabled: this.isEnabled(),
      source: record.poster_source,
      protected: Boolean(record.poster_protected),
      origin: record.poster_origin || null,
      width: record.poster_width || null,
      height: record.poster_height || null,
      revision: record.poster_revision,
      manualAvailable: fs.existsSync(this.manualPosterPath(channelId)),
      posterUrl: cacheExists ? `/images/channelposter-${channelId}.jpg?rev=${record.poster_revision}` : null,
      publishedAt: record.published_at || null,
      publishNote: record.publish_note || null,
      refresh: record.refresh_status
        ? { status: record.refresh_status, message: record.refresh_message, attemptedAt: record.refresh_attempted_at }
        : null,
    };
  }
}

module.exports = new ChannelArtworkModule();
module.exports.ArtworkValidationError = ArtworkValidationError;
