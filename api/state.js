// Shared squad storage for every device, on Upstash Redis (free tier).
// Connect an Upstash Redis store to the project in the Vercel dashboard;
// it provides the URL and token below as environment variables.
import { mergeDocs, emptyDoc } from '../public/js/sync.js';

const URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const KEY = 'gameon:state';

async function redis(command) {
  const res = await fetch(URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json.result;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!URL || !TOKEN) return res.status(503).json({ error: 'Storage is not connected yet.' });
  try {
    const stored = await redis(['GET', KEY]);
    const current = stored ? JSON.parse(stored) : emptyDoc();
    if (req.method === 'GET') return res.status(200).json(current);
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const merged = mergeDocs(current, body);
      await redis(['SET', KEY, JSON.stringify(merged)]);
      return res.status(200).json(merged);
    }
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).end();
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
}
