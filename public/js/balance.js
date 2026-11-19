// Team balancing.
//
// A player: { id, name, att, def, phy, fb, gk, pos, alt }
//   ratings are 1–3; pos is the main position and alt an optional backup,
//   each one of POSITIONS.
//
// Each team has a starting line-up of `format` players (5-a-side by default);
// the rest are subs.
//
// Hard rules (always enforced, or the split is rejected):
//   - team sizes differ by at most one
//   - "together" pairs share a team, "apart" pairs don't
//   - pinned keepers end up on different teams, and start in goal
// Structural rules for each starting line-up (enforced whenever any split can
// satisfy them; otherwise the least-bad split wins and a warning is returned):
//   - a CB: CB as main/backup position, or DEF 3
//   - a central player: MID as main/backup position
// Soft goals (minimised by the cost function), starting line-ups first and
// whole teams second:
//   - attack, defense, physicality, tracking back and overall strength balanced
//   - the team with the weaker keeper gets the stronger defense, including
//     the best defender when keepers differ
//   - position coverage (wing, mid, striker) balanced
//   - players who prefer GK spread across the teams

export const POSITIONS = ['GK', 'CB', 'WING', 'MID', 'ST'];

const W = {
  att: 1,
  def: 1,
  phy: 0.7,
  fb: 0.7,
  total: 1.2,
  gk: 1.5, // how much a keeper's rating counts toward the team's defense
  wing: 0.4,
  mid: 0.4,
  st: 0.4,
  weakKeeperBestDefender: 3,
  bench: 0.5, // whole-team balance, relative to the starting line-ups
  gkSpread: 4,
};

const EXHAUSTIVE_LIMIT = 18;

export const plays = (p, pos) => (p.pos === pos ? 1 : p.alt === pos ? 0.5 : 0);
export const isCB = (p) => p.def === 3 || plays(p, 'CB') > 0;
export const isMid = (p) => plays(p, 'MID') > 0;
const overall = (p) => p.att + p.def + p.phy + p.fb;

function pickKeeper(team, pinned) {
  if (!team.length) return null;
  const pin = team.find((p) => pinned.has(p.id));
  if (pin) return pin;
  let best = team[0];
  for (const p of team) {
    const a = plays(p, 'GK'), b = plays(best, 'GK');
    // GK preference, then GK rating; on a tie keep the stronger outfielder outfield.
    if (a > b || (a === b && (p.gk > best.gk || (p.gk === best.gk && overall(p) < overall(best))))) best = p;
  }
  return best;
}

// Choose a team's starters: keeper, a CB, a MID, then the strongest of the rest.
export function lineup(team, { format = 5, keeperMode = 'auto', keepers = [] } = {}) {
  const keeper = keeperMode !== 'none' ? pickKeeper(team, new Set(keepers)) : null;
  if (team.length <= format) return { starters: team.slice(), subs: [], keeper };
  const starters = keeper ? [keeper] : [];
  const rest = team.filter((p) => p !== keeper).sort((a, b) => overall(b) - overall(a));
  const take = (fits, rank) => {
    if (starters.length >= format || starters.some((p) => p !== keeper && fits(p))) return;
    const cands = rest.filter(fits).sort((a, b) => rank(b) - rank(a));
    if (!cands.length) return;
    starters.push(cands[0]);
    rest.splice(rest.indexOf(cands[0]), 1);
  };
  take(isCB, (p) => plays(p, 'CB') * 10 + p.def + overall(p) / 100);
  take(isMid, (p) => plays(p, 'MID') * 10 + overall(p) / 100);
  while (starters.length < format && rest.length) starters.push(rest.shift());
  const chosen = new Set(starters);
  return { starters, subs: team.filter((p) => !chosen.has(p)), keeper };
}

export function teamStats(team, keeper) {
  const s = {
    size: team.length,
    keeper,
    att: 0, def: 0, phy: 0, fb: 0,
    gk: keeper ? keeper.gk : 0,
    wing: 0, mid: 0, st: 0,
    cbs: 0, mids: 0, maxDef: 0,
    gkFans: team.filter((p) => p.pos === 'GK').length,
  };
  for (const p of team) {
    if (p === keeper) continue;
    s.att += p.att; s.def += p.def; s.phy += p.phy; s.fb += p.fb;
    s.wing += plays(p, 'WING'); s.mid += plays(p, 'MID'); s.st += plays(p, 'ST');
    if (isCB(p)) s.cbs++;
    if (isMid(p)) s.mids++;
    if (p.def > s.maxDef) s.maxDef = p.def;
  }
  s.defense = s.def + W.gk * s.gk; // outfield defense plus the keeper behind it
  s.total = s.att + s.def + s.phy + s.fb + W.gk * s.gk;
  return s;
}

function pairCost(a, b, useKeepers) {
  let cost =
    W.att * Math.abs(a.att - b.att) +
    W.def * Math.abs(a.defense - b.defense) +
    W.phy * Math.abs(a.phy - b.phy) +
    W.fb * Math.abs(a.fb - b.fb) +
    W.total * Math.abs(a.total - b.total) +
    W.wing * Math.abs(a.wing - b.wing) +
    W.mid * Math.abs(a.mid - b.mid) +
    W.st * Math.abs(a.st - b.st);
  if (useKeepers && a.gk !== b.gk) {
    const [weak, strong] = a.gk < b.gk ? [a, b] : [b, a];
    if (weak.maxDef < strong.maxDef) cost += W.weakKeeperBestDefender;
  }
  return cost;
}

// Score a split whose line-ups are already chosen.
function score(ups, teams, useKeepers) {
  const start = ups.map((u) => teamStats(u.starters, u.keeper));
  const full = teams.map((t, i) => teamStats(t, ups[i].keeper));
  let cost = pairCost(start[0], start[1], useKeepers);
  if (ups[0].subs.length || ups[1].subs.length) cost += W.bench * pairCost(full[0], full[1], useKeepers);
  if (useKeepers) cost += W.gkSpread * Math.max(0, Math.abs(full[0].gkFans - full[1].gkFans) - 1);
  const violations = {
    cb: (start[0].cbs < 1) + (start[1].cbs < 1),
    mid: (start[0].mids < 1) + (start[1].mids < 1),
  };
  return { cost, violations, structural: violations.cb + violations.mid, start, full };
}

const pct = (a, b) => Math.round((100 * Math.min(a.total, b.total)) / Math.max(1, a.total, b.total));

// Score a split. For a hand-edited result pass `starters` ([idsA, idsB]) and
// optionally `goal` ([idA | null, idB | null]) to fix who keeps.
export function evaluate(teamA, teamB, opts = {}) {
  const keeperMode = opts.keeperMode ?? 'auto';
  const useKeepers = keeperMode !== 'none';
  const teams = [teamA, teamB];
  const ups = teams.map((team, i) => {
    if (!opts.starters) return lineup(team, opts);
    const ids = new Set(opts.starters[i]);
    const starters = team.filter((p) => ids.has(p.id));
    const pinned = new Set([opts.goal?.[i], ...(opts.keepers ?? [])].filter(Boolean));
    const keeper = useKeepers ? pickKeeper(starters, pinned) : null;
    return { starters, subs: team.filter((p) => !ids.has(p.id)), keeper };
  });
  const { cost, violations, start, full } = score(ups, teams, useKeepers);
  const warnings = [];
  if (violations.cb) warnings.push('A starting line-up has no CB (CB position or DEF 3).');
  if (violations.mid) warnings.push('A starting line-up has no MID.');
  const side = new Map();
  teamA.forEach((p) => side.set(p.id, 0));
  teamB.forEach((p) => side.set(p.id, 1));
  for (const [x, y] of opts.together ?? []) {
    if (side.has(x) && side.has(y) && side.get(x) !== side.get(y)) warnings.push('A "together" rule is broken.');
  }
  for (const [x, y] of opts.apart ?? []) {
    if (side.has(x) && side.has(y) && side.get(x) === side.get(y)) warnings.push('An "apart" rule is broken.');
  }
  return {
    lineups: ups,
    stats: start,
    fullStats: full,
    cost,
    balance: pct(start[0], start[1]),
    fullBalance: pct(full[0], full[1]),
    warnings,
  };
}

function signature(teamA, teamB) {
  const ids = (t) => t.map((p) => p.id).sort().join(',');
  const [x, y] = [ids(teamA), ids(teamB)].sort();
  return `${x}|${y}`;
}

export class BalanceError extends Error {}

// Returns { teams: [A, B], ...evaluate(), options, signature }.
// opts: format (players per side on the pitch, default 5),
//       together, apart (arrays of [idA, idB]), keepers (pinned ids, max 2),
//       keeperMode ('auto' | 'none'), exclude (a signature to avoid repeating),
//       rng (for tests), tolerance (how close to optimal a reshuffle may be).
export function balance(players, opts = {}) {
  const {
    format = 5, together = [], apart = [], keepers = [], keeperMode = 'auto',
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
  const upOpts = { format, keeperMode, keepers };

  const scoreSides = (sides) => {
    const teams = [[], []];
    sides.forEach((s, i) => teams[s].push(players[i]));
    const ups = teams.map((t) => lineup(t, upOpts));
    return { teams, ...score(ups, teams, useKeepers) };
  };

  let best = null; // { structural, cost }
  let pool = [];
  const consider = (sides) => {
    const r = scoreSides(sides);
    if (!best || r.structural < best.structural || (r.structural === best.structural && r.cost < best.cost)) {
      const better = !best || r.structural < best.structural;
      best = { structural: r.structural, cost: r.cost };
      pool = better ? [] : pool.filter((c) => c.cost <= best.cost + tolerance);
    }
    if (r.structural === best.structural && r.cost <= best.cost + tolerance) {
      pool.push({ A: r.teams[0], B: r.teams[1], cost: r.cost });
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
    localSearch(n, sizeA, checks, consider, scoreSides, rng);
  }

  if (!pool.length) throw new BalanceError('These rules can\'t all be satisfied. Remove a together/apart rule.');

  let options = pool.filter((c) => signature(c.A, c.B) !== exclude);
  if (!options.length) options = pool;
  const pick = options[Math.floor(rng() * options.length)];
  // Colours carry no meaning; randomise which team gets which.
  const teams = rng() < 0.5 ? [pick.A, pick.B] : [pick.B, pick.A];
  return {
    teams,
    ...evaluate(teams[0], teams[1], { ...upOpts, together, apart }),
    options: pool.length,
    signature: signature(teams[0], teams[1]),
  };
}

// Large groups: random valid starts improved by pairwise swaps.
function localSearch(n, sizeA, checks, consider, scoreSides, rng) {
  const valid = (sides) => checks.every((list, i) => list.every(([j, same]) => (sides[i] === sides[j]) === same));
  const costOf = (sides) => {
    if (!valid(sides)) return Infinity;
    const r = scoreSides(sides);
    return r.structural * 100 + r.cost;
  };
  for (let restart = 0; restart < 30; restart++) {
    const order = Array.from({ length: n }, (_, i) => i).sort(() => rng() - 0.5);
    const sides = new Array(n).fill(1);
    order.slice(0, sizeA).forEach((i) => (sides[i] = 0));
    let cur = costOf(sides);
    let improved = true;
    while (improved) {
      improved = false;
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          if (sides[i] !== 0 || sides[j] !== 1) continue;
          sides[i] = 1; sides[j] = 0;
          const c = costOf(sides);
          if (c < cur) { cur = c; improved = true; }
          else { sides[i] = 0; sides[j] = 1; }
        }
      }
    }
    if (cur < Infinity) consider(sides.slice());
  }
}
