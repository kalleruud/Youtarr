const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const MAX_WAIT_MS = 30000;
const RETRY_MS = 100;

async function acquireCaptionLease(root, videoId) {
  const directory = path.join(root, 'caption-leases');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, crypto.createHash('sha256').update(String(videoId)).digest('hex'));
  const deadline = Date.now() + MAX_WAIT_MS;
  for (;;) {
    try {
      // Hard-link a fully written owner record: other processes never see an empty lock.
      const owner = `${target}.${crypto.randomUUID()}`;
      await fs.writeFile(owner, String(process.pid), { flag: 'wx', mode: 0o600 });
      try { await fs.link(owner, target); }
      finally { await fs.unlink(owner); }
      return async () => { await fs.unlink(target); };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const pid = Number(await fs.readFile(target, 'utf8'));
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid caption lease owner');
        try { process.kill(pid, 0); }
        catch (probe) { if (probe.code !== 'ESRCH') throw probe; await fs.unlink(target); continue; }
      } catch (read) { if (read.code === 'ENOENT') continue; throw read; }
      if (Date.now() >= deadline) throw new Error('Caption publication is busy; retry preview');
      await new Promise(resolve => setTimeout(resolve, RETRY_MS));
    }
  }
}
module.exports = { acquireCaptionLease };
