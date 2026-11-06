const { resolveCaptionProvenance } = require('../captionProvenance');

const fileName = 'Example [abc123].en.srt';
const resolve = info => resolveCaptionProvenance({ fileName, youtubeId: 'abc123', info });

test('recognizes a code present only in automatic captions', () => {
  expect(resolve({ subtitles: {}, automatic_captions: { en: [] } })).toBe('automatic');
});

test('recognizes a code present only in uploaded captions', () => {
  expect(resolve({ subtitles: { en: [] }, automatic_captions: {} })).toBe('human');
});

test('does not guess when both sources contain the code or metadata is incomplete', () => {
  expect(resolve({ subtitles: { en: [] }, automatic_captions: { en: [] } })).toBe('unknown');
  expect(resolve({ subtitles: {} })).toBe('unknown');
});

test('does not classify another video or an absent language', () => {
  const info = { subtitles: {}, automatic_captions: { en: [] } };
  expect(resolveCaptionProvenance({ fileName, youtubeId: 'other', info })).toBe('unknown');
  expect(resolve({ subtitles: {}, automatic_captions: { fr: [] } })).toBe('unknown');
});
