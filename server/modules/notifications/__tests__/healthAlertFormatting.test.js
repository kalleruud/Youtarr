/* eslint-env jest */

const { buildDownloadPauseContent } = require('../utils');
const {
  plainFormatter,
  discordFormatter,
  slackMarkdownFormatter,
  telegramFormatter,
  emailFormatter
} = require('../formatters');

const alert = {
  title: '⚠️ Youtarr needs attention',
  summary: 'Some processing steps after download did not finish.',
  lines: ['library - Application failure - abcdefghijk: Jellyfin request failed <b>'],
  footer: 'Open Settings > Acquisition Health.'
};

describe('formatHealthAlertMessage', () => {
  test.each([
    ['plain', plainFormatter],
    ['slack', slackMarkdownFormatter],
    ['telegram', telegramFormatter],
    ['email', emailFormatter]
  ])('%s formatter includes every line and the footer', (_name, formatter) => {
    const { title, body } = formatter.formatHealthAlertMessage(alert);
    expect([title, body.includes('abcdefghijk'), body.includes('Acquisition Health')]).toEqual([alert.title, true, true]);
  });

  test.each([
    ['telegram', telegramFormatter],
    ['email', emailFormatter]
  ])('%s formatter escapes HTML in lines', (_name, formatter) => {
    expect(formatter.formatHealthAlertMessage(alert).body).not.toContain('failed <b>');
  });

  test('discord formatter puts lines in a field', () => {
    const payload = discordFormatter.formatHealthAlertMessage(alert);
    expect(payload.embeds[0].fields.map((f) => f.name)).toEqual(['Affected', 'What to do']);
  });
});

describe('download pause resume hints', () => {
  test('the paused footer says how to resume', () => {
    const content = buildDownloadPauseContent({
      paused: true,
      reasons: [{ type: 'tempFreeSpace', text: 'only 1 GB is free in the temporary download folder', resumeHint: 'Free up at least 4.0 GB where downloads are staged.' }]
    });
    expect(content.footer).toContain('To resume: Free up at least 4.0 GB');
  });

  test('without hints the generic advice remains', () => {
    expect(buildDownloadPauseContent({ paused: true, reasons: [{ type: 'usage', text: 'x' }] }).footer).toContain('Free up space, remove videos');
  });
});
