import crypto from 'node:crypto';
import { NEUTRAL_UNAVAILABLE, readRawBody, sendError } from './http.js';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest();

// Constant-time string comparison. Both sides are hashed to a fixed length first, so
// neither content nor length of the expected secret leaks through timing.
export function safeEqual(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  return crypto.timingSafeEqual(sha256(provided), sha256(expected));
}

function failClosed(res, variableName) {
  // The variable name goes to server logs only, never to the client.
  console.error(`[auth] ${variableName} is not configured; refusing request`);
  res.status(503).json({ error: NEUTRAL_UNAVAILABLE });
  return false;
}

export function requireApiKey(req, res) {
  const expected = process.env.AUDIT_API_KEY;
  if (!expected) return failClosed(res, 'AUDIT_API_KEY');

  if (!safeEqual(req.headers['x-api-key'], expected)) {
    res.status(401).json({ error: 'Invalid API key' });
    return false;
  }

  return true;
}

export function requireWorkerToken(req, res) {
  const expected = process.env.AUDIT_WORKER_TOKEN;
  if (!expected) return failClosed(res, 'AUDIT_WORKER_TOKEN');

  const provided = req.headers['x-worker-token'] || req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!safeEqual(provided, expected)) {
    res.status(401).json({ error: 'Invalid worker token' });
    return false;
  }

  return true;
}

// Verifies the Shopify webhook HMAC over the RAW request body (not re-serialised JSON).
// Resolves to the raw body Buffer when valid; otherwise sends the error response and resolves to null.
// The route must set `export const config = { api: { bodyParser: false } }`.
export async function requireShopifyWebhook(req, res) {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) {
    failClosed(res, 'SHOPIFY_API_SECRET');
    return null;
  }

  const provided = req.headers['x-shopify-hmac-sha256'];
  if (!provided || typeof provided !== 'string') {
    res.status(401).json({ error: 'Missing Shopify webhook signature' });
    return null;
  }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (error) {
    sendError(res, error, 'shopify-webhook');
    return null;
  }

  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  if (!safeEqual(provided, digest)) {
    res.status(401).json({ error: 'Invalid Shopify webhook signature' });
    return null;
  }

  return rawBody;
}
