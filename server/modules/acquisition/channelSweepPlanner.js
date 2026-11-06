const { Op } = require('sequelize');
const ChannelVideo = require('../../models/channelvideo');
const Video = require('../../models/video');
const archiveModule = require('../archiveModule');
const channelIdentity = require('../channel/channelIdentity');
const acquisitionPolicyStore = require('./acquisitionPolicyStore');
const { getCapabilities } = require('./capabilities');
const { resolveAcquisitionPolicy } = require('./resolveAcquisitionPolicy');

// auto_download_enabled_tabs stores 'video', 'short', 'livestream'; the
// channel URLs need 'videos', 'shorts', 'streams'. Unknown entries keep the
// historical fallback to the videos tab.
const TAB_URL_SEGMENTS = Object.freeze({ video: 'videos', short: 'shorts', livestream: 'streams' });

// What a channel sweep can actually fetch for each kind: the channel match
// filter skips live and upcoming broadcasts, so the streams tab only ever
// yields finished broadcasts (replays).
const SWEEP_SOURCE_STATE = Object.freeze({ video: 'available', short: 'available', livestream: 'replay' });

const watchUrl = youtubeId => `https://www.youtube.com/watch?v=${youtubeId}`;

function parseEnabledKinds(value) {
  return (value ?? '')
    .split(',')
    .map(tab => tab.trim())
    .filter(Boolean)
    .map(tab => (TAB_URL_SEGMENTS[tab] ? tab : 'video'));
}

function decide(inputs, capabilities) {
  return resolveAcquisitionPolicy({
    ...inputs,
    sourceState: SWEEP_SOURCE_STATE[inputs.contentKind] || 'available',
    capabilities,
    trigger: 'automatic',
  });
}

/**
 * Pure: turn enabled channels plus their policies into the yt-dlp targets of
 * an automatic channel sweep.
 *
 * - A channel tab is fetched only when its kind's effective policy downloads.
 * - A video override that stops a download on a fetched tab becomes an
 *   excluded id (applied through --match-filter).
 * - A video override that asks for a download on a tab that is not fetched
 *   adds that one video, unless it was already acquired (has a Videos row or
 *   an archive entry): a deleted copy is never fetched again by policy.
 *
 * @returns {{urls: string[], excludedVideoIds: string[], skipped: Object[]}}
 */
function planChannelSweep({
  channels,
  globalPolicy = {},
  channelPolicies = new Map(),
  videoOverrides = [],
  mediaTypes = new Map(),
  acquiredIds = new Set(),
  capabilities = getCapabilities(),
  resolveChannelUrl,
  includeLegacyUrls = true,
}) {
  const urls = [];
  const excludedVideoIds = [];
  const skipped = [];
  const addUrl = (url) => { if (!urls.includes(url)) urls.push(url); };
  const overridesByChannel = new Map();
  for (const override of videoOverrides) {
    if (!overridesByChannel.has(override.channelId)) overridesByChannel.set(override.channelId, []);
    overridesByChannel.get(override.channelId).push(override);
  }

  for (const channel of channels) {
    if (!channel.channel_id) {
      // Legacy rows without an id cannot carry a channel policy; the global
      // policy for normal videos still decides whether they are fetched.
      const decision = decide({ global: globalPolicy, contentKind: 'video' }, capabilities);
      if (decision.jobAction === 'download') {
        if (includeLegacyUrls && channel.url) addUrl(channel.url);
      } else {
        skipped.push({ channelId: null, contentKind: 'video', reasons: decision.reasons });
      }
      continue;
    }
    const channelPolicy = channelPolicies.get(channel.channel_id) || {};
    const canonical = resolveChannelUrl(channel.channel_id);
    const enabledKinds = parseEnabledKinds(channel.auto_download_enabled_tabs);
    const fetchedKinds = new Set();

    for (const contentKind of new Set(enabledKinds)) {
      const decision = decide({ global: globalPolicy, channel: channelPolicy, contentKind }, capabilities);
      if (decision.jobAction === 'download') {
        fetchedKinds.add(contentKind);
        addUrl(`${canonical}/${TAB_URL_SEGMENTS[contentKind]}`);
      } else {
        skipped.push({ channelId: channel.channel_id, contentKind, reasons: decision.reasons });
      }
    }

    for (const override of overridesByChannel.get(channel.channel_id) || []) {
      const contentKind = mediaTypes.get(override.youtubeId) || 'video';
      const decision = decide({
        global: globalPolicy,
        channel: channelPolicy,
        video: override,
        contentKind,
        contentKindEnabled: enabledKinds.includes(contentKind),
        youtubeId: override.youtubeId,
      }, capabilities);
      const downloads = decision.jobAction === 'download';
      if (fetchedKinds.has(contentKind) && !downloads) {
        excludedVideoIds.push(override.youtubeId);
      } else if (!fetchedKinds.has(contentKind) && downloads && !acquiredIds.has(override.youtubeId)) {
        addUrl(watchUrl(override.youtubeId));
      }
    }
  }
  return { urls, excludedVideoIds, skipped };
}

async function findAcquiredIds(youtubeIds) {
  if (youtubeIds.length === 0) return new Set();
  const rows = await Video.findAll({ where: { youtubeId: { [Op.in]: youtubeIds } }, attributes: ['youtubeId'] });
  const acquired = new Set(rows.map(row => row.youtubeId));
  for (const id of archiveModule.filterArchivedVideoIds(youtubeIds)) acquired.add(id);
  return acquired;
}

async function findMediaTypes(youtubeIds) {
  const mediaTypes = new Map();
  if (youtubeIds.length === 0) return mediaTypes;
  const rows = await ChannelVideo.findAll({ where: { youtube_id: { [Op.in]: youtubeIds } }, attributes: ['youtube_id', 'media_type'] });
  for (const row of rows) if (row.media_type) mediaTypes.set(row.youtube_id, row.media_type);
  return mediaTypes;
}

/**
 * Load the policies for `channels` and plan their automatic sweep.
 * @param {Array} channels Channel rows with channel_id, url, auto_download_enabled_tabs
 * @param {{includeLegacyUrls?: boolean}} [options]
 */
async function loadChannelSweepPlan(channels, { includeLegacyUrls = true } = {}) {
  const channelIds = channels.map(channel => channel.channel_id).filter(Boolean);
  const [globalPolicy, channelPolicies, videoOverrides] = await Promise.all([
    acquisitionPolicyStore.getGlobal(),
    acquisitionPolicyStore.getChannelPolicies(channelIds),
    acquisitionPolicyStore.getVideoOverridesForChannels(channelIds),
  ]);
  const overrideIds = videoOverrides.map(override => override.youtubeId);
  const [mediaTypes, acquiredIds] = await Promise.all([findMediaTypes(overrideIds), findAcquiredIds(overrideIds)]);
  return planChannelSweep({
    channels,
    globalPolicy,
    channelPolicies,
    videoOverrides,
    mediaTypes,
    acquiredIds,
    resolveChannelUrl: id => channelIdentity.resolveChannelUrlFromId(id),
    includeLegacyUrls,
  });
}

module.exports = { planChannelSweep, loadChannelSweepPlan, TAB_URL_SEGMENTS, SWEEP_SOURCE_STATE };
