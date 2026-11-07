const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { acquireCaptionLease } = require('../captionLease');
test('serializes publishers and releases a lease', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'caption-lease-'));
  try {
    const release = await acquireCaptionLease(root, 'video');
    let acquired = false;
    const next = acquireCaptionLease(root, 'video').then(unlock => { acquired = true; return unlock; });
    expect(acquired).toBe(false);
    await release();
    const unlock = await next;
    expect(acquired).toBe(true);
    await unlock();
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
