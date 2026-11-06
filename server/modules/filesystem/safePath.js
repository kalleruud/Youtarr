// Configured roots may be mount points or symlinks. Descendants must never
// redirect migration reads, writes or removals through a symbolic link.
const { AsyncLocalStorage } = require('async_hooks');
const rootsContext = new AsyncLocalStorage();
const fs = require('fs-extra');
const path = require('path');

async function assertSafePath(target, root = path.parse(path.resolve(target)).root) {
  const base = path.resolve(root);
  const relative = path.relative(base, path.resolve(target));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw Object.assign(new Error(`Path escapes configured root: ${target}`), { code: 'unsafe-path' });
  }
  let current = base;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) {
        throw Object.assign(new Error(`Symbolic link in migration path: ${current}`), { code: 'unsafe-path' });
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
}
function withSafeRoots(roots, operation) {
  return rootsContext.run(roots.filter(Boolean), operation);
}
async function assertMigrationPath(target) {
  const root = (rootsContext.getStore() || []).find((base) => {
    const relative = path.relative(base, target);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  });
  await assertSafePath(target, root);
}
module.exports = { assertSafePath, assertMigrationPath, withSafeRoots };
