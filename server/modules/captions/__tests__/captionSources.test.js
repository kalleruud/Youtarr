const { classifyCaptionSource, listOfferedTracks } = require('../captionSources');
const { uploaded, automatic, info } = require('./fixtures');

describe('classifyCaptionSource', () => {
  test('a code offered only as uploaded is uploaded', () => {
    expect(classifyCaptionSource({ code: 'en-GB', info: info({ subtitles: { 'en-GB': uploaded('en-GB') } }) })).toBe('uploaded');
  });

  test('the recognized original track is automatic', () => {
    expect(classifyCaptionSource({ code: 'en', info: info({ automaticCaptions: { en: automatic('en') } }) })).toBe('automatic');
  });

  test('en-orig is automatic, not human-authored', () => {
    expect(classifyCaptionSource({ code: 'en-orig', info: info({ automaticCaptions: { 'en-orig': automatic('en-orig') } }) })).toBe('automatic');
  });

  test('a track whose URL carries tlang is a machine translation', () => {
    expect(classifyCaptionSource({ code: 'nb', info: info({ automaticCaptions: { nb: automatic('nb', { from: 'en' }) } }) })).toBe('translated');
  });

  test('a code offered both ways is unknown without the fetched URL', () => {
    const metadata = info({ subtitles: { en: uploaded('en') }, automaticCaptions: { en: automatic('en') } });
    expect(classifyCaptionSource({ code: 'en', info: metadata })).toBe('unknown');
  });

  test('the fetched URL resolves a code offered both ways', () => {
    const metadata = info({ subtitles: { en: uploaded('en') }, automaticCaptions: { en: automatic('en') } });
    expect(classifyCaptionSource({ code: 'en', info: metadata, requestedUrl: uploaded('en')[0].url })).toBe('uploaded');
  });

  test('requested_subtitles in the info dict resolves the source', () => {
    const metadata = info({
      subtitles: { en: uploaded('en') },
      automaticCaptions: { en: automatic('en') },
      requested_subtitles: { en: automatic('en')[0] },
    });
    expect(classifyCaptionSource({ code: 'en', info: metadata })).toBe('automatic');
  });

  test('a code YouTube does not offer is unknown', () => {
    expect(classifyCaptionSource({ code: 'fr', info: info() })).toBe('unknown');
  });
});

describe('listOfferedTracks', () => {
  test('lists regional uploaded and automatic tracks and skips live chat', () => {
    const metadata = info({
      subtitles: { 'zh-Hans': uploaded('zh-Hans'), live_chat: [{ ext: 'json' }] },
      automaticCaptions: { en: automatic('en'), 'pt-PT': automatic('pt-PT', { from: 'en' }) },
    });
    expect(listOfferedTracks(metadata)).toEqual([
      { code: 'zh-Hans', source: 'uploaded' },
      { code: 'en', source: 'automatic' },
      { code: 'pt-PT', source: 'translated' },
    ]);
  });
});
