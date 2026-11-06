// Show posters are 2:3, the shape Jellyfin's Shows grid (and JellySee) uses.
const POSTER_WIDTH = 1000;
const POSTER_HEIGHT = 1500;

// An upstream image counts as a portrait poster only inside this aspect
// window (width / height) and at least this wide; anything else (square
// avatars, wide banners) is composed onto a 2:3 canvas instead of stretched
// or cropped.
const PORTRAIT_MIN_ASPECT = 0.6;
const PORTRAIT_MAX_ASPECT = 0.72;
const PORTRAIT_MIN_WIDTH = 300;

// Owner uploads: anything portrait-ish is accepted as-is (only scaled down).
const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
const UPLOAD_MIN_WIDTH = 200;
const UPLOAD_MIN_HEIGHT = 300;
const UPLOAD_MAX_DIMENSION = 8000;
const UPLOAD_MIN_ASPECT = 0.5;
const UPLOAD_MAX_ASPECT = 0.8;

const FFMPEG_TIMEOUT_MS = 30000;
const FFPROBE_TIMEOUT_MS = 10000;

// Composition layout on the 1000x1500 canvas.
const COMPOSE_AVATAR_BOX = 640;
const COMPOSE_AVATAR_TOP = 300;
const COMPOSE_TITLE_TOP = 1040;
const COMPOSE_TITLE_FONT_SIZE = 72;
const COMPOSE_TITLE_LINE_HEIGHT = 92;
const COMPOSE_TITLE_MAX_LINES = 3;
const COMPOSE_TITLE_LINE_CHARS = 18;

// Fonts tried in order for the title; the poster is composed without a
// title when none exists.
const TITLE_FONT_CANDIDATES = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
];

// Jellyfin/Kodi local artwork names.
const SHOW_POSTER_FILENAME = 'poster.jpg';
const EPISODE_THUMB_SUFFIX = '-thumb.jpg';

const POSTER_ORIGINS = Object.freeze({
  MANUAL: 'manual',
  UPSTREAM: 'upstream',
  GENERATED: 'generated',
});

const POSTER_SOURCES = Object.freeze({ AUTO: 'auto', MANUAL: 'manual' });

const REFRESH_STATUSES = Object.freeze({
  REFRESHED: 'refreshed',
  NOT_FOUND: 'not-found',
  FAILED: 'failed',
  NOT_CONFIGURED: 'not-configured',
});

module.exports = {
  POSTER_WIDTH,
  POSTER_HEIGHT,
  PORTRAIT_MIN_ASPECT,
  PORTRAIT_MAX_ASPECT,
  PORTRAIT_MIN_WIDTH,
  UPLOAD_MAX_BYTES,
  UPLOAD_MIN_WIDTH,
  UPLOAD_MIN_HEIGHT,
  UPLOAD_MAX_DIMENSION,
  UPLOAD_MIN_ASPECT,
  UPLOAD_MAX_ASPECT,
  FFMPEG_TIMEOUT_MS,
  FFPROBE_TIMEOUT_MS,
  COMPOSE_AVATAR_BOX,
  COMPOSE_AVATAR_TOP,
  COMPOSE_TITLE_TOP,
  COMPOSE_TITLE_FONT_SIZE,
  COMPOSE_TITLE_LINE_HEIGHT,
  COMPOSE_TITLE_MAX_LINES,
  COMPOSE_TITLE_LINE_CHARS,
  TITLE_FONT_CANDIDATES,
  SHOW_POSTER_FILENAME,
  EPISODE_THUMB_SUFFIX,
  POSTER_ORIGINS,
  POSTER_SOURCES,
  REFRESH_STATUSES,
};
