const fs = require('fs');
const { wrapTitle, colorForIdentity, buildComposeArgs, composePoster, normalizeUpload } = require('../posterComposer');

const baseInput = {
  ffmpegPath: '/usr/bin/ffmpeg',
  sourcePath: '/images/channelavatar-UC1.jpg',
  outputPath: '/images/out.jpg',
  channelId: 'UC1',
  titleFiles: ['/tmp/youtarr-poster-x/title-0.txt'],
  fontPath: '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
};

describe('wrapTitle', () => {
  test('wraps words into short lines', () => {
    expect(wrapTitle('PawelCodeStuff Programming Tutorials')).toEqual(['PawelCodeStuff', 'Programming', 'Tutorials']);
  });

  test('ellipsizes titles longer than three lines', () => {
    const lines = wrapTitle('one two three four five six seven eight nine ten eleven twelve thirteen');
    expect(lines).toHaveLength(3);
  });

  test('marks a truncated title with an ellipsis', () => {
    const lines = wrapTitle('one two three four five six seven eight nine ten eleven twelve thirteen');
    expect(lines[2].endsWith('…')).toBe(true);
  });

  test('drops control characters', () => {
    expect(wrapTitle('A\u0000B\nC')).toEqual(['A B C']);
  });
});

test('derives the same identity colour every time', () => {
  expect(colorForIdentity('UC1')).toBe(colorForIdentity('UC1'));
});

describe('buildComposeArgs', () => {
  test('is deterministic for identical inputs', () => {
    expect(buildComposeArgs(baseInput)).toEqual(buildComposeArgs({ ...baseInput }));
  });

  test('fits the avatar inside the canvas instead of stretching it', () => {
    const filter = buildComposeArgs(baseInput)[buildComposeArgs(baseInput).indexOf('-filter_complex') + 1];
    expect(filter).toContain('scale=640:640:force_original_aspect_ratio=decrease');
  });

  test('writes a bit-exact 2:3 JPEG without metadata', () => {
    const args = buildComposeArgs(baseInput);
    expect(args).toEqual(expect.arrayContaining(['-map_metadata', '-1', '+bitexact']));
  });

  test('reads the title from a file, never from the filtergraph text', () => {
    const args = buildComposeArgs(baseInput);
    expect(args[args.indexOf('-filter_complex') + 1]).toContain('textfile=/tmp/youtarr-poster-x/title-0.txt:expansion=none');
  });

  test('skips the title when a path would need escaping', () => {
    const args = buildComposeArgs({ ...baseInput, fontPath: '/fonts/it\'s.ttf' });
    expect(args[args.indexOf('-filter_complex') + 1]).not.toContain('drawtext');
  });

  test('uses an identity colour canvas without a source image', () => {
    const args = buildComposeArgs({ ...baseInput, sourcePath: null });
    expect(args).toEqual(expect.arrayContaining(['lavfi', `color=c=${colorForIdentity('UC1')}:s=1000x1500`]));
  });
});

describe('composePoster', () => {
  test('runs ffmpeg once and removes its title files', async () => {
    let titleFile;
    const exec = jest.fn((cmd, args, opts, cb) => {
      const filter = args[args.indexOf('-filter_complex') + 1];
      titleFile = /textfile=([^:]+)/.exec(filter)[1];
      cb(null);
    });
    await composePoster({ sourcePath: '/a.jpg', outputPath: '/b.jpg', channelId: 'UC1', title: 'Pawel' }, {
      ffmpegPath: '/usr/bin/ffmpeg', exec, exists: () => true,
    });
    expect(fs.existsSync(titleFile)).toBe(false);
  });

  test('rejects when ffmpeg fails', async () => {
    const exec = jest.fn((cmd, args, opts, cb) => cb(new Error('ffmpeg failed')));
    await expect(composePoster({ sourcePath: null, outputPath: '/b.jpg', channelId: 'UC1', title: '' }, {
      ffmpegPath: '/usr/bin/ffmpeg', exec,
    })).rejects.toThrow('ffmpeg failed');
  });
});

test('normalizeUpload only scales down and keeps the aspect ratio', async () => {
  const exec = jest.fn((cmd, args, opts, cb) => cb(null));
  await normalizeUpload({ inputPath: '/in', outputPath: '/out.jpg' }, { ffmpegPath: '/usr/bin/ffmpeg', exec });
  const args = exec.mock.calls[0][1];
  expect(args[args.indexOf('-vf') + 1]).toContain('scale=\'min(1000,iw)\':\'min(1500,ih)\':force_original_aspect_ratio=decrease');
});
