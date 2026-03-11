import { requireShopifyWebhook } from '../../../lib/auth.js';
import { markStoreUninstalled } from '../../../lib/platform.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireShopifyWebhook(req, res)) return;

  try {
    const shopDomain = req.headers['x-shopify-shop-domain'] || req.body?.shop_domain;
    if (!shopDomain) {
      return res.status(400).json({ error: 'shop domain is required' });
    }

    const result = await markStoreUninstalled({ shopDomain, payload: req.body || {} });
    return res.status(200).json({ ok: true, result });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
