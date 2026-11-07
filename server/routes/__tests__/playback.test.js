const express = require('express');
const request = require('supertest');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const createRoutes = require('../playback');
let app, fixture, playback, release;
beforeEach(async () => {
  fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'range-fixture-'));
  const filePath = path.join(fixture, 'media.mp4');
  await fs.writeFile(filePath, '0123456789');
  release = jest.fn();
  playback = {
    openPlayback: jest.fn().mockResolvedValue({ sessionId: 'session', asset: 'media' }),
    getSessionAsset: jest.fn((id, asset) => {
      if (asset !== 'media') throw Object.assign(new Error('Invalid asset'), { status: 404 });
      return { filePath, release };
    }),
    closePlayback: jest.fn().mockResolvedValue(),
  };
  app = express();
  app.use(createRoutes({ verifyToken: (req, res, next) => req.headers['x-access-token'] === 'test' ? next() : res.sendStatus(401), playbackSession: playback }));
});
afterEach(async () => fs.remove(fixture));
test('stable and asset routes require authentication', async () => {
  expect((await request(app).get('/api/playback/abcdefghijk')).status).toBe(401);
  expect((await request(app).get('/api/playback/sessions/session/media')).status).toBe(401);
  expect(playback.openPlayback).not.toHaveBeenCalled();
});
test.each(['bytes=0-2', 'bytes=7-9', 'bytes=2-4'])('supports seek range %s', async range => {
  const response = await request(app).get('/api/playback/sessions/session/media').set('x-access-token', 'test').set('Range', range);
  expect(response.status).toBe(206);
  expect(response.headers['content-length']).toBe('3');
  expect(release).toHaveBeenCalled();
});
test('invalid range returns 416', async () => {
  const response = await request(app).get('/api/playback/sessions/session/media').set('x-access-token', 'test').set('Range', 'bytes=100-200');
  expect(response.status).toBe(416);
});
test('stable playback prepares and serves a range', async () => {
  const response = await request(app).get('/api/playback/abcdefghijk').set('x-access-token', 'test').set('Range', 'bytes=5-8');
  expect(response.status).toBe(206);
  expect(response.headers['content-range']).toBe('bytes 5-8/10');
});
test('upstream failure returns retryable error', async () => {
  playback.openPlayback.mockRejectedValue(Object.assign(new Error('Retry later'), { status: 503 }));
  const response = await request(app).get('/api/playback/abcdefghijk').set('x-access-token', 'test');
  expect(response.status).toBe(503);
  expect(response.headers['retry-after']).toBe('10');
});
test('cached range seeks bypass the preparation rate limit', async () => {
  playback.hasReadyPlayback = () => true;
  for (let index = 0; index < 12; index++) {
    const response = await request(app).get('/api/playback/abcdefghijk').set('x-access-token', 'test').set('Range', 'bytes=0-1');
    expect(response.status).toBe(206);
  }
});

test('DELETE requires auth and cannot revoke shared readers', async () => {
  expect((await request(app).delete('/api/playback/sessions/session/media')).status).toBe(401);
  expect((await request(app).delete('/api/playback/sessions/session/media').set('x-access-token', 'test')).status).toBe(204);
  expect(playback.closePlayback).not.toHaveBeenCalled();
});

test('disconnect cancels its waiter without closing shared playback and retry works', async () => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let cancelled;
  const aborted = new Promise(resolve => { cancelled = resolve; });
  playback.openPlayback.mockImplementationOnce((id, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { cancelled(); reject(Object.assign(new Error('Cancelled'), { status: 499 })); });
    entered();
  }));
  const pending = request(app).get('/api/playback/abcdefghijk').set('x-access-token', 'test');
  pending.end(() => {});
  await started;
  pending.abort();
  await aborted;
  await new Promise(resolve => pending.app.close(resolve));
  expect(playback.closePlayback).not.toHaveBeenCalled();
  expect((await request(app).get('/api/playback/abcdefghijk').set('x-access-token', 'test')).status).toBe(200);
});
