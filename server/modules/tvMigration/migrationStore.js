// Durable storage for TV library migrations, one folder per plan under
// config/tv-migrations/<planId>/:
//   plan.json        the immutable manifest written by planning
//   state.json       checkpoints, rewritten atomically after every step
//   user-state.json  the media server snapshot taken before the first move
//   leftovers/       per-video files the TV layout has no place for (the movie
//                    NFO, fanart, backdrop), kept so a rollback can put them back
// The media library itself never holds migration bookkeeping.
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_ROOT = path.join(__dirname, '../../../config', 'tv-migrations');
const PLAN_ID_PATTERN = /^\d{8}T\d{6}Z-[0-9a-f]{8}$/;

function isPlanId(value) {
  return typeof value === 'string' && PLAN_ID_PATTERN.test(value);
}

function newPlanId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `${stamp}-${crypto.randomBytes(4).toString('hex')}`;
}

async function writeJsonAtomic(target, value) {
  await fs.ensureDir(path.dirname(target));
  const tmp = `${target}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const handle = await fs.promises.open(tmp, 'w');
  try {
    await handle.writeFile(JSON.stringify(value, null, 2), 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, target);
}

async function readJson(target) {
  try {
    return JSON.parse(await fs.readFile(target, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

class MigrationStore {
  constructor({ rootDir = DEFAULT_ROOT } = {}) {
    this.rootDir = rootDir;
  }

  planDir(planId) {
    if (!isPlanId(planId)) throw new Error('Invalid migration plan id');
    return path.join(this.rootDir, planId);
  }

  leftoversDir(planId, youtubeId) {
    return path.join(this.planDir(planId), 'leftovers', youtubeId);
  }

  async savePlan(plan) {
    const target = path.join(this.planDir(plan.planId), 'plan.json');
    if (await fs.pathExists(target)) throw new Error('A migration plan is immutable once written');
    await writeJsonAtomic(target, plan);
  }

  async loadPlan(planId) {
    return readJson(path.join(this.planDir(planId), 'plan.json'));
  }

  async saveState(planId, state) {
    await writeJsonAtomic(path.join(this.planDir(planId), 'state.json'), { ...state, updatedAt: new Date().toISOString() });
  }

  async loadState(planId) {
    return readJson(path.join(this.planDir(planId), 'state.json'));
  }

  async saveUserState(planId, snapshot) {
    await writeJsonAtomic(path.join(this.planDir(planId), 'user-state.json'), snapshot);
  }

  async loadUserState(planId) {
    return readJson(path.join(this.planDir(planId), 'user-state.json'));
  }

  /** Plan ids on disk, newest first. */
  async listPlanIds() {
    let names;
    try {
      names = await fs.readdir(this.rootDir);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    return names.filter(isPlanId).sort().reverse();
  }
}

module.exports = { MigrationStore, isPlanId, newPlanId, writeJsonAtomic };
