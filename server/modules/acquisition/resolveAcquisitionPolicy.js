const {
  DELIVERY_POLICIES,
  LIVE_POLICIES,
  BUILT_IN_DEFAULTS,
  CONTENT_KINDS,
  JOB_ACTIONS,
} = require('./policyValues');

// Pure acquisition-policy resolution (issue #10).
//
// Precedence per field, independently for `delivery` (normal videos) and
// `live` (livestreams): explicit video override > channel > global > built-in.
// A value of null/undefined at a layer means "inherit".
//
// The result never contains a destructive action: a policy only decides what
// happens to future acquisitions. Deleting copies, replacing them or fetching
// a backlog are separate, previewed actions outside this module.

const VALUES = Object.freeze({ delivery: DELIVERY_POLICIES, live: LIVE_POLICIES });

const LAYERS = Object.freeze(['video', 'channel', 'global']);

function resolveField(field, inputs, reasons) {
  for (const source of LAYERS) {
    const layer = inputs[source];
    const value = layer ? layer[field] : undefined;
    if (value === undefined || value === null) continue;
    if (!VALUES[field].includes(value)) {
      reasons.push({
        code: 'invalid_policy',
        field,
        source,
        message: `The ${source} ${field} policy "${value}" is not recognized. Choose one of: ${VALUES[field].join(', ')}.`,
      });
      return { value: null, source };
    }
    return { value, source };
  }
  return { value: BUILT_IN_DEFAULTS[field], source: 'default' };
}

function capabilityOf(capabilities, action) {
  const entry = capabilities ? capabilities[action] : undefined;
  if (entry === true || entry === false) return { available: entry };
  return entry || null;
}

function createPlanner(capabilities, reasons) {
  const plannedActions = [];
  const request = (action) => {
    const capability = capabilityOf(capabilities, action);
    if (capability && capability.available === true) {
      if (!plannedActions.includes(action)) plannedActions.push(action);
      return;
    }
    if (!capability) {
      reasons.push({
        code: 'capability_unknown',
        action,
        message: `Youtarr could not confirm that "${action}" is supported, so nothing was queued. Update Youtarr or choose another policy.`,
      });
      return;
    }
    reasons.push({
      code: 'capability_unavailable',
      action,
      message: capability.reason || `"${capability.label || action}" is not available in this Youtarr version. Choose another policy.`,
    });
  };
  return { plannedActions, request };
}

function planManual({ contentKind, sourceState, request, reasons }) {
  if (contentKind === 'livestream' && (sourceState === 'live' || sourceState === 'upcoming')) {
    reasons.push({
      code: 'source_not_ready',
      message: 'This broadcast has not ended yet. Download it manually once its replay is available.',
    });
    return;
  }
  request('download');
}

function planLivestream({ live, delivery, sourceState, capabilities, request, reasons }) {
  if (live === 'ignore') {
    reasons.push({ code: 'policy_excluded', message: 'Livestreams are ignored by policy, including their replays.' });
    return;
  }
  const wantsPlayback = live === 'play' || live === 'play_and_record';
  const wantsRecording = live === 'record' || live === 'play_and_record';

  if (sourceState === 'replay') {
    // A finished broadcast is one logical episode: its replay follows the
    // normal delivery policy whatever the live mode was.
    request(delivery);
    return;
  }
  if (sourceState === 'upcoming') {
    reasons.push({ code: 'waiting_for_broadcast', message: 'The broadcast has not started yet.' });
    // Report unsupported live modes now so the setting can be fixed before it starts.
    const deferred = createPlanner(capabilities, reasons);
    if (wantsPlayback) deferred.request('livePlayback');
    if (wantsRecording) deferred.request('liveRecording');
    return;
  }
  if (sourceState === 'live') {
    if (live === 'replay') {
      reasons.push({ code: 'waiting_for_replay', message: 'Waiting for the broadcast to end; its replay follows the normal video setting.' });
      return;
    }
    if (wantsPlayback) request('livePlayback');
    if (wantsRecording) request('liveRecording');
    return;
  }
  reasons.push({ code: 'source_not_ready', message: 'The broadcast state is unknown; refresh the channel to check it again.' });
}

/**
 * Resolve the effective acquisition policy and what to do next for one video.
 *
 * @param {Object} input
 * @param {{delivery?: string|null, live?: string|null}} [input.global]
 * @param {{delivery?: string|null, live?: string|null}} [input.channel]
 * @param {{delivery?: string|null, live?: string|null}} [input.video] explicit per-video override
 * @param {string} input.contentKind 'video' | 'short' | 'livestream'
 * @param {string} input.sourceState 'available' | 'unavailable' | 'upcoming' | 'live' | 'replay'
 * @param {Object} input.capabilities map of action -> boolean | { available, label, reason }
 * @param {string} [input.trigger] 'automatic' (sweeps; default) or 'manual' (a user request)
 * @param {boolean} [input.contentKindEnabled] false when the channel's tab filter excludes this kind
 * @param {string} [input.youtubeId] identifies the single logical item the plan is for
 * @returns {{effectivePolicy: Object, plannedActions: string[], jobAction: string|null,
 *   logicalItem: string|null, reasons: Object[]}}
 */
function resolveAcquisitionPolicy({
  global = {},
  channel = {},
  video = {},
  contentKind,
  sourceState,
  capabilities = {},
  trigger = 'automatic',
  contentKindEnabled = true,
  youtubeId = null,
} = {}) {
  const reasons = [];
  const inputs = { global, channel, video };
  const delivery = resolveField('delivery', inputs, reasons);
  const live = resolveField('live', inputs, reasons);
  const effectivePolicy = {
    delivery: delivery.value,
    live: live.value,
    sources: { delivery: delivery.source, live: live.source },
  };
  const { plannedActions, request } = createPlanner(capabilities, reasons);
  const result = () => {
    // At most one queued job per logical item: live playback and streaming are
    // on demand, and recording (live) and downloading (replay) apply to
    // mutually exclusive source states of the same video identity.
    const jobAction = plannedActions.find(action => JOB_ACTIONS.includes(action)) || null;
    return { effectivePolicy, plannedActions, jobAction, logicalItem: youtubeId, reasons };
  };

  if (!delivery.value || !live.value) return result();
  if (!CONTENT_KINDS.includes(contentKind)) {
    reasons.push({ code: 'unknown_content_kind', message: 'The content type is unknown; refresh the channel to read it again.' });
    return result();
  }
  // Source availability is reported before, and separately from, policy.
  if (sourceState === 'unavailable') {
    reasons.push({ code: 'source_unavailable', message: 'The video is unavailable on YouTube (removed, private or region-locked). Retry when it is accessible.' });
    return result();
  }
  if (trigger === 'manual') {
    // Policy only governs automatic decisions: anything, including a
    // stream-only video, stays eligible for an explicit manual download.
    planManual({ contentKind, sourceState, request, reasons });
    return result();
  }
  const hasVideoOverride = delivery.source === 'video' || live.source === 'video';
  if (contentKindEnabled === false && !hasVideoOverride) {
    reasons.push({ code: 'content_kind_filtered', message: `The channel's automatic download tabs exclude ${contentKind}s.` });
    return result();
  }
  if (contentKind === 'livestream') {
    planLivestream({ live: live.value, delivery: delivery.value, sourceState, capabilities, request, reasons });
    return result();
  }
  if (sourceState !== 'available') {
    reasons.push({ code: 'source_not_ready', message: 'The video is not published yet.' });
    return result();
  }
  request(delivery.value);
  return result();
}

module.exports = { resolveAcquisitionPolicy };
