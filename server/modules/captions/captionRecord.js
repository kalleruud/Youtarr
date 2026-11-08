/**
 * What the download post-processor knows about each caption it published,
 * stored on the cached info.json under CAPTION_RECORD_KEY and read when the
 * download is recorded (pure; loaded by the post-processor, so it must not
 * pull in the database).
 */
const path = require('path');
const { classifyCaptionSource } = require('./captionSources');

const CAPTION_RECORD_KEY = '_youtarr_captions';
const SIDECAR_CODE = /\]\.([A-Za-z0-9-]+)\.srt$/i;
const SHA256 = /^[a-f0-9]{64}$/;

/**
 * @param {object} params
 * @param {string} params.fileName - sidecar name in the temp folder
 * @param {string} params.youtubeId
 * @param {object} params.info - the info.json being finalized
 * @param {object} [params.state] - yt-dlp after_move state (requested_subtitles)
 * @param {object} params.result - publishCaption result (or the skip record)
 * @returns {{code: string|null, source: string, normalization: string, sourceSha256: string|null, normalizerVersion: number|null}}
 */
function describeCaptionRecord({ fileName, youtubeId, info, state, result }) {
  const match = SIDECAR_CODE.exec(fileName || '');
  const code = match ? match[1] : null;
  const requested = code && state && state.id === youtubeId && state.requested_subtitles ? state.requested_subtitles[code] : null;
  const backupHash = result && result.backupPath ? path.basename(result.backupPath, '.srt') : null;
  return {
    code,
    source: code ? classifyCaptionSource({ code, info, requestedUrl: requested && typeof requested.url === 'string' ? requested.url : undefined }) : 'unknown',
    normalization: (result && result.status) || 'skipped',
    sourceSha256: result && result.status === 'published' && SHA256.test(backupHash || '') ? backupHash : null,
    normalizerVersion: result && Number.isInteger(result.normalizerVersion) ? result.normalizerVersion : null,
  };
}

module.exports = { describeCaptionRecord, CAPTION_RECORD_KEY };
