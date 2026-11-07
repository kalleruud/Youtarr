const { classifyAcquisitionFailure, classifyFilesystemError, classifyCaptionResults } = require('../outcomeClassifier');

describe('classifyAcquisitionFailure', () => {
  test.each([
    [{ error: 'ERROR: [youtube] abc: Video unavailable. This video is private' }, 'source-unavailable', false],
    [{ error: 'ERROR: Join this channel to get access to members-only content' }, 'source-unavailable', false],
    [{ error: 'ERROR: Premieres in 3 hours' }, 'source-unavailable', true],
    [{ error: 'x', diagnosisKey: 'bot-check-cookies-enabled' }, 'source-unavailable', true],
    [{ error: 'x', diagnosisKey: 'temp-out-of-space' }, 'storage-limit', true],
    [{ error: 'OSError: [Errno 13] Permission denied: /data/x' }, 'permission-path', true],
    [{ error: 'Something odd happened' }, 'application-failure', true],
  ])('%j is %s (retryable %s)', (video, category, retryable) => {
    expect(classifyAcquisitionFailure(video)).toMatchObject({ status: 'failed', category, retryable });
  });

  test('a failure handed to the automatic retry is pending, not failed', () => {
    expect(classifyAcquisitionFailure({ error: 'HTTP Error 403', autoRetryQueued: true }).status).toBe('pending');
  });

  test('an unexplained failure in a terminated job is reported as abandoned', () => {
    expect(classifyAcquisitionFailure({ error: '' }, { wasTerminated: true }).category).toBe('abandoned');
  });
});

describe('classifyFilesystemError', () => {
  test.each([
    [{ code: 'EACCES' }, 'permission-path'],
    [{ code: 'EROFS' }, 'permission-path'],
    [{ code: 'ENOSPC' }, 'storage-limit'],
    [{ message: 'boom' }, 'application-failure'],
  ])('%j is %s', (err, category) => {
    expect(classifyFilesystemError(err).category).toBe(category);
  });
});

describe('classifyCaptionResults', () => {
  test('no outcome when captions were not requested and none exist', () => {
    expect(classifyCaptionResults({ results: [], subtitlesRequested: false })).toBeNull();
  });

  test('requested captions that YouTube did not offer are "no captions", not a failure', () => {
    expect(classifyCaptionResults({ results: [], subtitlesRequested: true })).toMatchObject({ status: 'skipped', category: 'no-captions' });
  });

  test('a normalized track reports how many repeated lines it removed', () => {
    const outcome = classifyCaptionResults({ results: [{ file: 'a.en.srt', result: { status: 'published', diagnostics: { transitionsRemoved: 237 } } }] });
    expect(outcome).toMatchObject({ status: 'ok', reasonCode: 'caption-normalized', message: expect.stringContaining('237 repeated caption lines') });
  });

  test('a skipped normalization explains that repeated lines may remain (the repeating-caption case)', () => {
    const outcome = classifyCaptionResults({ results: [{ file: 'a.en.srt', result: { status: 'skipped', reason: 'SponsorBlock removal without accurate cuts; final caption timing cannot be verified' } }] });
    expect(outcome).toMatchObject({ status: 'warning', category: 'policy-excluded', message: expect.stringContaining('may repeat lines: SponsorBlock removal') });
  });

  test('a failed normalization is a warning, never a failure', () => {
    const outcome = classifyCaptionResults({ results: [{ file: 'a.en.srt', result: { status: 'warning', reason: 'caption normalization or publication failed', error: new Error('bad utf8') } }] });
    expect(outcome).toMatchObject({ status: 'warning', category: 'application-failure', message: expect.stringContaining('bad utf8') });
  });
});
