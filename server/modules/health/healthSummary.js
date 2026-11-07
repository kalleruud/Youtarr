// The compact acquisition-health overview (issue #18): storage pause and how
// to resume, unresolved outcomes by stage and category, stale channel checks,
// download leases, and the versions failures are stamped with. Reads only.
const logger = require('../../logger');
const configModule = require('../configModule');
const Channel = require('../../models/channel');
const JobVideoDownload = require('../../models/jobvideodownload');
const storageGuard = require('../storageGuard');
const videoActivity = require('../download/videoActivity');
const scheduledTaskRuns = require('../scheduledTaskRuns');
const outcomeStore = require('./outcomeStore');
const { getVersions } = require('./runtimeVersions');
const { CATEGORY_LABELS } = require('./constants');

// A channel whose listing has not been refreshed for this long is reported
// as stale (the automatic download run refreshes listings it checks).
const STALE_CHANNEL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_STALE_CHANNELS_LISTED = 20;
const RECENT_OUTCOMES = 20;
const AUTO_DOWNLOAD_TASK_KEY = 'channelDownloadFrequency';

function newestFetch(lastFetchedByTab) {
  if (!lastFetchedByTab) return null;
  try {
    const parsed = typeof lastFetchedByTab === 'string' ? JSON.parse(lastFetchedByTab) : lastFetchedByTab;
    const times = Object.values(parsed || {}).map((t) => Date.parse(t)).filter(Number.isFinite);
    return times.length ? Math.max(...times) : null;
  } catch {
    return null;
  }
}

async function staleChannels(now) {
  const channels = await Channel.findAll({
    where: { enabled: true },
    attributes: ['channel_id', 'title', 'uploader', 'lastFetchedByTab'],
    raw: true,
  });
  const stale = channels
    .map((c) => ({ channelId: c.channel_id, title: c.title || c.uploader || c.channel_id, lastCheckedAt: newestFetch(c.lastFetchedByTab) }))
    .filter((c) => c.lastCheckedAt === null || now - c.lastCheckedAt > STALE_CHANNEL_MS)
    .sort((a, b) => (a.lastCheckedAt || 0) - (b.lastCheckedAt || 0));
  return {
    enabledCount: channels.length,
    staleCount: stale.length,
    thresholdDays: STALE_CHANNEL_MS / (24 * 60 * 60 * 1000),
    channels: stale.slice(0, MAX_STALE_CHANNELS_LISTED).map((c) => ({
      ...c, lastCheckedAt: c.lastCheckedAt ? new Date(c.lastCheckedAt).toISOString() : null,
    })),
  };
}

async function safely(label, work, fallback) {
  try {
    return await work();
  } catch (err) {
    logger.warn({ err, part: label }, 'Health summary part unavailable');
    return fallback;
  }
}

async function build({ now = Date.now() } = {}) {
  const config = configModule.getConfig() || {};
  const [storage, problems, recent, channels, inProgressLeases, lastAutoDownload] = await Promise.all([
    safely('storage', () => storageGuard.refresh(), storageGuard.getStatus()),
    safely('problems', () => outcomeStore.countProblems(), []),
    safely('recent', () => outcomeStore.list({ limit: RECENT_OUTCOMES }), { outcomes: [], total: 0 }),
    safely('channels', () => staleChannels(now), null),
    safely('leases', () => JobVideoDownload.count({ where: { status: 'in_progress' } }), null),
    safely('autoDownload', () => scheduledTaskRuns.getLatestRun(AUTO_DOWNLOAD_TASK_KEY), null),
  ]);
  return {
    generatedAt: new Date(now).toISOString(),
    storage: {
      paused: Boolean(storage && storage.paused),
      pausedSince: storage ? storage.pausedSince : null,
      reasons: storage ? storage.reasons : [],
      usage: storage ? storage.usage : null,
      freeSpace: storage ? storage.freeSpace : null,
      tempFreeSpace: storage ? storage.tempFreeSpace : null,
      checkedAt: storage ? storage.checkedAt : null,
    },
    problems: problems.map((p) => ({ ...p, categoryLabel: CATEGORY_LABELS[p.category] || p.category })),
    recent: recent.outcomes,
    unresolvedTotal: recent.total,
    channels: channels && {
      ...channels,
      autoDownloadEnabled: Boolean(config.channelAutoDownload),
      lastAutoDownloadRun: lastAutoDownload,
    },
    leases: {
      activeVideos: Object.keys(videoActivity.snapshot().videos).length,
      inProgressDownloads: inProgressLeases,
    },
    // Live detection and capture gaps have nothing to report until live
    // recording exists; say so rather than show an empty healthy state.
    live: { tracked: false, message: 'Live detection delay and capture gaps are reported once live recording is available.' },
    versions: getVersions(),
  };
}

module.exports = { build, newestFetch, STALE_CHANNEL_MS };
