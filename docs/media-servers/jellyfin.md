# Jellyfin Integration Guide

Complete guide for integrating Youtarr with Jellyfin Media Server.

## Table of Contents
- [Overview](#overview)
- [Library Setup](#library-setup)
- [Jellyfin TV (Shows) Output](#jellyfin-tv-shows-output)
- [Migrating Existing Downloads to the TV Layout](#migrating-existing-downloads-to-the-tv-layout)
- [Metadata Configuration](#metadata-configuration)
- [Native Playlist Sync](#native-playlist-sync)
- [Channel Playlist Files (.m3u)](#channel-playlist-files-m3u)
- [Multi-Library Organization](#multi-library-organization)
- [Troubleshooting](#troubleshooting)

## Overview

Youtarr provides full Jellyfin support through:
- NFO metadata files with complete video information
- Channel poster artwork
- Optional channel and video backdrop art
- Proper folder structure for organization
- Multi-library support for content separation
- Real-time monitoring capability
- Native playlist sync: subscribed YouTube playlists appear as Jellyfin playlists (see [Native Playlist Sync](#native-playlist-sync))

## Library Setup

### Step 1: Create a New Library

1. In Jellyfin, go to Dashboard → Libraries
2. Click "Add Media Library"
3. Configure basic settings:
   - **Content Type**: `Movies` (current recommendation; see [Choosing a library type](#choosing-a-library-type) below)
   - **Display Name**: YouTube (or your preference)

#### Choosing a library type

Youtarr writes each video as a standalone "movie" with its own NFO metadata, so two Jellyfin content types can read the library:

- **`Movies` (current recommendation)**: the most reliable option. Every video displays as a movie with full metadata and artwork. Limitation: Jellyfin will NOT automatically import Youtarr's optional per-channel `.m3u` playlist files; Jellyfin only imports playlist files from libraries whose content type is Mixed or Music. See [Channel Playlist Files (.m3u)](#channel-playlist-files-m3u).
- **`Mixed Movies and Shows`**: automatically imports the per-channel `.m3u` files as Jellyfin playlists, but comes with real risks. [Jellyfin's own documentation](https://jellyfin.org/docs/general/server/media/mixed-movies-and-shows/) says this library type "is broken and deprecated" and recommends against using it, and its TV-detection heuristics can misclassify channel content as TV series: video titles that look episode-like ("Season 3", "Episode 12") or folder names starting with digits can be picked up as episodes, and a single misdetected video folder can flip an entire channel folder into displaying as a series. This tends to work on smaller libraries and break as the library grows, since more titles means more chances for a false match.
- **`Shows`**: supported for new downloads when Settings -> Core -> **Library Output Profile** is set to **Jellyfin TV**. See [Jellyfin TV (Shows) Output](#jellyfin-tv-shows-output). Existing downloads stay in the movie layout and are not moved by this setting.

### Step 2: Add Folders

Add your Youtarr download directory:
1. Click "Add" under Folders
2. Browse to your YouTube directory
3. For subfolders, add specific paths:
   - Kids: `/path/to/youtube/__kids`
   - Music: `/path/to/youtube/__music`
   - All: `/path/to/youtube`

### Step 3: Configure Metadata Sources

In the library settings:

**Top level library settings**
1. **Preferred download language**: Your language
2. **Country**: Your country
3. **Prefer embedded titles over filenames**: Set to enabled
4. **Enable real time monitoring**: Recommended as enabled
5. **Automatically refresh metadata**: Never (metadata is all embedded/included via `.nfo`)

**Metadata downloaders** (in order):
1. Disable **ALL** metadata downloaders since metadata is included!

**Metadata savers**:
- **Disable**: Nfo

> **Warning**: Do NOT enable the Nfo metadata saver. Youtarr generates and maintains the `.nfo` file for every video it downloads. If the saver is enabled, Jellyfin will update and overwrite those files with its own data, which can cause problems for your library.

**Image fetchers**:
- Disable all internet fetchers
- Local images will be used automatically

## Jellyfin TV (Shows) Output

With `libraryOutputProfile` set to `jellyfinTv` (Settings -> Core -> Library Output Profile -> Jellyfin TV), each new video download is published as a TV episode:

```
<downloads>/[__subfolder/]
  Channel [UCxxxxxxxxxxxxxxxxxxxxxx]/        <- one show per YouTube channel (the ID keeps it stable across renames)
    tvshow.nfo
    poster.jpg                              <- show poster (portrait with "Portrait show posters", see below)
    Season 2026/                            <- one season per publication year
      season.nfo
      Channel - S2026E001 - Title [videoId].mp4
      Channel - S2026E001 - Title [videoId].nfo        <- <episodedetails>
      Channel - S2026E001 - Title [videoId].en.srt     <- language-tagged subtitles
      Channel - S2026E001 - Title [videoId]-thumb.jpg  <- episode thumbnail
```

- Season and episode numbers come from the stored episode assignment (see [docs/DATABASE.md](../DATABASE.md#tv-episode-identity)): they never change once given, so rescans, refreshes, restarts and re-downloads publish the same file again rather than a new episode. A re-downloaded or republished episode keeps its existing file name and its NFO's `dateadded`.
- The episode NFO carries the title, show title, season, episode, aired date (the assignment's publication date), plot, runtime, genres/tags, rating and the YouTube video ID as `<uniqueid type="youtube">`. `tvshow.nfo` carries the channel title, description and channel ID.
- Every file is written to a hidden `.youtarr-partial-*` file in the same folder and renamed into place; the media file is renamed last. An interrupted publication therefore never exposes a half-written file, and no episode appears until its NFO, captions and thumbnail are in place. A failed publication moves the video back to the temp folder and the download reports an error, as a failed move does.
- MP3 downloads (MP3 only, and the MP3 of video + MP3) and videos without a known publication date keep the regular layout, so no season is invented. Videos whose date correction is under review publish with the stored assignment.
- `POST /api/videos/{youtubeId}/tv-metadata/regenerate` rewrites `tvshow.nfo`, `season.nfo` and the episode NFO of an episode already in this layout from the cached `.info.json`; the media, subtitles and thumbnail are not touched and nothing is downloaded.
- The "Generate video .nfo files" setting applies to the movie layout only; TV publication always writes its NFOs.
- The episode thumbnail is published with the episode: a byte copy of the landscape YouTube thumbnail, staged and renamed like the other files. With portrait show posters on, the show poster is written to (and Jellyfin is asked to refresh) the `Channel [UC…]` show folder once it exists; until the channel's first episode is published, the regular channel folder is used.

Recommended library settings for the YouTube Shows library: Content Type **Shows**; enable the **Nfo** metadata reader; disable the **Nfo** metadata saver; disable every remote metadata downloader and image fetcher (no TheTVDB/TMDb matching for YouTube channels); mount the media folder read-only in the Jellyfin container. Jellyfin's real-time monitoring picks up new episodes; Youtarr does not yet send Jellyfin a targeted refresh after publishing.

Existing downloads are not moved by this setting; see [Migrating Existing Downloads to the TV Layout](#migrating-existing-downloads-to-the-tv-layout). Empty `Season <year>` folders left after deleting a season's last episode are not cleaned up automatically.

## Migrating Existing Downloads to the TV Layout

Settings -> Maintenance -> **Move existing downloads into the TV library** moves videos already downloaded in the regular (movie) layout into the TV layout above. Nothing is downloaded again and no request goes to YouTube: episode metadata comes from the cached `jobs/info/<id>.info.json`, or from the database row when that file is gone.

**1. Preview.** The preview writes an immutable plan and changes nothing on disk, in the library or in Jellyfin. It lists, per video, the old and new path of the media file, its subtitles and thumbnail, and the files the TV layout has no place for (the movie `.nfo`, `-fanart.jpg`, `-backdrop.jpg`), which are kept with the plan instead of in the library. It explains every video that will stay where it is:

| Reason | Meaning |
|---|---|
| `date-required` | No publication date, so no season/episode can be assigned |
| `target-exists`, `duplicate-target` | Something already uses the new name |
| `already-published` | A TV copy of the video already exists; the movie copy is left alone |
| `multiple-media` | Two video files for one video in the same folder |
| `outside-library`, `unexpected-layout` | The file is not in a channel folder of the downloads folder or a `__subfolder` |
| `not-video`, `missing-media`, `no-channel` | Audio-only download, file not on disk, or no channel recorded |
| `not-writable` | Youtarr cannot write to the folder. The migration never changes permissions; fix them yourself |

Planning blocks the plan when the downloads folder looks unmounted, or when a move across drives would not fit (with a 1 GB margin). Planning allocates the stable episode numbers the same way a download would, so the plan's numbers are final. The preview also states which Jellyfin data is preserved (per user: played flag, play count, resume position, last played date, user playlist membership) and which is not (favorites, ratings and likes; restored playlist entries are appended in their original order after entries that are not Youtarr videos; Plex and Emby state).

**2. Apply.** Applying needs the Library Output Profile set to Jellyfin TV, no running download, and a confirmation. It:

- takes the **maintenance lease** (`config/maintenance-lease.json`): new downloads are refused, queued jobs wait, automatic cleanup, the orphan folder sweep, manual deletes, channel subfolder moves, the rescan, library repair and the page-load file check all stand aside until it is released. The lease survives a restart.
- refuses the whole plan, before moving anything, when a planned file or database row changed since the preview (make a new preview).
- reads Jellyfin watch state and the user playlists containing these videos and saves them with the plan. If Jellyfin is configured but cannot be read, applying is refused unless you choose to continue without that state.
- moves video by video: show/season/episode NFOs, then subtitles and thumbnail (renamed with the episode), then the leftovers into the plan folder, then the media file, then the database row. A rename on the same drive never rewrites the bytes; a move across drives copies to a hidden staging file, compares SHA-256 hashes and only then removes the source. With "Verify checksums" on (the default), every video file is hashed before and after its move. An existing file is never overwritten. An emptied per-video folder is removed; channel folders and their artwork stay.
- regenerates the channel and playlist `.m3u` files.

Every step is checkpointed in `config/tv-migrations/<planId>/state.json`. If a move fails, or the server stops, the plan is **interrupted** and the lease stays held: fix the cause and **Resume** (it continues from the video it stopped in), or **Roll back**.

**3. Switch the Jellyfin library (by hand).** Remove the Movies/Home Videos library that scans the Youtarr folder, then add a Shows library on the same folder with the settings above. Never let both library types index the same folder. If you set Jellyfin Video Library IDs in Youtarr, replace them with the new library's ID.

**4. Restore viewing state.** Once Jellyfin has scanned the Shows library, **Restore Jellyfin viewing state** finds each new episode by file name and writes the saved state for each user, and adds the new episodes to the saved user playlists. It is idempotent: episodes Jellyfin has not found yet stay pending, so run it again after the scan. Once nothing is pending, Youtarr-managed playlists are re-synced to the media servers. These writes are scoped to the migration; the routine watch status sync stays read-only.

**Rollback** moves every started video back, puts the leftovers back, restores the database rows, and removes the show/season NFOs the migration created where no episode is left. It does not revert viewing state already written to new Jellyfin episodes, and it does not switch the Jellyfin library back.

**Before applying**, back up the `config` folder (it holds `tv-migrations/` and `config.json`) and the database. The migration does not change the database schema and touches only the `filePath` column of the migrated videos, but image rollback alone never undoes moved files. The API is documented under **Library Migration** in `/swagger`.

## Metadata Configuration

### NFO Support

Jellyfin reads NFO files containing:
- **Title**: Video title as it appears on YouTube (the NFO title never includes the channel name)
- **Plot**: Full YouTube description
- **Premiered**: Original upload date
- **Year**: Upload year
- **Studios**: Channel name
- **Genres**: YouTube categories
- **Tags**: Video keywords
- **Runtime**: Duration in minutes
- **Unique ID**: YouTube video ID

### Artwork Support

Youtarr provides:
- **`poster.jpg`**: Channel artwork in each channel folder
- **`<VIDEO NAME>.jpg`**: Video thumbnail in each video folder
- **`backdrop.jpg`**: Channel background art from the YouTube channel banner, written when "Create backdrop images" is enabled in Settings -> Core (off by default)
- **`<VIDEO NAME>-backdrop.jpg`**: Per-video background art from the video thumbnail, controlled by the same setting (new downloads only)
- Proper image naming for Jellyfin recognition
- **Portrait show posters and `<VIDEO NAME>-thumb.jpg`**: written when "Portrait show posters for Jellyfin TV" (`tvShowArtwork`) is enabled; see below

### Portrait Show Posters and Episode Thumbnails

YouTube channel avatars are square (Youtarr's cached copy is 360x360) and video thumbnails are 16:9 (1280x720). A Jellyfin Shows grid, and clients such as JellySee, expect a 2:3 show poster and a landscape episode thumbnail. With `tvShowArtwork` on:

- **Show poster (`poster.jpg` in the channel folder, 1000x1500)**, chosen in this order:
  1. The owner's uploaded poster, when selected (Channel Settings > Artwork). Uploads are checked by content (JPEG, PNG or WebP), must be portrait (width/height 0.5-0.8), at least 200x300, at most 8000 pixels per side and 10 MB, and are re-encoded without metadata. A rejected upload never replaces the current poster.
  2. The current poster, when the owner pinned it. Pinned and uploaded posters survive channel refreshes and avatar changes.
  3. An upstream image already shaped like a poster (2:3-ish, at least 300 pixels wide), copied as-is.
  4. A generated poster: the full avatar centered (never stretched or cropped) on a blurred, darkened cover of itself, with the channel title below; a solid colour derived from the channel ID when there is no avatar. Generation is deterministic: unchanged inputs produce byte-identical output and keep the same revision.
- **Episode thumbnail (`<VIDEO NAME>-thumb.jpg`)**: a byte-for-byte copy of the original 16:9 thumbnail, written for new downloads; existing episodes get it from **Regenerate & republish**. Nothing is cropped, and no video is downloaded or rewritten.
- Youtarr stores each channel's poster origin, dimensions, revision, selection and pin in the `channel_artworks` table.
- A `poster.jpg` Youtarr did not write (not its previous poster, not the matching cached square avatar copy) is kept and reported in the Artwork settings, unless the owner uploads a poster.
- When the published poster changes and Jellyfin is connected (Settings > Media Servers), Youtarr asks Jellyfin to re-read that one show's images (`POST /Items/{id}/Refresh` with a full image refresh) instead of scanning the library. The outcome is shown in Channel Settings > Artwork: a failure or a show Jellyfin has not scanned yet can be retried there. Apps can keep showing the previous image until their own image cache expires.

Manual check still required: these posters have not yet been verified in Jellyfin Web or JellySee show, season and episode views.

## Native Playlist Sync

The library and metadata setup above is all you need for downloaded videos to show up in Jellyfin. Playlist sync is separate: connect it only if you want your subscribed YouTube playlists to appear as native Jellyfin playlists.

### Step 1: Create a Jellyfin API key

1. In Jellyfin, go to **Dashboard -> API Keys**
2. Create a new key for Youtarr and copy it

### Step 2: Connect Jellyfin in Youtarr

1. In Youtarr, open **Settings -> Jellyfin Integration**
2. Enter the **Jellyfin URL** (e.g., `http://192.168.1.100:8096`) and the **API key** from Step 1
3. Open the **Jellyfin User** dropdown and pick the account that should own the playlists. (Youtarr loads the user list from your server; you can also enter the user ID by hand.)
4. (Optional) Leave **Video Library IDs** blank. Youtarr matches downloaded videos to Jellyfin items across all your libraries.
5. Click **Test Connection**, then turn on **Enable Jellyfin integration**

Once connected, open a playlist in Youtarr and turn on its Jellyfin sync chip. See [Media Server Playlists](../MEDIA_SERVER_PLAYLISTS.md) for how syncing, ordering, and updates work.

Connecting Jellyfin also enables watch status sync: Youtarr periodically pulls per-video watch state (played, percent watched, last watched) for every user on the server and shows it as Watched chips and filters on its listing pages. It's one-way; Youtarr never marks anything watched on Jellyfin. Jellyfin decides when a video counts as played: **Maximum resume percentage** under Server -> Playback -> Resume. Settings live under **Settings -> Watch Status**; see [Track Watch Status from Media Servers](../USAGE_GUIDE.md#track-watch-status-from-media-servers).

Videos inside Jellyfin Collections remain available for watch status and native playlist sync with **Group movies into collections** enabled. You do not need to change that display setting.

### Visibility

A playlist marked **Public** in Youtarr is visible to all users on the server; a **Private** one is visible only to the configured user account.

## Channel Playlist Files (.m3u)

Separately from playlist sync, each channel has an optional "Generate channel playlist file (.m3u)" setting that writes a `<Channel Name>.m3u` playlist at the top of the channel folder (see [Channel playlist file](../USAGE_GUIDE.md#channel-playlist-file-m3u)).

Whether Jellyfin picks that file up as a playlist depends entirely on the library's content type:

- **Mixed Movies and Shows**: Jellyfin imports the file automatically as a (read-only) playlist during library scans, and picks up changes on later scans.
- **Movies**: Jellyfin ignores the file. This is expected; Jellyfin only imports playlist files from Mixed or Music libraries.

If you keep the recommended Movies library type, you can still use the file outside Jellyfin: any `.m3u`-capable player (VLC, mpv, Kodi) opens it directly, or a third-party tool such as [m3u-to-jellyfin](https://github.com/warreth/m3u-to-jellyfin) can import it into Jellyfin as a native, editable playlist via the API.

## Multi-Library Organization

### Creating Separate Libraries

Organize content by type:

1. **Create multiple libraries**:
   ```
   Library: "YouTube - Kids"
   Path: /path/to/youtube/__kids

   Library: "YouTube - Music"
   Path: /path/to/youtube/__music

   Library: "YouTube - General"
   Path: /path/to/youtube
   ```

2. **Configure each library** independently:
   - Kids: Enable parental ratings
   - Music: Music-focused display options
   - General: Standard movie library settings

### Benefits

- **Access Control**: Different user permissions per library
- **Organization**: Easier content discovery
- **Performance**: Faster scanning of specific content
- **Customization**: Different metadata settings per type

### Initial Setup

1. **Start Small**: Test with one channel first
2. **Verify NFO Generation**: Check files exist before scanning
3. **Plan Structure**: Organize subfolders before adding channels
4. **Test Permissions**: Ensure Jellyfin can read all files

## Troubleshooting

### Metadata Missing

**Problem**: Videos appear but lack descriptions/details

**Solutions**:
1. Verify NFO reader is enabled
2. Check NFO file content:
   ```bash
   cat "/path/to/video.nfo"
   ```
3. Disable other metadata providers
4. Manually refresh metadata for items

### Channel .m3u Not Appearing as a Playlist

**Problem**: A channel's "Generate channel playlist file (.m3u)" setting is on and the file exists on disk, but no playlist shows up in Jellyfin

**Cause**: The library's content type is `Movies`. Jellyfin only imports playlist files from Mixed or Music libraries; this is expected behavior, not a bug. See [Channel Playlist Files (.m3u)](#channel-playlist-files-m3u) for alternatives.

### Channel Displays as a TV Series

**Problem**: In a `Mixed Movies and Shows` library, a channel (or some of its videos) shows up as a TV series with seasons/episodes and broken metadata

**Cause**: Jellyfin's mixed-library TV-detection heuristics misread episode-like video titles or folder names starting with digits. Jellyfin has deprecated this library type.

**Solution**: Change the library's content type to `Movies` (or recreate the library as `Movies`) and rescan. Channel `.m3u` playlists will no longer auto-import; see [Choosing a library type](#choosing-a-library-type) for the tradeoff.

### Poster Issues

**Problem**: Channel/video posters not displaying

**Solutions**:
1. Check poster.jpg exists in channel folders
2. Check that video file .jpg files exist in video folders
2. Verify image permissions:
   ```bash
   ls -la /path/to/channel/poster.jpg
   ```
3. Clear cache and rescan
4. Check image format (JPEG required)

## File Structure

See [docs/YOUTARR_DOWNLOADS_FOLDER_STRUCTURE.md](../YOUTARR_DOWNLOADS_FOLDER_STRUCTURE.md)

Migration safety follow-up (PR #27): a watch-state snapshot requires every enumerated user in the adapter's `completeUserIds`. Playlist enumeration and entry reads require complete, non-repeating pagination with record counts. Failures stop apply before moving files unless the owner explicitly sends `acceptUserStateLoss: true`; that override records the failure diagnostics and does not claim state preservation. Verified cross-device copies record their staging inode and checksum before publication so resume/rollback can reconcile an unlink failure without deleting an unrelated identical file.

Migration acquisition now refuses while tracked library writers are active; retry after they finish. New writer entry is blocked throughout the persistent lease. Preview and execution reject symlink descendants of configured roots, including source, destination, sidecar, NFO and leftover paths, and recheck after preview. Configured root symlinks and mount points remain supported. These checks assume external filesystem administrators do not replace ancestors concurrently during a filesystem syscall; they are not an OS sandbox. Independent review and real-library validation remain unperformed. Playlist restoration appends entries and rollback cannot undo restored Jellyfin state or appended entries; preservation completion does not mean exact playlist ordering or reversible Jellyfin writes.
