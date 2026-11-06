const fs = require('fs');
const os = require('os');
const path = require('path');
const { episodeThumbName, prepareEpisodeArtwork, publishEpisodeArtwork } = require('../episodeArtwork');

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'episode-art-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const mediaPath = () => path.join(dir, 'Pawel - Title [abc123def45].mp4');

test('names the thumbnail after the media stem', () => {
  expect(episodeThumbName('Show - S2026E001 - Title [id]')).toBe('Show - S2026E001 - Title [id]-thumb.jpg');
});

test('plans a copy of the landscape thumbnail beside the media', () => {
  expect(prepareEpisodeArtwork({ filePath: mediaPath() })).toEqual({
    sourcePath: path.join(dir, 'Pawel - Title [abc123def45].jpg'),
    targetPath: path.join(dir, 'Pawel - Title [abc123def45]-thumb.jpg'),
  });
});

test('writes a byte-identical copy so the 16:9 image stays intact', () => {
  const plan = prepareEpisodeArtwork({ filePath: mediaPath() });
  fs.writeFileSync(plan.sourcePath, Buffer.from('original-1280x720-bytes'));
  expect(publishEpisodeArtwork(plan)).toBe('written');
  expect(fs.readFileSync(plan.targetPath)).toEqual(fs.readFileSync(plan.sourcePath));
});

test('never overwrites an existing episode thumbnail', () => {
  const plan = prepareEpisodeArtwork({ filePath: mediaPath() });
  fs.writeFileSync(plan.sourcePath, 'new');
  fs.writeFileSync(plan.targetPath, 'owner-chosen');
  expect(publishEpisodeArtwork(plan)).toBe('exists');
  expect(fs.readFileSync(plan.targetPath, 'utf8')).toBe('owner-chosen');
});

test('reports a missing source thumbnail', () => {
  expect(publishEpisodeArtwork(prepareEpisodeArtwork({ filePath: mediaPath() }))).toBe('no-source');
});
