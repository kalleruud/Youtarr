/**
 * One metadata-and-captions request to YouTube for a delayed caption check,
 * plus the ffprobe length of the stored media. Errors are classified so the
 * worker can tell a throttle (pause everything, count no attempt) from an
 * unavailable video (stop checking) from an ordinary failure (counts).
 */
const fs = require('fs').promises;
const path = require('path');
const { execFile } = require('child_process');
const ytDlpRunner = require('../ytDlpRunner');
const configModule = require('../configModule');
const YtdlpCommandBuilder = require('../download/ytdlpCommandBuilder');
const { TRACK_CODE } = require('./captionSources');

const FETCH_TIMEOUT_MS = 2 * 60 * 1000;
const PROBE_TIMEOUT_MS = 30 * 1000;
const MAX_REASON_LENGTH = 200;
const THROTTLE_PATTERN = /HTTP Error 429|Too Many Requests|try again later|confirm you.?re not a bot|confirm that you.?re not a bot/i;
const UNAVAILABLE_PATTERN = /Video unavailable|Private video|has been removed|removed by the uploader|members-only|join this channel|account .*terminated/i;

class CaptionFetchError extends Error {
  constructor(kind, reason) {
    super(reason);
    this.name = 'CaptionFetchError';
    this.kind = kind;
  }
}

// Short, URL-free reason (yt-dlp output can carry signed URLs).
function summarize(message) {
  const text = String(message || '');
  const line = text.split('\n').find((candidate) => /ERROR:/.test(candidate)) || text.split('\n')[0] || '';
  return line.replace(/https?:\/\/\S+/g, '[url]').replace(/\s+/g, ' ').trim().slice(0, MAX_REASON_LENGTH) || 'yt-dlp failed';
}

function classifyFetchError(err) {
  const message = String(err && err.message ? err.message : err);
  if ((err && err.code === 'COOKIES_REQUIRED') || THROTTLE_PATTERN.test(message)) {
    return new CaptionFetchError('throttled', 'YouTube is limiting requests');
  }
  if (UNAVAILABLE_PATTERN.test(message)) return new CaptionFetchError('unavailable', summarize(message));
  return new CaptionFetchError('failed', summarize(message));
}

/**
 * @param {{youtubeId: string, languages: string[], outputDir: string}} params
 * @returns {Promise<{info: object, captions: Map<string, string>}>}
 */
async function fetchCaptions({ youtubeId, languages, outputDir }) {
  const args = YtdlpCommandBuilder.buildCaptionEnrichmentArgs(configModule.getConfig() || {}, youtubeId, languages, outputDir);
  let runError = null;
  try {
    await ytDlpRunner.run(args, { timeoutMs: FETCH_TIMEOUT_MS });
  } catch (err) {
    runError = err;
  }
  if (runError) {
    const classified = classifyFetchError(runError);
    if (classified.kind !== 'failed') throw classified;
  }
  let info;
  try {
    info = JSON.parse(await fs.readFile(path.join(outputDir, `${youtubeId}.info.json`), 'utf8'));
  } catch {
    throw runError ? classifyFetchError(runError) : new CaptionFetchError('failed', 'yt-dlp wrote no metadata');
  }
  if (!info || info.id !== youtubeId) throw new CaptionFetchError('failed', 'yt-dlp returned metadata for another video');
  const captions = new Map();
  const prefix = `${youtubeId}.`;
  for (const name of await fs.readdir(outputDir)) {
    if (!name.startsWith(prefix) || !name.endsWith('.srt')) continue;
    const code = name.slice(prefix.length, -'.srt'.length);
    if (TRACK_CODE.test(code)) captions.set(code, path.join(outputDir, name));
  }
  return { info, captions };
}

/** Length of the stored media in seconds, or null when it cannot be measured. */
function probeDuration(mediaPath) {
  return new Promise((resolve) => {
    execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', mediaPath],
      { timeout: PROBE_TIMEOUT_MS }, (err, stdout) => {
        const value = err ? NaN : Number(String(stdout).trim());
        resolve(Number.isFinite(value) && value > 0 ? value : null);
      });
  });
}

module.exports = { fetchCaptions, probeDuration, classifyFetchError, CaptionFetchError };
