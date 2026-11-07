// Media server user state across a TV library migration. Before the first
// file moves, the Jellyfin watched/resume state of every video in the plan and
// the user playlists that contain them are read through the adapter and kept
// with the plan. Once Jellyfin has scanned the new Shows library, restore()
// finds each new episode item by file name and writes that state back. The
// writes are scoped to this migration; the routine watch status sync stays
// read-only.
const path = require('path');
const logger = require('../../logger');
const { PlaylistSyncState } = require('../../models');
const JellyfinAdapter = require('../mediaServers/adapters/jellyfinAdapter');
const { extractBasename } = require('../mediaServers/adapters/baseAdapter');
const plexModule = require('../plexModule');

const SUPPORTED_FIELDS = ['played flag', 'play count', 'resume position', 'last played date', 'user playlist membership'];
const UNSUPPORTED_JELLYFIN_FIELDS = [
  'favorites, user ratings and likes are not carried over',
  'rollback restores files and Youtarr paths only; restored Jellyfin viewing state and appended playlist entries are not undone',
  'restored playlist entries are appended in their original order, after entries that are not Youtarr videos',
];
const YOUTUBE_ID_IN_NAME = /\[([A-Za-z0-9_-]{1,64})\][^\s[\]]*$/;

function jellyfinConfigured(config) {
  return Boolean(config.jellyfinEnabled && config.jellyfinUrl && config.jellyfinApiKey && config.jellyfinUserId);
}

/** What the migration can and cannot preserve on each configured media server. */
function describeMediaServers(config) {
  const jellyfin = jellyfinConfigured(config);
  const notes = [];
  if (plexModule.getBaseUrl(null, config) && config.plexApiKey) {
    notes.push('Plex watch state and playlists are not migrated. Point Plex at the new layout yourself or keep it on its own stack.');
  }
  if (config.embyEnabled) notes.push('Emby watch state and playlists are not migrated.');
  if (!jellyfin) {
    notes.push('Jellyfin is not configured in Youtarr, so no Jellyfin watch state or playlists can be snapshotted or restored.');
  }
  return {
    jellyfin: {
      configured: jellyfin,
      supported: jellyfin ? SUPPORTED_FIELDS : [],
      unsupported: jellyfin ? UNSUPPORTED_JELLYFIN_FIELDS : [],
    },
    notes,
    // Keyed by video, not by path, so they survive unchanged.
    youtarrData: 'Youtarr\'s own records (stored watch status, protection, playlists, download history) are keyed by video and are kept.',
  };
}

function youtubeIdOf(filePath) {
  const match = YOUTUBE_ID_IN_NAME.exec(extractBasename(filePath || ''));
  return match ? match[1] : null;
}

function adapterFor(config) {
  return jellyfinConfigured(config) ? new JellyfinAdapter(config) : null;
}

/**
 * Read the state worth keeping for the plan's videos.
 * @returns {Promise<object|null>} null when Jellyfin is not configured
 */
async function snapshot(plan, config, { adapter = adapterFor(config) } = {}) {
  if (!adapter) return null;
  const ids = new Set(plan.items.map((item) => item.youtubeId));
  const { entries, users, completeUserIds } = await adapter.fetchWatchStates({ strict: true });
  const expectedUserIds = (users || []).map((user) => user.id);
  const missingUserIds = expectedUserIds.filter((id) => !completeUserIds?.includes(id));
  if (!expectedUserIds.length || missingUserIds.length) {
    const error = new Error(`Incomplete Jellyfin watch-state snapshot; incomplete users: ${missingUserIds.join(', ') || 'user enumeration unavailable'}`);
    error.diagnostics = { expectedUserIds, completeUserIds: completeUserIds || [], missingUserIds };
    throw error;
  }
  const watch = {};
  for (const entry of entries) {
    const youtubeId = youtubeIdOf(entry.path);
    if (!ids.has(youtubeId) || !entry.serverUserId) continue;
    (watch[youtubeId] = watch[youtubeId] || []).push({
      serverUserId: entry.serverUserId,
      played: Boolean(entry.played),
      playCount: entry.playCount || 0,
      positionMs: entry.positionMs,
      lastWatchedAt: entry.lastWatchedAt ? new Date(entry.lastWatchedAt).toISOString() : null,
    });
  }
  const userIds = (users && users.length ? users.map((user) => user.id) : [adapter.userId]).filter(Boolean);
  const managed = new Set((await PlaylistSyncState.findAll({ where: { server_type: 'jellyfin' }, attributes: ['server_playlist_id'] }))
    .map((row) => row.server_playlist_id).filter(Boolean));
  const playlists = (await adapter.listUserPlaylists(userIds))
    .filter((playlist) => !managed.has(playlist.id))
    .map((playlist) => ({ ...playlist, entries: playlist.entries.map((entry) => ({ ...entry, youtubeId: youtubeIdOf(entry.path) })) }))
    .filter((playlist) => playlist.entries.some((entry) => ids.has(entry.youtubeId)));
  return {
    server: 'jellyfin',
    takenAt: new Date().toISOString(),
    users: users || [],
    watch,
    playlists,
    counts: {
      videosWithState: Object.keys(watch).length,
      userEntries: Object.values(watch).reduce((sum, list) => sum + list.length, 0),
      playlists: playlists.length,
    },
  };
}

/**
 * Write the snapshot back onto the new episode items. Idempotent: progress
 * records what was restored, and a video Jellyfin has not scanned yet stays
 * pending for the next call.
 * @param {object} plan
 * @param {object} snap - snapshot() result
 * @param {object} progress - previous restore progress ({ watch, playlists })
 * @returns {Promise<{progress: object, report: object}>}
 */
async function restore(plan, snap, progress, config, { adapter = adapterFor(config), doneIds }) {
  const next = { watch: { ...(progress?.watch || {}) }, playlists: { ...(progress?.playlists || {}) } };
  const report = { restored: 0, pending: [], failed: [], playlistsUpdated: 0, playlistsPending: 0 };
  if (!snap || !adapter) return { progress: next, report };

  const byName = new Map();
  for (const item of await adapter.listEpisodePaths()) byName.set(extractBasename(item.path), item.id);
  const newItemIds = new Map();
  for (const item of plan.items) {
    if (!doneIds.has(item.youtubeId)) continue;
    const id = byName.get(path.basename(item.media.target));
    if (id) newItemIds.set(item.youtubeId, id);
  }

  for (const [youtubeId, entries] of Object.entries(snap.watch || {})) {
    if (!doneIds.has(youtubeId)) continue;
    const itemId = newItemIds.get(youtubeId);
    if (!itemId) {
      report.pending.push(youtubeId);
      continue;
    }
    const done = new Set(next.watch[youtubeId] || []);
    for (const entry of entries) {
      if (done.has(entry.serverUserId)) continue;
      try {
        await adapter.setUserData(itemId, entry.serverUserId, entry);
        done.add(entry.serverUserId);
        report.restored += 1;
      } catch (err) {
        logger.warn({ err, youtubeId, serverUserId: entry.serverUserId }, 'Could not restore Jellyfin user data for a migrated episode');
        report.failed.push({ youtubeId, serverUserId: entry.serverUserId, error: err.message });
      }
    }
    next.watch[youtubeId] = [...done];
  }

  for (const playlist of snap.playlists || []) {
    const wanted = playlist.entries.filter((entry) => doneIds.has(entry.youtubeId)).map((entry) => entry.youtubeId);
    const resolved = wanted.map((youtubeId) => newItemIds.get(youtubeId)).filter(Boolean);
    if (resolved.length < wanted.length) report.playlistsPending += 1;
    try {
      const present = new Set(await adapter.listPlaylistItemIds(playlist.id, playlist.userId));
      const missing = resolved.filter((id) => !present.has(id));
      await adapter.addPlaylistItems(playlist.id, missing, playlist.userId);
      if (missing.length > 0) report.playlistsUpdated += 1;
      next.playlists[playlist.id] = { added: [...new Set([...(next.playlists[playlist.id]?.added || []), ...missing])] };
    } catch (err) {
      logger.warn({ err, playlistId: playlist.id }, 'Could not restore a Jellyfin playlist after the migration');
      report.failed.push({ playlistId: playlist.id, name: playlist.name, error: err.message });
    }
  }
  return { progress: next, report };
}

module.exports = { describeMediaServers, snapshot, restore, youtubeIdOf, jellyfinConfigured };
