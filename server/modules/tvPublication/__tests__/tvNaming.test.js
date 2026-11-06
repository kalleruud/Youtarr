/* eslint-env jest */
const {
  sanitizeSegment,
  truncateUtf8,
  buildShowFolderName,
  showNameFromFolder,
  buildEpisodeStem,
  formatEpisodeCode,
  isYoutubeIdentity,
  EPISODE_TITLE_MAX_BYTES,
} = require('../tvNaming');
const { isFileForVideo } = require('../../filesystem');

describe('tvNaming', () => {
  test('builds the issue example episode stem with a fixed YouTube-ID suffix', () => {
    expect(buildEpisodeStem({ showName: 'Channel', season: 2026, episode: 1, title: 'Title', youtubeId: 'abc123DEF_-' }))
      .toBe('Channel - S2026E001 - Title [abc123DEF_-]');
  });

  test('pads episode numbers to three digits and keeps longer numbers whole', () => {
    expect([formatEpisodeCode(2026, 7), formatEpisodeCode(2026, 1234)]).toEqual(['S2026E007', 'S2026E1234']);
  });

  test('show folders carry the channel ID and round-trip their show name', () => {
    const folder = buildShowFolderName('My: Channel', 'UCabc');
    expect([folder, showNameFromFolder(folder, 'UCabc'), showNameFromFolder(folder, 'UCother')])
      .toEqual(['My# Channel [UCabc]', 'My# Channel', null]);
  });

  test('replaces separators, reserved characters and control codes', () => {
    expect(sanitizeSegment('a/b\\c<d>e\n\tf?*', 100)).toBe('a#b#c#d#e f##');
  });

  test('never yields a hidden (dot-leading) or empty segment', () => {
    expect([sanitizeSegment('...secret', 50), sanitizeSegment('   ', 50)]).toEqual(['secret', 'Untitled']);
  });

  test('truncates long titles by UTF-8 bytes without splitting characters', () => {
    const title = '日本語'.repeat(60);
    const segment = sanitizeSegment(title, EPISODE_TITLE_MAX_BYTES);
    expect(Buffer.byteLength(segment) <= EPISODE_TITLE_MAX_BYTES && title.startsWith(segment)).toBe(true);
  });

  test('truncateUtf8 leaves short strings unchanged', () => {
    expect(truncateUtf8('abc', 10)).toBe('abc');
  });

  test('every published sidecar name still belongs to its video for rescan and delete', () => {
    const stem = buildEpisodeStem({ showName: 'Show', season: 2024, episode: 3, title: 'Talk [otherVid01]', youtubeId: 'vid12345678' });
    const names = [`${stem}.mp4`, `${stem}.nfo`, `${stem}.en.srt`, `${stem}-thumb.jpg`];
    expect(names.every((name) => isFileForVideo(name, 'vid12345678') && !isFileForVideo(name, 'otherVid01'))).toBe(true);
  });

  test('accepts YouTube identities and rejects path-like values', () => {
    expect([isYoutubeIdentity('UC_x-1'), isYoutubeIdentity('../x'), isYoutubeIdentity('a b')]).toEqual([true, false, false]);
  });
});
