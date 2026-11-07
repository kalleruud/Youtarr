const { planEnrichmentWrites } = require('../enrichmentPlan');

const plan = (overrides) => planEnrichmentWrites({
  selected: [{ language: 'en', code: 'en-GB', source: 'uploaded', preferred: true }],
  languages: ['en'],
  fetchedCodes: new Set(['en-GB']),
  onDisk: [],
  currentRevision: 'r1',
  ...overrides,
});

test('installs a fetched track for a missing language', () => {
  expect(plan().installs.map((install) => install.code)).toEqual(['en-GB']);
});

test('an uploaded track retires the automatic track of its language', () => {
  const result = plan({ onDisk: [{ code: 'en', source: 'automatic', protected: false, mediaRevision: 'r1' }] });
  expect(result.retires).toEqual([{ code: 'en', supersededBy: ['en-GB'] }]);
});

test('a protected automatic track is never retired', () => {
  const result = plan({ onDisk: [{ code: 'en', source: 'automatic', protected: true, mediaRevision: 'r1' }] });
  expect(result.retires).toEqual([]);
});

test('a code listed verbatim is never retired', () => {
  const result = plan({ onDisk: [{ code: 'en-orig', source: 'automatic', protected: false, mediaRevision: 'r1' }], verbatimCodes: ['en-orig'] });
  expect(result.retires).toEqual([]);
});

test('a code listed verbatim is never replaced under the same code', () => {
  const result = plan({ onDisk: [{ code: 'en-GB', source: 'automatic', protected: false, mediaRevision: 'r1' }], verbatimCodes: ['en-GB'] });
  expect([result.installs, result.skipped]).toEqual([[], [{ code: 'en-GB', reason: 'listed-verbatim' }]]);
});

test('a retirement names every uploaded track that supersedes it', () => {
  const result = plan({
    selected: [{ language: 'en', code: 'en-GB', source: 'uploaded' }, { language: 'en', code: 'en-US', source: 'uploaded' }],
    fetchedCodes: new Set(['en-GB', 'en-US']),
    onDisk: [{ code: 'en', source: 'automatic', protected: false, mediaRevision: 'r1' }],
  });
  expect(result.retires).toEqual([{ code: 'en', supersededBy: ['en-GB', 'en-US'] }]);
});

test('a protected track with the same code is not replaced', () => {
  const result = plan({ onDisk: [{ code: 'en-GB', source: 'automatic', protected: true, mediaRevision: 'r1' }] });
  expect(result.skipped).toEqual([{ code: 'en-GB', reason: 'protected' }]);
});

test('a track recorded for another media revision is not replaced', () => {
  const result = plan({ onDisk: [{ code: 'en-GB', source: 'automatic', protected: false, mediaRevision: 'r2' }] });
  expect(result.skipped).toEqual([{ code: 'en-GB', reason: 'recorded-for-other-media-revision' }]);
});

test('an automatic track never replaces an uploaded one', () => {
  const result = plan({
    selected: [{ language: 'en', code: 'en', source: 'automatic' }],
    fetchedCodes: new Set(['en']),
    onDisk: [{ code: 'en-US', source: 'uploaded', protected: false, mediaRevision: 'r1' }],
  });
  expect(result.installs).toEqual([]);
});

test('a track that was not fetched is skipped', () => {
  expect(plan({ fetchedCodes: new Set() }).skipped).toEqual([{ code: 'en-GB', reason: 'not-fetched' }]);
});

test('languages outside the check are left alone', () => {
  expect(plan({ languages: ['nb'] }).installs).toEqual([]);
});
