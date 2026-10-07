import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mockReq, mockRes, mockDns, mockFetch, openaiCalls, snapshotEnv, clearEnv, silenceConsoleError } from './helpers.js';

const safe = await import('../lib/safe-fetch.js').catch(() => ({}));
const { default: analyzeHandler } = await import('../api/analyze.js');
const { default: fetchProductsHandler } = await import('../api/fetch-products.js');
const { default: queueAuditHandler } = await import('../api/queue-audit.js');

const KEY = 'test-audit-key-0123456789';

let restoreEnv;
beforeEach(() => {
  restoreEnv = snapshotEnv();
  clearEnv();
  process.env.AUDIT_API_KEY = KEY;
  process.env.OPENAI_API_KEY = 'sk-test-not-real';
  silenceConsoleError();
});
afterEach(() => {
  restoreEnv();
  mock.restoreAll();
});

function recordingFetch(respond) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return respond ? respond(String(url), init) : new Response('ok', { status: 200 });
  };
  return { calls, fetchImpl };
}

const BLOCKED_URLS = [
  'https://127.0.0.1/',
  'https://127.1.2.3/x',
  'https://169.254.169.254/latest/meta-data/',
  'https://10.0.0.5/',
  'https://172.16.0.1/',
  'https://172.31.255.255/',
  'https://192.168.1.1/',
  'https://100.64.0.1/',
  'https://0.0.0.0/',
  'https://224.0.0.1/',
  'https://255.255.255.255/',
  'https://[::1]/',
  'https://[::]/',
  'https://[::ffff:127.0.0.1]/',
  'https://[::ffff:7f00:1]/',
  'https://[::ffff:10.0.0.1]/',
  'https://[fe80::1]/',
  'https://[fc00::1]/',
  'https://[fd12:3456::1]/',
  'https://[ff02::1]/',
  'https://[64:ff9b::7f00:1]/',
  'https://[2002:7f00:1::]/',
  'https://2130706433/',
  'https://0x7f.0.0.1/',
  'https://localhost/',
  'https://foo.localhost/',
  'http://example.com/',
  'file:///etc/passwd',
  'gopher://example.com/',
  'ftp://example.com/',
  'javascript:alert(1)',
  'https://user:pass@example.com/',
  'https://user@example.com/',
  'https://example.com:8443/',
  'https://example.com:22/',
  'not a url',
];

test('A2: safe-fetch module exposes safeFetch', () => {
  assert.equal(typeof safe.safeFetch, 'function');
});

for (const url of BLOCKED_URLS) {
  test(`A2: safeFetch refuses ${url} without calling fetch`, async () => {
    mockDns();
    const { calls, fetchImpl } = recordingFetch();
    await assert.rejects(() => safe.safeFetch(url, { fetchImpl }));
    assert.equal(calls.length, 0);
  });
}

test('A2: DNS name resolving to a private IP is refused', async () => {
  mockDns({ 'internal.example.com': ['10.1.2.3'], 'meta.example.com': ['169.254.169.254'], 'v6.example.com': ['::1'] });
  const { calls, fetchImpl } = recordingFetch();
  for (const host of ['internal.example.com', 'meta.example.com', 'v6.example.com']) {
    await assert.rejects(() => safe.safeFetch(`https://${host}/`, { fetchImpl }), host);
  }
  assert.equal(calls.length, 0);
});

test('A2: DNS name with ANY private address (mixed answers) is refused', async () => {
  mockDns({ 'mixed.example.com': ['93.184.216.34', '10.0.0.9'] });
  const { calls, fetchImpl } = recordingFetch();
  await assert.rejects(() => safe.safeFetch('https://mixed.example.com/', { fetchImpl }));
  assert.equal(calls.length, 0);
});

test('A2: redirect from public to private host is refused on the second hop', async () => {
  mockDns();
  const { calls, fetchImpl } = recordingFetch((url) =>
    new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data/' } }));
  await assert.rejects(() => safe.safeFetch('https://public.example.com/start', { fetchImpl }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://public.example.com/start');
  assert.equal(calls[0].init.redirect, 'manual');
});

test('A2: redirect to http:// or to a DNS-private name is refused', async () => {
  mockDns({ 'internal.example.com': ['192.168.0.10'] });
  for (const location of ['http://public.example.com/x', 'https://internal.example.com/x', '//127.0.0.1/x']) {
    const { calls, fetchImpl } = recordingFetch(() => new Response(null, { status: 301, headers: { location } }));
    await assert.rejects(() => safe.safeFetch('https://public.example.com/start', { fetchImpl }), location);
    assert.equal(calls.length, 1, location);
  }
});

test('A2: more than 3 redirects is refused; up to 3 are followed', async () => {
  mockDns();
  let n = 0;
  const loop = recordingFetch(() => new Response(null, { status: 302, headers: { location: `https://public.example.com/r${++n}` } }));
  await assert.rejects(() => safe.safeFetch('https://public.example.com/r0', { fetchImpl: loop.fetchImpl }));
  assert.equal(loop.calls.length, 4);

  let m = 0;
  const ok = recordingFetch(() => (m++ < 3
    ? new Response(null, { status: 302, headers: { location: `https://public.example.com/ok${m}` } })
    : new Response('done', { status: 200 })));
  const res = await safe.safeFetch('https://public.example.com/ok0', { fetchImpl: ok.fetchImpl });
  assert.equal(res.status, 200);
  assert.equal(ok.calls.length, 4);
});

test('A2: non-GET requests do not follow redirects', async () => {
  mockDns();
  const { calls, fetchImpl } = recordingFetch(() => new Response(null, { status: 307, headers: { location: 'https://169.254.169.254/' } }));
  const res = await safe.safeFetch('https://public.example.com/hook', { fetchImpl, method: 'POST', body: '{}' });
  assert.equal(res.status, 307);
  assert.equal(calls.length, 1);
});

test('A2: timeout aborts a hanging request', async () => {
  mockDns();
  const fetchImpl = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  await assert.rejects(() => safe.safeFetch('https://public.example.com/slow', { fetchImpl, timeoutMs: 40 }), /timed out/i);
});

test('A2: response body larger than the limit is refused (content-length and streamed)', async () => {
  mockDns();
  const big = 'x'.repeat(5000);
  const withHeader = recordingFetch(() => new Response(big, { status: 200, headers: { 'content-length': String(big.length) } }));
  await assert.rejects(() => safe.safeFetchText('https://public.example.com/a', { fetchImpl: withHeader.fetchImpl, maxBytes: 1000 }), /too large/i);

  const noHeader = recordingFetch(() => new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode(big)); c.close(); },
  }), { status: 200 }));
  await assert.rejects(() => safe.safeFetchText('https://public.example.com/b', { fetchImpl: noHeader.fetchImpl, maxBytes: 1000 }), /too large/i);

  const small = recordingFetch(() => new Response('hello', { status: 200 }));
  const { text } = await safe.safeFetchText('https://public.example.com/c', { fetchImpl: small.fetchImpl, maxBytes: 1000 });
  assert.equal(text, 'hello');
});

test('A2: allowed public https URL is fetched with manual redirect handling', async () => {
  mockDns();
  const { calls, fetchImpl } = recordingFetch();
  const res = await safe.safeFetch('https://cdn.example.com/a.jpg', { fetchImpl });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.redirect, 'manual');
});

// ---- Handler level: the analyze endpoint, fetch-products, queue-audit -------------------------

async function callAnalyze(body, headers = { 'x-api-key': KEY }) {
  const res = mockRes();
  await analyzeHandler(mockReq({ headers, body }), res);
  return res;
}

test('A2: /api/analyze rejects private/odd imageUrls with 400 and makes no outbound call', async () => {
  mockDns();
  const calls = mockFetch();
  for (const bad of ['https://169.254.169.254/a.png', 'https://127.0.0.1/a.png', 'http://cdn.example.com/a.png', 'file:///etc/passwd', 'https://[::1]/a.png']) {
    const res = await callAnalyze({ title: 'T', imageUrls: [bad] });
    assert.equal(res.statusCode, 400, bad);
  }
  assert.equal(calls.length, 0);
});

test('A2: /api/analyze rejects an imageUrl whose DNS name resolves to a private IP before calling OpenAI', async () => {
  mockDns({ 'sneaky.example.com': ['10.0.0.7'] });
  const calls = mockFetch();
  const res = await callAnalyze({ title: 'T', imageUrls: ['https://sneaky.example.com/a.png'] });
  assert.equal(res.statusCode, 400);
  assert.equal(calls.length, 0);
});

test('A2: /api/analyze rejects a private productUrl and never fetches it', async () => {
  mockDns();
  const calls = mockFetch();
  for (const productUrl of ['http://127.0.0.1/admin', 'https://169.254.169.254/latest', 'https://10.0.0.1/x']) {
    const res = await callAnalyze({ title: 'T', productUrl, imageUrls: ['https://cdn.example.com/a.png'] });
    assert.equal(res.statusCode, 400, productUrl);
  }
  assert.equal(calls.length, 0);
});

test('A2: /api/analyze limits the number of imageUrls and the body size', async () => {
  mockDns();
  const calls = mockFetch();
  const many = Array.from({ length: 51 }, (_, i) => `https://cdn.example.com/${i}.jpg`);
  let res = await callAnalyze({ title: 'T', imageUrls: many });
  assert.equal(res.statusCode, 400);

  res = mockRes();
  await analyzeHandler(mockReq({ headers: { 'x-api-key': KEY, 'content-length': String(300 * 1024) }, body: { title: 'T', imageUrls: ['https://cdn.example.com/a.jpg'] } }), res);
  assert.equal(res.statusCode, 413);

  res = await callAnalyze({ title: 'T'.repeat(5000), imageUrls: ['https://cdn.example.com/a.jpg'] });
  assert.equal(res.statusCode, 400);
  assert.equal(openaiCalls(calls).length, 0);
});

test('A2: /api/analyze measures public page and images only through guarded fetch (redirect: manual)', async () => {
  mockDns();
  const calls = mockFetch();
  const res = await callAnalyze({
    title: 'T',
    productUrl: 'https://shop.example.com/products/t',
    imageUrls: ['https://cdn.example.com/a.jpg'],
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const outbound = calls.filter((c) => !c.url.startsWith('https://api.openai.com/'));
  assert.ok(outbound.length >= 2);
  for (const c of outbound) assert.equal(c.init.redirect, 'manual', c.url);
});

test('A2: /api/fetch-products refuses private and non-https store URLs without fetching', async () => {
  mockDns({ 'intranet.example.com': ['10.0.0.2'] });
  const calls = mockFetch();
  for (const storeUrl of ['https://169.254.169.254', 'http://127.0.0.1:8080', 'https://localhost', 'https://intranet.example.com', 'file:///etc/passwd', 'http://shop.example.com', 'https://[::1]']) {
    const res = mockRes();
    await fetchProductsHandler(mockReq({ body: { storeUrl } }), res);
    assert.equal(res.statusCode, 400, storeUrl);
  }
  assert.equal(calls.length, 0);
});

test('A2: /api/fetch-products works for a public store, uses manual redirects and refuses a private pagination Link', async () => {
  mockDns();
  let page = 0;
  const calls = mockFetch((url) => {
    if (!url.startsWith('https://shop.example.com/')) return undefined;
    page += 1;
    const body = JSON.stringify({ products: [{ id: page, title: `P${page}`, available: true, variants: [] }] });
    const headers = { 'content-type': 'application/json' };
    if (page === 1) headers.link = '<https://169.254.169.254/products.json?page_info=x>; rel="next"';
    return new Response(body, { status: 200, headers });
  });
  const res = mockRes();
  await fetchProductsHandler(mockReq({ body: { storeUrl: 'shop.example.com' } }), res);
  assert.ok(res.statusCode >= 400, `expected failure, got ${res.statusCode}`);
  assert.ok(!calls.some((c) => c.url.includes('169.254.169.254')));

  mock.restoreAll();
  silenceConsoleError();
  mockDns();
  const calls2 = mockFetch((url) => new Response(JSON.stringify({ products: [{ id: 1, title: 'P', available: true, variants: [] }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
  const res2 = mockRes();
  await fetchProductsHandler(mockReq({ body: { storeUrl: 'shop.example.com' } }), res2);
  assert.equal(res2.statusCode, 200, JSON.stringify(res2.body));
  assert.equal(res2.body.products.length, 1);
  assert.equal(calls2[0].init.redirect, 'manual');
});

test('A2: /api/queue-audit refuses private callbackUrl and private storeUrl (400, before touching the DB)', async () => {
  mockDns();
  mockFetch();
  for (const body of [
    { storeUrl: 'shop.example.com', callbackUrl: 'https://10.0.0.1/hook' },
    { storeUrl: 'shop.example.com', callbackUrl: 'http://example.com/hook' },
    { storeUrl: 'https://169.254.169.254' },
  ]) {
    const res = mockRes();
    await queueAuditHandler(mockReq({ headers: { 'x-api-key': KEY }, body }), res);
    assert.equal(res.statusCode, 400, JSON.stringify(body));
  }
});
