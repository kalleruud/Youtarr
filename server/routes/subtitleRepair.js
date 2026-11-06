const express = require('express');
const rateLimit = require('express-rate-limit');
const PREVIEW_WINDOW_MS = 60000;
const PREVIEWS_PER_WINDOW = 10;

function createSubtitleRepairRoutes({ verifyToken, subtitleRepair, logger, ready }) {
  const router = express.Router();
  const previewLimiter = rateLimit({ windowMs: PREVIEW_WINDOW_MS, max: PREVIEWS_PER_WINDOW, message: { error: 'Too many repair previews; try again shortly' } });
  router.use('/api/subtitle-repairs', verifyToken);
  const handle = action => async (req, res) => {
    try { await ready; await action(req, res); }
    catch (err) {
      logger.error({ err }, 'Subtitle repair request failed');
      res.status(err.status || 500).json({ error: err.status ? err.message : 'Subtitle repair failed; see server log' });
    }
  };
  /**
   * @swagger
   * /api/subtitle-repairs:
   *   get:
   *     summary: List durable subtitle repair previews and jobs
   *     responses:
   *       200:
   *         description: Repair records including per-track outcomes
   * /api/subtitle-repairs/preview:
   *   post:
   *     summary: Preview 1–100 video ids without changing captions
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [videoIds, automaticFinal]
   *             properties:
   *               videoIds:
   *                 type: array
   *                 maxItems: 100
   *                 items: { type: integer }
   *               automaticFinal: { type: boolean }
   *     responses:
   *       200:
   *         description: Hash-bound preview with examples, counts and warnings
   * /api/subtitle-repairs/{id}/{action}:
   *   post:
   *     summary: Start a preview, cancel unfinished work or restore original bytes
   *     parameters:
   *       - { in: path, name: id, required: true, schema: { type: string } }
   *       - { in: path, name: action, required: true, schema: { type: string, enum: [start, cancel, restore] } }
   *     responses:
   *       200:
   *         description: Durable job record
   *       409:
   *         description: Job conflict
   */
  router.get('/api/subtitle-repairs', handle(async (_req, res) => res.json(await subtitleRepair.list())));
  router.post('/api/subtitle-repairs/preview', previewLimiter, handle(async (req, res) => res.json(await subtitleRepair.previewRepair(req.body?.videoIds, { automaticFinal: req.body?.automaticFinal }))));
  for (const [action, method] of Object.entries({ start: 'startRepair', cancel: 'cancel', restore: 'restoreRepair' })) {
    router.post(`/api/subtitle-repairs/:id/${action}`, handle(async (req, res) => res.json(await subtitleRepair[method](req.params.id))));
  }
  return router;
}
module.exports = createSubtitleRepairRoutes;
