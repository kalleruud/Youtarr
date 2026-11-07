// What this build can actually do. Requested intent (a policy) is kept apart
// from capability: a channel may ask to stream before streaming ships, and the
// resolver then explains why nothing is queued instead of enqueueing a job
// that cannot run. Flip an entry only when its feature passes its release gate
// (streaming: #12/#13, live: #15/#16).

const CAPABILITIES = Object.freeze({
  download: Object.freeze({ available: true, label: 'Download' }),
  stream: Object.freeze({
    available: false,
    label: 'Stream on demand',
    reason: 'On-demand streaming is not available in this Youtarr version yet. '
      + 'Nothing is queued for these videos; choose "Download automatically" or download them manually.',
  }),
  livePlayback: Object.freeze({
    available: false,
    label: 'Live playback',
    reason: 'Live playback is not available in this Youtarr version yet. '
      + 'After the broadcast ends, its replay follows the normal video setting.',
  }),
  liveRecording: Object.freeze({
    available: false,
    label: 'Record while live',
    reason: 'Recording while live is not available in this Youtarr version yet. '
      + 'After the broadcast ends, its replay follows the normal video setting.',
  }),
});

function getCapabilities() {
  return CAPABILITIES;
}

module.exports = { getCapabilities, CAPABILITIES };
