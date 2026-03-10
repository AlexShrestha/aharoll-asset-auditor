export function requireApiKey(req, res) {
  const expected = process.env.AUDIT_API_KEY;
  if (!expected) {
    res.status(500).json({ error: 'AUDIT_API_KEY not configured' });
    return false;
  }

  const provided = req.headers['x-api-key'];
  if (!provided || provided !== expected) {
    res.status(401).json({ error: 'Invalid API key' });
    return false;
  }

  return true;
}

export function requireWorkerToken(req, res) {
  const expected = process.env.AUDIT_WORKER_TOKEN;
  if (!expected) {
    res.status(500).json({ error: 'AUDIT_WORKER_TOKEN not configured' });
    return false;
  }

  const provided = req.headers['x-worker-token'] || req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!provided || provided !== expected) {
    res.status(401).json({ error: 'Invalid worker token' });
    return false;
  }

  return true;
}
