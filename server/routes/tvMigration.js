const express = require('express');
const logger = require('../logger');

const ERROR_STATUS = {
  'not-found': 404,
  'invalid-scope': 400,
  'confirmation-required': 400,
  'invalid-state': 409,
  running: 409,
  'maintenance-active': 409,
  blocked: 409,
  'nothing-to-do': 409,
  'profile-not-tv': 409,
  stale: 409,
  'downloads-active': 409,
  'library-unavailable': 409,
  'snapshot-failed': 409,
  'no-snapshot': 409,
};

/**
 * Routes for migrating existing downloads into the Jellyfin TV layout. See
 * modules/tvMigration. Every route requires authentication.
 * @param {Object} deps
 * @param {Function} deps.verifyToken
 * @param {Object} deps.tvMigration
 */
module.exports = function createTvMigrationRoutes({ verifyToken, tvMigration }) {
  const router = express.Router();

  const handle = (action) => async (req, res) => {
    try {
      res.json(await action(req));
    } catch (err) {
      const status = ERROR_STATUS[err.code];
      if (status) {
        return res.status(status).json({ error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) });
      }
      logger.error({ err, planId: req.params.planId }, 'TV library migration request failed');
      return res.status(500).json({ error: 'The library migration request failed' });
    }
  };

  /**
   * @swagger
   * /api/library-migration:
   *   get:
   *     summary: List TV library migration plans
   *     description: Plans newest first, the maintenance lease (held while a migration applies, rolls back, or is interrupted) and the plan currently running.
   *     tags: [Library Migration]
   *     responses:
   *       200:
   *         description: Plans and lease
   */
  router.get('/api/library-migration', verifyToken, handle(() => tvMigration.list()));

  /**
   * @swagger
   * /api/library-migration/plans:
   *   post:
   *     summary: Preview a migration of existing downloads into the Jellyfin TV layout
   *     description: >
   *       Writes an immutable plan (old and new path of every file, episode numbers, files with no place in the TV
   *       layout, conflicts, blockers, and which media server state can be preserved). Nothing on disk, in the
   *       library or on a media server changes; stable episode numbers are allocated as a download would.
   *     tags: [Library Migration]
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               channelIds:
   *                 type: array
   *                 items: { type: string }
   *                 description: Limit the plan to these channels; omit for the whole library
   *               verifyChecksums:
   *                 type: boolean
   *                 default: true
   *                 description: Hash every video file before and after its move (reads each file twice)
   *     responses:
   *       200: { description: The plan }
   *       400: { description: Invalid scope }
   *       409: { description: A migration holds the maintenance lease }
   */
  router.post('/api/library-migration/plans', verifyToken, handle((req) => {
    const body = req.body || {};
    if (body.verifyChecksums !== undefined && typeof body.verifyChecksums !== 'boolean') {
      const err = new Error('verifyChecksums must be a boolean');
      err.code = 'invalid-scope';
      throw err;
    }
    return tvMigration.createPlan({ channelIds: body.channelIds ?? null, verifyChecksums: body.verifyChecksums !== false });
  }));

  /**
   * @swagger
   * /api/library-migration/plans/{planId}:
   *   get:
   *     summary: Get a migration plan with its progress
   *     tags: [Library Migration]
   *     parameters:
   *       - { in: path, name: planId, required: true, schema: { type: string } }
   *     responses:
   *       200: { description: The plan, per-video checkpoints and status }
   *       404: { description: Not found }
   */
  router.get('/api/library-migration/plans/:planId', verifyToken, handle((req) => tvMigration.get(req.params.planId)));

  /**
   * @swagger
   * /api/library-migration/plans/{planId}/apply:
   *   post:
   *     summary: Apply a migration plan
   *     description: >
   *       Requires confirm true, a plan without blockers, the Jellyfin TV library output profile and no running
   *       download. Takes the maintenance lease (downloads, cleanup, rescans and file checks pause), refuses when
   *       any planned file changed since planning, snapshots Jellyfin watch state and user playlists, then moves
   *       files in the background. Poll the plan for progress.
   *     tags: [Library Migration]
   *     parameters:
   *       - { in: path, name: planId, required: true, schema: { type: string } }
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               confirm: { type: boolean }
   *               acceptUserStateLoss:
   *                 type: boolean
   *                 description: Continue when the Jellyfin snapshot cannot be taken
   *     responses:
   *       200: { description: Started }
   *       400: { description: Not confirmed }
   *       409: { description: Refused (code says why; stale lists the changed videos) }
   */
  router.post('/api/library-migration/plans/:planId/apply', verifyToken, handle((req) => tvMigration.apply(req.params.planId, {
    confirm: req.body?.confirm === true,
    acceptUserStateLoss: req.body?.acceptUserStateLoss === true,
  })));

  /**
   * @swagger
   * /api/library-migration/plans/{planId}/resume:
   *   post:
   *     summary: Resume an interrupted migration from its checkpoints
   *     tags: [Library Migration]
   *     parameters:
   *       - { in: path, name: planId, required: true, schema: { type: string } }
   *     responses:
   *       200: { description: Resumed }
   *       409: { description: Not interrupted, or another run is active }
   */
  router.post('/api/library-migration/plans/:planId/resume', verifyToken, handle((req) => tvMigration.resume(req.params.planId)));

  /**
   * @swagger
   * /api/library-migration/plans/{planId}/rollback:
   *   post:
   *     summary: Move every started video back and restore its database row
   *     description: Jellyfin user data written by a restore is not reverted.
   *     tags: [Library Migration]
   *     parameters:
   *       - { in: path, name: planId, required: true, schema: { type: string } }
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               confirm: { type: boolean }
   *     responses:
   *       200: { description: Rollback started }
   *       400: { description: Not confirmed }
   *       409: { description: Not applied or interrupted, or another run is active }
   */
  router.post('/api/library-migration/plans/:planId/rollback', verifyToken, handle((req) => tvMigration.rollback(req.params.planId, {
    confirm: req.body?.confirm === true,
  })));

  /**
   * @swagger
   * /api/library-migration/plans/{planId}/restore-user-state:
   *   post:
   *     summary: Restore snapshotted Jellyfin watch state and playlist entries onto the new episodes
   *     description: >
   *       Run after Jellyfin has scanned the new Shows library. Idempotent; videos Jellyfin has not found yet stay
   *       pending for the next call. When nothing is pending, Youtarr-managed playlists are re-synced too.
   *     tags: [Library Migration]
   *     parameters:
   *       - { in: path, name: planId, required: true, schema: { type: string } }
   *     responses:
   *       200: { description: Restore started }
   *       409: { description: Not applied, no snapshot, or another run is active }
   */
  router.post('/api/library-migration/plans/:planId/restore-user-state', verifyToken,
    handle((req) => tvMigration.restoreUserState(req.params.planId)));

  return router;
};
