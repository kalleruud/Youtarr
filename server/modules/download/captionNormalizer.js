const NORMALIZER_VERSION = 2;
const MAX_TRANSITION_MS = 20;

function parseTime(value, format) {
  const pattern = format === 'vtt'
    ? /^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)\.(\d{3})$/
    : /^(\d{2,}):([0-5]\d):([0-5]\d),(\d{3})$/;
  const match = pattern.exec(value);
  if (!match) throw new Error('Invalid caption timestamp');
  const time = ((Number(match[1] || 0) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000 + Number(match[4]);
  if (!Number.isSafeInteger(time)) throw new Error('Invalid caption timestamp');
  return time;
}

function parseTextTrack(rawTrack, format) {
  if (typeof rawTrack !== 'string' || !rawTrack.trim()) throw new Error('Empty caption track');
  const lines = rawTrack.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  if (format === 'vtt' && !/^WEBVTT(?:[ \t].*)?$/.test(lines.shift())) throw new Error('Invalid VTT header');
  const cues = [];
  let i = 0;
  while (i < lines.length) {
    while (i < lines.length && !lines[i].trim()) i++;
    if (i === lines.length) break;
    if (format === 'srt') {
      if (!/^\d+$/.test(lines[i++].trim())) throw new Error('Invalid SRT cue index');
    } else if (!lines[i].includes('-->')) {
      if (i + 1 >= lines.length || !lines[i + 1].includes('-->')) throw new Error('Unsupported VTT block');
      i++;
    }
    const timing = /^(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/.exec(lines[i++] || '');
    if (!timing) throw new Error('Invalid caption timing');
    const start = parseTime(timing[1], format);
    const end = parseTime(timing[2], format);
    const textLines = [];
    while (i < lines.length) {
      if (!lines[i].trim()) {
        let next = i + 1;
        while (next < lines.length && !lines[next].trim()) next++;
        if (next === lines.length || (format === 'srt' && /^\d+$/.test(lines[next].trim()) && /-->/.test(lines[next + 1] || '')) ||
            (format === 'vtt' && (/-->/.test(lines[next]) || /-->/.test(lines[next + 1] || '')))) {
          i = next;
          break;
        }
        // A blank line ends an SRT cue in strict parsers, so blank or
        // whitespace-only lines inside a cue are dropped rather than kept.
        i = next;
        continue;
      }
      textLines.push(lines[i++]);
    }
    while (textLines.length && !textLines[textLines.length - 1].trim()) textLines.pop();
    const text = textLines.join('\n');
    if (format === 'vtt' && /<[^>]*>/.test(text)) throw new Error('Unsupported VTT markup');
    cues.push({ start, end, text });
  }
  return cues;
}

function parseJson3(rawTrack) {
  let data;
  try { data = typeof rawTrack === 'string' ? JSON.parse(rawTrack) : rawTrack; } catch { throw new Error('Invalid JSON3'); }
  if (!data || !Array.isArray(data.events)) throw new Error('Invalid JSON3 events');
  return data.events.filter(event => Array.isArray(event.segs) && event.segs.length).map(event => {
    if (event.segs.some(segment => typeof segment.utf8 !== 'string' || (segment.tOffsetMs != null && segment.tOffsetMs !== 0))) {
      throw new Error('Unsupported JSON3 segment timing');
    }
    return { start: event.tStartMs, end: event.tStartMs + event.dDurationMs, text: event.segs.map(segment => segment.utf8).join('').trim() };
  });
}

function validateCues(cues) {
  if (!cues.length) throw new Error('Empty caption track');
  let previousStart = -1;
  for (const cue of cues) {
    if (!Number.isSafeInteger(cue.start) || !Number.isSafeInteger(cue.end) || cue.start < previousStart ||
        cue.start < 0 || cue.end <= cue.start || typeof cue.text !== 'string' || !cue.text.trim()) throw new Error('Invalid caption cue');
    previousStart = cue.start;
  }
}

function applyTimingMap(cues, timingMap) {
  if (!Array.isArray(timingMap) || !timingMap.length) throw new Error('Invalid timing map');
  let lastEnd = 0;
  for (const segment of timingMap) {
    if (!segment || !Number.isSafeInteger(segment.sourceStart) || !Number.isSafeInteger(segment.sourceEnd) ||
        !Number.isSafeInteger(segment.destStart) || segment.sourceStart < 0 || segment.sourceEnd <= segment.sourceStart ||
        segment.destStart < lastEnd || !Number.isSafeInteger(segment.destStart + segment.sourceEnd - segment.sourceStart)) throw new Error('Invalid timing map');
    lastEnd = segment.destStart + segment.sourceEnd - segment.sourceStart;
  }
  const mapped = [];
  for (const segment of timingMap) {
    for (const cue of cues) {
      const start = Math.max(cue.start, segment.sourceStart);
      const end = Math.min(cue.end, segment.sourceEnd);
      if (start < end) mapped.push({ start: segment.destStart + start - segment.sourceStart, end: segment.destStart + end - segment.sourceStart, text: cue.text });
    }
  }
  return mapped;
}

function normalizeCaptionTrack({ rawTrack, format, provenance, timingMap } = {}) {
  if (!['srt', 'vtt', 'json3'].includes(format)) throw new Error('Unsupported caption format');
  let cues = format === 'json3' ? parseJson3(rawTrack) : parseTextTrack(rawTrack, format);
  validateCues(cues);
  let transitionsRemoved = 0;
  if (provenance === 'automatic') {
    for (let i = 1; i < cues.length - 1; i++) {
      const previous = cues[i - 1];
      const transition = cues[i];
      const next = cues[i + 1];
      const lastLine = previous.text.split('\n').pop();
      const prefix = `${lastLine}\n`;
      const remainder = next.text.startsWith(prefix) ? next.text.slice(prefix.length) : '';
      if (transition.end - transition.start <= MAX_TRANSITION_MS && previous.end === transition.start &&
          transition.end === next.start && transition.text === lastLine && remainder.trim() && remainder !== lastLine) {
        previous.end = transition.end;
        next.text = remainder;
        cues.splice(i, 1);
        transitionsRemoved++;
        i--;
      }
    }
  }
  if (timingMap != null) cues = applyTimingMap(cues, timingMap);
  if (cues.length) validateCues(cues);
  return { cues, diagnostics: { transitionsRemoved }, normalizerVersion: NORMALIZER_VERSION };
}

module.exports = { normalizeCaptionTrack };
