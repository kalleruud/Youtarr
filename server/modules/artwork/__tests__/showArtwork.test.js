const { isSuitablePortrait, resolveShowArtwork } = require('../showArtwork');

const channel = { channelId: 'UC1', title: 'Pawel' };
const square = { path: '/img/channelavatar-UC1.jpg', sha256: 'up', dimensions: { width: 900, height: 900 } };
const portrait = { path: '/img/channelavatar-UC1.jpg', sha256: 'up', dimensions: { width: 1000, height: 1500 } };
const manual = { path: '/img/channelposter-manual-UC1.jpg', sha256: 'man' };

describe('isSuitablePortrait', () => {
  test('accepts a 2:3 image', () => {
    expect(isSuitablePortrait({ width: 680, height: 1000 })).toBe(true);
  });

  test('rejects a square avatar', () => {
    expect(isSuitablePortrait({ width: 360, height: 360 })).toBe(false);
  });

  test('rejects a 16:9 thumbnail', () => {
    expect(isSuitablePortrait({ width: 1280, height: 720 })).toBe(false);
  });

  test('rejects a portrait image too small to use', () => {
    expect(isSuitablePortrait({ width: 200, height: 300 })).toBe(false);
  });
});

describe('resolveShowArtwork', () => {
  test('uses the selected manual poster before anything else', () => {
    const decision = resolveShowArtwork(channel, { source: 'manual', protected: true }, { manual, upstream: portrait });
    expect(decision).toMatchObject({ action: 'copy', origin: 'manual', sourcePath: manual.path });
  });

  test('keeps a pinned automatic poster when one exists', () => {
    const decision = resolveShowArtwork(channel, { source: 'auto', protected: true, current: { exists: true, origin: 'generated' } }, { upstream: portrait });
    expect(decision.action).toBe('keep');
  });

  test('copies an upstream image that is already poster-shaped', () => {
    const decision = resolveShowArtwork(channel, { source: 'auto' }, { upstream: portrait });
    expect(decision).toMatchObject({ action: 'copy', origin: 'upstream' });
  });

  test('composes a square avatar instead of stretching it', () => {
    const decision = resolveShowArtwork(channel, { source: 'auto' }, { upstream: square });
    expect(decision).toMatchObject({ action: 'compose', origin: 'generated', sourcePath: square.path, title: 'Pawel' });
  });

  test('composes from identity alone when there is no image', () => {
    const decision = resolveShowArtwork(channel, { source: 'auto' }, {});
    expect(decision).toMatchObject({ action: 'compose', sourcePath: null, channelId: 'UC1' });
  });

  test('falls back to automatic artwork when the selected upload is gone', () => {
    const decision = resolveShowArtwork(channel, { source: 'manual' }, { upstream: square });
    expect(decision.origin).toBe('generated');
  });
});
