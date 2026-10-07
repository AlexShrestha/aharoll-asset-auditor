import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { mockReq, mockRes, snapshotEnv, clearEnv, silenceConsoleError } from './helpers.js';

const KEY = 'test-audit-key-0123456789';
const WORKER = 'test-worker-token-0123456789';
const root = new URL('..', import.meta.url).pathname;

let restoreEnv;
beforeEach(() => {
  restoreEnv = snapshotEnv();
  clearEnv(); // SUPABASE_DB_URL etc. are intentionally unset -> misconfigured deployment
  process.env.AUDIT_API_KEY = KEY;
  process.env.AUDIT_WORKER_TOKEN = WORKER;
  silenceConsoleError();
});
afterEach(() => {
  restoreEnv();
  mock.restoreAll();
});

// Any ALL_CAPS_WITH_UNDERSCORE token, e.g. SUPABASE_DB_URL, would be an internal variable name.
const LEAK = /[A-Z][A-Z0-9]+_[A-Z0-9_]+/;

async function call(file, req) {
  const { default: handler } = await import(`../api/${file}`);
  const res = mockRes();
  await handler(req, res);
  return res;
}

const key = { 'x-api-key': KEY };

test('A4: queue endpoints with missing DB config -> 503 neutral, no variable names', async () => {
  const cases = [
    ['queue-audit.js', mockReq({ headers: key, body: { storeUrl: 'shop.example.com' } })],
    ['queue-status.js', mockReq({ method: 'GET', headers: key, query: { jobId: '00000000-0000-0000-0000-000000000000' } })],
    ['queue-worker.js', mockReq({ headers: { 'x-worker-token': WORKER }, body: {} })],
    ['audit-runs.js', mockReq({ headers: key, body: { workspaceId: 'w', storeId: 's' } })],
    ['audit-runs.js', mockReq({ method: 'GET', headers: key, query: { auditRunId: 'a' } })],
    ['auth/register-shopify-user.js', mockReq({ headers: key, body: { shopDomain: 'x.myshopify.com', accessToken: 'shpat_test_not_real' } })],
  ];
  for (const [file, req] of cases) {
    const res = await call(file, req);
    assert.equal(res.statusCode, 503, `${file} -> ${res.statusCode} ${JSON.stringify(res.body)}`);
    assert.doesNotMatch(JSON.stringify(res.body), LEAK, file);
  }
});

test('A4: missing AUDIT_API_KEY / AUDIT_WORKER_TOKEN -> 503 neutral on every queue endpoint', async () => {
  delete process.env.AUDIT_API_KEY;
  delete process.env.AUDIT_WORKER_TOKEN;
  const cases = [
    ['queue-audit.js', mockReq({ headers: key, body: { storeUrl: 'shop.example.com' } })],
    ['queue-status.js', mockReq({ method: 'GET', headers: key, query: { jobId: 'x' } })],
    ['queue-worker.js', mockReq({ headers: { 'x-worker-token': WORKER }, body: {} })],
  ];
  for (const [file, req] of cases) {
    const res = await call(file, req);
    assert.equal(res.statusCode, 503, file);
    assert.doesNotMatch(JSON.stringify(res.body), LEAK, file);
  }
});

test('A4: admin-session login with missing ADMIN_DASHBOARD_KEY -> 503 neutral', async () => {
  const res = await call('admin-session.js', mockReq({ body: { key: 'whatever' } }));
  assert.equal(res.statusCode, 503);
  assert.doesNotMatch(JSON.stringify(res.body), LEAK);
});

test('A4: unexpected errors are not echoed to clients (500 generic)', async () => {
  const { sendError } = await import('../lib/http.js');
  const res = mockRes();
  sendError(res, new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2'), 'test');
  assert.equal(res.statusCode, 500);
  assert.doesNotMatch(JSON.stringify(res.body), /ECONNREFUSED|hunter2|10\.0\.0\.5/);
});

test('A4: .env.example lists every required variable NAME, with no values', () => {
  const lines = readFileSync(join(root, '.env.example'), 'utf8').split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
  const entries = Object.fromEntries(lines.map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
  for (const name of ['AUDIT_API_KEY', 'AUDIT_WORKER_TOKEN', 'OPENAI_API_KEY', 'SHOPIFY_API_SECRET', 'SUPABASE_DB_URL', 'ADMIN_DASHBOARD_KEY', 'STORE_TOKEN_ENCRYPTION_KEY']) {
    assert.ok(name in entries, `${name} missing from .env.example`);
  }
  for (const [name, value] of Object.entries(entries)) assert.equal(value.trim(), '', `${name} must have no value`);
});

test('A4: every process.env.X used by server code is documented in .env.example', () => {
  const documented = new Set(readFileSync(join(root, '.env.example'), 'utf8').split('\n').map((l) => l.split('=')[0].trim()));
  const used = new Set();
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.js')) for (const m of readFileSync(full, 'utf8').matchAll(/process\.env\.([A-Z0-9_]+)/g)) used.add(m[1]);
    }
  };
  walk(join(root, 'api'));
  walk(join(root, 'lib'));
  used.delete('NODE_ENV');
  const missing = [...used].filter((n) => !documented.has(n));
  assert.deepEqual(missing, []);
});
