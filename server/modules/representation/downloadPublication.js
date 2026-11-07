// TV publication of a finished download over a streamed episode (issue #14).
// Runs on the representation facade (index.js), which owns leases and records.
const path = require('path');
const logger = require('../../logger');
const store = require('./representationStore');
const { findStreamEntries } = require('./localAsset');
const { LEASE_OPERATIONS } = require('./representationValues');

// A download waits out a STRM publication (whose lease expires after two
// minutes) rather than publishing beside it.
const PROMOTION_LEASE_WAIT_MS = 150 * 1000;

// The file is published: record it, never failing the download.
async function promoteAfterPublish(facade, youtubeId, mediaPath, lease) {
  try {
    await facade.promoteDownloadedAsset(youtubeId, { location: mediaPath }, lease ? { lease } : { waitMs: 0 });
  } catch (err) {
    logger.warn({ err, youtubeId }, 'Could not record the download as the episode representation; the next event reconciles it');
  }
}

/**
 * publish() only ever replaces a STRM entry in the planned file's folder, so
 * when that folder holds none (every video that was never streamed), it runs
 * straight away, as before representations existed: no lease, no database
 * access first. Otherwise the watch state of the STRM entry is recorded
 * before publish() runs, under the lease; publish({ keepStreamEntries }) must
 * keep STRM entries in place when asked (the snapshot failed or could not be
 * checked), and the next event or the periodic reconcile pass removes them.
 * Never fails the download because of representations: a busy lease or a
 * database error is logged and the file is published anyway (the lease
 * holder, the next promotion or publication, or the reconcile pass converges
 * the episode to the local file; an eviction only ever deletes the file it
 * previewed, see localTombstone).
 */
async function publish(facade, youtubeId, { plannedLocation, publish: publishFiles }) {
  if ((await findStreamEntries(path.dirname(plannedLocation), youtubeId)).length === 0) {
    const result = await publishFiles({ keepStreamEntries: false });
    await promoteAfterPublish(facade, youtubeId, result.mediaPath, null);
    return result;
  }
  let streamed = null;
  try {
    streamed = await facade.hasNonLocalRepresentation(youtubeId);
  } catch (err) {
    logger.warn({ err, youtubeId }, 'Could not read the episode representations; publishing the download without them');
  }
  let lease = null;
  try {
    lease = await store.acquireLease(youtubeId, LEASE_OPERATIONS.DOWNLOAD_PROMOTION, { waitMs: streamed ? PROMOTION_LEASE_WAIT_MS : 0 });
  } catch (err) {
    logger.warn({ err, youtubeId }, 'Could not take the episode publication lease; publishing the download without it');
  }
  try {
    let keepStreamEntries = streamed !== false;
    if (streamed) {
      try {
        const { candidates } = await facade._resolve(youtubeId);
        await facade._snapshotForLocal(youtubeId, candidates, plannedLocation);
        keepStreamEntries = false;
      } catch (err) {
        logger.error({ err, youtubeId }, 'Could not record the watch state of the STRM entry; keeping it until a later event');
      }
    }
    if (lease) {
      try {
        await store.renewLease(lease);
      } catch (err) {
        logger.warn({ err, youtubeId }, 'Lost the episode publication lease; publishing the download without it');
        lease = null;
      }
    }
    const result = await publishFiles({ keepStreamEntries });
    await promoteAfterPublish(facade, youtubeId, result.mediaPath, lease);
    return result;
  } finally {
    if (lease) await store.releaseLease(lease).catch(err => logger.warn({ err, youtubeId }, 'Could not release the episode publication lease'));
  }
}

module.exports = { publish, PROMOTION_LEASE_WAIT_MS };
