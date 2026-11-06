const crypto = require('crypto');
const fs = require('fs');
const { execFile } = require('child_process');
const { FFPROBE_TIMEOUT_MS } = require('./constants');

// Image types accepted from uploads, identified by content, never by the
// client's file name or MIME header.
const SIGNATURES = [
  { type: 'jpeg', test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'png', test: (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { type: 'webp', test: (b) => b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' },
];

function detectImageType(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  const match = SIGNATURES.find((s) => s.test(buffer));
  return match ? match.type : null;
}

/**
 * Probe an image's pixel dimensions with ffprobe. Resolves null when the
 * file cannot be read as an image; never rejects.
 */
function probeImage(filePath, { exec = execFile } = {}) {
  return new Promise((resolve) => {
    exec(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', filePath],
      { timeout: FFPROBE_TIMEOUT_MS },
      (err, stdout) => {
        if (err) return resolve(null);
        const [width, height] = String(stdout).trim().split(',').map((v) => parseInt(v, 10));
        if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
          return resolve(null);
        }
        resolve({ width, height });
      }
    );
  });
}

/** sha256 of a file's bytes, or null when it cannot be read. */
function sha256File(filePath) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch (err) {
    return null;
  }
}

module.exports = { detectImageType, probeImage, sha256File };
