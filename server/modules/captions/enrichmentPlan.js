/**
 * What a delayed caption check may write (pure).
 *
 * Only tracks the preferences select, for languages the check was scheduled
 * for, and only when they were fetched. An existing sidecar is replaced only
 * by a better source (uploaded over automatic/translated), never when it is
 * protected or was recorded for a different media revision. An uploaded track
 * under a new code ("en-GB") retires the lower-ranked tracks of its language
 * ("en" automatic), as the post-download pruning does, except protected ones
 * and codes the user listed verbatim.
 */
const { SOURCE_RANK, SOURCES } = require('./captionSources');
const { matchesEntry } = require('./captionTrackSelection');

const SKIP = Object.freeze({
  NOT_FETCHED: 'not-fetched',
  PROTECTED: 'protected',
  OTHER_REVISION: 'recorded-for-other-media-revision',
  COVERED: 'language-already-covered',
});

function rank(source) {
  return SOURCE_RANK[source] ?? 0;
}

/**
 * @param {object} params
 * @param {{language: string, code: string, source: string}[]} params.selected - selection.tracks
 * @param {string[]} params.languages - languages this check is for
 * @param {Set<string>} params.fetchedCodes - codes whose SRT was fetched
 * @param {{code: string, source: string, protected: boolean, mediaRevision: string|null}[]} params.onDisk
 * @param {string} params.currentRevision
 * @param {string[]} [params.verbatimCodes] - codes listed verbatim in the language setting
 * @returns {{installs: object[], retires: object[], skipped: {code: string, reason: string}[]}}
 */
function planEnrichmentWrites({ selected, languages, fetchedCodes, onDisk, currentRevision, verbatimCodes = [] }) {
  const installs = [];
  const retires = [];
  const skipped = [];
  const verbatim = new Set(verbatimCodes.map((code) => code.toLowerCase()));
  const wanted = new Set(languages);
  const isStale = (track) => track.mediaRevision != null && track.mediaRevision !== currentRevision;

  for (const track of selected) {
    if (!wanted.has(track.language)) continue;
    if (!fetchedCodes.has(track.code)) {
      skipped.push({ code: track.code, reason: SKIP.NOT_FETCHED });
      continue;
    }
    const sameCode = onDisk.find((existing) => existing.code === track.code);
    if (sameCode && sameCode.protected) {
      skipped.push({ code: track.code, reason: SKIP.PROTECTED });
      continue;
    }
    if (sameCode && isStale(sameCode)) {
      skipped.push({ code: track.code, reason: SKIP.OTHER_REVISION });
      continue;
    }
    const sameLanguage = onDisk.filter((existing) => matchesEntry(track.language, existing.code));
    if (sameLanguage.some((existing) => rank(existing.source) >= rank(track.source))) {
      skipped.push({ code: track.code, reason: SKIP.COVERED });
      continue;
    }
    installs.push({ ...track, replaces: sameCode ? sameCode.code : null });
    if (track.source !== SOURCES.UPLOADED) continue;
    for (const existing of sameLanguage) {
      if (existing.code === track.code || existing.protected || isStale(existing) ||
          verbatim.has(existing.code.toLowerCase()) || retires.some((retire) => retire.code === existing.code)) continue;
      retires.push({ code: existing.code, supersededBy: track.code });
    }
  }
  const installed = new Set(installs.map((install) => install.code));
  return { installs, retires: retires.filter((retire) => !installed.has(retire.code)), skipped };
}

module.exports = { planEnrichmentWrites, SKIP };
