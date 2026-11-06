// Shared vocabulary of acquisition policies (issue #10). Pure constants: the
// resolver, store, sweep planner and route validation all read these.

const DELIVERY_POLICIES = Object.freeze(['download', 'stream']);
const LIVE_POLICIES = Object.freeze(['ignore', 'replay', 'play', 'record', 'play_and_record']);

// Built-in defaults reproduce Youtarr's behavior before policies existed:
// normal videos download automatically and the streams tab only ever picked
// up finished broadcasts (the channel match filter skips live/upcoming ones).
const BUILT_IN_DEFAULTS = Object.freeze({ delivery: 'download', live: 'replay' });

const CONTENT_KINDS = Object.freeze(['video', 'short', 'livestream']);

// 'replay' is a broadcast that has ended and is available as a normal VOD.
const SOURCE_STATES = Object.freeze(['available', 'unavailable', 'upcoming', 'live', 'replay']);

const TRIGGERS = Object.freeze(['automatic', 'manual']);

const POLICY_SCOPES = Object.freeze({ GLOBAL: 'global', CHANNEL: 'channel', VIDEO: 'video' });

// Actions that produce a queued job. Streaming and live playback are served on
// demand and never occupy the download queue.
const JOB_ACTIONS = Object.freeze(['download', 'liveRecording']);

module.exports = {
  DELIVERY_POLICIES,
  LIVE_POLICIES,
  BUILT_IN_DEFAULTS,
  CONTENT_KINDS,
  SOURCE_STATES,
  TRIGGERS,
  POLICY_SCOPES,
  JOB_ACTIONS,
};
