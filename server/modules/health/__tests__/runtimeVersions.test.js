const runtimeVersions = require('../runtimeVersions');

test('reports the package version and the provided yt-dlp version', () => {
  runtimeVersions.setToolVersionProvider(() => '2026.10.01');
  expect(runtimeVersions.getVersions()).toEqual({ appVersion: require('../../../../package.json').version, toolVersion: '2026.10.01' });
});

test('a pending or failing provider yields no tool version', () => {
  runtimeVersions.setToolVersionProvider(() => Promise.resolve('x'));
  expect(runtimeVersions.getToolVersion()).toBeNull();
  runtimeVersions.setToolVersionProvider(() => { throw new Error('no yt-dlp'); });
  expect(runtimeVersions.getToolVersion()).toBeNull();
});
