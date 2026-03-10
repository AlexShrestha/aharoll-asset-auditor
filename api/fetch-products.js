import { fetchAllAvailableProducts } from '../lib/shopify-products.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { storeUrl } = req.body;
  if (!storeUrl) {
    return res.status(400).json({ error: 'storeUrl is required' });
  }

  try {
    const data = await fetchAllAvailableProducts(storeUrl);
    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
