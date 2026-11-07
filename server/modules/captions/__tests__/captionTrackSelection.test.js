const { selectPublishableTracks, assessCoverage, preferencesFromConfig } = require('../captionTrackSelection');

const prefs = (overrides = {}) => preferencesFromConfig({ subtitleLanguage: 'en', ...overrides });

describe('selectPublishableTracks', () => {
  test('keeps every uploaded regional variant, preferred variant first', () => {
    const offered = [{ code: 'en-US', source: 'uploaded' }, { code: 'en-GB', source: 'uploaded' }, { code: 'en', source: 'automatic' }];
    const { tracks } = selectPublishableTracks({ preferences: prefs({ captionPreferredVariants: 'en-GB' }), offered });
    expect(tracks.map((track) => [track.code, track.preferred])).toEqual([['en-GB', true], ['en-US', false]]);
  });

  test('prefers the bare automatic track over -orig', () => {
    const offered = [{ code: 'en-orig', source: 'automatic' }, { code: 'en', source: 'automatic' }];
    expect(selectPublishableTracks({ preferences: prefs(), offered }).tracks.map((track) => track.code)).toEqual(['en']);
  });

  test('uploaded-only reports automatic tracks as not allowed', () => {
    const offered = [{ code: 'en', source: 'automatic' }];
    const result = selectPublishableTracks({ preferences: prefs({ captionSourcePolicy: 'uploaded-only' }), offered });
    expect(result.missing).toEqual([{ language: 'en', reason: 'automatic-not-allowed' }]);
  });

  test('a machine translation alone is translation-only unless allowed', () => {
    const offered = [{ code: 'nb', source: 'translated' }];
    const result = selectPublishableTracks({ preferences: prefs({ subtitleLanguage: 'nb' }), offered });
    expect(result.missing).toEqual([{ language: 'nb', reason: 'translation-only' }]);
  });

  test('an allowed machine translation is selected', () => {
    const offered = [{ code: 'nb', source: 'translated' }];
    const result = selectPublishableTracks({ preferences: prefs({ subtitleLanguage: 'nb', captionAllowTranslated: true }), offered });
    expect(result.tracks).toEqual([{ language: 'nb', code: 'nb', source: 'translated', preferred: true }]);
  });

  test('Norwegian "no" matches tracks published as "nb"', () => {
    const offered = [{ code: 'nb', source: 'uploaded' }];
    expect(selectPublishableTracks({ preferences: prefs({ subtitleLanguage: 'no' }), offered }).tracks[0].code).toBe('nb');
  });

  test('Nynorsk is not taken for Norwegian Bokmal', () => {
    const offered = [{ code: 'nn', source: 'uploaded' }];
    expect(selectPublishableTracks({ preferences: prefs({ subtitleLanguage: 'nb' }), offered }).missing[0].reason).toBe('not-offered');
  });

  test('a verbatim regional code matches only itself', () => {
    const offered = [{ code: 'pt', source: 'uploaded' }, { code: 'pt-BR', source: 'automatic' }];
    expect(selectPublishableTracks({ preferences: prefs({ subtitleLanguage: 'pt-BR' }), offered }).tracks.map((track) => track.code)).toEqual(['pt-BR']);
  });

  test('regex entries are reported as unsupported', () => {
    expect(selectPublishableTracks({ preferences: prefs({ subtitleLanguage: 'en.*' }), offered: [] }).unsupported).toEqual(['en.*']);
  });
});

describe('assessCoverage', () => {
  test('an offered track missing on disk is not-downloaded', () => {
    const result = assessCoverage({ preferences: prefs(), offered: [{ code: 'en', source: 'automatic' }], onDisk: [] });
    expect(result.missing).toEqual([{ language: 'en', reason: 'not-downloaded' }]);
  });

  test('an uploaded track offered over an automatic one on disk is an upgrade', () => {
    const result = assessCoverage({
      preferences: prefs(),
      offered: [{ code: 'en-GB', source: 'uploaded' }],
      onDisk: [{ code: 'en', source: 'automatic' }],
    });
    expect(result.upgrades).toEqual([{ language: 'en', code: 'en-GB', source: 'uploaded' }]);
  });

  test('an existing automatic track does not cover a language under uploaded-only', () => {
    const result = assessCoverage({
      preferences: prefs({ captionSourcePolicy: 'uploaded-only' }),
      offered: [{ code: 'en', source: 'automatic' }],
      onDisk: [{ code: 'en', source: 'automatic' }],
    });
    expect(result.missing).toEqual([{ language: 'en', reason: 'automatic-not-allowed' }]);
  });

  test('an existing machine translation does not cover a language while translations are disabled', () => {
    const result = assessCoverage({
      preferences: prefs({ subtitleLanguage: 'nb' }),
      offered: [{ code: 'nb', source: 'translated' }],
      onDisk: [{ code: 'nb', source: 'translated' }],
    });
    expect(result.missing).toEqual([{ language: 'nb', reason: 'translation-only' }]);
  });

  test('an existing machine translation covers a language while translations are allowed', () => {
    const result = assessCoverage({
      preferences: prefs({ subtitleLanguage: 'nb', captionAllowTranslated: true }),
      offered: [{ code: 'nb', source: 'translated' }],
      onDisk: [{ code: 'nb', source: 'translated' }],
    });
    expect(result.missing).toEqual([]);
  });
});
