/**
 * Which caption tracks a video should publish under the caption preferences,
 * and why a configured language has none (pure).
 *
 * Per configured language: every uploaded track (regional variants are
 * preserved, as the post-download pruning keeps them), otherwise one
 * automatic track, otherwise, when allowed, one machine translation. A bare
 * code ("en", "no") matches its regional/script variants and aliases; any
 * other plain code ("pt-BR", "en-orig") matches only itself. Aliases,
 * exclusions and regexes in the language list cannot be evaluated here and
 * are reported as `unsupported`.
 */
const {
  parseSubtitleLanguages,
  isExpandableLanguageCode,
  isPlainLanguageCode,
  languageFamily,
} = require('../download/subtitleLanguages');
const { SOURCES, SOURCE_RANK } = require('./captionSources');

const SOURCE_POLICIES = Object.freeze(['uploaded-then-automatic', 'uploaded-only']);
const DEFAULT_SOURCE_POLICY = SOURCE_POLICIES[0];

const MISSING_REASONS = Object.freeze({
  NOT_OFFERED: 'not-offered',
  AUTOMATIC_NOT_ALLOWED: 'automatic-not-allowed',
  TRANSLATION_ONLY: 'translation-only',
  // Offered when last checked, but no sidecar is on disk.
  NOT_DOWNLOADED: 'not-downloaded',
});

function baseLanguage(code) {
  return code.split('-')[0].toLowerCase();
}

function parseVariantList(value) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => isPlainLanguageCode(entry));
}

/**
 * Caption preferences from a config object (saved or proposed).
 * @param {object} config
 * @returns {{subtitleLanguage: string, sourcePolicy: string, allowTranslated: boolean, preferredVariants: string[]}}
 */
function preferencesFromConfig(config = {}) {
  return {
    subtitleLanguage: config.subtitleLanguage,
    sourcePolicy: SOURCE_POLICIES.includes(config.captionSourcePolicy) ? config.captionSourcePolicy : DEFAULT_SOURCE_POLICY,
    allowTranslated: config.captionAllowTranslated === true,
    preferredVariants: parseVariantList(config.captionPreferredVariants),
  };
}

function matchesEntry(entry, code) {
  if (isExpandableLanguageCode(entry)) {
    return languageFamily(entry).map((member) => member.toLowerCase()).includes(baseLanguage(code));
  }
  return entry.toLowerCase() === code.toLowerCase();
}

function variantOrder(entry, preferredVariants) {
  return (track) => {
    const code = track.code.toLowerCase();
    if (code === entry.toLowerCase()) return -2;
    const preferred = preferredVariants.indexOf(code);
    if (preferred >= 0) return preferred - preferredVariants.length - 2;
    // "-orig" duplicates the bare recognized track; keep it as a last resort.
    return code.endsWith('-orig') ? 1 : 0;
  };
}

function sortByPreference(tracks, entry, preferredVariants) {
  const rank = variantOrder(entry, preferredVariants);
  return [...tracks].sort((a, b) => rank(a) - rank(b) || a.code.localeCompare(b.code));
}

/**
 * @param {object} params
 * @param {object} params.preferences - from preferencesFromConfig
 * @param {{code: string, source: string}[]} params.offered - from listOfferedTracks
 * @returns {{
 *   tracks: {language: string, code: string, source: string, preferred: boolean}[],
 *   missing: {language: string, reason: string}[],
 *   unsupported: string[],
 * }}
 */
function selectPublishableTracks({ preferences, offered }) {
  const { subtitleLanguage, sourcePolicy, allowTranslated, preferredVariants = [] } = preferences;
  const tracks = [];
  const missing = [];
  const unsupported = [];
  const chosenCodes = new Set();

  for (const entry of parseSubtitleLanguages(subtitleLanguage)) {
    if (!isPlainLanguageCode(entry)) {
      unsupported.push(entry);
      continue;
    }
    const candidates = (offered || []).filter((track) => matchesEntry(entry, track.code));
    const bySource = (source) => sortByPreference(candidates.filter((track) => track.source === source), entry, preferredVariants);
    const uploaded = bySource(SOURCES.UPLOADED);
    const automatic = bySource(SOURCES.AUTOMATIC);
    const translated = bySource(SOURCES.TRANSLATED);

    let picked = [];
    if (uploaded.length) picked = uploaded;
    else if (automatic.length && sourcePolicy !== 'uploaded-only') picked = [automatic[0]];
    else if (translated.length && allowTranslated && sourcePolicy !== 'uploaded-only') picked = [translated[0]];

    if (!picked.length) {
      let reason = MISSING_REASONS.NOT_OFFERED;
      if (automatic.length || (translated.length && allowTranslated)) reason = MISSING_REASONS.AUTOMATIC_NOT_ALLOWED;
      else if (translated.length) reason = MISSING_REASONS.TRANSLATION_ONLY;
      missing.push({ language: entry, reason });
      continue;
    }
    picked.forEach((track, index) => {
      if (chosenCodes.has(track.code)) return;
      chosenCodes.add(track.code);
      tracks.push({ language: entry, code: track.code, source: track.source, preferred: index === 0 });
    });
  }
  return { tracks, missing, unsupported };
}

function bestRank(tracks) {
  return tracks.reduce((best, track) => Math.max(best, SOURCE_RANK[track.source] ?? 0), -1);
}

/**
 * Compare what is on disk with what the preferences would publish.
 * @param {object} params
 * @param {object} params.preferences
 * @param {{code: string, source: string}[]} params.offered - what YouTube offered (last known)
 * @param {{code: string, source: string}[]} params.onDisk - sidecars present now
 * @returns {{
 *   selection: object,
 *   missing: {language: string, reason: string}[],
 *   upgrades: {language: string, code: string, source: string}[],
 *   unsupported: string[],
 * }}
 */
function assessCoverage({ preferences, offered, onDisk }) {
  const selection = selectPublishableTracks({ preferences, offered });
  const missing = [];
  const upgrades = [];
  for (const entry of parseSubtitleLanguages(preferences.subtitleLanguage)) {
    if (!isPlainLanguageCode(entry)) continue;
    const present = (onDisk || []).filter((track) => matchesEntry(entry, track.code));
    const selected = selection.tracks.filter((track) => track.language === entry);
    if (!present.length) {
      const unavailable = selection.missing.find((item) => item.language === entry);
      missing.push({ language: entry, reason: unavailable ? unavailable.reason : MISSING_REASONS.NOT_DOWNLOADED });
      continue;
    }
    if (selected.length && bestRank(selected) > bestRank(present)) {
      upgrades.push({ language: entry, code: selected[0].code, source: selected[0].source });
    }
  }
  return { selection, missing, upgrades, unsupported: selection.unsupported };
}

module.exports = {
  assessCoverage,
  SOURCE_POLICIES,
  DEFAULT_SOURCE_POLICY,
  MISSING_REASONS,
  preferencesFromConfig,
  selectPublishableTracks,
  matchesEntry,
};
