// Redaction and size bounds for anything an outcome stores or a health
// notification sends. Reuses the log scrubber (configured keys, Apprise URLs,
// token query parameters, URL credentials) and adds the secrets the scrubber
// does not need for log files: cookie values and signed googlevideo URLs.
const { createLogScrubber } = require('../../logging/logScrubber');
const { MAX_MESSAGE_LENGTH, MAX_DETAILS_BYTES, MAX_REASON_CODE_LENGTH } = require('./constants');

const REDACTED = '[REDACTED]';
const EXTRA_PATTERNS = [
  // Signed media URLs carry expiring signatures and the requesting IP.
  [/https?:\/\/[^\s"'<>]*googlevideo\.com[^\s"'<>]*/gi, `[signed media URL ${REDACTED}]`],
  [/([?&](?:sig|signature|lsig|token|key|access_token)=)[^&\s"']+/gi, `$1${REDACTED}`],
  [/((?:cookie|set-cookie|authorization)\s*[:=]\s*)[^\n]+/gi, `$1${REDACTED}`],
  [/(MediaBrowser Token=")[^"]*/gi, `$1${REDACTED}`],
];

function scrubText(value, config = {}) {
  if (value === null || value === undefined) return null;
  let text = String(value);
  try {
    text = createLogScrubber(config || {})(text);
  } catch {
    // A malformed config must not stop the record; the patterns below still apply.
  }
  for (const [pattern, replacement] of EXTRA_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

function truncate(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

/** Redacted single-line message, at most MAX_MESSAGE_LENGTH characters. */
function boundMessage(value, config) {
  const text = scrubText(value, config);
  if (!text) return null;
  return truncate(text.replace(/\s+/g, ' ').trim(), MAX_MESSAGE_LENGTH) || null;
}

function boundReasonCode(value) {
  if (!value) return null;
  return String(value).replace(/[^a-z0-9_.-]/gi, '-').slice(0, MAX_REASON_CODE_LENGTH);
}

/**
 * Redacted JSON of a plain details object. When it is too large, string
 * fields are shortened; if that is still too large only a marker is kept.
 */
function boundDetails(details, config) {
  if (!details || typeof details !== 'object') return null;
  const serialize = (value) => scrubText(JSON.stringify(value), config);
  let json = serialize(details);
  if (Buffer.byteLength(json, 'utf8') <= MAX_DETAILS_BYTES) return json;
  const shortened = {};
  for (const [key, value] of Object.entries(details)) {
    shortened[key] = typeof value === 'string' ? truncate(value, 200) : value;
  }
  json = serialize(shortened);
  if (Buffer.byteLength(json, 'utf8') <= MAX_DETAILS_BYTES) return json;
  return JSON.stringify({ truncated: true });
}

function parseDetails(json) {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

module.exports = { scrubText, boundMessage, boundReasonCode, boundDetails, parseDetails, REDACTED };
