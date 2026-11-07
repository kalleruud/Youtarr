/* eslint-env jest */
const express = require('express');
const request = require('supertest');
const createAcquisitionHealthRoutes = require('../acquisitionHealth');

class HealthError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const passThrough = (req, res, next) => next();
const buildApp = (health, { verifyToken = passThrough, limiter = passThrough, downloadModule = {} } = {}) => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.log = { error: jest.fn() }; next(); });
  app.use(createAcquisitionHealthRoutes({ verifyToken, health: { HealthError, ...health }, downloadModule, healthRetryRateLimiter: limiter }));
  return app;
};

const ID = 'abcdefghijk';

describe('acquisition health routes', () => {
  test('GET summary returns the overview', async () => {
    const res = await request(buildApp({ getSummary: jest.fn().mockResolvedValue({ problems: [] }) })).get('/api/acquisition-health/summary');
    expect([res.status, res.body]).toEqual([200, { problems: [] }]);
  });

  test('requires authentication', async () => {
    const getSummary = jest.fn();
    const res = await request(buildApp({ getSummary }, { verifyToken: (req, res) => res.status(401).json({ error: 'no' }) }))
      .get('/api/acquisition-health/summary');
    expect([res.status, getSummary.mock.calls.length]).toEqual([401, 0]);
  });

  test('GET outcomes passes validated filters', async () => {
    const listOutcomes = jest.fn().mockResolvedValue({ outcomes: [], total: 0 });
    await request(buildApp({ listOutcomes })).get('/api/acquisition-health/outcomes?stage=library&status=failed,pending&limit=5');
    expect(listOutcomes).toHaveBeenCalledWith({ stage: 'library', statuses: ['failed', 'pending'], category: undefined, limit: '5', offset: undefined });
  });

  test.each([
    ['stage=nope'],
    ['status=bogus'],
    ['category=Bad%20Value'],
  ])('GET outcomes rejects %s', async (query) => {
    const res = await request(buildApp({ listOutcomes: jest.fn() })).get(`/api/acquisition-health/outcomes?${query}`);
    expect(res.status).toBe(400);
  });

  test('GET a video explanation validates the id', async () => {
    const res = await request(buildApp({ explainVideo: jest.fn() })).get('/api/acquisition-health/videos/bad');
    expect(res.status).toBe(400);
  });

  test('GET a video explanation returns it', async () => {
    const explainVideo = jest.fn().mockResolvedValue({ youtubeId: ID });
    const res = await request(buildApp({ explainVideo })).get(`/api/acquisition-health/videos/${ID}`);
    expect([res.status, explainVideo.mock.calls[0][0]]).toEqual([200, ID]);
  });

  test('POST retry forwards stage, revision and the download module', async () => {
    const retryStep = jest.fn().mockResolvedValue({ queued: true });
    const downloadModule = { doSpecificDownloads: jest.fn() };
    await request(buildApp({ retryStep }, { downloadModule })).post(`/api/acquisition-health/videos/${ID}/retry`).send({ stage: 'library', revision: 4 });
    expect(retryStep).toHaveBeenCalledWith({ youtubeId: ID, stage: 'library', revision: 4 }, { downloadModule });
  });

  test('POST retry maps a duplicate to 409 with its code', async () => {
    const retryStep = jest.fn().mockRejectedValue(new HealthError(409, 'stale-or-duplicate', 'Refresh'));
    const res = await request(buildApp({ retryStep })).post(`/api/acquisition-health/videos/${ID}/retry`).send({ stage: 'acquisition', revision: 1 });
    expect([res.status, res.body]).toEqual([409, { error: 'Refresh', code: 'stale-or-duplicate' }]);
  });

  test('POST retry is rate limited', async () => {
    const retryStep = jest.fn();
    const limiter = (req, res) => res.status(429).json({ error: 'slow down' });
    const res = await request(buildApp({ retryStep }, { limiter })).post(`/api/acquisition-health/videos/${ID}/retry`).send({});
    expect([res.status, retryStep.mock.calls.length]).toEqual([429, 0]);
  });

  test('an unexpected error is a generic 500', async () => {
    const res = await request(buildApp({ getSummary: jest.fn().mockRejectedValue(new Error('secret detail')) })).get('/api/acquisition-health/summary');
    expect([res.status, res.body]).toEqual([500, { error: 'Failed to read acquisition health' }]);
  });
});
