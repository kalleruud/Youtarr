/**
 * Caption provenance, language preferences and delayed caption checks
 * (issue #5). Facade wiring the catalog and the worker to their real
 * dependencies; the parts are constructed with injectable dependencies for
 * tests.
 */
const configModule = require('../configModule');
const videoActivity = require('../download/videoActivity');
const archiveAccess = require('../download/archiveAccess');
const store = require('./captionStore');
const { fetchCaptions, probeDuration } = require('./captionFetcher');
const { CaptionCatalog } = require('./captionCatalog');
const { CaptionEnrichment } = require('./captionEnrichment');
const { parseRetrySchedule } = require('./enrichmentSchedule');
const { SOURCE_POLICIES } = require('./captionTrackSelection');

const catalog = new CaptionCatalog({ store, configModule });
const enrichment = new CaptionEnrichment({
  store,
  catalog,
  configModule,
  fetcher: { fetchCaptions },
  probeDuration,
  // A running download may be writing this video's files, and checks should
  // not compete with downloads for YouTube's request budget.
  isBusy: (youtubeId) => videoActivity.isActive(youtubeId) || archiveAccess.isDownloading(),
});

module.exports = {
  catalog,
  enrichment,
  parseRetrySchedule,
  SOURCE_POLICIES,
};
