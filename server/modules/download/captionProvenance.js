const { isFileForVideo } = require('../filesystem/pathBuilder');
const path = require('path');

const DURATION_TOLERANCE_MS = 1000;

function resolveCaptionProvenance({ fileName, youtubeId, info }) {
  if (!isFileForVideo(fileName, youtubeId)) return 'unknown';
  const match = /\]\.([A-Za-z0-9-]+)\.srt$/i.exec(fileName);
  if (!match || !info || !info.subtitles || !info.automatic_captions ||
      typeof info.subtitles !== 'object' || typeof info.automatic_captions !== 'object') return 'unknown';
  const code = match[1];
  const uploaded = Object.prototype.hasOwnProperty.call(info.subtitles, code);
  const automatic = Object.prototype.hasOwnProperty.call(info.automatic_captions, code);
  // An exact code present in both sets is deliberately ambiguous: custom
  // yt-dlp options can disable uploaded captions independently.
  if (uploaded && !automatic) return 'human';
  if (automatic && !uploaded) return 'automatic';
  return 'unknown';
}

// Fresh after_move evidence is usable only for a managed, complete download.
// Custom options can change sections, conversions and overwrite semantics.
function resolveCaptionTimeline({ contract, state, videoPath, fileName, youtubeId }) {
  if (contract !== 'managed-caption-v1' || !state || state.id !== youtubeId ||
      state.filepath !== videoPath || state.__real_download !== true) return 'unknown';
  const match = /\]\.([A-Za-z0-9-]+)\.srt$/i.exec(fileName);
  const selected = match && state.requested_subtitles && state.requested_subtitles[match[1]];
  return selected && selected.ext === 'srt' && selected.filepath === path.join(path.dirname(videoPath), fileName) ? 'final' : 'unknown';
}

function resolveCutCaptions({ state, videoPath, fileName, youtubeId, info, categories, actualDuration }) {
  if (!state || state.id !== youtubeId || state.filepath !== videoPath || state.__real_download !== true ||
      !Array.isArray(state.sponsorblock_chapters) || !Array.isArray(categories) || !categories.length ||
      !Number.isFinite(info?.duration) || !Number.isFinite(state.duration) || !Number.isFinite(actualDuration)) return null;
  const match = /\]\.([A-Za-z0-9-]+)\.srt$/i.exec(fileName);
  const sub = match && state.requested_subtitles?.[match[1]];
  if (!sub || sub.ext !== 'srt' || sub.filepath !== path.join(path.dirname(videoPath), fileName) ||
      typeof sub.data !== 'string' || !sub.data.trim()) return null;
  const cuts = [];
  for (const chapter of state.sponsorblock_chapters) {
    if (!chapter || typeof chapter !== 'object') return null;
    if (!categories.includes(chapter.category)) continue;
    if (!Number.isFinite(chapter.start_time) || !Number.isFinite(chapter.end_time)) return null;
    const start = Math.round(chapter.start_time * 1000);
    const end = Math.round(chapter.end_time * 1000);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) return null;
    cuts.push({ start, end });
  }
  cuts.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const cut of cuts) {
    const last = merged[merged.length - 1];
    if (last && cut.start <= last.end) last.end = Math.max(last.end, cut.end);
    else merged.push({ ...cut });
  }
  // yt-dlp's duration is whole seconds while the media is not: SponsorBlock
  // clamps segment ends to it, and ModifyChapters treats lengths within 1 s as
  // the same video (`_duration_mismatch(..., 1)`). The cut positions themselves
  // are exact with accurate cuts, so the source length is taken from the cut
  // file (ffprobe length + removed time) and only has to agree with yt-dlp's
  // duration within that same 1 s; a cut map that does not match the file is
  // off by whole segments and is rejected.
  const duration = Math.round(info.duration * 1000);
  if (!Number.isSafeInteger(duration) || duration <= 0) return null;
  if (merged.some(cut => cut.end > duration + DURATION_TOLERANCE_MS)) return null;
  for (const cut of merged) cut.end = Math.min(cut.end, duration);
  if (merged.some(cut => cut.end <= cut.start)) return null;
  const removed = merged.reduce((sum, cut) => sum + cut.end - cut.start, 0);
  const sourceDuration = Math.round(actualDuration * 1000) + removed;
  if (Math.abs(sourceDuration - duration) > DURATION_TOLERANCE_MS) return null;
  if (Math.abs(Math.round(state.duration * 1000) - (duration - removed)) > DURATION_TOLERANCE_MS) return null;
  const timingMap = [];
  let sourceStart = 0;
  let destStart = 0;
  for (const cut of merged) {
    if (cut.start > sourceStart) {
      timingMap.push({ sourceStart, sourceEnd: cut.start, destStart });
      destStart += cut.start - sourceStart;
    }
    sourceStart = cut.end;
  }
  if (sourceStart < sourceDuration) timingMap.push({ sourceStart, sourceEnd: sourceDuration, destStart });
  return timingMap.length ? { source: sub.data, timingMap } : null;
}

module.exports = { resolveCaptionProvenance, resolveCaptionTimeline, resolveCutCaptions };
