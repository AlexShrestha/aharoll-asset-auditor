import { analyzeProduct } from '../lib/analyze-product.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });
  }

  const { title, productUrl, imageUrls, variants, productType, brandContext, imageAlts, imageFilenames } = req.body;

  try {
    const result = await analyzeProduct({
      apiKey,
      title,
      productUrl,
      imageUrls,
      variants,
      productType,
      brandContext,
      imageAlts,
      imageFilenames,
    });

    return res.status(200).json(result);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
