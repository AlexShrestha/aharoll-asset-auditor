import { requireShopifyWebhook } from '../../../lib/auth.js';
import { sendError } from '../../../lib/http.js';
import { markStoreUninstalled } from '../../../lib/platform.js';

// The HMAC must be computed over the exact bytes Shopify sent, so the body parser is disabled.
export const config = { api: { bodyParser: false } };

export function createUninstalledHandler({ markStoreUninstalled: markUninstalled }) {
  return async function handler(req, res) {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const rawBody = await requireShopifyWebhook(req, res);
    if (!rawBody) return;

    try {
      let payload;
      try {
        payload = JSON.parse(rawBody.toString('utf8'));
      } catch {
        return res.status(400).json({ error: 'Invalid JSON body' });
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return res.status(400).json({ error: 'Invalid JSON body' });
      }

      // The payload is covered by the signature; the shop-domain header is not. Prefer the payload
      // and reject a header that contradicts it.
      const payloadDomain = payload.myshopify_domain || payload.shop_domain || null;
      const headerDomain = req.headers['x-shopify-shop-domain'] || null;
      if (payloadDomain && headerDomain && String(payloadDomain).toLowerCase() !== String(headerDomain).toLowerCase()) {
        return res.status(400).json({ error: 'shop domain mismatch' });
      }
      const shopDomain = payloadDomain || headerDomain;
      if (!shopDomain) {
        return res.status(400).json({ error: 'shop domain is required' });
      }

      const result = await markUninstalled({ shopDomain: String(shopDomain), payload });
      return res.status(200).json({ ok: true, result });
    } catch (error) {
      return sendError(res, error, 'shopify-webhook-uninstalled');
    }
  };
}

export default createUninstalledHandler({ markStoreUninstalled });
