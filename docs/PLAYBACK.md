# Bounded on-demand playback

`GET /api/playback/{youtubeId}` prepares one known Video or ChannelVideo identity,
then serves a file with Express HTTP byte ranges (including suffix ranges and
416 for unsatisfiable ranges). No arbitrary source URL or path is accepted.
`Content-Location` identifies `/api/playback/sessions/{sessionId}/media`; subsequent
range requests can use either URL. `DELETE` on that asset closes its session.
All three routes require the existing `verifyToken` authentication; nothing is
public. Preparation is limited to ten requests per minute per client IP.

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
`closePlayback(sessionId)`. #13 can publish the stable identity URL only once its
client authentication contract is verified. #14 can extend local selection at
`openPlayback`: an existing nonremoved Video's regular nonempty file wins. No
mutation of episode identity, media publication, watch state or acquisition policy
is performed here. Selecting stream mode does not itself publish a STRM.

## Resource and failure contract

Two preparing/ready sessions maximum; same-video ready sessions reuse their cache.
Two concurrent readers per session maximum. Failed preparation releases its slot.
Preparation has a ten-minute deadline, 20-second socket timeout, one retry per
request/fragment, serial fragments and a 4 MiB/s transfer limit. Unknown, private,
removed and unavailable sources return an honest error; 503 includes Retry-After.
A later session invokes yt-dlp afresh, so no expiring source URL is persisted.

Cache files are private disposable directories under the OS temporary directory,
following the outside-appdata temporary storage convention. The completed file
limit is 1 GiB. A one-second monitor stops a session exceeding 1 GiB total staging
usage; this is a monitored limit, not a filesystem quota: fragment buffering and
FFmpeg mux output can transiently overshoot. yt-dlp also rejects estimated source
files above 1 GiB. Provision temporary storage accordingly. Idle sessions expire
after ten minutes without a reader; absolute lifetime is four hours. Disconnects
cancel preparation, or release an active reader lease. Closure terminates the
whole detached process group, escalates to SIGKILL after one second and removes
its files after the grace period. Session capacity remains reserved during cleanup.
Normal application exit kills outstanding process groups. A hard application/container crash can leave temporary files; the host's temporary
storage cleanup is required for these orphan directories. No appdata is deleted.

Logs record identity/session IDs and safe statuses using the existing durable
logging transport. Child output is discarded: credential-bearing upstream URLs,
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
