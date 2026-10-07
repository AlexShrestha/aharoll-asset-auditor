import { declaredBodyTooLarge, sendError } from '../lib/http.js';
import { fetchAllAvailableProducts } from '../lib/shopify-products.js';

// Public, read-only endpoint used by the browser SPA to preview a store's products.
// It is not authenticated by design; abuse is limited by lib/safe-fetch.js (https + public hosts only,
// manual redirects, per-page timeout and size cap) and by the page/time budget in fetchAllAvailableProducts.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (declaredBodyTooLarge(req, 4096)) {
    return res.status(413).json({ error: 'Payload too large' });
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
