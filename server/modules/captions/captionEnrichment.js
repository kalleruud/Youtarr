/**
 * Delayed caption checks: a durable, bounded, rate-limited worker that asks
 * YouTube for captions a download did not get (a broadcast's captions often
 * arrive hours later) and publishes them next to the existing media.
 *
 * - Metadata and captions only: never the media, never the download archive,
 *   never a Videos row or the cached info.json.
 * - One check at a time, at least `captionEnrichmentMinIntervalSeconds`
 *   apart, at most MAX_JOBS_PER_TICK per tick, and none while a download is
 *   running: download activity is re-checked right before the request, and a
 *   request in flight when a download starts is stopped and returned to the
 *   queue without counting an attempt. A throttle response pauses every check
 *   without counting an attempt.
 * - Captions are published only when the stored media has the source's
 *   length (no SponsorBlock cut), and only for the media revision the check
 *   was scheduled for; protected and verbatim-listed tracks are never
 *   replaced. Publication holds the video's publication lease, and every
 *   write first re-checks download activity, the media revision and the
 *   track's protection. A track is retired only after an uploaded track that
 *   supersedes it was published.
 */
const fs = require('fs').promises;
const path = require('path');
const logger = require('../../logger');
const { normalizeCaptionTrack } = require('../download/captionNormalizer');
const { serializeSrt } = require('../download/captionPublication');
const { parseSubtitleLanguages, isExpandableLanguageCode, isPlainLanguageCode } = require('../download/subtitleLanguages');
const { listOfferedTracks, SOURCES } = require('./captionSources');
const { selectPublishableTracks, preferencesFromConfig, matchesEntry, isSourceAllowed } = require('./captionTrackSelection');
const { planEnrichmentWrites } = require('./enrichmentPlan');
const { resolveRetrySchedule, nextAttemptAt } = require('./enrichmentSchedule');
const { parseWanted } = require('./captionCatalog');
const defaultFiles = require('./captionFiles');
const defaultLease = require('../download/videoPublicationLease');

const TICK_INTERVAL_MS = 5 * 60 * 1000;
const FIRST_TICK_DELAY_MS = 2 * 60 * 1000;
const MAX_JOBS_PER_TICK = 5;
const LEASE_MS = 15 * 60 * 1000;
const BUSY_RETRY_MS = 15 * 60 * 1000;
const BUSY_POLL_MS = 1000;
const THROTTLE_PAUSE_MS = 60 * 60 * 1000;
const DEFAULT_MIN_INTERVAL_SECONDS = 60;
const MIN_INTERVAL_FLOOR_SECONDS = 10;
const DURATION_TOLERANCE_MS = 1000;
const LIVE_STATUSES = new Set(['is_live', 'was_live', 'post_live']);

const REASON_TEXT = {
  'not-offered': (language) => `YouTube offers no ${language} captions`,
  'automatic-not-allowed': (language) => `only automatic ${language} captions exist, and the caption source setting allows uploaded captions only`,
  'translation-only': (language) => `only machine-translated ${language} captions exist; allow machine translations to use them`,
  'not-downloaded': (language) => `YouTube lists ${language} captions but they could not be fetched`,
  'awaiting-uploaded': (language) => `no uploaded ${language} captions appeared; the automatic captions stay`,
};

function describeReasons(items) {
  return items.map((item) => (REASON_TEXT[item.reason] || ((language) => `${language} captions are unavailable`))(item.language)).join('; ');
}

class CaptionEnrichment {
  constructor({ store, catalog, configModule, fetcher, probeDuration, isBusy, files = defaultFiles, lease = defaultLease,
    busyPollMs = BUSY_POLL_MS, now = () => new Date(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
    Object.assign(this, { store, catalog, configModule, fetcher, probeDuration, isBusy, files, lease, busyPollMs, now, sleep });
    this.ticking = false;
    this.lastFetchAt = 0;
    this.pausedUntil = 0;
    this.timer = null;
    this.firstTick = null;
  }

  config() {
    return this.configModule.getConfig() || {};
  }

  minIntervalMs() {
    const seconds = Number(this.config().captionEnrichmentMinIntervalSeconds);
    const value = Number.isFinite(seconds) ? seconds : DEFAULT_MIN_INTERVAL_SECONDS;
    return Math.max(MIN_INTERVAL_FLOOR_SECONDS, value) * 1000;
  }

  async start() {
    try {
      const recovered = await this.store.recoverExpiredLeases(this.now(), { all: true });
      if (recovered) logger.info({ recovered }, 'Returned interrupted caption checks to the queue');
    } catch (err) {
      logger.warn({ err }, 'Could not recover interrupted caption checks');
    }
    const run = () => this.tick().catch((err) => logger.error({ err }, 'Caption check tick failed'));
    this.firstTick = setTimeout(run, FIRST_TICK_DELAY_MS);
    this.firstTick.unref();
    this.timer = setInterval(run, TICK_INTERVAL_MS);
    this.timer.unref();
  }

  stop() {
    clearTimeout(this.firstTick);
    clearInterval(this.timer);
    this.firstTick = null;
    this.timer = null;
  }

  /** One pass over due checks. Never overlaps itself. */
  async tick() {
    if (this.ticking) return { status: 'skipped', reason: 'running' };
    const config = this.config();
    if (config.captionEnrichmentEnabled !== true || !config.subtitlesEnabled) return { status: 'skipped', reason: 'disabled' };
    if (this.now().getTime() < this.pausedUntil) return { status: 'skipped', reason: 'throttled' };
    this.ticking = true;
    const outcomes = [];
    try {
      const now = this.now();
      await this.store.recoverExpiredLeases(now);
      const jobs = await this.store.claimDueJobs({ now, limit: MAX_JOBS_PER_TICK, leaseUntil: new Date(now.getTime() + LEASE_MS) });
      for (const job of jobs) {
        if (this.now().getTime() < this.pausedUntil) {
          await this.release(job, job.next_attempt_at);
          outcomes.push('released');
          continue;
        }
        try {
          outcomes.push(await this.attempt(job));
        } catch (err) {
          logger.error({ err, youtubeId: job.youtube_id }, 'Caption check failed unexpectedly');
          await this.release(job, new Date(this.now().getTime() + BUSY_RETRY_MS)).catch(() => {});
          outcomes.push('error');
        }
      }
    } finally {
      this.ticking = false;
    }
    return { status: 'success', outcomes };
  }

  async waitForRateLimit() {
    const wait = this.lastFetchAt + this.minIntervalMs() - this.now().getTime();
    if (wait > 0) await this.sleep(wait);
    this.lastFetchAt = this.now().getTime();
  }

  deferForDownload(job) {
    return this.release(job, new Date(this.now().getTime() + BUSY_RETRY_MS));
  }

  release(job, nextAttemptAtValue) {
    return this.store.saveJob(job.youtube_id, { status: 'pending', lease_until: null, next_attempt_at: nextAttemptAtValue });
  }

  finish(job, status, reason, extra = {}) {
    return this.store.saveJob(job.youtube_id, { status, reason, lease_until: null, next_attempt_at: null, ...extra });
  }

  // Languages of the check still uncovered on disk now, by tracks the
  // preferences allow (the same rule as assessCoverage).
  stillWanted(wanted, onDisk) {
    const preferences = preferencesFromConfig(this.config());
    return wanted.filter((item) => {
      const present = onDisk.filter((track) => matchesEntry(item.language, track.code) && isSourceAllowed(preferences, track.source));
      if (item.reason === 'awaiting-uploaded') return !present.some((track) => track.source === SOURCES.UPLOADED);
      return present.length === 0;
    });
  }

  /** @returns {Promise<string>} outcome */
  async attempt(job) {
    const youtubeId = job.youtube_id;
    const video = await this.store.getVideo(youtubeId);
    if (!video || video.removed || !video.filePath || /\.mp3$/i.test(video.filePath)) {
      await this.finish(job, 'blocked', 'The video is no longer stored with a video file, so there is nothing to add captions to.');
      return 'blocked';
    }
    if (this.isBusy(youtubeId)) {
      await this.deferForDownload(job);
      return 'deferred';
    }
    const revision = await this.files.mediaRevision(video.filePath);
    if (!revision) {
      await this.finish(job, 'blocked', 'The video file was not found. Run a library rescan, then use "Check again".');
      return 'blocked';
    }
    if (job.media_revision && revision !== job.media_revision) {
      await this.finish(job, 'blocked', 'The video file changed after this check was scheduled. Use "Check again" to check against the current file.');
      return 'blocked';
    }
    const cachedInfo = await this.catalog.readInfo(youtubeId);
    const wanted = this.stillWanted(parseWanted(job), await this.catalog.describeOnDisk(video, cachedInfo));
    if (!wanted.length) {
      await this.finish(job, 'completed', null, { wanted: JSON.stringify([]) });
      return 'completed';
    }

    const outputDir = await fs.mkdtemp(path.join(await this.workRoot(), `${youtubeId}-`));
    try {
      await this.waitForRateLimit();
      // A download may have started during the awaits above; nothing may be
      // awaited between this check and the request.
      if (this.isBusy(youtubeId)) {
        await this.deferForDownload(job);
        return 'deferred';
      }
      let fetched;
      const controller = new AbortController();
      const watch = setInterval(() => {
        if (this.isBusy(youtubeId)) controller.abort();
      }, this.busyPollMs);
      if (watch.unref) watch.unref();
      try {
        fetched = await this.fetcher.fetchCaptions({
          youtubeId, languages: wanted.map((item) => item.language), outputDir, signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted || (err && err.kind === 'aborted')) {
          logger.info({ youtubeId }, 'A download started; stopped the caption check and returned it to the queue');
          await this.deferForDownload(job);
          return 'deferred';
        }
        return await this.handleFetchError(job, err);
      } finally {
        clearInterval(watch);
      }
      const timelineProblem = await this.checkTimeline(video.filePath, fetched.info);
      if (timelineProblem) {
        await this.finish(job, 'blocked', timelineProblem, { attempts: job.attempts + 1, last_attempt_at: this.now() });
        return 'blocked';
      }
      const published = await this.lease.withLease(youtubeId, () => this.publish({ job, video, revision, wanted, fetched }));
      if (published === 'busy') {
        await this.deferForDownload(job);
        return 'deferred';
      }
      if (published === 'revision-changed') {
        await this.finish(job, 'blocked', 'The video file changed during the check. Use "Check again" to check against the current file.');
        return 'blocked';
      }
      return await this.conclude({ job, video, wanted, info: fetched.info });
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // Private per-attempt folders, outside the media root, removed afterwards.
  async workRoot() {
    const root = path.join(this.configModule.getJobsPath(), 'caption-checks');
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    return root;
  }

  async handleFetchError(job, err) {
    if (err && err.kind === 'throttled') {
      this.pausedUntil = this.now().getTime() + THROTTLE_PAUSE_MS;
      logger.warn({ youtubeId: job.youtube_id }, 'YouTube is limiting requests; pausing caption checks for an hour');
      await this.release(job, job.next_attempt_at);
      return 'throttled';
    }
    if (err && err.kind === 'unavailable') {
      await this.finish(job, 'blocked', `YouTube no longer serves this video (${err.message}).`, {
        attempts: job.attempts + 1, last_attempt_at: this.now(),
      });
      return 'blocked';
    }
    logger.warn({ youtubeId: job.youtube_id, reason: err && err.message }, 'Caption check request failed');
    return this.scheduleNext(job, null, `The last check failed: ${(err && err.message) || 'unknown error'}.`);
  }

  async checkTimeline(mediaPath, info) {
    const probed = await this.probeDuration(mediaPath);
    if (!Number.isFinite(info?.duration) || !Number.isFinite(probed)) {
      return 'The length of the stored video or of the YouTube source is unknown, so caption timing cannot be verified.';
    }
    const difference = Math.round(Math.abs(probed - info.duration) * 1000);
    if (difference <= DURATION_TOLERANCE_MS) return null;
    return `The stored video is ${(difference / 1000).toFixed(1)} s ${probed < info.duration ? 'shorter' : 'longer'} than the YouTube source (for example after SponsorBlock removal), so YouTube captions would be out of sync. Captions are not added to this file.`;
  }

  prepareBytes(raw, source) {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    if (source === SOURCES.AUTOMATIC) {
      const result = normalizeCaptionTrack({ rawTrack: text, format: 'srt', provenance: 'automatic' });
      const serialized = serializeSrt(result.cues);
      normalizeCaptionTrack({ rawTrack: serialized, format: 'srt', provenance: 'unknown' });
      return { bytes: Buffer.from(serialized, 'utf8'), normalizerVersion: result.normalizerVersion };
    }
    normalizeCaptionTrack({ rawTrack: text, format: 'srt', provenance: 'unknown' });
    return { bytes: raw, normalizerVersion: null };
  }

  verbatimCodes() {
    return parseSubtitleLanguages(this.config().subtitleLanguage)
      .filter((entry) => isPlainLanguageCode(entry) && !isExpandableLanguageCode(entry))
      .map((entry) => entry.toLowerCase());
  }

  /**
   * Re-validate one write immediately before it happens (the caller holds the
   * lease): `busy` and `revision-changed` stop the publication, `protected`
   * and `listed-verbatim` skip only this track, null allows the write.
   */
  async guardWrite({ youtubeId, video, revision, code, replacesExisting }) {
    if (this.isBusy(youtubeId)) return 'busy';
    if ((await this.files.mediaRevision(video.filePath)) !== revision) return 'revision-changed';
    const row = (await this.store.listTracks(youtubeId)).find((track) => track.track_code === code);
    if (row && row.protected) return 'protected';
    if (replacesExisting && this.verbatimCodes().includes(code.toLowerCase())) return 'listed-verbatim';
    // Nothing is awaited between this check and the caller's write.
    if (this.isBusy(youtubeId)) return 'busy';
    return null;
  }

  /** @returns {Promise<'ok'|'busy'|'revision-changed'>} */
  async publish({ job, video, revision, wanted, fetched }) {
    const youtubeId = job.youtube_id;
    const preferences = preferencesFromConfig(this.config());
    const selection = selectPublishableTracks({ preferences, offered: listOfferedTracks(fetched.info) });
    const onDisk = await this.catalog.describeOnDisk(video, fetched.info);
    const plan = planEnrichmentWrites({
      selected: selection.tracks,
      languages: wanted.map((item) => item.language),
      fetchedCodes: new Set(fetched.captions.keys()),
      onDisk,
      currentRevision: revision,
      verbatimCodes: this.verbatimCodes(),
    });
    const backupRoot = path.join(this.configModule.getJobsPath(), 'caption-originals');
    const mediaRoot = this.configModule.directoryPath;
    const publishedCodes = new Set();
    for (const install of plan.installs) {
      const raw = await fs.readFile(fetched.captions.get(install.code));
      let prepared;
      try {
        prepared = this.prepareBytes(raw, install.source);
      } catch (err) {
        logger.warn({ err, youtubeId, code: install.code }, 'Fetched caption failed validation; not published');
        continue;
      }
      const blocked = await this.guardWrite({ youtubeId, video, revision, code: install.code, replacesExisting: Boolean(install.replaces) });
      if (blocked === 'busy' || blocked === 'revision-changed') return blocked;
      if (blocked) {
        logger.info({ youtubeId, code: install.code, reason: blocked }, 'Caption changed since the check was planned; not replaced');
        continue;
      }
      const targetPath = this.files.sidecarPath(video.filePath, install.code);
      const result = await this.files.installCaption({
        targetPath, bytes: prepared.bytes, backupRoot, mediaRoot,
        beforeMutation: () => this.guardWrite({ youtubeId, video, revision, code: install.code, replacesExisting: Boolean(install.replaces) }),
      });
      if (result.blocked === 'busy' || result.blocked === 'revision-changed') return result.blocked;
      if (result.blocked) continue;
      const { backupPath, resultSha256 } = result;
      await this.store.saveTrack({
        youtube_id: youtubeId,
        track_code: install.code,
        language: install.code.split('-')[0].toLowerCase(),
        source: install.source,
        origin: 'enrichment',
        file_path: targetPath,
        media_revision: revision,
        source_sha256: this.files.sha256(raw),
        result_sha256: resultSha256,
        normalizer_version: prepared.normalizerVersion,
        retrieved_at: this.now(),
        protected: false,
      });
      publishedCodes.add(install.code);
      logger.info({ youtubeId, code: install.code, source: install.source, backupPath }, 'Published delayed caption');
    }
    for (const retire of plan.retires) {
      // Only a published replacement supersedes a track; otherwise it stays.
      const supersededBy = retire.supersededBy.filter((code) => publishedCodes.has(code));
      if (!supersededBy.length) continue;
      const blocked = await this.guardWrite({ youtubeId, video, revision, code: retire.code, replacesExisting: true });
      if (blocked === 'busy' || blocked === 'revision-changed') return blocked;
      if (blocked) continue;
      const result = await this.files.retireCaption({
        targetPath: this.files.sidecarPath(video.filePath, retire.code), backupRoot, mediaRoot,
        beforeMutation: () => this.guardWrite({ youtubeId, video, revision, code: retire.code, replacesExisting: true }),
      });
      if (result.blocked === 'busy' || result.blocked === 'revision-changed') return result.blocked;
      if (result.blocked) continue;
      const { backupPath } = result;
      await this.store.deleteTracks(youtubeId, [retire.code]);
      logger.info({ youtubeId, code: retire.code, supersededBy, backupPath }, 'Retired caption superseded by an uploaded track');
    }
    return 'ok';
  }

  async conclude({ job, video, wanted, info }) {
    const onDisk = await this.catalog.describeOnDisk(video, null);
    const remaining = this.stillWanted(wanted, onDisk);
    // A broadcast's uploaded captions often follow its automatic ones, so a
    // language an automatic track now covers keeps being checked.
    if (LIVE_STATUSES.has(info?.live_status) || info?.was_live === true) {
      for (const item of wanted) {
        if (remaining.some((entry) => entry.language === item.language)) continue;
        const present = onDisk.filter((track) => matchesEntry(item.language, track.code));
        if (!present.some((track) => track.source === SOURCES.UPLOADED)) remaining.push({ language: item.language, reason: 'awaiting-uploaded' });
      }
    }
    const offered = listOfferedTracks(info);
    if (!remaining.length) {
      await this.finish(job, 'completed', null, { attempts: job.attempts + 1, last_attempt_at: this.now(), wanted: JSON.stringify([]) });
      return 'completed';
    }
    // Refresh each language's reason from what YouTube offers now.
    const selection = selectPublishableTracks({ preferences: preferencesFromConfig(this.config()), offered });
    const reasons = remaining.map((item) => {
      if (item.reason === 'awaiting-uploaded') return item;
      const current = selection.missing.find((missing) => missing.language === item.language);
      return { language: item.language, reason: current ? current.reason : 'not-downloaded' };
    });
    return this.scheduleNext(job, reasons, null);
  }

  async scheduleNext(job, wanted, failureReason) {
    const attempts = job.attempts + 1;
    const now = this.now();
    const offsetsMs = resolveRetrySchedule(this.config().captionEnrichmentRetrySchedule);
    const remainingWanted = wanted || parseWanted(job);
    const limit = Math.max(job.max_attempts, 1);
    const next = attempts >= limit ? null : nextAttemptAt({
      baseline: new Date(job.baseline_at), attempts, offsetsMs, now, lastAttemptAt: now,
    });
    const fields = { attempts, last_attempt_at: now, lease_until: null, wanted: JSON.stringify(remainingWanted) };
    if (!next) {
      const why = failureReason || `${describeReasons(remainingWanted)}.`;
      await this.store.saveJob(job.youtube_id, {
        ...fields,
        status: 'exhausted',
        next_attempt_at: null,
        reason: `Stopped after ${attempts} check${attempts === 1 ? '' : 's'}: ${why} Use "Check again" to look once more, or adjust the caption preferences.`,
      });
      return 'exhausted';
    }
    await this.store.saveJob(job.youtube_id, {
      ...fields,
      status: 'pending',
      next_attempt_at: next,
      reason: failureReason || `Still waiting: ${describeReasons(remainingWanted)}.`,
    });
    return 'rescheduled';
  }
}

module.exports = { CaptionEnrichment, MAX_JOBS_PER_TICK, THROTTLE_PAUSE_MS };
