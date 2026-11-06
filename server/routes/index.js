const path = require('path');
const createSubtitleRepairRoutes = require('./subtitleRepair');
const subtitleRepair = require('../modules/subtitleRepair');
const messageEmitter = require('../modules/messageEmitter');
const createHealthRoutes = require('./health');
const createAuthRoutes = require('./auth');
const createSetupRoutes = require('./setup');
const createConfigRoutes = require('./config');
const createChannelRoutes = require('./channels');
const createChannelArtworkRoutes = require('./channelArtwork');
const channelArtworkModule = require('../modules/channelArtworkModule');
const createVideoRoutes = require('./videos');
const createJobRoutes = require('./jobs');
const createPlexRoutes = require('./plex');
const createApiKeyRoutes = require('./apikeys');
const createSubscriptionRoutes = require('./subscriptions');
const createVideoDetailRoutes = require('./videoDetail');
const episodeAssignment = require('../modules/episodeAssignment');
const createAcquisitionPolicyRoutes = require('./acquisitionPolicy');
const acquisitionPolicyService = require('../modules/acquisition/acquisitionPolicyService');
const tvPublication = require('../modules/tvPublication');
const createVideoSearchRoutes = require('./videoSearch');
const createChannelSearchRoutes = require('./channelSearch');
const createPlaylistRoutes = require('./playlists');
const createMediaServerRoutes = require('./mediaServers');
const createYoutubeApiKeyRoutes = require('./youtubeApiKey');
const createYtdlpOptionsRoutes = require('./ytdlpOptions');
const createMaintenanceRoutes = require('./maintenance');
const createSubfolderRoutes = require('./subfolders');
const createSchedulesRoutes = require('./schedules');
const createLogRoutes = require('./logs');
const createVideoTrashRoutes = require('./videoTrash');
const videoMetadataModule = require('../modules/videoMetadataModule');
const videoTrashModule = require('../modules/videoTrashModule');
const videoOembedEnricher = require('../modules/videoOembedEnricher');
const playlistModule = require('../modules/playlistModule');
const m3uGenerator = require('../modules/m3uGenerator');
const mediaServers = require('../modules/mediaServers');
const channelSettingsModule = require('../modules/channelSettingsModule');
const channelDownloadAllModule = require('../modules/channelDownloadAllModule');
const ratingMapper = require('../modules/ratingMapper');
const subfolderModule = require('../modules/subfolderModule');
const playlistVideoFilters = require('../modules/playlistVideoFilters');
const playlistDownloadModule = require('../modules/playlistDownloadModule');
const models = require('../models');
const videoLocalStatus = require('../modules/videoLocalStatus');
const youtubeUrlParser = require('../modules/youtubeUrlParser');
const videoActivity = require('../modules/download/videoActivity');
const scheduledTaskManager = require('../modules/scheduledTaskManager');
const scheduledTaskRuns = require('../modules/scheduledTaskRuns');
const scheduleConfig = require('../modules/scheduleConfig');
const rescanRunSummary = require('../modules/rescanRunSummary');
const ytdlpUpdateRunSummary = require('../modules/ytdlpUpdateRunSummary');
const storageGuard = require('../modules/storageGuard');
const cookieDetails = require('../modules/cookieDetails');
const cookieTest = require('../modules/cookieTest');
const logger = require('../logger');
const logFilesModule = require('../modules/logFilesModule');

/**
 * Registers all route modules with the Express app
 * @param {Object} app - Express application
 * @param {Object} deps - Dependencies to inject into route modules
 */
function registerRoutes(app, deps) {
  const {
    verifyToken,
    loginLimiter,
    setupCreateAuthLimiter,
    youtubeApiKeyTestLimiter,
    ytdlpValidationRateLimiter,
    filenamePreviewRateLimiter,
    cookieTestRateLimiter,
    artworkUploadRateLimiter,
    configModule,
    channelModule,
    plexModule,
    downloadModule,
    jobModule,
    videosModule,
    archiveModule,
    subscriptionImportModule,
    videoSearchModule,
    channelSearchModule,
    youtubeApi,
    getCachedYtDlpVersion,
    validateEnvAuthCredentials,
    setupTokenModule,
    getClientAddress,
    isWslEnvironment,
  } = deps;

  // Health routes (no auth required for health checks, but yt-dlp endpoints are authenticated)
  app.use(createHealthRoutes({
    getCachedYtDlpVersion, verifyToken, configModule, scheduledTaskRuns, ytdlpUpdateRunSummary, scheduledTaskManager,
  }));

  // Auth routes
  app.use(createAuthRoutes({ verifyToken, loginLimiter, configModule, getClientAddress }));

  // Setup routes
  app.use(createSetupRoutes({ configModule, setupTokenModule, setupCreateAuthLimiter, getClientAddress }));

  // Config routes
  app.use(createConfigRoutes({
    verifyToken, configModule, validateEnvAuthCredentials, isWslEnvironment, filenamePreviewRateLimiter,
    cookieDetails, cookieTest, cookieTestRateLimiter, getLoggingStatus: logger.getLoggingStatus,
  }));

  // Channel routes
  app.use(createChannelRoutes({ verifyToken, channelModule, archiveModule, channelDownloadAllModule, ratingMapper, storageGuard }));

  // Channel show poster routes (upload/select/pin/reset/regenerate, Jellyfin artwork refresh)
  app.use(createChannelArtworkRoutes({ verifyToken, channelArtworkModule, artworkUploadRateLimiter }));

  // Video routes
  app.use(createVideoRoutes({
    verifyToken, videosModule, downloadModule, videoOembedEnricher, videoLocalStatus, storageGuard, scheduledTaskManager, ratingMapper,
    youtubeUrlParser,
  }));

  // Trash routes: deleted and missing videos (counts, mark as deleted, purge)
  app.use(createVideoTrashRoutes({ verifyToken, videoTrashModule, jobModule }));

  // Video search routes
  app.use(createVideoSearchRoutes({ verifyToken, videoSearchModule }));

  // Channel search routes
  app.use(createChannelSearchRoutes({ verifyToken, channelSearchModule }));

  // YouTube API key test route
  app.use(createYoutubeApiKeyRoutes({ verifyToken, youtubeApiKeyTestLimiter, youtubeApi, configModule }));

  // yt-dlp options validation route
  app.use(createYtdlpOptionsRoutes({ verifyToken, ytdlpValidationRateLimiter }));

  // Job routes
  app.use(createJobRoutes({ verifyToken, jobModule, downloadModule, videoActivity, storageGuard }));

  // Plex routes
  app.use(createPlexRoutes({ verifyToken, plexModule, configModule }));

  // API Key routes
  app.use(createApiKeyRoutes({ verifyToken }));

  // Subscription import routes
  app.use(createSubscriptionRoutes({ verifyToken, subscriptionImportModule }));

  // Video detail routes (metadata and streaming)
  app.use(createVideoDetailRoutes({ verifyToken, videoMetadataModule, mediaServers, episodeAssignment, tvPublication }));

  // Acquisition policy routes (stream/download and livestream policies)
  app.use(createAcquisitionPolicyRoutes({ verifyToken, acquisitionPolicyService }));

  // Playlist routes
  app.use(createPlaylistRoutes({ verifyToken, playlistModule, downloadModule, m3uGenerator, mediaServers, models, channelSettingsModule, ratingMapper, subfolderModule, playlistVideoFilters, playlistDownloadModule, storageGuard }));

  // Media server routes
  app.use(createMediaServerRoutes({ verifyToken, configModule, mediaServers, scheduledTaskManager }));

  subtitleRepair.configure({
    mediaRoot: () => configModule.directoryPath,
    leaseRoot: () => configModule.getJobsPath(),
    stateRoot: () => path.join(configModule.getJobsPath(), 'subtitle-repairs'),
    resolveVideo: id => models.Video.findByPk(id),
    notify: () => { if (global.wss) messageEmitter.emitMessage('broadcast', null, 'subtitleRepair', 'subtitleRepairUpdated', {}); },
    onError: err => logger.error({ err }, 'Subtitle repair worker failed'),
    refresh: async filepath => {
      const adapters = mediaServers.serverRegistry.getEnabledAdapters(configModule.getConfig()).filter(adapter => adapter.serverType === 'jellyfin');
      const results = [];
      for (const adapter of adapters) results.push(await adapter.refreshCaptionItem(filepath));
      return { status: results.length ? (results.every(result => result.status === 'refreshed') ? 'refreshed' : 'pending') : 'not-configured' };
    },
  });
  const repairReady = subtitleRepair.recover();
  repairReady.catch(err => logger.error({ err }, 'Subtitle repair recovery failed'));
  app.use(createSubtitleRepairRoutes({ verifyToken, subtitleRepair, logger, ready: repairReady }));

  // Maintenance routes
  app.use(createMaintenanceRoutes({
    verifyToken, videosModule, configModule, scheduledTaskRuns, rescanRunSummary, scheduledTaskManager,
  }));

  // Subfolder registry routes
  app.use(createSubfolderRoutes({ verifyToken, subfolderModule }));

  // Scheduled task status routes
  app.use(createSchedulesRoutes({ verifyToken, scheduledTaskManager, scheduledTaskRuns, scheduleConfig }));

  // Log file download
  app.use(createLogRoutes({ verifyToken, logFilesModule, configModule }));

  // Defensive redirect: /channels -> /subscriptions (frontend handles client-side routing,
  // this fallback covers direct server-side hits during the transition period)
  app.get('/channels', (req, res) => res.redirect(301, '/subscriptions'));
}

module.exports = { registerRoutes };
