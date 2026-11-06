/* eslint-env jest */
const express = require('express');
const request = require('supertest');

jest.mock('../../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const createChannelArtworkRoutes = require('../channelArtwork');

class ArtworkValidationError extends Error {}

const status = { enabled: true, source: 'auto', protected: false, revision: 1 };

function buildApp(overrides = {}) {
  const channelArtworkModule = {
    ArtworkValidationError,
    getStatus: jest.fn(async () => status),
    updatePreference: jest.fn(async () => status),
    uploadManualPoster: jest.fn(async () => ({ ...status, source: 'manual' })),
    resetPoster: jest.fn(async () => status),
    regenerate: jest.fn(async () => ({ ...status, episodes: { written: 1, existing: 0, missing: 0, failed: 0 } })),
    findChannel: jest.fn(async () => ({ channel_id: 'UC1' })),
    requestRefresh: jest.fn(async () => ({ status: 'refreshed' })),
    ...overrides,
  };
  const app = express();
  app.use(express.json());
  app.use(createChannelArtworkRoutes({
    verifyToken: (req, res, next) => next(),
    channelArtworkModule,
    artworkUploadRateLimiter: (req, res, next) => next(),
  }));
  return { app, channelArtworkModule };
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);

describe('channel artwork routes', () => {
  test('returns the poster status', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/channels/UC1/artwork');
    expect(res.body).toEqual(status);
  });

  test('rejects a malformed channel id', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/channels/..%2Fetc/artwork');
    expect(res.status).toBe(400);
  });

  test('answers 404 for an unknown channel', async () => {
    const { app } = buildApp({ getStatus: jest.fn(async () => null) });
    const res = await request(app).get('/api/channels/UCX/artwork');
    expect(res.status).toBe(404);
  });

  test('passes the selection and pin through', async () => {
    const { app, channelArtworkModule } = buildApp();
    await request(app).put('/api/channels/UC1/artwork').send({ source: 'manual', protected: true });
    expect(channelArtworkModule.updatePreference).toHaveBeenCalledWith('UC1', { source: 'manual', protected: true });
  });

  test('maps validation errors to 400 with the message', async () => {
    const { app } = buildApp({ updatePreference: jest.fn(async () => { throw new ArtworkValidationError('Upload a poster before selecting it.'); }) });
    const res = await request(app).put('/api/channels/UC1/artwork').send({ source: 'manual' });
    expect({ status: res.status, body: res.body }).toEqual({ status: 400, body: { error: 'Upload a poster before selecting it.' } });
  });

  test('hands the uploaded bytes to the module', async () => {
    const { app, channelArtworkModule } = buildApp();
    await request(app).post('/api/channels/UC1/artwork/poster').attach('poster', JPEG, 'poster.jpg');
    expect(channelArtworkModule.uploadManualPoster).toHaveBeenCalledWith('UC1', JPEG);
  });

  test('rejects an upload without a file', async () => {
    const { app } = buildApp();
    const res = await request(app).post('/api/channels/UC1/artwork/poster');
    expect(res.status).toBe(400);
  });

  test('rejects an upload over the size limit before the module sees it', async () => {
    const { app, channelArtworkModule } = buildApp();
    const res = await request(app).post('/api/channels/UC1/artwork/poster')
      .attach('poster', Buffer.alloc(10 * 1024 * 1024 + 1), 'big.jpg');
    expect({ status: res.status, called: channelArtworkModule.uploadManualPoster.mock.calls.length }).toEqual({ status: 400, called: 0 });
  });

  test('regenerates and returns episode counts', async () => {
    const { app } = buildApp();
    const res = await request(app).post('/api/channels/UC1/artwork/regenerate');
    expect(res.body.episodes.written).toBe(1);
  });

  test('resets to automatic artwork', async () => {
    const { app, channelArtworkModule } = buildApp();
    await request(app).delete('/api/channels/UC1/artwork/poster');
    expect(channelArtworkModule.resetPoster).toHaveBeenCalledWith('UC1');
  });

  test('retries the Jellyfin refresh', async () => {
    const { app, channelArtworkModule } = buildApp();
    await request(app).post('/api/channels/UC1/artwork/refresh');
    expect(channelArtworkModule.requestRefresh).toHaveBeenCalledWith('UC1');
  });

  test('answers 500 without internal details on unexpected errors', async () => {
    const { app } = buildApp({ resetPoster: jest.fn(async () => { throw new Error('EACCES /secret/path'); }) });
    const res = await request(app).delete('/api/channels/UC1/artwork/poster');
    expect(res.body).toEqual({ error: 'Channel artwork request failed' });
  });
});
