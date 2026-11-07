jest.mock('../../../models/video', () => ({ findOne: jest.fn(), findAll: jest.fn() }));
jest.mock('../../../models/captionTrack', () => ({ findAll: jest.fn(), findOne: jest.fn(), create: jest.fn(), destroy: jest.fn(), update: jest.fn() }));
jest.mock('../../../models/captionEnrichmentJob', () => ({ findAll: jest.fn(), findOne: jest.fn(), create: jest.fn(), update: jest.fn() }));

const CaptionEnrichmentJob = require('../../../models/captionEnrichmentJob');
const CaptionTrack = require('../../../models/captionTrack');
const store = require('../captionStore');

const row = (values) => ({ ...values, get: () => values });

beforeEach(() => jest.clearAllMocks());

test('claims only checks it moved out of pending', async () => {
  CaptionEnrichmentJob.findAll.mockResolvedValue([row({ id: 1, youtube_id: 'a' }), row({ id: 2, youtube_id: 'b' })]);
  CaptionEnrichmentJob.update.mockResolvedValueOnce([1]).mockResolvedValueOnce([0]);
  const claimed = await store.claimDueJobs({ now: new Date(), limit: 5, leaseUntil: new Date() });
  expect(claimed.map((job) => job.youtube_id)).toEqual(['a']);
});

test('startup recovery returns every running check', async () => {
  CaptionEnrichmentJob.update.mockResolvedValue([2]);
  await store.recoverExpiredLeases(new Date(), { all: true });
  expect(CaptionEnrichmentJob.update.mock.calls[0][1]).toEqual({ where: { status: 'running' } });
});

test('saving a new track creates it', async () => {
  CaptionTrack.findOne.mockResolvedValue(null);
  await store.saveTrack({ youtube_id: 'a', track_code: 'en' });
  expect(CaptionTrack.create).toHaveBeenCalledWith(expect.objectContaining({ youtube_id: 'a', track_code: 'en' }));
});

test('protection on an unrecorded track reports no row', async () => {
  CaptionTrack.findOne.mockResolvedValue(null);
  expect(await store.setProtected('a', 'en', true)).toBe(false);
});

test('repeating the stored protection value still reports the row', async () => {
  // MySQL reports changed rows: a repeated value affects 0 rows.
  const existing = { protected: true, update: jest.fn() };
  CaptionTrack.findOne.mockResolvedValue(existing);
  CaptionTrack.update.mockResolvedValue([0]);
  expect(await store.setProtected('a', 'en', true)).toBe(true);
});

test('changing protection updates the found row', async () => {
  const existing = { protected: false, update: jest.fn() };
  CaptionTrack.findOne.mockResolvedValue(existing);
  await store.setProtected('a', 'en', true);
  expect(existing.update).toHaveBeenCalledWith(expect.objectContaining({ protected: true }));
});
