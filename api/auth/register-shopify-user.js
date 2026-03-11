import { requireApiKey } from '../../lib/auth.js';
import { registerShopifyUser } from '../../lib/platform.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireApiKey(req, res)) return;

  try {
    const result = await registerShopifyUser(req.body || {});
    return res.status(200).json(result);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
