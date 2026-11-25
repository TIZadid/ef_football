// A room's shared data (squad, guests, rules, matchday, this week's teams).
// Every request carries the room code and PIN in X-Room / X-Pin.
import { redis, keys, storageReady, authorize, send, fail, readBody } from './_lib.js';
import { mergeDocs, emptyDoc } from '../public/js/sync.js';

export default async function handler(req, res) {
  if (!storageReady()) return send(res, 503, { error: 'Storage is not connected yet.' });
  try {
    const code = String(req.headers['x-room'] ?? '').trim();
    await authorize(code, String(req.headers['x-pin'] ?? ''));
    const stored = await redis('GET', keys.state(code));
    const current = stored ? JSON.parse(stored) : emptyDoc();
    if (req.method === 'GET') return send(res, 200, current);
    if (req.method === 'POST') {
      const merged = mergeDocs(current, readBody(req));
      await redis('SET', keys.state(code), JSON.stringify(merged));
      return send(res, 200, merged);
    }
    res.setHeader('Allow', 'GET, POST');
    return send(res, 405, { error: 'Use GET or POST.' });
  } catch (err) {
    return fail(res, err);
  }
}
