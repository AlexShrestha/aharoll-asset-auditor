// SSRF-hardened outbound fetch for URLs that come from users (store URLs, product/image URLs, callbacks).
//
// Rules: https only, no userinfo, default port only, every resolved address must be public,
// redirects are followed manually (max 3) with the same checks on every hop, timeout and body-size limits.
//
// Known limit: the hostname is resolved here and again by fetch(), so a DNS-rebinding attacker with a
// very short TTL could in theory answer differently the second time. Pinning the connection to the
// vetted address needs a custom dispatcher (undici) and is not done to avoid a new dependency.

import dns from 'node:dns';
import net from 'node:net';

export class SafeFetchError extends Error {
  // status: 400 for a refused URL, 502 for upstream problems (timeout, too large, too many redirects).
  constructor(message, { status = 400, code = 'blocked' } = {}) {
    super(message);
    this.name = 'SafeFetchError';
    this.status = status;
    this.code = code;
    this.expose = true;
  }
}

export const DEFAULT_TIMEOUT_MS = 15000;
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
export const MAX_REDIRECTS = 3;
// Credentials that must not follow a redirect to a different origin.
const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'x-api-key', 'proxy-authorization']);

function stripSensitiveHeaders(headers) {
  if (!headers) return headers;
  const entries = headers instanceof Headers ? [...headers.entries()] : Array.isArray(headers) ? headers : Object.entries(headers);
  return Object.fromEntries(entries.filter(([name]) => !SENSITIVE_HEADERS.has(String(name).toLowerCase())));
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.home.arpa'];

// ---- address classification ---------------------------------------------------------------

function parseIPv4(text) {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return octets.every((n) => n >= 0 && n <= 255) ? octets : null;
}

function isPrivateIPv4([a, b, c]) {
  return (
    a === 0 || // 0.0.0.0/8 "this network"
    a === 10 || // 10/8
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // 100.64/10 CGNAT
    (a === 169 && b === 254) || // link-local / cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12
    (a === 192 && b === 0 && c === 0) || // 192.0.0.0/24 IETF protocol assignments
    (a === 192 && b === 0 && c === 2) || // TEST-NET-1
    (a === 192 && b === 88 && c === 99) || // 6to4 relay
    (a === 192 && b === 168) || // 192.168/16
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224 // multicast, reserved, broadcast
  );
}

function parseIPv6(input) {
  let text = input.toLowerCase();
  if (text.includes('%')) return null; // zone ids are never legitimate here
  let tail = [];
  const lastColon = text.lastIndexOf(':');
  if (text.includes('.')) {
    const v4 = parseIPv4(text.slice(lastColon + 1));
    if (!v4) return null;
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    text = text.slice(0, lastColon + 1) + '0:0';
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const toGroups = (s) => (s === '' ? [] : s.split(':'));
  const head = toGroups(halves[0]);
  const rest = halves.length === 2 ? toGroups(halves[1]) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const groups = halves.length === 1 ? head : [...head, ...Array(missing).fill('0'), ...rest];
  const numbers = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? Number.parseInt(g, 16) : NaN));
  if (numbers.some(Number.isNaN)) return null;
  if (tail.length) {
    numbers[6] = tail[0];
    numbers[7] = tail[1];
  }
  return numbers;
}

const embeddedV4 = (hi, lo) => [hi >> 8, hi & 255, lo >> 8, lo & 255];

function isPrivateIPv6(g) {
  const zero = (from, to) => g.slice(from, to).every((x) => x === 0);
  if (zero(0, 8)) return true; // ::
  if (zero(0, 7) && g[7] === 1) return true; // ::1
  if (zero(0, 5) && g[5] === 0xffff) return isPrivateIPv4(embeddedV4(g[6], g[7])); // ::ffff:a.b.c.d
  if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return true; // ::ffff:0:0:0/96 SIIT (RFC 6145), maps to arbitrary IPv4
  if (zero(0, 6)) return true; // ::/96 deprecated IPv4-compatible
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return isPrivateIPv4(embeddedV4(g[6], g[7])); // NAT64
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true; // local-use NAT64
  if (g[0] === 0x2002) return isPrivateIPv4(embeddedV4(g[1], g[2])); // 6to4
  if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x0100 && zero(1, 4)) return true; // discard-only
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  return false;
}

// True when `address` is NOT a publicly routable unicast address (or cannot be parsed).
export function isPrivateAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const octets = parseIPv4(address);
    return !octets || isPrivateIPv4(octets);
  }
  if (family === 6) {
    const groups = parseIPv6(address);
    return !groups || isPrivateIPv6(groups);
  }
  return true;
}

// ---- URL validation ---------------------------------------------------------------------------

// Synchronous checks (no DNS). Returns the parsed URL or throws SafeFetchError.
export function parseSafeUrl(input) {
  if (typeof input !== 'string' && !(input instanceof URL)) {
    throw new SafeFetchError('URL is required');
  }
  let url;
  try {
    url = new URL(String(input));
  } catch {
    throw new SafeFetchError('URL is not valid');
  }
  if (url.protocol !== 'https:') throw new SafeFetchError('Only https URLs are allowed');
  if (url.username || url.password) throw new SafeFetchError('URLs with credentials are not allowed');
  if (url.port && url.port !== '443') throw new SafeFetchError('Non-standard ports are not allowed');

  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) throw new SafeFetchError('URL is not valid');
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (net.isIP(bare)) {
    if (isPrivateAddress(bare)) throw new SafeFetchError('URL host is not allowed');
  } else if (host === 'localhost' || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s)) || !host.includes('.')) {
    throw new SafeFetchError('URL host is not allowed');
  }
  return url;
}

// Callback URLs are stored and called later, so validate them (sync) when they are accepted.
export function assertSafeCallbackUrl(input) {
  if (typeof input !== 'string' || input.length > 2048) {
    throw new SafeFetchError('callbackUrl must be a URL string');
  }
  return parseSafeUrl(input);
}

// Sync checks + DNS resolution; every returned address must be public.
export async function assertSafeUrl(input) {
  const url = parseSafeUrl(input);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return url;

  let records;
  try {
    records = await dns.promises.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new SafeFetchError('URL host could not be resolved');
  }
  if (!Array.isArray(records) || records.length === 0) {
    throw new SafeFetchError('URL host could not be resolved');
  }
  if (records.some((r) => isPrivateAddress(r.address))) {
    throw new SafeFetchError('URL host is not allowed');
  }
  return url;
}

// ---- fetching --------------------------------------------------------------------------------

function timeoutError() {
  return new SafeFetchError('Request timed out', { status: 502, code: 'timeout' });
}

async function discard(response) {
  try {
    await response.body?.cancel();
  } catch {
    // ignore
  }
}

// Fetch with SSRF protection. Returns the final Response (headers received; body not yet read).
// Options: timeoutMs, fetchImpl, signal (internal), plus ordinary fetch init fields.
// Redirects are followed (max 3, re-validated each hop) only for GET/HEAD; other methods return the 3xx as is.
export async function safeFetch(input, options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl, signal: externalSignal, ...init } = options;
  const doFetch = fetchImpl || ((...args) => globalThis.fetch(...args));
  const method = String(init.method || 'GET').toUpperCase();
  const canFollow = method === 'GET' || method === 'HEAD';

  const controller = new AbortController();
  const signal = externalSignal || controller.signal;
  const timer = externalSignal ? null : setTimeout(() => controller.abort(), timeoutMs);

  try {
    let target = input;
    let requestHeaders = init.headers;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const url = await assertSafeUrl(target);
      let response;
      try {
        response = await doFetch(url.href, {
          ...init,
          method,
          redirect: 'manual',
          signal,
          headers: { 'User-Agent': 'AhaRoll-Asset-Auditor/1.0', ...(requestHeaders || {}) },
        });
      } catch (error) {
        if (error?.name === 'AbortError' || signal.aborted) throw timeoutError();
        throw new SafeFetchError('Request failed', { status: 502, code: 'network' });
      }

      if (!REDIRECT_STATUSES.has(response.status)) return response;
      const location = response.headers.get('location');
      if (!canFollow || !location) return response;

      await discard(response);
      if (hop === MAX_REDIRECTS) {
        throw new SafeFetchError('Too many redirects', { status: 502, code: 'redirects' });
      }
      let next;
      try {
        next = new URL(location, url);
      } catch {
        throw new SafeFetchError('Redirect target is not valid', { status: 502, code: 'redirect' });
      }
      // Cross-origin hop: never forward credentials to the new origin.
      if (next.origin !== url.origin) requestHeaders = stripSensitiveHeaders(requestHeaders);
      target = next.href;
    }
    throw new SafeFetchError('Too many redirects', { status: 502, code: 'redirects' });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const tooLarge = () => new SafeFetchError('Response too large', { status: 502, code: 'too_large' });

// Reads a body with a hard size cap. onOverflow: 'throw' (default) or 'truncate'.
export async function readBodyLimited(response, { maxBytes = DEFAULT_MAX_BYTES, onOverflow = 'throw' } = {}) {
  const declared = Number.parseInt(response.headers.get('content-length') || '', 10);
  if (Number.isFinite(declared) && declared > maxBytes && onOverflow === 'throw') {
    await discard(response);
    throw tooLarge();
  }
  if (!response.body) return { buffer: Buffer.alloc(0), truncated: false, bytes: 0 };

  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > maxBytes) {
        if (onOverflow === 'throw') throw tooLarge();
        truncated = true;
        chunks.push(value.subarray(0, value.length - (bytes - maxBytes)));
        bytes = maxBytes;
        break;
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof SafeFetchError) {
      await reader.cancel().catch(() => {});
      throw error;
    }
    throw error?.name === 'AbortError' ? timeoutError() : new SafeFetchError('Request failed', { status: 502, code: 'network' });
  } finally {
    if (truncated) await reader.cancel().catch(() => {});
  }
  return { buffer: Buffer.concat(chunks), truncated, bytes };
}

// safeFetch + size-limited body read, both under a single timeout.
export async function safeFetchBuffer(input, options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES, onOverflow, ...rest } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await safeFetch(input, { ...rest, signal: controller.signal });
    const body = await readBodyLimited(response, { maxBytes, onOverflow });
    return { response, ...body };
  } finally {
    clearTimeout(timer);
  }
}

export async function safeFetchText(input, options = {}) {
  const result = await safeFetchBuffer(input, options);
  return { ...result, text: result.buffer.toString('utf8') };
}

export async function safeFetchJson(input, options = {}) {
  const result = await safeFetchText(input, options);
  try {
    return { ...result, json: JSON.parse(result.text) };
  } catch {
    throw new SafeFetchError('Response was not valid JSON', { status: 502, code: 'bad_json' });
  }
}
