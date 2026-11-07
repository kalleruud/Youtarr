const express = require('express');

const YOUTUBE_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Acquisition-policy routes (issue #10): global defaults, per-channel
 * policies and per-video overrides for stream/download and livestream
 * handling, each returned with its effective decisions and explanations.
 * @param {Object} deps
 * @param {Function} deps.verifyToken
 * @param {Object} deps.acquisitionPolicyService
 * @returns {express.Router}
 */
function createAcquisitionPolicyRoutes({ verifyToken, acquisitionPolicyService }) {
  const router = express.Router();

  const handle = (operation, work) => async (req, res) => {
    try {
      return res.json(await work(req));
    } catch (err) {
      if (err instanceof acquisitionPolicyService.AcquisitionPolicyError) {
        const body = { error: err.message, code: err.code };
        if (err.currentRevision !== undefined) body.currentRevision = err.currentRevision;
        return res.status(err.status).json(body);
      }
      req.log.error({ err, operation, params: req.params }, 'Acquisition policy request failed');
      return res.status(500).json({ error: 'Failed to process acquisition policy' });
    }
  };

  const requireChannelId = (req, res, next) => (
    CHANNEL_ID_PATTERN.test(req.params.channelId) ? next() : res.status(400).json({ error: 'Invalid channel ID' })
  );
  const requireYoutubeId = (req, res, next) => (
    YOUTUBE_ID_PATTERN.test(req.params.youtubeId) ? next() : res.status(400).json({ error: 'Invalid YouTube ID' })
  );

  /**
   * @swagger
   * components:
   *   schemas:
   *     AcquisitionPolicyUpdate:
   *       type: object
   *       description: Omit a field to keep it; null clears it back to inherit.
   *       properties:
   *         delivery:
   *           type: string
   *           nullable: true
   *           enum: [download, stream]
   *           description: Normal videos and Shorts - download automatically or stream on demand.
   *         live:
   *           type: string
   *           nullable: true
   *           enum: [ignore, replay, play, record, play_and_record]
   *           description: Livestreams - ignore, wait for replay, allow live playback, record while live, or both.
   *         expectedRevision:
   *           type: integer
   *           minimum: 0
   *           description: When set, the update is refused with 409 unless this is the current revision.
   * /api/acquisition-policy:
   *   get:
   *     summary: Get the global acquisition policy defaults
   *     description: Returns explicit global selections, built-in defaults, capabilities and the effective decision per content kind and source state.
   *     tags: [Acquisition Policy]
   *     responses:
   *       200:
   *         description: Global policy and decisions
   *   put:
   *     summary: Update the global acquisition policy defaults
   *     description: Affects future automatic decisions only; never deletes, replaces or backfills anything.
   *     tags: [Acquisition Policy]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/AcquisitionPolicyUpdate'
   *     responses:
   *       200:
   *         description: Updated global policy and decisions
   *       400:
   *         description: Invalid policy value or body
   *       409:
   *         description: expectedRevision is stale (code revision-conflict)
   */
  router.get('/api/acquisition-policy', verifyToken,
    handle('getGlobal', () => acquisitionPolicyService.getGlobal()));
  router.put('/api/acquisition-policy', verifyToken,
    handle('updateGlobal', req => acquisitionPolicyService.updateGlobal(req.body)));

  /**
   * @swagger
   * /api/channels/{channelId}/acquisition-policy:
   *   get:
   *     summary: Get a channel's acquisition policy
   *     description: Explicit channel selections and the effective decision (planned actions and reasons) per content kind and source state.
   *     tags: [Acquisition Policy]
   *     parameters:
   *       - in: path
   *         name: channelId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Channel policy and decisions
   *       400:
   *         description: Invalid channel ID
   *       404:
   *         description: Channel not found
   *   put:
   *     summary: Update a channel's acquisition policy
   *     description: Affects future automatic sweeps only. Switching to stream keeps existing downloads and protected videos.
   *     tags: [Acquisition Policy]
   *     parameters:
   *       - in: path
   *         name: channelId
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/AcquisitionPolicyUpdate'
   *     responses:
   *       200:
   *         description: Updated channel policy and decisions
   *       400:
   *         description: Invalid policy value, body or channel ID
   *       404:
   *         description: Channel not found
   *       409:
   *         description: expectedRevision is stale (code revision-conflict)
   */
  router.get('/api/channels/:channelId/acquisition-policy', verifyToken, requireChannelId,
    handle('getChannel', req => acquisitionPolicyService.getChannel(req.params.channelId)));
  router.put('/api/channels/:channelId/acquisition-policy', verifyToken, requireChannelId,
    handle('updateChannel', req => acquisitionPolicyService.updateChannel(req.params.channelId, req.body)));

  /**
   * @swagger
   * /api/videos/{youtubeId}/acquisition-policy:
   *   get:
   *     summary: Get a video's acquisition policy override and decisions
   *     description: The explicit override (if any), the automatic decision under video > channel > global precedence, and the manual-download decision, which ignores policy.
   *     tags: [Acquisition Policy]
   *     parameters:
   *       - in: path
   *         name: youtubeId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Video override and decisions
   *       400:
   *         description: Invalid YouTube ID
   *       404:
   *         description: Video is not in any tracked channel listing or download
   *   put:
   *     summary: Set a video's acquisition policy override
   *     tags: [Acquisition Policy]
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
   *             $ref: '#/components/schemas/AcquisitionPolicyUpdate'
   *     responses:
   *       200:
   *         description: Updated override and decisions
   *       400:
   *         description: Invalid policy value, body or YouTube ID
   *       404:
   *         description: Video is not in any tracked channel listing or download
   *       409:
   *         description: Stale expectedRevision (revision-conflict) or too many video overrides (override-limit)
   *   delete:
   *     summary: Clear a video's acquisition policy override
   *     description: The video inherits its channel and global policy again.
   *     tags: [Acquisition Policy]
   *     parameters:
   *       - in: path
   *         name: youtubeId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Cleared override and decisions
   *       400:
   *         description: Invalid YouTube ID
   *       404:
   *         description: Video is not in any tracked channel listing or download
   */
  router.get('/api/videos/:youtubeId/acquisition-policy', verifyToken, requireYoutubeId,
    handle('getVideo', req => acquisitionPolicyService.getVideo(req.params.youtubeId)));
  router.put('/api/videos/:youtubeId/acquisition-policy', verifyToken, requireYoutubeId,
    handle('updateVideo', req => acquisitionPolicyService.updateVideo(req.params.youtubeId, req.body)));
  router.delete('/api/videos/:youtubeId/acquisition-policy', verifyToken, requireYoutubeId,
    handle('clearVideo', req => acquisitionPolicyService.clearVideo(req.params.youtubeId)));

  return router;
}

module.exports = createAcquisitionPolicyRoutes;
