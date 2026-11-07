// One exclusive maintenance lease for library-wide changes that must not race
// with downloads, cleanup, rescans or file checks (the TV library migration).
// While it is held, downloads are refused, queued jobs stay Pending, automatic
// cleanup and the orphan sweep skip, manual deletes are refused, and the
// rescan, library repair and page-load file check leave rows alone.
//
// The lease is written to config/maintenance-lease.json and read back
// synchronously when this module loads, so a restart in the middle of a
// migration comes back paused before any startup task runs.
const EventEmitter = require('events');
const { AsyncLocalStorage } = require('async_hooks');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('../logger');

const DEFAULT_LEASE_PATH = path.join(__dirname, '../../config', 'maintenance-lease.json');
const MAINTENANCE_ACTIVE_CODE = 'MAINTENANCE_ACTIVE';

class MaintenanceActiveError extends Error {
  constructor(lease) {
    super(`A library maintenance task is running: ${lease.reason}`);
    this.name = 'MaintenanceActiveError';
    this.code = MAINTENANCE_ACTIVE_CODE;
    this.lease = lease;
  }
}

class MaintenanceLease extends EventEmitter {
  constructor({ leasePath = DEFAULT_LEASE_PATH } = {}) {
    super();
    this.leasePath = leasePath;
    this.operations = new Set();
    this.operationContext = new AsyncLocalStorage();
    this.ownerContext = new AsyncLocalStorage();
    this.lease = this._load();
  }

  _load() {
    try {
      const lease = JSON.parse(fs.readFileSync(this.leasePath, 'utf8'));
      if (lease && typeof lease.token === 'string' && typeof lease.owner === 'string') {
        logger.warn({ owner: lease.owner, reason: lease.reason }, 'A library maintenance lease survived a restart; downloads and cleanup stay paused until it is released');
        return lease;
      }
    } catch (err) {
      if (err.code !== 'ENOENT') logger.error({ err, leasePath: this.leasePath }, 'Could not read the maintenance lease file');
    }
    return null;
  }

  _persist() {
    fs.mkdirSync(path.dirname(this.leasePath), { recursive: true });
    const tmp = `${this.leasePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.lease, null, 2));
    fs.renameSync(tmp, this.leasePath);
  }

  /** The current lease ({ token, owner, reason, acquiredAt }) or null. */
  current() {
    return this.lease ? { ...this.lease } : null;
  }

  isActive() {
    return this.lease !== null;
  }

  /** Human-readable reason, for skipped runs and refusals. */
  describe() {
    return this.lease ? `A library maintenance task is running: ${this.lease.reason}` : null;
  }

  /**
   * Take the lease. The same owner may take it again (resume after a
   * restart) and gets the existing token back.
   * @param {string} owner - Stable id of the holder, e.g. "tv-migration:<planId>"
   * @param {string} reason - Shown to users while held
   * @returns {string} token
   */
  acquire(owner, reason) {
    if (this.operations.size) throw new MaintenanceActiveError({ reason: 'Library writes are in progress; retry when they finish' });
    if (this.lease && this.lease.owner !== owner) throw new MaintenanceActiveError(this.lease);
    if (this.lease) {
      if (this.lease.reason !== reason) {
        this.lease.reason = reason;
        this._persist();
      }
      return this.lease.token;
    }
    this.lease = { token: crypto.randomBytes(12).toString('hex'), owner, reason, acquiredAt: new Date().toISOString() };
    try {
      this._persist();
    } catch (err) {
      this.lease = null;
      throw err;
    }
    logger.info({ owner, reason }, 'Maintenance lease acquired');
    return this.lease.token;
  }

  /** Release the lease held by owner. A lease held by someone else is left alone. */
  release(owner) {
    if (!this.lease || this.lease.owner !== owner) return false;
    try {
      fs.rmSync(this.leasePath, { force: true });
    } catch (err) {
      logger.error({ err, leasePath: this.leasePath }, 'Could not remove the maintenance lease file');
      throw err;
    }
    this.lease = null;
    logger.info({ owner }, 'Maintenance lease released');
    this.emit('released');
    return true;
  }

  // Entry and lease acquisition are synchronous: neither can slip between the
  // other's check and registration. Nested and detached calls each retain their own lifetime.
  async runOperation(operation) {
    if (this.lease && this.ownerContext.getStore() === this.lease.token) return operation();
    const inherited = this.operationContext.getStore();
    if (!inherited || !this.operations.has(inherited)) this.assertInactive();
    const token = {};
    this.operations.add(token);
    try {
      return await this.operationContext.run(token, operation);
    } finally {
      this.operations.delete(token);
    }
  }

  runAsOwner(owner, operation) {
    if (!this.lease || this.lease.owner !== owner) throw new Error('Maintenance lease ownership required');
    return this.ownerContext.run(this.lease.token, operation);
  }

  trackMethods(instance, names, guarded = []) {
    for (const name of names) {
      const original = instance[name];
      instance[name] = (...args) => {
        // Preserve existing skip/refusal response shapes while maintenance is held.
        if (this.isActive() && guarded.includes(name)) return original.apply(instance, args);
        return this.runOperation(() => original.apply(instance, args));
      };
    }
    return instance;
  }

  /** Throw MaintenanceActiveError while any lease is held. */
  assertInactive() {
    if (this.lease) throw new MaintenanceActiveError(this.lease);
  }

  isMaintenanceError(err) {
    return Boolean(err && err.code === MAINTENANCE_ACTIVE_CODE);
  }
}

module.exports = new MaintenanceLease();
module.exports.MaintenanceLease = MaintenanceLease;
module.exports.MaintenanceActiveError = MaintenanceActiveError;
module.exports.MAINTENANCE_ACTIVE_CODE = MAINTENANCE_ACTIVE_CODE;
