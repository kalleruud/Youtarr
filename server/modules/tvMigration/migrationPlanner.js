// Builds the manifest of a TV library migration: for every downloaded video
// still in the regular (movie) layout, where its media file and sidecars go in
// the Jellyfin TV layout, which files have no place there, and why a video
// cannot be moved. Nothing on disk, in the library or on a media server
// changes. Planning does allocate the stable episode numbers (#6) through the
// same seam a download uses, so the manifest's numbers are final.
const fs = require('fs-extra');
const path = require('path');
const { Op } = require('sequelize');
const { Video, Channel } = require('../../models');
const configModule = require('../configModule');
const tvPublication = require('../tvPublication');
const tvPublisher = require('../tvPublication/tvPublisher');
const { planPublication } = require('../tvPublication/tvPlanner');
const { buildSeasonFolderName } = require('../tvPublication/tvNaming');
const { isFileForVideo, VIDEO_EXTENSIONS } = require('../filesystem');
const { checkLibraryRoot, libraryCheckCoversRows } = require('../libraryRootCheck');
const { fingerprint, statOrNull } = require('./fileMover');
const { assertSafePath, withSafeRoots } = require('../filesystem/safePath');
const { describeMediaServers } = require('./userState');

const PLAN_VERSION = 1;
// Keep this much free beyond the bytes a cross-filesystem copy needs.
const FREE_SPACE_MARGIN_BYTES = 1024 * 1024 * 1024;
const SUBFOLDER_PREFIX = '__';

class SkipError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function pad(n) {
  return String(n).padStart(2, '0');
}

// The NFO "dateadded" format; the original download time keeps the media
// server's "recently added" order.
function formatDateAdded(date) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

async function readInfo(youtubeId) {
  try {
    return JSON.parse(await fs.readFile(path.join(configModule.getJobsPath(), 'info', `${youtubeId}.info.json`), 'utf8'));
  } catch (err) {
    return null;
  }
}

// Episode metadata from the cached .info.json, else from the Videos row: the
// migration never asks YouTube.
async function videoInfo(row) {
  const info = (await readInfo(row.youtubeId)) || {
    title: row.youTubeVideoName,
    description: row.description || '',
    duration: row.duration,
    upload_date: row.originalDate,
    channel: row.youTubeChannelName,
  };
  info.id = row.youtubeId;
  if (row.normalized_rating !== undefined) info.normalized_rating = row.normalized_rating;
  return info;
}

async function isWritable(dir) {
  try {
    await fs.access(dir, fs.constants.W_OK);
    return true;
  } catch (err) {
    return false;
  }
}

// Folders show folders may live in: the downloads folder and its __subfolders.
async function libraryParents(baseDir) {
  const parents = [baseDir];
  for (const name of await fs.readdir(baseDir).catch(() => [])) {
    if (!name.startsWith(SUBFOLDER_PREFIX)) continue;
    if ((await statOrNull(path.join(baseDir, name)))?.isDirectory()) parents.push(path.join(baseDir, name));
  }
  return parents;
}

class MigrationPlanner {
  /**
   * @param {object} options
   * @param {string} options.planId
   * @param {string[]} [options.channelIds] - limit to these channels
   * @param {boolean} [options.verifyChecksums]
   * @param {Date} [options.now]
   */
  async plan({ planId, channelIds = null, verifyChecksums = true, now = new Date() }) {
    const config = configModule.getConfig() || {};
    const baseDir = configModule.directoryPath;
    const plan = {
      planId,
      version: PLAN_VERSION,
      createdAt: now.toISOString(),
      baseDir,
      profileAtPlan: tvPublication.profileOf(config),
      options: { verifyChecksums: verifyChecksums !== false },
      scope: { channelIds: channelIds && channelIds.length ? [...channelIds] : null },
      items: [],
      skipped: [],
      alreadyMigrated: 0,
      blockers: [],
      warnings: [],
      mediaServers: describeMediaServers(config),
    };
    if (!baseDir) {
      plan.blockers.push({ code: 'no-library', message: 'No downloads folder is configured.' });
      return this._finish(plan);
    }
    const libraryCheck = await checkLibraryRoot(baseDir);
    if (await libraryCheckCoversRows(libraryCheck, Video, { removed: false })) {
      plan.blockers.push({ code: 'library-unavailable', message: libraryCheck.message });
      return this._finish(plan);
    }
    if (!tvPublication.isEnabled(config)) {
      plan.warnings.push({
        code: 'profile-not-tv',
        message: 'The Library Output Profile is not Jellyfin TV. Switch it before applying, so new downloads land in the same show folders.',
      });
    }

    const where = { removed: false, filePath: { [Op.ne]: null } };
    if (plan.scope.channelIds) where.channel_id = plan.scope.channelIds;
    const rows = await Video.findAll({ where, order: [['channel_id', 'ASC'], ['id', 'ASC']] });

    const context = { baseDir, parents: await libraryParents(baseDir), showFolders: new Map(), channels: new Map(), targets: new Set() };
    for (const row of rows) {
      try {
        const item = await this._planItem(row, context);
        if (item === 'already-migrated') {
          plan.alreadyMigrated += 1;
        } else {
          plan.items.push(item);
        }
      } catch (err) {
        if (!(err instanceof SkipError) && !err.code) throw err;
        plan.skipped.push({
          youtubeId: row.youtubeId,
          channelId: row.channel_id || null,
          title: row.youTubeVideoName,
          filePath: row.filePath,
          code: err.code,
          message: err.message,
        });
      }
    }
    await this._checkFreeSpace(plan);
    return this._finish(plan);
  }

  _finish(plan) {
    const channels = new Set(plan.items.map((item) => item.channelId));
    const shows = [...new Set(plan.items.map((item) => item.showDir))].sort();
    plan.summary = {
      toMove: plan.items.length,
      skipped: plan.skipped.length,
      alreadyMigrated: plan.alreadyMigrated,
      channels: channels.size,
      shows,
      bytes: plan.items.reduce((sum, item) => sum + item.media.fingerprint.size, 0),
      copyBytes: plan.items.filter((item) => item.crossDevice).reduce((sum, item) => sum + item.media.fingerprint.size, 0),
    };
    return plan;
  }

  async _planItem(row, context) {
    const { youtubeId } = row;
    const channelId = row.channel_id;
    if (!channelId) throw new SkipError('no-channel', 'The video has no channel, so it cannot be placed in a show.');
    if (tvPublication.publishedLocation(row.filePath, channelId)) return 'already-migrated';

    const relative = path.relative(context.baseDir, row.filePath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new SkipError('outside-library', 'The file is outside the downloads folder.');
    }
    if (!VIDEO_EXTENSIONS.includes(path.extname(row.filePath).toLowerCase())) {
      throw new SkipError('not-video', 'Only video files move into the TV layout; audio-only downloads stay where they are.');
    }
    await assertSafePath(row.filePath, context.baseDir);
    const mediaPrint = await fingerprint(row.filePath).catch(() => null);
    if (!mediaPrint) throw new SkipError('missing-media', 'The video file is not on disk.');

    const oldDir = path.dirname(row.filePath);
    const perVideoFolder = path.basename(oldDir).endsWith(` - ${youtubeId}`);
    const channelDir = perVideoFolder ? path.dirname(oldDir) : oldDir;
    const parentDir = path.dirname(channelDir);
    if (!context.parents.includes(parentDir)) {
      throw new SkipError('unexpected-layout', 'The file is not in a channel folder of the downloads folder or one of its __subfolders.');
    }

    const info = await videoInfo(row);
    const assignment = await tvPublication.assign(channelId, info);
    if (!['assigned', 'date-correction-review'].includes(assignment.status) || !Number.isInteger(assignment.season)) {
      throw new SkipError('date-required', 'The publication date is unknown, so no season and episode can be assigned.');
    }

    const show = await this._showFolder(context, channelId, parentDir);
    const seasonDir = path.join(show.parentDir, show.folderName || '_', buildSeasonFolderName(assignment.season));
    await assertSafePath(seasonDir, context.baseDir);
    if (show.folderName && await tvPublisher.findExistingEpisode(seasonDir, youtubeId)) {
      throw new SkipError('already-published', 'A TV episode file for this video already exists; the movie-layout copy is left in place.');
    }

    const assets = await tvPublisher.collectAssets(row.filePath);
    const downloadedAt = row.last_downloaded_at ? new Date(row.last_downloaded_at) : new Date(mediaPrint.mtimeMs);
    const channel = await this._channel(context, channelId);
    const publication = planPublication({
      video: tvPublication.videoFromInfo(info, {
        channelId,
        showTitle: (channel && (channel.title || channel.uploader)) || row.youTubeChannelName || null,
        showPlot: channel && channel.description,
      }),
      assignment,
      assets,
      layout: { parentDir: show.parentDir, showFolderName: show.folderName, dateAdded: formatDateAdded(downloadedAt) },
    });
    if (!show.folderName) show.folderName = path.basename(publication.showDir);

    const files = [];
    for (const sidecar of publication.sidecars) {
      files.push({ role: sidecar.role, source: sidecar.source, target: sidecar.target, fingerprint: await fingerprint(sidecar.source) });
    }
    const mapped = new Set([row.filePath, ...files.map((file) => file.source)]);
    const leftovers = [];
    const kept = [];
    for (const name of (await fs.readdir(oldDir)).sort()) {
      const source = path.join(oldDir, name);
      if (mapped.has(source) || name.startsWith(tvPublisher.STAGING_PREFIX) || !isFileForVideo(name, youtubeId)) continue;
      if (row.audioFilePath && path.resolve(row.audioFilePath) === path.resolve(source)) {
        kept.push(source);
        continue;
      }
      if (VIDEO_EXTENSIONS.includes(path.extname(name).toLowerCase())) {
        throw new SkipError('multiple-media', `Another video file for this video is in the same folder (${name}).`);
      }
      await assertSafePath(source, context.baseDir);
      const print = await fingerprint(source).catch(() => null);
      if (print) leftovers.push({ name, source, fingerprint: print });
    }

    const targets = [publication.media.target, publication.episodeNfo.target, ...files.map((file) => file.target)];
    for (const target of targets) {
      await assertSafePath(target, context.baseDir);
      if (context.targets.has(target)) throw new SkipError('duplicate-target', `Another video in this plan would use ${target}.`);
      if (await statOrNull(target)) throw new SkipError('target-exists', `A file already exists at ${target}.`);
    }
    targets.forEach((target) => context.targets.add(target));

    if (!(await isWritable(oldDir)) || !(await isWritable(show.parentDir))) {
      throw new SkipError('not-writable', 'Youtarr cannot write to the video folder or the library folder. Fix the folder permissions; the migration never changes them.');
    }
    const parentPrint = await statOrNull(show.parentDir);

    return {
      youtubeId,
      channelId,
      title: info.title || row.youTubeVideoName,
      season: assignment.season,
      episode: assignment.episode,
      assignmentVersion: assignment.assignmentVersion,
      oldDir,
      perVideoFolder,
      showDir: publication.showDir,
      seasonDir: publication.seasonDir,
      crossDevice: Boolean(parentPrint && parentPrint.dev !== mediaPrint.dev),
      media: { source: row.filePath, target: publication.media.target, fingerprint: mediaPrint },
      files,
      leftovers,
      kept,
      documents: [...publication.documents, publication.episodeNfo].map((doc) => ({ role: doc.role, target: doc.target, content: doc.content })),
    };
  }

  async _channel(context, channelId) {
    if (!context.channels.has(channelId)) {
      context.channels.set(channelId, await Channel.findOne({
        where: { channel_id: channelId }, attributes: ['title', 'uploader', 'description'],
      }));
    }
    return context.channels.get(channelId);
  }

  // The channel's show folder: an existing one (found by channel id) in the
  // channel's own folder's parent first, then anywhere in the library, else a
  // new one beside the old channel folder. Decided once per channel per plan.
  async _showFolder(context, channelId, parentDir) {
    if (context.showFolders.has(channelId)) return context.showFolders.get(channelId);
    let show = null;
    for (const candidate of [parentDir, ...context.parents.filter((dir) => dir !== parentDir)]) {
      const folderName = await tvPublisher.findShowFolderName(candidate, channelId);
      if (folderName) {
        show = { parentDir: candidate, folderName };
        break;
      }
    }
    show = show || { parentDir, folderName: null };
    context.showFolders.set(channelId, show);
    return show;
  }

  // Copies across filesystems need room for the whole file until the source
  // is removed. Renames need none.
  async _checkFreeSpace(plan) {
    const needs = new Map();
    for (const item of plan.items.filter((entry) => entry.crossDevice)) {
      const parent = path.dirname(item.showDir);
      needs.set(parent, (needs.get(parent) || 0) + item.media.fingerprint.size);
    }
    for (const [dir, bytes] of needs) {
      let available;
      try {
        const stats = await fs.promises.statfs(dir);
        available = stats.bavail * stats.bsize;
      } catch (err) {
        plan.warnings.push({ code: 'free-space-unknown', message: `Could not measure free space in ${dir}.` });
        continue;
      }
      if (available < bytes + FREE_SPACE_MARGIN_BYTES) {
        plan.blockers.push({
          code: 'insufficient-space',
          message: `Copying to ${dir} needs ${bytes} bytes plus a 1 GB margin, but only ${available} bytes are free.`,
        });
      }
    }
  }
}

const planner = new MigrationPlanner();
const plan = planner.plan.bind(planner);
planner.plan = (...args) => withSafeRoots([configModule.directoryPath], () => plan(...args));
module.exports = planner;
module.exports.SkipError = SkipError;
module.exports.formatDateAdded = formatDateAdded;
