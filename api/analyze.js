import { analyzeProduct, validateAnalyzeRequest } from '../lib/analyze-product.js';
import { requireApiKey } from '../lib/auth.js';
import { ConfigError, DEFAULT_BODY_LIMIT, declaredBodyTooLarge, sendError } from '../lib/http.js';

// Platform-level cap on the parsed JSON body (also enforced below via content-length and per-field limits).
export const config = { api: { bodyParser: { sizeLimit: '256kb' } } };

// Server-to-server endpoint for the Shopify app backend. Contract:
//   POST /api/analyze, header x-api-key: <AUDIT_API_KEY>
//   JSON { title, imageUrls[], productUrl?, variants?, productType?, imageAlts?, imageFilenames?, brandContext? }
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Fails closed (503) when AUDIT_API_KEY is not configured; 401 otherwise on a missing/wrong key.
  if (!requireApiKey(req, res)) return;

  if (declaredBodyTooLarge(req, DEFAULT_BODY_LIMIT)) {
    return res.status(413).json({ error: 'Payload too large' });
  }

  try {
    const input = validateAnalyzeRequest(req.body);

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new ConfigError('OPENAI_API_KEY is not configured');

    const result = await analyzeProduct({ apiKey, ...input });
    return res.status(200).json(result);
  } catch (error) {
    return sendError(res, error, 'analyze');
  }
}
