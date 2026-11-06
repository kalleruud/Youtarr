const { normalizeCaptionTrack } = require('../captionNormalizer');

const rolling = `1
00:00:00,000 --> 00:00:01,000
Hello 世界

2
00:00:01,000 --> 00:00:01,010
Hello 世界

3
00:00:01,010 --> 00:00:02,000
Hello 世界
Next phrase!
`;

const normalize = (rawTrack, provenance = 'automatic') => normalizeCaptionTrack({ rawTrack, format: 'srt', provenance });

test('removes an evidenced rolling transition and preserves Unicode', () => {
  expect(normalize(rolling).cues).toEqual([
    { start: 0, end: 1010, text: 'Hello 世界' },
    { start: 1010, end: 2000, text: 'Next phrase!' },
  ]);
});

test('preserves human-authored captions', () => {
  expect(normalize(rolling, 'human').cues).toHaveLength(3);
});

test('preserves repeated speech without a transition pattern', () => {
  const repeated = '1\n00:00:00,000 --> 00:00:01,000\nYes!\n\n2\n00:00:01,000 --> 00:00:02,000\nYes!';
  expect(normalize(repeated).cues.map(cue => cue.text)).toEqual(['Yes!', 'Yes!']);
});

test('rejects malformed input and unsupported timing maps', () => {
  expect(() => normalize('1\n00:00:02,000 --> 00:00:01,000\nHello')).toThrow();
  expect(() => normalizeCaptionTrack({ rawTrack: rolling, format: 'srt', timingMap: [] })).toThrow();
});

test('is deterministic and leaves normalized cues unchanged on another pass', () => {
  const first = normalize(rolling);
  expect(normalize(rolling)).toEqual(first);
  const serialized = '1\n00:00:00,000 --> 00:00:01,010\nHello 世界\n\n2\n00:00:01,010 --> 00:00:02,000\nNext phrase!';
  expect(normalize(serialized).cues).toEqual(first.cues);
});

test('preserves ambiguous tracks and intentional gaps', () => {
  const ambiguous = rolling.replace('00:00:01,010 --> 00:00:02,000', '00:00:01,020 --> 00:00:02,000');
  expect(normalize(ambiguous).cues).toHaveLength(3);
  expect(normalize(rolling, 'unknown').cues).toHaveLength(3);
});


test.each([
  [1710, 1720, 3470, 3480, 5430, 5440],
  [1750, 1760, 3390, 3400, 5390, 5400],
])('normalizes successive observed transition shapes %#', (...times) => {
  const stamp = ms => `00:00:${String(Math.floor(ms / 1000)).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
  const [a, b, c, d, e, f] = times;
  const raw = `1\n${stamp(0)} --> ${stamp(a)}\n\nAlpha 世界\n\n2\n${stamp(a)} --> ${stamp(b)}\nAlpha 世界\n \n\n3\n${stamp(b)} --> ${stamp(c)}\nAlpha 世界\nBeta!\n\n4\n${stamp(c)} --> ${stamp(d)}\nBeta!\n \n\n5\n${stamp(d)} --> ${stamp(e)}\nBeta!\nGamma.\n\n6\n${stamp(e)} --> ${stamp(f)}\nGamma.\n \n\n7\n${stamp(f)} --> ${stamp(6000)}\nGamma.\nDelta.`;
  const result = normalize(raw);
  expect(result.cues.map(cue => cue.text)).toEqual(['Alpha 世界', 'Beta!', 'Gamma.', 'Delta.']);
  expect(result.cues.map(cue => [cue.start, cue.end])).toEqual([[0, b], [b, d], [d, f], [f, 6000]]);
});

test('does not remove a repeated line in an ambiguous transition', () => {
  const input = rolling.replace('Next phrase!', 'Hello 世界');
  expect(normalize(input).cues).toHaveLength(3);
});

test('parses plain timed VTT and JSON3', () => {
  const vtt = 'WEBVTT\n\n00:00.000 --> 00:01.000\nこんにちは\n\n00:01.500 --> 00:02.000\n世界';
  const json = JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'こんにちは' }] }, { tStartMs: 1500, dDurationMs: 500, segs: [{ utf8: '世界' }] }] });
  const expected = [{ start: 0, end: 1000, text: 'こんにちは' }, { start: 1500, end: 2000, text: '世界' }];
  expect(normalizeCaptionTrack({ rawTrack: vtt, format: 'vtt' }).cues).toEqual(expected);
  expect(normalizeCaptionTrack({ rawTrack: json, format: 'json3' }).cues).toEqual(expected);
});

test('rejects unsupported timed markup and JSON3 segment offsets', () => {
  expect(() => normalizeCaptionTrack({ rawTrack: 'WEBVTT\n\n00:00.000 --> 00:01.000\n<00:00.500>word', format: 'vtt' })).toThrow();
  expect(() => normalizeCaptionTrack({ rawTrack: { events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'word', tOffsetMs: 100 }] }] }, format: 'json3' })).toThrow();
});

test('maps cuts, clipped cues and repeated source intervals onto the final timeline', () => {
  const input = '1\n00:00:00,200 --> 00:00:00,600\none\n\n2\n00:00:01,900 --> 00:00:02,100\nedge\n\n3\n00:00:03,000 --> 00:00:03,500\nremoved\n\n4\n00:00:04,200 --> 00:00:04,600\ntwo';
  const timingMap = [{ sourceStart: 0, sourceEnd: 2000, destStart: 0 }, { sourceStart: 4000, sourceEnd: 6000, destStart: 2000 }, { sourceStart: 0, sourceEnd: 2000, destStart: 4000 }];
  expect(normalizeCaptionTrack({ rawTrack: input, format: 'srt', timingMap }).cues).toEqual([
    { start: 200, end: 600, text: 'one' }, { start: 1900, end: 2000, text: 'edge' },
    { start: 2200, end: 2600, text: 'two' }, { start: 4200, end: 4600, text: 'one' }, { start: 5900, end: 6000, text: 'edge' },
  ]);
});

test('preserves speaker changes, multiline captions and standalone short cues', () => {
  const input = '1\n00:00:00,000 --> 00:00:01,000\n- Alice: Hello.\n- Bob: Hi.\n\n2\n00:00:01,000 --> 00:00:01,010\nOh!\n\n3\n00:00:01,010 --> 00:00:02,000\n- Alice: Again.\n- Bob: Yes.';
  expect(normalize(input).cues.map(cue => cue.text)).toEqual(['- Alice: Hello.\n- Bob: Hi.', 'Oh!', '- Alice: Again.\n- Bob: Yes.']);
});

test('rejects overlapping destination segments in a timing map', () => {
  const timingMap = [{ sourceStart: 0, sourceEnd: 1000, destStart: 0 }, { sourceStart: 0, sourceEnd: 1000, destStart: 500 }];
  expect(() => normalizeCaptionTrack({ rawTrack: rolling, format: 'srt', timingMap })).toThrow('Invalid timing map');
});

test('drops blank and whitespace-only lines inside a cue', () => {
  const input = '1\n00:00:00,000 --> 00:00:01,000\nFirst\n \t\nSecond\n\n2\n00:00:01,000 --> 00:00:02,000\nThird';
  expect(normalize(input).cues.map(cue => cue.text)).toEqual(['First\nSecond', 'Third']);
});
