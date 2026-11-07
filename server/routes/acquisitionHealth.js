const express = require('express');

const YOUTUBE_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const STAGES = ['acquisition', 'captions', 'publication', 'library'];
const STATUSES = ['ok', 'warning', 'failed', 'pending', 'skipped'];
const CATEGORY_PATTERN = /^[a-z-]{1,32}$/;

/**
 * Acquisition-health routes (issue #18): the compact overview, unresolved
 * outcomes, one video's explanation, and per-step retry.
 * @param {Object} deps
 * @param {Function} deps.verifyToken
 * @param {Object} deps.health - modules/health facade
 * @param {Object} deps.downloadModule - queues acquisition retries
 * @param {Function} deps.healthRetryRateLimiter
 * @returns {express.Router}
 */
function createAcquisitionHealthRoutes({ verifyToken, health, downloadModule, healthRetryRateLimiter }) {
  const router = express.Router();

  const handle = (operation, work) => async (req, res) => {
    try {
      return res.json(await work(req));
    } catch (err) {
      if (err instanceof health.HealthError) {
        return res.status(err.status).json({ error: err.message, code: err.code });
      }
      req.log.error({ err, operation, params: req.params }, 'Acquisition health request failed');
      return res.status(500).json({ error: 'Failed to read acquisition health' });
    }
  };

  const requireYoutubeId = (req, res, next) => (
    YOUTUBE_ID_PATTERN.test(req.params.youtubeId) ? next() : res.status(400).json({ error: 'Invalid YouTube ID' })
  );

  /**
   * @swagger
   * /api/acquisition-health/summary:
   *   get:
   *     summary: Acquisition health overview
   *     description: >
   *       Storage pause state with per-reason resume hints (total size, free
   *       disk space, temporary download folder), unresolved outcomes by stage
   *       and category, recent unresolved outcomes, stale channel checks,
   *       download leases, and the app and yt-dlp versions outcomes are stamped
   *       with. Live detection is reported as not tracked yet.
   *     tags: [Acquisition Health]
   *     responses:
   *       200:
   *         description: Health overview
   */
  router.get('/api/acquisition-health/summary', verifyToken, handle('summary', () => health.getSummary()));

  /**
   * @swagger
   * /api/acquisition-health/outcomes:
   *   get:
   *     summary: List recorded stage outcomes, newest first
   *     description: Defaults to unresolved outcomes (failed, warning, pending).
   *     tags: [Acquisition Health]
   *     parameters:
   *       - in: query
   *         name: stage
   *         schema: { type: string, enum: [acquisition, captions, publication, library] }
   *       - in: query
   *         name: status
   *         description: Comma-separated statuses (ok, warning, failed, pending, skipped)
   *         schema: { type: string }
   *       - in: query
   *         name: category
   *         schema: { type: string }
   *       - in: query
   *         name: limit
   *         schema: { type: integer, minimum: 1, maximum: 200, default: 50 }
   *       - in: query
   *         name: offset
   *         schema: { type: integer, minimum: 0, default: 0 }
   *     responses:
   *       200:
   *         description: "{ outcomes, total }"
   *       400:
   *         description: Invalid filter
   */
  router.get('/api/acquisition-health/outcomes', verifyToken, (req, res, next) => {
    const { stage, status, category } = req.query;
    if (stage !== undefined && !STAGES.includes(stage)) return res.status(400).json({ error: 'Invalid stage' });
    const statuses = status === undefined ? undefined : String(status).split(',').filter(Boolean);
    if (statuses && (!statuses.length || statuses.some((s) => !STATUSES.includes(s)))) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    if (category !== undefined && !CATEGORY_PATTERN.test(String(category))) return res.status(400).json({ error: 'Invalid category' });
    req.healthFilters = { stage, statuses, category, limit: req.query.limit, offset: req.query.offset };
    return next();
  }, handle('outcomes', (req) => health.listOutcomes(req.healthFilters)));

  /**
   * @swagger
   * /api/acquisition-health/videos/{youtubeId}:
   *   get:
   *     summary: Explain one video's acquisition state
   *     description: >
   *       Every recorded stage outcome plus a plain-language explanation of why
   *       the video is missing, pending, excluded by policy, or what is left to
   *       finish (captions, publication, library listing).
   *     tags: [Acquisition Health]
   *     parameters:
   *       - in: path
   *         name: youtubeId
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       200:
   *         description: "{ youtubeId, title, explanation, outcomes }"
   *       400:
   *         description: Invalid YouTube ID
   */
  router.get('/api/acquisition-health/videos/:youtubeId', verifyToken, requireYoutubeId,
    handle('explain', (req) => health.explainVideo(req.params.youtubeId)));

  /**
   * @swagger
   * /api/acquisition-health/videos/{youtubeId}/retry:
   *   post:
   *     summary: Retry one step of a video
   *     description: >
   *       Retries the acquisition (queues a download of just this video) or the
   *       library step (re-checks Jellyfin and refreshes only that show).
   *       `revision` is the outcome revision the caller saw and acts as the
   *       idempotency key: a repeated, stale or concurrent request gets 409 and
   *       nothing runs twice. Captions and publication are not retried here.
   *     tags: [Acquisition Health]
   *     parameters:
   *       - in: path
   *         name: youtubeId
   *         required: true
   *         schema: { type: string }
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [stage, revision]
   *             properties:
   *               stage: { type: string, enum: [acquisition, library] }
   *               revision: { type: integer, minimum: 1 }
   *     responses:
   *       200:
   *         description: "{ outcome, queued: true }"
   *       400:
   *         description: Invalid id, stage or revision
   *       409:
   *         description: Stale or duplicate retry, already downloaded, already in progress, or downloads paused (with how to resume)
   *       422:
   *         description: The step cannot be retried on its own
   *       429:
   *         description: Too many retry requests
   */
  router.post('/api/acquisition-health/videos/:youtubeId/retry', verifyToken, healthRetryRateLimiter, requireYoutubeId,
    handle('retry', (req) => {
      const body = req.body || {};
      return health.retryStep(
        { youtubeId: req.params.youtubeId, stage: body.stage, revision: body.revision },
        { downloadModule }
      );
    }));

  return router;
}

module.exports = createAcquisitionHealthRoutes;
