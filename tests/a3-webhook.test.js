import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mockRes, rawReq, snapshotEnv, clearEnv, silenceConsoleError } from './helpers.js';

const mod = await import('../api/shopify/webhooks/uninstalled.js');
const SECRET = 'shpss_test_secret_not_real';

const sign = (raw, secret = SECRET) => crypto.createHmac('sha256', secret).update(raw).digest('base64');

let restoreEnv;
beforeEach(() => {
  restoreEnv = snapshotEnv();
  clearEnv();
  process.env.SHOPIFY_API_SECRET = SECRET;
  silenceConsoleError();
});
afterEach(() => {
  restoreEnv();
  mock.restoreAll();
});

function build() {
  const calls = [];
  const handler = mod.createUninstalledHandler({
    markStoreUninstalled: async (args) => { calls.push(args); return { updated: 1 }; },
  });
  return { calls, handler };
}

const RAW = '{"id":123,"name":"demo","myshopify_domain":"demo.myshopify.com","domain":"demo.example.com"}';

async function send(handler, { raw, signature, extraHeaders = {} }) {
  const headers = { ...extraHeaders };
  if (signature !== undefined) headers['x-shopify-hmac-sha256'] = signature;
  const res = mockRes();
  await handler(rawReq({ headers, raw }), res);
  return res;
}

test('A3: webhook route disables the body parser so the raw body can be verified', () => {
  assert.equal(mod.config?.api?.bodyParser, false);
});

test('A3: valid signature over the RAW body -> 200 and store marked uninstalled', async () => {
  const { calls, handler } = build();
  const res = await send(handler, { raw: RAW, signature: sign(RAW), extraHeaders: { 'x-shopify-shop-domain': 'demo.myshopify.com' } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].shopDomain, 'demo.myshopify.com');
});

test('A3: signature is checked against exact bytes (whitespace/escapes/key order preserved)', async () => {
  const { calls, handler } = build();
  const weird = '{ "myshopify_domain" : "demo.myshopify.com",\n  "note": "caf\\u00e9 \\/ slash" }\n';
  const res = await send(handler, { raw: weird, signature: sign(weird) });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(calls.length, 1);
});

test('A3: semantically identical but reformatted JSON with the original signature -> 401', async () => {
  const { calls, handler } = build();
  const reformatted = JSON.stringify(JSON.parse(RAW), null, 2);
  assert.notEqual(reformatted, RAW);
  const res = await send(handler, { raw: reformatted, signature: sign(RAW) });
  assert.equal(res.statusCode, 401);
  assert.equal(calls.length, 0);
});

test('A3: wrong / malformed / missing / different-length signature -> 401, handler not run', async () => {
  const { calls, handler } = build();
  for (const signature of [sign(RAW, 'other-secret'), 'AAAA', '', 'x'.repeat(200), undefined]) {
    const res = await send(handler, { raw: RAW, signature });
    assert.equal(res.statusCode, 401, String(signature));
  }
  assert.equal(calls.length, 0);
});

test('A3: SHOPIFY_API_SECRET unset -> fail closed 503 with neutral message', async () => {
  delete process.env.SHOPIFY_API_SECRET;
  const { calls, handler } = build();
  const res = await send(handler, { raw: RAW, signature: sign(RAW) });
  assert.equal(res.statusCode, 503);
  assert.doesNotMatch(JSON.stringify(res.body), /SHOPIFY|SECRET/);
  assert.equal(calls.length, 0);
});

test('A3: signed payload domain wins; conflicting unsigned header -> 400', async () => {
  const { calls, handler } = build();
  const res = await send(handler, { raw: RAW, signature: sign(RAW), extraHeaders: { 'x-shopify-shop-domain': 'victim.myshopify.com' } });
  assert.equal(res.statusCode, 400);
  assert.equal(calls.length, 0);
});

test('A3: non-POST -> 405; invalid JSON with valid signature -> 400; oversized body -> 413', async () => {
  const { handler } = build();
  let res = mockRes();
  await handler(rawReq({ method: 'GET', headers: {}, raw: '' }), res);
  assert.equal(res.statusCode, 405);

  const bad = 'not json';
  res = await send(handler, { raw: bad, signature: sign(bad) });
  assert.equal(res.statusCode, 400);

  const huge = JSON.stringify({ myshopify_domain: 'demo.myshopify.com', pad: 'x'.repeat(2 * 1024 * 1024) });
  res = await send(handler, { raw: huge, signature: sign(huge) });
  assert.equal(res.statusCode, 413);
});

test('A3: every api/ route has an auth guard (audit regression)', async () => {
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const root = new URL('../api', import.meta.url).pathname;
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full); else if (name.endsWith('.js')) files.push(full);
    }
  };
  walk(root);
  // fetch-products is intentionally public (read-only product listing used by the public SPA); it is hardened by safe-fetch.
  const PUBLIC = new Set(['fetch-products.js', 'admin-session.js']);
  const GUARDS = /requireApiKey|requireWorkerToken|requireAdminSession|requireShopifyWebhook/;
  const unguarded = files.filter((f) => !PUBLIC.has(f.split('/').pop()) && !GUARDS.test(readFileSync(f, 'utf8')));
  assert.deepEqual(unguarded.map((f) => f.replace(root, 'api')), []);
});
