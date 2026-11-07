const { KINDS, STATES, MODES, COMPLETE_LOCAL_KINDS } = require('./representationValues');

// Pure playback selection for one logical episode (issue #14). The caller
// checks the filesystem and passes each candidate with `usable` set; nothing
// here touches the network, so a usable local copy is chosen even when
// YouTube is unreachable or the video was removed there.
//
// Order:
//   1. an explicitly selected representation, when it is still usable
//   2. a complete verified local copy (local download > complete recording > cache)
//   3. the upstream source, when streaming is available and the source exists
//   4. a partial recording, flagged as partial
//   5. nothing: unavailable, with the reasons

function isCompleteLocal(candidate) {
  return candidate.usable && COMPLETE_LOCAL_KINDS.includes(candidate.kind) && candidate.state === STATES.VERIFIED;
}

function isPartialRecording(candidate) {
  return candidate.usable && candidate.kind === KINDS.RECORDING && candidate.state === STATES.PARTIAL;
}

function streamEntry(candidates) {
  return candidates.find(c => c.kind === KINDS.STRM && c.state === STATES.PUBLISHED)
    || candidates.find(c => c.kind === KINDS.STRM)
    || null;
}

function upstreamBlockers(upstream) {
  const reasons = [];
  if (!upstream || !upstream.capable) {
    reasons.push({ code: 'stream_unavailable', message: 'On-demand streaming is not available in this Youtarr version.' });
  }
  if (upstream && upstream.sourceAvailable === false) {
    reasons.push({ code: 'source_removed', message: 'The video is no longer available on YouTube.' });
  }
  return reasons;
}

/**
 * @param {Object} input
 * @param {Array<{id: (number|null), kind: string, state: string, usable: boolean, legacy?: boolean}>} input.candidates
 * @param {(number|null)} [input.selectedId] explicitly selected representation id
 * @param {{capable: boolean, sourceAvailable: boolean}} input.upstream
 * @returns {{mode: string, representation: (Object|null), partial: boolean, explicit: boolean, reasons: Object[]}}
 */
function selectRepresentation({ candidates = [], selectedId = null, upstream }) {
  const reasons = [];
  const result = (mode, representation, extra = {}) => ({
    mode, representation, partial: false, explicit: false, reasons, ...extra,
  });

  const blockers = upstreamBlockers(upstream);
  if (selectedId != null) {
    const selected = candidates.find(c => c.id === selectedId);
    if (selected && selected.kind === KINDS.STRM && blockers.length === 0) {
      return result(MODES.UPSTREAM, selected, { explicit: true });
    }
    if (selected && selected.kind !== KINDS.STRM && selected.usable) {
      return result(MODES.LOCAL, selected, { explicit: true, partial: selected.state === STATES.PARTIAL });
    }
    reasons.push({
      code: 'selected_unavailable',
      message: 'The selected version is no longer available; using the best remaining copy.',
    });
  }

  for (const kind of COMPLETE_LOCAL_KINDS) {
    const local = candidates.find(c => c.kind === kind && isCompleteLocal(c));
    if (local) return result(MODES.LOCAL, local);
  }
  const unusable = candidates.filter(c => c.kind !== KINDS.STRM && !c.usable && c.state !== STATES.EVICTED);
  if (unusable.length > 0) {
    reasons.push({ code: 'local_copy_missing', message: 'A recorded local copy is missing or changed on disk.' });
  }

  if (blockers.length === 0) return result(MODES.UPSTREAM, streamEntry(candidates));

  const partial = candidates.find(isPartialRecording);
  if (partial) {
    reasons.push(...blockers, { code: 'partial_only', message: 'Only a partial recording is available; it has gaps.' });
    return result(MODES.LOCAL, partial, { partial: true });
  }
  reasons.push(...blockers);
  return result(MODES.UNAVAILABLE, null);
}

module.exports = { selectRepresentation };
