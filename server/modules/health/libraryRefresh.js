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
// At most this many shows are worked through per completed job; the rest stay
// pending and can be retried from the health view.
const MAX_SHOWS_PER_BATCH = 25;

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
    this.queue = Promise.resolve();
    this.inFlightShows = new Set();
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
   * batch at a time; resolves when this batch is done. Never rejects.
   */
  enqueue(youtubeIds) {
    const run = this.queue.then(() => this._runBatch(youtubeIds));
    this.queue = run.catch(() => {});
    return run.catch((err) => {
      logger.error({ err }, 'Library refresh batch failed');
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
    const shows = [...byShow.entries()];
    for (const [showDir, items] of shows.slice(0, MAX_SHOWS_PER_BATCH)) {
      if (this.inFlightShows.has(showDir)) continue;
      this.inFlightShows.add(showDir);
      try {
        await this._refreshShow(adapter, showDir, items);
      } finally {
        this.inFlightShows.delete(showDir);
      }
    }
    if (shows.length > MAX_SHOWS_PER_BATCH) {
      logger.warn({ shows: shows.length, limit: MAX_SHOWS_PER_BATCH }, 'Library refresh limited to the first shows of this batch');
    }
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
