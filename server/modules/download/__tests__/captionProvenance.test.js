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
    info: { duration: 6 }, categories: ['sponsor'], actualDuration: 4.038,
    state: { id: 'abc123', filepath: '/tmp/video.mp4', __real_download: true, duration: 4,
      requested_subtitles: { en: { ext: 'srt', filepath: '/tmp/Video [abc123].en.srt', data: 'source' } },
      sponsorblock_chapters: [{ category: 'sponsor', start_time: 2, end_time: 4 }] },
  };
  test('maps kept source ranges onto the verified final duration', () => {
    expect(resolveCutCaptions(input)).toEqual({ source: 'source', timingMap: [
      { sourceStart: 0, sourceEnd: 2000, destStart: 0 },
      { sourceStart: 4000, sourceEnd: 6038, destStart: 2000 },
    ] });
  });
  const realistic = (chapters, actualDuration, stateDuration) => ({
    ...input, info: { duration: 212 }, actualDuration,
    state: { ...input.state, duration: stateDuration, sponsorblock_chapters: chapters },
  });
  test('accepts a fractional media length against whole-second metadata', () => {
    const result = resolveCutCaptions(realistic([{ category: 'sponsor', start_time: 60, end_time: 90 }], 182.43, 182));
    expect(result.timingMap).toEqual([
      { sourceStart: 0, sourceEnd: 60000, destStart: 0 },
      { sourceStart: 90000, sourceEnd: 212430, destStart: 60000 },
    ]);
  });
  test('accepts an outro cut ending at the whole-second duration', () => {
    const result = resolveCutCaptions(realistic([{ category: 'sponsor', start_time: 200, end_time: 212 }], 200.43, 200));
    expect(result.timingMap).toEqual([
      { sourceStart: 0, sourceEnd: 200000, destStart: 0 },
      { sourceStart: 212000, sourceEnd: 212430, destStart: 200000 },
    ]);
  });
  test('maps a video without matching segments one to one', () => {
    const result = resolveCutCaptions(realistic([{ category: 'intro', start_time: 0, end_time: 5 }], 212.43, 212));
    expect(result.timingMap).toEqual([{ sourceStart: 0, sourceEnd: 212430, destStart: 0 }]);
  });
  test('rejects a cut map several seconds away from the final media length', () => {
    expect(resolveCutCaptions(realistic([{ category: 'sponsor', start_time: 60, end_time: 90 }], 176.4, 182))).toBeNull();
  });
  test.each([
    { state: { ...input.state, duration: 6 } },
    { actualDuration: 6 }, { actualDuration: undefined },
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
      { sourceStart: 4000, sourceEnd: 6038, destStart: 2000 },
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
