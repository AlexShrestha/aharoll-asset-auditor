import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mockReq, mockRes, mockDns, mockFetch, openaiCalls, snapshotEnv, clearEnv, silenceConsoleError } from './helpers.js';

const { default: handler } = await import('../api/analyze.js');
const auth = await import('../lib/auth.js');

const KEY = 'test-audit-key-0123456789';
const validBody = () => ({
  title: 'Black Dress',
  imageUrls: ['https://cdn.example.com/a.jpg', 'https://cdn.example.com/b.jpg'],
});

let restoreEnv;
let calls;

beforeEach(() => {
  restoreEnv = snapshotEnv();
  clearEnv();
  process.env.AUDIT_API_KEY = KEY;
  process.env.OPENAI_API_KEY = 'sk-test-not-real';
  mockDns();
  calls = mockFetch();
  silenceConsoleError();
});

afterEach(() => {
  restoreEnv();
  mock.restoreAll();
});

test('A1: /api/analyze without x-api-key -> 401 and OpenAI is not called', async () => {
  const res = mockRes();
  await handler(mockReq({ headers: {}, body: validBody() }), res);
  assert.equal(res.statusCode, 401);
  assert.equal(openaiCalls(calls).length, 0);
  assert.equal(calls.length, 0);
});

test('A1: /api/analyze with wrong x-api-key -> 401 and OpenAI is not called', async () => {
  for (const wrong of ['wrong', KEY + 'x', KEY.slice(0, -1), '']) {
    const res = mockRes();
    await handler(mockReq({ headers: { 'x-api-key': wrong }, body: validBody() }), res);
    assert.equal(res.statusCode, 401, `key "${wrong}"`);
  }
  assert.equal(openaiCalls(calls).length, 0);
});

test('A1: /api/analyze with correct x-api-key -> 200 and OpenAI is called once', async () => {
  const res = mockRes();
  await handler(mockReq({ headers: { 'x-api-key': KEY }, body: validBody() }), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(openaiCalls(calls).length, 1);
});

test('A1: AUDIT_API_KEY unset -> fail closed 503 without leaking internals, provider not called', async () => {
  delete process.env.AUDIT_API_KEY;
  const res = mockRes();
  await handler(mockReq({ headers: { 'x-api-key': 'anything' }, body: validBody() }), res);
  assert.equal(res.statusCode, 503);
  assert.doesNotMatch(JSON.stringify(res.body), /AUDIT_API_KEY|OPENAI|env/i);
  assert.equal(openaiCalls(calls).length, 0);
});

test('A1: API key comparison is constant-time (timingSafeEqual, safe for different lengths)', () => {
  const spy = mock.method(crypto, 'timingSafeEqual');
  const res = mockRes();
  const ok = auth.requireApiKey(mockReq({ headers: { 'x-api-key': 'short' } }), res);
  assert.equal(ok, false);
  assert.equal(res.statusCode, 401);
  assert.equal(spy.mock.callCount(), 1);
  const [a, b] = spy.mock.calls[0].arguments;
  assert.equal(a.length, b.length);
});

test('A1: worker token comparison is constant-time and fails closed when unset', () => {
  process.env.AUDIT_WORKER_TOKEN = 'worker-secret-token';
  const spy = mock.method(crypto, 'timingSafeEqual');
  let res = mockRes();
  assert.equal(auth.requireWorkerToken(mockReq({ headers: { 'x-worker-token': 'nope' } }), res), false);
  assert.equal(res.statusCode, 401);
  assert.equal(spy.mock.callCount(), 1);

  res = mockRes();
  assert.equal(auth.requireWorkerToken(mockReq({ headers: { authorization: 'Bearer worker-secret-token' } }), res), true);

  delete process.env.AUDIT_WORKER_TOKEN;
  res = mockRes();
  assert.equal(auth.requireWorkerToken(mockReq({ headers: { 'x-worker-token': 'x' } }), res), false);
  assert.equal(res.statusCode, 503);
  assert.doesNotMatch(JSON.stringify(res.body), /AUDIT_WORKER_TOKEN/);
});
