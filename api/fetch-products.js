import { declaredBodyTooLarge, sendError } from '../lib/http.js';
import { checkRateLimit, clientIp } from '../lib/rate-limit.js';
import { fetchAllAvailableProducts } from '../lib/shopify-products.js';

// Public, read-only endpoint used by the browser SPA to preview a store's products.
// It is not authenticated by design; abuse is limited by lib/safe-fetch.js (https + public hosts only,
// manual redirects, per-page timeout and size cap), by the page/size/time budget in fetchAllAvailableProducts
// and by a per-IP rate limit (best-effort only: in-memory, so per serverless instance; see lib/rate-limit.js).
export const RATE_LIMIT = { limit: 10, windowMs: 60_000 };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (declaredBodyTooLarge(req, 4096)) {
    return res.status(413).json({ error: 'Payload too large' });
  }

  const rate = checkRateLimit(`fetch-products:${clientIp(req)}`, RATE_LIMIT);
  if (!rate.allowed) {
    res.setHeader('Retry-After', String(rate.retryAfterSec));
    return res.status(429).json({ error: 'Too many requests' });
  }

  const storeUrl = req.body?.storeUrl;
  if (!storeUrl) {
    return res.status(400).json({ error: 'storeUrl is required' });
  }

  try {
    const data = await fetchAllAvailableProducts(storeUrl);
    return res.status(200).json(data);
  } catch (error) {
    return sendError(res, error, 'fetch-products');
  }
}
