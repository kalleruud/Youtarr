// Pure naming rules for the Jellyfin TV layout:
//   <Show> [<channel id>]/Season <year>/<Show> - S<year>E<nnn> - <Title> [<video id>].<ext>
// The bracketed YouTube IDs are identity: the show folder is found again by its
// channel ID after a channel rename, and every episode file keeps the trailing
// "[<video id>]" token the rescan, file check and delete paths rely on.
const { sanitizeNameLikeYtDlp } = require('../filesystem/sanitizer');

const SHOW_NAME_MAX_BYTES = 80;
const EPISODE_TITLE_MAX_BYTES = 96;
const EPISODE_NUMBER_MIN_DIGITS = 3;
const UNTITLED = 'Untitled';
// YouTube channel and video IDs. Anything else is refused rather than
// sanitized, because it is used as identity inside path segments.
const YOUTUBE_IDENTITY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
// Characters that are invalid in XML 1.0 or that render as invisible control
// codes in file names.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;

function isYoutubeIdentity(value) {
  return typeof value === 'string' && YOUTUBE_IDENTITY_PATTERN.test(value);
}

// Cut a string to at most maxBytes of UTF-8 without splitting a code point.
function truncateUtf8(value, maxBytes) {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let out = '';
  let bytes = 0;
  for (const char of value) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > maxBytes) break;
    out += char;
    bytes += size;
  }
  return out;
}

// One path segment from free text: no separators, no Windows-reserved
// characters (same rules as yt-dlp --windows-filenames), no control codes, no
// leading dot (that would hide the file from media servers), bounded length.
function sanitizeSegment(value, maxBytes, fallback = UNTITLED) {
  let text = String(value == null ? '' : value)
    .replace(CONTROL_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .trim();
  text = truncateUtf8(text, maxBytes).trim();
  if (!text) text = fallback;
  // yt-dlp's rule replaces one trailing dot/space with '#'; apply it after
  // truncation so the result never ends in a dot or space.
  return sanitizeNameLikeYtDlp(text);
}

function buildShowFolderName(showTitle, channelId) {
  return `${sanitizeSegment(showTitle, SHOW_NAME_MAX_BYTES, channelId)} [${channelId}]`;
}

// The show name part of a show folder ("Name [UC...]" -> "Name"), or null if
// the folder does not belong to channelId.
function showNameFromFolder(folderName, channelId) {
  const suffix = ` [${channelId}]`;
  if (typeof folderName !== 'string' || !folderName.endsWith(suffix)) return null;
  const name = folderName.slice(0, -suffix.length);
  return name || null;
}

function buildSeasonFolderName(season) {
  return `Season ${season}`;
}

function formatEpisodeCode(season, episode) {
  return `S${season}E${String(episode).padStart(EPISODE_NUMBER_MIN_DIGITS, '0')}`;
}

function buildEpisodeStem({ showName, season, episode, title, youtubeId }) {
  const show = sanitizeSegment(showName, SHOW_NAME_MAX_BYTES);
  const episodeTitle = sanitizeSegment(title, EPISODE_TITLE_MAX_BYTES);
  return `${show} - ${formatEpisodeCode(season, episode)} - ${episodeTitle} [${youtubeId}]`;
}

module.exports = {
  SHOW_NAME_MAX_BYTES,
  EPISODE_TITLE_MAX_BYTES,
  isYoutubeIdentity,
  truncateUtf8,
  sanitizeSegment,
  buildShowFolderName,
  showNameFromFolder,
  buildSeasonFolderName,
  formatEpisodeCode,
  buildEpisodeStem,
};
