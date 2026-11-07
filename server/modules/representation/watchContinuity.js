// Watch continuity across a change of an episode's published file (issue #14).
//
// Youtarr keeps watch state per videos row (video_watch_status), so it
// survives a stream -> download promotion inside Youtarr. A media server does
// not: replacing "<stem>.strm" with "<stem>.mp4" makes Jellyfin create a new,
// unwatched item, and the watch-status sync would then read the old state as
// "marked unwatched" and reset the stored rows. So a promotion records a
// carryover per (video, server, user) with stored watch state, and the sync:
//   - holds back resets of those rows while the carryover is not settled;
//   - restores the state onto the new item once the server has scanned it,
//     unless the user already watched the new item (then theirs wins);
//   - settles the carryover once the server lists the new item with state.
// Nothing is ever reset because of a carryover; an unsupported server or a
// failed restore keeps the stored rows (they stay visible in Youtarr).
const { Op } = require('sequelize');
const logger = require('../../logger');
const Video = require('../../models/video');
const VideoWatchStatus = require('../../models/videowatchstatus');
const WatchStateCarryover = require('../../models/watchStateCarryover');
const { MediaServerUnavailableError } = require('../mediaServers/adapters/baseAdapter');

const CARRYOVER_STATUSES = Object.freeze({
  PENDING: 'pending',
  RESTORED: 'restored',
  SUPERSEDED: 'superseded',
  UNSUPPORTED: 'unsupported',
  FAILED: 'failed',
});
// Statuses whose stored rows the sync must not reset.
const HOLDING_STATUSES = Object.freeze([
  CARRYOVER_STATUSES.PENDING, CARRYOVER_STATUSES.RESTORED, CARRYOVER_STATUSES.UNSUPPORTED, CARRYOVER_STATUSES.FAILED,
]);
// About a week at the default 4-hour sync: long enough for a slow library scan.
const MAX_RESTORE_ATTEMPTS = 42;
// Bounds one sync's restore work per server.
const MAX_RESTORES_PER_RUN = 200;
const ERROR_MAX_LENGTH = 255;

const rowKey = (videoId, serverUserId) => `${videoId}:${serverUserId}`;

function hasWatchState(row) {
  return !!row.played || row.play_count > 0 || row.position_ms > 0 || row.percent_watched > 0 || row.last_watched_at != null;
}

function stateOf(row) {
  return {
    played: !!row.played,
    playCount: Number(row.play_count) || 0,
    positionMs: row.position_ms == null ? null : Number(row.position_ms),
    percentWatched: row.percent_watched == null ? null : Number(row.percent_watched),
    lastWatchedAt: row.last_watched_at ? new Date(row.last_watched_at) : null,
  };
}

function basenameOf(location) {
  const match = String(location || '').match(/[^\\/]+$/);
  return match ? match[0] : '';
}

class WatchContinuity {
  get STATUSES() { return CARRYOVER_STATUSES; }

  /**
   * Record the stored watch state of a video for restoration at toLocation.
   * Replaces any earlier carryover of the same (video, server, user).
   * @returns {Promise<number>} carryovers recorded
   */
  async recordCarryovers({ youtubeId, fromLocation, toLocation }) {
    if (!toLocation || fromLocation === toLocation) return 0;
    const video = await Video.findOne({ where: { youtubeId }, attributes: ['id'] });
    if (!video) return 0;
    const rows = (await VideoWatchStatus.findAll({ where: { video_id: video.id }, raw: true })).filter(hasWatchState);
    if (rows.length === 0) return 0;
    const now = new Date();
    await WatchStateCarryover.bulkCreate(rows.map(row => ({
      video_id: video.id,
      youtube_id: youtubeId,
      server_type: row.server_type,
      server_user_id: String(row.server_user_id),
      played: !!row.played,
      play_count: row.play_count || 0,
      position_ms: row.position_ms,
      percent_watched: row.percent_watched,
      last_watched_at: row.last_watched_at,
      from_location: fromLocation || null,
      to_location: toLocation,
      status: CARRYOVER_STATUSES.PENDING,
      attempts: 0,
      last_error: null,
      created_at: now,
      updated_at: now,
    })), {
      updateOnDuplicate: [
        'youtube_id', 'played', 'play_count', 'position_ms', 'percent_watched', 'last_watched_at',
        'from_location', 'to_location', 'status', 'attempts', 'last_error', 'updated_at',
      ],
    });
    logger.info({ youtubeId, carryovers: rows.length }, 'Recorded watch state to carry over to the new media server item');
    return rows.length;
  }

  /** Carryovers of one video, for the representation status API. */
  async listForYoutubeId(youtubeId) {
    const rows = await WatchStateCarryover.findAll({ where: { youtube_id: youtubeId }, raw: true });
    return rows.map(row => ({
      serverType: row.server_type,
      serverUserId: row.server_user_id,
      status: row.status,
      attempts: row.attempts,
      lastError: row.last_error,
      toLocation: row.to_location,
      updatedAt: row.updated_at,
    }));
  }

  async _setStatus(row, status, { attempts = row.attempts, error = null } = {}) {
    await WatchStateCarryover.update(
      { status, attempts, last_error: error ? String(error).slice(0, ERROR_MAX_LENGTH) : null, updated_at: new Date() },
      { where: { id: row.id } }
    );
    row.status = status;
  }

  async _failedAttempt(row, error) {
    const attempts = row.attempts + 1;
    const status = attempts >= MAX_RESTORE_ATTEMPTS ? CARRYOVER_STATUSES.FAILED : CARRYOVER_STATUSES.PENDING;
    await this._setStatus(row, status, { attempts, error });
  }

  /**
   * Before a server's watch-state fetch: restore pending carryovers through
   * the adapter's restoreWatchStates, and report which stored rows the sync
   * must not reset. Rethrows MediaServerUnavailableError (the sync skips the
   * server); any other failure keeps every carryover holding.
   * @returns {Promise<{held: Set<string>, restoredYoutubeIds: string[], carryovers: Object[]}>}
   */
  async prepareServer(adapter) {
    const serverType = adapter.serverType;
    const rows = await WatchStateCarryover.findAll({
      where: { server_type: serverType, status: { [Op.in]: HOLDING_STATUSES } },
      order: [['id', 'ASC']],
      raw: true,
    });
    const restoredYoutubeIds = new Set();
    const pending = rows.filter(row => row.status === CARRYOVER_STATUSES.PENDING).slice(0, MAX_RESTORES_PER_RUN);
    if (pending.length > 0) {
      if (typeof adapter.restoreWatchStates !== 'function') {
        for (const row of pending) {
          await this._setStatus(row, CARRYOVER_STATUSES.UNSUPPORTED,
            { error: `${serverType} does not support restoring watch state; Youtarr keeps the stored state` });
        }
      } else {
        await this._restore(adapter, pending, restoredYoutubeIds);
      }
    }
    const held = new Set(rows.filter(row => HOLDING_STATUSES.includes(row.status))
      .map(row => rowKey(row.video_id, row.server_user_id)));
    return { held, restoredYoutubeIds: [...restoredYoutubeIds], carryovers: rows };
  }

  async _restore(adapter, pending, restoredYoutubeIds) {
    let results;
    try {
      results = await adapter.restoreWatchStates(pending.map(row => ({
        key: String(row.id), path: row.to_location, serverUserId: row.server_user_id, state: stateOf(row),
      })));
    } catch (err) {
      if (err instanceof MediaServerUnavailableError) throw err;
      logger.warn({ err, serverType: adapter.serverType }, 'Could not restore carried-over watch state; will retry next sync');
      for (const row of pending) await this._failedAttempt(row, 'restore request failed');
      return;
    }
    for (const row of pending) {
      const result = results.get(String(row.id)) || { status: 'error', message: 'no result' };
      if (result.status === 'restored') {
        await this._setStatus(row, CARRYOVER_STATUSES.RESTORED);
        restoredYoutubeIds.add(row.youtube_id);
      } else if (result.status === 'superseded') {
        await this._setStatus(row, CARRYOVER_STATUSES.RESTORED);
      } else if (result.status === 'not-found') {
        await this._failedAttempt(row, 'the media server has not scanned the new file yet');
      } else {
        await this._failedAttempt(row, result.message || 'restore failed');
      }
    }
    logger.info({
      serverType: adapter.serverType,
      attempted: pending.length,
      restored: pending.filter(row => row.status === CARRYOVER_STATUSES.RESTORED).length,
    }, 'Processed carried-over watch state');
  }

  /**
   * After a server's listing was matched: a holding carryover whose
   * (video, user) the server now lists at the new file has been settled by
   * the server itself (the user watched the new item), so it stops holding.
   */
  async settleListed(prepared, listed) {
    const holding = (prepared.carryovers || []).filter(row => HOLDING_STATUSES.includes(row.status));
    if (holding.length === 0) return;
    const listedPaths = new Map();
    for (const { video, entry } of listed) {
      const key = rowKey(video.id, entry.serverUserId);
      if (!listedPaths.has(key)) listedPaths.set(key, new Set());
      listedPaths.get(key).add(basenameOf(entry.path));
    }
    for (const row of holding) {
      const key = rowKey(row.video_id, row.server_user_id);
      if (listedPaths.get(key)?.has(basenameOf(row.to_location))) {
        await this._setStatus(row, CARRYOVER_STATUSES.SUPERSEDED);
        prepared.held.delete(key);
      }
    }
  }
}

const watchContinuity = new WatchContinuity();
watchContinuity.rowKey = rowKey;
watchContinuity.MAX_RESTORE_ATTEMPTS = MAX_RESTORE_ATTEMPTS;

module.exports = watchContinuity;
