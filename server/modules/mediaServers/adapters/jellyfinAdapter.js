const axios = require('axios');
const BaseAdapter = require('./baseAdapter');
const {
  extractBasename,
  normalizeBaseUrl,
  REQUEST_TIMEOUT_MS,
  isServerUnavailableError,
  describeHttpError,
  MediaServerUnavailableError,
} = require('./baseAdapter');
const logger = require('../../../logger');

// Jellyfin/Emby report playback position in ticks (100ns units).
const TICKS_PER_MS = 10000;

const WATCH_STATE_FILTERS = [{ isPlayed: true }, { filters: 'IsResumable' }];
const WATCH_STATE_PAGE_SIZE = 1000;

class JellyfinAdapter extends BaseAdapter {
  constructor(config) {
    super(config);
    this.serverType = 'jellyfin';
    this.url = normalizeBaseUrl(config.jellyfinUrl);
    this.apiKey = String(config.jellyfinApiKey || '').trim();
    this.userId = String(config.jellyfinUserId || '').trim() || undefined;
    this.allUsers = config.jellyfinWatchStatusAllUsers !== false;
  }

  // Jellyfin 12.0 disables the legacy X-Emby-Token header by default; the
  // Authorization: MediaBrowser scheme is accepted by 10.x and 12.x alike.
  _headers() { return { Authorization: `MediaBrowser Token="${this.apiKey}"` }; }

  async testConnection() {
    try {
      const res = await axios.get(`${this.url}/System/Info`, { headers: this._headers(), timeout: REQUEST_TIMEOUT_MS });
      return { ok: true, version: res.data?.Version };
    } catch (err) {
      const status = err.response?.status;
      if (status === 401 || status === 403) {
        return {
          ok: false,
          error: 'The server is reachable but rejected the API key. Re-copy the key from the server dashboard (select only the key itself) and try again.',
        };
      }
      return { ok: false, error: err.message };
    }
  }

  async listUsers() {
    const res = await axios.get(`${this.url}/Users`, { headers: this._headers(), timeout: REQUEST_TIMEOUT_MS });
    return (res.data || []).map((u) => ({ id: u.Id, name: u.Name }));
  }

  async triggerLibraryScan() {
    try {
      await axios.post(`${this.url}/Library/Refresh`, null, { headers: this._headers(), timeout: REQUEST_TIMEOUT_MS });
    } catch (err) {
      logger.warn({ ...describeHttpError(err) }, 'jellyfin: library refresh request failed');
    }
  }

  async resolveItemIdByFilepath(filepath) {
    // Match by filename across different mount views (supports Windows paths
    // via extractBasename which splits on both / and \).
    const target = extractBasename(filepath);
    // Audio-only downloads are Audio items on the server, not Video.
    const isAudio = /\.mp3$/i.test(target);
    try {
      const params = {
        userId: this.userId,
        includeItemTypes: isAudio ? 'Audio' : 'Video,Movie,Episode',
        // Data lookups need individual movies even when Jellyfin groups collections.
        collapseBoxSetItems: false,
        recursive: true,
        fields: 'Path',
      };
      const res = await axios.get(`${this.url}/Items`, { headers: this._headers(), params, timeout: REQUEST_TIMEOUT_MS });
      const items = res.data?.Items || [];
      const match = items.find((i) => i.Path && extractBasename(i.Path) === target);
      return match ? match.Id : null;
    } catch (err) {
      if (isServerUnavailableError(err)) throw new MediaServerUnavailableError(describeHttpError(err));
      logger.warn({ ...describeHttpError(err), filepath }, 'jellyfin: could not look up library item by file path');
      return null;
    }
  }

  // The library item for a channel folder, matched by folder name because
  // Jellyfin's mount path rarely equals Youtarr's. Shows are few, so they
  // are listed whole; a folder item (mixed/home-video libraries) is looked
  // up by name. Resolves null when Jellyfin has not scanned the folder yet.
  async resolveFolderItemId(folderPath) {
    const target = extractBasename(String(folderPath).replace(/[\\/]+$/, ''));
    const lookups = [
      { includeItemTypes: 'Series' },
      { includeItemTypes: 'Folder', searchTerm: target },
    ];
    for (const lookup of lookups) {
      const params = { userId: this.userId, recursive: true, fields: 'Path', ...lookup };
      const res = await axios.get(`${this.url}/Items`, { headers: this._headers(), params, timeout: REQUEST_TIMEOUT_MS });
      const match = (res.data?.Items || []).find((i) => i.Path && extractBasename(i.Path.replace(/[\\/]+$/, '')) === target);
      if (match) return match.Id;
    }
    return null;
  }

  // Ask Jellyfin to re-read one show's local images (poster.jpg) instead of
  // scanning the library. Resolves { status, message }; never rejects.
  async refreshFolderImages(folderPath) {
    try {
      const itemId = await this.resolveFolderItemId(folderPath);
      if (!itemId) {
        return { status: 'not-found', message: 'Jellyfin has not scanned this channel folder yet; retry after its next library scan.' };
      }
      await axios.post(`${this.url}/Items/${encodeURIComponent(itemId)}/Refresh`, null, {
        headers: this._headers(),
        params: { metadataRefreshMode: 'Default', imageRefreshMode: 'FullRefresh', replaceAllImages: true, replaceAllMetadata: false },
        timeout: REQUEST_TIMEOUT_MS,
      });
      return { status: 'refreshed', message: 'Jellyfin is re-reading the poster. Apps may show the previous image until their image cache expires.' };
    } catch (err) {
      const details = describeHttpError(err);
      logger.warn({ ...details, folderPath }, 'jellyfin: artwork refresh request failed');
      return { status: 'failed', message: `Jellyfin artwork refresh failed: ${details.message || err.message}` };
    }
  }

  // Watch state per target user: every server user when
  // jellyfinWatchStatusAllUsers is on (the default), else just the configured
  // one. Only watched and in-progress items are listed; a whole-server listing
  // takes minutes on large libraries and would outlast the request timeout.
  // Everything unlisted is unwatched, so users listed in full come back as
  // completeUserIds. UserData rides along when enableUserData is set and a
  // userId is supplied (API-key auth returns no UserData otherwise). A failed
  // /Users fetch fails the whole call: silently syncing nobody would
  // masquerade as an empty success.
  async fetchWatchStates() {
    try {
      let users = [];
      let targets;
      if (this.allUsers) {
        const res = await axios.get(`${this.url}/Users`, { headers: this._headers(), timeout: REQUEST_TIMEOUT_MS });
        users = (res.data || []).map((u) => ({ id: String(u.Id), name: u.Name || null }));
        targets = users;
      } else {
        targets = [{ id: this.userId, name: null }];
      }
      const entries = [];
      const completeUserIds = [];
      for (const user of targets) {
        const { items, complete } = await this._listItemsWithWatchState(user.id);
        for (const item of items) {
          if (item.Path) entries.push(this._itemWatchState(item, user.id));
        }
        if (!user.id) continue;
        if (complete) {
          completeUserIds.push(user.id);
        } else {
          logger.warn({ serverUserId: user.id }, 'jellyfin: server repeated a page of items; keeping stored watch state for this user');
        }
      }
      return { entries, users, completeUserIds };
    } catch (err) {
      if (isServerUnavailableError(err)) throw new MediaServerUnavailableError(describeHttpError(err));
      throw err;
    }
  }

  // Server-side filters for watched, then in-progress items; combined in one
  // request they must both hold, which matches nothing. An item in both
  // listings is kept once, as watched. `complete` is false when a full page
  // brought nothing new (the server ignored startIndex), so later pages were
  // never seen. Offset paging can also skip an item when the listing shifts
  // mid-sync (an earlier item marked unwatched between two pages); that
  // resets the skipped row until the next sync, which only defers cleanup.
  async _listItemsWithWatchState(userId) {
    const itemsById = new Map();
    let complete = true;
    for (const filter of WATCH_STATE_FILTERS) {
      const seen = new Set();
      for (let startIndex = 0; ; startIndex += WATCH_STATE_PAGE_SIZE) {
        const params = {
          userId,
          includeItemTypes: 'Video,Movie,Episode',
          // Collection containers do not carry the individual videos' watch state.
          collapseBoxSetItems: false,
          recursive: true,
          fields: 'Path',
          enableUserData: true,
          sortBy: 'SortName',
          startIndex,
          limit: WATCH_STATE_PAGE_SIZE,
          ...filter,
        };
        const res = await axios.get(`${this.url}/Items`, { headers: this._headers(), params, timeout: REQUEST_TIMEOUT_MS });
        const page = res.data?.Items || [];
        let added = 0;
        for (const item of page) {
          if (seen.has(item.Id)) continue;
          seen.add(item.Id);
          added += 1;
          if (!itemsById.has(item.Id)) itemsById.set(item.Id, item);
        }
        // A short page ends the listing; a longer one means the server
        // ignored limit and returned everything.
        if (page.length !== WATCH_STATE_PAGE_SIZE) break;
        if (added === 0) {
          complete = false;
          break;
        }
      }
    }
    return { items: [...itemsById.values()], complete };
  }

  _itemWatchState(item, serverUserId) {
    const ud = item.UserData || {};
    const played = !!ud.Played;
    const positionTicks = ud.PlaybackPositionTicks != null ? Number(ud.PlaybackPositionTicks) : null;
    let percentWatched = null;
    if (played) {
      percentWatched = 100;
    } else if (ud.PlayedPercentage != null) {
      percentWatched = Math.round(Number(ud.PlayedPercentage) * 10) / 10;
    }
    return {
      path: item.Path,
      serverUserId,
      played,
      playCount: ud.PlayCount != null ? Number(ud.PlayCount) : 0,
      positionMs: positionTicks != null ? Math.round(positionTicks / TICKS_PER_MS) : null,
      percentWatched,
      lastWatchedAt: ud.LastPlayedDate ? new Date(ud.LastPlayedDate) : null,
    };
  }

  // ---- Library migration (tvMigration) only. Routine watch-status sync
  // stays read-only; these are called only when a user restores the state a
  // migration snapshotted.

  /** Every Episode item with its file path, paged: [{ id, path }]. */
  async listEpisodePaths() {
    const items = [];
    for (let startIndex = 0; ; startIndex += WATCH_STATE_PAGE_SIZE) {
      const params = {
        userId: this.userId, includeItemTypes: 'Episode', recursive: true, fields: 'Path',
        sortBy: 'SortName', startIndex, limit: WATCH_STATE_PAGE_SIZE,
      };
      const res = await axios.get(`${this.url}/Items`, { headers: this._headers(), params, timeout: REQUEST_TIMEOUT_MS });
      const page = res.data?.Items || [];
      for (const item of page) if (item.Path) items.push({ id: item.Id, path: item.Path });
      if (page.length !== WATCH_STATE_PAGE_SIZE) break;
    }
    return items;
  }

  /**
   * Playlists each user can see, with their entries in order:
   * [{ id, name, userId, entries: [{ itemId, path }] }]. A playlist visible
   * to several users is listed once, under the first of them.
   */
  async listUserPlaylists(userIds) {
    const playlists = new Map();
    for (const userId of userIds) {
      const items = await this._migrationItems('/Items', { userId, includeItemTypes: 'Playlist', recursive: true });
      for (const playlist of items) {
        if (playlists.has(playlist.Id)) continue;
        const entries = (await this._migrationItems(`/Playlists/${encodeURIComponent(playlist.Id)}/Items`, { userId, fields: 'Path' }))
          .map((item) => ({ itemId: item.Id, path: item.Path || null }));
        playlists.set(playlist.Id, { id: playlist.Id, name: playlist.Name || null, userId, entries });
      }
    }
    return [...playlists.values()];
  }

  // Migration must never treat a truncated or repeated page as a complete snapshot.
  async _migrationItems(endpoint, params) {
    const items = [];
    const seen = new Set();
    for (let startIndex = 0; ; startIndex += WATCH_STATE_PAGE_SIZE) {
      const res = await axios.get(`${this.url}${endpoint}`, {
        headers: this._headers(), params: { ...params, startIndex, limit: WATCH_STATE_PAGE_SIZE }, timeout: REQUEST_TIMEOUT_MS,
      });
      const page = res.data?.Items;
      const total = res.data?.TotalRecordCount;
      if (!Array.isArray(page) || !Number.isInteger(total) || total < 0) throw new Error('Incomplete Jellyfin playlist snapshot: missing count or items');
      for (const item of page) {
        const key = item.PlaylistItemId || item.Id;
        if (!key || seen.has(key)) throw new Error('Incomplete Jellyfin playlist snapshot: repeated page or item');
        seen.add(key);
        items.push(item);
      }
      if (items.length === total) return items;
      if (!page.length || items.length > total) throw new Error('Incomplete Jellyfin playlist snapshot: inconsistent pagination');
    }
  }

  /** Item ids currently in a playlist, in order. */
  async listPlaylistItemIds(playlistId, userId) {
    return (await this._migrationItems(`/Playlists/${encodeURIComponent(playlistId)}/Items`, { userId })).map((item) => item.Id);
  }

  async addPlaylistItems(playlistId, itemIds, userId) {
    if (itemIds.length === 0) return;
    await axios.post(`${this.url}/Playlists/${encodeURIComponent(playlistId)}/Items`, null, {
      headers: this._headers(), params: { ids: itemIds.join(','), userId }, timeout: REQUEST_TIMEOUT_MS,
    });
  }

  /**
   * Write one user's played flag, play count, resume position and last
   * played date for an item. Jellyfin 10.9+ takes /UserItems/{id}/UserData;
   * older servers only the /Users/{userId}/Items/{id}/UserData form.
   */
  async setUserData(itemId, userId, state) {
    const body = {
      Played: Boolean(state.played),
      PlayCount: Number.isFinite(state.playCount) ? state.playCount : 0,
      PlaybackPositionTicks: Number.isFinite(state.positionMs) ? Math.round(state.positionMs * TICKS_PER_MS) : 0,
      ...(state.lastWatchedAt ? { LastPlayedDate: new Date(state.lastWatchedAt).toISOString() } : {}),
    };
    const options = { headers: this._headers(), timeout: REQUEST_TIMEOUT_MS };
    try {
      await axios.post(`${this.url}/UserItems/${encodeURIComponent(itemId)}/UserData`, body, { ...options, params: { userId } });
    } catch (err) {
      if (err.response?.status !== 404) throw err;
      await axios.post(`${this.url}/Users/${encodeURIComponent(userId)}/Items/${encodeURIComponent(itemId)}/UserData`, body, options);
    }
  }

  async createPlaylist(name, itemIds, opts = {}) {
    const body = {
      Name: name,
      Ids: itemIds,
      UserId: this.userId,
      MediaType: opts.mediaType === 'audio' ? 'Audio' : 'Video',
      IsPublic: !!opts.public,
    };
    const res = await axios.post(`${this.url}/Playlists`, body, { headers: this._headers(), timeout: REQUEST_TIMEOUT_MS });
    return { id: res.data?.Id };
  }

  async replacePlaylistItems(playlistId, itemIds, opts = {}) {
    if (!opts.name) {
      throw new Error('replacePlaylistItems requires opts.name to recreate the playlist');
    }
    // Jellyfin's DELETE /Playlists/{id}/Items has version-specific quirks that
    // return 400 on current versions. Simpler and more reliable: delete the
    // whole playlist via DELETE /Items/{id} and recreate.
    // Tolerate a stale playlistId (e.g. user deleted the playlist manually or
    // the server state drifted) — log and fall through to create-fresh.
    try {
      await axios.delete(`${this.url}/Items/${playlistId}`, { headers: this._headers(), timeout: REQUEST_TIMEOUT_MS });
    } catch (err) {
      const status = err.response?.status;
      logger.warn({ status, playlistId }, 'jellyfin replacePlaylistItems: delete failed, creating fresh');
    }
    // An empty playlist cannot be created, so an emptied one stays deleted
    // (id null) until the next sync with items creates it again.
    if (itemIds.length === 0) return { id: null };
    return this.createPlaylist(opts.name, itemIds, { public: !!opts.public, mediaType: opts.mediaType });
  }
}

module.exports = JellyfinAdapter;
