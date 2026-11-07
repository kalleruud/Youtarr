// Episode representations (issue #14): one logical episode, keyed by its
// YouTube id (#6's stable identity), with any number of playable copies - a
// verified local file, a STRM entry, a cache or a recording. This facade is
// the only writer of those copies' records and decides which one plays.
//
// Single-entry strategy: controlled file replacement. A downloaded file is
// published under the STRM entry's exact stem (the TV publisher keeps an
// existing episode's stem), the STRM entry is removed once the media file has
// landed, and the watch state the media server kept on the STRM item is
// carried over to its new item (watchContinuity). Every change runs under the
// episode's publication lease, so a download, a STRM refresh and an eviction
// of the same video never interleave, and each one reconciles leftovers of
// the others: whatever ran last leaves exactly one visible entry.
const fs = require('fs-extra');
const path = require('path');
const logger = require('../../logger');
const Video = require('../../models/video');
const Channel = require('../../models/channel');
const { getCapabilities } = require('../acquisition/capabilities');
const { removedColumns } = require('../videoRemovalState');
const { isYoutubeIdentity } = require('../tvPublication/tvNaming');
const store = require('./representationStore');
const watchContinuity = require('./watchContinuity');
const { selectRepresentation } = require('./selectRepresentation');
const { inspectLocalMedia, isStreamEntryFor, findStreamEntries, listEpisodeSidecars } = require('./localAsset');
const { KINDS, STATES, MODES, LEASE_OPERATIONS, COMPLETE_LOCAL_KINDS } = require('./representationValues');

// A download waits out a STRM publication (whose lease expires after two
// minutes) rather than publishing beside it.
const PROMOTION_LEASE_WAIT_MS = 150 * 1000;
const EVICTION_DETAIL = 'Local copy removed; still streamable';

class RepresentationError extends Error {
  constructor(status, code, message, reasons = []) {
    super(message);
    this.name = 'RepresentationError';
    this.status = status;
    this.code = code;
    this.reasons = reasons;
  }
}

function requireIdentity(youtubeId) {
  if (!isYoutubeIdentity(youtubeId)) throw new RepresentationError(400, 'invalid-id', 'A valid YouTube video ID is required');
}

function publicView(candidate) {
  if (!candidate) return null;
  return {
    id: candidate.id ?? null,
    kind: candidate.kind,
    variant: candidate.variant || '',
    state: candidate.state,
    location: candidate.location || null,
    sizeBytes: candidate.sizeBytes ?? null,
    revision: candidate.revision ?? null,
    legacy: !!candidate.legacy,
  };
}

class EpisodeRepresentations {
  constructor() {
    this._streamPublisher = null;
  }

  get KINDS() { return KINDS; }
  get MODES() { return MODES; }
  get LEASE_OPERATIONS() { return LEASE_OPERATIONS; }

  /**
   * Seam for STRM publication (#13): `{ write({ youtubeId }) -> Promise<{ location }> }`
   * writes the episode's STRM entry under the same stem as its other files.
   * Eviction is refused until one is registered.
   */
  registerStreamPublisher(publisher) {
    this._streamPublisher = publisher || null;
  }

  async _video(youtubeId) {
    return Video.findOne({
      where: { youtubeId },
      attributes: ['id', 'youtubeId', 'channel_id', 'filePath', 'removed', 'youtube_removed', 'protected'],
    });
  }

  // Every representation with `usable` set from the filesystem, plus the
  // video's own filePath as a legacy local copy when no recorded local copy
  // is usable (downloads from before representations existed).
  async _candidates(youtubeId, video, representations) {
    const candidates = [];
    for (const rep of representations) {
      if (rep.kind === KINDS.STRM) {
        candidates.push({ ...rep, usable: rep.state === STATES.PUBLISHED });
      } else if (rep.state === STATES.VERIFIED || rep.state === STATES.PARTIAL) {
        const check = await inspectLocalMedia(rep.location, youtubeId);
        candidates.push({ ...rep, usable: check.usable, problem: check.reason || null });
      } else {
        candidates.push({ ...rep, usable: false });
      }
    }
    const hasUsableLocal = candidates.some(c => c.kind === KINDS.LOCAL && c.usable);
    const known = new Set(representations.map(rep => rep.location));
    if (!hasUsableLocal && video && video.filePath && !video.removed && !known.has(video.filePath)) {
      const check = await inspectLocalMedia(video.filePath, youtubeId);
      candidates.push({
        id: null, kind: KINDS.LOCAL, variant: '', state: STATES.VERIFIED, location: video.filePath,
        sizeBytes: check.sizeBytes ?? null, usable: check.usable, legacy: true,
      });
    }
    return candidates;
  }

  async _resolve(youtubeId) {
    const [representations, head, video] = await Promise.all([
      store.list(youtubeId), store.getHead(youtubeId), this._video(youtubeId),
    ]);
    const candidates = await this._candidates(youtubeId, video, representations);
    const selection = selectRepresentation({
      candidates,
      selectedId: head.selectedRepresentationId,
      upstream: {
        capable: getCapabilities().stream.available === true,
        sourceAvailable: !(video && video.youtube_removed),
      },
    });
    return { selection, candidates, representations, head, video };
  }

  /**
   * Which copy playback should use. Never contacts YouTube: a usable local
   * copy wins even when the source is gone.
   * @returns {Promise<{youtubeId: string, revision: number, mode: string, partial: boolean,
   *   explicit: boolean, representation: (Object|null), reasons: Object[]}>}
   */
  async resolvePlayableRepresentation(youtubeId) {
    requireIdentity(youtubeId);
    const { selection, head } = await this._resolve(youtubeId);
    return {
      youtubeId,
      revision: head.revision,
      mode: selection.mode,
      partial: selection.partial,
      explicit: selection.explicit,
      representation: publicView(selection.representation),
      reasons: selection.reasons,
    };
  }

  /**
   * Run fn(lease) holding the episode's publication lease. onBusy 'proceed'
   * runs fn(null) when the lease cannot be taken (for a download whose files
   * must still be finalized; the next event reconciles).
   */
  async withPublicationLease(youtubeId, operation, fn, { waitMs = 0, onBusy = 'throw' } = {}) {
    let lease;
    try {
      lease = await store.acquireLease(youtubeId, operation, { waitMs });
    } catch (err) {
      if (onBusy !== 'proceed') throw err;
      logger.warn({ err, youtubeId, operation }, 'Could not take the episode publication lease; continuing without it');
      return fn(null);
    }
    try {
      return await fn(lease);
    } finally {
      await store.releaseLease(lease).catch(err => logger.warn({ err, youtubeId }, 'Could not release the episode publication lease'));
    }
  }

  async _withLease(youtubeId, operation, lease, fn, options) {
    return lease ? fn(lease) : this.withPublicationLease(youtubeId, operation, fn, options);
  }

  // The file a media server shows for the episode right now.
  _visibleLocation(candidates) {
    const stream = candidates.find(c => c.kind === KINDS.STRM && c.state === STATES.PUBLISHED);
    if (stream) return stream.location;
    const local = candidates.find(c => COMPLETE_LOCAL_KINDS.includes(c.kind) && c.usable && c.state === STATES.VERIFIED);
    return local ? local.location : null;
  }

  // Under the lease: when a complete local copy is usable, remove STRM
  // entries of the episode (beside the local copy and where the published
  // one was) and mark published STRM records retired.
  async _reconcileUnderLease(lease, youtubeId) {
    const { selection, candidates } = await this._resolve(youtubeId);
    const local = selection.mode === MODES.LOCAL && !selection.partial ? selection.representation : null;
    if (!local) return { removed: [], retired: 0 };
    const streams = candidates.filter(c => c.kind === KINDS.STRM);
    const locations = new Set(await findStreamEntries(path.dirname(local.location), youtubeId));
    for (const stream of streams) {
      if (isStreamEntryFor(stream.location, youtubeId)) locations.add(stream.location);
    }
    const removed = [];
    for (const location of locations) {
      try {
        if (await fs.pathExists(location)) {
          await fs.remove(location);
          removed.push(location);
        }
      } catch (err) {
        logger.warn({ err, location }, 'Could not remove a STRM entry replaced by a local copy');
      }
    }
    let retired = 0;
    for (const stream of streams.filter(s => s.state === STATES.PUBLISHED)) {
      await store.record(lease, {
        kind: KINDS.STRM, variant: stream.variant, state: STATES.RETIRED, location: stream.location,
        detail: 'Replaced by the local copy',
      });
      retired += 1;
    }
    if (removed.length || retired) logger.info({ youtubeId, removed: removed.length, retired }, 'Reconciled episode to its local copy');
    return { removed, retired };
  }

  /** Converge the episode's visible entries to its selected copy. */
  async reconcile(youtubeId, { lease = null } = {}) {
    requireIdentity(youtubeId);
    return this._withLease(youtubeId, LEASE_OPERATIONS.RECONCILE, lease, l => this._reconcileUnderLease(l, youtubeId));
  }

  /**
   * Record a downloaded, verified local file as the episode's local copy,
   * retire its STRM entry and carry watch state over to the new file.
   * Idempotent: promoting the same file again changes nothing.
   * @param {string} youtubeId
   * @param {{location: string}} verifiedAsset
   * @param {{lease?: Object}} [options] - an already held publication lease
   */
  async promoteDownloadedAsset(youtubeId, verifiedAsset, { lease = null } = {}) {
    requireIdentity(youtubeId);
    const location = verifiedAsset && verifiedAsset.location;
    const check = await inspectLocalMedia(location, youtubeId);
    if (!check.usable) {
      throw new RepresentationError(422, 'unverified-asset', `The downloaded file cannot be used (${check.reason}).`);
    }
    return this._withLease(youtubeId, LEASE_OPERATIONS.DOWNLOAD_PROMOTION, lease, async (activeLease) => {
      const before = this._visibleLocation((await this._resolve(youtubeId)).candidates);
      // Persist the hold before retiring the old entry. A failed snapshot
      // must leave it intact so a retry can safely take the snapshot.
      const carryovers = before && before !== location
        ? await watchContinuity.recordCarryovers({ youtubeId, fromLocation: before, toLocation: location })
        : 0;
      const recorded = await store.record(activeLease, {
        kind: KINDS.LOCAL, state: STATES.VERIFIED, location, sizeBytes: check.sizeBytes, verified: true,
      });
      const reconciled = await this._reconcileUnderLease(activeLease, youtubeId);
      const carryoverError = null;
      return { changed: recorded.changed, revision: recorded.revision, retiredStream: reconciled.retired > 0,
        removedStreamEntries: reconciled.removed, carryovers, carryoverError };
    }, { waitMs: PROMOTION_LEASE_WAIT_MS });
  }

  async _writeStreamEntry(lease, youtubeId, write) {
    const written = await write({ youtubeId });
    const location = written && written.location;
    if (!isStreamEntryFor(location, youtubeId) || !(await fs.pathExists(location))) {
      throw new RepresentationError(500, 'invalid-stream-entry', 'The stream publisher did not write a STRM entry for this video.');
    }
    const recorded = await store.record(lease, { kind: KINDS.STRM, state: STATES.PUBLISHED, location, verified: true });
    return { location, changed: recorded.changed, revision: recorded.revision };
  }

  /**
   * Seam for #13: publish the episode's STRM entry unless a complete local
   * copy exists (then leftovers are reconciled instead and write is not
   * called). Returns { status: 'published' | 'skipped' | 'busy' }.
   */
  async publishStreamEntry(youtubeId, { write } = {}) {
    requireIdentity(youtubeId);
    if (typeof write !== 'function') throw new RepresentationError(500, 'invalid-writer', 'A STRM writer is required');
    try {
      return await this.withPublicationLease(youtubeId, LEASE_OPERATIONS.STREAM_PUBLICATION, async (lease) => {
        const { selection } = await this._resolve(youtubeId);
        if (selection.mode === MODES.LOCAL && !selection.partial) {
          const reconciled = await this._reconcileUnderLease(lease, youtubeId);
          return { status: 'skipped', reason: 'local-copy', removed: reconciled.removed };
        }
        return { status: 'published', ...(await this._writeStreamEntry(lease, youtubeId, write)) };
      });
    } catch (err) {
      if (err.code === 'LEASE_BUSY') return { status: 'busy' };
      throw err;
    }
  }

  /**
   * What evicting the local copy would do. Eviction removes only the media
   * file; metadata, captions and artwork stay for the streamable episode.
   */
  async previewLocalEviction(youtubeId) {
    requireIdentity(youtubeId);
    const { selection, head, video } = await this._resolve(youtubeId);
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
    if (getCapabilities().stream.available !== true) {
      refuse('stream_unavailable', 'Streaming is not available, so removing the local copy would leave nothing to play. Delete the video instead.');
    } else if (!this._streamPublisher) {
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
   * Evict the local copy after a preview: publish the STRM entry first, then
   * remove only the media file. Refused unless the preview allows it and
   * nothing changed since (expectedRevision).
   */
  async evictLocalCopy(youtubeId, { expectedRevision } = {}) {
    requireIdentity(youtubeId);
    return this.withPublicationLease(youtubeId, LEASE_OPERATIONS.EVICTION, async (lease) => {
      const preview = await this.previewLocalEviction(youtubeId);
      if (!preview.allowed) {
        throw new RepresentationError(409, 'eviction-refused', preview.reasons[0].message, preview.reasons);
      }
      if (expectedRevision !== undefined && expectedRevision !== preview.revision) {
        throw new store.RepresentationRevisionError(preview.revision);
      }
      const { selection } = await this._resolve(youtubeId);
      const local = selection.representation;
      const stream = await this._writeStreamEntry(lease, youtubeId, this._streamPublisher.write.bind(this._streamPublisher));
      await fs.remove(local.location);
      await store.record(lease, {
        kind: local.kind, variant: local.variant || '', state: STATES.EVICTED, location: local.location,
        sizeBytes: local.sizeBytes ?? null, detail: EVICTION_DETAIL,
      });
      await Video.update(removedColumns('user_deleted', { detail: EVICTION_DETAIL }), { where: { youtubeId } });
      const carryovers = await watchContinuity.recordCarryovers({ youtubeId, fromLocation: local.location, toLocation: stream.location });
      logger.info({ youtubeId, removed: local.location, stream: stream.location }, 'Evicted the local copy; the episode stays streamable');
      return { youtubeId, removed: [local.location], kept: preview.keep, streamLocation: stream.location, carryovers };
    });
  }

  /** Explicitly select a version (null returns to automatic selection). */
  async selectVersion(youtubeId, representationId, { expectedRevision } = {}) {
    requireIdentity(youtubeId);
    if (representationId !== null && !Number.isInteger(representationId)) {
      throw new RepresentationError(400, 'invalid-selection', 'representationId must be an integer or null');
    }
    try {
      await this.withPublicationLease(youtubeId, LEASE_OPERATIONS.SELECTION,
        lease => store.select(lease, representationId, { expectedRevision }));
    } catch (err) {
      if (err.code === 'NOT_FOUND') throw new RepresentationError(404, 'not-found', err.message);
      throw err;
    }
    return this.resolvePlayableRepresentation(youtubeId);
  }

  /** Everything the representation API reports for one episode. */
  async getStatus(youtubeId) {
    requireIdentity(youtubeId);
    const { selection, candidates, head } = await this._resolve(youtubeId);
    return {
      youtubeId,
      revision: head.revision,
      selectedRepresentationId: head.selectedRepresentationId,
      lease: head.lease,
      playback: {
        mode: selection.mode,
        partial: selection.partial,
        explicit: selection.explicit,
        representation: publicView(selection.representation),
        reasons: selection.reasons,
      },
      representations: candidates.map(c => ({ ...publicView(c), usable: !!c.usable, detail: c.detail || null })),
      watchCarryovers: await watchContinuity.listForYoutubeId(youtubeId),
      eviction: await this.previewLocalEviction(youtubeId),
    };
  }
}

const representations = new EpisodeRepresentations();
representations.RepresentationError = RepresentationError;
representations.RepresentationLeaseError = store.RepresentationLeaseError;
representations.RepresentationRevisionError = store.RepresentationRevisionError;
representations.PROMOTION_LEASE_WAIT_MS = PROMOTION_LEASE_WAIT_MS;

module.exports = representations;
