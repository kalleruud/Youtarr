// Acquisition health (issue #18): the facade the download pipeline, restart
// recovery, routes and server wiring use. Records stage outcomes, explains a
// video's state, runs per-step retries, and hands post-download work to the
// targeted library refresh and the rate-limited notifier. Recording is
// best-effort everywhere: health bookkeeping never fails a download.
const logger = require('../../logger');
const Video = require('../../models/video');
const ChannelVideo = require('../../models/channelvideo');
const JobVideoDownload = require('../../models/jobvideodownload');
const storageGuard = require('../storageGuard');
const videoActivity = require('../download/videoActivity');
const acquisitionPolicyService = require('../acquisition/acquisitionPolicyService');
const { removalState } = require('../videoRemovalState');
const outcomeStore = require('./outcomeStore');
const libraryRefresh = require('./libraryRefresh');
const healthNotifier = require('./healthNotifier');
const healthSummary = require('./healthSummary');
const { classifyAcquisitionFailure } = require('./outcomeClassifier');
const { explainVideo, policyRevisionOf } = require('./videoHealthExplainer');
const { STAGES, STATUSES, CATEGORIES, YOUTUBE_ID_PATTERN } = require('./constants');

// Policy revisions are looked up per failed video; past this many in one job
// the rest are recorded without one rather than costing a query each.
const MAX_POLICY_LOOKUPS_PER_JOB = 50;
const RETRY_STAGES = Object.freeze([STAGES.ACQUISITION, STAGES.LIBRARY]);

class HealthError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function watchUrl(youtubeId) {
  return `https://www.youtube.com/watch?v=${youtubeId}`;
}

class HealthModule {
  constructor() {
    this.notificationsEnabled = false;
  }

  /** Only the server process sends alerts (the post-processor only records). */
  enableNotifications() {
    this.notificationsEnabled = true;
  }

  async _policyRevision(youtubeId) {
    try {
      return policyRevisionOf(await acquisitionPolicyService.getVideo(youtubeId));
    } catch {
      return null;
    }
  }

  /**
   * Download finalizer: one acquisition outcome per video of the run.
   * Never throws.
   */
  async recordAcquisitionResults({ jobId, succeeded = [], failed = [], wasTerminated = false } = {}) {
    try {
      for (const video of succeeded) {
        if (!video || !YOUTUBE_ID_PATTERN.test(String(video.youtubeId || ''))) continue;
        await outcomeStore.record({
          youtubeId: video.youtubeId, stage: STAGES.ACQUISITION, status: STATUSES.OK, category: CATEGORIES.OK,
          reasonCode: 'downloaded', message: 'Downloaded.', retryable: false, jobId,
        });
      }
      let lookups = 0;
      for (const video of failed) {
        if (!video || !YOUTUBE_ID_PATTERN.test(String(video.youtubeId || ''))) continue;
        const outcome = classifyAcquisitionFailure(video, { wasTerminated });
        const policyRevision = lookups < MAX_POLICY_LOOKUPS_PER_JOB ? await this._policyRevision(video.youtubeId) : null;
        lookups += 1;
        await outcomeStore.record({
          youtubeId: video.youtubeId, stage: STAGES.ACQUISITION, ...outcome, jobId, policyRevision,
          details: video.diagnosisKey ? { diagnosisKey: video.diagnosisKey } : null,
        });
      }
    } catch (err) {
      logger.warn({ err, jobId }, 'Could not record acquisition health outcomes');
    }
  }

  /**
   * Restart recovery: the leases (JobVideoDownload rows) a restart left
   * unfinished become retryable `abandoned` acquisition outcomes.
   * @param {Array<{jobId: string, jobType: string, youtubeIds: string[]}>} jobs
   */
  async recordAbandoned(jobs = []) {
    let videoCount = 0;
    try {
      for (const job of jobs) {
        for (const youtubeId of job.youtubeIds || []) {
          // A video that is on disk anyway (an earlier download) was not lost.
          const video = await Video.findOne({ where: { youtubeId }, raw: true });
          if (video && removalState(video) === 'present') continue;
          const stored = await outcomeStore.record({
            youtubeId, stage: STAGES.ACQUISITION, status: STATUSES.FAILED, category: CATEGORIES.ABANDONED,
            reasonCode: 'restart-abandoned',
            message: `A server restart interrupted this download (job "${job.jobType || 'download'}"). Its partial files were cleaned up; retry to download it again.`,
            retryable: true, jobId: job.jobId,
          });
          if (stored) videoCount += 1;
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Could not record abandoned downloads');
    }
    if (jobs.length) {
      logger.warn({ jobCount: jobs.length, videoCount }, 'Restart recovery abandoned download jobs');
      if (this.notificationsEnabled) healthNotifier.reportAbandoned({ jobCount: jobs.length, videoCount });
    }
    return { jobCount: jobs.length, videoCount };
  }

  /**
   * After a download job: alert on problems the post-processor recorded and
   * confirm TV-published episodes in Jellyfin. Never rejects.
   */
  async afterDownloadCompleted(youtubeIds = []) {
    const ids = youtubeIds.filter((id) => YOUTUBE_ID_PATTERN.test(String(id)));
    if (!ids.length) return;
    try {
      if (this.notificationsEnabled) {
        for (const stage of [STAGES.CAPTIONS, STAGES.PUBLICATION]) {
          healthNotifier.report([...(await outcomeStore.getStageForVideos(ids, stage)).values()]);
        }
      }
      await libraryRefresh.enqueue(ids);
      if (this.notificationsEnabled) {
        healthNotifier.report([...(await outcomeStore.getStageForVideos(ids, STAGES.LIBRARY)).values()]);
      }
    } catch (err) {
      logger.warn({ err }, 'Post-download health checks failed');
    }
  }

  /** Everything known about one video, with a plain-language explanation. */
  async explainVideo(youtubeId) {
    if (!YOUTUBE_ID_PATTERN.test(String(youtubeId || ''))) {
      throw new HealthError(400, 'invalid-id', 'A YouTube video id has 11 letters, digits, - or _.');
    }
    const [video, listing, outcomes] = await Promise.all([
      Video.findOne({ where: { youtubeId }, raw: true }),
      ChannelVideo.findOne({ where: { youtube_id: youtubeId }, raw: true }),
      outcomeStore.getForVideo(youtubeId),
    ]);
    let policy = null;
    try {
      policy = await acquisitionPolicyService.getVideo(youtubeId);
    } catch (err) {
      if (err.status !== 404) logger.warn({ err, youtubeId }, 'Could not resolve the acquisition policy for the health view');
    }
    const explanation = explainVideo({
      video,
      listing,
      outcomes,
      policy,
      storage: storageGuard.getStatus(),
      active: videoActivity.isActive(youtubeId),
      removalState: video ? removalState(video) : null,
    });
    return { youtubeId, title: (video && video.youTubeVideoName) || (listing && listing.title) || null, explanation, outcomes };
  }

  /**
   * Retry one step. `revision` is the outcome revision the caller saw: it is
   * the idempotency key, so a repeated or stale request is refused (409).
   * @param {object} deps - { downloadModule } (injected by the route)
   */
  async retryStep({ youtubeId, stage, revision }, { downloadModule } = {}) {
    if (!YOUTUBE_ID_PATTERN.test(String(youtubeId || ''))) throw new HealthError(400, 'invalid-id', 'Invalid YouTube video id.');
    if (stage === STAGES.CAPTIONS || stage === STAGES.PUBLICATION) {
      throw new HealthError(422, 'not-retryable-step',
        stage === STAGES.CAPTIONS
          ? 'Captions cannot be retried on their own here; caption repair for existing downloads is a separate feature. The downloaded caption track is kept.'
          : 'Publication runs as part of the download; retry the acquisition step instead.');
    }
    if (!RETRY_STAGES.includes(stage)) throw new HealthError(400, 'invalid-stage', `stage must be one of: ${RETRY_STAGES.join(', ')}.`);
    if (!Number.isInteger(revision) || revision < 1) throw new HealthError(400, 'invalid-revision', 'revision must be the outcome revision you are retrying.');

    if (stage === STAGES.ACQUISITION) await this._assertAcquisitionRetryAllowed(youtubeId);

    if (stage === STAGES.LIBRARY && !libraryRefresh.canAccept(youtubeId)) {
      throw new HealthError(503, 'refresh-capacity', 'Targeted refresh capacity is full; retry the library step later.');
    }
    const claimed = await outcomeStore.claimRetry({ youtubeId, stage, expectedRevision: revision });
    if (!claimed) {
      throw new HealthError(409, 'stale-or-duplicate',
        'This step changed since you loaded it, is not retryable, or a retry was already requested. Refresh to see its current state.');
    }

    if (stage === STAGES.LIBRARY) {
      const completion = libraryRefresh.enqueue([youtubeId]);
      if (completion.accepted === false) {
        await outcomeStore.record({
          youtubeId, stage, expectedRevision: claimed.revision,
          status: STATUSES.PENDING, category: CATEGORIES.SCAN_PENDING,
          reasonCode: 'refresh-deferred', retryable: true, details: claimed.details,
          message: 'Targeted refresh capacity is full; retry the library step later.',
        });
        throw new HealthError(503, 'refresh-capacity', 'Targeted refresh capacity is full; retry the library step later.');
      }
      completion.catch(() => {});
      return { outcome: claimed, queued: true };
    }

    if (!downloadModule) throw new HealthError(503, 'unavailable', 'Downloads are not available right now.');
    try {
      const admission = await downloadModule.doSpecificDownloads({ body: { urls: [watchUrl(youtubeId)], overrideSettings: { allowRedownload: true } } });
      if (admission && Array.isArray(admission.alreadyActiveIds) && admission.alreadyActiveIds.includes(youtubeId)) {
        throw new HealthError(409, 'in-progress', 'This video is already queued or downloading.');
      }
    } catch (err) {
      await outcomeStore.record({
        youtubeId, stage, expectedRevision: claimed.revision, status: STATUSES.FAILED, category: claimed.category, reasonCode: 'retry-not-queued',
        message: `The retry could not be queued: ${err.message}`, retryable: true, details: claimed.details,
      });
      if (err instanceof HealthError) throw err;
      if (storageGuard.isPausedError(err)) throw new HealthError(409, 'downloads-paused', storageGuard.describe(err.status));
      throw err;
    }
    return { outcome: await outcomeStore.getOne(youtubeId, stage), queued: true };
  }

  async _assertAcquisitionRetryAllowed(youtubeId) {
    const video = await Video.findOne({ where: { youtubeId }, raw: true });
    if (video && removalState(video) === 'present') {
      throw new HealthError(409, 'already-downloaded', 'This video is already downloaded.');
    }
    // Existing leases: an active claim in this process or a download still
    // tracked as in progress means a retry would duplicate it.
    const lease = videoActivity.isActive(youtubeId)
      || await JobVideoDownload.count({ where: { youtube_id: youtubeId, status: 'in_progress' } }) > 0;
    if (lease) throw new HealthError(409, 'in-progress', 'This video is already queued or downloading.');
    const storage = await storageGuard.refresh();
    if (storage.paused) {
      const hints = storage.reasons.map((r) => r.resumeHint).filter(Boolean).join(' ');
      throw new HealthError(409, 'downloads-paused', `${storageGuard.describe(storage)}. ${hints}`.trim());
    }
  }

  getSummary() {
    return healthSummary.build();
  }

  listOutcomes(filters) {
    return outcomeStore.list(filters);
  }
}

const healthModule = new HealthModule();
healthModule.HealthError = HealthError;
healthModule.RETRY_STAGES = RETRY_STAGES;
module.exports = healthModule;
