# Database Configuration and Management

This document provides comprehensive information about Youtarr's database setup, configuration, troubleshooting, and management.

## Table of Contents
- [Overview](#overview)
- [Internal Database (Default)](#internal-database-default)
- [External Database Setup](#external-database-setup)
- [Database Migrations](#database-migrations)
- [Troubleshooting Database Issues](#troubleshooting-database-issues)
- [Storage Considerations](#storage-considerations)

## Overview

Youtarr uses MariaDB/MySQL for storing:
- Channel subscriptions and metadata
- Playlist subscriptions and per-server sync state
- Video information and download history
- Job queues and processing state
- Session data for authentication

### Database Tables
| Table              | Model             | Description                       |
| :----------------- | :-------------    | :-------------------------------- |
| `channels`         | `Channel`         | YouTube channel information. `m3u_enabled` (boolean, default false): generate a `.m3u` playlist file in the channel folder. `m3u_sort_order` (string, default `oldest_first`): `.m3u` entry order, `oldest_first` or `newest_first`. `auto_removal_protected` (boolean, default false): exclude every video of this channel from auto-removal; only applies while the channel is subscribed (`enabled`), and enabling it clears `auto_removal_keep_recent_count`. `auto_removal_keep_recent_count` (int, nullable): auto-removal always keeps this many of the channel's most recently downloaded videos; mutually exclusive with `auto_removal_protected`, dormant while the channel is unsubscribed. `additional_tags` (text, nullable, default null): adds additional, custom tags to videos downloaded from the channel. `tab_video_counts` (text, nullable): JSON of YouTube's public video totals per tab, keyed by media type (`{"video":{"total":449,"fetchedAt":"..."}}`), used for the download percentage (refreshed daily with a YouTube API key, every three days or more in capped batches through yt-dlp without one). `tab_counts_attempted_at` (datetime, nullable): when a tab count lookup last started for the channel, successful or not; yt-dlp bulk refreshes take the oldest attempts first and skip channels attempted within three days, and opening a channel page waits an hour after an attempt. Non-unique index on `channel_id` (some installs carry duplicate rows). |
| `videos`           | `Video`           | Downloaded video metadata. `removed` (boolean): no file on disk. `removed_reason` (VARCHAR(32), nullable) says why: `user_deleted` (deleted in the app), `auto_removal` (automatic cleanup; `removed_detail` VARCHAR(255) holds the rule, e.g. "older than 30 days"), `not_found` (a file was expected on disk and not found: the video is *missing*), or `marked_deleted` (the user marked a missing video as deleted). Every other removed row, including NULL (removed before the reason was recorded), is *deleted*. `removed_at` (DATETIME, nullable): when it was removed. Deleted videos are hidden on the Videos page by default; a file that reappears clears all three columns. Index on `(removed, removed_reason)`. `video_resolution` (VARCHAR(20), nullable): actual pixel dimensions of the downloaded file, e.g. `"1920x1080"`, measured by ffprobe at download time and backfilled by the filesystem rescan; the displayed tier label (e.g. "1080p") is derived client-side (`client/src/utils/videoResolution.ts`), so labeling rules can change without re-probing; NULL = not yet checked or audio-only, `"0x0"` = probe failed (never shown in the UI). Index on `channel_id`. |
| `channelvideos`    | `ChannelVideo`    | Channel <-> video associations. `published_at_source` tracks `published_at` provenance: `exact` (.info.json), `approximate` (yt-dlp flat-playlist date), `estimated` (ordering-only placeholder assigned when YouTube returns a listing with no dates; never displayed), NULL (legacy, treated as approximate). Non-unique indexes on `(channel_id, youtube_id)` and `youtube_id`. |
| `jobs`             | `Job`             | Download job queue. `aux_data` (MEDIUMTEXT, nullable): JSON snapshot of job data other than videos (failed downloads, diagnoses, skip counts, terminated channels), written on job save and merged back on startup load; NULL for jobs recorded before the column existed. |
| `jobvideos`        | `JobVideo`        | Job <-> video associations        |
| `jobvideodownloads`| `JobVideoDownload`| Download progress tracking        |
| `sessions`         | `Session`         | User authentication sessions      |
| `apikeys`          | `ApiKey`          | API key credentials for external integrations (bookmarklets, shortcuts, automation). External API policy fields store the key role, request permissions and auto-approval settings, allowed media types, rating limits, revocation time, and write quotas. Existing keys are assigned the `legacy_download` role. |
| `api_key_channel_grants` | `ApiKeyChannelGrant` | Channels granted to an API key. Unique index on `(api_key_id, channel_id)`. |
| `external_requests` | `ExternalRequest` | External API request lifecycle records, including the requesting key, optional channel and job, status, idempotency hash, and completion timestamps. |
| `external_api_usage_buckets` | `ExternalApiUsageBucket` | Per-key hourly and daily accepted-write counters. Unique index on `(api_key_id, window_type, window_start)`. |
| `playlists`        | `Playlist`        | Subscribed YouTube playlists with per-playlist sync targets and seeded settings. `auto_download_baseline_at` (DATETIME, nullable): saved starting time for automatic following. `auto_download_baseline_id` (INTEGER, nullable): last known playlist entry id for new setups, avoiding same-second timestamp ambiguity. Existing timestamp-only cutoffs are preserved on upgrade. `auto_download_setup_error` (STRING, nullable): persisted first-setup failure (`PLAYLIST_TOO_LARGE` or `PLAYLIST_REFRESH_INCOMPLETE`), cleared when a baseline is successfully established. `sort_order` (STRING NOT NULL, default `'default'`): saved output order for the `.m3u` file and media server sync; `'reversed'` flips the YouTube playlist order. `title_filter_regex` (TEXT, nullable): matched against video titles on refresh as a case-insensitive JavaScript regex; the settings endpoint rejects a pattern that does not compile. It also seeds auto-created source channels, whose title filter runs through yt-dlp's Python matching (case sensitive). |
| `playlistvideos`   | `PlaylistVideo`   | One row per (playlist, video) with the YouTube playlist position. `first_seen_at`: immutable local discovery time, backfilled from row creation on upgrade. `downloaded_at`: recorded download/job time, independently updated. `auto_download_requested`: explicitly selected existing videos pending successful download, saved only with auto-download enabled and an established baseline. `auto_download_last_attempt_at` (DATETIME(3), nullable): scheduling time for an explicit saved batch or a selected scheduled retry, written before queue submission. Used to rotate older saved requests, independently of discovery and download dates; legacy requests with no known attempt remain null and join the bounded retry pool. First initialization preserves pending requests; successful downloads clear their own flags, and an explicit starting-point reset clears the remaining requests. Legacy `added_at` is retained for pre-upgrade timestamp cutoffs; it is no longer overwritten on download. |
| `playlist_sync_state` | `PlaylistSyncState` | Per-(playlist, server) sync state: server playlist id, last_synced_at, last_error |
| `subfolders`       | `Subfolder`       | Durable registry of known subfolder names (id, name unique, created_at, updated_at). Backfilled from channels, playlists, and video file paths by the `add-subfolders-table` migration; kept current by register-on-create and register-on-download-override. |
| `video_watch_status` | `VideoWatchStatus` | Per-video, per-media-server, per-user watch state pulled by the watch status sync. Absence of a row means never synced/unknown, not unwatched. Columns: `video_id`, `server_type` (`plex`/`jellyfin`/`emby`), `server_user_id` (Plex owner is `'1'`), `played`, `play_count`, `position_ms`, `percent_watched`, `last_watched_at`, `last_synced_at`. Unique index on `(video_id, server_type, server_user_id)`. |
| `media_server_users` | `MediaServerUser` | Media-server account directory populated during watch status sync: `server_type`, `server_user_id`, `server_user_name`. Unique index on `(server_type, server_user_id)`. Used to display which users watched a video. |
| `watch_status_sync_cursors` | `WatchStatusSyncCursor` | Durable per-server watch-status sync cursor (unique `server_type`, `cursor` DATETIME). Today only Plex uses it: the newest play-history event scanned, so incremental pulls never permanently skip events. Deleting a row forces a full history re-scan on the next sync. |
| `scheduled_task_runs` | `ScheduledTaskRun` | Bounded run history (the last 20 runs per task, plus any row still running and the newest row of each outcome) for the configurable schedules: `task_key` (the schedule's config key), `trigger_type` (`scheduled`/`manual`/`startup`), `status` (`running`/`success`/`error`/`skipped`/`interrupted`), task-specific `outcome`, `message`, JSON `details`, `started_at`, `finished_at`. Index on `(task_key, started_at)`. Rows still `running` when the server starts are marked `interrupted`. Feeds `GET /api/schedules` and the last-run displays on the Scheduling, Maintenance, and YT-DLP settings pages. |
| `health_outcomes`  | `HealthOutcome`   | Latest acquisition-health outcome per video and processing stage; see [Acquisition health outcomes](#acquisition-health-outcomes). |
| `SequelizeMeta`    | NA                | Sequelize ORM migration tracking  |

### External API Policy Foundation

The external API policy fields and supporting tables are dormant until the runtime/control plane is enabled. Existing keys retain their single-video download behavior and are backfilled with the `legacy_download` role. API-key values remain hashed and cannot be recovered from the database. Revocation is represented by `revoked_at` together with the key's active status.

## Internal Database (Default)

### Container Details
- **Image**: `mariadb:10.3`
- **Container Name**: `youtarr-db`
- **Port**: 3321 inside the Docker network only; the bundled database is not published to the host
- **Character Set**: `utf8mb4` (full Unicode/emoji support), collation `utf8mb4_unicode_ci` on the database default and every table. The `20260907000000-normalize-utf8mb4-unicode-collation` migration converts older installs that still had `utf8mb4_general_ci` or three-byte `utf8` tables.
- **Default Credentials**:
  - User: `root`
  - Password: `123qweasd` (change in production!)
  - Database: `youtarr`

### Storage Options

#### Option 1: Bind Mount (legacy / pre-existing installs)
```yaml
volumes:
  - ./database:/var/lib/mysql
```
- Data stored in `./database` directory on the host
- Kept for backwards compatibility with existing bind-mounted installs and plain `docker compose up -d` users
- Works well on native Linux Docker hosts
- Can have permission issues on Synology/QNAP
- Can corrupt during MariaDB schema migrations on Docker Desktop for Windows/macOS, ARM hosts, and some virtualized filesystems

#### Option 2: Named Volume (Recommended for Docker Desktop/ARM/NAS)
```yaml
volumes:
  - youtarr-db-data:/var/lib/mysql
```
- Better compatibility with Synology/QNAP
- Avoids the virtualized-filesystem write semantics problem that can affect bind-mounted MariaDB
- Used automatically for fresh installs started with `./start.sh` on every platform (Linux included, since v1.69)
- Recommended for Docker Desktop on Windows/macOS, ARM systems, and NAS setups
- Not easily visible on host: data lives under `/var/lib/docker/volumes/<project>_youtarr-db-data/_data` rather than `./database/`. To back it up, stop Youtarr with `docker stop youtarr`, then run `./scripts/backup.sh`. Keep the database container in place; the script can start it if needed. Use `docker stop` rather than `./stop.sh`, which removes containers. See [Backup and Restore](BACKUP_RESTORE.md).

### Migrating from Bind Mount to Named Volume

If you already have Youtarr data in `./database/`, do **not** switch the compose mount by hand unless you intentionally want to start with an empty database. Use the migration helper instead:

```bash
./scripts/migrate-to-named-volume.sh
```

What the script does (in this order, so any failure leaves the simplest possible recovery state):
1. Runs a pre-flight permissions check so it fails fast (instead of stalling on an interactive `sudo` prompt) if it cannot write to the project directory.
2. Stops Youtarr.
3. Starts the existing bind-mounted MariaDB long enough to run `mysqldump` and to capture per-table row counts.
4. Renames `./database/` to `./database.bind-mount-backup.<timestamp>/` so the original files are preserved.
5. Starts a fresh named-volume MariaDB and imports the dump.
6. Verifies that the table set matches the source **and** that every table has the same row count as the source.
7. **Only after verification succeeds**, snapshots `.env` to `./.env.bak.<timestamp>` and pins `COMPOSE_PATH_SEPARATOR=:` and `COMPOSE_FILE=docker-compose.yml:docker-compose.arm.yml` in `.env`. This means a failure during step 5 or 6 leaves `.env` untouched, and recovery is just `mv ./database.bind-mount-backup.<timestamp> ./database` plus removing the partial named volume.
8. Brings the full stack (app + database) back up so Youtarr is immediately usable.

**If you use `docker-compose.override.yml`** (for example, to mount a NAS share): once `COMPOSE_FILE` is pinned, Compose no longer loads the override automatically, and the script does not add it. Add it to `COMPOSE_FILE` before `docker-compose.arm.yml` right after the migration, or whatever the override configured (such as your video share) disappears from the containers. See [Keeping docker-compose.override.yml](DOCKER.md#keeping-docker-composeoverrideyml).

**What the migration does *not* copy**: `mysqldump` runs with `--single-transaction --routines --triggers --events`. Schema, data, stored routines, triggers, and events all migrate. MariaDB users and `GRANT` statements (anything in `mysql.user` / `mysql.db`) do **not**. The default Youtarr install only uses the bundled `root` user, so this is a no-op for almost everyone. If you have created additional database users on the bundled MariaDB, recreate them after the migration completes.

**Password note**: for the bundled `root` database user, `DB_ROOT_PASSWORD` seeds the root password when a fresh MariaDB data directory is initialized, while Youtarr connects with `DB_PASSWORD`. The migration requires those two values to match before it creates the new named-volume database.

After it completes, the stack is already running. Subsequent restarts can use any of:

```bash
./start.sh                                                       # recommended
docker compose up -d                                             # the script pins COMPOSE_FILE in .env
docker compose -f docker-compose.yml -f docker-compose.arm.yml up -d  # explicit override
```

### Reverting to Bind Mount

The migration is reversible:

1. Stop the stack:
   ```bash
   ./stop.sh
   ```
2. Restore the `.env` snapshot:
   ```bash
   mv ./.env.bak.<timestamp> .env
   ```
3. Remove the named volume for this install. The name is usually `<project>_youtarr-db-data`:
   ```bash
   docker volume ls --format '{{.Name}}' | grep -E '(^|_)youtarr-db-data$'
   docker volume rm <volume-name>
   ```
4. Restore the original bind-mounted database directory:
   ```bash
   mv ./database.bind-mount-backup.<timestamp> ./database
   ```
5. Start Youtarr:
   ```bash
   ./start.sh
   ```

Changes made while running on the named volume are not present in the old bind-mounted backup. If you have used the named volume for a while and want to keep those newer changes, take a backup first with `./scripts/backup.sh`.

### Fresh Installs with Named Volume

For a new install with no data to preserve, you can start directly with the named-volume override:

```bash
docker compose -f docker-compose.yml -f docker-compose.arm.yml up -d
```

Or pin the override in `.env` so plain `docker compose up -d` uses it:

```env
COMPOSE_PATH_SEPARATOR=:
COMPOSE_FILE=docker-compose.yml:docker-compose.arm.yml
```

`COMPOSE_PATH_SEPARATOR=:` is important on Windows so Compose parses the file list consistently.

### Security Considerations

#### Changing Default Credentials
1. Edit `.env` file:
   ```bash
   DB_USER=youtarr
   DB_PASSWORD=secure-password-here
   DB_ROOT_PASSWORD=different-secure-password
   ```

2. If using non-root user, uncomment in `docker-compose.yml`:
   ```yaml
   environment:
     - MYSQL_USER=${DB_USER}
     - MYSQL_PASSWORD=${DB_PASSWORD}
   ```

3. Restart containers for changes to take effect

**Warning**: The bundled database is not exposed to the host by default. If you manually publish port 3321, keep it restricted to trusted hosts only.

## External Database Setup

### Requirements
- MariaDB 10.3+ or MySQL 8.0+
- Database with `utf8mb4` character set
- User with full privileges on the database
- Network connectivity from Youtarr container

### Step 1: Prepare External Database

Run on your database server:

**Note**: The example below assumes you are using `youtarr` for your DB name and `youtarr` for your DB user.

```sql
CREATE DATABASE youtarr
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

CREATE USER 'youtarr'@'%'
  IDENTIFIED BY 'your-secure-password';

GRANT ALL PRIVILEGES ON youtarr.*
  TO 'youtarr'@'%';

FLUSH PRIVILEGES;
```

Replace `'%'` with specific IP/network if restricting access.

### Step 2: Configure Youtarr

Edit `.env` file:
```bash
DB_HOST=192.168.1.100  # Your database server IP
DB_PORT=3306           # Your database port
DB_USER=youtarr        # Database username
DB_PASSWORD=your-secure-password
DB_NAME=youtarr        # Database name
```

### Step 3: Start with External Database

Using convenience script:
```bash
./start-with-external-db.sh
```

Or manually:
```bash
docker compose -f docker-compose.external-db.yml up -d
```

### Reverting to Internal Database
Simply run the normal start script:
```bash
./start.sh
```

## Database Migrations

### How Migrations Work
- Migrations run automatically on container startup
- Tracked in `SequelizeMeta` table
- Located in `/app/migrations/` inside container
- Idempotent - safe to run multiple times

### Creating New Migrations
```bash
# Use the provided script
./scripts/db-create-migration.sh my-migration-name

# Or use npm directly
npm run db:create-migration -- --name my-migration-name
```

### Migration Best Practices
1. **Always use helpers** for idempotent operations:
   ```javascript
   const { tableExists, columnExists, createTableIfNotExists } = require('./helpers');

   if (!await columnExists(queryInterface, 'videos', 'duration')) {
     await queryInterface.addColumn('videos', 'duration', {...});
   }
   ```

2. **Test migrations** in development first
3. **Never modify** existing migration files
4. **Create new migrations** for schema changes

## Troubleshooting Database Issues

### Permission Failures

#### Symptoms
- `InnoDB: Operating system error number 13`
- MariaDB container fails to start
- Permission denied errors in logs

#### Common Causes
1. **Synology/QNAP NAS**: MariaDB runs as UID 999, which may not exist
2. **Docker Desktop/ARM/NAS**: virtualized filesystem or permission issues with bind-mounted MariaDB data
3. **Wrong ownership**: Database files owned by incorrect user

#### Solutions
1. **Migrate to named volume** (see above)
2. **Fix permissions**:
   ```bash
   # Check current ownership
   ls -la ./database

   # Fix ownership (adjust UID:GID as needed)
   sudo chown -R 999:999 ./database
   ```

### Duplicate Column Errors

#### Symptoms
- `Duplicate column name 'duration'`
- `Table 'channelvideos' already exists`
- Migration errors after crash/restore

#### Cause
Lost or corrupted `SequelizeMeta` table causing migrations to re-run

#### Solution
With recent updates, migrations are idempotent and self-healing:
1. Simply restart the container:
   ```bash
   docker compose down
   docker compose up -d
   ```

2. If errors persist, manually check:
   ```bash
   # Connect to database
   docker exec -it youtarr-db mysql -u root -p123qweasd youtarr

   # Check SequelizeMeta
   SELECT * FROM SequelizeMeta;

   # If missing, migrations will re-run safely
   ```

### Connection Issues

#### Cannot Connect to Database
1. **Check container status**:
   ```bash
   docker ps | grep youtarr-db
   ```

2. **Test connection**:
   ```bash
   # From inside the database container
   docker compose exec youtarr-db mysql -u root -p123qweasd youtarr
   ```

3. **Check logs**:
   ```bash
   docker logs youtarr-db
   ```

#### Authentication Failures
- Verify credentials match in `.env` and database
- Check user permissions: `SHOW GRANTS FOR 'youtarr'@'%';`
- Ensure user can connect from container IP

### Character Set Issues

#### Symptoms
- Emoji not saving correctly
- UTF-8 encoding errors
- Question marks in text

#### Solution
Ensure database uses `utf8mb4`:
```sql
-- Check database charset
SELECT DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME
FROM information_schema.SCHEMATA
WHERE SCHEMA_NAME = 'youtarr';

-- Convert if needed
ALTER DATABASE youtarr
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;
```

Tables on mixed collations (`utf8mb4_general_ci` beside `utf8mb4_unicode_ci`) make any query that
compares string columns across them fail with `Illegal mix of collations`. The
`normalize-utf8mb4-unicode-collation` migration fixes this automatically on startup; see
[Troubleshooting](TROUBLESHOOTING.md#startup-fails-with-illegal-mix-of-collations) for the manual steps.

## Storage Considerations

### Database Size Estimates
- **Per Channel**: ~1-2 KB metadata
- **Per Video**: ~5-10 KB metadata
- **Growth Rate**: ~10 MB per 1000 videos

### TV episode identity

`episode_shows` locks allocations by the immutable YouTube channel ID, independently of duplicate legacy `channels` rows. `episode_assignments` has one row per YouTube video ID and a unique `(channel_id, season, episode)` index. Both use case-sensitive identity collation. The migration only adds these tables and leaves videos and download history intact; rolling it back discards assignments and must not be done after publication without restoring a matching database backup.

The `episodeAssignment.ensureEpisodeAssignment` publication interface allocates the known channel catalog on its first request, ordered by publication time and then case-sensitive YouTube ID. Later discoveries append to their year without renumbering. Video ID is shared by uploads, Shorts and live replays; channel titles and handles do not participate. The returned `publishedAt` and `publishedAtSource` are the date and provenance used for assignment. Current source observations remain in `channelvideos`.

Missing, invalid, or `estimated` (synthetic ordering) dates return `date-required` with no episode; they must be shown as awaiting a date and not published as a fabricated year. A later differing observation returns `date-correction-review` and retains the original assignment and date: the video details show both dates and a separately designed preview/reassignment is required before moving an episode. No automatic reassignment is implemented. Conflicting ownership of one video ID is an error. TV publication is introduced by #7; this interface alone does not write TV files or change the existing library.

When duplicate catalog rows disagree, status and allocation responses expose a differing observation within the highest-confidence date tier instead of hiding it behind a matching older row. The persisted assignment remains unchanged pending review.

### Acquisition policies

`acquisition_policies` (migration `20261106104340-create-acquisition-policies`) holds explicit stream/download and livestream selections, one row per `(scope, subject_id)` (unique index): scope `global` (subject `global`), `channel` (subject = YouTube channel ID) or `video` (subject = YouTube video ID, with its `channel_id`). `delivery_policy` is `download` or `stream`; `live_policy` is `ignore`, `replay`, `play`, `record` or `play_and_record`; NULL inherits. Precedence per field: video > channel > global > built-in default (`download`, `replay`, which is the behavior before policies existed, so installs without rows are unchanged). Every write bumps `revision` under a row lock; an update carrying a stale `expectedRevision` is refused. The table uses case-sensitive identity collation like `episode_assignments`.

The migration only creates this table; no existing table, column or row changes, and no database service or volume change is involved. Rolling it back discards the stored selections only.

Enforcement (`server/modules/acquisition/`): `resolveAcquisitionPolicy` is pure and returns `{ effectivePolicy, plannedActions, jobAction, logicalItem, reasons }`. Requested intent is kept apart from capability (`capabilities.js`): streaming, live playback and live recording are not available in this release, so selecting them queues nothing and every decision carries an actionable reason (`capability_unavailable`, or `capability_unknown` when support cannot be confirmed). `channelSweepPlanner` applies the policies to automatic channel sweeps only: a channel tab is fetched only when its kind's effective policy downloads (`ignore` drops the streams tab; the streams tab only yields finished broadcasts, whose replay follows the delivery policy under every non-`ignore` live mode), a per-video override that stops a download on a fetched tab becomes a quoted `id!='...'` `--match-filter` exclusion (at most 2000 video overrides), and a per-video download override on a tab that is not fetched adds that single video unless it already has a `videos` row or archive entry. Policy changes affect future decisions only: nothing is deleted, replaced or backfilled, protected and existing downloads are untouched, and manual downloads, channel "Download all" and playlist following ignore these policies, so a stream-only video stays eligible for a later manual download. Source unavailability (`source_unavailable`) is reported separately from policy exclusion (`policy_excluded`, `content_kind_filtered`). One video ID is one logical item: live playback plus recording plans at most one job, and a later replay shares the identity from `episode_assignments`.

### Channel artwork

`channel_artworks` (migration `20261106104507-create-channel-artworks`) holds one row per YouTube channel ID describing its 2:3 show poster: `poster_source` (`auto` or `manual`), `poster_protected` (the owner's pin), `poster_origin` (`manual`, `upstream`, `generated`), `poster_width`/`poster_height`, `poster_revision` (incremented only when the poster bytes change), `poster_sha256`, `input_fingerprint` (selection, source images and title the poster was made from, so unchanged inputs skip regeneration), `published_sha256`/`published_at`/`publish_note` for the folder's `poster.jpg`, and `refresh_status`/`refresh_message`/`refresh_attempted_at` for the last Jellyfin artwork refresh. The migration is additive: it changes no existing table, and a missing row means automatic artwork that has not been resolved yet. Image files themselves live in the image cache (`channelposter-<id>.jpg`, `channelposter-manual-<id>.jpg`, `channelavatar-<id>.jpg`), not the database. Rolling the migration back only discards selections, pins and refresh history.

### Acquisition health outcomes

`health_outcomes` (migration `20261106204350-create-health-outcomes`, model `models/healthOutcome.js`, required directly rather than through the models index) holds the latest result of each processing stage of a video: one row per `(youtube_id, stage)` (unique index), with `stage` one of `acquisition`, `captions`, `publication` or `library` (the targeted Jellyfin listing check after TV publication). `status` is `ok`, `warning`, `failed`, `pending` or `skipped`; `category` is what the health view shows (`ok`, `source-unavailable`, `policy-excluded`, `no-captions`, `permission-path`, `storage-limit`, `scan-pending`, `abandoned`, `application-failure`); `reason_code`, a redacted `message` of at most 500 characters and redacted JSON `details` of at most 2 KB explain it (API keys, notification URLs, token parameters, cookies and signed googlevideo URLs are removed before storing). `retryable` says whether the step can be retried on its own, `attempts` counts consecutive unsuccessful results, and every write bumps `revision`, which per-step retries use as their idempotency key (compare-and-set, with a 10-minute cooldown on a claimed retry). `app_version`, `tool_version` (yt-dlp, when the writing process knows it) and `policy_revision` (`global.channel.video` acquisition-policy revisions, for failed downloads) record what produced the outcome; `job_id` links the download job. Index on `(status, updated_at)`. The table uses case-sensitive identity collation like `episode_assignments` and has no foreign keys.

The migration only creates this table; no existing table, column or row changes, and no database service or volume change is involved. It creates no foreign keys and alters nothing, so it is expected to apply the same way on MariaDB 10.3, 12.x and MySQL 8.0; CI runs its integration test on MariaDB 10.3 and MySQL 8.0 (not yet on 12.x). Rolling it back discards the diagnostics only; downloads, files and job history are unaffected.
