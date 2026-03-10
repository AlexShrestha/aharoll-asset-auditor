import { requireApiKey } from '../lib/auth.js';
import { getAuditJob } from '../lib/queue.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireApiKey(req, res)) return;

  const { jobId, limit = '50', offset = '0' } = req.query;
  if (!jobId) {
    return res.status(400).json({ error: 'jobId is required' });
  }

  try {
    const job = await getAuditJob(jobId, {
      limit: Math.min(Number.parseInt(limit, 10) || 50, 200),
      offset: Math.max(Number.parseInt(offset, 10) || 0, 0),
    });

    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    return res.status(200).json(job);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
