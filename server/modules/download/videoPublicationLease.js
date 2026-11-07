/**
 * Per-video publication lease: an in-process keyed mutex that writers of a
 * video's caption sidecars and caption rows hold across their mutations, so
 * a delayed caption check and the server-side download finalization of the
 * same video never interleave. Waiters are served in arrival order.
 *
 * The per-video post-processor runs in yt-dlp's child process and cannot take
 * an in-process lock; download runs are covered by `archiveAccess` through finalization (per-video
 * activity can end earlier). Enrichment re-checks both immediately before
 * sidecar rename/unlink. This is not a cross-process lock: a download can
 * start between that check and the filesystem operation. PR #29's
 * cross-process `captionLease` can later replace this with the same
 * acquire/release shape.
 */
class VideoPublicationLease {
  constructor() {
    this.tails = new Map();
  }

  /**
   * Wait for the video's lease.
   * @param {string} youtubeId
   * @returns {Promise<() => Promise<void>>} release (idempotent)
   */
  async acquire(youtubeId) {
    const previous = this.tails.get(youtubeId) || Promise.resolve();
    let unlock;
    const current = new Promise((resolve) => { unlock = resolve; });
    const tail = previous.then(() => current);
    this.tails.set(youtubeId, tail);
    await previous;
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      unlock();
      if (this.tails.get(youtubeId) === tail) this.tails.delete(youtubeId);
    };
  }

  /** Whether someone holds or waits for the video's lease. */
  isHeld(youtubeId) {
    return this.tails.has(youtubeId);
  }

  async withLease(youtubeId, run) {
    const release = await this.acquire(youtubeId);
    try {
      return await run();
    } finally {
      await release();
    }
  }
}

module.exports = new VideoPublicationLease();
module.exports.VideoPublicationLease = VideoPublicationLease;
