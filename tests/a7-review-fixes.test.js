import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mockReq, mockRes, mockDns, mockFetch, snapshotEnv, clearEnv, silenceConsoleError } from './helpers.js';
import { isPrivateAddress, safeFetch, parseSafeUrl } from '../lib/safe-fetch.js';
import { resetRateLimits, checkRateLimit, clientIp } from '../lib/rate-limit.js';
import { MAX_PAGES, PAGE_MAX_BYTES, TOTAL_BUDGET_MS, fetchAllAvailableProducts } from '../lib/shopify-products.js';
import fetchProductsHandler, { RATE_LIMIT } from '../api/fetch-products.js';

let restoreEnv;
beforeEach(() => {
  restoreEnv = snapshotEnv();
  clearEnv();
  resetRateLimits();
  silenceConsoleError();
});
afterEach(() => {
  restoreEnv();
  mock.restoreAll();
});

// ---- 1. SIIT ::ffff:0:0:0/96 ----------------------------------------------------------------------

test('A7: SIIT addresses (::ffff:0:a.b.c.d) are private, including ones embedding public IPv4', () => {
  for (const a of ['::ffff:0:127.0.0.1', '::ffff:0:7f00:1', '::ffff:0:10.0.0.1', '::ffff:0:93.184.216.34', '0:0:0:0:ffff:0:a00:1']) {
    assert.equal(isPrivateAddress(a), true, a);
    assert.throws(() => parseSafeUrl(`https://[${a}]/`), a);
  }
  // IPv4-mapped public address is still judged by its embedded v4 (unchanged behaviour)
  assert.equal(isPrivateAddress('::ffff:93.184.216.34'), false);
  assert.equal(isPrivateAddress('2606:4700:4700::1111'), false);
});

// ---- 2. credentials dropped on cross-origin redirect ------------------------------------------

test('A7: sensitive headers are stripped on a cross-origin redirect but kept on same-origin', async () => {
  mockDns();
  const calls = [];
  const hops = [
    'https://a.example.com/next', // same origin
    'https://b.example.com/final', // cross origin
  ];
  let i = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers });
    return i < hops.length ? new Response(null, { status: 302, headers: { location: hops[i++] } }) : new Response('ok');
  };
  await safeFetch('https://a.example.com/start', {
    fetchImpl,
    headers: { Authorization: 'Bearer secret', Cookie: 'sid=1', 'X-Api-Key': 'k', 'Proxy-Authorization': 'p', Accept: 'application/json' },
  });
  assert.equal(calls.length, 3);
  const has = (h, n) => Object.keys(h).some((k) => k.toLowerCase() === n);
  for (const n of ['authorization', 'cookie', 'x-api-key', 'proxy-authorization']) {
    assert.ok(has(calls[0].headers, n), `first hop keeps ${n}`);
    assert.ok(has(calls[1].headers, n), `same-origin hop keeps ${n}`);
    assert.ok(!has(calls[2].headers, n), `cross-origin hop drops ${n}`);
  }
  assert.ok(has(calls[2].headers, 'accept'));
});

test('A7: once dropped, credentials do not come back on a later hop to the original origin', async () => {
  mockDns();
  const calls = [];
  const hops = ['https://b.example.com/x', 'https://a.example.com/back'];
  let i = 0;
  const fetchImpl = async (url, init) => {
    calls.push(init.headers);
    return i < hops.length ? new Response(null, { status: 302, headers: { location: hops[i++] } }) : new Response('ok');
  };
  await safeFetch('https://a.example.com/start', { fetchImpl, headers: { authorization: 'Bearer secret' } });
  assert.equal(calls.length, 3);
  assert.ok(calls[0].authorization);
  assert.ok(!calls[1].authorization);
  assert.ok(!calls[2].authorization);
});

// ---- 3. fetch-products limits ---------------------------------------------------------------------

test('A7: fetch-products limits are tightened', () => {
  assert.equal(MAX_PAGES, 10);
  assert.equal(PAGE_MAX_BYTES, 5 * 1024 * 1024);
  assert.equal(TOTAL_BUDGET_MS, 20000);
});

test('A7: pagination stops at 10 pages and reports truncated', async () => {
  mockDns();
  let n = 0;
  const calls = mockFetch((url) => {
    if (!url.startsWith('https://shop.example.com/')) return undefined;
    n += 1;
    const products = Array.from({ length: 250 }, (_, k) => ({ id: n * 1000 + k, title: 'P', available: true, variants: [] }));
    return new Response(JSON.stringify({ products }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const data = await fetchAllAvailableProducts('shop.example.com');
  assert.equal(calls.length, 10);
  assert.equal(data.meta.pages, 10);
  assert.equal(data.meta.truncated, true);
});

test('A7: a page larger than 5 MB is refused', async () => {
  mockDns();
  mockFetch((url) => {
    if (!url.startsWith('https://shop.example.com/')) return undefined;
    return new Response('x'.repeat(5 * 1024 * 1024 + 10), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  await assert.rejects(() => fetchAllAvailableProducts('shop.example.com'), /too large/i);
});

test('A7: total time budget (20 s) is enforced between pages', async () => {
  mockDns();
  const realNow = Date.now;
  let clock = realNow();
  mock.method(Date, 'now', () => clock);
  mockFetch((url) => {
    if (!url.startsWith('https://shop.example.com/')) return undefined;
    clock += 8000; // each page "takes" 8 s
    const products = Array.from({ length: 250 }, (_, k) => ({ id: k, title: 'P', available: true, variants: [] }));
    return new Response(JSON.stringify({ products }), { status: 200 });
  });
  await assert.rejects(() => fetchAllAvailableProducts('shop.example.com'), /too long/i);
});

// ---- 3b. rate limit --------------------------------------------------------------------------------

test('A7: clientIp uses only the first x-forwarded-for address', () => {
  assert.equal(clientIp({ headers: { 'x-forwarded-for': '1.2.3.4, 9.9.9.9' } }), '1.2.3.4');
  assert.equal(clientIp({ headers: { 'x-forwarded-for': ' 5.6.7.8 ' } }), '5.6.7.8');
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: '8.8.8.8' } }), '8.8.8.8');
  assert.equal(clientIp({ headers: {} }), 'unknown');
});

test('A7: checkRateLimit blocks after the limit and resets after the window', () => {
  const opts = { limit: 2, windowMs: 1000 };
  assert.equal(checkRateLimit('k', { ...opts, now: 0 }).allowed, true);
  assert.equal(checkRateLimit('k', { ...opts, now: 10 }).allowed, true);
  const blocked = checkRateLimit('k', { ...opts, now: 20 });
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSec >= 1);
  assert.equal(checkRateLimit('other', { ...opts, now: 20 }).allowed, true);
  assert.equal(checkRateLimit('k', { ...opts, now: 1001 }).allowed, true);
});

test('A7: /api/fetch-products returns 429 with Retry-After past the per-IP limit; other IPs unaffected', async () => {
  mockDns();
  const calls = mockFetch();
  const hit = async (ip, xff) => {
    const res = mockRes();
    await fetchProductsHandler(mockReq({ headers: { 'x-forwarded-for': xff || ip }, body: { storeUrl: 'https://127.0.0.1' } }), res);
    return res;
  };
  for (let i = 0; i < RATE_LIMIT.limit; i += 1) assert.equal((await hit('1.1.1.1')).statusCode, 400);
  const blocked = await hit('1.1.1.1');
  assert.equal(blocked.statusCode, 429);
  assert.ok(Number(blocked.headers['retry-after']) >= 1);
  // spoofing extra XFF entries does not give a fresh bucket; only the first address counts
  assert.equal((await hit(null, '1.1.1.1, 7.7.7.7')).statusCode, 429);
  // a different client IP has its own bucket
  assert.equal((await hit('2.2.2.2')).statusCode, 400);
  assert.equal(calls.length, 0);
});
