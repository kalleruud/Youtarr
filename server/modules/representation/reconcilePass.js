// Periodic convergence of episodes that may show two visible entries (issue
// #14). Every event reconciles its own episode, but a STRM entry kept because
// the watch-state snapshot failed, and whose next promotion failed too, would
// otherwise wait for an event that may never come. This pass runs after the
// filesystem rescan (nightly by default, and once at startup) over episodes
// with a published STRM record and a local copy: the candidate lookup is a
// fixed number of queries (one when nothing is published, as while streaming
// is off), and only candidates cost file checks. Each candidate is reconciled
// under its lease, which puts back a file an interrupted eviction left aside,
// records the STRM item's watch state and only then removes the STRM entry.
// Local media is never removed here.
const path = require('path');
const { Op } = require('sequelize');
const logger = require('../../logger');
const Video = require('../../models/video');
const store = require('./representationStore');
const { recoverTombstones } = require('./localTombstone');
const { LEASE_OPERATIONS } = require('./representationValues');

// Bounds one run; the rest wait for the next run.
const MAX_EPISODES_PER_RUN = 500;

async function findLibraryFiles(youtubeIds) {
  const rows = await Video.findAll({
    where: { youtubeId: { [Op.in]: youtubeIds }, filePath: { [Op.ne]: null }, removed: false },
    attributes: ['youtubeId', 'filePath'],
    raw: true,
  });
  return new Map(rows.map(row => [row.youtubeId, row.filePath]));
}

async function reconcileOne(facade, candidate, counts) {
  try {
    await facade.withPublicationLease(candidate.youtubeId, LEASE_OPERATIONS.RECONCILE, async (lease) => {
      const dirs = new Set(candidate.localLocations.map(location => path.dirname(location)));
      for (const dir of dirs) {
        const recovered = await recoverTombstones(dir, candidate.youtubeId);
        counts.restoredFiles += recovered.restored.length;
      }
      const result = await facade._reconcileUnderLease(lease, candidate.youtubeId);
      if (result.snapshotError) counts.snapshotFailed += 1;
      else if (result.failed) counts.failed += 1;
      else if (result.removed.length || result.retired) counts.reconciled += 1;
      else counts.unchanged += 1;
    });
  } catch (err) {
    if (err.code === 'LEASE_BUSY') {
      counts.busy += 1;
      return;
    }
    counts.failed += 1;
    logger.warn({ err, youtubeId: candidate.youtubeId }, 'Could not reconcile the episode entries');
  }
}

/**
 * @param {Object} facade - the representation facade (index.js)
 * @param {{maxEpisodes?: number}} [options]
 * @returns {Promise<{candidates: number, reconciled: number, unchanged: number, busy: number,
 *   snapshotFailed: number, failed: number, restoredFiles: number, deferred: number}>}
 */
async function run(facade, { maxEpisodes = MAX_EPISODES_PER_RUN } = {}) {
  const counts = {
    candidates: 0, reconciled: 0, unchanged: 0, busy: 0, snapshotFailed: 0, failed: 0, restoredFiles: 0, deferred: 0,
  };
  const candidates = await store.listDuplicateCandidates({ findLibraryFiles });
  counts.candidates = candidates.length;
  counts.deferred = Math.max(0, candidates.length - maxEpisodes);
  for (const candidate of candidates.slice(0, maxEpisodes)) {
    await reconcileOne(facade, candidate, counts);
  }
  if (counts.reconciled || counts.restoredFiles || counts.busy || counts.snapshotFailed || counts.failed || counts.deferred) {
    const level = counts.snapshotFailed || counts.failed ? 'warn' : 'info';
    logger[level](counts, 'Reconciled episodes with both a STRM entry and a local copy');
  }
  return counts;
}

module.exports = { run, MAX_EPISODES_PER_RUN };
