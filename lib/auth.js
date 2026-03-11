import crypto from 'node:crypto';

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

export function requireShopifyWebhook(req, res) {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) {
    res.status(500).json({ error: 'SHOPIFY_API_SECRET not configured' });
    return false;
  }

  const provided = req.headers['x-shopify-hmac-sha256'];
  if (!provided) {
    res.status(401).json({ error: 'Missing Shopify webhook signature' });
    return false;
  }

  const payload = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
  const digest = crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('base64');
  if (provided.length !== digest.length) {
    res.status(401).json({ error: 'Invalid Shopify webhook signature' });
    return false;
  }
  const valid = crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(digest));

  if (!valid) {
    res.status(401).json({ error: 'Invalid Shopify webhook signature' });
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
