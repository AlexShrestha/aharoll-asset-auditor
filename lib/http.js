// Shared HTTP helpers for Vercel functions: typed errors, neutral error responses, raw body reading.

// Thrown when the deployment is misconfigured (missing secret / DB URL). Never shown to clients.
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

// Error whose message is safe to show to the caller.
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.expose = true;
  }
}

export const NEUTRAL_UNAVAILABLE = 'Service temporarily unavailable';

export function sendUnavailable(res, detailForLogs) {
  console.error(`[config] ${detailForLogs}`);
  return res.status(503).json({ error: NEUTRAL_UNAVAILABLE });
}

// Converts any thrown error into a response that does not leak internals.
export function sendError(res, error, context = 'api') {
  if (error instanceof ConfigError) {
    return sendUnavailable(res, `${context}: ${error.message}`);
  }
  if (error && error.expose === true && Number.isInteger(error.status)) {
    return res.status(error.status).json({ error: error.message });
  }
  console.error(`[${context}] unexpected error:`, error);
  return res.status(500).json({ error: 'Internal server error' });
}

export const DEFAULT_BODY_LIMIT = 256 * 1024;

// Rejects requests that declare a body larger than `limit` (cheap pre-check; the platform enforces its own cap too).
export function declaredBodyTooLarge(req, limit = DEFAULT_BODY_LIMIT) {
  const declared = Number.parseInt(req.headers?.['content-length'], 10);
  return Number.isFinite(declared) && declared > limit;
}

// Reads the unparsed request body. Requires the route to disable the body parser
// (`export const config = { api: { bodyParser: false } }`). Throws HttpError(413) when above `limit`.
export async function readRawBody(req, limit = 1024 * 1024) {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  if (typeof req.rawBody === 'string') return Buffer.from(req.rawBody, 'utf8');

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > limit) throw new HttpError(413, 'Payload too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}
