// Eviction of an episode's local copy while it stays streamable (issue #14):
// a previewed action, separate from any policy change. Runs on the
// representation facade (index.js), which owns leases and STRM writes.
const fs = require('fs-extra');
const path = require('path');
const logger = require('../../logger');
const Video = require('../../models/video');
const Channel = require('../../models/channel');
const configModule = require('../configModule');
const { getCapabilities } = require('../acquisition/capabilities');
const { removedColumns } = require('../videoRemovalState');
const { checkLibraryRoot, isRowUnderLibraryCheck } = require('../libraryRootCheck');
const store = require('./representationStore');
const watchContinuity = require('./watchContinuity');
const { RepresentationError } = require('./representationError');
const { listEpisodeSidecars } = require('./localAsset');
const { MODES, STATES, LEASE_OPERATIONS, STREAM_ENTRY_EXTENSION } = require('./representationValues');

const EVICTION_DETAIL = 'Local copy removed; still streamable';

// What identifies the previewed local file: a download that replaced it
// meanwhile (same path, new file) must not be evicted.
async function fileIdentity(location) {
  try {
    const stat = await fs.stat(location);
    return { ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
  } catch (err) {
    return null;
  }
}

function sameIdentity(a, b) {
  return !!a && !!b && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

// A failing downloads-folder check (an unmounted drive or share) blocks
// evicting a file it covers, as it blocks manual deletes; a check that
// itself fails does not block, also as for deletes.
async function libraryCheck() {
  try {
    return await checkLibraryRoot(configModule.directoryPath);
  } catch (err) {
    logger.warn({ err }, 'Could not check the downloads folder before evicting a local copy');
    return null;
  }
}

async function preview(facade, youtubeId) {
  const { selection, head, video } = await facade._resolve(youtubeId);
  const reasons = [];
  const refuse = (code, message) => reasons.push({ code, message });
  if (!video) refuse('not_found', 'This video has no library record.');
  if (video && video.protected) refuse('protected', 'This video is protected from deletion.');
  if (video && video.channel_id) {
    const channel = await Channel.findOne({ where: { channel_id: video.channel_id }, attributes: ['auto_removal_protected'] });
    if (channel && channel.auto_removal_protected) refuse('channel_protected', 'This channel\'s videos are protected from removal.');
  }
  const local = selection.mode === MODES.LOCAL && !selection.partial ? selection.representation : null;
  if (!local) refuse('no_local_copy', 'There is no complete local copy to remove.');
  if (local) {
    const check = await libraryCheck();
    if (isRowUnderLibraryCheck(check, { filePath: local.location })) {
      refuse('library_unavailable', `${check.message} Nothing was removed; check that the drive is mounted.`);
    }
  }
  if (getCapabilities().stream.available !== true) {
    refuse('stream_unavailable', 'Streaming is not available, so removing the local copy would leave nothing to play. Delete the video instead.');
  } else if (!facade._streamPublisher) {
    refuse('stream_publisher_unavailable', 'STRM publication is not available, so the episode would disappear. Delete the video instead.');
  }
  if (video && video.youtube_removed) refuse('source_removed', 'The video is no longer on YouTube; the local copy is the only one left.');
  return {
    youtubeId,
    allowed: reasons.length === 0,
    revision: head.revision,
    remove: local ? [local.location] : [],
    keep: local ? await listEpisodeSidecars(local.location, youtubeId) : [],
    reasons,
  };
}

/**
 * Evict the local copy after a preview. The local item's watch state is
 * recorded first (a failure changes nothing), then the STRM entry is
 * published, then only the media file is removed - and only while the
 * lease is still held and the file is still the one previewed; otherwise
 * the STRM entry is withdrawn and the local file stays. Refused unless the
 * preview allows it and nothing changed since (expectedRevision).
 */
async function evict(facade, youtubeId, { expectedRevision } = {}) {
  return facade.withPublicationLease(youtubeId, LEASE_OPERATIONS.EVICTION, async (lease) => {
    const previewed = await preview(facade, youtubeId);
    if (!previewed.allowed) {
      throw new RepresentationError(409, 'eviction-refused', previewed.reasons[0].message, previewed.reasons);
    }
    if (expectedRevision !== undefined && expectedRevision !== previewed.revision) {
      throw new store.RepresentationRevisionError(previewed.revision);
    }
    const { selection } = await facade._resolve(youtubeId);
    const local = selection.representation;
    const identity = await fileIdentity(local.location);
    // The publisher writes the entry under the media's stem (see registerStreamPublisher).
    const plannedStream = path.join(path.dirname(local.location), `${path.parse(local.location).name}${STREAM_ENTRY_EXTENSION}`);
    let carryovers = await watchContinuity.ensureCarryovers({ youtubeId, fromLocation: local.location, toLocation: plannedStream });
    const stream = await facade._writeStreamEntry(lease, youtubeId, facade._streamPublisher.write.bind(facade._streamPublisher));
    try {
      if (stream.location !== plannedStream) {
        carryovers += await watchContinuity.ensureCarryovers({ youtubeId, fromLocation: local.location, toLocation: stream.location });
      }
      await facade._confirmLease(lease);
      if (!sameIdentity(identity, await fileIdentity(local.location))) {
        throw new RepresentationError(409, 'local-copy-changed', 'The local copy changed while it was being evicted; nothing was removed.');
      }
    } catch (err) {
      await facade._yieldToLocalMedia(err.code === 'LEASE_LOST' ? null : lease, youtubeId, stream.location)
        .catch(yieldErr => logger.warn({ err: yieldErr, youtubeId }, 'Could not withdraw the STRM entry of a stopped eviction'));
      throw err;
    }
    await fs.remove(local.location);
    await store.record(lease, {
      kind: local.kind, variant: local.variant || '', state: STATES.EVICTED, location: local.location,
      sizeBytes: local.sizeBytes ?? null, detail: EVICTION_DETAIL,
    });
    await Video.update(removedColumns('user_deleted', { detail: EVICTION_DETAIL }), { where: { youtubeId } });
    logger.info({ youtubeId, removed: local.location, stream: stream.location }, 'Evicted the local copy; the episode stays streamable');
    return { youtubeId, removed: [local.location], kept: previewed.keep, streamLocation: stream.location, carryovers };
  });
}

module.exports = { preview, evict, EVICTION_DETAIL };
