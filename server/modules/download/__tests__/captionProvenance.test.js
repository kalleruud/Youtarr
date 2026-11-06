const { resolveCaptionProvenance } = require('../captionProvenance');

const fileName = 'Example [abc123].en.srt';
const resolve = info => resolveCaptionProvenance({ fileName, youtubeId: 'abc123', info });

test('recognizes a code present only in automatic captions', () => {
  expect(resolve({ subtitles: {}, automatic_captions: { en: [] } })).toBe('automatic');
});

describe('cut timing evidence', () => {
  const { resolveCutCaptions } = require('../captionProvenance');
  const input = {
    videoPath: '/tmp/video.mp4', youtubeId: 'abc123', fileName: 'Video [abc123].en.srt',
    info: { duration: 6 }, categories: ['sponsor'],
    state: { id: 'abc123', filepath: '/tmp/video.mp4', __real_download: true, duration: 4,
      requested_subtitles: { en: { ext: 'srt', filepath: '/tmp/Video [abc123].en.srt', data: 'source' } },
      sponsorblock_chapters: [{ category: 'sponsor', start_time: 2, end_time: 4 }] },
  };
  test('maps kept source ranges onto the verified final duration', () => {
    expect(resolveCutCaptions(input)).toEqual({ source: 'source', timingMap: [
      { sourceStart: 0, sourceEnd: 2000, destStart: 0 },
      { sourceStart: 4000, sourceEnd: 6000, destStart: 2000 },
    ] });
  });
  test.each([
    { state: { ...input.state, duration: 6 } },
    { state: { ...input.state, sponsorblock_chapters: null } },
    { state: { ...input.state, requested_subtitles: { en: { ext: 'srt' } } } },
    { state: { ...input.state, requested_subtitles: { en: { ext: 'srt', filepath: '/tmp/other.srt', data: 'source' } } } },
    { state: { ...input.state, __real_download: false } },
  ])('rejects incomplete or inconsistent evidence %#', extra => {
    expect(resolveCutCaptions({ ...input, ...extra })).toBeNull();
  });
  test('merges overlapping cuts before building the map', () => {
    const state = { ...input.state, sponsorblock_chapters: [
      { category: 'sponsor', start_time: 2, end_time: 3 },
      { category: 'sponsor', start_time: 2.5, end_time: 4 },
    ] };
    expect(resolveCutCaptions({ ...input, state }).timingMap).toEqual([
      { sourceStart: 0, sourceEnd: 2000, destStart: 0 },
      { sourceStart: 4000, sourceEnd: 6000, destStart: 2000 },
    ]);
  });
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


describe('final timeline contract', () => {
  const { resolveCaptionTimeline } = require('../captionProvenance');
  const input = {
    contract: 'managed-caption-v1', videoPath: '/tmp/video.mp4', youtubeId: 'abc123', fileName: 'Video [abc123].en.srt',
    state: { id: 'abc123', filepath: '/tmp/video.mp4', __real_download: true, requested_subtitles: { en: { ext: 'srt', filepath: '/tmp/Video [abc123].en.srt' } } },
  };
  test('accepts converted SRTs at after_move for a fresh managed download', () => {
    expect(resolveCaptionTimeline(input)).toBe('final');
  });
  test.each([
    { contract: 'unknown-caption-timeline' }, { state: undefined },
    { state: { ...input.state, __real_download: false } },
    { state: { ...input.state, filepath: '/different.mp4' } },
    { state: { ...input.state, id: 'other' } },
    { state: { ...input.state, requested_subtitles: { en: { ext: 'vtt' } } } },
  ])('rejects unverified or mismatched evidence %#', extra => {
    expect(resolveCaptionTimeline({ ...input, ...extra })).toBe('unknown');
  });
});
