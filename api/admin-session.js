import { clearAdminSessionHeaders, createAdminSessionHeaders, isAdminAuthenticated, verifyAdminKey } from '../lib/admin-session.js';

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ authenticated: isAdminAuthenticated(req) });
  }

  if (req.method === 'POST') {
    const { key } = req.body || {};

    try {
      if (!verifyAdminKey(key)) {
        return res.status(401).json({ error: 'Invalid admin key' });
      }

      res.setHeader('Set-Cookie', createAdminSessionHeaders()['Set-Cookie']);
      return res.status(200).json({ authenticated: true });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  if (req.method === 'DELETE') {
    res.setHeader('Set-Cookie', clearAdminSessionHeaders()['Set-Cookie']);
    return res.status(200).json({ authenticated: false });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
