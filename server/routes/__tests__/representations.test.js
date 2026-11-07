/* eslint-env jest */
const express = require('express');
const request = require('supertest');
const createRepresentationRoutes = require('../representations');

class RepresentationError extends Error {
  constructor(status, code, message, reasons = []) { super(message); this.status = status; this.code = code; this.reasons = reasons; }
}
class RepresentationRevisionError extends Error {
  constructor(currentRevision) { super('changed'); this.currentRevision = currentRevision; }
}
class RepresentationLeaseError extends Error {}

const ID = 'abcdefghijk';
const buildApp = (facade, verifyToken = (req, res, next) => next()) => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.log = { error: jest.fn() }; next(); });
  app.use(createRepresentationRoutes({
    verifyToken,
    representations: { RepresentationError, RepresentationRevisionError, RepresentationLeaseError, ...facade },
  }));
  return app;
};

describe('episode representation routes', () => {
  test('GET returns the representation status', async () => {
    const getStatus = jest.fn().mockResolvedValue({ youtubeId: ID, playback: { mode: 'local' } });
    const res = await request(buildApp({ getStatus })).get(`/api/videos/${ID}/representation`);
    expect([res.status, res.body.playback.mode]).toEqual([200, 'local']);
  });

  test('requires authentication', async () => {
    const getStatus = jest.fn();
    const res = await request(buildApp({ getStatus }, (req, res) => res.status(401).json({ error: 'no' }))).get(`/api/videos/${ID}/representation`);
    expect([res.status, getStatus.mock.calls.length]).toEqual([401, 0]);
  });

  test('rejects an invalid YouTube ID', async () => {
    const res = await request(buildApp({ getStatus: jest.fn() })).get('/api/videos/..%2Fetc/representation');
    expect(res.status).toBe(400);
  });

  test('evict requires the preview revision', async () => {
    const evictLocalCopy = jest.fn();
    const res = await request(buildApp({ evictLocalCopy })).post(`/api/videos/${ID}/representation/evict`).send({});
    expect([res.status, evictLocalCopy.mock.calls.length]).toEqual([400, 0]);
  });

  test('evict forwards the preview revision', async () => {
    const evictLocalCopy = jest.fn().mockResolvedValue({ removed: [] });
    await request(buildApp({ evictLocalCopy })).post(`/api/videos/${ID}/representation/evict`).send({ expectedRevision: 3 });
    expect(evictLocalCopy).toHaveBeenCalledWith(ID, { expectedRevision: 3 });
  });

  test('a refused eviction returns 409 with its reasons', async () => {
    const evictLocalCopy = jest.fn().mockRejectedValue(new RepresentationError(409, 'eviction-refused', 'protected', [{ code: 'protected' }]));
    const res = await request(buildApp({ evictLocalCopy })).post(`/api/videos/${ID}/representation/evict`).send({ expectedRevision: 1 });
    expect([res.status, res.body.code, res.body.reasons]).toEqual([409, 'eviction-refused', [{ code: 'protected' }]]);
  });

  test('a stale preview returns 409 revision-conflict', async () => {
    const evictLocalCopy = jest.fn().mockRejectedValue(new RepresentationRevisionError(4));
    const res = await request(buildApp({ evictLocalCopy })).post(`/api/videos/${ID}/representation/evict`).send({ expectedRevision: 1 });
    expect([res.status, res.body]).toEqual([409, { error: 'changed', code: 'revision-conflict', currentRevision: 4 }]);
  });

  test('a change in progress returns 409 busy', async () => {
    const selectVersion = jest.fn().mockRejectedValue(new RepresentationLeaseError('busy'));
    const res = await request(buildApp({ selectVersion })).put(`/api/videos/${ID}/representation/selection`).send({ representationId: 2 });
    expect([res.status, res.body.code]).toEqual([409, 'busy']);
  });

  test('selection requires representationId', async () => {
    const res = await request(buildApp({ selectVersion: jest.fn() })).put(`/api/videos/${ID}/representation/selection`).send({});
    expect(res.status).toBe(400);
  });

  test('selection forwards null to return to automatic selection', async () => {
    const selectVersion = jest.fn().mockResolvedValue({ mode: 'local' });
    await request(buildApp({ selectVersion })).put(`/api/videos/${ID}/representation/selection`).send({ representationId: null });
    expect(selectVersion).toHaveBeenCalledWith(ID, null, { expectedRevision: undefined });
  });

  test('an unexpected failure returns a generic 500', async () => {
    const res = await request(buildApp({ getStatus: jest.fn().mockRejectedValue(new Error('db down')) })).get(`/api/videos/${ID}/representation`);
    expect([res.status, res.body]).toEqual([500, { error: 'Failed to process the episode representation' }]);
  });
});
