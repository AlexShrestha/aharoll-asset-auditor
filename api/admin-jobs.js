import { requireAdminSession } from '../lib/admin-session.js';
import { listAuditJobs } from '../lib/queue.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireAdminSession(req, res)) return;

  const { status = 'all', limit = '25', offset = '0', search = '' } = req.query;

  try {
    const result = await listAuditJobs({
      status,
      limit: Math.min(Number.parseInt(limit, 10) || 25, 100),
      offset: Math.max(Number.parseInt(offset, 10) || 0, 0),
      search: String(search || ''),
    });

    return res.status(200).json(result);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
