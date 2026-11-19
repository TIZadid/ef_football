import { test } from 'node:test';
import assert from 'node:assert/strict';
import { balance, evaluate, BalanceError } from '../public/js/balance.js';

let seed = 1;
const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const P = (id, att, def, phy, fb, gk, pos = 'both') => ({ id, name: id, att, def, phy, fb, gk, pos });

const squad = [
  P('a', 3, 1, 2, 1, 1, 'wing'), P('b', 3, 2, 3, 2, 1, 'central'), P('c', 1, 3, 3, 3, 2, 'central'),
  P('d', 2, 3, 2, 2, 1, 'both'), P('e', 2, 2, 1, 3, 3, 'both'), P('f', 1, 1, 1, 1, 2, 'wing'),
  P('g', 2, 2, 2, 2, 1, 'wing'), P('h', 3, 1, 1, 1, 1, 'central'), P('i', 1, 2, 3, 2, 1, 'both'),
  P('j', 2, 1, 2, 3, 1, 'wing'),
];
const ids = (t) => t.map((p) => p.id);
const sideOf = (r, id) => (ids(r.teams[0]).includes(id) ? 0 : 1);

test('sizes differ by at most one', () => {
  for (const n of [2, 5, 9, 10]) {
    const r = balance(squad.slice(0, n), { rng });
    assert.ok(Math.abs(r.teams[0].length - r.teams[1].length) <= 1);
    assert.equal(r.teams[0].length + r.teams[1].length, n);
  }
});

test('each team gets a CB and a central player when possible', () => {
  for (let k = 0; k < 20; k++) {
    const r = balance(squad, { rng });
    for (const s of r.stats) {
      assert.ok(s.cbs >= 1, 'CB missing');
      assert.ok(s.centrals >= 1, 'central missing');
    }
    assert.deepEqual(r.warnings, []);
  }
});

test('warns when only one CB exists', () => {
  const noCbs = squad.map((p) => (p.id === 'd' ? { ...p, def: 2 } : p));
  const r = balance(noCbs, { rng });
  assert.ok(r.warnings.some((w) => w.includes('centre-back')));
});

test('together and apart rules hold', () => {
  for (let k = 0; k < 20; k++) {
    const r = balance(squad, { rng, together: [['a', 'h'], ['b', 'f']], apart: [['c', 'd']] });
    assert.equal(sideOf(r, 'a'), sideOf(r, 'h'));
    assert.equal(sideOf(r, 'b'), sideOf(r, 'f'));
    assert.notEqual(sideOf(r, 'c'), sideOf(r, 'd'));
  }
});

test('conflicting rules throw', () => {
  assert.throws(() => balance(squad, { together: [['a', 'b']], apart: [['a', 'b']] }), BalanceError);
});

test('pinned keepers go to different teams and keep goal', () => {
  const r = balance(squad, { rng, keepers: ['a', 'b'] });
  assert.notEqual(sideOf(r, 'a'), sideOf(r, 'b'));
  assert.deepEqual(r.stats.map((s) => s.keeper.id).sort(), ['a', 'b']);
});

test('the best gk on each team keeps goal', () => {
  const r = balance(squad, { rng });
  r.stats.forEach((s, t) => assert.equal(s.keeper.gk, Math.max(...r.teams[t].map((p) => p.gk))));
});

test('weaker keeper gets the better defense', () => {
  for (let k = 0; k < 20; k++) {
    const r = balance(squad, { rng });
    const [a, b] = r.stats;
    if (a.gk === b.gk) continue;
    const [weak, strong] = a.gk < b.gk ? [a, b] : [b, a];
    assert.ok(weak.maxDef >= strong.maxDef, 'weak keeper team lacks best defender');
    assert.ok(weak.def >= strong.def, 'weak keeper team has less outfield defense');
  }
});

test('teams are close in overall strength', () => {
  const r = balance(squad, { rng });
  assert.ok(Math.abs(r.stats[0].total - r.stats[1].total) <= 2);
  assert.ok(r.balance >= 90);
});

test('reshuffle avoids repeating the previous split when it can', () => {
  const first = balance(squad, { rng });
  if (first.options > 1) {
    const second = balance(squad, { rng, exclude: first.signature });
    assert.notEqual(second.signature, first.signature);
  }
});

test('no-keeper mode ignores gk', () => {
  const r = balance(squad, { rng, keeperMode: 'none' });
  r.stats.forEach((s) => { assert.equal(s.keeper, null); assert.equal(s.gk, 0); });
});

test('large groups use local search and still satisfy rules', () => {
  const big = Array.from({ length: 28 }, (_, i) =>
    P(`p${i}`, 1 + (i % 3), 1 + ((i * 2) % 3), 1 + ((i * 5) % 3), 1 + ((i * 7) % 3), 1 + ((i * 11) % 3), ['wing', 'central', 'both'][i % 3]));
  const r = balance(big, { rng, apart: [['p0', 'p1']] });
  assert.equal(r.teams[0].length, 14);
  assert.notEqual(sideOf(r, 'p0'), sideOf(r, 'p1'));
});

test('evaluate flags broken rules after manual swaps', () => {
  const e = evaluate(squad.slice(0, 5), squad.slice(5), { together: [['a', 'f']] });
  assert.ok(e.warnings.some((w) => w.includes('together')));
});
