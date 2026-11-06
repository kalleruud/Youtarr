const { detectImageType, probeImage } = require('../imageInspector');

describe('detectImageType', () => {
  test('recognizes JPEG by content', () => {
    expect(detectImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toBe('jpeg');
  });

  test('recognizes PNG by content', () => {
    expect(detectImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]))).toBe('png');
  });

  test('recognizes WebP by content', () => {
    expect(detectImageType(Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ', 'latin1'))).toBe('webp');
  });

  test('rejects text named like an image', () => {
    expect(detectImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
  });
});

describe('probeImage', () => {
  test('parses ffprobe width and height', async () => {
    const exec = jest.fn((cmd, args, opts, cb) => cb(null, '1280,720\n'));
    await expect(probeImage('/x.jpg', { exec })).resolves.toEqual({ width: 1280, height: 720 });
  });

  test('resolves null when ffprobe fails', async () => {
    const exec = jest.fn((cmd, args, opts, cb) => cb(new Error('Invalid data')));
    await expect(probeImage('/x.jpg', { exec })).resolves.toBeNull();
  });
});
