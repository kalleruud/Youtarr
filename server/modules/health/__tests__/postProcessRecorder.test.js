jest.mock('../outcomeStore', () => ({ record: jest.fn(async (o) => o) }));

const outcomeStore = require('../outcomeStore');
const recorder = require('../postProcessRecorder');

const stages = () => outcomeStore.record.mock.calls.map(([o]) => `${o.stage}:${o.status}`);

beforeEach(() => jest.clearAllMocks());

test('a TV episode records publication and a pending Jellyfin check with the show folder', async () => {
  await recorder.recordPublished({
    youtubeId: 'abcdefghijk', jobId: 'j', mediaPath: '/lib/Show [UC1]/Season 2026/ep.mp4',
    tvPlan: { showDir: '/lib/Show [UC1]', season: 2026, episode: 7 },
  });
  expect(stages()).toEqual(['publication:ok', 'library:pending']);
  expect(outcomeStore.record.mock.calls[1][0].details).toMatchObject({ showDir: '/lib/Show [UC1]', mediaPath: '/lib/Show [UC1]/Season 2026/ep.mp4' });
});

test('a movie-layout download records publication only', async () => {
  await recorder.recordPublished({ youtubeId: 'abcdefghijk', mediaPath: '/lib/x.mp4' });
  expect(stages()).toEqual(['publication:ok']);
});

test('a move failure from permissions is a permission/path error pointing at the download retry', async () => {
  await recorder.recordPublicationFailure({ youtubeId: 'abcdefghijk', error: Object.assign(new Error('denied'), { code: 'EACCES' }) });
  expect(outcomeStore.record.mock.calls[0][0]).toMatchObject({ status: 'failed', category: 'permission-path', retryable: false, message: expect.stringContaining('retry the download') });
});

test('caption results are recorded as one captions outcome', async () => {
  await recorder.recordCaptions({ youtubeId: 'abcdefghijk', results: [{ file: 'a.srt', result: { status: 'unchanged', diagnostics: { transitionsRemoved: 0 } } }] });
  expect(stages()).toEqual(['captions:ok']);
});

test('no captions outcome when captions are off and none were downloaded', async () => {
  await recorder.recordCaptions({ youtubeId: 'abcdefghijk', results: [], subtitlesRequested: false });
  expect(outcomeStore.record).not.toHaveBeenCalled();
});
