const { parseRetrySchedule, resolveRetrySchedule, nextAttemptAt } = require('../enrichmentSchedule');

const HOUR = 60 * 60 * 1000;

test('parses the default proposal', () => {
  expect(parseRetrySchedule('1h, 24h, 7d').offsetsMs).toEqual([HOUR, 24 * HOUR, 7 * 24 * HOUR]);
});

test.each([
  ['', 'at least one'],
  ['1h,1h', 'increase'],
  ['1m', 'between 5 minutes and 90 days'],
  ['tomorrow', 'not an offset'],
  ['1h,2h,3h,4h,5h,6h,7h,8h,9h,10h,11h', 'at most 10'],
])('rejects %p', (value, message) => {
  expect(parseRetrySchedule(value).error).toContain(message);
});

test('an unusable setting falls back to the default schedule', () => {
  expect(resolveRetrySchedule('nonsense')).toHaveLength(3);
});

test('the first check is the first offset after the download', () => {
  const baseline = new Date('2026-01-01T00:00:00Z');
  expect(nextAttemptAt({ baseline, attempts: 0, offsetsMs: [HOUR], now: baseline })).toEqual(new Date('2026-01-01T01:00:00Z'));
});

test('a used-up schedule has no next check', () => {
  expect(nextAttemptAt({ baseline: new Date(0), attempts: 1, offsetsMs: [HOUR], now: new Date(0) })).toBeNull();
});

test('overdue checks keep their spacing after the previous check', () => {
  const baseline = new Date('2026-01-01T00:00:00Z');
  const now = new Date('2026-01-20T00:00:00Z');
  const next = nextAttemptAt({ baseline, attempts: 1, offsetsMs: [HOUR, 24 * HOUR], now, lastAttemptAt: now });
  expect(next).toEqual(new Date(now.getTime() + 23 * HOUR));
});
