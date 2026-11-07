const express = require('express');
const rateLimit = require('express-rate-limit');

const YOUTUBE_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
// Every route takes a YouTube id and reads the filesystem and database; the
// limits leave room for a user clicking through a library.
const RATE_WINDOW_MS = 60 * 1000;
const READ_LIMIT = 120;
const CHANGE_LIMIT = 30;
const limiter = (max) => rateLimit({
  windowMs: RATE_WINDOW_MS,
  max,
  message: { error: 'Too many episode representation requests, please try again shortly' },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
});

/**
 * Episode representation routes (issue #14): which copy of a video plays
 * (local file, STRM/upstream, recording), explicit version selection, and
 * local-copy eviction as a previewed action separate from policy changes.
 * @param {Object} deps
 * @param {Function} deps.verifyToken
 * @param {Object} deps.representations - modules/representation facade
 * @returns {express.Router}
 */
function createRepresentationRoutes({ verifyToken, representations }) {
  const router = express.Router();
  const readLimiter = limiter(READ_LIMIT);
  const changeLimiter = limiter(CHANGE_LIMIT);

  const handle = (operation, work) => async (req, res) => {
    try {
      return res.json(await work(req));
    } catch (err) {
      if (err instanceof representations.RepresentationError) {
        const body = { error: err.message, code: err.code };
        if (err.reasons && err.reasons.length) body.reasons = err.reasons;
        return res.status(err.status).json(body);
      }
      if (err instanceof representations.RepresentationRevisionError) {
        return res.status(409).json({ error: err.message, code: 'revision-conflict', currentRevision: err.currentRevision });
      }
      if (err instanceof representations.RepresentationLeaseError) {
        return res.status(409).json({ error: err.message, code: 'busy' });
      }
      req.log.error({ err, operation, params: req.params }, 'Episode representation request failed');
      return res.status(500).json({ error: 'Failed to process the episode representation' });
    }
  };

  const requireYoutubeId = (req, res, next) => (
    YOUTUBE_ID_PATTERN.test(req.params.youtubeId) ? next() : res.status(400).json({ error: 'Invalid YouTube ID' })
  );

  const parseExpectedRevision = (body) => {
    const value = body && body.expectedRevision;
    if (value === undefined) return undefined;
    if (!Number.isInteger(value) || value < 0) {
      throw new representations.RepresentationError(400, 'invalid-revision', 'expectedRevision must be a non-negative integer.');
    }
    return value;
  };

  /**
   * @swagger
   * /api/videos/{youtubeId}/representation:
   *   get:
   *     summary: Get the playable copies of one episode
   *     description: The copy playback uses (local file, upstream/STRM or a recording) and why, every recorded copy, watch state being carried over to a media server's new item, and a preview of evicting the local copy.
   *     tags: [Episode Representations]
   *     parameters:
   *       - in: path
   *         name: youtubeId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Representation status
   *       400:
   *         description: Invalid YouTube ID
   *       429:
   *         description: Too many requests
   */
  router.get('/api/videos/:youtubeId/representation', verifyToken, readLimiter, requireYoutubeId,
    handle('getStatus', req => representations.getStatus(req.params.youtubeId)));

  /**
   * @swagger
   * /api/videos/{youtubeId}/representation/selection:
   *   put:
   *     summary: Select which copy of an episode plays
   *     description: An explicit selection (for example a partial recording) wins while it stays usable; null returns to automatic selection.
   *     tags: [Episode Representations]
   *     parameters:
   *       - in: path
   *         name: youtubeId
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [representationId]
   *             properties:
   *               representationId:
   *                 type: integer
   *                 nullable: true
   *               expectedRevision:
   *                 type: integer
   *                 minimum: 0
   *     responses:
   *       200:
   *         description: The playback decision after the change
   *       400:
   *         description: Invalid body or YouTube ID
   *       404:
   *         description: The representation does not belong to this video
   *       409:
   *         description: Stale expectedRevision (revision-conflict) or another change in progress (busy)
   *       429:
   *         description: Too many requests
   */
  router.put('/api/videos/:youtubeId/representation/selection', verifyToken, changeLimiter, requireYoutubeId,
    handle('selectVersion', req => {
      if (!req.body || !('representationId' in req.body)) {
        throw new representations.RepresentationError(400, 'invalid-body', 'representationId is required (null for automatic).');
      }
      return representations.selectVersion(req.params.youtubeId, req.body.representationId,
        { expectedRevision: parseExpectedRevision(req.body) });
    }));

  /**
   * @swagger
   * /api/videos/{youtubeId}/representation/evict:
   *   post:
   *     summary: Remove an episode's local copy and keep it streamable
   *     description: Publishes the STRM entry, then removes only the media file that was previewed; metadata, captions and artwork stay. The file is moved aside atomically and deleted only if it is still the previewed file, so a download that replaced it meanwhile is kept (local-copy-changed, or replacedByDownload when the new file landed right after). Refused for protected videos and channels, while the video is queued or downloading, when streaming or STRM publication is unavailable, or when YouTube no longer has the video. Send the revision from the GET preview.
   *     tags: [Episode Representations]
   *     parameters:
   *       - in: path
   *         name: youtubeId
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [expectedRevision]
   *             properties:
   *               expectedRevision:
   *                 type: integer
   *                 minimum: 0
   *     responses:
   *       200:
   *         description: What was removed and kept
   *       400:
   *         description: Invalid body or YouTube ID
   *       409:
   *         description: Refused (eviction-refused, with reasons such as download_active), the local copy changed meanwhile (local-copy-changed), stale preview (revision-conflict) or another change in progress (busy)
   *       429:
   *         description: Too many requests
   */
  router.post('/api/videos/:youtubeId/representation/evict', verifyToken, changeLimiter, requireYoutubeId,
    handle('evictLocalCopy', req => {
      const expectedRevision = parseExpectedRevision(req.body);
      if (expectedRevision === undefined) {
        throw new representations.RepresentationError(400, 'invalid-revision', 'expectedRevision from the preview is required.');
      }
      return representations.evictLocalCopy(req.params.youtubeId, { expectedRevision });
    }));

  return router;
}

module.exports = createRepresentationRoutes;
