# Bounded on-demand playback

`GET /api/playback/{youtubeId}` prepares one known Video or ChannelVideo identity,
then serves a file with Express HTTP byte ranges (including suffix ranges and
416 for unsatisfiable ranges). No arbitrary source URL or path is accepted.
`Content-Location` identifies `/api/playback/sessions/{sessionId}/media`; subsequent
range requests can use either URL. `DELETE` is an idempotent viewer release hint: it does not revoke shared readers or evict the cache. HTTP responses own and automatically release reader leases; only server expiry/internal shutdown owns shared-session disposal.
All three routes require the existing `verifyToken` authentication; nothing is
public. Preparation is limited to ten requests per minute per client IP; ready cached
range requests bypass that creation limit.

## Seek/resume design and tradeoff

This initial strategy fully prepares a bounded MP4 before sending headers. Separate
H.264 video (at most 1080p) and AAC audio are muxed by yt-dlp/FFmpeg; MP4 fallback
and remux use codec copy, never a required video transcode. This avoids a
forward-only pipe and gives a completed seekable index before playback, with
normal audio/video timestamps. It trades first-frame latency for predictable
random access. Large or slow items fail rather than silently becoming unbounded
download jobs. It does not archive a channel, update download history, or write
complete.list. Live recording/playback is outside this VOD implementation.

The session module owns `openPlayback(videoId, {signal})`,
`getSessionAsset(sessionId, 'media')` (a file lease with idempotent `release`), and
`closePlayback(sessionId)` (internal disposal only; HTTP DELETE never calls it). #13 can publish the stable identity URL only once its
client authentication contract is verified. #14 can extend local selection at
`openPlayback`: an existing nonremoved Video's regular nonempty file wins. No
mutation of episode identity, media publication, watch state or acquisition policy
is performed here. Selecting stream mode does not itself publish a STRM.

## Resource and failure contract

Two upstream preparing/ready caches maximum; concurrent same-video opens share one preparation promise. Local files use a separate metadata budget (64 total identities), so two local viewers do not block upstream preparation. Eight concurrent readers and 32 preparation waiters per identity permit overlapping seeks and bounded retry sharing. Failed preparation releases its slot.
Preparation has a ten-minute deadline, 20-second socket timeout, one retry per
request/fragment, serial fragments and a 4 MiB/s transfer limit. Unknown catalog identities return 404. Known private/removed/unsupported, filtered VOD (including live/upcoming/unknown duration), missing successful output, and budget failures return nonretryable 422. Unclassified upstream/tool/storage failures and deadlines return 503 with Retry-After.
A later session invokes yt-dlp afresh, so no expiring source URL is persisted.

Cache files are private disposable directories under the OS temporary directory,
normally `/tmp/youtarr-playback-*`. Download cleanup preserves these roots even when its configured directory overlaps or contains the OS temporary directory. In an Unraid container, `/tmp` is normally the container writable layer unless explicitly mounted: provision a dedicated adequately sized temporary mount for OS temporary storage if needed; this code does not add a mount or environment setting. The completed file
limit is 1 GiB. A one-second monitor stops a session exceeding 1 GiB total staging
usage; this is a monitored limit, not a filesystem quota: fragment buffering and
FFmpeg mux output can transiently overshoot. Format selection requires known per-stream size estimates: video and audio each fit one quarter of the staging budget, or a combined MP4 fits half. This leaves room for simultaneous mux input/output and selects lower quality where necessary; unknown size estimates can make an otherwise playable source unsupported. yt-dlp also rejects estimated source files above 1 GiB. Provision temporary storage accordingly. Idle sessions expire
after ten minutes without a reader; absolute lifetime is four hours. Disconnects cancel only that waiter, or release an active reader lease. When all preparation waiters disconnect, a 30-second grace permits reconnect/retry reuse; after that abandoned work is terminated. The ten-minute preparation deadline never resets for retries. Complete-file preparation can still exceed proxy/client startup timeouts; this is not low-latency streaming and those client gates remain open. Closure terminates the
whole detached process group, escalates to SIGKILL after one second and removes
its files after the grace period. Session capacity remains reserved during cleanup.
Normal application exit kills outstanding process groups and removes owned session directories. A hard application/container crash can leave temporary files; the host's temporary
storage cleanup is required for these orphan directories. No appdata is deleted.

Logs record identity/session IDs and safe statuses using the existing durable
logging transport. Only the last 8 KiB of stderr is parsed in memory for safe permanent-error categories; raw output is never logged or returned. Durable logs include the exit code and safe reason category: credential-bearing upstream URLs,
cookies and proxy arguments are never included in playback errors or logs.

## Verification and release gate

Mocked yt-dlp fixtures exercise local preference, fresh resolution, failures,
capacity and cache removal. Route fixtures exercise authentication and byte ranges.
No production database, live Jellyfin, or real YouTube requests are needed.

Real Jellyfin Web and JellySee start, synchronized audio/video, forward/back seek,
resume, long startup timeouts and authentication forwarding remain **unperformed**.
The server can supply `x-access-token` using existing authentication, but actual
Jellyfin-to-Youtarr and JellySee request/header behavior has not been established.
Do not put broad API credentials in STRM files or infer compatibility from these
HTTP fixture tests. #13 must finalize a scoped playback credential and externally
reachable URL contract before publication. This release gate keeps #12 open.
