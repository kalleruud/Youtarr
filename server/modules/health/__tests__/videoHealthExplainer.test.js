const { explainVideo, policyRevisionOf } = require('../videoHealthExplainer');

const policy = (automatic) => ({ automatic, globalRevision: 1, channelRevision: 2, revision: 0 });

describe('explainVideo', () => {
  test('a video being downloaded is in progress', () => {
    expect(explainVideo({ active: true }).state).toBe('in-progress');
  });

  test('a present video with a skipped caption normalization explains the repeating captions', () => {
    const result = explainVideo({
      video: { youtubeId: 'abcdefghijk' },
      removalState: 'present',
      outcomes: [
        { stage: 'acquisition', status: 'ok', category: 'ok' },
        { stage: 'captions', status: 'warning', category: 'policy-excluded', message: 'published unchanged, so rolling captions may repeat lines', retryable: false, revision: 3 },
      ],
    });
    expect(result).toMatchObject({ state: 'attention', category: 'policy-excluded', stage: 'captions', headline: expect.stringContaining('may repeat lines') });
  });

  test('a present TV episode awaiting Jellyfin is pending a scan, not failed', () => {
    const result = explainVideo({
      video: {}, removalState: 'present',
      outcomes: [{ stage: 'library', status: 'pending', category: 'scan-pending', message: 'not listed yet', retryable: true, revision: 2 }],
    });
    expect(result).toMatchObject({ state: 'pending', category: 'scan-pending', retryable: true });
  });

  test('a present video with every step done is ok', () => {
    expect(explainVideo({ video: {}, removalState: 'present', outcomes: [] }).state).toBe('ok');
  });

  test('a missing file points at the mount', () => {
    expect(explainVideo({ video: {}, removalState: 'missing' }).category).toBe('permission-path');
  });

  test('a recorded download failure explains a never-downloaded video', () => {
    const result = explainVideo({ outcomes: [{ stage: 'acquisition', status: 'failed', category: 'abandoned', message: 'A server restart interrupted this download', retryable: true, revision: 1 }] });
    expect(result).toMatchObject({ category: 'abandoned', retryable: true, revision: 1 });
  });

  test('a video YouTube removed is source-unavailable', () => {
    expect(explainVideo({ listing: { youtube_removed: true } }).category).toBe('source-unavailable');
  });

  test('a stream-policy video is excluded by policy with the resolver explanation', () => {
    const result = explainVideo({
      listing: {},
      policy: policy({ jobAction: null, effectivePolicy: { delivery: 'stream' }, reasons: [{ code: 'capability_unavailable', message: 'Streaming is not available yet.' }] }),
    });
    expect(result).toMatchObject({ category: 'policy-excluded', headline: 'Streaming is not available yet.', policyRevision: '1.2.0' });
  });

  test('an eligible video while downloads are paused names the storage limit and how to resume', () => {
    const result = explainVideo({
      listing: {},
      policy: policy({ jobAction: 'download', reasons: [] }),
      storage: { paused: true, reasons: [{ text: 'only 1 GB is free', resumeHint: 'Free up at least 4 GB.' }] },
    });
    expect(result).toMatchObject({ category: 'storage-limit', nextStep: 'Free up at least 4 GB.' });
  });

  test('an unknown video says so', () => {
    expect(explainVideo({}).state).toBe('unknown');
  });
});

test('policyRevisionOf joins the layer revisions', () => {
  expect(policyRevisionOf({ globalRevision: 3, channelRevision: undefined, revision: 1 })).toBe('3.0.1');
});
