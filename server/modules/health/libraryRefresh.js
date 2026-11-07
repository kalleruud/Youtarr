// Targeted Jellyfin refresh after TV publication (issue #18, deferred from
// #7). The post-processor records a pending `library` outcome for each
// episode it publishes; after the job, this checks whether Jellyfin lists the
// episode and, if not, refreshes only that show's Series item, re-checking a
// bounded number of times. It never scans a whole library, and its result
// only ever changes the `library` stage: a refresh failure cannot mark the
// download failed.
const path = require('path');
const logger = require('../../logger');
const configModule = require('../configModule');
const serverRegistry = require('../mediaServers/serverRegistry');
const outcomeStore = require('./outcomeStore');
const { STAGES, STATUSES, CATEGORIES } = require('./constants');

// One check right away, then re-checks while Jellyfin's refresh runs.
const CHECK_DELAYS_MS = Object.freeze([0, 30 * 1000, 2 * 60 * 1000, 5 * 60 * 1000]);
// At most this many shows run concurrently; overflow is explicitly deferred
// and can be retried from the health view.
const MAX_SHOWS_PER_BATCH = 25;
const MAX_PENDING_VIDEOS = 200;

function defaultSleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

class LibraryRefresh {
  constructor({ sleep = defaultSleep, delays = CHECK_DELAYS_MS } = {}) {
    this.sleep = sleep;
    this.delays = delays;
    this.videos = new Map();
    this.inFlightShows = new Map();
  }

  isEnabled(config = configModule.getConfig() || {}) {
    return config.jellyfinPublishRefresh !== false;
  }

  _adapter(config) {
    return serverRegistry.getEnabledAdapters(config)
      .find((adapter) => adapter.serverType === 'jellyfin' && typeof adapter.checkShowPublication === 'function') || null;
  }

  /**
   * Queue checks for the given videos' pending library outcomes. Runs one
   * bounded concurrent shows; resolves when admitted work is done. Never rejects.
   */
  canAccept(youtubeId) {
    return this.videos.has(youtubeId) || this.videos.size < MAX_PENDING_VIDEOS;
  }

  // Reserve synchronously before the asynchronous revision claim. Automatic
  // admission coalesces onto this slot until the claimed worker completes.
  async enqueueRetry(youtubeId, claim) {
    if (this.videos.has(youtubeId) || !this.canAccept(youtubeId)) return null;
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    this.videos.set(youtubeId, { promise, resolve });
    let started = false;
    try {
      const outcome = await claim();
      if (!outcome) return { outcome: null };
      this._startBatch([youtubeId], outcome);
      started = true;
      return { outcome, completion: promise };
    } finally {
      if (!started) {
        this.videos.delete(youtubeId);
        resolve();
      }
    }
  }

  enqueue(youtubeIds) {
    const waits = [];
    const admitted = [];
    let refused = false;
    for (const id of new Set(youtubeIds)) {
      if (this.videos.has(id)) {
        waits.push(this.videos.get(id).promise);
      } else if (this.videos.size < MAX_PENDING_VIDEOS) {
        let resolve;
        const promise = new Promise((done) => { resolve = done; });
        this.videos.set(id, { promise, resolve });
        admitted.push(id);
        waits.push(promise);
      } else {
        refused = true;
      }
    }
    if (admitted.length < new Set(youtubeIds).size) {
      logger.warn({ limit: MAX_PENDING_VIDEOS }, 'Library refresh admission coalesced or full; pending videos can be retried from Acquisition Health');
    }
    if (admitted.length) {
      this._startBatch(admitted);
    }
    const completion = Promise.all(waits).then(() => undefined);
    completion.accepted = !refused;
    return completion;
  }

  _startBatch(admitted, claimed = null) {
    this._runBatch(admitted).then(async () => {
      // A missing/replaced outcome or unusable publication details can leave
      // no runnable item. Release only our still-unsettled claim.
      if (claimed) {
        await this._record(claimed, STATUSES.PENDING, CATEGORIES.SCAN_PENDING,
          'refresh-deferred', 'Targeted refresh finished without confirmation; retry the library step later.', true);
      }
    }).catch(async (err) => {
      logger.error({ err }, 'Library refresh batch failed');
      if (claimed) {
        await this._record(claimed, STATUSES.PENDING, CATEGORIES.SCAN_PENDING,
          'refresh-deferred', 'Targeted refresh could not complete; retry the library step later.', true);
      }
    }).catch((err) => {
      logger.error({ err }, 'Library refresh failure could not be recorded');
    }).finally(() => {
      for (const id of admitted) {
        this.videos.get(id).resolve();
        this.videos.delete(id);
      }
    });
  }

  async _runBatch(youtubeIds) {
    const pending = [...(await outcomeStore.getStageForVideos(youtubeIds, STAGES.LIBRARY)).values()]
      .filter((o) => o.status === STATUSES.PENDING && o.details && o.details.showDir && o.details.mediaPath);
    if (!pending.length) return;

    const config = configModule.getConfig() || {};
    const adapter = this._adapter(config);
    if (!adapter || !this.isEnabled(config)) {
      const message = adapter
        ? 'Targeted Jellyfin refresh is turned off; Jellyfin\'s own library monitoring adds new episodes.'
        : 'No Jellyfin server is configured; the media server\'s own library monitoring adds new episodes.';
      for (const item of pending) {
        await this._record(item, STATUSES.SKIPPED, CATEGORIES.SCAN_PENDING, 'refresh-disabled', message, false);
      }
      return;
    }

    const byShow = new Map();
    for (const item of pending) {
      const list = byShow.get(item.details.showDir) || [];
      list.push(item);
      byShow.set(item.details.showDir, list);
    }
    await Promise.all([...byShow.entries()].map(async ([showDir, items]) => {
      // A show already being checked or beyond the concurrency bound is
      // explicitly deferred, never chained behind minutes of delayed checks.
      if (this.inFlightShows.has(showDir) || this.inFlightShows.size >= MAX_SHOWS_PER_BATCH) {
        for (const item of items) {
          await this._record(item, STATUSES.PENDING, CATEGORIES.SCAN_PENDING, 'refresh-deferred',
            'Targeted refresh capacity is busy. Jellyfin monitoring can still add this episode; retry the library step from Acquisition Health.', true);
        }
        return;
      }
      this.inFlightShows.set(showDir, true);
      const heartbeat = setInterval(() => {
        for (const item of items.filter((entry) => entry.reasonCode === 'retry-requested')) {
          outcomeStore.renewRetry(item.youtubeId, STAGES.LIBRARY, item.revision)
            .catch((err) => logger.warn({ err }, 'Library retry renewal failed'));
        }
      }, 60 * 1000);
      heartbeat.unref?.();
      try {
        await this._refreshShow(adapter, showDir, items);
      } finally {
        clearInterval(heartbeat);
        this.inFlightShows.delete(showDir);
      }
    }));
  }

  async _refreshShow(adapter, showDir, items) {
    let remaining = items;
    let refreshed = false;
    let showFound = false;
    for (let attempt = 0; attempt < this.delays.length && remaining.length; attempt += 1) {
      if (this.delays[attempt]) await this.sleep(this.delays[attempt]);
      let check;
      try {
        check = await adapter.checkShowPublication(showDir, { refresh: false });
        if (check.status === 'listed') {
          showFound = true;
          remaining = await this._settleVisible(remaining, check.files, attempt);
          if (remaining.length && !refreshed) {
            await adapter.checkShowPublication(showDir, { refresh: true });
            refreshed = true;
          }
        }
      } catch (err) {
        for (const item of remaining) {
          await this._record(item, STATUSES.FAILED, CATEGORIES.APPLICATION_FAILURE, 'jellyfin-refresh-failed',
            `${err.message} The episode file is published; only Jellyfin's listing is unconfirmed.`, err.retryable !== false);
        }
        return;
      }
    }
    for (const item of remaining) {
      const message = showFound
        ? 'Jellyfin was asked to refresh this show but does not list the episode yet. Its next library scan will add it; retry the library step to check again.'
        : 'Jellyfin has not scanned this show folder yet. Its real-time monitoring or next library scan will add it; retry the library step to check again.';
      await this._record(item, STATUSES.PENDING, CATEGORIES.SCAN_PENDING, showFound ? 'episode-not-listed' : 'show-not-found', message, true);
    }
  }

  async _settleVisible(items, files, attempt) {
    const remaining = [];
    for (const item of items) {
      if (files.has(path.basename(item.details.mediaPath))) {
        await this._record(item, STATUSES.OK, CATEGORIES.OK, 'listed-in-jellyfin',
          `Jellyfin lists this episode${attempt ? ' after a targeted show refresh' : ''}.`, false);
      } else {
        remaining.push(item);
      }
    }
    return remaining;
  }

  _record(item, status, category, reasonCode, message, retryable) {
    return outcomeStore.record({
      youtubeId: item.youtubeId,
      expectedRevision: item.revision,
      stage: STAGES.LIBRARY,
      status,
      category,
      reasonCode,
      message,
      retryable,
      jobId: item.jobId,
      details: item.details,
    });
  }
}

const libraryRefresh = new LibraryRefresh();
libraryRefresh.LibraryRefresh = LibraryRefresh;
libraryRefresh.CHECK_DELAYS_MS = CHECK_DELAYS_MS;
libraryRefresh.MAX_SHOWS_PER_BATCH = MAX_SHOWS_PER_BATCH;
module.exports = libraryRefresh;
