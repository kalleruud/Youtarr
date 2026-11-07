// Episode representations (issue #14): one logical episode, keyed by its
// YouTube id (#6's stable identity), with any number of playable copies - a
// verified local file, a STRM entry, a cache or a recording. This facade is
// the only writer of those copies' records and decides which one plays.
//
// Single-entry strategy: controlled file replacement. A downloaded file is
// published under the STRM entry's exact stem (the TV publisher keeps an
// existing episode's stem) and the STRM entry is removed as the media file
// lands. The watch state the media server kept on the item that goes away is
// recorded durably (watchContinuity) BEFORE anything visible changes, and is
// restored onto the new item; when it cannot be recorded, the old entry stays
// until a later event, or the periodic reconcile pass, records it. Changes
// run under the episode's publication lease, re-checked right before each
// filesystem change. A download may still publish without it (no STRM entry
// in its folder, a busy lease, a database error), so nothing relies on the
// lease alone: an eviction deletes only the very file it previewed
// (localTombstone), every operation reconciles leftovers of the others, a
// local file always wins over a STRM entry, and the reconcile pass converges
// whatever is left.
const fs = require('fs-extra');
const path = require('path');
const logger = require('../../logger');
const Video = require('../../models/video');
const { getCapabilities } = require('../acquisition/capabilities');
const { isYoutubeIdentity } = require('../tvPublication/tvNaming');
const store = require('./representationStore');
const watchContinuity = require('./watchContinuity');
const { selectRepresentation } = require('./selectRepresentation');
const eviction = require('./eviction');
const reconcilePass = require('./reconcilePass');
const downloadPublication = require('./downloadPublication');
const { RepresentationError } = require('./representationError');
const { inspectLocalMedia, isStreamEntryFor, findStreamEntries, findLocalMedia } = require('./localAsset');
const { KINDS, STATES, MODES, LEASE_OPERATIONS } = require('./representationValues');

const { PROMOTION_LEASE_WAIT_MS } = downloadPublication;

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
    // An evicted record does not hide a file the library row says is back
    // (a download that landed during or after the eviction).
    const known = new Set(representations.filter(rep => rep.state !== STATES.EVICTED).map(rep => rep.location));
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

  /** Run fn(lease) holding the episode's publication lease. */
  async withPublicationLease(youtubeId, operation, fn, { waitMs = 0 } = {}) {
    const lease = await store.acquireLease(youtubeId, operation, { waitMs });
    try {
      return await fn(lease);
    } finally {
      await store.releaseLease(lease).catch(err => logger.warn({ err, youtubeId }, 'Could not release the episode publication lease'));
    }
  }

  async _withLease(youtubeId, operation, lease, fn, options) {
    return lease ? fn(lease) : this.withPublicationLease(youtubeId, operation, fn, options);
  }

  // Right before every filesystem change: the lease must still be ours, and
  // is extended. A holder that paused past its lease (and was taken over)
  // stops here instead of changing files under the new holder.
  async _confirmLease(lease) {
    if (lease) await store.renewLease(lease);
  }

  /**
   * Whether the episode has a copy other than a local file (a STRM entry,
   * cache or recording). A download of a video without one never waits for
   * the publication lease.
   */
  async hasNonLocalRepresentation(youtubeId) {
    return (await store.list(youtubeId)).some(rep => rep.kind !== KINDS.LOCAL);
  }

  // The STRM entry whose media server item may hold watch state that a local
  // copy at `location` takes over: the published one, else - while
  // `location` is not recorded yet, i.e. a promotion that was interrupted
  // after the STRM was retired - the retired one. Null without a STRM record:
  // the sync never matched a STRM item of the video, so nothing is at stake.
  _streamSource(candidates, location) {
    const published = candidates.find(c => c.kind === KINDS.STRM && c.state === STATES.PUBLISHED && c.location && c.location !== location);
    if (published) return published.location;
    const recorded = candidates.some(c => c.kind === KINDS.LOCAL && !c.legacy && c.state === STATES.VERIFIED && c.location === location);
    if (recorded) return null;
    const retired = candidates.find(c => c.kind === KINDS.STRM && c.state === STATES.RETIRED && c.location && c.location !== location);
    return retired ? retired.location : null;
  }

  // Durably hold the STRM item's watch state for the local copy at
  // `location`. Idempotent, so every retry repairs a snapshot an
  // interrupted run did not record.
  async _snapshotForLocal(youtubeId, candidates, location) {
    const source = this._streamSource(candidates, location);
    return source ? watchContinuity.ensureCarryovers({ youtubeId, fromLocation: source, toLocation: location }) : 0;
  }

  // Under the lease: when a complete local copy is usable, remove STRM
  // entries of the episode (beside the local copy and where the published
  // one was) and mark published STRM records retired. The watch state the
  // STRM item may hold is recorded first; if that fails, the entry stays
  // (the episode is still playable) and the next event retries.
  async _reconcileUnderLease(lease, youtubeId) {
    const { selection, candidates } = await this._resolve(youtubeId);
    const local = selection.mode === MODES.LOCAL && !selection.partial ? selection.representation : null;
    if (!local) return { removed: [], retired: 0 };
    const streams = candidates.filter(c => c.kind === KINDS.STRM);
    const locations = new Set(await findStreamEntries(path.dirname(local.location), youtubeId));
    for (const stream of streams) {
      if (isStreamEntryFor(stream.location, youtubeId)) locations.add(stream.location);
    }
    const present = [];
    for (const location of locations) {
      if (await fs.pathExists(location)) present.push(location);
    }
    const published = streams.filter(s => s.state === STATES.PUBLISHED);
    if (present.length === 0 && published.length === 0) return { removed: [], retired: 0 };
    try {
      await this._snapshotForLocal(youtubeId, candidates, local.location);
    } catch (err) {
      logger.warn({ err, youtubeId }, 'Could not record the watch state of the STRM entry; leaving it in place until a later event');
      return { removed: [], retired: 0, snapshotError: err };
    }
    await this._confirmLease(lease);
    const removed = [];
    for (const location of present) {
      try {
        await fs.remove(location);
        removed.push(location);
      } catch (err) {
        logger.warn({ err, location }, 'Could not remove a STRM entry replaced by a local copy');
      }
    }
    // A record stays published while its entry is still on disk, so the
    // periodic reconcile pass retries the removal.
    const failed = new Set(present.filter(location => !removed.includes(location)));
    let retired = 0;
    for (const stream of published.filter(s => !failed.has(s.location))) {
      await store.record(lease, {
        kind: KINDS.STRM, variant: stream.variant, state: STATES.RETIRED, location: stream.location,
        detail: 'Replaced by the local copy',
      });
      retired += 1;
    }
    // A copy known only from the library row becomes a recorded one.
    if (local.legacy && (removed.length || retired)) {
      await store.record(lease, {
        kind: KINDS.LOCAL, state: STATES.VERIFIED, location: local.location, sizeBytes: local.sizeBytes ?? null, verified: true,
      });
    }
    if (removed.length || retired) logger.info({ youtubeId, removed: removed.length, retired }, 'Reconciled episode to its local copy');
    return { removed, retired, failed: failed.size };
  }

  /** Converge the episode's visible entries to its selected copy. */
  async reconcile(youtubeId, { lease = null } = {}) {
    requireIdentity(youtubeId);
    return this._withLease(youtubeId, LEASE_OPERATIONS.RECONCILE, lease, l => this._reconcileUnderLease(l, youtubeId));
  }

  /**
   * Periodic convergence (after the filesystem rescan): every episode with a
   * published STRM entry and a local copy is reconciled, so a STRM entry
   * kept after a failed watch-state snapshot is removed once one succeeds,
   * without waiting for another event. See reconcilePass.
   */
  async reconcileDuplicateEntries(options) {
    return reconcilePass.run(this, options);
  }

  /**
   * Record a downloaded, verified local file as the episode's local copy,
   * retire its STRM entry and carry watch state over to the new file.
   * Idempotent: promoting the same file again changes nothing.
   * @param {string} youtubeId
   * @param {{location: string}} verifiedAsset
   * @param {{lease?: Object, waitMs?: number}} [options] - an already held
   *   publication lease; without one, how long to wait for it (by default
   *   PROMOTION_LEASE_WAIT_MS, but only when the episode has a non-local copy)
   */
  async promoteDownloadedAsset(youtubeId, verifiedAsset, { lease = null, waitMs } = {}) {
    requireIdentity(youtubeId);
    const location = verifiedAsset && verifiedAsset.location;
    const check = await inspectLocalMedia(location, youtubeId);
    if (!check.usable) {
      throw new RepresentationError(422, 'unverified-asset', `The downloaded file cannot be used (${check.reason}).`);
    }
    let wait = waitMs || 0;
    if (!lease && waitMs === undefined && await this.hasNonLocalRepresentation(youtubeId)) wait = PROMOTION_LEASE_WAIT_MS;
    return this._withLease(youtubeId, LEASE_OPERATIONS.DOWNLOAD_PROMOTION, lease, async (activeLease) => {
      const { candidates } = await this._resolve(youtubeId);
      // Durable before the STRM entry is retired; a failure leaves it
      // published so a retry takes the snapshot.
      const carryovers = await this._snapshotForLocal(youtubeId, candidates, location);
      const recorded = await store.record(activeLease, {
        kind: KINDS.LOCAL, state: STATES.VERIFIED, location, sizeBytes: check.sizeBytes, verified: true,
      });
      const reconciled = await this._reconcileUnderLease(activeLease, youtubeId);
      return {
        changed: recorded.changed, revision: recorded.revision, retiredStream: reconciled.retired > 0,
        removedStreamEntries: reconciled.removed, carryovers,
        snapshotError: reconciled.snapshotError ? reconciled.snapshotError.message : null,
      };
    }, { waitMs: wait });
  }

  /**
   * Publish a finished download as the episode's visible file and promote it
   * (TV layout); never fails the download because of representations. See
   * downloadPublication.publish.
   * @param {string} youtubeId
   * @param {{plannedLocation: string, publish: function({keepStreamEntries: boolean}): Promise<{mediaPath: string}>}} options
   * @returns {Promise<{mediaPath: string}>} what publish returned
   */
  async publishDownloadedEpisode(youtubeId, options) {
    return downloadPublication.publish(this, youtubeId, options);
  }

  // Leave one entry when a local media file sits beside a STRM entry this
  // operation wrote: the local file wins. With the lease, the STRM item's
  // watch state is recorded first, the STRM record retired and the file
  // recorded as the local copy (a download that published without the lease
  // could not record it); without the lease (lost before the entry was
  // recorded, so no sync matched it), only the STRM file is removed and the
  // next event fixes the records.
  async _yieldToLocalMedia(lease, youtubeId, streamLocation) {
    // A partial recording is not a complete local copy; it never wins.
    const partial = new Set((await store.list(youtubeId)).filter(rep => rep.state === STATES.PARTIAL).map(rep => rep.location));
    const media = (await findLocalMedia(path.dirname(streamLocation), youtubeId)).filter(location => !partial.has(location));
    if (media.length === 0) return false;
    if (lease) {
      try {
        await watchContinuity.ensureCarryovers({ youtubeId, fromLocation: streamLocation, toLocation: media[0] });
      } catch (err) {
        logger.warn({ err, youtubeId }, 'Could not record the watch state of the STRM entry; leaving it beside the local copy until a later event');
        return false;
      }
      await this._confirmLease(lease);
    }
    await fs.remove(streamLocation);
    if (lease) {
      await store.record(lease, {
        kind: KINDS.STRM, state: STATES.RETIRED, location: streamLocation, detail: 'Replaced by the local copy',
      });
      const check = await inspectLocalMedia(media[0], youtubeId);
      if (check.usable) {
        await store.record(lease, {
          kind: KINDS.LOCAL, state: STATES.VERIFIED, location: media[0], sizeBytes: check.sizeBytes, verified: true,
        });
      }
    }
    logger.info({ youtubeId, removed: streamLocation, local: media[0] }, 'Removed a STRM entry written beside a local copy');
    return true;
  }

  async _writeStreamEntry(lease, youtubeId, write) {
    await this._confirmLease(lease);
    const written = await write({ youtubeId });
    const location = written && written.location;
    if (!isStreamEntryFor(location, youtubeId) || !(await fs.pathExists(location))) {
      throw new RepresentationError(500, 'invalid-stream-entry', 'The stream publisher did not write a STRM entry for this video.');
    }
    try {
      const recorded = await store.record(lease, { kind: KINDS.STRM, state: STATES.PUBLISHED, location, verified: true });
      return { location, changed: recorded.changed, revision: recorded.revision };
    } catch (err) {
      if (err.code === 'LEASE_LOST') {
        // Taken over while the entry was written: a download may have
        // published its file meanwhile, and then this entry must go.
        await this._yieldToLocalMedia(null, youtubeId, location)
          .catch(yieldErr => logger.warn({ err: yieldErr, youtubeId }, 'Could not remove a STRM entry written after the lease was lost'));
      }
      throw err;
    }
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
        const written = await this._writeStreamEntry(lease, youtubeId, write);
        // A download that published without the lease (it was busy) may have
        // landed meanwhile; the holder converges the episode to it.
        if (await this._yieldToLocalMedia(lease, youtubeId, written.location)) {
          return { status: 'skipped', reason: 'local-copy', removed: [written.location] };
        }
        return { status: 'published', ...written };
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
    return eviction.preview(this, youtubeId);
  }

  /** Evict the local copy after a preview (see eviction.evict). */
  async evictLocalCopy(youtubeId, { expectedRevision } = {}) {
    requireIdentity(youtubeId);
    return eviction.evict(this, youtubeId, { expectedRevision });
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
