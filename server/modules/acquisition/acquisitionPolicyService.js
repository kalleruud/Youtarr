const Channel = require('../../models/channel');
const ChannelVideo = require('../../models/channelvideo');
const Video = require('../../models/video');
const acquisitionPolicyStore = require('./acquisitionPolicyStore');
const { getCapabilities } = require('./capabilities');
const { resolveAcquisitionPolicy } = require('./resolveAcquisitionPolicy');
const {
  DELIVERY_POLICIES,
  LIVE_POLICIES,
  BUILT_IN_DEFAULTS,
  POLICY_SCOPES,
} = require('./policyValues');

// Bounds the per-video exclusions interpolated into a sweep's --match-filter
// (about 17 bytes each, well under the 128 KiB single-argument limit).
const MAX_VIDEO_OVERRIDES = 2000;

const POLICY_CHANGE_NOTE = 'Policy changes apply to future automatic decisions only. '
  + 'Existing downloads, protected videos and their files are kept: nothing is deleted, replaced '
  + 'or downloaded retroactively. Use a manual download or "Download all" to fetch a backlog.';

// The situations a channel's policy is explained for.
const SCENARIOS = Object.freeze([
  { contentKind: 'video', sourceState: 'available' },
  { contentKind: 'short', sourceState: 'available' },
  { contentKind: 'livestream', sourceState: 'upcoming' },
  { contentKind: 'livestream', sourceState: 'live' },
  { contentKind: 'livestream', sourceState: 'replay' },
]);

const LIVE_STATUS_TO_SOURCE_STATE = Object.freeze({
  is_live: 'live',
  is_upcoming: 'upcoming',
  was_live: 'replay',
  post_live: 'replay',
});

class AcquisitionPolicyError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'AcquisitionPolicyError';
    this.status = status;
    this.code = code;
  }
}

function enabledKinds(channel) {
  if (!channel) return null;
  return (channel.auto_download_enabled_tabs ?? '').split(',').map(tab => tab.trim()).filter(Boolean);
}

function explicitOf(policy) {
  return { delivery: policy.delivery, live: policy.live };
}

/**
 * Validate a policy update body: { delivery?, live?, expectedRevision? }.
 * A field set to null clears that layer back to "inherit".
 */
function parsePolicyUpdate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AcquisitionPolicyError(400, 'invalid-body', 'Request body must be a JSON object.');
  }
  const changes = {};
  for (const [field, allowed] of [['delivery', DELIVERY_POLICIES], ['live', LIVE_POLICIES]]) {
    if (!(field in body)) continue;
    const value = body[field];
    if (value !== null && !allowed.includes(value)) {
      throw new AcquisitionPolicyError(400, 'invalid-policy', `${field} must be null (inherit) or one of: ${allowed.join(', ')}.`);
    }
    changes[field] = value;
  }
  if (Object.keys(changes).length === 0) {
    throw new AcquisitionPolicyError(400, 'invalid-body', 'Provide delivery and/or live.');
  }
  const { expectedRevision } = body;
  if (expectedRevision !== undefined && (!Number.isInteger(expectedRevision) || expectedRevision < 0)) {
    throw new AcquisitionPolicyError(400, 'invalid-revision', 'expectedRevision must be a non-negative integer.');
  }
  return { changes, expectedRevision };
}

class AcquisitionPolicyService {
  explain({ global, channel = {}, video = {}, kinds = null }) {
    const capabilities = getCapabilities();
    return SCENARIOS.map(({ contentKind, sourceState }) => ({
      contentKind,
      sourceState,
      ...resolveAcquisitionPolicy({
        global,
        channel,
        video,
        contentKind,
        sourceState,
        capabilities,
        contentKindEnabled: kinds ? kinds.includes(contentKind) : true,
      }),
    }));
  }

  async withConflictMapping(work) {
    try {
      return await work();
    } catch (err) {
      if (err instanceof acquisitionPolicyStore.PolicyRevisionConflictError) {
        const conflict = new AcquisitionPolicyError(409, 'revision-conflict', err.message);
        conflict.currentRevision = err.currentRevision;
        throw conflict;
      }
      throw err;
    }
  }

  async getGlobal() {
    const policy = await acquisitionPolicyStore.getGlobal();
    return {
      scope: POLICY_SCOPES.GLOBAL,
      explicit: explicitOf(policy),
      builtInDefaults: BUILT_IN_DEFAULTS,
      revision: policy.revision,
      capabilities: getCapabilities(),
      decisions: this.explain({ global: policy }),
      note: POLICY_CHANGE_NOTE,
    };
  }

  async updateGlobal(body) {
    const { changes, expectedRevision } = parsePolicyUpdate(body);
    await this.withConflictMapping(() => acquisitionPolicyStore.set(
      POLICY_SCOPES.GLOBAL, acquisitionPolicyStore.GLOBAL_SUBJECT, changes, { expectedRevision }
    ));
    return this.getGlobal();
  }

  async findChannel(channelId) {
    const channel = await Channel.findOne({ where: { channel_id: channelId } });
    if (!channel) throw new AcquisitionPolicyError(404, 'channel-not-found', 'Channel not found.');
    return channel;
  }

  async getChannel(channelId) {
    const channel = await this.findChannel(channelId);
    const [global, policy] = await Promise.all([
      acquisitionPolicyStore.getGlobal(),
      acquisitionPolicyStore.get(POLICY_SCOPES.CHANNEL, channelId),
    ]);
    return {
      scope: POLICY_SCOPES.CHANNEL,
      channelId,
      explicit: explicitOf(policy),
      revision: policy.revision,
      globalRevision: global.revision,
      autoDownloadEnabled: !!channel.enabled,
      capabilities: getCapabilities(),
      decisions: this.explain({ global, channel: policy, kinds: enabledKinds(channel) }),
      note: POLICY_CHANGE_NOTE,
    };
  }

  async updateChannel(channelId, body) {
    const { changes, expectedRevision } = parsePolicyUpdate(body);
    await this.findChannel(channelId);
    await this.withConflictMapping(() => acquisitionPolicyStore.set(
      POLICY_SCOPES.CHANNEL, channelId, changes, { expectedRevision }
    ));
    return this.getChannel(channelId);
  }

  async findVideo(youtubeId) {
    const [listing, video] = await Promise.all([
      ChannelVideo.findOne({ where: { youtube_id: youtubeId } }),
      Video.findOne({ where: { youtubeId } }),
    ]);
    const channelId = (listing && listing.channel_id) || (video && video.channel_id) || null;
    if (!channelId) {
      throw new AcquisitionPolicyError(404, 'video-not-found', 'Video not found in any tracked channel listing or download.');
    }
    return { listing, video, channelId };
  }

  async getVideo(youtubeId) {
    const { listing, video, channelId } = await this.findVideo(youtubeId);
    const [global, channelPolicy, override, channel] = await Promise.all([
      acquisitionPolicyStore.getGlobal(),
      acquisitionPolicyStore.get(POLICY_SCOPES.CHANNEL, channelId),
      acquisitionPolicyStore.get(POLICY_SCOPES.VIDEO, youtubeId),
      Channel.findOne({ where: { channel_id: channelId } }),
    ]);
    const contentKind = (listing && listing.media_type) || (video && video.media_type) || 'video';
    const unavailable = (listing && listing.youtube_removed) || (video && video.youtube_removed);
    let sourceState = 'available';
    if (unavailable) sourceState = 'unavailable';
    else if (contentKind === 'livestream') sourceState = LIVE_STATUS_TO_SOURCE_STATE[listing && listing.live_status] || 'replay';
    const kinds = enabledKinds(channel);
    const common = {
      global,
      channel: channelPolicy,
      video: override,
      contentKind,
      sourceState,
      capabilities: getCapabilities(),
      youtubeId,
    };
    return {
      scope: POLICY_SCOPES.VIDEO,
      youtubeId,
      channelId,
      contentKind,
      sourceState,
      explicit: explicitOf(override),
      revision: override.revision,
      channelRevision: channelPolicy.revision,
      globalRevision: global.revision,
      hasLocalCopy: !!(video && !video.removed),
      protected: !!(video && video.protected),
      automatic: resolveAcquisitionPolicy({
        ...common,
        contentKindEnabled: kinds ? kinds.includes(contentKind) : true,
      }),
      manual: resolveAcquisitionPolicy({ ...common, trigger: 'manual' }),
      capabilities: getCapabilities(),
      note: POLICY_CHANGE_NOTE,
    };
  }

  async updateVideo(youtubeId, body) {
    const { changes, expectedRevision } = parsePolicyUpdate(body);
    const { channelId } = await this.findVideo(youtubeId);
    const current = await acquisitionPolicyStore.get(POLICY_SCOPES.VIDEO, youtubeId);
    const addsOverride = current.delivery === null && current.live === null
      && Object.values(changes).some(value => value !== null);
    if (addsOverride && (await acquisitionPolicyStore.countVideoOverrides()) >= MAX_VIDEO_OVERRIDES) {
      throw new AcquisitionPolicyError(409, 'override-limit',
        `At most ${MAX_VIDEO_OVERRIDES} videos can have their own policy. Clear unused video overrides or change the channel policy instead.`);
    }
    await this.withConflictMapping(() => acquisitionPolicyStore.set(
      POLICY_SCOPES.VIDEO, youtubeId, changes, { expectedRevision, channelId }
    ));
    return this.getVideo(youtubeId);
  }

  async clearVideo(youtubeId, { expectedRevision } = {}) {
    return this.updateVideo(youtubeId, { delivery: null, live: null, expectedRevision });
  }
}

const service = new AcquisitionPolicyService();
service.AcquisitionPolicyError = AcquisitionPolicyError;
service.MAX_VIDEO_OVERRIDES = MAX_VIDEO_OVERRIDES;
service.parsePolicyUpdate = parsePolicyUpdate;

module.exports = service;
