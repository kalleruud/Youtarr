// Health outcomes written by the yt-dlp post-processor (a separate,
// short-lived process): captions, publication into the library, and a
// pending library check for TV-published episodes that the server process
// confirms after the job (libraryRefresh). Every call is best-effort and
// returns quietly: a recording problem never changes a download's result,
// and nothing here sends notifications.
const path = require('path');
const outcomeStore = require('./outcomeStore');
const { classifyCaptionResults, classifyFilesystemError } = require('./outcomeClassifier');
const { STAGES, STATUSES, CATEGORIES } = require('./constants');

async function recordCaptions({ youtubeId, jobId, results, subtitlesRequested }) {
  const outcome = classifyCaptionResults({ results, subtitlesRequested });
  if (!outcome) return null;
  return outcomeStore.record({ youtubeId, stage: STAGES.CAPTIONS, jobId, ...outcome });
}

/**
 * The media reached its library location. For a TV episode, also leave a
 * pending library check carrying the show folder and file the server
 * process will look for in Jellyfin.
 */
async function recordPublished({ youtubeId, jobId, mediaPath, tvPlan = null }) {
  const details = tvPlan
    ? { layout: 'jellyfinTv', showDir: tvPlan.showDir, mediaPath, season: tvPlan.season, episode: tvPlan.episode }
    : { layout: 'movie', mediaPath };
  const published = await outcomeStore.record({
    youtubeId, stage: STAGES.PUBLICATION, status: STATUSES.OK, category: CATEGORIES.OK, jobId,
    reasonCode: tvPlan ? 'published-tv-episode' : 'published',
    message: tvPlan
      ? `Published as S${tvPlan.season}E${String(tvPlan.episode).padStart(3, '0')} in ${path.basename(tvPlan.showDir)}.`
      : `Moved into the library as ${path.basename(mediaPath)}.`,
    retryable: false, details,
  });
  if (!tvPlan) return published;
  await outcomeStore.record({
    youtubeId, stage: STAGES.LIBRARY, status: STATUSES.PENDING, category: CATEGORIES.SCAN_PENDING, jobId,
    reasonCode: 'awaiting-library-check', message: 'Waiting to confirm that Jellyfin lists this episode.',
    retryable: true, details,
  });
  return published;
}

/** The move into the library failed; the files stay in the temp folder. */
async function recordPublicationFailure({ youtubeId, jobId, error, targetPath }) {
  const { category, reasonCode } = classifyFilesystemError(error);
  const hint = category === CATEGORIES.PERMISSION_PATH
    ? 'Check that the library folder exists and is writable by Youtarr (YOUTARR_UID/GID), then retry the download.'
    : 'Retry the download once the cause is fixed.';
  return outcomeStore.record({
    youtubeId, stage: STAGES.PUBLICATION, status: STATUSES.FAILED, category, reasonCode, jobId,
    message: `Could not move the download into the library (${(error && (error.code || error.message)) || 'unknown error'}). ${hint}`,
    // Publication only runs inside a download, so the acquisition step is
    // the one to retry; this record itself is not retried.
    retryable: false,
    details: { targetPath: targetPath || null },
  });
}

module.exports = { recordCaptions, recordPublished, recordPublicationFailure };
