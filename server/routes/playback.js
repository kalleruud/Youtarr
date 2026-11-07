const express = require('express');
const rateLimit = require('express-rate-limit');

function createPlaybackRoutes({ verifyToken, playbackSession }) {
  const router = express.Router();
  const limiter = rateLimit({ windowMs: 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false, skip: req => playbackSession.hasReadyPlayback?.(req.params.videoId) || false, message: { error: 'Too many playback requests; retry later' } });
  const errorResponse = (res, error) => {
    const status = error.status || 503;
    if (status === 503) res.set('Retry-After', '10');
    res.status(status).json({ error: error.status ? error.message : 'Playback unavailable; retry later' });
  };
  const sendAsset = (req, res, sessionId, asset) => {
    const lease = playbackSession.getSessionAsset(sessionId, asset);
    res.set('Cache-Control', 'private, no-store');
    res.set('Content-Location', `/api/playback/sessions/${sessionId}/media`);
    const abort = () => res.destroy();
    const release = () => {
      lease.signal?.removeEventListener('abort', abort);
      lease.release();
    };
    lease.signal?.addEventListener('abort', abort, { once: true });
    res.once('close', release);
    res.sendFile(lease.filePath, { acceptRanges: true, dotfiles: 'allow' }, error => {
      release();
      if (error && !res.headersSent && !res.destroyed) errorResponse(res, { status: error.status || 503, message: 'Playback asset unavailable' });
    });
  };

  /**
   * @swagger
   * /api/playback/{videoId}:
   *   get:
   *     summary: Prepare known YouTube media and serve a seekable file (authenticated)
   *     parameters:
   *       - in: path
   *         name: videoId
   *         required: true
   *         schema: { type: string, pattern: '^[A-Za-z0-9_-]{11}$' }
   *     responses:
   *       200: { description: Media file }
   *       206: { description: Byte range }
   *       401: { description: Authentication required }
   *       422: { description: Source unsupported, filtered or exceeds cache budget }
   *       503: { description: Retryable preparation or capacity failure }
   */
  router.get('/api/playback/:videoId', verifyToken, limiter, async (req, res) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    res.once('close', abort);
    try {
      const session = await playbackSession.openPlayback(req.params.videoId, { signal: controller.signal });
      res.removeListener('close', abort);
      if (res.destroyed) return;
      sendAsset(req, res, session.sessionId, session.asset);
    } catch (error) {
      if (!res.destroyed) errorResponse(res, error);
    } finally {
      res.removeListener('close', abort);
    }
  });

  /**
   * @swagger
   * /api/playback/sessions/{sessionId}/{asset}:
   *   get:
   *     summary: Read a prepared playback asset with HTTP byte ranges (authenticated)
   *     parameters:
   *       - { in: path, name: sessionId, required: true, schema: { type: string } }
   *       - { in: path, name: asset, required: true, schema: { type: string, enum: [media] } }
   *     responses:
   *       200: { description: Media file }
   *       206: { description: Byte range }
   *       404: { description: Session expired or invalid asset }
   *   delete:
   *     summary: Release viewer hint; shared cache expires server-side (authenticated)
   *     responses:
   *       204: { description: Viewer release hint accepted; shared cache retained }
   */
  router.get('/api/playback/sessions/:sessionId/:asset', verifyToken, (req, res) => {
    try { sendAsset(req, res, req.params.sessionId, req.params.asset); }
    catch (error) { errorResponse(res, error); }
  });
  router.delete('/api/playback/sessions/:sessionId/:asset', verifyToken, async (req, res) => {
    try {
      if (req.params.asset !== 'media') return res.status(400).json({ error: 'Invalid asset' });
      // Shared cache ownership is server-side. Each response releases its own reader.
      // DELETE is an idempotent release hint; it cannot revoke other viewers.
      res.sendStatus(204);
    } catch (error) { errorResponse(res, error); }
  });
  return router;
}
module.exports = createPlaybackRoutes;
