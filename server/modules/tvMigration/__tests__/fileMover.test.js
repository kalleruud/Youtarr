/* eslint-env jest */
jest.mock('../../../logger');

const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const { moveFile, removeDirIfEmpty, fingerprint, sha256 } = require('../fileMover');

let root;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'tvmig-move-'));
});

afterEach(async () => {
  jest.restoreAllMocks();
  await fs.remove(root);
});

describe('moveFile', () => {
  test('renames on the same filesystem', async () => {
    await fs.outputFile(path.join(root, 'a.mp4'), 'bytes');
    const result = await moveFile(path.join(root, 'a.mp4'), path.join(root, 'sub', 'b.mp4'));
    expect([result, await fs.readFile(path.join(root, 'sub', 'b.mp4'), 'utf8')]).toEqual([{ action: 'moved', method: 'rename' }, 'bytes']);
  });

  test('treats a move that already happened as done', async () => {
    await fs.outputFile(path.join(root, 'b.mp4'), 'bytes');
    expect(await moveFile(path.join(root, 'a.mp4'), path.join(root, 'b.mp4'), { expectedSize: 5 })).toEqual({ action: 'already-moved' });
  });

  test('refuses an already-moved target of another size', async () => {
    await fs.outputFile(path.join(root, 'b.mp4'), 'other bytes');
    await expect(moveFile(path.join(root, 'a.mp4'), path.join(root, 'b.mp4'), { expectedSize: 5 })).rejects.toMatchObject({ code: 'size-mismatch' });
  });

  test('never overwrites an existing target', async () => {
    await fs.outputFile(path.join(root, 'a.mp4'), 'new');
    await fs.outputFile(path.join(root, 'b.mp4'), 'old');
    await expect(moveFile(path.join(root, 'a.mp4'), path.join(root, 'b.mp4'))).rejects.toMatchObject({ code: 'target-exists' });
  });

  test('reports a file that is in neither place', async () => {
    await expect(moveFile(path.join(root, 'a.mp4'), path.join(root, 'b.mp4'))).rejects.toMatchObject({ code: 'source-missing' });
  });

  test('copies, verifies and removes the source across filesystems', async () => {
    await fs.outputFile(path.join(root, 'a.mp4'), 'cross-device bytes');
    const expectedHash = await sha256(path.join(root, 'a.mp4'));
    const realRename = fs.rename;
    jest.spyOn(fs, 'rename').mockImplementationOnce(async () => {
      throw Object.assign(new Error('cross-device'), { code: 'EXDEV' });
    }).mockImplementation((...args) => realRename(...args));
    const result = await moveFile(path.join(root, 'a.mp4'), path.join(root, 'b.mp4'));
    expect([result.method, result.sha256, await fs.pathExists(path.join(root, 'a.mp4')), await sha256(path.join(root, 'b.mp4'))])
      .toEqual(['copy', expectedHash, false, expectedHash]);
  });
});

describe('removeDirIfEmpty', () => {
  test('removes an empty folder', async () => {
    await fs.ensureDir(path.join(root, 'empty'));
    expect(await removeDirIfEmpty(path.join(root, 'empty'))).toBe(true);
  });

  test('never removes a folder with files', async () => {
    await fs.outputFile(path.join(root, 'full', 'keep.txt'), 'x');
    expect([await removeDirIfEmpty(path.join(root, 'full')), await fs.pathExists(path.join(root, 'full', 'keep.txt'))]).toEqual([false, true]);
  });
});

test('fingerprint is null for a missing file', async () => {
  expect(await fingerprint(path.join(root, 'nope'))).toBeNull();
});

for (const reverse of [false, true]) {
  test(`recovers a published copy after unlink failure (${reverse ? 'rollback' : 'resume'})`, async () => {
    const source = path.join(root, 'a.mp4');
    const target = path.join(root, 'b.mp4');
    await fs.outputFile(source, 'verified bytes');
    const journal = {};
    let durable;
    jest.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('cross device'), { code: 'EXDEV' }));
    jest.spyOn(fs, 'unlink').mockRejectedValueOnce(new Error('unlink failed'));
    await expect(moveFile(source, target, { journal, checkpoint: async () => { durable = JSON.parse(JSON.stringify(journal)); } })).rejects.toThrow('unlink failed');
    await moveFile(reverse ? target : source, reverse ? source : target, { journal: durable });
    expect(await fs.readFile(reverse ? source : target, 'utf8')).toBe('verified bytes');
    expect(await fs.pathExists(reverse ? target : source)).toBe(false);
  });
}

test('identical preexisting copies without a publication journal remain untouched', async () => {
  const source = path.join(root, 'a');
  const target = path.join(root, 'b');
  await fs.outputFile(source, 'same');
  await fs.outputFile(target, 'same');
  await expect(moveFile(source, target, { journal: {} })).rejects.toMatchObject({ code: 'target-exists' });
  expect(await fs.readFile(source, 'utf8')).toBe('same');
});

test('refuses a replaced destination even when its content is identical', async () => {
  const source = path.join(root, 'a');
  const target = path.join(root, 'b');
  await fs.outputFile(source, 'same');
  const journal = {};
  jest.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('cross device'), { code: 'EXDEV' }));
  jest.spyOn(fs, 'unlink').mockRejectedValueOnce(new Error('unlink failed'));
  await expect(moveFile(source, target, { journal })).rejects.toThrow('unlink failed');
  await fs.rename(target, path.join(root, 'keep-original-inode'));
  await fs.outputFile(target, 'same');
  await expect(moveFile(source, target, { journal })).rejects.toMatchObject({ code: 'target-exists' });
  expect(await fs.readFile(source, 'utf8')).toBe('same');
});
