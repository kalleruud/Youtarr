// Effective build and tool versions stamped on every health outcome, so a
// failure can be matched to the Youtarr build and yt-dlp that produced it.
const { MAX_VERSION_LENGTH } = require('./constants');

let appVersion;
let toolVersionProvider = () => process.env.YOUTARR_YTDLP_VERSION || null;

function clip(value) {
  if (value === null || value === undefined || value === '') return null;
  return String(value).trim().slice(0, MAX_VERSION_LENGTH) || null;
}

function getAppVersion() {
  if (appVersion === undefined) {
    try {
      appVersion = clip(require('../../../package.json').version);
    } catch {
      appVersion = null;
    }
  }
  return appVersion;
}

/** server.js hands in its cached `yt-dlp --version` lookup. */
function setToolVersionProvider(provider) {
  if (typeof provider === 'function') toolVersionProvider = provider;
}

function getToolVersion() {
  try {
    const value = toolVersionProvider();
    return typeof value === 'string' ? clip(value) : null;
  } catch {
    return null;
  }
}

function getVersions() {
  return { appVersion: getAppVersion(), toolVersion: getToolVersion() };
}

module.exports = { getVersions, getAppVersion, getToolVersion, setToolVersionProvider };
