// Pure mapping from what a pipeline step reported to a health outcome
// ({ status, category, reasonCode, message, retryable }). No I/O.
const { STATUSES, CATEGORIES } = require('./constants');

const NOT_PUBLISHED_PATTERN = /premieres? in|live event will begin|this live event|is upcoming|scheduled to start/i;
const SOURCE_GONE_PATTERN = /video unavailable|private video|has been removed|no longer available|account .*terminated|copyright|not available in your country|geo.?restrict|members[- ]only|join this channel|sign in to confirm your age|age.?restricted|inappropriate for some users/i;
const PATH_ERROR_CODES = new Set(['EACCES', 'EPERM', 'EROFS', 'ENOENT', 'ENOTDIR', 'EISDIR', 'EXDEV', 'ENAMETOOLONG', 'ELOOP']);
const STORAGE_ERROR_CODES = new Set(['ENOSPC', 'EDQUOT']);
const PATH_ERROR_PATTERN = /permission denied|read-only file system|no such file or directory|operation not permitted|not a directory/i;
const STORAGE_ERROR_PATTERN = /no space left on device|disk quota exceeded/i;

function outcome(status, category, reasonCode, message, retryable) {
  return { status, category, reasonCode, message, retryable };
}

/**
 * A failed video from the download finalizer (youtubeId, error,
 * diagnosisKey, autoRetryQueued) mapped to an acquisition outcome.
 */
function classifyAcquisitionFailure(video = {}, { wasTerminated = false } = {}) {
  const error = String(video.error || '');
  const key = video.diagnosisKey || '';
  if (video.autoRetryQueued) {
    return outcome(STATUSES.PENDING, CATEGORIES.SOURCE_UNAVAILABLE, 'auto-retry-queued',
      `Download failed and an automatic retry is queued: ${error || 'no error text'}`, false);
  }
  if (key === 'temp-out-of-space' || STORAGE_ERROR_PATTERN.test(error)) {
    return outcome(STATUSES.FAILED, CATEGORIES.STORAGE_LIMIT, key || 'out-of-space',
      'Not enough free space to finish the download. Free up space in the temporary download folder, then retry.', true);
  }
  if (key.startsWith('bot-check') || key.startsWith('http-403')) {
    return outcome(STATUSES.FAILED, CATEGORIES.SOURCE_UNAVAILABLE, key,
      `YouTube refused the download (${key}). See Download History for the suggested fix, then retry.`, true);
  }
  if (NOT_PUBLISHED_PATTERN.test(error)) {
    return outcome(STATUSES.FAILED, CATEGORIES.SOURCE_UNAVAILABLE, 'source-not-ready',
      `The video is not available yet: ${error}`, true);
  }
  if (SOURCE_GONE_PATTERN.test(error)) {
    return outcome(STATUSES.FAILED, CATEGORIES.SOURCE_UNAVAILABLE, 'source-unavailable',
      `YouTube does not offer this video: ${error}`, false);
  }
  if (PATH_ERROR_PATTERN.test(error)) {
    return outcome(STATUSES.FAILED, CATEGORIES.PERMISSION_PATH, 'path-error',
      `A folder could not be written: ${error}`, true);
  }
  if (wasTerminated) {
    return outcome(STATUSES.FAILED, CATEGORIES.ABANDONED, 'job-terminated',
      'The download job was stopped before this video finished.', true);
  }
  return outcome(STATUSES.FAILED, CATEGORIES.APPLICATION_FAILURE, 'download-failed',
    error ? `Download failed: ${error}` : 'Download failed without an error message.', true);
}

/** A filesystem exception (publication, moves) mapped to a category. */
function classifyFilesystemError(err) {
  const code = err && err.code;
  const text = String((err && err.message) || err || '');
  if (STORAGE_ERROR_CODES.has(code) || STORAGE_ERROR_PATTERN.test(text)) {
    return { category: CATEGORIES.STORAGE_LIMIT, reasonCode: code || 'out-of-space', retryable: true };
  }
  if (PATH_ERROR_CODES.has(code) || PATH_ERROR_PATTERN.test(text)) {
    return { category: CATEGORIES.PERMISSION_PATH, reasonCode: code || 'path-error', retryable: true };
  }
  return { category: CATEGORIES.APPLICATION_FAILURE, reasonCode: code || 'publication-failed', retryable: true };
}

/**
 * Caption results of one video's post-processing (publishCaption results
 * plus the file name) mapped to one captions outcome. A caption result never
 * fails the download, so the worst status here is a warning.
 * @param {object} input
 * @param {Array<{file: string, result: object}>} input.results
 * @param {boolean} input.subtitlesRequested - captions were configured
 */
function classifyCaptionResults({ results = [], subtitlesRequested = false } = {}) {
  if (!results.length) {
    if (!subtitlesRequested) return null;
    return {
      ...outcome(STATUSES.SKIPPED, CATEGORIES.NO_CAPTIONS, 'no-captions',
        'YouTube offered no caption track in the configured languages for this video.', false),
      details: { tracks: [] },
    };
  }
  const tracks = results.map(({ file, result = {} }) => ({
    file,
    status: result.status || 'unknown',
    reason: result.reason || null,
    transitionsRemoved: result.diagnostics ? result.diagnostics.transitionsRemoved || 0 : null,
  }));
  const failed = results.find(({ result = {} }) => result.status === 'warning');
  if (failed) {
    const reason = failed.result.error ? `${failed.result.reason}: ${failed.result.error.message || failed.result.error}` : failed.result.reason;
    return {
      ...outcome(STATUSES.WARNING, CATEGORIES.APPLICATION_FAILURE, 'caption-normalization-failed',
        `The downloaded caption ${failed.file} was published unchanged, so rolling captions may repeat lines: ${reason}`, false),
      details: { tracks },
    };
  }
  const skipped = results.find(({ result = {} }) => result.status === 'skipped');
  if (skipped) {
    return {
      ...outcome(STATUSES.WARNING, CATEGORIES.POLICY_EXCLUDED, 'caption-normalization-skipped',
        `The downloaded caption ${skipped.file} was published unchanged, so rolling captions may repeat lines: ${skipped.result.reason}`, false),
      details: { tracks },
    };
  }
  const removed = tracks.reduce((sum, track) => sum + (track.transitionsRemoved || 0), 0);
  return {
    ...outcome(STATUSES.OK, CATEGORIES.OK, removed ? 'caption-normalized' : 'caption-unchanged',
      removed ? `Removed ${removed} repeated caption line${removed === 1 ? '' : 's'} across ${tracks.length} track${tracks.length === 1 ? '' : 's'}.`
        : `${tracks.length} caption track${tracks.length === 1 ? '' : 's'} needed no changes.`, false),
    details: { tracks },
  };
}

module.exports = { classifyAcquisitionFailure, classifyFilesystemError, classifyCaptionResults };
