/**
 * Retry schedule for delayed caption checks (pure).
 *
 * `captionEnrichmentRetrySchedule` is a comma-separated list of offsets from
 * the download ("1h,24h,7d"): one check at each, so the list length bounds
 * the attempts. Offsets grow, which is the backoff.
 */

const DEFAULT_RETRY_SCHEDULE = '1h,24h,7d';
const MAX_SCHEDULE_ENTRIES = 10;
const MIN_OFFSET_MS = 5 * 60 * 1000;
const MAX_OFFSET_MS = 90 * 24 * 60 * 60 * 1000;
const UNIT_MS = { m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };
const ENTRY = /^(\d{1,4})([mhd])$/;

/**
 * @param {string} value
 * @returns {{offsetsMs: number[]|null, error: string|null}}
 */
function parseRetrySchedule(value) {
  const entries = String(value ?? '').split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  if (!entries.length) return { offsetsMs: null, error: 'Enter at least one retry offset, such as 1h,24h,7d.' };
  if (entries.length > MAX_SCHEDULE_ENTRIES) return { offsetsMs: null, error: `Use at most ${MAX_SCHEDULE_ENTRIES} retry offsets.` };
  const offsetsMs = [];
  for (const entry of entries) {
    const match = ENTRY.exec(entry);
    if (!match) return { offsetsMs: null, error: `"${entry}" is not an offset like 30m, 1h or 7d.` };
    const offset = Number(match[1]) * UNIT_MS[match[2]];
    if (offset < MIN_OFFSET_MS || offset > MAX_OFFSET_MS) {
      return { offsetsMs: null, error: 'Each retry offset must be between 5 minutes and 90 days.' };
    }
    if (offsetsMs.length && offset <= offsetsMs[offsetsMs.length - 1]) {
      return { offsetsMs: null, error: 'Retry offsets must increase.' };
    }
    offsetsMs.push(offset);
  }
  return { offsetsMs, error: null };
}

/** The configured offsets, or the default when the setting is unusable. */
function resolveRetrySchedule(value) {
  const parsed = parseRetrySchedule(value);
  return parsed.offsetsMs || parseRetrySchedule(DEFAULT_RETRY_SCHEDULE).offsetsMs;
}

/**
 * When the next check is due after `attempts` checks, or null when the
 * schedule is used up. Checks keep the schedule's spacing after the previous
 * check, so overdue checks (server offline for days) never run back to back.
 * @param {{baseline: Date, attempts: number, offsetsMs: number[], now: Date, lastAttemptAt?: Date|null}} params
 * @returns {Date|null}
 */
function nextAttemptAt({ baseline, attempts, offsetsMs, now, lastAttemptAt = null }) {
  if (attempts >= offsetsMs.length) return null;
  let due = baseline.getTime() + offsetsMs[attempts];
  if (lastAttemptAt && attempts > 0) {
    due = Math.max(due, lastAttemptAt.getTime() + offsetsMs[attempts] - offsetsMs[attempts - 1]);
  }
  return new Date(Math.max(due, now.getTime()));
}

module.exports = {
  DEFAULT_RETRY_SCHEDULE,
  parseRetrySchedule,
  resolveRetrySchedule,
  nextAttemptAt,
};
