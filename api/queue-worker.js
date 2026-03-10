import { requireWorkerToken } from '../lib/auth.js';
import { processQueueBatch } from '../lib/queue.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireWorkerToken(req, res)) return;

  const batchSize = Math.min(Math.max(Number.parseInt(req.body?.batchSize, 10) || 3, 1), 10);

  try {
    const result = await processQueueBatch({ batchSize });
    return res.status(200).json(result);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
