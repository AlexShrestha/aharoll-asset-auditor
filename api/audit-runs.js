import { requireApiKey } from '../lib/auth.js';
import { createPlatformAuditRun, getPlatformAuditRun } from '../lib/platform.js';
import { sendError } from '../lib/http.js';

export default async function handler(req, res) {
  if (!requireApiKey(req, res)) return;

  if (req.method === 'POST') {
    const {
      workspaceId,
      storeId,
      requestedByUserId = null,
      scope = { type: 'all_products' },
      requestedChecks = [],
      callbackUrl = null,
      callbackToken = null,
    } = req.body || {};

    if (!workspaceId || !storeId) {
      return res.status(400).json({ error: 'workspaceId and storeId are required' });
    }

    try {
      const result = await createPlatformAuditRun({
        workspaceId,
        storeId,
        requestedByUserId,
        scope,
        requestedChecks,
        callbackUrl,
        callbackToken,
      });
      return res.status(202).json(result);
    } catch (error) {
      return sendError(res, error, 'audit-runs');
    }
  }

  if (req.method === 'GET') {
    const { auditRunId } = req.query;
    if (!auditRunId) {
      return res.status(400).json({ error: 'auditRunId is required' });
    }

    try {
      const result = await getPlatformAuditRun(auditRunId);
      if (!result) return res.status(404).json({ error: 'Audit run not found' });
      return res.status(200).json(result);
    } catch (error) {
      return sendError(res, error, 'audit-runs');
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
