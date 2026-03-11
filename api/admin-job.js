import { requireAdminSession } from '../lib/admin-session.js';
import { getAuditJobDetail } from '../lib/queue.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireAdminSession(req, res)) return;

  const { jobId, limit = '100', offset = '0', productStatus = 'all', severity = 'all' } = req.query;
  if (!jobId) {
    return res.status(400).json({ error: 'jobId is required' });
  }

  try {
    const result = await getAuditJobDetail(jobId, {
      limit: Math.min(Number.parseInt(limit, 10) || 100, 250),
      offset: Math.max(Number.parseInt(offset, 10) || 0, 0),
      productStatus,
      severity,
    });

    if (!result) {
      return res.status(404).json({ error: 'Job not found' });
    }

    return res.status(200).json(result);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
