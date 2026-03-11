import { requireApiKey } from '../lib/auth.js';
import { createAuditJob } from '../lib/queue.js';

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
    const job = await createAuditJob({ storeUrl, category, callbackUrl, callbackToken, metadata });
    return res.status(202).json({
      jobId: job.id,
      status: job.status,
      normalizedStoreUrl: job.normalized_store_url,
      category: job.category,
      createdAt: job.created_at,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
