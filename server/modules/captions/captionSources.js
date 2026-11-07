/**
 * Caption provenance from yt-dlp metadata (pure).
 *
 * YouTube offers creator-uploaded tracks in the info.json `subtitles` object
 * and speech-recognition tracks plus every machine translation in
 * `automatic_captions`. A translation's URL carries a `tlang` parameter; the
 * original recognized track does not (yt-dlp lists it twice, as "<lang>" and
 * "<lang>-orig"). A code alone never establishes authorship: "en-orig" is an
 * automatic track and the same code can be offered as uploaded and automatic.
 */

const SOURCES = Object.freeze({
  UPLOADED: 'uploaded',
  AUTOMATIC: 'automatic',
  TRANSLATED: 'translated',
  GENERATED: 'generated',
  UNKNOWN: 'unknown',
});

// Higher wins when two tracks serve the same language.
const SOURCE_RANK = Object.freeze({ uploaded: 3, automatic: 2, translated: 1, generated: 1, unknown: 0 });

const TRACK_CODE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8}){0,3}$/;

function formatsOf(group, code) {
  if (!group || typeof group !== 'object' || !Object.prototype.hasOwnProperty.call(group, code)) return null;
  return Array.isArray(group[code]) ? group[code] : null;
}

function isTranslationFormat(format) {
  if (!format || typeof format.url !== 'string') return false;
  try {
    return new URL(format.url).searchParams.has('tlang');
  } catch {
    return false;
  }
}

function automaticKind(formats) {
  return formats.length > 0 && formats.every(isTranslationFormat) ? SOURCES.TRANSLATED : SOURCES.AUTOMATIC;
}

/**
 * Classify one track code against the metadata it was fetched with.
 * @param {object} params
 * @param {string} params.code - Track code as in the sidecar name ("en-GB")
 * @param {object} params.info - yt-dlp info dict (subtitles, automatic_captions, requested_subtitles)
 * @param {string} [params.requestedUrl] - URL yt-dlp actually fetched, when known
 * @returns {'uploaded'|'automatic'|'translated'|'unknown'}
 */
function classifyCaptionSource({ code, info, requestedUrl }) {
  if (!info || typeof code !== 'string' || !TRACK_CODE.test(code)) return SOURCES.UNKNOWN;
  const uploaded = formatsOf(info.subtitles, code);
  const automatic = formatsOf(info.automatic_captions, code);
  const requested = info.requested_subtitles && typeof info.requested_subtitles === 'object'
    && Object.prototype.hasOwnProperty.call(info.requested_subtitles, code) ? info.requested_subtitles[code] : null;
  const url = requestedUrl || (requested && typeof requested.url === 'string' ? requested.url : null);
  if (url) {
    if (uploaded && uploaded.some((format) => format && format.url === url)) return SOURCES.UPLOADED;
    const match = automatic && automatic.find((format) => format && format.url === url);
    if (match) return isTranslationFormat(match) ? SOURCES.TRANSLATED : SOURCES.AUTOMATIC;
  }
  if (uploaded && !automatic) return SOURCES.UPLOADED;
  if (automatic && !uploaded) return automaticKind(automatic);
  return SOURCES.UNKNOWN;
}

/**
 * Every track YouTube offers for a video, one entry per (code, source).
 * @param {object} info - yt-dlp info dict
 * @returns {{code: string, source: string}[]}
 */
function listOfferedTracks(info) {
  if (!info) return [];
  const offered = [];
  for (const code of Object.keys(info.subtitles || {})) {
    if (TRACK_CODE.test(code) && formatsOf(info.subtitles, code)) offered.push({ code, source: SOURCES.UPLOADED });
  }
  for (const code of Object.keys(info.automatic_captions || {})) {
    const formats = formatsOf(info.automatic_captions, code);
    if (TRACK_CODE.test(code) && formats) offered.push({ code, source: automaticKind(formats) });
  }
  return offered;
}

module.exports = { SOURCES, SOURCE_RANK, TRACK_CODE, classifyCaptionSource, listOfferedTracks };
