/* eslint-env jest */
jest.mock('../../../logger');
const { planPublication, TvPublicationError } = require('../tvPlanner');

const video = {
  youtubeId: 'vid12345678',
  channelId: 'UCchannel01',
  title: 'Episode <One> & "more"',
  showTitle: 'Show & Co',
  showPlot: 'About the show',
  description: 'Episode plot',
  durationSeconds: 125,
  genres: ['Education'],
  tags: ['tag'],
  rating: null,
};
const assignment = { season: 2026, episode: 4, publishedAt: '2026-03-02T00:00:00.000Z', status: 'assigned' };
const assets = {
  media: '/tmp/dl/Show - Episode [vid12345678].mp4',
  subtitles: [
    { path: '/tmp/dl/Show - Episode [vid12345678].en.srt', language: 'en' },
    { path: '/tmp/dl/Show - Episode [vid12345678].nb-NO.srt', language: 'nb-NO' },
    { path: '/tmp/dl/x.bad lang.srt', language: 'bad lang' },
  ],
  thumbnail: '/tmp/dl/Show - Episode [vid12345678].jpg',
};
const layout = { parentDir: '/library' };
const now = new Date('2026-11-06T10:00:00Z');

function plan(overrides = {}) {
  return planPublication({ video, assignment, assets, layout, now, ...overrides });
}

describe('planPublication', () => {
  test('places the episode in its show and year-season folder', () => {
    expect(plan().media.target)
      .toBe('/library/Show & Co [UCchannel01]/Season 2026/Show & Co - S2026E004 - Episode #One# & #more# [vid12345678].mp4');
  });

  test('names language-tagged subtitles and the thumbnail after the episode media stem', () => {
    const { stem, sidecars } = plan();
    expect(sidecars.map((s) => s.target.split('/').pop())).toEqual([
      `${stem}.en.srt`, `${stem}.nb-NO.srt`, `${stem}-thumb.jpg`,
    ]);
  });

  test('writes episode NFO with season, episode, aired date and YouTube identity', () => {
    const xml = plan().episodeNfo.content;
    expect([
      '<season>2026</season>', '<episode>4</episode>', '<aired>2026-03-02</aired>',
      '<uniqueid type="youtube" default="true">vid12345678</uniqueid>',
      '<title>Episode &lt;One&gt; &amp; &quot;more&quot;</title>',
    ].every((part) => xml.includes(part))).toBe(true);
  });

  test('writes tvshow.nfo keyed by the channel ID', () => {
    const show = plan().documents.find((d) => d.role === 'show');
    expect([show.target, show.content.includes('<uniqueid type="youtube" default="true">UCchannel01</uniqueid>')])
      .toEqual(['/library/Show & Co [UCchannel01]/tvshow.nfo', true]);
  });

  test('reuses an existing show folder after the channel is renamed', () => {
    const result = plan({ video: { ...video, showTitle: 'Renamed' }, layout: { parentDir: '/library', showFolderName: 'Old Name [UCchannel01]' } });
    expect([result.showDir, result.stem.startsWith('Old Name - S2026E004')]).toEqual(['/library/Old Name [UCchannel01]', true]);
  });

  test('keeps an already-published stem when the video title changes', () => {
    const existingStem = 'Show & Co - S2026E004 - Old title [vid12345678]';
    expect(plan({ video: { ...video, title: 'New title' }, layout: { parentDir: '/library', existingStem } }).stem).toBe(existingStem);
  });

  test('keeps the recorded dateadded on republish', () => {
    expect(plan({ layout: { parentDir: '/library', dateAdded: '2026-01-01 08:00:00' } }).episodeNfo.content)
      .toContain('<dateadded>2026-01-01 08:00:00</dateadded>');
  });

  test('is deterministic for the same input', () => {
    expect(plan()).toEqual(plan());
  });

  test('publishes videos whose date correction is under review with the stored assignment', () => {
    expect(plan({ assignment: { ...assignment, status: 'date-correction-review' } }).season).toBe(2026);
  });

  test.each([
    [{ status: 'date-required', season: null, episode: null }, 'date-required'],
    [{ ...assignment, episode: 0 }, 'date-required'],
  ])('refuses an unnumbered assignment (%o)', (badAssignment, code) => {
    expect(() => plan({ assignment: badAssignment })).toThrow(expect.objectContaining({ code }));
  });

  test('refuses identities that are not YouTube IDs', () => {
    expect(() => plan({ video: { ...video, channelId: '../etc' } })).toThrow(TvPublicationError);
  });

  test('refuses a relative library folder', () => {
    expect(() => plan({ layout: { parentDir: 'library' } })).toThrow(expect.objectContaining({ code: 'invalid-layout' }));
  });
});
