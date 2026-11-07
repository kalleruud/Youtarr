// Shared vocabulary of episode representations (issue #14). Pure constants.

// The kinds of playable copy one logical episode (YouTube id) can have.
// 'local': a downloaded, verified media file. 'strm': a published STRM entry
// pointing at the playback route (#13). 'cache': a complete temporary copy
// kept by a streaming session (#12). 'recording': a live capture (#16), whose
// variant names its revision.
const KINDS = Object.freeze({ LOCAL: 'local', STRM: 'strm', CACHE: 'cache', RECORDING: 'recording' });

// 'verified': a complete file whose size Youtarr checked. 'partial': a
// recording with gaps. 'published': the visible STRM entry. 'retired': a STRM
// entry replaced by a local copy (the stream route itself stays valid).
// 'evicted': a local copy removed on purpose while the episode stays streamable.
const STATES = Object.freeze({
  VERIFIED: 'verified',
  PARTIAL: 'partial',
  PUBLISHED: 'published',
  RETIRED: 'retired',
  EVICTED: 'evicted',
});

// What playback should use. 'upstream' means "resolve from YouTube" (#12).
const MODES = Object.freeze({ LOCAL: 'local', UPSTREAM: 'upstream', UNAVAILABLE: 'unavailable' });

// Complete local kinds in order of preference.
const COMPLETE_LOCAL_KINDS = Object.freeze([KINDS.LOCAL, KINDS.RECORDING, KINDS.CACHE]);

const STREAM_ENTRY_EXTENSION = '.strm';

const LEASE_OPERATIONS = Object.freeze({
  DOWNLOAD_PROMOTION: 'download-promotion',
  STREAM_PUBLICATION: 'stream-publication',
  EVICTION: 'eviction',
  RECONCILE: 'reconcile',
  SELECTION: 'selection',
});

// A download's publication moves a whole media file and may cross
// filesystems; everything else only writes or removes a small file.
const LEASE_TTL_MS = Object.freeze({
  [LEASE_OPERATIONS.DOWNLOAD_PROMOTION]: 30 * 60 * 1000,
  [LEASE_OPERATIONS.STREAM_PUBLICATION]: 2 * 60 * 1000,
  [LEASE_OPERATIONS.EVICTION]: 5 * 60 * 1000,
  [LEASE_OPERATIONS.RECONCILE]: 2 * 60 * 1000,
  [LEASE_OPERATIONS.SELECTION]: 60 * 1000,
});

module.exports = {
  KINDS,
  STATES,
  MODES,
  COMPLETE_LOCAL_KINDS,
  STREAM_ENTRY_EXTENSION,
  LEASE_OPERATIONS,
  LEASE_TTL_MS,
};
