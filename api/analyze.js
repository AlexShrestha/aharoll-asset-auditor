import { analyzeProduct } from '../lib/analyze-product.js';
import { requireApiKey } from '../lib/auth.js';
import { ConfigError, sendError } from '../lib/http.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Server-to-server only: callers must present AUDIT_API_KEY. Fails closed (503) when it is not configured.
  if (!requireApiKey(req, res)) return;

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new ConfigError('OPENAI_API_KEY is not configured');

    const { title, productUrl, imageUrls, variants, productType, brandContext, imageAlts, imageFilenames } = req.body || {};
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
    return sendError(res, error, 'analyze');
  }
}
