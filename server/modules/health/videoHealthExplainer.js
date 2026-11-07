// Pure explanation of one video's state (issue #18): "why is this video
// missing, why are its captions pending, is its library entry published".
// The caller gathers the inputs; this module only decides. Precedence:
// work in progress, then the file on disk and its later stages, then why a
// file was never acquired (recorded failure, source, ignore, policy, storage).
const { STATUSES, CATEGORIES, CATEGORY_LABELS, STAGES, STAGE_ORDER } = require('./constants');

const PROBLEM = new Set([STATUSES.FAILED, STATUSES.WARNING, STATUSES.PENDING]);
const SOURCE_REASON_CODES = new Set(['source_unavailable', 'source_not_ready']);

function result(state, category, headline, nextStep, extra = {}) {
  return { state, category, categoryLabel: CATEGORY_LABELS[category] || category, headline, nextStep, ...extra };
}

function fromOutcome(outcome, state) {
  return result(state, outcome.category, outcome.message || `${outcome.stage} ${outcome.status}`,
    outcome.retryable ? `Retry the ${outcome.stage} step.` : null,
    { stage: outcome.stage, retryable: outcome.retryable, revision: outcome.revision });
}

function laterStageProblem(outcomes) {
  // The first unresolved stage after acquisition explains a present file.
  return STAGE_ORDER.slice(1)
    .map((stage) => outcomes.find((o) => o.stage === stage))
    .find((o) => o && PROBLEM.has(o.status));
}

function describeStorage(storage) {
  const reasons = (storage && Array.isArray(storage.reasons)) ? storage.reasons : [];
  const text = reasons.map((r) => r.text).filter(Boolean).join('; ');
  const hints = reasons.map((r) => r.resumeHint).filter(Boolean);
  return {
    headline: `The acquisition policy downloads this video, but downloads are paused: ${text || 'storage limit reached'}.`,
    nextStep: hints.length ? hints.join(' ') : 'Free up space or change the limits in Settings > Storage Limits; downloads resume on their own.',
  };
}

/**
 * @param {object} input
 * @param {object|null} input.video - Videos row (plain)
 * @param {object|null} input.listing - ChannelVideo row (plain)
 * @param {Array} input.outcomes - recorded outcomes for this video
 * @param {object|null} input.policy - acquisitionPolicyService.getVideo() result
 * @param {object|null} input.storage - storageGuard status
 * @param {boolean} input.active - queued or downloading right now
 * @param {string} input.removalState - present | deleted | missing (for a row)
 */
function explainVideo({ video = null, listing = null, outcomes = [], policy = null, storage = null, active = false, removalState = null } = {}) {
  if (active) {
    return result('in-progress', CATEGORIES.OK, 'The video is queued or downloading right now.', null);
  }

  if (video && removalState === 'present') {
    const problem = laterStageProblem(outcomes);
    if (problem) return fromOutcome(problem, problem.status === STATUSES.PENDING ? 'pending' : 'attention');
    return result('ok', CATEGORIES.OK, 'Downloaded and every recorded step finished.', null);
  }
  if (video && removalState === 'missing') {
    return result('attention', CATEGORIES.PERMISSION_PATH,
      'The database lists this video, but its file was not found at the last check.',
      'Check that the downloads folder or share is mounted, then run a file rescan in Settings > Maintenance.');
  }
  if (video && removalState === 'deleted') {
    return result('removed', CATEGORIES.POLICY_EXCLUDED,
      `The file was deleted${video.removed_detail ? ` (${video.removed_detail})` : ''}.`,
      'Download it again from the video page if you want it back.');
  }

  const acquisition = outcomes.find((o) => o.stage === STAGES.ACQUISITION);
  if (acquisition && PROBLEM.has(acquisition.status)) {
    return fromOutcome(acquisition, acquisition.status === STATUSES.PENDING ? 'pending' : 'attention');
  }
  if (listing && listing.youtube_removed) {
    return result('attention', CATEGORIES.SOURCE_UNAVAILABLE,
      'YouTube no longer offers this video (removed, private or region-locked).', null);
  }
  if (listing && listing.availability === 'subscriber_only') {
    return result('attention', CATEGORIES.SOURCE_UNAVAILABLE,
      'This is a members-only video; automatic downloads skip it.', 'Download it manually with cookies from a member account.');
  }
  if (listing && listing.ignored) {
    return result('excluded', CATEGORIES.POLICY_EXCLUDED, 'The video is ignored on its channel page.', 'Un-ignore it to make it eligible again.');
  }

  const automatic = policy && policy.automatic;
  if (automatic) {
    const reasons = Array.isArray(automatic.reasons) ? automatic.reasons : [];
    const sourceReason = reasons.find((r) => SOURCE_REASON_CODES.has(r.code));
    if (sourceReason) return result('attention', CATEGORIES.SOURCE_UNAVAILABLE, sourceReason.message, null);
    if (!automatic.jobAction) {
      const explanation = reasons.map((r) => r.message).filter(Boolean).join(' ')
        || `The ${automatic.effectivePolicy ? automatic.effectivePolicy.delivery : 'current'} policy does not download this video automatically.`;
      return result('excluded', CATEGORIES.POLICY_EXCLUDED, explanation, 'A manual download is always allowed.',
        { policyRevision: policyRevisionOf(policy) });
    }
    if (storage && storage.paused) {
      const { headline, nextStep } = describeStorage(storage);
      return result('attention', CATEGORIES.STORAGE_LIMIT, headline, nextStep);
    }
    return result('pending', CATEGORIES.OK, 'Eligible: the next automatic download run will fetch it if the channel filters allow it.', null,
      { policyRevision: policyRevisionOf(policy) });
  }
  if (!listing && !video) {
    return result('unknown', CATEGORIES.OK, 'Youtarr has no record of this video in a tracked channel or download.', null);
  }
  return result('pending', CATEGORIES.OK, 'Not downloaded yet.', null);
}

/** "global.channel.video" revision triple of the policy layers in effect. */
function policyRevisionOf(policy) {
  if (!policy) return null;
  return [policy.globalRevision, policy.channelRevision, policy.revision].map((r) => (Number.isInteger(r) ? r : 0)).join('.');
}

module.exports = { explainVideo, policyRevisionOf };
