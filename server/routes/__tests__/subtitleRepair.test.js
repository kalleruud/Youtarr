const express = require('express');
const request = require('supertest');
const createRoutes = require('../subtitleRepair');
function app(service, authorized = true) {
  const result = express();
  result.use(express.json());
  result.use(createRoutes({ verifyToken: (_req, res, next) => authorized ? next() : res.sendStatus(401), subtitleRepair: service, logger: { error: jest.fn() } }));
  return result;
}
test('requires authentication', async () => {
  expect((await request(app({}, false)).get('/api/subtitle-repairs')).status).toBe(401);
});
test('previews validated videos through service', async () => {
  const previewRepair = jest.fn().mockResolvedValue({ id: 'preview' });
  const response = await request(app({ previewRepair })).post('/api/subtitle-repairs/preview').send({ videoIds: [1], automaticFinal: false });
  expect(response.body).toEqual({ id: 'preview' });
  expect(previewRepair).toHaveBeenCalledWith([1], { automaticFinal: false });
});
test('returns conflict errors with standard shape', async () => {
  const startRepair = jest.fn().mockRejectedValue(Object.assign(new Error('Already running'), { status: 409 }));
  const response = await request(app({ startRepair })).post('/api/subtitle-repairs/id/start');
  expect(response.status).toBe(409);
  expect(response.body).toEqual({ error: 'Already running' });
});
