/* eslint-env jest */
// Identity-checked removal against real files: whatever a concurrent writer
// puts at the path, only the previewed file is ever deleted.
jest.mock('../../../logger');

const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const { isFileForVideo } = require('../../filesystem');
const { fileIdentity, removeIfUnchanged, recoverTombstones, originalName } = require('../localTombstone');

const ID = 'vid12345678';
let dir;
let media;

const contents = async () => {
  const names = (await fs.readdir(dir)).sort();
  return Promise.all(names.map(async name => [name.startsWith('.') ? 'tombstone' : name, await fs.readFile(path.join(dir, name), 'utf8')]));
};

// Runs `before` right before the rename to a tombstone and `after` right
// after it: a download publishing (renaming its file onto the path) at the
// worst possible moments.
function interleaveRename({ before, after }) {
  const realRename = fs.rename;
  return jest.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (before) await before();
    await realRename(from, to);
    if (after) await after();
  });
}

const landDownload = (text) => async () => {
  const staged = path.join(dir, `.staging-${text}`);
  await fs.writeFile(staged, text);
  await fs.move(staged, media, { overwrite: true });
};

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tombstone-'));
  media = path.join(dir, `Show - S2026E001 - First [${ID}].mp4`);
  await fs.writeFile(media, 'previewed');
});

afterEach(async () => {
  jest.restoreAllMocks();
  await fs.remove(dir);
});

describe('removeIfUnchanged', () => {
  test('removes the previewed file', async () => {
    const result = await removeIfUnchanged(media, await fileIdentity(media));
    expect([result.removed, await contents()]).toEqual([true, []]);
  });

  test('keeps a file a download put at the path before the removal', async () => {
    const identity = await fileIdentity(media);
    await landDownload('new download')();
    const result = await removeIfUnchanged(media, identity);
    expect([result, await contents()]).toEqual([{ removed: false, reason: 'changed' }, [[path.basename(media), 'new download']]]);
  });

  test('keeps a file a download put at the path in the instant before the move aside', async () => {
    const identity = await fileIdentity(media);
    interleaveRename({ before: landDownload('new download') });
    const result = await removeIfUnchanged(media, identity);
    expect([result.reason, await contents()]).toEqual(['changed', [[path.basename(media), 'new download']]]);
  });

  test('removes only the previewed file when a download lands right after the move aside', async () => {
    const identity = await fileIdentity(media);
    interleaveRename({ after: landDownload('new download') });
    const result = await removeIfUnchanged(media, identity);
    expect([result.removed, await contents()]).toEqual([true, [[path.basename(media), 'new download']]]);
  });

  test('keeps both files when two downloads land around the move aside', async () => {
    const identity = await fileIdentity(media);
    interleaveRename({ before: landDownload('first download'), after: landDownload('second download') });
    const result = await removeIfUnchanged(media, identity);
    expect([result.reason, await contents()]).toEqual(['conflict', [
      ['tombstone', 'first download'], [path.basename(media), 'second download'],
    ]]);
  });

  test('reports a file that is already gone', async () => {
    const identity = await fileIdentity(media);
    await fs.remove(media);
    expect(await removeIfUnchanged(media, identity)).toEqual({ removed: false, reason: 'missing' });
  });

  test('never removes a file without a recorded identity', async () => {
    const result = await removeIfUnchanged(media, null);
    expect([result.removed, await fs.readFile(media, 'utf8')]).toEqual([false, 'previewed']);
  });
});

describe('tombstone names', () => {
  const name = `.Show - S2026E001 - First [${ID}].mp4 [youtarr-evicting-0123456789abcdef]`;

  test('are not taken for one of the video\'s files', () => {
    expect(isFileForVideo(name, ID)).toBe(false);
  });

  test('do not look like downloaded media to the library scan', () => {
    expect(/\[([^[\]]+)\]\.[a-z0-9]+$/i.test(name)).toBe(false);
  });

  test('keep the original name for recovery', () => {
    expect(originalName(name)).toBe(`Show - S2026E001 - First [${ID}].mp4`);
  });
});

describe('recoverTombstones (an eviction interrupted by a crash)', () => {
  const tombstoneOf = (location) => path.join(dir, `.${path.basename(location)} [youtarr-evicting-0123456789abcdef]`);

  test('puts a file moved aside back at its name', async () => {
    await fs.rename(media, tombstoneOf(media));
    const result = await recoverTombstones(dir, ID);
    expect([result.restored, await contents()]).toEqual([[media], [[path.basename(media), 'previewed']]]);
  });

  test('drops a tombstone whose file is also back at its name', async () => {
    await fs.link(media, tombstoneOf(media));
    await recoverTombstones(dir, ID);
    expect(await contents()).toEqual([[path.basename(media), 'previewed']]);
  });

  test('keeps a tombstone whose name another file has taken', async () => {
    await fs.rename(media, tombstoneOf(media));
    await fs.writeFile(media, 'new download');
    const result = await recoverTombstones(dir, ID);
    expect([result.kept.length, await contents()]).toEqual([1, [['tombstone', 'previewed'], [path.basename(media), 'new download']]]);
  });

  test('leaves other videos\' tombstones alone', async () => {
    const other = path.join(dir, 'Other [abcdefghijk].mp4');
    await fs.writeFile(other, 'other');
    await fs.rename(other, tombstoneOf(other));
    await recoverTombstones(dir, ID);
    expect(await fs.pathExists(other)).toBe(false);
  });
});
