// Rate-limited, batched, secret-safe health alerts (issue #18). Download
// failures already notify through the download summary, so this only covers
// what that summary cannot see: caption, publication and library-listing
// problems after a successful download, and jobs a restart abandoned.
// Alerts are collected for a short window and sent as one message; each
// (stage, category) alerts at most once per cooldown and the total per day
// is capped, so a failing step can never cause a notification storm. Every
// line is redacted again before it leaves Youtarr.
const logger = require('../../logger');
const configModule = require('../configModule');
const notificationModule = require('../notificationModule');
const { boundMessage } = require('./outcomeText');
const { STATUSES, CATEGORIES, CATEGORY_LABELS, STAGES } = require('./constants');

const BATCH_DELAY_MS = 60 * 1000;
const KEY_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const MAX_ALERTS_PER_DAY = 12;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_LINES = 10;
const ALERT_FOOTER = 'The downloaded media is kept. Open Settings > Acquisition Health for details and per-step retry. Repeats of the same problem are not notified again for 6 hours.';

// Alert only for problems a person has to act on; pending scans, policy
// skips and "no captions on YouTube" are visible in the health view only.
function isAlertable(outcome) {
  if (!outcome || outcome.stage === STAGES.ACQUISITION) return false;
  if (outcome.status === STATUSES.FAILED) return true;
  return outcome.status === STATUSES.WARNING
    && [CATEGORIES.APPLICATION_FAILURE, CATEGORIES.PERMISSION_PATH, CATEGORIES.STORAGE_LIMIT].includes(outcome.category);
}

class HealthNotifier {
  constructor({ now = () => Date.now(), schedule = setTimeout, send = (content) => notificationModule.sendHealthAlert(content) } = {}) {
    this.now = now;
    this.schedule = schedule;
    this.send = send;
    this.pending = [];
    this.timer = null;
    this.lastSentByKey = new Map();
    this.sentAt = [];
    this.suppressed = 0;
  }

  /** Queue outcomes; alertable ones are sent in the next batch. */
  report(outcomes) {
    for (const outcome of outcomes || []) {
      if (isAlertable(outcome)) this._enqueue({ key: `${outcome.stage}:${outcome.category}`, line: this._lineFor(outcome) });
    }
  }

  /** Restart recovery: jobs and videos that were abandoned. */
  reportAbandoned({ jobCount, videoCount }) {
    if (!jobCount) return;
    this._enqueue({
      key: 'restart:abandoned',
      line: `A restart interrupted ${jobCount} download job${jobCount === 1 ? '' : 's'}${videoCount ? ` (${videoCount} video${videoCount === 1 ? '' : 's'} unfinished)` : ''}. Retry them from the health view or Download History.`,
    });
  }

  _lineFor(outcome) {
    const label = CATEGORY_LABELS[outcome.category] || outcome.category;
    return `${outcome.stage} - ${label} - ${outcome.youtubeId}: ${outcome.message || outcome.reasonCode || outcome.status}`;
  }

  _enqueue(item) {
    const last = this.lastSentByKey.get(item.key);
    if (last !== undefined && this.now() - last < KEY_COOLDOWN_MS && !this.pending.some((p) => p.key === item.key)) {
      this.suppressed += 1;
      return;
    }
    this.pending.push(item);
    if (!this.timer) {
      this.timer = this.schedule(() => {
        this.timer = null;
        this.flush().catch((err) => logger.error({ err }, 'Health alert flush failed'));
      }, BATCH_DELAY_MS);
      if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
    }
  }

  async flush() {
    const items = this.pending;
    this.pending = [];
    if (!items.length) return null;
    const now = this.now();
    this.sentAt = this.sentAt.filter((at) => now - at < DAY_MS);
    if (this.sentAt.length >= MAX_ALERTS_PER_DAY) {
      this.suppressed += items.length;
      logger.warn({ dropped: items.length }, 'Health alert daily limit reached; see the health view');
      return null;
    }
    const config = configModule.getConfig() || {};
    const lines = items.slice(0, MAX_LINES).map((item) => boundMessage(item.line, config));
    if (items.length > MAX_LINES) lines.push(`…and ${items.length - MAX_LINES} more.`);
    const content = {
      title: items.length === 1 ? '⚠️ Youtarr needs attention' : `⚠️ Youtarr: ${items.length} problems need attention`,
      summary: 'Some processing steps after download did not finish.',
      lines,
      footer: ALERT_FOOTER,
    };
    this.sentAt.push(now);
    for (const item of items) this.lastSentByKey.set(item.key, now);
    await this.send(content);
    return content;
  }
}

const healthNotifier = new HealthNotifier();
healthNotifier.HealthNotifier = HealthNotifier;
healthNotifier.isAlertable = isAlertable;
healthNotifier.limits = { BATCH_DELAY_MS, KEY_COOLDOWN_MS, MAX_ALERTS_PER_DAY, MAX_LINES };
module.exports = healthNotifier;
