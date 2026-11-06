const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const { assertSafePath } = require('../safePath');
let root;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'safe-path-')); });
afterEach(async () => { await fs.remove(root); });
test.each(['source', 'destination'])('rejects an existing %s ancestor symlink', async (name) => {
  await fs.ensureDir(path.join(root, 'outside'));
  await fs.symlink(path.join(root, 'outside'), path.join(root, name));
  await expect(assertSafePath(path.join(root, name, 'Season', 'media.mp4'), root)).rejects.toMatchObject({ code: 'unsafe-path' });
});
test('rechecks a path replaced by a symlink after preview', async () => {
  const show = path.join(root, 'show');
  const target = path.join(show, 'Season', 'episode.nfo');
  await assertSafePath(target, root);
  await fs.symlink(os.tmpdir(), show);
  await expect(assertSafePath(target, root)).rejects.toMatchObject({ code: 'unsafe-path' });
});
test('allows a configured root symlink and missing descendants', async () => {
  await fs.ensureDir(path.join(root, 'real'));
  await fs.symlink(path.join(root, 'real'), path.join(root, 'configured'));
  await expect(assertSafePath(path.join(root, 'configured', 'show', 'file'), path.join(root, 'configured'))).resolves.toBeUndefined();
});
test('rejects lexical escape', async () => {
  await expect(assertSafePath(path.join(root, '..', 'escape'), root)).rejects.toMatchObject({ code: 'unsafe-path' });
});
