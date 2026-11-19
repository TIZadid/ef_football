import { test } from 'node:test';
import assert from 'node:assert/strict';
import { balance, evaluate, lineup, BalanceError, isCB, isMid, unknown, suggestKeepers, repeats, teamStats } from '../public/js/balance.js';

let seed = 1;
const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const P = (id, att, def, phy, fb, gk, pos = 'MID', alt = null) => ({ id, name: id, att, def, phy, fb, gk, pos, alt });

const squad = [
  P('a', 3, 1, 2, 1, 1, 'WING', 'ST'), P('b', 3, 2, 3, 2, 1, 'ST'), P('c', 1, 3, 3, 3, 2, 'CB'),
  P('d', 2, 3, 2, 2, 1, 'CB', 'MID'), P('e', 2, 2, 1, 3, 3, 'GK'), P('f', 1, 1, 1, 1, 2, 'WING'),
  P('g', 2, 2, 2, 2, 1, 'MID', 'WING'), P('h', 3, 1, 1, 1, 1, 'ST', 'MID'), P('i', 1, 2, 3, 2, 1, 'MID'),
  P('j', 2, 1, 2, 3, 1, 'WING'), P('k', 2, 2, 2, 2, 2, 'GK', 'CB'), P('l', 2, 2, 2, 1, 1, 'MID'),
  P('m', 1, 2, 2, 2, 1, 'CB'), P('n', 2, 1, 2, 2, 1, 'WING', 'MID'),
];
const ids = (t) => t.map((p) => p.id);
const sideOf = (r, id) => (ids(r.teams[0]).includes(id) ? 0 : 1);

test('sizes differ by at most one', () => {
  for (const n of [2, 5, 9, 10, 14]) {
    const r = balance(squad.slice(0, n), { rng });
    assert.ok(Math.abs(r.teams[0].length - r.teams[1].length) <= 1);
    assert.equal(r.teams[0].length + r.teams[1].length, n);
  }
});

test('5-a-side by default: 5 start, the rest are subs', () => {
  const r = balance(squad, { rng });
  r.lineups.forEach((u) => { assert.equal(u.starters.length, 5); assert.equal(u.subs.length, 2); });
});

test('bigger formats start more players', () => {
  const r = balance(squad, { rng, format: 7 });
  r.lineups.forEach((u) => { assert.equal(u.starters.length, 7); assert.equal(u.subs.length, 0); });
});

test('every starting line-up has a keeper, a CB and a MID', () => {
  for (let k = 0; k < 15; k++) {
    const r = balance(squad, { rng });
    for (const u of r.lineups) {
      assert.ok(u.keeper && u.starters.includes(u.keeper));
      assert.ok(u.starters.some((p) => p !== u.keeper && isCB(p)), 'CB missing');
      assert.ok(u.starters.some((p) => p !== u.keeper && isMid(p)), 'MID missing');
    }
    assert.deepEqual(r.warnings, []);
  }
});

test('GK-preferred players keep goal and are spread across teams', () => {
  const r = balance(squad, { rng });
  assert.notEqual(sideOf(r, 'e'), sideOf(r, 'k'));
  assert.deepEqual(r.lineups.map((u) => u.keeper.id).sort(), ['e', 'k']);
});

test('DEF 3 counts as a CB even without the CB position', () => {
  assert.ok(isCB(P('x', 1, 3, 1, 1, 1, 'WING')));
  assert.ok(isCB(P('y', 1, 1, 1, 1, 1, 'ST', 'CB')));
  assert.ok(!isCB(P('z', 1, 2, 1, 1, 1, 'MID')));
});

test('warns when there are not enough CBs', () => {
  const few = squad.map((p) => ({ ...p, def: Math.min(p.def, 2), pos: p.pos === 'CB' ? 'MID' : p.pos, alt: p.alt === 'CB' ? null : p.alt }));
  const r = balance(few, { rng });
  assert.ok(r.warnings.some((w) => w.includes('CB')));
});

test('together and apart rules hold', () => {
  for (let k = 0; k < 15; k++) {
    const r = balance(squad, { rng, together: [['a', 'h'], ['b', 'f']], apart: [['c', 'd']] });
    assert.equal(sideOf(r, 'a'), sideOf(r, 'h'));
    assert.equal(sideOf(r, 'b'), sideOf(r, 'f'));
    assert.notEqual(sideOf(r, 'c'), sideOf(r, 'd'));
  }
});

test('conflicting rules throw', () => {
  assert.throws(() => balance(squad, { together: [['a', 'b']], apart: [['a', 'b']] }), BalanceError);
});

test('pinned keepers go to different teams and start in goal', () => {
  const r = balance(squad, { rng, keepers: ['a', 'b'] });
  assert.notEqual(sideOf(r, 'a'), sideOf(r, 'b'));
  assert.deepEqual(r.lineups.map((u) => u.keeper.id).sort(), ['a', 'b']);
});

test('weaker keeper gets the better defense', () => {
  for (let k = 0; k < 15; k++) {
    const r = balance(squad.slice(0, 10), { rng });
    const [a, b] = r.stats;
    if (a.gk === b.gk) continue;
    const [weak, strong] = a.gk < b.gk ? [a, b] : [b, a];
    assert.ok(weak.maxDef >= strong.maxDef, 'weak keeper team lacks best defender');
    assert.ok(weak.def >= strong.def, 'weak keeper team has less outfield defense');
  }
});

test('starting line-ups are close in strength', () => {
  const r = balance(squad, { rng });
  assert.ok(r.balance >= 90, `balance ${r.balance}`);

});

test('regenerate avoids repeating the previous split when it can', () => {
  const first = balance(squad, { rng });
  assert.ok(first.options > 1);
  const second = balance(squad, { rng, exclude: first.signature });
  assert.notEqual(second.signature, first.signature);
});

test('no-keeper mode ignores gk', () => {
  const r = balance(squad, { rng, keeperMode: 'none' });
  r.stats.forEach((s) => { assert.equal(s.keeper, null); assert.equal(s.gk, 0); });
});

test('lineup fills keeper, CB, MID then strongest', () => {
  const team = [P('s1', 3, 1, 3, 1, 1, 'ST'), P('s2', 3, 1, 3, 2, 1, 'ST'), P('s3', 3, 1, 3, 3, 1, 'WING'),
    P('k', 1, 1, 1, 1, 3, 'GK'), P('cb', 1, 2, 1, 1, 1, 'CB'), P('m', 1, 1, 1, 1, 1, 'MID'), P('w', 3, 1, 2, 2, 1, 'WING')];
  const u = lineup(team, { format: 5 });
  assert.equal(u.keeper.id, 'k');
  assert.deepEqual(ids(u.starters).sort(), ['cb', 'k', 'm', 's3', 's2'].sort());
});

test('evaluate respects hand-edited starters and keeper', () => {
  const A = squad.slice(0, 7), B = squad.slice(7);
  const e = evaluate(A, B, { starters: [['a', 'b', 'c', 'd', 'f'], ids(B).slice(0, 5)], goal: ['a', null] });
  assert.equal(e.lineups[0].keeper.id, 'a');
  assert.deepEqual(ids(e.lineups[0].subs), ['e', 'g']);
});

test('large groups use local search and still satisfy rules', () => {
  const pos = ['GK', 'CB', 'WING', 'MID', 'ST'];
  const big = Array.from({ length: 28 }, (_, i) =>
    P(`p${i}`, 1 + (i % 3), 1 + ((i * 2) % 3), 1 + ((i * 5) % 3), 1 + ((i * 7) % 3), 1 + ((i * 11) % 3), pos[i % 5]));
  const r = balance(big, { rng, apart: [['p0', 'p1']], format: 7 });
  assert.equal(r.teams[0].length, 14);
  assert.notEqual(sideOf(r, 'p0'), sideOf(r, 'p1'));
});

test('evaluate flags broken rules after edits', () => {
  const e = evaluate(squad.slice(0, 7), squad.slice(7), { together: [['a', 'h']] });
  assert.ok(e.warnings.some((w) => w.includes('together')));
});

test('unrated guests (no position, average stats) never fill the CB or MID slot', () => {
  const guest = { id: 'g', name: 'g', att: 2, def: 2, phy: 2, fb: 2, gk: 1, pos: null, alt: null, unrated: true };
  assert.ok(!isCB(guest) && !isMid(guest));
  const r = balance([...squad.slice(0, 9), guest], { rng });
  for (const u of r.lineups) {
    assert.ok(u.starters.some((p) => p !== u.keeper && isCB(p)));
    assert.ok(u.starters.some((p) => p !== u.keeper && isMid(p)));
  }
});

const blank = (id) => ({ id, name: id, att: 2, def: 2, phy: 2, fb: 2, gk: 1, pos: null, alt: null, empty: ['att', 'def', 'phy', 'fb', 'gk'] });

test('fully unknown players are split across the teams', () => {
  for (let k = 0; k < 15; k++) {
    const r = balance([...squad.slice(0, 8), blank('u1'), blank('u2')], { rng });
    assert.notEqual(sideOf(r, 'u1'), sideOf(r, 'u2'));
  }
});

test('four unknown players split two and two, in a bigger group too', () => {
  for (let k = 0; k < 5; k++) {
    const r = balance([...squad, blank('u1'), blank('u2'), blank('u3'), blank('u4')], { rng });
    const onA = ['u1', 'u2', 'u3', 'u4'].filter((id) => sideOf(r, id) === 0).length;
    assert.equal(onA, 2);
  }
});

test('partly rated players count as partly unknown; no position alone is not unknown', () => {
  assert.equal(unknown({ ...squad[0], pos: null }), 0);
  const half = { ...blank('h'), att: 3, pos: 'ST', empty: ['def', 'phy', 'fb'] };
  assert.equal(unknown(half), 0.6);
  assert.equal(unknown(blank('b')), 1);
  assert.equal(unknown(squad[0]), 0);
});

test('the two stars go to different teams', () => {
  const star = (id) => P(id, 3, 3, 3, 3, 1, 'MID');
  const avg = (id, pos) => P(id, 2, 2, 2, 2, 1, pos);
  const group = [star('s1'), star('s2'), avg('a1', 'GK'), avg('a2', 'GK'), avg('a3', 'CB'), avg('a4', 'CB'),
    avg('a5', 'MID'), avg('a6', 'MID'), avg('a7', 'ST'), avg('a8', 'WING')];
  for (let k = 0; k < 10; k++) {
    const r = balance(group, { rng });
    assert.notEqual(sideOf(r, 's1'), sideOf(r, 's2'));
  }
});

test('win chance is close to a coin flip for a balanced split', () => {
  const r = balance(squad, { rng });
  assert.ok(Math.abs(r.chance[0] - 50) <= 4, `chance ${r.chance}`);
  assert.equal(r.chance[0] + r.chance[1], 100);
});

test('a striker adds more attack than a centre-back with the same ratings', () => {
  const st = P('st', 3, 1, 2, 2, 1, 'ST'), cb = P('cb', 3, 1, 2, 2, 1, 'CB');
  const a = teamStats([st], null), b = teamStats([cb], null);
  assert.ok(a.atk > b.atk && a.defU < b.defU);
});

test('suggested keepers prefer GK position, then GK rating', () => {
  const ks = suggestKeepers(squad);
  assert.deepEqual(ks.map((p) => p.id), ['e', 'k']);
});

test('repeats counts recent teammate pairs, newest weighted most', () => {
  const t = [[squad[0], squad[1]], [squad[2], squad[3]]];
  assert.equal(repeats(t, [[['a', 'b'], ['c', 'd']]]), 2);
  assert.equal(repeats(t, [[['a', 'c'], ['b', 'd']]]), 0);
  assert.equal(repeats(t, [[['x'], ['y']], [['a', 'b'], ['c', 'd']]]), 1);
});

test('freshness: with history, picks repeat fewer teammates than ignoring it', () => {
  const history = [];
  let fresh = 0, stale = 0;
  for (let k = 0; k < 8; k++) {
    const h = balance(squad, { rng, history });
    const plain = balance(squad, { rng });
    fresh += repeats(h.teams, history);
    stale += repeats(plain.teams, history);
    history.unshift(h.teams.map((t) => t.map((p) => p.id)));
  }
  assert.ok(fresh <= stale, `fresh ${fresh} stale ${stale}`);
});

test('the team that tracks back less gets the better CB', () => {
  const group = [
    P('gk1', 1, 1, 1, 1, 3, 'GK'), P('gk2', 1, 1, 1, 1, 3, 'GK'),
    P('cbGood', 1, 3, 3, 2, 1, 'CB'), P('cbOk', 2, 2, 2, 2, 1, 'CB'),
    P('lazy1', 3, 1, 2, 1, 1, 'ST'), P('lazy2', 3, 1, 2, 1, 1, 'WING', 'MID'),
    P('work1', 2, 2, 2, 3, 1, 'MID'), P('work2', 2, 2, 2, 3, 1, 'MID'),
  ];
  for (let k = 0; k < 10; k++) {
    const r = balance(group, { rng, format: 4 });
    const [a, b] = r.stats;
    if (Math.abs(a.track - b.track) <= 0.25) continue;
    const lazy = a.track < b.track ? a : b, busy = lazy === a ? b : a;
    assert.ok(lazy.cbQ >= busy.cbQ, `lazy cb ${lazy.cbQ} vs ${busy.cbQ}`);
  }
});

test('balance covers the whole squad, bench included', () => {
  const r = balance(squad, { rng }); // 14 players: 5 start + 2 subs a side
  for (const st of r.stats) assert.equal(st.impacts.length, st.size - 1);
  // A strong bench on one side and a weak one on the other is visible in the score.
  const A = squad.slice(0, 7), B = squad.slice(7);
  const weakBench = B.map((p, i) => (i >= 5 ? { ...p, att: 1, def: 1, phy: 1, fb: 1 } : p));
  const same = evaluate(A, B, {}), worse = evaluate(A, weakBench, {});
  assert.ok(worse.stats[1].expected < same.stats[1].expected);
});
