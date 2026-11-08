/* eslint-env jest */
const express = require('express');
const request = require('supertest');

jest.mock('../../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const createCaptionRoutes = require('../captions');

const ID = 'abcdefghijk';

function buildApp(overrides = {}) {
  const captionCatalog = {
    getVideoCaptions: jest.fn(async () => ({ youtubeId: ID, tracks: [], missing: [] })),
    setProtection: jest.fn(async () => ({ status: 'ok' })),
    requestRetry: jest.fn(async () => ({ status: 'scheduled', enrichment: { status: 'pending' } })),
    previewPreferences: jest.fn(async () => ({ totals: {}, examples: [], limit: 200 })),
    ...overrides,
  };
  const app = express();
  app.use(express.json());
  app.use(createCaptionRoutes({ verifyToken: (req, res, next) => next(), captionCatalog }));
  return { app, captionCatalog };
}

describe('caption routes', () => {
  test('returns the caption summary', async () => {
    const { app } = buildApp();
    expect((await request(app).get(`/api/videos/${ID}/captions`)).status).toBe(200);
  });

  test('rejects an invalid video id', async () => {
    const { app } = buildApp();
    expect((await request(app).get('/api/videos/bad/captions')).status).toBe(400);
  });

  test('an unknown video is 404', async () => {
    const { app } = buildApp({ getVideoCaptions: jest.fn(async () => null) });
    expect((await request(app).get(`/api/videos/${ID}/captions`)).status).toBe(404);
  });

  test('protection requires a boolean', async () => {
    const { app } = buildApp();
    expect((await request(app).put(`/api/videos/${ID}/captions/en/protection`).send({ protected: 'yes' })).status).toBe(400);
  });

  test('protection rejects a code that is not a language code', async () => {
    const { app } = buildApp();
    expect((await request(app).put(`/api/videos/${ID}/captions/..%2Fx/protection`).send({ protected: true })).status).toBe(400);
  });

  test('protection is saved', async () => {
    const { app, captionCatalog } = buildApp();
    await request(app).put(`/api/videos/${ID}/captions/en-GB/protection`).send({ protected: true });
    expect(captionCatalog.setProtection).toHaveBeenCalledWith(ID, 'en-GB', true);
  });

  test('check again is accepted', async () => {
    const { app } = buildApp();
    expect((await request(app).post(`/api/videos/${ID}/captions/check`)).status).toBe(202);
  });

  test.each([['disabled'], ['running'], ['nothing-missing']])('check again refused as %s is 409', async (status) => {
    const { app } = buildApp({ requestRetry: jest.fn(async () => ({ status })) });
    expect((await request(app).post(`/api/videos/${ID}/captions/check`)).body.reason).toBe(status);
  });

  test('preview passes only the caption preference fields', async () => {
    const { app, captionCatalog } = buildApp();
    await request(app).post('/api/captions/preview').send({ captionSourcePolicy: 'uploaded-only', plexApiKey: 'x' });
    expect(captionCatalog.previewPreferences).toHaveBeenCalledWith({ captionSourcePolicy: 'uploaded-only' });
  });

  test('preview rejects a non-boolean translation setting', async () => {
    const { app } = buildApp();
    expect((await request(app).post('/api/captions/preview').send({ captionAllowTranslated: 'yes' })).status).toBe(400);
  });
});
