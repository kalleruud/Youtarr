// Synthetic yt-dlp metadata shapes for caption tests (no real video data).
const BASE = 'https://www.youtube.com/api/timedtext?v=abcdefghijk';

function uploaded(code) {
  return [{ ext: 'vtt', url: `${BASE}&lang=${code}&fmt=vtt`, name: code }];
}

function automatic(code, { from } = {}) {
  const url = from ? `${BASE}&lang=${from}&kind=asr&fmt=vtt&tlang=${code}` : `${BASE}&lang=${code}&kind=asr&fmt=vtt`;
  return [{ ext: 'vtt', url, name: code }];
}

function info({ subtitles = {}, automaticCaptions = {}, ...rest } = {}) {
  return { id: 'abcdefghijk', duration: 120, subtitles, automatic_captions: automaticCaptions, ...rest };
}

const SRT = '1\n00:00:01,000 --> 00:00:02,000\nHello there\n\n2\n00:00:03,000 --> 00:00:04,000\nGeneral greeting\n';

module.exports = { uploaded, automatic, info, SRT };
