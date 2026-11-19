// Team balancing.
//
// A player: { id, name, att, def, phy, fb, gk, pos: 'wing' | 'central' | 'both' }
// Ratings are 1–3. def === 3 marks a centre-back (CB).
//
// Hard rules (always enforced, or the split is rejected):
//   - team sizes differ by at most one
//   - "together" pairs share a team, "apart" pairs don't
//   - pinned keepers end up on different teams
// Structural rules (enforced whenever any split can satisfy them; otherwise
// the least-bad split wins and a warning is returned):
//   - every team has an outfield CB
//   - every team has an outfield central player (central or both)
// Soft goals (minimised by the cost function):
//   - attack, defense, physicality, tracking back and overall strength balanced
//   - the team with the weaker keeper gets the stronger defense, including
//     the best defender when keepers differ
//   - wing / central coverage balanced

export const ATTRS = ['att', 'def', 'phy', 'fb'];

const W = {
  att: 1,
  def: 1,
  phy: 0.7,
  fb: 0.7,
  total: 1.2,
  gk: 1.5, // how much a keeper's rating counts toward the team's defense
  wing: 0.4,
  central: 0.4,
  weakKeeperBestDefender: 3,
};

const EXHAUSTIVE_LIMIT = 20;

function pickKeeper(team, pinned) {
  if (!team.length) return null;
  const pin = team.find((p) => pinned.has(p.id));
  if (pin) return pin;
  let best = team[0];
  for (const p of team) {
    const out = (q) => q.att + q.def + q.phy + q.fb;
    // Best keeper; on a tie, keep the stronger outfielder outfield.
    if (p.gk > best.gk || (p.gk === best.gk && out(p) < out(best))) best = p;
  }
  return best;
}

export function teamStats(team, { keeperMode = 'auto', keepers = [] } = {}) {
  const useKeepers = keeperMode !== 'none';
  const keeper = useKeepers ? pickKeeper(team, new Set(keepers)) : null;
  const s = {
    size: team.length,
    keeper,
    att: 0, def: 0, phy: 0, fb: 0,
    gk: keeper ? keeper.gk : 0,
    wing: 0, central: 0,
    cbs: 0, centrals: 0, maxDef: 0,
  };
  for (const p of team) {
    if (p === keeper) continue;
    s.att += p.att; s.def += p.def; s.phy += p.phy; s.fb += p.fb;
    if (p.pos === 'wing') s.wing += 1;
    else if (p.pos === 'central') s.central += 1;
    else { s.wing += 0.5; s.central += 0.5; }
    if (p.def === 3) s.cbs++;
    if (p.pos !== 'wing') s.centrals++;
    if (p.def > s.maxDef) s.maxDef = p.def;
  }
  s.defense = s.def + W.gk * s.gk; // outfield defense plus the keeper behind it
  s.total = s.att + s.def + s.phy + s.fb + W.gk * s.gk;
  return s;
}

function score(a, b, useKeepers) {
  let cost =
    W.att * Math.abs(a.att - b.att) +
    W.def * Math.abs(a.defense - b.defense) +
    W.phy * Math.abs(a.phy - b.phy) +
    W.fb * Math.abs(a.fb - b.fb) +
    W.total * Math.abs(a.total - b.total) +
    W.wing * Math.abs(a.wing - b.wing) +
    W.central * Math.abs(a.central - b.central);
  if (useKeepers && a.gk !== b.gk) {
    const [weak, strong] = a.gk < b.gk ? [a, b] : [b, a];
    if (weak.maxDef < strong.maxDef) cost += W.weakKeeperBestDefender;
  }
  const violations = {
    cb: (a.cbs < 1) + (b.cbs < 1),
    central: (a.centrals < 1) + (b.centrals < 1),
  };
  return { cost, violations, structural: violations.cb + violations.central };
}

// Score a given split. Used after manual swaps too.
export function evaluate(teamA, teamB, opts = {}) {
  const useKeepers = (opts.keeperMode ?? 'auto') !== 'none';
  const a = teamStats(teamA, opts);
  const b = teamStats(teamB, opts);
  const { cost, violations } = score(a, b, useKeepers);
  const warnings = [];
  if (violations.cb) warnings.push('Not enough centre-backs (DEF 3) for one per team.');
  if (violations.central) warnings.push('Not enough central players for one per team.');
  const together = opts.together ?? [];
  const apart = opts.apart ?? [];
  const side = new Map();
  teamA.forEach((p) => side.set(p.id, 0));
  teamB.forEach((p) => side.set(p.id, 1));
  for (const [x, y] of together) {
    if (side.has(x) && side.has(y) && side.get(x) !== side.get(y)) warnings.push('A "together" rule is broken.');
  }
  for (const [x, y] of apart) {
    if (side.has(x) && side.has(y) && side.get(x) === side.get(y)) warnings.push('An "apart" rule is broken.');
  }
  // Headline number: how close the two teams' overall strength is.
  const balance = Math.round((100 * Math.min(a.total, b.total)) / Math.max(1, a.total, b.total));
  return { stats: [a, b], cost, balance, warnings };
}

function signature(teamA, teamB) {
  const ids = (t) => t.map((p) => p.id).sort().join(',');
  const [x, y] = [ids(teamA), ids(teamB)].sort();
  return `${x}|${y}`;
}

export class BalanceError extends Error {}

// Returns { teams: [A, B], ...evaluate(), options, signature }.
// opts: together, apart (arrays of [idA, idB]), keepers (pinned ids, max 2),
//       keeperMode ('auto' | 'none'), exclude (a signature to avoid repeating),
//       rng (for tests), tolerance (how close to optimal a reshuffle may be).
export function balance(players, opts = {}) {
  const {
    together = [], apart = [], keepers = [], keeperMode = 'auto',
    exclude = null, rng = Math.random, tolerance = 0.75,
  } = opts;
  const n = players.length;
  if (n < 2) throw new BalanceError('Need at least 2 players.');
  if (keeperMode !== 'none' && keepers.length > 2) throw new BalanceError('Pin at most 2 keepers.');

  const index = new Map(players.map((p, i) => [p.id, i]));
  const sameRules = [];
  const diffRules = [];
  const addRule = (list, [x, y]) => {
    if (index.has(x) && index.has(y) && x !== y) list.push([index.get(x), index.get(y)]);
  };
  together.forEach((r) => addRule(sameRules, r));
  apart.forEach((r) => addRule(diffRules, r));
  if (keeperMode !== 'none' && keepers.length === 2) addRule(diffRules, keepers);

  // For each player i, the rules that link it to an earlier player j < i.
  const checks = players.map(() => []);
  for (const [x, y] of sameRules) checks[Math.max(x, y)].push([Math.min(x, y), true]);
  for (const [x, y] of diffRules) checks[Math.max(x, y)].push([Math.min(x, y), false]);

  const sizeA = Math.floor(n / 2);
  const sizeB = n - sizeA;
  const useKeepers = keeperMode !== 'none';
  const evalOpts = { keeperMode, keepers };

  let best = null; // { structural, cost }
  let pool = [];
  const consider = (sides) => {
    const A = [], B = [];
    sides.forEach((s, i) => (s ? B : A).push(players[i]));
    const r = score(teamStats(A, evalOpts), teamStats(B, evalOpts), useKeepers);
    if (!best || r.structural < best.structural || (r.structural === best.structural && r.cost < best.cost)) {
      const better = !best || r.structural < best.structural;
      best = { structural: r.structural, cost: r.cost };
      pool = better ? [] : pool.filter((c) => c.cost <= best.cost + tolerance);
    }
    if (r.structural === best.structural && r.cost <= best.cost + tolerance) {
      pool.push({ A, B, cost: r.cost });
      if (pool.length > 400) pool.sort((x, y) => x.cost - y.cost).length = 200;
    }
  };

  if (n <= EXHAUSTIVE_LIMIT) {
    const sides = new Array(n);
    const rec = (i, na, nb) => {
      if (i === n) return consider(sides);
      for (const s of [0, 1]) {
        if (s === 0 && na === sizeA) continue;
        if (s === 1 && nb === sizeB) continue;
        // Even split: the two halves are interchangeable, so pin player 0.
        if (i === 0 && s === 1 && sizeA === sizeB) continue;
        let ok = true;
        for (const [j, same] of checks[i]) {
          if ((sides[j] === s) !== same) { ok = false; break; }
        }
        if (!ok) continue;
        sides[i] = s;
        rec(i + 1, na + (s === 0), nb + (s === 1));
      }
    };
    rec(0, 0, 0);
  } else {
    localSearch(players, sizeA, checks, consider, rng, evalOpts, useKeepers);
  }

  if (!pool.length) throw new BalanceError('These rules can\'t all be satisfied. Remove a together/apart rule.');

  pool.sort((x, y) => x.cost - y.cost);
  let options = pool.filter((c) => signature(c.A, c.B) !== exclude);
  if (!options.length) options = pool;
  const pick = options[Math.floor(rng() * options.length)];
  // Stronger keeper side first isn't meaningful; randomise colours.
  const teams = rng() < 0.5 ? [pick.A, pick.B] : [pick.B, pick.A];
  return {
    teams,
    ...evaluate(teams[0], teams[1], { ...evalOpts, together, apart }),
    options: pool.length,
    signature: signature(teams[0], teams[1]),
  };
}

// Large groups: random valid starts improved by pairwise swaps.
function localSearch(players, sizeA, checks, consider, rng, evalOpts, useKeepers) {
  const n = players.length;
  const valid = (sides) => checks.every((list, i) => list.every(([j, same]) => (sides[i] === sides[j]) === same));
  const costOf = (sides) => {
    const A = [], B = [];
    sides.forEach((s, i) => (s ? B : A).push(players[i]));
    const r = score(teamStats(A, evalOpts), teamStats(B, evalOpts), useKeepers);
    return r.structural * 100 + r.cost;
  };
  for (let restart = 0; restart < 60; restart++) {
    const order = players.map((_, i) => i).sort(() => rng() - 0.5);
    const sides = new Array(n).fill(1);
    order.slice(0, sizeA).forEach((i) => (sides[i] = 0));
    let cur = valid(sides) ? costOf(sides) : Infinity;
    let improved = true;
    while (improved) {
      improved = false;
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          if (sides[i] !== 0 || sides[j] !== 1) continue;
          sides[i] = 1; sides[j] = 0;
          const c = valid(sides) ? costOf(sides) : Infinity;
          if (c < cur) { cur = c; improved = true; }
          else { sides[i] = 0; sides[j] = 1; }
        }
      }
    }
    if (cur < Infinity) consider(sides.slice());
  }
}
