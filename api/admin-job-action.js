import { requireAdminSession } from '../lib/admin-session.js';
import { restartAuditJob, stopAuditJob } from '../lib/queue.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireAdminSession(req, res)) return;

  const { jobId, action } = req.body || {};
  if (!jobId || !action) {
    return res.status(400).json({ error: 'jobId and action are required' });
  }

  try {
    const result = action === 'stop'
      ? await stopAuditJob(jobId)
      : action === 'restart'
        ? await restartAuditJob(jobId)
        : null;

    if (!result) {
      return res.status(action === 'stop' || action === 'restart' ? 404 : 400).json({
        error: action === 'stop' || action === 'restart' ? 'Job not found' : 'Unsupported action',
      });
    }

    return res.status(200).json({ job: result });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
