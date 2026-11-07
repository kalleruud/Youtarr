// Shared vocabulary of acquisition-health outcomes (issue #18). Pure
// constants: the store, classifiers, explainer, routes and notifier read them.

// One durable outcome per (video, stage). Stages run in this order; a later
// stage never changes an earlier stage's record, so a caption or library
// refresh problem can never turn a finished download into a failed one.
const STAGES = Object.freeze({
  ACQUISITION: 'acquisition',
  CAPTIONS: 'captions',
  PUBLICATION: 'publication',
  LIBRARY: 'library',
});
const STAGE_ORDER = Object.freeze([STAGES.ACQUISITION, STAGES.CAPTIONS, STAGES.PUBLICATION, STAGES.LIBRARY]);

const STATUSES = Object.freeze({
  OK: 'ok',
  WARNING: 'warning',
  FAILED: 'failed',
  PENDING: 'pending',
  SKIPPED: 'skipped',
});

// What the UI tells the user, in the order the issue lists them, plus the
// states that are not problems (ok) or that restart recovery creates.
const CATEGORIES = Object.freeze({
  OK: 'ok',
  SOURCE_UNAVAILABLE: 'source-unavailable',
  POLICY_EXCLUDED: 'policy-excluded',
  NO_CAPTIONS: 'no-captions',
  PERMISSION_PATH: 'permission-path',
  STORAGE_LIMIT: 'storage-limit',
  SCAN_PENDING: 'scan-pending',
  ABANDONED: 'abandoned',
  APPLICATION_FAILURE: 'application-failure',
});

// Plain-language labels; the client mirrors these in its own copy.
const CATEGORY_LABELS = Object.freeze({
  [CATEGORIES.OK]: 'OK',
  [CATEGORIES.SOURCE_UNAVAILABLE]: 'Source unavailable',
  [CATEGORIES.POLICY_EXCLUDED]: 'Excluded by policy or settings',
  [CATEGORIES.NO_CAPTIONS]: 'No captions',
  [CATEGORIES.PERMISSION_PATH]: 'Permission or path error',
  [CATEGORIES.STORAGE_LIMIT]: 'Storage limit',
  [CATEGORIES.SCAN_PENDING]: 'Library scan pending',
  [CATEGORIES.ABANDONED]: 'Interrupted by a restart',
  [CATEGORIES.APPLICATION_FAILURE]: 'Application failure',
});

// Bounds for persisted text: enough to diagnose, never a whole log.
const MAX_MESSAGE_LENGTH = 500;
const MAX_DETAILS_BYTES = 2048;
const MAX_REASON_CODE_LENGTH = 64;
const MAX_VERSION_LENGTH = 40;
const YOUTUBE_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

module.exports = {
  STAGES,
  STAGE_ORDER,
  STATUSES,
  CATEGORIES,
  CATEGORY_LABELS,
  MAX_MESSAGE_LENGTH,
  MAX_DETAILS_BYTES,
  MAX_REASON_CODE_LENGTH,
  MAX_VERSION_LENGTH,
  YOUTUBE_ID_PATTERN,
};
