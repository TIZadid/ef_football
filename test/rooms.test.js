import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// The API talks to Upstash over fetch; answer those calls from memory.
process.env.KV_REST_API_URL = 'http://redis.test';
process.env.KV_REST_API_TOKEN = 'test';
let db;
globalThis.fetch = async (url, { body }) => {
  const [cmd, key, value, flag] = JSON.parse(body);
  let result = null;
  if (cmd === 'GET') result = db.has(key) ? db.get(key) : null;
  else if (cmd === 'SET') { if (!(flag === 'NX' && db.has(key))) { db.set(key, value); result = 'OK'; } }
  else if (cmd === 'INCR') { result = Number(db.get(key) || 0) + 1; db.set(key, String(result)); }
  else if (cmd === 'EXPIRE') result = 1;
  return { json: async () => ({ result }) };
};
const room = (await import('../api/room.js')).default;
const state = (await import('../api/state.js')).default;

function call(handler, { method = 'POST', body, headers = {} } = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200, headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      status(c) { this.statusCode = c; return this; },
      json(o) { resolve({ status: this.statusCode, body: o }); },
      end() { resolve({ status: this.statusCode }); },
    };
    handler({ method, body: body && JSON.stringify(body), headers }, res);
  });
}
const create = (body) => call(room, { body: { action: 'create', ...body } });
const join = (code, pin) => call(room, { body: { action: 'join', code, pin } });

beforeEach(() => { db = new Map(); });

test('created rooms get unique codes', async () => {
  const codes = new Set();
  for (let i = 0; i < 30; i++) codes.add((await create({ name: 'x', pin: '1234' })).body.code);
  assert.equal(codes.size, 30);
});

test('a chosen code can only be taken once', async () => {
  assert.equal((await create({ name: 'a', pin: '1111', code: '5555' })).status, 200);
  assert.equal((await create({ name: 'b', pin: '2222', code: '5555' })).status, 409);
});

test('joining needs the right PIN', async () => {
  const { code } = (await create({ name: 'a', pin: '1111' })).body;
  assert.equal((await join(code, '1111')).status, 200);
  assert.equal((await join(code, '2222')).status, 401);
  assert.equal((await join('424242', '1111')).status, 404);
});

test('too many wrong PINs lock the room for a while', async () => {
  const { code } = (await create({ name: 'a', pin: '1111' })).body;
  for (let i = 0; i < 10; i++) await join(code, '9999');
  assert.equal((await join(code, '1111')).status, 429);
});

test('state is per room and needs the PIN', async () => {
  const a = (await create({ name: 'a', pin: '1111' })).body.code;
  const b = (await create({ name: 'b', pin: '2222' })).body.code;
  await call(state, { body: { pool: [{ id: 'p', name: 'Only in A', t: 1 }] }, headers: { 'x-room': a, 'x-pin': '1111' } });
  const inB = await call(state, { method: 'GET', headers: { 'x-room': b, 'x-pin': '2222' } });
  assert.deepEqual(inB.body.pool, []);
  const wrong = await call(state, { method: 'GET', headers: { 'x-room': a, 'x-pin': '2222' } });
  assert.equal(wrong.status, 401);
});

test('the pre-rooms data becomes room 9999, claimed by the first PIN', async () => {
  db.set('gameon:state', JSON.stringify({ pool: [{ id: 'p1', name: 'Abir', t: 1 }] }));
  assert.equal((await create({ name: 'x', pin: '1111', code: '9999' })).status, 409);
  const first = await join('9999', '4321');
  assert.equal(first.body.claimed, true);
  assert.equal((await join('9999', '1111')).status, 401);
  const got = await call(state, { method: 'GET', headers: { 'x-room': '9999', 'x-pin': '4321' } });
  assert.equal(got.body.pool[0].name, 'Abir');
});
