const { isFileForVideo } = require('../filesystem/pathBuilder');

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

module.exports = { resolveCaptionProvenance };
