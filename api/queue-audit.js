import { requireApiKey } from '../lib/auth.js';
import { createAuditJob } from '../lib/queue.js';
import { assertSafeCallbackUrl } from '../lib/safe-fetch.js';
import { assertSafeStoreUrl } from '../lib/shopify-products.js';
import { sendError } from '../lib/http.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireApiKey(req, res)) return;

  const { storeUrl, category = null, callbackUrl = null, callbackToken = null, metadata = null } = req.body || {};
  if (!storeUrl) {
    return res.status(400).json({ error: 'storeUrl is required' });
  }

  try {
    // Reject URLs the worker would later refuse to fetch (private hosts, http, odd ports) up front.
    assertSafeStoreUrl(storeUrl);
    if (callbackUrl) assertSafeCallbackUrl(callbackUrl);
    const job = await createAuditJob({ storeUrl, category, callbackUrl, callbackToken, metadata });
    return res.status(202).json({
      jobId: job.id,
      status: job.status,
      normalizedStoreUrl: job.normalized_store_url,
      category: job.category,
      createdAt: job.created_at,
    });
  } catch (error) {
    return sendError(res, error, 'queue-audit');
  }
}
