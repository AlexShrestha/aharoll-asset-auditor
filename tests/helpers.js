import { Readable } from 'node:stream';
import dns from 'node:dns';
import { mock } from 'node:test';

export function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; return this; },
  };
  return res;
}

export function mockReq({ method = 'POST', headers = {}, body, query = {} } = {}) {
  return { method, headers, body, query };
}

// A request whose body is an unparsed stream, as in a function with bodyParser disabled.
export function rawReq({ method = 'POST', headers = {}, raw = '' } = {}) {
  const stream = Readable.from([Buffer.from(raw)]);
  stream.method = method;
  stream.headers = headers;
  return stream;
}

const PUBLIC_IP = '93.184.216.34';

// Mocks dns.promises.lookup. `table` maps hostname -> array of addresses; others resolve to a public IP.
export function mockDns(table = {}) {
  const calls = [];
  mock.method(dns.promises, 'lookup', async (hostname) => {
    calls.push(hostname);
    const addrs = table[hostname] || [PUBLIC_IP];
    return addrs.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  });
  return calls;
}

// Mocks global fetch. Never touches the network. `respond(url, init)` may return a Response.
export function mockFetch(respond) {
  const calls = [];
  mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const href = String(url);
    calls.push({ url: href, init });
    const custom = respond ? await respond(href, init) : undefined;
    if (custom) return custom;
    if (href.startsWith('https://api.openai.com/')) {
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(sampleAnalysis()) } }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('ok', { status: 200, headers: { 'content-length': '2', 'content-type': 'image/jpeg' } });
  });
  return calls;
}

export function sampleAnalysis() {
  return {
    images: [{ index: 0, has_model: false, angle: 'front', background: 'white', quality: 'good', crop_style: 'product_only', shows_detail: false, variant_guess: 'black', brief: 'x' }],
    inconsistencies: [],
    severity: 'none',
    summary: 'ok',
    missing: [],
    seo_issues: [],
    scores: { asset_coverage: 90, variant_integrity: 90, seo_accessibility: 90 },
  };
}

export function openaiCalls(calls) {
  return calls.filter((c) => c.url.startsWith('https://api.openai.com/'));
}

const ENV_KEYS = [
  'AUDIT_API_KEY', 'AUDIT_WORKER_TOKEN', 'OPENAI_API_KEY', 'SHOPIFY_API_SECRET',
  'SUPABASE_DB_URL', 'ADMIN_DASHBOARD_KEY', 'STORE_TOKEN_ENCRYPTION_KEY',
];

export function snapshotEnv() {
  const saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  return () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  };
}

export function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

export const silenceConsoleError = () => mock.method(console, 'error', () => {});
