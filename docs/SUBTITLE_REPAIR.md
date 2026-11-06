# Existing subtitle repair

In a downloaded video's details, expand **Repair subtitles**, or use Settings → Maintenance for a comma-separated batch of numeric video database IDs (up to 100). Confirm automatic-caption provenance and synchronization to the final media only after verifying them. Human, ambiguous or unverified SponsorBlock timelines must remain unconfirmed: those tracks are skipped. This is a conservative owner assertion, not automatic provenance detection. Repair operates on the existing final SRT timeline; it cannot fix an already mistimed track.

Preview first. Review the warning, removed-transition count and before/after cue examples (first 1,200 characters). Apply the reviewed preview. Results distinguish repaired, unchanged, skipped and failed tracks. Cancel stops between tracks. Reloading Maintenance or reconnecting retrieves the durable records. Create a new preview for interrupted/failed work. Repeated repair is unchanged.

The worker resolves movie and jellyfinTv paths from video records, rejects paths outside DATA_PATH and symlink caption files, checks source hashes and the normalizer version, and shares a per-video cross-process lease with download finalization. The original SRT bytes and a JSON write-ahead journal live under the existing jobs directory's `subtitle-repairs/`, outside DATA_PATH. Backups are content addressed, verified and never exposed as scanned subtitles. Do not delete this directory if restore is needed. Include it in config/jobs backups. No database schema, media bytes, download history or complete.list changes are made.

Restore verifies backup bytes and refuses to overwrite captions changed since repair. Interrupted publication is reconciled by result hash on server startup; unfinished tracks stay intact. Leases recover dead process owners; a busy owner times out after 30 seconds. One app writer remains required; external tools do not participate in these leases. The filesystem must support atomic same-directory rename and hard links for leases.

Jellyfin gets an item-only metadata refresh after a successful repair or restore, with at most three attempts and bounded HTTP timeouts. Failure is reported as pending and does not undo a subtitle. No full-library refresh is triggered. An item not yet indexed remains pending; use Jellyfin's item refresh manually when available.

## API

All endpoints require `x-access-token`. `GET /api/subtitle-repairs` seeds the durable history; `POST /api/subtitle-repairs/preview` accepts `{videoIds: number[], automaticFinal: boolean}`. `POST /api/subtitle-repairs/:id/start`, `/cancel`, and `/restore` perform the corresponding action. `subtitleRepairUpdated` WebSocket events invalidate the history snapshot. The reusable module interface is `previewRepair(videoIds, options)`, `startRepair(previewId)`, `restoreRepair(repairId)`. Future provenance/enrichment writers must use the caption lease and shared caption publication helpers.

## Release checks still required

Development uses synthetic tracks in temporary directories only. Repairing the owner's two affected videos, Jellyfin Web/JellySee recognition, natural reading and audio sync, live-library backup visibility, low-storage host checks and operational rollback rehearsal are manual and unperformed. Owner approval is required before production repair or deployment. Keep issue #4 open until those checks are recorded. Existing-caption provenance/timing confirmation is an explicit prerequisite.
