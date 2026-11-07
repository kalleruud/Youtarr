const { VideoPublicationLease } = require('../videoPublicationLease');

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('a second holder of the same video waits for the first to release', async () => {
  const lease = new VideoPublicationLease();
  const release = await lease.acquire('abcdefghijk');
  let acquired = false;
  const next = lease.acquire('abcdefghijk').then((unlock) => { acquired = true; return unlock; });
  await flush();
  const before = acquired;
  await release();
  await (await next)();
  expect([before, acquired]).toEqual([false, true]);
});

test('different videos do not wait for each other', async () => {
  const lease = new VideoPublicationLease();
  await lease.acquire('abcdefghijk');
  await expect(lease.acquire('bcdefghijkl')).resolves.toEqual(expect.any(Function));
});

test('the lease is free again after the last holder releases', async () => {
  const lease = new VideoPublicationLease();
  await lease.withLease('abcdefghijk', async () => {});
  expect(lease.isHeld('abcdefghijk')).toBe(false);
});

test('withLease releases when the work throws', async () => {
  const lease = new VideoPublicationLease();
  await expect(lease.withLease('abcdefghijk', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
  expect(lease.isHeld('abcdefghijk')).toBe(false);
});
