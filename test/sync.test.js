import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeDocs } from '../public/js/sync.js';

const P = (id, t, name = id) => ({ id, name, t });

test('players merge by id, newest edit wins', () => {
  const m = mergeDocs({ pool: [P('a', 1, 'old'), P('b', 5)] }, { pool: [P('a', 3, 'new'), P('c', 2)] });
  assert.deepEqual(m.pool.map((p) => p.id).sort(), ['a', 'b', 'c']);
  assert.equal(m.pool.find((p) => p.id === 'a').name, 'new');
});

test('deletions stick unless the player was edited afterwards', () => {
  const m = mergeDocs({ pool: [P('a', 1), P('b', 9)] }, { deleted: { a: 2, b: 3 } });
  assert.deepEqual(m.pool.map((p) => p.id), ['b']);
});

test('whole-value fields take the newer copy', () => {
  const m = mergeDocs(
    { together: [['x', 'y']], stamps: { together: 5 }, settings: { venue: 'A' }, },
    { together: [], stamps: { together: 3, settings: 4 }, settings: { venue: 'B' } },
  );
  assert.deepEqual(m.together, [['x', 'y']]);
  assert.equal(m.settings.venue, 'B');
});

test('recent guests: newest first, capped, cleared ones dropped', () => {
  const many = Array.from({ length: 15 }, (_, i) => P(`g${i}`, i + 10));
  const m = mergeDocs({ recent: many }, { recent: [P('old', 1)], recentCleared: 5 });
  assert.equal(m.recent.length, 12);
  assert.equal(m.recent[0].id, 'g14');
  assert.ok(!m.recent.some((p) => p.id === 'old'));
});

test("this week's state syncs: newer picks and teams win", () => {
  const m = mergeDocs(
    { picked: ['a'], result: { teams: [['a'], ['b']] }, stamps: { picked: 1, result: 9 } },
    { picked: ['a', 'b'], result: null, stamps: { picked: 5, result: 2 } },
  );
  assert.deepEqual(m.picked, ['a', 'b']);
  assert.deepEqual(m.result.teams, [['a'], ['b']]);
});
