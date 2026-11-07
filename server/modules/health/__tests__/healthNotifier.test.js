jest.mock('../../../logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() }));
jest.mock('../../configModule', () => ({ getConfig: jest.fn(() => ({ jellyfinApiKey: 'supersecretkey123' })) }));
jest.mock('../../notificationModule', () => ({ sendHealthAlert: jest.fn() }));

const { HealthNotifier, isAlertable, limits } = require('../healthNotifier');

const failed = (overrides = {}) => ({
  youtubeId: 'abcdefghijk', stage: 'library', status: 'failed', category: 'application-failure', message: 'Jellyfin request failed', ...overrides,
});

function makeNotifier() {
  let now = 0;
  const send = jest.fn().mockResolvedValue(1);
  const notifier = new HealthNotifier({ now: () => now, schedule: () => ({ unref() {} }), send });
  return { notifier, send, advance: (ms) => { now += ms; } };
}

describe('isAlertable', () => {
  test.each([
    [failed(), true],
    [failed({ stage: 'acquisition' }), false],
    [failed({ status: 'pending', category: 'scan-pending' }), false],
    [failed({ stage: 'captions', status: 'warning', category: 'policy-excluded' }), false],
    [failed({ stage: 'captions', status: 'warning', category: 'application-failure' }), true],
    [failed({ stage: 'captions', status: 'skipped', category: 'no-captions' }), false],
  ])('%j -> %s', (outcome, expected) => {
    expect(isAlertable(outcome)).toBe(expected);
  });
});

describe('HealthNotifier', () => {
  test('outcomes reported together are sent as one message', async () => {
    const { notifier, send } = makeNotifier();
    notifier.report([failed(), failed({ youtubeId: 'bbbbbbbbbbb', stage: 'publication', category: 'permission-path' })]);
    await notifier.flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].lines).toHaveLength(2);
  });

  test('the same problem is not notified again within the cooldown', async () => {
    const { notifier, send, advance } = makeNotifier();
    notifier.report([failed()]);
    await notifier.flush();
    advance(60 * 1000);
    notifier.report([failed({ youtubeId: 'ccccccccccc' })]);
    await notifier.flush();
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('the same problem notifies again after the cooldown', async () => {
    const { notifier, send, advance } = makeNotifier();
    notifier.report([failed()]);
    await notifier.flush();
    advance(limits.KEY_COOLDOWN_MS + 1);
    notifier.report([failed()]);
    await notifier.flush();
    expect(send).toHaveBeenCalledTimes(2);
  });

  test('messages per day are capped', async () => {
    const { notifier, send } = makeNotifier();
    for (let i = 0; i < limits.MAX_ALERTS_PER_DAY + 3; i += 1) {
      // Different problems each time, so only the daily cap applies.
      notifier.lastSentByKey.clear();
      notifier.report([failed({ youtubeId: `id${String(i).padStart(9, '0')}` })]);
      await notifier.flush();
    }
    expect(send).toHaveBeenCalledTimes(limits.MAX_ALERTS_PER_DAY);
  });

  test('long batches are truncated', async () => {
    const { notifier, send } = makeNotifier();
    const many = Array.from({ length: limits.MAX_LINES + 5 }, (_, i) => failed({ youtubeId: `id${String(i).padStart(9, '0')}` }));
    notifier.report(many);
    await notifier.flush();
    expect(send.mock.calls[0][0].lines).toHaveLength(limits.MAX_LINES + 1);
  });

  test('secrets in messages are redacted before sending', async () => {
    const { notifier, send } = makeNotifier();
    notifier.report([failed({ message: 'Request with key supersecretkey123 failed' })]);
    await notifier.flush();
    expect(JSON.stringify(send.mock.calls[0][0])).not.toContain('supersecretkey123');
  });

  test('abandoned jobs after a restart are reported with counts', async () => {
    const { notifier, send } = makeNotifier();
    notifier.reportAbandoned({ jobCount: 2, videoCount: 3 });
    await notifier.flush();
    expect(send.mock.calls[0][0].lines[0]).toContain('interrupted 2 download jobs (3 videos unfinished)');
  });

  test('nothing is sent when no job was abandoned', async () => {
    const { notifier, send } = makeNotifier();
    notifier.reportAbandoned({ jobCount: 0, videoCount: 0 });
    await notifier.flush();
    expect(send).not.toHaveBeenCalled();
  });
});
