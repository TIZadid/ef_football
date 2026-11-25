// Team balancing, modelled the way a manager reads a small-sided game.
//
// A player: { id, name, att, def, phy, fb, gk, pos, alt, empty? }
//   ratings are 1–5 (the app fills empty stats with the group average and
//   lists them in `empty`); pos is the main position and alt an optional
//   backup, each one of POSITIONS (pos may be null when unknown).
//
// Each team has a starting line-up of `format` players (5-a-side by default);
// the rest are rotating subs.
//
// How strength is measured
//   - Every outfield starter gets a role (CB, WING, MID, ST, or ANY when the
//     position is unknown). The role decides how much of each rating counts:
//     a striker's attack counts in full, a centre-back's barely; a CB's
//     defense counts in full, a striker's barely. Playing off the main
//     position costs a little (backup 90%, out of position less).
//   - Team units: Attack, Back line (outfield defense + keeper), Engine
//     (physicality + tracking back) and Keeper. The keeper is weighted more
//     the smaller the game.
//   - Everything is measured over the whole squad, bench included: subs
//     rotate in and share minutes. The starting line-up is display only.
//   - Win chance comes from the strength gap through a logistic curve.
//
// Hard rules (always enforced, or the split is rejected):
//   - team sizes differ by at most one
//   - "together" pairs share a team, "apart" pairs don't
//   - pinned keepers end up on different teams, and start in goal
// Structural rules for each team (enforced whenever any split can
// satisfy them; otherwise the least-bad split wins and a warning is returned):
//   - a CB: CB as main/backup position, or DEF 4+
//   - a central player: MID as main/backup position
// Soft goals (the cost function):
//   - expected strength equal (the main term), then each unit equal
//   - stars split: the top three compared best vs best, second vs second…
//   - the team with the weaker keeper gets the stronger back line, including
//     the best defender when keepers differ
//   - the team whose players track back less gets the better CB (and poor
//     tracking back in front of a weak CB counts as leaking goals)
//   - wing / mid / striker roles spread evenly
//   - players who prefer GK, and players with unknown stats, spread out
// Among near-optimal splits the pick prefers fresh match-ups (fewer repeat
// teammates from recent games), with some randomness for "Regenerate".

export const POSITIONS = ['GK', 'CB', 'WING', 'MID', 'ST'];
const OUTFIELD = ['CB', 'WING', 'MID', 'ST'];

// How much of each rating a role turns into attack / defense.
const ROLE = {
  CB: { att: 0.3, def: 1.0, fb: 0.3 },
  WING: { att: 0.9, def: 0.45, fb: 0.5 },
  MID: { att: 0.65, def: 0.7, fb: 0.5 },
  ST: { att: 1.0, def: 0.25, fb: 0.35 },
  ANY: { att: 0.7, def: 0.6, fb: 0.45 },
};

const W = {
  strength: 5, // expected strength gap: the main thing
  atk: 1,
  back: 1,
  eng: 0.6,
  stars: 0.3, // player-impact gap for the top three, best vs best
  top: 0.6, // best player vs best player
  role: 0.4, // wing / mid / striker spread
  weakKeeperBestDefender: 3,
  lazyNeedsCB: 2.5,
  leak: 0.6, // defense lost per point of missing tracking back × CB weakness
  gkSpread: 4,
  unknown: 3, // per fully-unknown player of difference between the teams
};

const TAU = 4; // logistic scale: a strength gap of 1 ≈ 56% win chance
const EXHAUSTIVE_LIMIT = 18;

// Ratings are 1–5, but the steps aren't equal: 1 is clearly weak, and the
// gaps shrink as ratings rise (3, 4 and 5 are close). Every calculation goes
// through this curve.
const CURVE = [1, 1.8, 2.3, 2.6, 2.8];
export const val = (r) => {
  const x = Math.min(5, Math.max(1, r)) - 1;
  const i = Math.min(3, Math.floor(x));
  return CURVE[i] + (CURVE[i + 1] - CURVE[i]) * (x - i);
};
export const MID_RATING = 3;
export const TOP_RATING = 5;

export const plays = (p, pos) => (p.pos === pos ? 1 : p.alt === pos ? 0.5 : 0);
export const isCB = (p) => p.def >= 4 || plays(p, 'CB') > 0;
export const isMid = (p) => plays(p, 'MID') > 0;
// Role-free individual quality, used for star balance and picking starters.
export const impact = (p) => val(p.att) + val(p.def) + 0.8 * val(p.phy) + 0.7 * val(p.fb);
// 0 for a fully rated player, 1 when every stat is empty. (No position on its
// own isn't unknown: it just means the player has no set role.)
export const unknown = (p) => (p.empty?.length ?? 0) / 5;
export const keeperWeight = (format) => (format <= 6 ? 2.2 : format <= 8 ? 1.8 : 1.5);

// How suited a player is to going in goal: GK rating, plus a bonus for
// wanting to play there (an unknown rating counts as 1.5).
export const keeperScore = (p) => val(p.empty?.includes('gk') ? 2 : p.gk) + 1.2 * plays(p, 'GK');

// Who goes in goal: whoever makes the team strongest, the way a manager
// decides. Weighs their keeping (with a bonus for wanting to play there)
// against what the outfield loses without them, so a star with a decent GK
// rating isn't wasted in goal when a willing keeper is nearly as good.
const IMPACT_TO_STRENGTH = 0.55; // a typical outfielder's impact → strength
function pickKeeper(team, pinned, format = 5) {
  if (!team.length) return null;
  const pin = team.find((p) => pinned.has(p.id));
  if (pin) return pin;
  const K = keeperWeight(format);
  const slots = Math.max(0, Math.min(format, team.length) - 1);
  const sorted = team.map(impact).sort((a, b) => b - a);
  const top = sorted.slice(0, slots).reduce((a, b) => a + b, 0);
  let best = null, bestValue = -Infinity;
  for (const p of team) {
    const own = impact(p);
    // Outfield impact left when p keeps: if p would have started outfield,
    // the next best player takes the spot.
    const inTop = own >= (sorted[slots - 1] ?? Infinity);
    const outfield = inTop ? top - own + (sorted[slots] ?? 0) : top;
    const value = K * keeperScore(p) + IMPACT_TO_STRENGTH * outfield;
    if (value > bestValue + 1e-9) { best = p; bestValue = value; }
  }
  return best;
}

// The players best suited to keep goal, best first.
export function suggestKeepers(players, count = 2) {
  return players.slice().sort((a, b) => keeperScore(b) - keeperScore(a) || impact(a) - impact(b)).slice(0, count);
}

function naturalRole(p) {
  if (OUTFIELD.includes(p.pos)) return { role: p.pos, fit: 1 };
  if (OUTFIELD.includes(p.alt)) return { role: p.alt, fit: 0.9 };
  // A keeper playing outfield, or someone whose position nobody knows.
  return { role: 'ANY', fit: p.pos === 'GK' ? 0.85 : 0.95 };
}

// Give each outfield starter a role, making sure the line-up has a CB and a MID
// whenever someone can cover it (without taking the only player of another
// key role).
export function assignRoles(outfield) {
  const roles = new Map(outfield.map((p) => [p, naturalRole(p)]));
  const count = (role) => [...roles.values()].filter((r) => r.role === role).length;
  const cover = (role, can, fitOf, rank) => {
    if (count(role)) return;
    const cands = outfield.filter((p) => {
      const r = roles.get(p).role;
      return can(p) && !((r === 'CB' || r === 'MID') && count(r) === 1);
    });
    if (!cands.length) return;
    const p = cands.sort((a, b) => rank(b) - rank(a))[0];
    roles.set(p, { role, fit: fitOf(p) });
  };
  cover('CB', isCB, (p) => (plays(p, 'CB') ? 0.9 : 0.85), (p) => val(p.def) * 2 + plays(p, 'CB'));
  cover('MID', isMid, () => 0.9, (p) => impact(p));
  return roles;
}

// Choose a team's starters: keeper, a CB, a MID, then the strongest of the rest.
export function lineup(team, { format = 5, keeperMode = 'auto', keepers = [] } = {}) {
  const keeper = keeperMode !== 'none' ? pickKeeper(team, new Set(keepers), format) : null;
  if (team.length <= format) return { starters: team.slice(), subs: [], keeper };
  const starters = keeper ? [keeper] : [];
  const rest = team.filter((p) => p !== keeper).sort((a, b) => impact(b) - impact(a));
  const take = (fits, rank) => {
    if (starters.length >= format || starters.some((p) => p !== keeper && fits(p))) return;
    const cands = rest.filter(fits).sort((a, b) => rank(b) - rank(a));
    if (!cands.length) return;
    starters.push(cands[0]);
    rest.splice(rest.indexOf(cands[0]), 1);
  };
  take(isCB, (p) => plays(p, 'CB') * 10 + val(p.def) + impact(p) / 100);
  take(isMid, (p) => plays(p, 'MID') * 10 + impact(p) / 100);
  while (starters.length < format && rest.length) starters.push(rest.shift());
  const chosen = new Set(starters);
  return { starters, subs: team.filter((p) => !chosen.has(p)), keeper };
}

function outfieldValue(p, role, fit) {
  const w = ROLE[role];
  return {
    atk: fit * (w.att * val(p.att) + 0.15 * val(p.phy)),
    def: fit * (w.def * val(p.def) + w.fb * val(p.fb)),
    eng: 0.6 * val(p.phy) + 0.4 * val(p.fb),
  };
}

// Units for a line-up (`starters`, with `keeper` in goal) plus the rotation
// strength of the whole team.
// A team's units, measured over the whole squad: subs rotate in and share
// minutes, so the starting line-up shown in the app is display only. Sums are
// scaled to the outfield places on the pitch, so a team with one extra player
// isn't counted as stronger just for having more bodies.
export function teamStats(starters, keeper, { format = 5, team = starters } = {}) {
  const K = keeperWeight(format);
  const outfield = team.filter((p) => p !== keeper);
  const roles = assignRoles(outfield);
  const slots = Math.max(0, Math.min(format, team.length) - (keeper ? 1 : 0));
  const scale = outfield.length ? slots / outfield.length : 0;
  const s = {
    size: team.length,
    keeper,
    roles,
    atk: 0, defU: 0, eng: 0,
    gk: keeper ? val(keeper.gk) : 0,
    wing: 0, mid: 0, st: 0,
    cbs: 0, mids: 0, maxDef: 0,
    gkFans: team.filter((p) => p.pos === 'GK').length,
    unknown: team.reduce((sum, p) => sum + unknown(p), 0),
    impacts: outfield.map(impact).sort((a, b) => b - a),
  };
  for (const p of outfield) {
    const { role, fit } = roles.get(p);
    const v = outfieldValue(p, role, fit);
    s.atk += v.atk; s.defU += v.def; s.eng += v.eng;
    if (role === 'WING') s.wing++;
    if (role === 'MID') { s.mid++; s.mids++; }
    if (role === 'ST') s.st++;
    if (role === 'CB') s.cbs++;
    if (val(p.def) > s.maxDef) s.maxDef = val(p.def);
  }
  s.atk *= scale; s.defU *= scale; s.eng *= scale;
  s.wing *= scale; s.mid *= scale; s.st *= scale;
  // Tracking back of the non-CB outfielders, and how good the best CB is.
  const front = outfield.filter((p) => roles.get(p).role !== 'CB');
  const cbsList = outfield.filter((p) => roles.get(p).role === 'CB');
  s.track = front.length ? front.reduce((sum, p) => sum + val(p.fb), 0) / front.length : val(MID_RATING);
  s.cbQ = cbsList.length ? Math.max(...cbsList.map((p) => val(p.def) + 0.3 * (val(p.phy) - val(MID_RATING)))) : 1;
  // A front line that doesn't track back leaves the CB exposed: the weaker
  // the CB, the more it leaks.
  s.defU -= W.leak * Math.max(0, val(MID_RATING) - s.track) * Math.max(0, val(TOP_RATING) - s.cbQ);
  s.back = s.defU + K * s.gk;
  s.expected = s.atk + s.defU + 0.6 * s.eng + K * s.gk;
  s.total = s.expected;
  return s;
}

function pairCost(a, b, useKeepers) {
  let cost =
    W.strength * Math.abs(a.expected - b.expected) +
    W.atk * Math.abs(a.atk - b.atk) +
    W.back * Math.abs(a.back - b.back) +
    W.eng * Math.abs(a.eng - b.eng) +
    W.role * (Math.abs(a.wing - b.wing) + Math.abs(a.mid - b.mid) + Math.abs(a.st - b.st));
  const n = Math.min(a.impacts.length, b.impacts.length, 3);
  let stars = 0;
  for (let i = 0; i < n; i++) stars += Math.abs(a.impacts[i] - b.impacts[i]);
  cost += W.stars * stars + W.top * Math.abs((a.impacts[0] ?? 0) - (b.impacts[0] ?? 0));
  if (useKeepers && Math.abs(a.gk - b.gk) > 0.01) {
    const [weak, strong] = a.gk < b.gk ? [a, b] : [b, a];
    if (weak.maxDef < strong.maxDef) cost += W.weakKeeperBestDefender;
  }
  if (Math.abs(a.track - b.track) > 0.3) {
    const [lazy, busy] = a.track < b.track ? [a, b] : [b, a];
    if (lazy.cbQ < busy.cbQ) cost += W.lazyNeedsCB;
  }
  if (useKeepers) cost += W.gkSpread * Math.max(0, Math.abs(a.gkFans - b.gkFans) - 1);
  cost += W.unknown * Math.abs(a.unknown - b.unknown);
  return cost;
}

// Score a split whose line-ups are already chosen.
function score(ups, teams, useKeepers, format) {
  const stats = ups.map((u, i) => teamStats(u.starters, u.keeper, { format, team: teams[i] }));
  const cost = pairCost(stats[0], stats[1], useKeepers);
  const violations = {
    cb: (stats[0].cbs < 1) + (stats[1].cbs < 1),
    mid: (stats[0].mids < 1) + (stats[1].mids < 1),
  };
  return { cost, violations, structural: violations.cb + violations.mid, stats };
}

export function winChance(a, b) {
  const p = 1 / (1 + Math.exp(-(a.expected - b.expected) / TAU));
  const pa = Math.round(p * 100);
  return [pa, 100 - pa];
}

// Score a split. For a hand-edited result pass `starters` ([idsA, idsB]) and
// optionally `goal` ([idA | null, idB | null]) to fix who keeps.
export function evaluate(teamA, teamB, opts = {}) {
  const keeperMode = opts.keeperMode ?? 'auto';
  const format = opts.format ?? 5;
  const useKeepers = keeperMode !== 'none';
  const teams = [teamA, teamB];
  const ups = teams.map((team, i) => {
    if (!opts.starters) return lineup(team, opts);
    const ids = new Set(opts.starters[i]);
    const starters = team.filter((p) => ids.has(p.id));
    const pinned = new Set([opts.goal?.[i], ...(opts.keepers ?? [])].filter(Boolean));
    const keeper = useKeepers ? pickKeeper(starters, pinned, format) : null;
    return { starters, subs: team.filter((p) => !ids.has(p.id)), keeper };
  });
  const { cost, violations, stats } = score(ups, teams, useKeepers, format);
  const warnings = [];
  if (violations.cb) warnings.push('A team has no CB (CB position or DEF 4+).');
  if (violations.mid) warnings.push('A team has no MID.');
  const side = new Map();
  teamA.forEach((p) => side.set(p.id, 0));
  teamB.forEach((p) => side.set(p.id, 1));
  for (const [x, y] of opts.together ?? []) {
    if (side.has(x) && side.has(y) && side.get(x) !== side.get(y)) warnings.push('A "together" rule is broken.');
  }
  for (const [x, y] of opts.apart ?? []) {
    if (side.has(x) && side.has(y) && side.get(x) === side.get(y)) warnings.push('An "apart" rule is broken.');
  }
  const chance = winChance(stats[0], stats[1]);
  return {
    lineups: ups,
    stats,
    cost,
    chance,
    // The weaker team's strength as a share of the stronger team's.
    balance: Math.round((100 * Math.min(stats[0].expected, stats[1].expected)) / Math.max(stats[0].expected, stats[1].expected, 0.01)),
    warnings,
  };
}

function signature(teamA, teamB) {
  const ids = (t) => t.map((p) => p.id).sort().join(',');
  const [x, y] = [ids(teamA), ids(teamB)].sort();
  return `${x}|${y}`;
}

// How many teammate pairs in a split were also teammates recently
// (newer games count more). `history` is newest first, as [[idsA], [idsB]].
export function repeats(teams, history = []) {
  let total = 0;
  history.forEach((past, age) => {
    const weight = 1 / (age + 1);
    const sideOf = new Map();
    past.forEach((ids, t) => ids.forEach((id) => sideOf.set(id, t)));
    for (const team of teams) {
      for (let i = 0; i < team.length; i++) {
        for (let j = i + 1; j < team.length; j++) {
          const a = sideOf.get(team[i].id), b = sideOf.get(team[j].id);
          if (a !== undefined && a === b) total += weight;
        }
      }
    }
  });
  return total;
}

export class BalanceError extends Error {}

// Returns { teams: [A, B], ...evaluate(), options, signature }.
// opts: format (players per side on the pitch, default 5),
//       together, apart (arrays of [idA, idB]), keepers (pinned ids, max 2),
//       keeperMode ('auto' | 'none'), exclude (a signature to avoid repeating),
//       history (recent splits, newest first), rng (for tests),
//       tolerance (how close to optimal a pick may be).
export function balance(players, opts = {}) {
  const {
    format = 5, together = [], apart = [], keepers = [], keeperMode = 'auto',
    exclude = null, history = [], rng = Math.random, tolerance = 1,
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
    return { teams, ...score(ups, teams, useKeepers, format) };
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
  // Prefer the fairest and freshest: weight each option by closeness to the
  // best cost and by how few recent teammate pairs it repeats.
  const weights = options.map((c) => Math.exp(-2 * (c.cost - best.cost) - 0.35 * repeats([c.A, c.B], history)));
  let roll = rng() * weights.reduce((a, b) => a + b, 0);
  let pick = options[options.length - 1];
  for (let i = 0; i < options.length; i++) {
    roll -= weights[i];
    if (roll <= 0) { pick = options[i]; break; }
  }
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
