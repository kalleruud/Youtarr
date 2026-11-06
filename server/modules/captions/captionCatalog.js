/**
 * Caption provenance per video: records the sidecars a download published,
 * answers "which captions does this video have, and why is a language
 * missing", previews preference changes, and schedules delayed caption
 * checks for languages that are not available yet.
 */
const fs = require('fs').promises;
const path = require('path');
const logger = require('../../logger');
const { classifyCaptionSource, listOfferedTracks, SOURCES } = require('./captionSources');
const { assessCoverage, preferencesFromConfig, matchesEntry } = require('./captionTrackSelection');
const { resolveRetrySchedule, nextAttemptAt } = require('./enrichmentSchedule');
const files = require('./captionFiles');
const { CAPTION_RECORD_KEY } = require('./captionRecord');

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const PREVIEW_VIDEO_LIMIT = 200;
const PREVIEW_EXAMPLE_LIMIT = 25;
const ACTIVE_JOB_STATUSES = new Set(['pending', 'running']);
const LIVE_STATUSES = new Set(['is_live', 'was_live', 'post_live']);

function baseLanguage(code) {
  return code.split('-')[0].toLowerCase();
}

function isAudioOnly(filePath) {
  return /\.mp3$/i.test(filePath || '');
}

class CaptionCatalog {
  constructor({ store, configModule, now = () => new Date() } = {}) {
    this.store = store;
    this.configModule = configModule;
    this.now = now;
  }

  config() {
    return this.configModule.getConfig() || {};
  }

  async readInfo(youtubeId) {
    try {
      const infoPath = path.join(this.configModule.getJobsPath(), 'info', `${youtubeId}.info.json`);
      return JSON.parse(await fs.readFile(infoPath, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') logger.warn({ err, youtubeId }, 'Could not read cached info.json for captions');
      return null;
    }
  }

  /**
   * Sidecars on disk merged with their recorded provenance. A sidecar without
   * a row (downloaded before tracking) is classified from the cached info.json.
   */
  async describeOnDisk(video, info) {
    const rows = new Map((await this.store.listTracks(video.youtubeId)).map((row) => [row.track_code, row]));
    const revision = await files.mediaRevision(video.filePath);
    const sidecars = await files.listSidecars(video.filePath);
    return sidecars.map((sidecar) => {
      const row = rows.get(sidecar.code);
      return {
        code: sidecar.code,
        language: baseLanguage(sidecar.code),
        path: sidecar.path,
        source: row ? row.source : classifyCaptionSource({ code: sidecar.code, info }),
        origin: row ? row.origin : 'unrecorded',
        protected: Boolean(row && row.protected),
        mediaRevision: row ? row.media_revision : null,
        currentRevision: revision,
        normalizerVersion: row ? row.normalizer_version : null,
        retrievedAt: row ? row.retrieved_at : null,
        recorded: Boolean(row),
      };
    });
  }

  /**
   * Record the sidecars of freshly downloaded videos and schedule checks for
   * missing languages. Best effort: a failure is logged per video.
   * @param {{youtubeId: string, filePath?: string}[]} videoData
   */
  async recordDownloads(videoData) {
    for (const video of videoData || []) {
      if (!video || !YOUTUBE_ID.test(video.youtubeId || '') || !video.filePath || isAudioOnly(video.filePath)) continue;
      try {
        await this.recordDownload(video);
      } catch (err) {
        logger.warn({ err, youtubeId: video.youtubeId }, 'Could not record caption provenance');
      }
    }
  }

  async recordDownload({ youtubeId, filePath }) {
    const info = await this.readInfo(youtubeId);
    const records = Array.isArray(info?.[CAPTION_RECORD_KEY]) ? info[CAPTION_RECORD_KEY] : [];
    const revision = await files.mediaRevision(filePath);
    if (!revision) return;
    const existing = new Map((await this.store.listTracks(youtubeId)).map((row) => [row.track_code, row]));
    const sidecars = await files.listSidecars(filePath);
    const now = this.now();
    const onDisk = [];
    for (const sidecar of sidecars) {
      const bytes = await fs.readFile(sidecar.path);
      const resultSha256 = files.sha256(bytes);
      const record = records.find((item) => item && item.code === sidecar.code) || {};
      const source = Object.values(SOURCES).includes(record.source)
        ? record.source
        : classifyCaptionSource({ code: sidecar.code, info });
      await this.store.saveTrack({
        youtube_id: youtubeId,
        track_code: sidecar.code,
        language: baseLanguage(sidecar.code),
        source,
        origin: 'download',
        file_path: sidecar.path,
        media_revision: revision,
        source_sha256: /^[a-f0-9]{64}$/.test(record.sourceSha256 || '') ? record.sourceSha256 : resultSha256,
        result_sha256: resultSha256,
        normalizer_version: Number.isInteger(record.normalizerVersion) ? record.normalizerVersion : null,
        retrieved_at: now,
        protected: Boolean(existing.get(sidecar.code)?.protected),
      });
      onDisk.push({ code: sidecar.code, source });
    }
    const present = new Set(sidecars.map((sidecar) => sidecar.code));
    await this.store.deleteTracks(youtubeId, [...existing.keys()].filter((code) => !present.has(code)));
    await this.scheduleCheck({ youtubeId, info, onDisk, revision, baseline: now });
  }

  /**
   * Languages a later check should look for: missing ones, and for a live
   * broadcast also languages only automatic/translated tracks cover, since
   * uploaded captions often follow a broadcast.
   */
  wantedLanguages({ info, onDisk, preferences }) {
    const coverage = assessCoverage({ preferences, offered: listOfferedTracks(info), onDisk });
    const wanted = coverage.missing.map((item) => ({ language: item.language, reason: item.reason }));
    const live = LIVE_STATUSES.has(info?.live_status) || info?.was_live === true;
    if (live) {
      for (const entry of coverage.selection.tracks.map((track) => track.language)) {
        if (wanted.some((item) => item.language === entry)) continue;
        const present = onDisk.filter((track) => matchesEntry(entry, track.code));
        if (present.length && !present.some((track) => track.source === SOURCES.UPLOADED)) {
          wanted.push({ language: entry, reason: 'awaiting-uploaded' });
        }
      }
    }
    return wanted;
  }

  async scheduleCheck({ youtubeId, info, onDisk, revision, baseline }) {
    const config = this.config();
    if (!config.subtitlesEnabled) return null;
    const wanted = this.wantedLanguages({ info, onDisk, preferences: preferencesFromConfig(config) });
    const job = await this.store.getJob(youtubeId);
    if (!wanted.length) {
      if (job && ACTIVE_JOB_STATUSES.has(job.status)) {
        await this.store.saveJob(youtubeId, { status: 'completed', reason: null, next_attempt_at: null, lease_until: null });
      }
      return null;
    }
    if (config.captionEnrichmentEnabled !== true) return null;
    const offsetsMs = resolveRetrySchedule(config.captionEnrichmentRetrySchedule);
    return this.store.saveJob(youtubeId, {
      status: 'pending',
      reason: null,
      wanted: JSON.stringify(wanted),
      attempts: 0,
      max_attempts: offsetsMs.length,
      baseline_at: baseline,
      next_attempt_at: nextAttemptAt({ baseline, attempts: 0, offsetsMs, now: baseline }),
      last_attempt_at: null,
      lease_until: null,
      media_revision: revision,
    });
  }

  /**
   * Captions of one video for the video modal.
   * @returns {Promise<object|null>} null when the video is unknown
   */
  async getVideoCaptions(youtubeId) {
    const video = await this.store.getVideo(youtubeId);
    if (!video) return null;
    const config = this.config();
    const base = {
      youtubeId,
      subtitlesEnabled: config.subtitlesEnabled === true,
      enrichmentEnabled: config.captionEnrichmentEnabled === true,
    };
    if (video.removed || !video.filePath || isAudioOnly(video.filePath)) {
      return { ...base, tracks: [], missing: [], upgrades: [], unsupported: [], enrichment: null, mediaAvailable: false };
    }
    const info = await this.readInfo(youtubeId);
    const onDisk = await this.describeOnDisk(video, info);
    const coverage = assessCoverage({ preferences: preferencesFromConfig(config), offered: listOfferedTracks(info), onDisk });
    const job = await this.store.getJob(youtubeId);
    const jobWanted = parseWanted(job);
    const missing = coverage.missing.map((item) => ({
      ...item,
      state: missingState(job, jobWanted, item.language),
    }));
    return {
      ...base,
      mediaAvailable: true,
      tracks: onDisk.map((track) => ({
        code: track.code,
        language: track.language,
        source: track.source,
        origin: track.origin,
        protected: track.protected,
        normalizerVersion: track.normalizerVersion,
        retrievedAt: track.retrievedAt,
        mediaRevisionCurrent: track.mediaRevision == null ? null : track.mediaRevision === track.currentRevision,
      })),
      missing,
      upgrades: coverage.upgrades,
      unsupported: coverage.unsupported,
      enrichment: job ? describeJob(job, jobWanted) : null,
    };
  }

  async setProtection(youtubeId, code, value) {
    const video = await this.store.getVideo(youtubeId);
    if (!video || !video.filePath) return { status: 'not-found' };
    const sidecars = await files.listSidecars(video.filePath);
    const sidecar = sidecars.find((item) => item.code === code);
    if (!sidecar) return { status: 'not-found' };
    if (!(await this.store.setProtected(youtubeId, code, value))) {
      // A sidecar without a row (downloaded before tracking): record it now.
      const info = await this.readInfo(youtubeId);
      const bytes = await fs.readFile(sidecar.path);
      await this.store.saveTrack({
        youtube_id: youtubeId,
        track_code: code,
        language: baseLanguage(code),
        source: classifyCaptionSource({ code, info }),
        origin: 'unrecorded',
        file_path: sidecar.path,
        media_revision: await files.mediaRevision(video.filePath),
        source_sha256: files.sha256(bytes),
        result_sha256: files.sha256(bytes),
        retrieved_at: null,
        protected: value,
      });
    }
    return { status: 'ok' };
  }

  /**
   * Check again now: re-baselines on the current media file and grants one
   * more attempt beyond those already made.
   */
  async requestRetry(youtubeId) {
    const config = this.config();
    if (config.captionEnrichmentEnabled !== true) return { status: 'disabled' };
    const video = await this.store.getVideo(youtubeId);
    if (!video || video.removed || !video.filePath || isAudioOnly(video.filePath)) return { status: 'not-found' };
    const revision = await files.mediaRevision(video.filePath);
    if (!revision) return { status: 'not-found' };
    const info = await this.readInfo(youtubeId);
    const onDisk = await this.describeOnDisk(video, info);
    const wanted = this.wantedLanguages({ info, onDisk, preferences: preferencesFromConfig(config) });
    if (!wanted.length) return { status: 'nothing-missing' };
    const job = await this.store.getJob(youtubeId);
    if (job && job.status === 'running') return { status: 'running' };
    const now = this.now();
    const attempts = job ? job.attempts : 0;
    const saved = await this.store.saveJob(youtubeId, {
      status: 'pending',
      reason: null,
      wanted: JSON.stringify(wanted),
      attempts,
      max_attempts: attempts + 1,
      baseline_at: job ? job.baseline_at : now,
      next_attempt_at: now,
      lease_until: null,
      media_revision: revision,
    });
    return { status: 'scheduled', enrichment: describeJob(saved, wanted) };
  }

  /**
   * What the proposed preferences would publish compared with the saved ones,
   * for the most recent downloads. Nothing is changed.
   */
  async previewPreferences(proposedConfig) {
    const current = preferencesFromConfig(this.config());
    const proposed = preferencesFromConfig({ ...this.config(), ...proposedConfig });
    const videos = await this.store.listRecentVideos(PREVIEW_VIDEO_LIMIT);
    const totals = { videosChecked: 0, videosChanged: 0, newlyMissing: 0, newlyCovered: 0, upgrades: 0 };
    const examples = [];
    for (const video of videos) {
      if (isAudioOnly(video.filePath)) continue;
      const info = await this.readInfo(video.youtubeId);
      if (!info) continue;
      totals.videosChecked++;
      const offered = listOfferedTracks(info);
      const onDisk = await this.describeOnDisk(video, info);
      const before = assessCoverage({ preferences: current, offered, onDisk });
      const after = assessCoverage({ preferences: proposed, offered, onDisk });
      const beforeCodes = before.selection.tracks.map((track) => track.code);
      const afterTracks = after.selection.tracks.map((track) => ({ code: track.code, source: track.source }));
      const added = afterTracks.filter((track) => !beforeCodes.includes(track.code));
      const removed = beforeCodes.filter((code) => !afterTracks.some((track) => track.code === code));
      const newlyMissing = after.missing.filter((item) => !before.missing.some((prior) => prior.language === item.language));
      if (!added.length && !removed.length && !newlyMissing.length && after.upgrades.length === before.upgrades.length) continue;
      totals.videosChanged++;
      totals.newlyMissing += newlyMissing.length;
      totals.newlyCovered += before.missing.filter((item) => !after.missing.some((next) => next.language === item.language)).length;
      totals.upgrades += Math.max(0, after.upgrades.length - before.upgrades.length);
      if (examples.length < PREVIEW_EXAMPLE_LIMIT) {
        examples.push({
          youtubeId: video.youtubeId,
          title: video.title,
          onDisk: onDisk.map((track) => ({ code: track.code, source: track.source })),
          added,
          removed,
          missing: after.missing,
        });
      }
    }
    return { totals, examples, limit: PREVIEW_VIDEO_LIMIT };
  }
}

function parseWanted(job) {
  if (!job || !job.wanted) return [];
  try {
    const wanted = JSON.parse(job.wanted);
    return Array.isArray(wanted) ? wanted : [];
  } catch {
    return [];
  }
}

function missingState(job, wanted, language) {
  if (!job || !wanted.some((item) => item.language === language)) return 'unavailable';
  if (ACTIVE_JOB_STATUSES.has(job.status)) return 'pending';
  if (job.status === 'exhausted') return 'exhausted';
  if (job.status === 'blocked') return 'blocked';
  return 'unavailable';
}

function describeJob(job, wanted) {
  return {
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.max_attempts,
    nextAttemptAt: job.next_attempt_at,
    lastAttemptAt: job.last_attempt_at,
    reason: job.reason,
    languages: wanted.map((item) => item.language),
  };
}

module.exports = { CaptionCatalog, parseWanted };
