const mockRows = new Map();
let mockCatalog = [];
let mockQueue = Promise.resolve();
const mockTx = { LOCK: { UPDATE: 'UPDATE' } };

jest.mock('../../db', () => ({ sequelize: { transaction: jest.fn(async (options, fn) => {
  const previous = mockQueue;
  let release;
  mockQueue = new Promise(resolve => { release = resolve; });
  await previous;
  try { return await fn(mockTx); } finally { release(); }
}) } }));
jest.mock('../../models/channelvideo', () => ({ findAll: jest.fn(async () => mockCatalog) }));
jest.mock('../../models/episodeShow', () => ({ findOrCreate: jest.fn(), findByPk: jest.fn() }));
jest.mock('../../models/episodeAssignment', () => ({
  findByPk: jest.fn(async id => mockRows.get(id)),
  findAll: jest.fn(async ({ where }) => [...mockRows.values()].filter(row => !where.channel_id || row.channel_id === where.channel_id)),
  create: jest.fn(async row => { mockRows.set(row.youtube_id, row); return row; }),
}));
const assignments = require('../episodeAssignment');

beforeEach(() => { mockRows.clear(); mockCatalog = []; mockQueue = Promise.resolve(); });
const entry = (youtube_id, publishedAt, published_at_source = 'exact') => ({ youtube_id, publishedAt, published_at_source });
const get = (youtubeId, publishedAt, source) => assignments.ensureEpisodeAssignment({ channelId: 'UC1', youtubeId, publishedAt, source });

test('first export sorts the known mockCatalog by date and id and later backfill does not renumber', async () => {
  mockCatalog = [entry('b', '2021-01-01'), entry('a', '2021-01-01')];
  expect((await get('b')).episode).toBe(2);
  expect((await get('a')).episode).toBe(1);
  mockCatalog.push(entry('earlier', '2020-12-01'), entry('late', '2021-01-01'));
  expect((await get('late')).episode).toBe(3);
  expect((await get('b')).episode).toBe(2);
});

test('simultaneous requests converge on unique numbers and repeated replay identity', async () => {
  mockCatalog = [entry('a', '2021-01-01'), entry('b', '2021-01-01')];
  const results = await Promise.all([get('a'), get('b'), get('a')]);
  expect(results.map(r => r.episode)).toEqual([1, 2, 1]);
});

test('synthetic dates remain unassigned and corrected years require review', async () => {
  mockCatalog = [entry('a', '2021-01-01', 'estimated')];
  expect((await get('a', '2021-01-01', 'estimated')).status).toBe('date-required');
  expect((await get('a', '2022-01-01', 'exact')).season).toBe(2022);
  expect((await get('a', '2023-01-01', 'exact')).status).toBe('date-correction-review');
});

test('duplicate catalog entries do not allocate twice and cross-channel ownership is retained', async () => {
  mockCatalog = [entry('a', '2021-01-01'), entry('a', '2021-01-01'), entry('b', '2021-01-01')];
  mockRows.set('b', { youtube_id: 'b', channel_id: 'other', season: 2021, episode: 1 });
  expect((await get('a')).episode).toBe(1);
  await expect(get('b')).rejects.toThrow('another channel');
});

test('same-year corrected dates require review without moving the episode', async () => {
  const first = await get('a', '2021-01-01', 'exact');
  const corrected = await get('a', '2021-02-01', 'exact');
  expect(corrected).toMatchObject({ season: first.season, episode: first.episode, status: 'date-correction-review' });
});

test('retries a deadlocked allocation and returns the persisted identity', async () => {
  const db = require('../../db').sequelize;
  db.transaction.mockRejectedValueOnce({ original: { code: 'ER_LOCK_DEADLOCK' } });
  expect(await get('a', '2021-01-01', 'exact')).toMatchObject({ season: 2021, episode: 1 });
});

test('invalid dates cannot create a season', async () => {
  expect((await get('a', '2021-02-30', 'exact')).status).toBe('date-required');
});
