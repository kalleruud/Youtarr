/* eslint-env jest */
jest.mock('../../logger');

const express = require('express');
const supertest = require('supertest');
const createTvMigrationRoutes = require('../tvMigration');

function refusal(code, message = 'refused') {
  return Object.assign(new Error(message), { code });
}

function makeModule(overrides = {}) {
  return {
    list: jest.fn().mockResolvedValue({ plans: [], lease: null, running: null }),
    createPlan: jest.fn().mockResolvedValue({ planId: 'p' }),
    get: jest.fn().mockResolvedValue({ planId: 'p', status: 'planned' }),
    apply: jest.fn().mockResolvedValue({ planId: 'p', status: 'applying' }),
    resume: jest.fn().mockResolvedValue({ planId: 'p', status: 'applying' }),
    rollback: jest.fn().mockResolvedValue({ planId: 'p', status: 'rolling-back' }),
    restoreUserState: jest.fn().mockResolvedValue({ planId: 'p', status: 'applied' }),
    ...overrides,
  };
}

function makeApp(tvMigration, verifyToken = (req, _res, next) => next()) {
  const app = express();
  app.use(express.json());
  app.use(createTvMigrationRoutes({ verifyToken, tvMigration }));
  return app;
}

test('requires authentication', async () => {
  const res = await supertest(makeApp(makeModule(), (req, res) => res.status(401).json({ error: 'no' }))).get('/api/library-migration');
  expect(res.status).toBe(401);
});

test('creates a plan with the requested scope', async () => {
  const module = makeModule();
  await supertest(makeApp(module)).post('/api/library-migration/plans').send({ channelIds: ['UC1'], verifyChecksums: false });
  expect(module.createPlan).toHaveBeenCalledWith({ channelIds: ['UC1'], verifyChecksums: false });
});

test('rejects a non-boolean verifyChecksums', async () => {
  const res = await supertest(makeApp(makeModule())).post('/api/library-migration/plans').send({ verifyChecksums: 'yes' });
  expect(res.status).toBe(400);
});

test('passes only a literal true confirmation to apply', async () => {
  const module = makeModule();
  await supertest(makeApp(module)).post('/api/library-migration/plans/p/apply').send({ confirm: 'true', acceptUserStateLoss: true });
  expect(module.apply).toHaveBeenCalledWith('p', { confirm: false, acceptUserStateLoss: true });
});

test('maps a stale plan to 409 with the changed videos', async () => {
  const module = makeModule({ apply: jest.fn().mockRejectedValue(Object.assign(refusal('stale', 'changed'), { details: { stale: [{ youtubeId: 'v' }] } })) });
  const res = await supertest(makeApp(module)).post('/api/library-migration/plans/p/apply').send({ confirm: true });
  expect([res.status, res.body]).toEqual([409, { error: 'changed', code: 'stale', details: { stale: [{ youtubeId: 'v' }] } }]);
});

test('maps an unknown plan to 404', async () => {
  const module = makeModule({ get: jest.fn().mockRejectedValue(refusal('not-found')) });
  const res = await supertest(makeApp(module)).get('/api/library-migration/plans/nope');
  expect(res.status).toBe(404);
});

test('hides unexpected errors behind a 500', async () => {
  const module = makeModule({ resume: jest.fn().mockRejectedValue(new Error('EACCES /secret/path')) });
  const res = await supertest(makeApp(module)).post('/api/library-migration/plans/p/resume');
  expect([res.status, res.body]).toEqual([500, { error: 'The library migration request failed' }]);
});

test('rollback forwards the confirmation', async () => {
  const module = makeModule();
  await supertest(makeApp(module)).post('/api/library-migration/plans/p/rollback').send({ confirm: true });
  expect(module.rollback).toHaveBeenCalledWith('p', { confirm: true });
});

test('restore-user-state starts a restore', async () => {
  const module = makeModule();
  const res = await supertest(makeApp(module)).post('/api/library-migration/plans/p/restore-user-state');
  expect([res.status, module.restoreUserState.mock.calls[0][0]]).toEqual([200, 'p']);
});
