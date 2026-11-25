// Shared by the API routes: Upstash Redis over REST, and room access checks.
// (Files starting with "_" aren't routes on Vercel.)
import crypto from 'node:crypto';

const URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

export const storageReady = () => Boolean(URL && TOKEN);

export async function redis(...command) {
  const res = await fetch(URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json.result;
}

export const keys = {
  meta: (code) => `gameon:room:${code}:meta`,
  state: (code) => `gameon:room:${code}:state`,
  fails: (code) => `gameon:room:${code}:fails`,
};
// Before rooms existed, everything lived here; it becomes room 9999.
const LEGACY_KEY = 'gameon:state';
const LEGACY_ROOM = '9999';

export const validCode = (code) => /^\d{4,8}$/.test(String(code ?? ''));
export const validPin = (pin) => /^\d{4,8}$/.test(String(pin ?? ''));
export const hashPin = (code, pin) => crypto.createHash('sha256').update(`gameon:${code}:${pin}`).digest('hex');

const MAX_FAILS = 10;
const LOCKOUT_SECONDS = 15 * 60;

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function readMeta(code) {
  let raw = await redis('GET', keys.meta(code));
  if (!raw && code === LEGACY_ROOM) {
    // First visit since rooms: move the old shared data into room 9999.
    const legacy = await redis('GET', LEGACY_KEY);
    if (legacy) {
      await redis('SET', keys.state(code), legacy, 'NX');
      await redis('SET', keys.meta(code), JSON.stringify({ name: 'Game On', pin: null, created: Date.now() }), 'NX');
      raw = await redis('GET', keys.meta(code));
    }
  }
  return raw ? JSON.parse(raw) : null;
}

// Check the code and PIN. A room without a PIN yet (only the migrated room)
// takes the first PIN it's given.
export async function authorize(code, pin) {
  if (!validCode(code)) throw new HttpError(400, 'Room codes are 4 to 8 digits.');
  if (!validPin(pin)) throw new HttpError(400, 'PINs are 4 to 8 digits.');
  const meta = await readMeta(code);
  if (!meta) throw new HttpError(404, 'No room with that code.');
  const fails = Number(await redis('GET', keys.fails(code))) || 0;
  if (fails >= MAX_FAILS) throw new HttpError(429, 'Too many wrong PINs. Try again in 15 minutes.');
  if (!meta.pin) {
    meta.pin = hashPin(code, pin);
    await redis('SET', keys.meta(code), JSON.stringify(meta));
    return { meta, claimed: true };
  }
  if (meta.pin !== hashPin(code, pin)) {
    await redis('INCR', keys.fails(code));
    await redis('EXPIRE', keys.fails(code), LOCKOUT_SECONDS);
    throw new HttpError(401, 'Wrong PIN for this room.');
  }
  return { meta, claimed: false };
}

export function send(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Server-Time', String(Date.now()));
  return res.status(status).json(body);
}

export function fail(res, err) {
  if (err instanceof HttpError) return send(res, err.status, { error: err.message });
  return send(res, 500, { error: String(err.message || err) });
}

export const readBody = (req) => (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {});
