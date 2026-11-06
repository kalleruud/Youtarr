// Migrates existing downloads from the regular (movie) layout into the
// Jellyfin TV layout without downloading anything again.
//
//   createPlan  -> preview: an immutable manifest, nothing moves
//   apply       -> takes the maintenance lease, snapshots Jellyfin user state,
//                  then moves video by video with durable checkpoints
//   resume      -> continues an interrupted apply from its checkpoints
//   rollback    -> puts every started video back and restores its row
//   restoreUserState -> after Jellyfin scanned the new Shows library, writes
//                  the snapshotted watched/resume state and playlist entries
//
// While a plan is applying, rolling back, or interrupted, the maintenance
// lease stays held (it survives restarts), so downloads, cleanup, rescans and
// file checks never see a half-moved library.
const logger = require('../../logger');
const configModule = require('../configModule');
const tvPublication = require('../tvPublication');
const m3uGenerator = require('../m3uGenerator');
const playlistOutputRefresh = require('../playlistOutputRefresh');
const maintenanceLease = require('../maintenanceLease');
const { Playlist, PlaylistVideo, Video } = require('../../models');
const { checkLibraryRoot, libraryCheckCoversRows } = require('../libraryRootCheck');
const { MigrationStore, newPlanId, isPlanId } = require('./migrationStore');
const migrationPlanner = require('./migrationPlanner');
const executor = require('./migrationExecutor');
const userState = require('./userState');

const STATUS = {
  PLANNED: 'planned',
  APPLYING: 'applying',
  APPLIED: 'applied',
  INTERRUPTED: 'interrupted',
  ROLLING_BACK: 'rolling-back',
  ROLLED_BACK: 'rolled-back',
};
const ACTIVE_STATUSES = [STATUS.APPLYING, STATUS.ROLLING_BACK, STATUS.INTERRUPTED];
const MAX_CHANNEL_IDS = 500;

class TvMigrationError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'TvMigrationError';
    this.code = code;
    if (details) this.details = details;
  }
}

function leaseOwner(planId) {
  return `tv-migration:${planId}`;
}

// The manifest without NFO bodies, which only the executor needs.
function publicItem(item, itemState) {
  const { documents, ...rest } = item;
  return { ...rest, documents: documents.map((doc) => ({ role: doc.role, target: doc.target })), state: itemState || { status: 'pending' } };
}

class TvMigration {
  constructor({ store = new MigrationStore(), lease = maintenanceLease } = {}) {
    this.store = store;
    this.lease = lease;
    this.running = null;
    this.downloadActivityCheck = () => false;
  }

  /** server.js wires in "is a download job running right now". */
  setDownloadActivityCheck(check) {
    this.downloadActivityCheck = check;
  }

  /** A run in progress when the process stopped is marked interrupted; its lease is still held. */
  async initialize() {
    // A process that stopped between finishing a run and releasing its lease
    // left the lease behind; a finished plan no longer needs it.
    const lease = this.lease.current();
    const leasedPlan = lease && lease.owner.startsWith('tv-migration:') ? lease.owner.slice('tv-migration:'.length) : null;
    if (leasedPlan && isPlanId(leasedPlan)) {
      const leasedState = await this.store.loadState(leasedPlan);
      if (!leasedState || [STATUS.PLANNED, STATUS.APPLIED, STATUS.ROLLED_BACK].includes(leasedState.status)) {
        this.lease.release(lease.owner);
        logger.warn({ planId: leasedPlan }, 'Released the maintenance lease of a finished TV library migration');
      }
    }
    for (const planId of await this.store.listPlanIds()) {
      const state = await this.store.loadState(planId);
      if (!state || ![STATUS.APPLYING, STATUS.ROLLING_BACK].includes(state.status)) continue;
      state.error = `The server stopped while the migration was ${state.status === STATUS.APPLYING ? 'applying' : 'rolling back'}. Resume or roll it back.`;
      state.interruptedFrom = state.status;
      state.status = STATUS.INTERRUPTED;
      await this.store.saveState(planId, state);
      this.lease.acquire(leaseOwner(planId), `TV library migration ${planId} was interrupted`);
      logger.warn({ planId }, 'TV library migration was interrupted by a restart');
    }
  }

  async createPlan({ channelIds = null, verifyChecksums = true } = {}) {
    if (channelIds !== null && (!Array.isArray(channelIds) || channelIds.length > MAX_CHANNEL_IDS ||
        !channelIds.every((id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id)))) {
      throw new TvMigrationError('invalid-scope', 'channelIds must be a list of YouTube channel ids');
    }
    if (this.lease.isActive()) {
      throw new TvMigrationError('maintenance-active', this.lease.describe());
    }
    const planId = newPlanId();
    const plan = await migrationPlanner.plan({ planId, channelIds, verifyChecksums });
    await this.store.savePlan(plan);
    await this.store.saveState(planId, { status: STATUS.PLANNED, items: {}, createdDocuments: [] });
    logger.info({ planId, summary: plan.summary, blockers: plan.blockers.length }, 'TV library migration planned');
    return this.get(planId);
  }

  async list() {
    const plans = [];
    for (const planId of await this.store.listPlanIds()) {
      const [plan, state] = await Promise.all([this.store.loadPlan(planId), this.store.loadState(planId)]);
      if (!plan) continue;
      plans.push({ planId, createdAt: plan.createdAt, status: state?.status || STATUS.PLANNED, summary: plan.summary, error: state?.error || null });
    }
    return { plans, lease: this.lease.current(), running: this.running ? this.running.planId : null };
  }

  async get(planId) {
    const { plan, state } = await this._load(planId);
    const snapshot = await this.store.loadUserState(planId);
    const items = plan.items.map((item) => publicItem(item, state.items[item.youtubeId]));
    const counts = { pending: 0, 'in-progress': 0, done: 0, failed: 0, 'rolled-back': 0 };
    for (const item of items) counts[item.state.status] = (counts[item.state.status] || 0) + 1;
    return {
      ...plan,
      items,
      status: state.status,
      error: state.error || null,
      interruptedFrom: state.status === STATUS.INTERRUPTED ? (state.interruptedFrom || STATUS.APPLYING) : null,
      progress: counts,
      appliedAt: state.appliedAt || null,
      rolledBackAt: state.rolledBackAt || null,
      followUps: state.followUps || [],
      userState: snapshot ? { takenAt: snapshot.takenAt, counts: snapshot.counts } : null,
      userStateSkipped: state.userStateSkipped || null,
      userStateDiagnostics: state.userStateDiagnostics || null,
      restore: state.restore || null,
      running: Boolean(this.running && this.running.planId === planId),
    };
  }

  async _load(planId) {
    if (!isPlanId(planId)) throw new TvMigrationError('not-found', 'Migration plan not found');
    const [plan, state] = await Promise.all([this.store.loadPlan(planId), this.store.loadState(planId)]);
    if (!plan || !state) throw new TvMigrationError('not-found', 'Migration plan not found');
    return { plan, state };
  }

  _assertIdle() {
    if (this.running) throw new TvMigrationError('running', `Migration ${this.running.planId} is already ${this.running.mode === 'rollback' ? 'rolling back' : 'running'}`);
  }

  /**
   * Start moving files. Refused unless the plan is fresh, confirmed, free of
   * blockers, and the library profile is Jellyfin TV.
   * @param {string} planId
   * @param {{confirm?: boolean, acceptUserStateLoss?: boolean}} options
   */
  async apply(planId, { confirm = false, acceptUserStateLoss = false } = {}) {
    this._assertIdle();
    const { plan, state } = await this._load(planId);
    if (state.status !== STATUS.PLANNED) throw new TvMigrationError('invalid-state', `The plan is ${state.status}; only a new plan can be applied`);
    if (confirm !== true) throw new TvMigrationError('confirmation-required', 'Applying moves files; send confirm: true');
    if (plan.blockers.length > 0) throw new TvMigrationError('blocked', plan.blockers.map((b) => b.message).join(' '));
    if (plan.items.length === 0) throw new TvMigrationError('nothing-to-do', 'The plan has no videos to move');
    if (!tvPublication.isEnabled()) {
      throw new TvMigrationError('profile-not-tv', 'Set the Library Output Profile to Jellyfin TV before applying, so new downloads use the same layout');
    }
    if (configModule.directoryPath !== plan.baseDir) {
      throw new TvMigrationError('stale', 'The downloads folder changed since this plan was made; make a new plan');
    }
    if (this.downloadActivityCheck()) {
      throw new TvMigrationError('downloads-active', 'A download is running. Apply the migration once it finishes.');
    }

    const owner = leaseOwner(planId);
    try {
      this.lease.acquire(owner, `TV library migration ${planId} is moving files`);
    } catch (err) {
      if (this.lease.isMaintenanceError(err)) throw new TvMigrationError('maintenance-active', err.message);
      throw err;
    }
    try {
      const libraryCheck = await checkLibraryRoot(plan.baseDir);
      if (await libraryCheckCoversRows(libraryCheck, Video, { removed: false })) {
        throw new TvMigrationError('library-unavailable', libraryCheck.message);
      }
      const stale = [];
      for (const item of plan.items) {
        const reason = await executor.staleReason(item);
        if (reason) stale.push({ youtubeId: item.youtubeId, reason });
      }
      if (stale.length > 0) {
        throw new TvMigrationError('stale', `${stale.length} video(s) changed since the plan was made; make a new plan`, { stale });
      }
      await this._snapshotUserState(plan, state, acceptUserStateLoss);
    } catch (err) {
      this.lease.release(owner);
      throw err;
    }

    state.status = STATUS.APPLYING;
    state.startedAt = new Date().toISOString();
    await this.store.saveState(planId, state);
    this._start(planId, 'apply');
    return this.get(planId);
  }

  async _snapshotUserState(plan, state, acceptUserStateLoss) {
    const config = configModule.getConfig() || {};
    if (!userState.jellyfinConfigured(config)) return;
    try {
      const snapshot = await userState.snapshot(plan, config);
      await this.store.saveUserState(plan.planId, snapshot);
    } catch (err) {
      logger.warn({ err, planId: plan.planId }, 'Could not snapshot Jellyfin user state before the migration');
      if (!acceptUserStateLoss) {
        throw new TvMigrationError('snapshot-failed',
          `Could not read Jellyfin watch state and playlists (${err.message}). Fix the connection, or apply with acceptUserStateLoss to continue without them.`, err.diagnostics);
      }
      state.userStateDiagnostics = err.diagnostics || null;
      state.userStateSkipped = `Jellyfin user state was not snapshotted: ${err.message}`;
    }
  }

  async resume(planId) {
    this._assertIdle();
    const { state } = await this._load(planId);
    if (state.status !== STATUS.INTERRUPTED || state.interruptedFrom === STATUS.ROLLING_BACK) {
      throw new TvMigrationError('invalid-state', state.interruptedFrom === STATUS.ROLLING_BACK
        ? 'This migration was interrupted while rolling back; roll it back again'
        : `The plan is ${state.status}; only an interrupted migration can be resumed`);
    }
    this.lease.acquire(leaseOwner(planId), `TV library migration ${planId} is moving files`);
    state.status = STATUS.APPLYING;
    state.error = null;
    await this.store.saveState(planId, state);
    this._start(planId, 'apply');
    return this.get(planId);
  }

  async rollback(planId, { confirm = false } = {}) {
    this._assertIdle();
    const { state } = await this._load(planId);
    if (![STATUS.INTERRUPTED, STATUS.APPLIED].includes(state.status)) {
      throw new TvMigrationError('invalid-state', `The plan is ${state.status}; only an applied or interrupted migration can be rolled back`);
    }
    if (confirm !== true) throw new TvMigrationError('confirmation-required', 'Rolling back moves files; send confirm: true');
    try {
      this.lease.acquire(leaseOwner(planId), `TV library migration ${planId} is rolling back`);
    } catch (err) {
      if (this.lease.isMaintenanceError(err)) throw new TvMigrationError('maintenance-active', err.message);
      throw err;
    }
    state.status = STATUS.ROLLING_BACK;
    state.error = null;
    await this.store.saveState(planId, state);
    this._start(planId, 'rollback');
    return this.get(planId);
  }

  async restoreUserState(planId) {
    this._assertIdle();
    const { plan, state } = await this._load(planId);
    if (state.status !== STATUS.APPLIED) throw new TvMigrationError('invalid-state', 'Only an applied migration can restore user state');
    const snapshot = await this.store.loadUserState(planId);
    if (!snapshot) throw new TvMigrationError('no-snapshot', 'This migration has no Jellyfin user state to restore');
    state.restore = { ...(state.restore || {}), status: 'running', startedAt: new Date().toISOString() };
    await this.store.saveState(planId, state);
    this._start(planId, 'restore', { plan, snapshot });
    return this.get(planId);
  }

  // Runs one background job; the caller already validated and persisted the
  // starting state. Never rejects.
  _start(planId, mode, extra = {}) {
    const run = (async () => {
      try {
        if (mode === 'apply') await this._runApply(planId);
        else if (mode === 'rollback') await this._runRollback(planId);
        else await this._runRestore(planId, extra);
      } catch (err) {
        logger.error({ err, planId, mode }, 'TV library migration run failed');
      } finally {
        this.running = null;
      }
    })();
    this.running = { planId, mode, promise: run };
  }

  /** Resolves when the current background run (if any) ends. For tests and shutdown. */
  async waitForIdle() {
    if (this.running) await this.running.promise;
  }

  async _runApply(planId) {
    const { plan, state } = await this._load(planId);
    const createdDocuments = new Set(state.createdDocuments || []);
    const save = async () => {
      state.createdDocuments = [...createdDocuments];
      await this.store.saveState(planId, state);
    };
    for (const item of plan.items) {
      const itemState = state.items[item.youtubeId] || { status: 'pending' };
      if (itemState.status === 'done') continue;
      itemState.status = 'in-progress';
      itemState.error = null;
      state.items[item.youtubeId] = itemState;
      await save();
      try {
        await executor.applyItem(item, {
          itemState,
          leftoversRoot: this.store.rootDir,
          leftoversDir: this.store.leftoversDir(planId, item.youtubeId),
          createdDocuments,
          verifyChecksums: plan.options.verifyChecksums,
          checkpoint: save,
        });
        itemState.status = 'done';
        await save();
      } catch (err) {
        logger.error({ err, planId, youtubeId: item.youtubeId }, 'TV library migration stopped at a video');
        itemState.status = 'failed';
        itemState.error = err.message;
        state.status = STATUS.INTERRUPTED;
        state.interruptedFrom = STATUS.APPLYING;
        state.error = `Stopped at ${item.youtubeId}: ${err.message}. Fix the cause, then resume, or roll back.`;
        await save();
        return;
      }
    }
    state.followUps = await this.lease.runAsOwner(leaseOwner(planId), () => this._refreshPlaylistFiles(plan));
    state.status = STATUS.APPLIED;
    state.appliedAt = new Date().toISOString();
    state.error = null;
    await save();
    this.lease.release(leaseOwner(planId));
    logger.info({ planId, moved: plan.items.length }, 'TV library migration applied');
  }

  async _runRollback(planId) {
    const { plan, state } = await this._load(planId);
    const save = () => this.store.saveState(planId, state);
    for (const item of [...plan.items].reverse()) {
      const itemState = state.items[item.youtubeId];
      if (!itemState || ['pending', 'rolled-back'].includes(itemState.status)) continue;
      try {
        await executor.rollbackItem(item, {
          itemState,
          leftoversRoot: this.store.rootDir,
          leftoversDir: this.store.leftoversDir(planId, item.youtubeId),
          checkpoint: save,
        });
        itemState.status = 'rolled-back';
        itemState.error = null;
        await save();
      } catch (err) {
        logger.error({ err, planId, youtubeId: item.youtubeId }, 'TV library migration rollback stopped at a video');
        itemState.error = err.message;
        state.status = STATUS.INTERRUPTED;
        state.interruptedFrom = STATUS.ROLLING_BACK;
        state.error = `Rollback stopped at ${item.youtubeId}: ${err.message}. Fix the cause, then roll back again.`;
        await save();
        return;
      }
    }
    state.removedDocuments = await executor.removeCreatedDocuments(state.createdDocuments || []);
    state.followUps = await this.lease.runAsOwner(leaseOwner(planId), () => this._refreshPlaylistFiles(plan));
    state.status = STATUS.ROLLED_BACK;
    state.rolledBackAt = new Date().toISOString();
    await save();
    this.lease.release(leaseOwner(planId));
    logger.info({ planId }, 'TV library migration rolled back');
  }

  async _runRestore(planId, { plan, snapshot }) {
    const { state } = await this._load(planId);
    const doneIds = new Set(Object.entries(state.items).filter(([, s]) => s.status === 'done').map(([id]) => id));
    try {
      const { progress, report } = await userState.restore(plan, snapshot, state.restore?.progress, configModule.getConfig() || {}, { doneIds });
      const complete = report.pending.length === 0 && report.playlistsPending === 0 && report.failed.length === 0;
      if (complete) await playlistOutputRefresh.refreshForVideos([...doneIds]);
      state.restore = { status: complete ? 'complete' : 'partial', finishedAt: new Date().toISOString(), progress, report };
    } catch (err) {
      logger.error({ err, planId }, 'Restoring Jellyfin user state failed');
      state.restore = { ...(state.restore || {}), status: 'error', finishedAt: new Date().toISOString(), error: err.message };
    }
    await this.store.saveState(planId, state);
  }

  // Regenerate the .m3u files that list moved videos. Media server playlists
  // are re-synced by restoreUserState, once Jellyfin has scanned the new paths.
  async _refreshPlaylistFiles(plan) {
    const notes = [];
    const ids = plan.items.map((item) => item.youtubeId);
    for (const channelId of new Set(plan.items.map((item) => item.channelId))) {
      try {
        await m3uGenerator.generateChannelM3U(channelId);
      } catch (err) {
        notes.push(`Channel playlist file for ${channelId} was not regenerated: ${err.message}`);
      }
    }
    try {
      const rows = await PlaylistVideo.findAll({ where: { youtube_id: ids, ignored: false }, attributes: ['playlist_id'] });
      const playlists = await Playlist.findAll({ where: { playlist_id: [...new Set(rows.map((row) => row.playlist_id))], enabled: true } });
      for (const playlist of playlists) await m3uGenerator.generatePlaylistM3U(playlist.id);
    } catch (err) {
      notes.push(`Playlist .m3u files were not regenerated: ${err.message}`);
    }
    return notes;
  }
}

module.exports = new TvMigration();
module.exports.TvMigration = TvMigration;
module.exports.TvMigrationError = TvMigrationError;
module.exports.STATUS = STATUS;
module.exports.ACTIVE_STATUSES = ACTIVE_STATUSES;
