const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const {
  POSTER_WIDTH,
  POSTER_HEIGHT,
  FFMPEG_TIMEOUT_MS,
  COMPOSE_AVATAR_BOX,
  COMPOSE_AVATAR_TOP,
  COMPOSE_TITLE_TOP,
  COMPOSE_TITLE_FONT_SIZE,
  COMPOSE_TITLE_LINE_HEIGHT,
  COMPOSE_TITLE_MAX_LINES,
  COMPOSE_TITLE_LINE_CHARS,
  TITLE_FONT_CANDIDATES,
} = require('./constants');

// Paths placed inside an ffmpeg filtergraph must not need escaping; only
// the fixed font list and our own temp files ever go there.
const FILTER_SAFE_PATH = /^[A-Za-z0-9/._-]+$/;
// Output flags that keep the encoded bytes identical for identical inputs.
const DETERMINISTIC_OUTPUT_ARGS = ['-map_metadata', '-1', '-fflags', '+bitexact', '-flags:v', '+bitexact'];
const ELLIPSIS = '…';

/** Split a channel title into at most COMPOSE_TITLE_MAX_LINES short lines. */
function wrapTitle(title) {
  const clean = String(title || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return [];
  const clip = (word) => (word.length > COMPOSE_TITLE_LINE_CHARS
    ? `${word.slice(0, COMPOSE_TITLE_LINE_CHARS - 1)}${ELLIPSIS}`
    : word);
  const lines = [];
  let current = '';
  const words = clean.split(' ');
  for (let i = 0; i < words.length; i += 1) {
    const word = clip(words[i]);
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= COMPOSE_TITLE_LINE_CHARS) {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = word;
    if (lines.length === COMPOSE_TITLE_MAX_LINES) {
      const last = lines[lines.length - 1];
      lines[lines.length - 1] = `${last.slice(0, COMPOSE_TITLE_LINE_CHARS - 1)}${ELLIPSIS}`;
      return lines;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** A muted background colour derived from the channel id, stable forever. */
function colorForIdentity(channelId) {
  const digest = crypto.createHash('sha256').update(String(channelId || '')).digest();
  // Keep each channel dark so white title text stays readable.
  const channel = (byte) => (40 + (byte % 70)).toString(16).padStart(2, '0');
  return `0x${channel(digest[0])}${channel(digest[1])}${channel(digest[2])}`;
}

function findTitleFont(exists = fs.existsSync) {
  return TITLE_FONT_CANDIDATES.find((candidate) => exists(candidate)) || null;
}

/**
 * The ffmpeg arguments for a 2:3 show poster. With a source image the
 * canvas is a blurred, darkened cover of it with the whole image centered
 * on top (never stretched, never cropped); without one it is a solid
 * identity colour. Title lines are drawn from text files so no title text
 * ever reaches the filtergraph. Pure: same inputs, same arguments.
 */
function buildComposeArgs({ ffmpegPath, sourcePath, outputPath, channelId, titleFiles = [], fontPath = null }) {
  const args = [ffmpegPath, '-loglevel', 'error', '-y'];
  const filters = [];
  if (sourcePath) {
    args.push('-i', sourcePath);
    filters.push(
      '[0:v]split=2[bgsrc][fgsrc]',
      `[bgsrc]scale=${POSTER_WIDTH}:${POSTER_HEIGHT}:force_original_aspect_ratio=increase,crop=${POSTER_WIDTH}:${POSTER_HEIGHT},gblur=sigma=40,drawbox=x=0:y=0:w=iw:h=ih:color=black@0.35:t=fill[bg]`,
      `[fgsrc]scale=${COMPOSE_AVATAR_BOX}:${COMPOSE_AVATAR_BOX}:force_original_aspect_ratio=decrease[fg]`,
      `[bg][fg]overlay=x=(W-w)/2:y=${COMPOSE_AVATAR_TOP}[base0]`
    );
  } else {
    args.push('-f', 'lavfi', '-i', `color=c=${colorForIdentity(channelId)}:s=${POSTER_WIDTH}x${POSTER_HEIGHT}`);
    filters.push('[0:v]null[base0]');
  }
  let base = 'base0';

  const drawTitle = fontPath && FILTER_SAFE_PATH.test(fontPath)
    && titleFiles.every((file) => FILTER_SAFE_PATH.test(file));
  if (drawTitle) {
    const top = sourcePath
      ? COMPOSE_TITLE_TOP
      : Math.round((POSTER_HEIGHT - titleFiles.length * COMPOSE_TITLE_LINE_HEIGHT) / 2);
    titleFiles.forEach((file, index) => {
      const next = `base${index + 1}`;
      filters.push(
        `[${base}]drawtext=fontfile=${fontPath}:textfile=${file}:expansion=none:fontsize=${COMPOSE_TITLE_FONT_SIZE}`
        + `:fontcolor=white:shadowcolor=black@0.6:shadowx=3:shadowy=3:x=(w-text_w)/2:y=${top + index * COMPOSE_TITLE_LINE_HEIGHT}[${next}]`
      );
      base = next;
    });
  }
  filters.push(`[${base}]format=yuvj420p[out]`);

  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[out]',
    '-frames:v', '1',
    '-q:v', '2',
    ...DETERMINISTIC_OUTPUT_ARGS,
    outputPath
  );
  return args;
}

function runFfmpeg(args, exec) {
  const [command, ...rest] = args;
  return new Promise((resolve, reject) => {
    exec(command, rest, { timeout: FFMPEG_TIMEOUT_MS }, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Compose a 2:3 poster for a channel into outputPath.
 * @param {Object} input - { sourcePath|null, outputPath, channelId, title }
 * @param {Object} deps - { ffmpegPath, exec, exists }
 */
async function composePoster({ sourcePath, outputPath, channelId, title }, { ffmpegPath, exec = execFile, exists = fs.existsSync } = {}) {
  const lines = wrapTitle(title);
  const fontPath = lines.length ? findTitleFont(exists) : null;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'youtarr-poster-'));
  try {
    const titleFiles = fontPath
      ? lines.map((line, index) => {
        const file = path.join(tempDir, `title-${index}.txt`);
        fs.writeFileSync(file, line, 'utf8');
        return file;
      })
      : [];
    await runFfmpeg(buildComposeArgs({ ffmpegPath, sourcePath, outputPath, channelId, titleFiles, fontPath }), exec);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Re-encode an uploaded image as a metadata-free JPEG, scaled down (never
 * up, never stretched) to fit the poster size.
 */
async function normalizeUpload({ inputPath, outputPath }, { ffmpegPath, exec = execFile } = {}) {
  await runFfmpeg([
    ffmpegPath, '-loglevel', 'error', '-y',
    '-i', inputPath,
    '-vf', `scale='min(${POSTER_WIDTH},iw)':'min(${POSTER_HEIGHT},ih)':force_original_aspect_ratio=decrease,format=yuvj420p`,
    '-frames:v', '1',
    '-q:v', '2',
    ...DETERMINISTIC_OUTPUT_ARGS,
    outputPath,
  ], exec);
}

module.exports = { wrapTitle, colorForIdentity, findTitleFont, buildComposeArgs, composePoster, normalizeUpload };
