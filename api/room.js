// Rooms: each group's data lives under its own code, protected by a PIN.
//   POST { action: 'create', name, pin, code? }           → { code, name, recoveryKey }
//   POST { action: 'join', code, pin }                    → { code, name, claimed }
//   POST { action: 'change-pin', code, pin, newPin }      → { ok }
//   POST { action: 'recovery-key', code, pin }            → { recoveryKey }  (replaces the old one)
//   POST { action: 'reset-pin', code, recoveryKey, newPin } → { code, name, recoveryKey } (a fresh key)
import {
  redis, keys, storageReady, validCode, validPin, hashPin, authorize, authorizeRecovery, readMeta, writeMeta,
  newRecoveryKey, hashRecovery, send, fail, readBody, HttpError,
} from './_lib.js';
import { emptyDoc } from '../public/js/sync.js';

const randomCode = () => String(Math.floor(100000 + Math.random() * 900000)); // 6 digits

export default async function handler(req, res) {
  if (!storageReady()) return send(res, 503, { error: 'Storage is not connected yet.' });
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return send(res, 405, { error: 'Use POST.' }); }
  try {
    const body = readBody(req);
    if (body.action === 'join') {
      const code = String(body.code ?? '').trim();
      const { meta, claimed } = await authorize(code, String(body.pin ?? ''));
      return send(res, 200, { code, name: meta.name, claimed });
    }
    if (body.action === 'change-pin' || body.action === 'reset-pin') {
      const code = String(body.code ?? '').trim();
      const newPin = String(body.newPin ?? '');
      if (!validPin(newPin)) throw new HttpError(400, 'The new PIN must be 4 to 8 digits.');
      const meta = body.action === 'change-pin'
        ? (await authorize(code, String(body.pin ?? ''))).meta
        : await authorizeRecovery(code, body.recoveryKey);
      meta.pin = hashPin(code, newPin);
      // A used recovery key is replaced, so it can't be used twice.
      let recoveryKey;
      if (body.action === 'reset-pin') {
        recoveryKey = newRecoveryKey();
        meta.recovery = hashRecovery(code, recoveryKey);
      }
      await writeMeta(code, meta);
      await redis('SET', keys.fails(code), '0');
      return send(res, 200, { ok: true, code, name: meta.name, recoveryKey });
    }
    if (body.action === 'recovery-key') {
      const code = String(body.code ?? '').trim();
      const { meta } = await authorize(code, String(body.pin ?? ''));
      const recoveryKey = newRecoveryKey();
      meta.recovery = hashRecovery(code, recoveryKey);
      await writeMeta(code, meta);
      return send(res, 200, { recoveryKey });
    }
    if (body.action === 'create') {
      const pin = String(body.pin ?? '');
      const name = String(body.name ?? '').trim().slice(0, 30) || 'Our group';
      if (!validPin(pin)) throw new HttpError(400, 'PINs are 4 to 8 digits.');
      const wanted = body.code ? String(body.code).trim() : null;
      if (wanted && !validCode(wanted)) throw new HttpError(400, 'Room codes are 4 to 8 digits.');
      // SET … NX only succeeds for a code nobody has, so codes stay unique.
      for (let attempt = 0; attempt < (wanted ? 1 : 12); attempt++) {
        const code = wanted || randomCode();
        // Make sure the old shared data has moved into 9999 before anyone can claim the code.
        if (code === '9999') await readMeta(code);
        const recoveryKey = newRecoveryKey();
        const meta = { name, pin: hashPin(code, pin), recovery: hashRecovery(code, recoveryKey), created: Date.now() };
        const ok = await redis('SET', keys.meta(code), JSON.stringify(meta), 'NX');
        if (ok) {
          await redis('SET', keys.state(code), JSON.stringify(emptyDoc()), 'NX');
          return send(res, 200, { code, name, recoveryKey });
        }
        if (wanted) throw new HttpError(409, 'That room code is taken. Pick another, or leave it blank for a random one.');
      }
      throw new HttpError(503, 'Couldn\'t find a free code. Try again.');
    }
    throw new HttpError(400, 'Unknown action.');
  } catch (err) {
    return fail(res, err);
  }
}
