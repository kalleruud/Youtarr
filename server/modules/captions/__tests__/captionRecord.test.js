const { describeCaptionRecord } = require('../captionRecord');
const { uploaded, automatic, info } = require('./fixtures');

const HASH = 'a'.repeat(64);

test('records the source from the URL yt-dlp fetched and the original hash', () => {
  const metadata = info({ subtitles: { en: uploaded('en') }, automaticCaptions: { en: automatic('en') } });
  const record = describeCaptionRecord({
    fileName: 'Video [abcdefghijk].en.srt',
    youtubeId: 'abcdefghijk',
    info: metadata,
    state: { id: 'abcdefghijk', requested_subtitles: { en: automatic('en')[0] } },
    result: { status: 'published', backupPath: `/jobs/caption-originals/${HASH}.srt`, normalizerVersion: 2 },
  });
  expect(record).toEqual({ code: 'en', source: 'automatic', normalization: 'published', sourceSha256: HASH, normalizerVersion: 2 });
});

test('a skipped caption keeps no source hash', () => {
  const record = describeCaptionRecord({
    fileName: 'Video [abcdefghijk].en-GB.srt', youtubeId: 'abcdefghijk',
    info: info({ subtitles: { 'en-GB': uploaded('en-GB') } }), result: { status: 'skipped' },
  });
  expect(record).toMatchObject({ code: 'en-GB', source: 'uploaded', sourceSha256: null });
});
