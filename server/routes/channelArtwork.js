const express = require('express');
const multer = require('multer');
const logger = require('../logger');
const { UPLOAD_MAX_BYTES } = require('../modules/artwork/constants');

const CHANNEL_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Show poster routes for one channel.
 * @param {Object} deps
 * @param {Function} deps.verifyToken - Token verification middleware
 * @param {Object} deps.channelArtworkModule - Artwork orchestration module
 * @param {Function} deps.artworkUploadRateLimiter - Rate limiter for uploads and regeneration
 * @returns {express.Router}
 */
module.exports = function createChannelArtworkRoutes({ verifyToken, channelArtworkModule, artworkUploadRateLimiter }) {
  const router = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: UPLOAD_MAX_BYTES, files: 1 } });

  const validateChannelId = (req, res, next) => {
    if (!CHANNEL_ID_PATTERN.test(req.params.channelId)) {
      return res.status(400).json({ error: 'Invalid channel id' });
    }
    next();
  };

  const handle = (operation, action) => async (req, res) => {
    try {
      const result = await action(req);
      if (!result) return res.status(404).json({ error: 'Channel not found' });
      res.json(result);
    } catch (err) {
      if (err instanceof channelArtworkModule.ArtworkValidationError) {
        return res.status(400).json({ error: err.message });
      }
      logger.error({ err, channelId: req.params.channelId, operation }, 'Channel artwork request failed');
      res.status(500).json({ error: 'Channel artwork request failed' });
    }
  };

  const receiveUpload = (req, res, next) => {
    upload.single('poster')(req, res, (err) => {
      if (!err) return next();
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: `The poster must be smaller than ${Math.round(UPLOAD_MAX_BYTES / (1024 * 1024))} MB.` });
      }
      return res.status(400).json({ error: 'Upload one image in the "poster" field.' });
    });
  };

  /**
   * @swagger
   * /api/channels/{channelId}/artwork:
   *   get:
   *     summary: Get the channel's show poster status
   *     description: Selection (auto or manual), pin, origin (manual, upstream, generated), dimensions, revision, preview URL, folder publication note and the last Jellyfin artwork refresh outcome.
   *     tags: [Channels]
   *     parameters:
   *       - in: path
   *         name: channelId
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       200: { description: Artwork status }
   *       400: { description: Invalid channel id }
   *       404: { description: Channel not found }
   */
  router.get('/api/channels/:channelId/artwork', verifyToken, validateChannelId,
    handle('status', (req) => channelArtworkModule.getStatus(req.params.channelId)));

  /**
   * @swagger
   * /api/channels/{channelId}/artwork:
   *   put:
   *     summary: Select or pin the show poster
   *     tags: [Channels]
   *     parameters:
   *       - in: path
   *         name: channelId
   *         required: true
   *         schema: { type: string }
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               source: { type: string, enum: [auto, manual], description: manual requires an uploaded poster }
   *               protected: { type: boolean, description: Pinned posters are kept through channel refreshes and upstream avatar changes }
   *     responses:
   *       200: { description: Updated artwork status }
   *       400: { description: Invalid selection }
   *       404: { description: Channel not found }
   */
  router.put('/api/channels/:channelId/artwork', verifyToken, validateChannelId,
    handle('select', (req) => {
      const { source, protected: pinned } = req.body || {};
      return channelArtworkModule.updatePreference(req.params.channelId, { source, protected: pinned });
    }));

  /**
   * @swagger
   * /api/channels/{channelId}/artwork/poster:
   *   post:
   *     summary: Upload a show poster
   *     description: Multipart field "poster". JPEG, PNG or WebP identified by content, at most 10 MB and 8000 pixels per side, at least 200x300, portrait (width/height 0.5-0.8). The image is re-encoded, selected and pinned. A rejected upload leaves the current poster untouched.
   *     tags: [Channels]
   *     parameters:
   *       - in: path
   *         name: channelId
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       200: { description: Updated artwork status }
   *       400: { description: Invalid or oversized image }
   *       404: { description: Channel not found }
   *       429: { description: Too many artwork requests }
   */
  router.post('/api/channels/:channelId/artwork/poster', verifyToken, validateChannelId, artworkUploadRateLimiter, receiveUpload,
    handle('upload', (req) => {
      if (!req.file) {
        throw new channelArtworkModule.ArtworkValidationError('Upload one image in the "poster" field.');
      }
      return channelArtworkModule.uploadManualPoster(req.params.channelId, req.file.buffer);
    }));

  /**
   * @swagger
   * /api/channels/{channelId}/artwork/poster:
   *   delete:
   *     summary: Reset the show poster to automatic artwork
   *     description: Removes the uploaded poster and the pin, then resolves the automatic poster again.
   *     tags: [Channels]
   *     parameters:
   *       - in: path
   *         name: channelId
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       200: { description: Updated artwork status }
   *       404: { description: Channel not found }
   */
  router.delete('/api/channels/:channelId/artwork/poster', verifyToken, validateChannelId,
    handle('reset', (req) => channelArtworkModule.resetPoster(req.params.channelId)));

  /**
   * @swagger
   * /api/channels/{channelId}/artwork/regenerate:
   *   post:
   *     summary: Regenerate and republish the channel's artwork
   *     description: Recomposes the automatic poster (deterministic; unchanged inputs keep the same revision), republishes poster.jpg and writes missing episode -thumb.jpg files from the existing landscape thumbnails. Never downloads or rewrites video.
   *     tags: [Channels]
   *     parameters:
   *       - in: path
   *         name: channelId
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       200: { description: Updated artwork status with episode thumbnail counts }
   *       404: { description: Channel not found }
   *       429: { description: Too many artwork requests }
   */
  router.post('/api/channels/:channelId/artwork/regenerate', verifyToken, validateChannelId, artworkUploadRateLimiter,
    handle('regenerate', (req) => channelArtworkModule.regenerate(req.params.channelId)));

  /**
   * @swagger
   * /api/channels/{channelId}/artwork/refresh:
   *   post:
   *     summary: Retry the Jellyfin artwork refresh
   *     description: Asks Jellyfin to re-read this show's images only (no library scan) and stores the outcome.
   *     tags: [Channels]
   *     parameters:
   *       - in: path
   *         name: channelId
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       200: { description: Updated artwork status }
   *       404: { description: Channel not found }
   */
  router.post('/api/channels/:channelId/artwork/refresh', verifyToken, validateChannelId,
    handle('refresh', async (req) => {
      const channelId = req.params.channelId;
      if (!(await channelArtworkModule.findChannel(channelId))) return null;
      await channelArtworkModule.requestRefresh(channelId);
      return channelArtworkModule.getStatus(channelId);
    }));

  return router;
};
