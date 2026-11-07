const { selectRepresentation } = require('../selectRepresentation');

const local = (extra = {}) => ({ id: 1, kind: 'local', state: 'verified', usable: true, ...extra });
const strm = (extra = {}) => ({ id: 2, kind: 'strm', state: 'published', usable: true, ...extra });
const recording = (extra = {}) => ({ id: 3, kind: 'recording', variant: 'r1', state: 'partial', usable: true, ...extra });
const streaming = { capable: true, sourceAvailable: true };
const noStreaming = { capable: false, sourceAvailable: true };
const sourceGone = { capable: true, sourceAvailable: false };

describe('selectRepresentation', () => {
  test('prefers a usable local copy over the stream', () => {
    expect(selectRepresentation({ candidates: [strm(), local()], upstream: streaming }).representation.id).toBe(1);
  });

  test('plays the local copy when YouTube no longer has the video', () => {
    expect(selectRepresentation({ candidates: [local()], upstream: sourceGone }).mode).toBe('local');
  });

  test('streams when the local copy is missing on disk', () => {
    const result = selectRepresentation({ candidates: [local({ usable: false }), strm()], upstream: streaming });
    expect([result.mode, result.representation.id]).toEqual(['upstream', 2]);
  });

  test('explains a recorded local copy that is missing', () => {
    const result = selectRepresentation({ candidates: [local({ usable: false })], upstream: streaming });
    expect(result.reasons.map(r => r.code)).toContain('local_copy_missing');
  });

  test('does not report an evicted copy as missing', () => {
    const result = selectRepresentation({ candidates: [local({ state: 'evicted', usable: false })], upstream: streaming });
    expect(result.reasons).toEqual([]);
  });

  test('prefers a downloaded copy over a complete recording', () => {
    const result = selectRepresentation({ candidates: [recording({ state: 'verified' }), local()], upstream: noStreaming });
    expect(result.representation.kind).toBe('local');
  });

  test('prefers the stream over a partial recording', () => {
    expect(selectRepresentation({ candidates: [recording()], upstream: streaming }).mode).toBe('upstream');
  });

  test('falls back to a partial recording, flagged partial', () => {
    const result = selectRepresentation({ candidates: [recording()], upstream: noStreaming });
    expect([result.mode, result.partial]).toEqual(['local', true]);
  });

  test('honors an explicitly selected partial recording over a complete copy', () => {
    const result = selectRepresentation({ candidates: [local(), recording()], selectedId: 3, upstream: streaming });
    expect([result.representation.id, result.explicit, result.partial]).toEqual([3, true, true]);
  });

  test('honors an explicitly selected stream over a local copy', () => {
    const result = selectRepresentation({ candidates: [local(), strm()], selectedId: 2, upstream: streaming });
    expect([result.mode, result.explicit]).toEqual(['upstream', true]);
  });

  test('ignores a selection that is no longer usable', () => {
    const result = selectRepresentation({ candidates: [local(), recording({ usable: false })], selectedId: 3, upstream: streaming });
    expect([result.representation.id, result.reasons[0].code]).toEqual([1, 'selected_unavailable']);
  });

  test('is unavailable without a local copy or streaming', () => {
    const result = selectRepresentation({ candidates: [], upstream: noStreaming });
    expect([result.mode, result.reasons.map(r => r.code)]).toEqual(['unavailable', ['stream_unavailable']]);
  });

  test('is unavailable when the source is gone and no local copy is left', () => {
    const result = selectRepresentation({ candidates: [strm()], upstream: sourceGone });
    expect(result.reasons.map(r => r.code)).toEqual(['source_removed']);
  });
});
