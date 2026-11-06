const backendConfig = require('./jest.config');

module.exports = {
    ...backendConfig,
    roots: ['<rootDir>/migrations'],
    testMatch: ['<rootDir>/migrations/__tests__/externalApiDatabase.integration.test.js', '<rootDir>/migrations/__tests__/episodeAssignmentDatabase.integration.test.js', '<rootDir>/migrations/__tests__/channelArtworkDatabase.integration.test.js', '<rootDir>/migrations/__tests__/captionTracksDatabase.integration.test.js'],
    testPathIgnorePatterns: [],
};
