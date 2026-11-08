const express = require('express');
const rateLimit = require('express-rate-limit');
const logger = require('../logger');

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const TRACK_CODE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8}){0,3}$/;
const MAX_LANGUAGE_SETTING_LENGTH = 200;
const PREVIEW_FIELDS = ['subtitleLanguage', 'captionSourcePolicy', 'captionAllowTranslated', 'captionPreferredVariants'];

// "Check again" schedules a YouTube request; the worker spaces requests, and
// this keeps a client from rewriting the queue in a loop.
const captionCheckLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Too many caption check requests, please try again shortly' },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
});

/**
 * Caption provenance, protection, delayed checks and preference preview
 * (issue #5).
 * @param {{verifyToken: Function, captionCatalog: object}} deps
 */
function createCaptionRoutes({ verifyToken, captionCatalog }) {
  const router = express.Router();

  /**
   * @swagger
   * /api/videos/{youtubeId}/captions:
   *   get:
   *     summary: Caption tracks of a downloaded video and why configured languages are missing
   *     description: |
   *       Lists the SRT sidecars next to the video file with their source
   *       (uploaded, automatic, translated, generated, unknown), origin
   *       (download, enrichment, unrecorded), protection and normalizer
   *       version; each configured language without a track with its reason
   *       (not-offered, automatic-not-allowed, translation-only,
   *       not-downloaded) and state (pending, exhausted, blocked,
   *       unavailable); and the delayed caption check, if any.
   *     tags: [Videos]
   *     parameters:
   *       - in: path
   *         name: youtubeId
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       200: { description: Caption summary }
   *       400: { description: Invalid YouTube ID }
   *       404: { description: Video not found }
   */
  router.get('/api/videos/:youtubeId/captions', verifyToken, async (req, res) => {
    const { youtubeId } = req.params;
    if (!YOUTUBE_ID.test(youtubeId)) return res.status(400).json({ error: 'Invalid YouTube ID' });
    try {
      const summary = await captionCatalog.getVideoCaptions(youtubeId);
      if (!summary) return res.status(404).json({ error: 'Video not found' });
      return res.json(summary);
    } catch (err) {
      logger.error({ err, youtubeId }, 'Failed to read captions');
      return res.status(500).json({ error: 'Failed to read captions' });
    }
  });

  /**
   * @swagger
   * /api/videos/{youtubeId}/captions/{code}/protection:
   *   put:
   *     summary: Protect a caption track from automatic replacement
   *     description: A protected track is never replaced or removed by a delayed caption check.
   *     tags: [Videos]
   *     parameters:
   *       - in: path
   *         name: youtubeId
   *         required: true
   *         schema: { type: string }
   *       - in: path
   *         name: code
   *         required: true
   *         schema: { type: string }
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [protected]
   *             properties:
   *               protected: { type: boolean }
   *     responses:
   *       200: { description: Saved }
   *       400: { description: Invalid input }
   *       404: { description: Video or caption track not found }
   */
  router.put('/api/videos/:youtubeId/captions/:code/protection', verifyToken, async (req, res) => {
    const { youtubeId, code } = req.params;
    if (!YOUTUBE_ID.test(youtubeId) || !TRACK_CODE.test(code)) return res.status(400).json({ error: 'Invalid video or caption code' });
    if (typeof req.body?.protected !== 'boolean') return res.status(400).json({ error: 'protected must be true or false' });
    try {
      const result = await captionCatalog.setProtection(youtubeId, code, req.body.protected);
      if (result.status === 'not-found') return res.status(404).json({ error: 'Caption track not found' });
      return res.json({ protected: req.body.protected });
    } catch (err) {
      logger.error({ err, youtubeId, code }, 'Failed to change caption protection');
      return res.status(500).json({ error: 'Failed to change caption protection' });
    }
  });

  /**
   * @swagger
   * /api/videos/{youtubeId}/captions/check:
   *   post:
   *     summary: Check YouTube again for missing captions of a video
   *     description: |
   *       Schedules one more delayed caption check against the current video
   *       file, due now. The worker still spaces YouTube requests and skips
   *       while downloads run. Media is never downloaded.
   *     tags: [Videos]
   *     parameters:
   *       - in: path
   *         name: youtubeId
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       202: { description: Scheduled }
   *       400: { description: Invalid YouTube ID }
   *       404: { description: Video not found or has no video file }
   *       409: { description: "Caption checks are turned off (disabled), a check is running (running), or nothing is missing (nothing-missing)" }
   *       429: { description: Too many requests }
   */
  router.post('/api/videos/:youtubeId/captions/check', verifyToken, captionCheckLimiter, async (req, res) => {
    const { youtubeId } = req.params;
    if (!YOUTUBE_ID.test(youtubeId)) return res.status(400).json({ error: 'Invalid YouTube ID' });
    try {
      const result = await captionCatalog.requestRetry(youtubeId);
      if (result.status === 'not-found') return res.status(404).json({ error: 'Video not found or has no video file' });
      if (result.status === 'disabled') return res.status(409).json({ error: 'Delayed caption checks are turned off in Settings', reason: 'disabled' });
      if (result.status === 'running') return res.status(409).json({ error: 'A caption check is running for this video', reason: 'running' });
      if (result.status === 'nothing-missing') return res.status(409).json({ error: 'No configured caption language is missing', reason: 'nothing-missing' });
      return res.status(202).json({ enrichment: result.enrichment });
    } catch (err) {
      logger.error({ err, youtubeId }, 'Failed to schedule caption check');
      return res.status(500).json({ error: 'Failed to schedule caption check' });
    }
  });

  /**
   * @swagger
   * /api/captions/preview:
   *   post:
   *     summary: Preview caption preference changes on recent downloads
   *     description: |
   *       Compares the tracks the saved and the proposed caption preferences
   *       would publish for up to 200 recent downloads, from their cached
   *       metadata. Nothing is changed or fetched.
   *     tags: [Configuration]
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               subtitleLanguage: { type: string }
   *               captionSourcePolicy: { type: string, enum: [uploaded-then-automatic, uploaded-only] }
   *               captionAllowTranslated: { type: boolean }
   *               captionPreferredVariants: { type: string }
   *     responses:
   *       200: { description: "{ totals, examples, limit }" }
   *       400: { description: Invalid input }
   */
  router.post('/api/captions/preview', verifyToken, async (req, res) => {
    const body = req.body || {};
    const proposed = {};
    for (const key of PREVIEW_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
      const value = body[key];
      const valid = key === 'captionAllowTranslated'
        ? typeof value === 'boolean'
        : typeof value === 'string' && value.length <= MAX_LANGUAGE_SETTING_LENGTH;
      if (!valid) return res.status(400).json({ error: `Invalid ${key}` });
      proposed[key] = value;
    }
    try {
      return res.json(await captionCatalog.previewPreferences(proposed));
    } catch (err) {
      logger.error({ err }, 'Failed to preview caption preferences');
      return res.status(500).json({ error: 'Failed to preview caption preferences' });
    }
  });

  return router;
}

module.exports = createCaptionRoutes;
