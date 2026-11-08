// Temp-dir library for caption tests: a media root, a jobs folder and one
// downloaded video. Nothing outside the OS temp folder is touched.
const fs = require('fs');
const os = require('os');
const path = require('path');

const YOUTUBE_ID = 'abcdefghijk';
const VIDEO_BYTES = Buffer.from('synthetic video bytes');

function createSandbox({ info, config = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'youtarr-captions-'));
  const mediaRoot = path.join(root, 'media');
  const jobsPath = path.join(root, 'jobs');
  const videoDir = path.join(mediaRoot, 'Channel', `Video [${YOUTUBE_ID}]`);
  fs.mkdirSync(videoDir, { recursive: true });
  fs.mkdirSync(path.join(jobsPath, 'info'), { recursive: true });
  const filePath = path.join(videoDir, `Video [${YOUTUBE_ID}].mp4`);
  fs.writeFileSync(filePath, VIDEO_BYTES);
  if (info) fs.writeFileSync(path.join(jobsPath, 'info', `${YOUTUBE_ID}.info.json`), JSON.stringify(info));
  const settings = { subtitlesEnabled: true, subtitleLanguage: 'en', captionEnrichmentEnabled: true, ...config };
  const configModule = {
    directoryPath: mediaRoot,
    getConfig: () => settings,
    getJobsPath: () => jobsPath,
  };
  return {
    root,
    mediaRoot,
    jobsPath,
    videoDir,
    filePath,
    settings,
    configModule,
    video: { youtubeId: YOUTUBE_ID, title: 'Video', filePath, audioFilePath: null, duration: 120, removed: false },
    sidecar: (code) => path.join(videoDir, `Video [${YOUTUBE_ID}].${code}.srt`),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

module.exports = { createSandbox, YOUTUBE_ID, VIDEO_BYTES };
