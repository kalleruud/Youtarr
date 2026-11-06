const {
  PORTRAIT_MIN_ASPECT,
  PORTRAIT_MAX_ASPECT,
  PORTRAIT_MIN_WIDTH,
  POSTER_ORIGINS,
  POSTER_SOURCES,
} = require('./constants');

/** True when an image is already shaped like a show poster. */
function isSuitablePortrait(dimensions) {
  if (!dimensions || !dimensions.width || !dimensions.height) return false;
  const aspect = dimensions.width / dimensions.height;
  return aspect >= PORTRAIT_MIN_ASPECT
    && aspect <= PORTRAIT_MAX_ASPECT
    && dimensions.width >= PORTRAIT_MIN_WIDTH;
}

/**
 * Decide which poster a channel's show card uses. Pure: the caller supplies
 * what exists on disk and in the stored preference.
 *
 * Order: the owner's uploaded poster (when selected), the current poster
 * when the owner pinned it, an upstream image already shaped like a poster,
 * then a 2:3 composition of the upstream image (or of the channel identity
 * alone when there is no image at all).
 *
 * @param {Object} channel - { channelId, title }
 * @param {Object} preference - { source, protected, current: { exists } }
 * @param {Object} candidates - { manual: { path, dimensions } | null, upstream: { path, dimensions, sha256 } | null }
 * @returns {{ action: 'keep'|'copy'|'compose', origin: string, sourcePath: string|null, sourceSha256: string|null }}
 */
function resolveShowArtwork(channel, preference = {}, candidates = {}) {
  const { manual = null, upstream = null } = candidates;
  const current = preference.current || {};

  if (preference.source === POSTER_SOURCES.MANUAL && manual) {
    return { action: 'copy', origin: POSTER_ORIGINS.MANUAL, sourcePath: manual.path, sourceSha256: manual.sha256 || null };
  }
  if (preference.protected && current.exists) {
    return { action: 'keep', origin: current.origin || null, sourcePath: null, sourceSha256: current.sourceSha256 || null };
  }
  if (upstream && isSuitablePortrait(upstream.dimensions)) {
    return { action: 'copy', origin: POSTER_ORIGINS.UPSTREAM, sourcePath: upstream.path, sourceSha256: upstream.sha256 || null };
  }
  return {
    action: 'compose',
    origin: POSTER_ORIGINS.GENERATED,
    sourcePath: upstream ? upstream.path : null,
    sourceSha256: upstream ? upstream.sha256 || null : null,
    channelId: channel.channelId,
    title: channel.title || '',
  };
}

module.exports = { isSuitablePortrait, resolveShowArtwork };
