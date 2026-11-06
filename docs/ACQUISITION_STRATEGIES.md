# Viewing and storage strategies

In Settings → Core Settings choose global defaults. Channel Settings → Strategy overrides these independently for uploads/Shorts and broadcasts. Video detail can override either field; Inherit clears that field. Save strategy applies immediately to future automation only. Existing media and protected items are retained. Quality and subtitle languages remain in the existing download settings.

Each scenario shows the effective setting, its source, next action and capability/source exclusions returned by the server. Unsupported streaming/live modes do not queue work. Manual Download remains available in stream mode. Disable a channel in Subscriptions to pause its automation; enable it to resume.

Download All is an explicit backlog action, separate from changing policy, converting copies or deleting media. Load the channel listing first. Preview queues nothing. Confirmation sends `selectionVersion` from the preview; changed candidates or channel/global/video policy return 409 and require another preview. Downloads already acquired, archived or active are excluded. Known storage bytes are zero and all candidates have unknown size; duration is not a storage estimate. Storage pauses are shown using the existing admission error.

Streaming sessions, durable recording/partial outcomes and copy conversion are delivered by subsequent roadmap issues. These controls do not claim unsupported media is streamable or recorded. Existing job history remains the place to inspect failures and retry manual acquisition. Jellyfin Web/JellySee, mobile device and production checks were not performed during implementation.
