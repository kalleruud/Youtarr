/* eslint-env jest */
const express = require('express');
const request = require('supertest');
const createAcquisitionPolicyRoutes = require('../acquisitionPolicy');

class AcquisitionPolicyError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const buildApp = (service, verifyToken = (req, res, next) => next()) => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.log = { error: jest.fn() }; next(); });
  app.use(createAcquisitionPolicyRoutes({ verifyToken, acquisitionPolicyService: { AcquisitionPolicyError, ...service } }));
  return app;
};

describe('acquisition policy routes', () => {
  test('GET /api/acquisition-policy returns the global summary', async () => {
    const res = await request(buildApp({ getGlobal: jest.fn().mockResolvedValue({ scope: 'global' }) })).get('/api/acquisition-policy');
    expect([res.status, res.body]).toEqual([200, { scope: 'global' }]);
  });

  test('PUT /api/acquisition-policy forwards the body', async () => {
    const updateGlobal = jest.fn().mockResolvedValue({});
    await request(buildApp({ updateGlobal })).put('/api/acquisition-policy').send({ delivery: 'stream' });
    expect(updateGlobal).toHaveBeenCalledWith({ delivery: 'stream' });
  });

  test('requires authentication', async () => {
    const getGlobal = jest.fn();
    const res = await request(buildApp({ getGlobal }, (req, res) => res.status(401).json({ error: 'no' }))).get('/api/acquisition-policy');
    expect([res.status, getGlobal.mock.calls.length]).toEqual([401, 0]);
  });

  test('PUT /api/channels/:channelId/acquisition-policy updates the channel', async () => {
    const updateChannel = jest.fn().mockResolvedValue({ channelId: 'UC1' });
    const res = await request(buildApp({ updateChannel })).put('/api/channels/UC1/acquisition-policy').send({ live: 'ignore' });
    expect([res.status, updateChannel.mock.calls[0]]).toEqual([200, ['UC1', { live: 'ignore' }]]);
  });

  test('rejects a malformed channel id', async () => {
    const res = await request(buildApp({ getChannel: jest.fn() })).get('/api/channels/bad%20id/acquisition-policy');
    expect(res.status).toBe(400);
  });

  test('rejects a malformed YouTube id', async () => {
    const res = await request(buildApp({ getVideo: jest.fn() })).get('/api/videos/short/acquisition-policy');
    expect(res.status).toBe(400);
  });

  test('DELETE /api/videos/:youtubeId/acquisition-policy clears the override', async () => {
    const clearVideo = jest.fn().mockResolvedValue({});
    await request(buildApp({ clearVideo })).delete('/api/videos/aaaaaaaaaaa/acquisition-policy');
    expect(clearVideo).toHaveBeenCalledWith('aaaaaaaaaaa');
  });

  test('maps service errors to their status with an error message', async () => {
    const conflict = new AcquisitionPolicyError(409, 'revision-conflict', 'changed');
    conflict.currentRevision = 3;
    const res = await request(buildApp({ updateVideo: jest.fn().mockRejectedValue(conflict) }))
      .put('/api/videos/aaaaaaaaaaa/acquisition-policy').send({ delivery: 'stream' });
    expect([res.status, res.body]).toEqual([409, { error: 'changed', code: 'revision-conflict', currentRevision: 3 }]);
  });

  test('unexpected failures are a 500 without internals', async () => {
    const res = await request(buildApp({ getChannel: jest.fn().mockRejectedValue(new Error('db password wrong')) }))
      .get('/api/channels/UC1/acquisition-policy');
    expect([res.status, res.body]).toEqual([500, { error: 'Failed to process acquisition policy' }]);
  });
});
