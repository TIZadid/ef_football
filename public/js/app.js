import { balance, evaluate, BalanceError, POSITIONS, isCB } from './balance.js';
import { renderShareImage, shareText } from './share.js';

const app = document.getElementById('app');
const sheetRoot = document.getElementById('sheet-root');

// ---------- storage ----------
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(`gameon.${key}`); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`gameon.${key}`, JSON.stringify(value)); } catch { /* private mode */ }
  },
};

const RATINGS = [
  ['att', 'ATT', 'Attack', 'Goal threat'],
  ['def', 'DEF', 'Defense', '3 = centre-back'],
  ['phy', 'PHY', 'Physical', 'Strength & engine'],
  ['fb', 'BCK', 'Falls back', 'Tracks back to help'],
  ['gk', 'GK', 'Goalkeeping', 'Between the sticks'],
];
const POS_LABEL = { GK: 'Keeper', CB: 'Centre-back', WING: 'Winger', MID: 'Midfield', ST: 'Striker' };
const FORMATS = [5, 6, 7, 8, 9, 11];
const DEFAULT_FORMAT = 5;
const TEAM_NAMES = ['Lime', 'Orange'];

// Players saved before positions existed used wing / central / both.
const LEGACY_POS = { wing: ['WING', null], central: ['MID', null], both: ['MID', 'WING'] };
// A player added without stats counts as average with no position, so they
// never fill a team's CB or MID slot.
const unratedStats = (p) => ({ ...p, att: 2, def: 2, phy: 2, fb: 2, gk: 1, pos: null, alt: null, unrated: true });

function normalise(p) {
  const clamp = (v, d = 2) => Math.min(3, Math.max(1, Math.round(Number(v) || d)));
  const [legacyPos, legacyAlt] = LEGACY_POS[p.pos] ?? [];
  const pos = POSITIONS.includes(p.pos) ? p.pos : legacyPos ?? 'MID';
  const alt = POSITIONS.includes(p.alt) && p.alt !== pos ? p.alt : legacyPos ? legacyAlt : null;
  if (p.unrated) return { ...unratedStats(p), id: String(p.id || uid()), name: String(p.name).slice(0, 18), ...(p.guest ? { guest: true } : {}) };
  return {
    id: String(p.id || uid()), name: String(p.name).slice(0, 18),
    att: clamp(p.att), def: clamp(p.def), phy: clamp(p.phy), fb: clamp(p.fb), gk: clamp(p.gk, 1),
    pos, alt, ...(p.guest ? { guest: true } : {}),
  };
}

const state = {
  pool: store.get('pool', []).map(normalise),
  session: {
    picked: [], guests: [], together: [], apart: [], keepers: [], keeperMode: 'auto', format: DEFAULT_FORMAT, result: null,
    ...store.get('session', {}),
  },
  reveal: false,
};
state.session.guests = state.session.guests.map(normalise);
if (state.session.result && !state.session.result.starters) state.session.result = null;

// ---------- helpers ----------
function uid() { return Math.random().toString(36).slice(2, 10); }
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pad = (n) => String(n).padStart(2, '0');
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const dateLabel = () => new Date().toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' }).toUpperCase();
const posTag = (p) => (p.unrated ? 'ANY' : `${p.pos}${p.alt ? ` · ${p.alt}` : ''}`);
const buzz = (pattern) => navigator.vibrate && navigator.vibrate(pattern);

const everyone = () => [...state.pool, ...state.session.guests];
const byId = (id) => everyone().find((p) => p.id === id);
const playing = () => state.session.picked.map(byId).filter(Boolean);
const isPlaying = (id) => state.session.picked.includes(id);

function save() {
  store.set('pool', state.pool);
  store.set('session', state.session);
}

// Drop references to players who no longer exist.
function prune() {
  const s = state.session;
  const ids = new Set(everyone().map((p) => p.id));
  s.picked = s.picked.filter((id) => ids.has(id));
  s.keepers = s.keepers.filter((id) => ids.has(id));
  s.together = s.together.filter(([a, b]) => ids.has(a) && ids.has(b));
  s.apart = s.apart.filter(([a, b]) => ids.has(a) && ids.has(b));
  if (s.result && s.result.teams.flat().some((id) => !ids.has(id))) s.result = null;
  save();
}

function balanceOpts() {
  const s = state.session;
  return {
    format: s.format,
    together: s.together,
    apart: s.apart,
    keeperMode: s.keeperMode,
    keepers: s.keeperMode === 'none' ? [] : s.keepers.filter(isPlaying),
  };
}

let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1900);
}

function bump(el) {
  el.classList.remove('bump');
  void el.offsetWidth;
  el.classList.add('bump');
}

const bars = (p) => `<div class="bars">${RATINGS.map(([k, short]) => `
  <div><span>${short}</span><p>${[1, 2, 3].map((n) => `<i class="${p[k] >= n ? 'f' : ''}"></i>`).join('')}</p></div>`).join('')}</div>`;

const topbar = (back, step) => `
  <div class="topbar" style="--d:0">
    <button class="icon-btn" data-go="${back}" aria-label="Back">←</button>
    <span class="mono muted">${step ? `Step ${pad(step)} / 03` : dateLabel()}</span>
    ${step ? `<div class="steps">${[1, 2, 3].map((n) => `<i class="${n <= step ? 'on' : ''}"></i>`).join('')}</div>` : ''}
  </div>`;

// ---------- routing ----------
const ROUTES = { home, squad, pick, rules, result };

function routeFromHash() {
  const r = location.hash.slice(1);
  return r in ROUTES ? r : 'home';
}

function go(name) {
  if (location.hash === `#${name}`) show(name);
  else location.hash = name;
}

function show(name, animate = true) {
  if (name === 'result' && !state.session.result) name = 'pick';
  const paint = () => {
    app.replaceChildren(ROUTES[name]());
    window.scrollTo(0, 0);
    if (name === 'result' && state.reveal) { state.reveal = false; requestAnimationFrame(revealTeams); }
  };
  if (!animate || reduced()) return paint();
  const wipe = h('<div class="wipe"></div>');
  document.body.append(wipe);
  setTimeout(paint, 290);
  wipe.addEventListener('animationend', () => wipe.remove());
}

window.addEventListener('hashchange', () => { closeSheet(); show(routeFromHash()); });
document.addEventListener('click', (e) => {
  const target = e.target.closest('[data-go]');
  if (!target) return;
  // Every new game starts as 5-a-side.
  if (target.hasAttribute('data-new-game')) { state.session.format = DEFAULT_FORMAT; save(); }
  go(target.dataset.go);
});

// ---------- home ----------
function home() {
  const s = state.session;
  const words = ['Attack', 'Defense', 'Physical', 'Track back', 'Keepers', 'Fair teams', 'Game on'];
  const ruleCount = s.together.length + s.apart.length;
  return h(`
    <section class="screen home">
      <div class="meta" style="--d:0">
        <span class="mono">${dateLabel()}</span>
        <span class="mono lime">● Matchday</span>
      </div>
      <div class="hero" style="--d:1">
        <h1 class="display headline"><span>Game</span><span>On<span class="dot">.</span></span></h1>
      </div>
      <p class="sub" style="--d:2">Tap who's in tonight. Get two fair teams in seconds, then drop them in the group chat.</p>
      <div class="tags" style="--d:3">
        <span class="tag">Squad <b>${pad(state.pool.length)}</b></span>
        <span class="tag">In tonight <b>${pad(s.picked.length)}</b></span>
        <span class="tag">Rules <b>${pad(ruleCount)}</b></span>
      </div>
      <div class="home-actions" style="--d:4">
        <button class="btn" data-go="pick" data-new-game>Make teams <span class="arrow">→</span></button>
        <button class="btn ghost" data-go="squad"><span>Squad</span></button>
      </div>
      <div class="ticker" style="--d:5" aria-hidden="true">
        <div>${[...words, ...words].map((w) => `<span>${w}</span>`).join('')}</div>
      </div>
    </section>`);
}

// ---------- squad ----------
function squad() {
  const el = h(`
    <section class="screen">
      ${topbar('home')}
      <h1 class="display headline" style="--d:1">The <span class="out">squad</span></h1>
      <p class="sub" style="--d:2">Your regulars. Tap anyone to change their ratings or position. Ratings go from 1 to 3.</p>
      <div style="--d:3">
        ${state.pool.length ? '' : `
          <div class="empty">
            <p class="display">Empty pitch</p>
            <p class="muted">Add your regulars to get started.</p>
            <button class="btn small paper" data-add>Add first player</button>
          </div>`}
        <div class="grid">
          ${state.pool.map((p, i) => ticket(p, i, false)).join('')}
          <button class="add-tile" data-add><b>+</b>Player</button>
        </div>
        <div class="squad-actions">
          <button class="chip" data-export>Export squad</button>
          <label class="chip">Import squad<input type="file" accept="application/json" hidden data-import></label>
        </div>
      </div>
      <div class="dock"><div class="dock-inner">
        <button class="btn" data-go="pick" data-new-game>Make teams <span class="arrow">→</span></button>
      </div></div>
    </section>`);

  el.addEventListener('click', (e) => {
    const t = e.target.closest('.ticket');
    if (t) return openPlayerSheet({ player: byId(t.dataset.id) });
    if (e.target.closest('[data-add]')) return openPlayerSheet({});
    if (e.target.closest('[data-export]')) return exportSquad();
  });
  el.querySelector('[data-import]').addEventListener('change', importSquad);
  return el;
}

function exportSquad() {
  const blob = new Blob([JSON.stringify(state.pool, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'squad.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

async function importSquad(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data)) throw new Error();
    state.pool = data.filter((p) => p && p.name).map((p) => normalise({ ...p, guest: false }));
    prune();
    toast(`${state.pool.length} players imported`);
    show('squad', false);
  } catch {
    toast('That file isn\'t a squad');
  }
}

// The demo squad was removed. Clear any demo players still saved in the
// browser, matching name, ratings and positions exactly so real players stay.
const DEMO_PLAYERS = new Set([
  'Arif,3,1,2,1,1,WING,ST', 'Sabbir,2,3,3,2,1,CB,', 'Nayeem,1,3,2,3,2,CB,MID', 'Rakib,3,2,2,2,1,MID,ST',
  'Fahim,2,2,1,3,3,GK,MID', 'Tanvir,1,2,3,2,2,WING,', 'Imran,2,3,2,1,1,CB,', 'Shuvo,3,1,1,1,1,ST,WING',
  'Rony,2,2,3,3,1,MID,WING', 'Mahin,1,1,2,2,3,GK,', 'Sakib,3,2,3,2,1,MID,', 'Jamil,2,1,1,2,2,WING,MID',
]);
function removeDemoPlayers() {
  const key = (p) => [p.name, p.att, p.def, p.phy, p.fb, p.gk, p.pos, p.alt ?? ''].join(',');
  const before = state.pool.length;
  state.pool = state.pool.filter((p) => !DEMO_PLAYERS.has(key(p)));
  if (state.pool.length !== before) prune();
}

// ---------- tickets ----------
function ticket(p, i, selectable = true) {
  const on = selectable && isPlaying(p.id);
  return `
    <button class="ticket ${on ? 'on' : ''}" data-id="${p.id}" style="--i:${i}" ${selectable ? `aria-pressed="${on}"` : ''}>
      ${selectable ? '<span class="stamp">IN</span>' : ''}
      <span class="name">${esc(p.name)}</span>
      ${p.unrated ? '<span class="no-stats">No stats · plays as average</span>' : bars(p)}
      <span class="row">
        <span class="pos">${posTag(p)}</span>
        ${p.guest ? '<span class="pos guest-tag" data-remove title="Remove guest">GUEST ✕</span>' : '<span class="barcode" style="flex:1;max-width:56px"></span>'}
      </span>
    </button>`;
}

// ---------- step 1: pick ----------
function pick() {
  const s = state.session;
  const list = everyone();
  const el = h(`
    <section class="screen">
      ${topbar('home', 1)}
      <h1 class="display headline" style="--d:1">Who's <span class="out">in?</span></h1>
      <p class="sub" style="--d:2">Tap everyone playing tonight. Someone new? Add them as a guest, just for tonight.</p>
      <div style="--d:3">
        <div class="format">
          <span class="mono muted">Players a side</span>
          <div class="format-opts">
            ${FORMATS.map((f) => `<button class="${s.format === f ? 'on' : ''}" data-format="${f}">${f}</button>`).join('')}
          </div>
        </div>
        <div class="toolbar">
          <button class="chip" data-all>All in</button>
          <button class="chip" data-none>Clear</button>
          <button class="chip" data-go="squad">Edit squad</button>
        </div>
      </div>
      <div class="grid" style="--d:4">
        ${list.map((p, i) => ticket(p, i)).join('')}
        <button class="add-tile" data-guest><b>+</b>Guest</button>
      </div>
      ${state.pool.length ? '' : `<div class="empty" style="--d:5;margin-top:14px"><p class="muted">No squad yet.</p><button class="btn small paper" data-go="squad">Set up squad</button></div>`}
      <div class="dock"><div class="dock-inner">
        <div class="tally"><span class="count" data-count>${pad(s.picked.length)}</span><span class="mono muted" data-split-info></span></div>
        <button class="btn" data-next>Next <span class="arrow">→</span></button>
      </div></div>
    </section>`);

  const count = el.querySelector('[data-count]');
  const info = el.querySelector('[data-split-info]');
  const next = el.querySelector('[data-next]');
  const sync = (animate = true) => {
    const n = s.picked.length;
    const subs = Math.max(0, n - 2 * s.format);
    count.textContent = pad(n);
    if (animate) bump(count);
    info.textContent = n < 2 ? 'pick 2+' : subs ? `${s.format}v${s.format} +${subs} sub${subs > 1 ? 's' : ''}` : `${Math.floor(n / 2)}v${Math.ceil(n / 2)}`;
    next.disabled = n < 2;
    save();
  };

  el.addEventListener('click', (e) => {
    const f = e.target.closest('[data-format]');
    if (f) {
      s.format = Number(f.dataset.format);
      el.querySelectorAll('[data-format]').forEach((b) => b.classList.toggle('on', b === f));
      buzz(8);
      return sync(false);
    }
    const remove = e.target.closest('[data-remove]');
    if (remove) {
      const card = remove.closest('.ticket');
      const id = card.dataset.id;
      s.guests = s.guests.filter((g) => g.id !== id);
      prune();
      card.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.7) rotate(8deg)' }], { duration: 250 }).onfinish = () => card.remove();
      return sync();
    }
    const t = e.target.closest('.ticket');
    if (t) {
      const id = t.dataset.id;
      s.picked = isPlaying(id) ? s.picked.filter((x) => x !== id) : [...s.picked, id];
      t.classList.toggle('on', isPlaying(id));
      t.setAttribute('aria-pressed', isPlaying(id));
      buzz(8);
      return sync();
    }
    if (e.target.closest('[data-all]')) {
      s.picked = everyone().map((p) => p.id);
      el.querySelectorAll('.ticket').forEach((t2) => t2.classList.add('on'));
      return sync();
    }
    if (e.target.closest('[data-none]')) {
      s.picked = [];
      el.querySelectorAll('.ticket').forEach((t2) => t2.classList.remove('on'));
      return sync();
    }
    if (e.target.closest('[data-guest]')) return openPlayerSheet({ guest: true });
    if (e.target.closest('[data-next]')) return go('rules');
  });
  sync(false);
  return el;
}

// ---------- step 2: rules ----------
function rules() {
  const s = state.session;
  let mode = 'together';
  let first = null;
  const players = playing();
  const active = (pair) => pair.every(isPlaying);
  const hints = {
    together: 'Tap two players who must be on the same team.',
    apart: 'Tap two players who must be on different teams.',
    keeper: 'Tap up to two players to put in goal. Otherwise the best keeper on each team goes in.',
  };

  const el = h(`
    <section class="screen">
      ${topbar('pick', 2)}
      <h1 class="display headline" style="--d:1">House <span class="out">rules</span></h1>
      <p class="sub" style="--d:2">All optional. Rules are saved and come back next time those players are in.</p>
      <div style="--d:3">
        <div class="seg" role="tablist">
          <button data-mode="together" class="on">Together</button>
          <button data-mode="apart">Apart</button>
          <button data-mode="keeper">🧤 Keeper</button>
        </div>
        <p class="hint" data-hint></p>
        <div class="people" data-people></div>
        <div class="rules" data-rules></div>
      </div>
      <div style="--d:4">
        <div class="section-title"><h2 class="display">Keepers</h2><span class="mono muted">GK rating</span></div>
        <div class="seg" data-kmode>
          <button data-k="auto">Fixed keepers</button>
          <button data-k="none">Rolling / none</button>
        </div>
        <p class="hint" data-khint></p>
      </div>
      <div class="dock"><div class="dock-inner">
        <div class="tally"><span class="count">${pad(players.length)}</span><span class="mono muted">${s.format}-a-side</span></div>
        <button class="btn" data-split>Split 'em <span class="arrow">⚡</span></button>
      </div></div>
    </section>`);

  const $ = (sel) => el.querySelector(sel);
  const refresh = () => {
    $('[data-hint]').textContent = first ? `${byId(first).name} + … tap one more` : hints[mode];
    el.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
    el.querySelectorAll('[data-k]').forEach((b) => b.classList.toggle('on', b.dataset.k === s.keeperMode));
    $('[data-khint]').textContent = s.keeperMode === 'none'
      ? 'Nobody stays in goal, so GK ratings are ignored.'
      : 'Each team gets a keeper. The team with the weaker keeper gets the stronger defense.';
    const gks = s.keeperMode === 'none' ? [] : s.keepers;
    $('[data-people]').innerHTML = players.map((p) => `
      <button class="person ${first === p.id ? 'sel' : ''} ${gks.includes(p.id) ? 'gk' : ''}" data-id="${p.id}">${esc(p.name)}</button>`).join('');
    const items = [
      ...s.together.filter(active).map((r) => ['together', r]),
      ...s.apart.filter(active).map((r) => ['apart', r]),
      ...gks.filter(isPlaying).map((id) => ['keeper', [id]]),
    ];
    const hidden = s.together.length + s.apart.length - items.filter(([k]) => k !== 'keeper').length;
    $('[data-rules]').innerHTML = items.map(([kind, ids]) => `
      <div class="rule ${kind}">
        <span class="label">${ids.map((id) => esc(byId(id).name)).join(kind === 'apart' ? ' ✕ ' : ' + ')}</span>
        <span class="kind">${kind === 'keeper' ? 'IN GOAL' : kind.toUpperCase()}</span>
        <button data-del="${kind}:${ids.join(',')}" aria-label="Remove rule">✕</button>
      </div>`).join('') + (hidden ? `<p class="hint">+${hidden} saved rule${hidden > 1 ? 's' : ''} for players not in tonight</p>` : '');
  };

  const samePair = (a, b) => ([x, y]) => (x === a && y === b) || (x === b && y === a);
  el.addEventListener('click', (e) => {
    const m = e.target.closest('[data-mode]');
    if (m) { mode = m.dataset.mode; first = null; return refresh(); }
    const k = e.target.closest('[data-k]');
    if (k) { s.keeperMode = k.dataset.k; save(); return refresh(); }
    const del = e.target.closest('[data-del]');
    if (del) {
      const [kind, list] = del.dataset.del.split(':');
      const [a, b] = list.split(',');
      if (kind === 'keeper') s.keepers = s.keepers.filter((x) => x !== a);
      else s[kind] = s[kind].filter((r) => !samePair(a, b)(r));
      save();
      return refresh();
    }
    const person = e.target.closest('.person');
    if (person) {
      const id = person.dataset.id;
      if (mode === 'keeper') {
        if (s.keeperMode === 'none') s.keeperMode = 'auto';
        s.keepers = s.keepers.includes(id) ? s.keepers.filter((x) => x !== id) : [...s.keepers.filter(isPlaying), id].slice(-2);
      } else if (!first || first === id) {
        first = first === id ? null : id;
      } else {
        const other = mode === 'together' ? 'apart' : 'together';
        s[other] = s[other].filter((r) => !samePair(first, id)(r));
        if (!s[mode].some(samePair(first, id))) s[mode].push([first, id]);
        first = null;
        buzz([10, 40, 10]);
      }
      save();
      return refresh();
    }
    if (e.target.closest('[data-split]')) {
      if (runSplit()) { state.reveal = true; go('result'); }
    }
  });
  refresh();
  return el;
}

function runSplit(exclude = null) {
  try {
    const r = balance(playing(), { ...balanceOpts(), exclude });
    state.session.result = {
      teams: r.teams.map((t) => t.map((p) => p.id)),
      starters: r.lineups.map((u) => u.starters.map((p) => p.id)),
      goal: r.lineups.map((u) => u.keeper?.id ?? null),
      signature: r.signature,
      options: r.options,
      edited: false,
    };
    save();
    return true;
  } catch (err) {
    toast(err instanceof BalanceError ? err.message : 'Something went wrong');
    console.error(err);
    return false;
  }
}

function currentResult() {
  const r = state.session.result;
  const teams = r.teams.map((ids) => ids.map(byId));
  const ev = evaluate(teams[0], teams[1], { ...balanceOpts(), starters: r.starters, goal: r.goal });
  const format = state.session.format;
  ev.lineups.forEach((u, t) => {
    const want = Math.min(format, teams[t].length);
    if (u.starters.length !== want) ev.warnings.push(`Team ${TEAM_NAMES[t]} has ${u.starters.length} starting (${want} needed).`);
  });
  return { teams, options: r.options, edited: r.edited, ...ev };
}

// ---------- step 3: result ----------
function result() {
  const el = h(`
    <section class="screen">
      ${topbar('rules', 3)}
      <div data-body style="--d:1"></div>
      <div class="dock"><div class="dock-inner">
        <button class="btn orange small regen" data-shuffle aria-label="Regenerate teams"><span class="spin">↻</span> Regenerate</button>
        <button class="btn" data-share>Send <span class="arrow">↗</span></button>
      </div></div>
    </section>`);
  const body = el.querySelector('[data-body]');

  const paint = () => {
    const r = currentResult();
    const [a, b] = r.stats;
    const rows = [['ATT', a.att, b.att], ['DEF', a.def, b.def], ['PHY', a.phy, b.phy], ['BCK', a.fb, b.fb]];
    if (state.session.keeperMode !== 'none') rows.push(['GK', a.gk, b.gk]);
    const hasSubs = r.lineups.some((u) => u.subs.length);
    body.innerHTML = `
      <div class="meter">
        <div>
          <span class="mono muted">${dateLabel()} · ${state.session.format}-a-side</span>
          <h1 class="display headline">Kick<span class="out">off</span></h1>
        </div>
        <div style="text-align:right">
          <div class="pct">${r.balance}<small>%</small></div>
          <span class="mono muted">${hasSubs ? 'starters ' : ''}balanced</span>
        </div>
      </div>
      <div class="versus">
        <span class="vs">VS</span>
        ${r.teams.map((team, t) => teamPanel(r.lineups[t], t)).join('')}
      </div>
      ${r.warnings.map((w) => `<div class="warn">⚠ ${esc(w)}</div>`).join('')}
      <p class="edit-hint"><span>✎</span> Tap any player to swap, move, bench or put them in goal.</p>
      <div class="compare">
        <p class="mono muted">${hasSubs ? 'Starting line-ups' : 'Teams'}</p>
        ${rows.map(([k, va, vb]) => {
          const max = Math.max(va, vb, 1);
          return `<div class="cmp">
            <span class="v lime">${va}</span>
            <span class="track"><i style="--w:${(va / max) * 100}%"></i></span>
            <span class="k">${k}</span>
            <span class="track b"><i style="--w:${(vb / max) * 100}%"></i></span>
            <span class="v orange">${vb}</span>
          </div>`;
        }).join('')}
      </div>
      <p class="mono muted">${hasSubs ? `Whole squads incl. subs: ${r.fullBalance}% balanced. ` : ''}${r.edited ? 'Edited by hand.' : r.options > 1 ? `One of ${r.options} equally fair splits.` : 'The only fair split.'}</p>`;
  };

  el.addEventListener('click', (e) => {
    const slot = e.target.closest('.slot');
    if (slot) return openEditSheet(slot.dataset.id, body, paint);
    const regen = e.target.closest('[data-shuffle]');
    if (regen) {
      const prev = state.session.result.signature;
      if (runSplit(prev)) {
        regen.querySelector('.spin').animate([{ transform: 'rotate(0)' }, { transform: 'rotate(360deg)' }], { duration: 600, easing: 'cubic-bezier(.16,1,.3,1)' });
        buzz(12);
        paint();
        revealTeams();
      }
      return;
    }
    if (e.target.closest('[data-share]')) openShareSheet();
  });

  paint();
  return el;
}

function slotHtml(p, keeper) {
  const isGk = p === keeper;
  return `
    <li><button class="slot ${isGk ? 'keeper' : ''}" data-id="${p.id}">
      <span class="nm">${isGk ? '🧤 ' : ''}${esc(p.name)}</span>
      <span class="badges">
        ${!isGk && isCB(p) ? '<span class="b cb">CB</span>' : ''}
        <span class="b">${isGk ? `GK${p.gk}` : p.pos ?? '?'}</span>
      </span>
    </button></li>`;
}

function teamPanel(u, t) {
  const starters = u.keeper ? [u.keeper, ...u.starters.filter((p) => p !== u.keeper)] : u.starters;
  return `
    <div class="team ${t ? 'b' : 'a'}">
      <header>
        <span class="mono">${u.starters.length + u.subs.length} players</span>
        <h2 class="display">${TEAM_NAMES[t]}</h2>
      </header>
      <ol>${starters.map((p) => slotHtml(p, u.keeper)).join('')}</ol>
      ${u.subs.length ? `<p class="bench-label mono">Subs</p><ol class="bench">${u.subs.map((p) => slotHtml(p, null)).join('')}</ol>` : ''}
    </div>`;
}

// ---------- editing a result ----------
function openEditSheet(id, body, paint) {
  const r = state.session.result;
  const p = byId(id);
  const t = r.teams[0].includes(id) ? 0 : 1;
  const o = 1 - t;
  const starting = r.starters[t].includes(id);
  const current = currentResult();
  const isGk = current.lineups[t].keeper?.id === id;
  const useKeepers = state.session.keeperMode !== 'none';
  const status = isGk ? 'In goal' : starting ? 'Starting' : 'Sub';
  const name = (x) => esc(byId(x).name);
  const chip = (x, extra = '') => `<button class="swap-chip ${extra}" data-swap="${x}">${name(x)}<small>${r.starters[r.teams[0].includes(x) ? 0 : 1].includes(x) ? (current.lineups.some((u) => u.keeper?.id === x) ? 'GK' : 'START') : 'SUB'}</small></button>`;
  const teammates = r.teams[t].filter((x) => x !== id && r.starters[t].includes(x) !== starting);
  const canStart = !starting && r.starters[t].length < Math.min(state.session.format, r.teams[t].length);

  const sheet = openSheet(`
    <span class="mono">Team ${TEAM_NAMES[t]} · ${status}</span>
    <h2 class="display">${esc(p.name)}</h2>
    <div class="quick">
      ${useKeepers && starting && !isGk ? '<button class="btn paper small" data-act="goal">🧤 Put in goal</button>' : ''}
      ${starting ? '<button class="btn paper small" data-act="bench">Bench</button>' : ''}
      ${canStart ? '<button class="btn paper small" data-act="start">Start</button>' : ''}
      <button class="btn small ${o ? 'orange' : ''}" data-act="move">Move to ${TEAM_NAMES[o]} →</button>
    </div>
    <p class="mono sheet-label">Swap with ${TEAM_NAMES[o]}</p>
    <div class="swap-grid ${o ? 'b' : 'a'}">${r.teams[o].map((x) => chip(x)).join('')}</div>
    ${teammates.length ? `<p class="mono sheet-label">${starting ? 'Swap with a sub' : 'Swap with a starter'}</p>
    <div class="swap-grid same">${teammates.map((x) => chip(x)).join('')}</div>` : ''}`);

  const apply = (fn, msg) => {
    const before = snapshot(body);
    fn();
    r.signature = null;
    r.edited = true;
    save();
    closeSheet();
    paint();
    flip(body, before, [id]);
    buzz(10);
    if (msg) toast(msg);
  };
  const replace = (list, a, b) => { const i = list.indexOf(a); if (i >= 0) list[i] = b; };

  sheet.addEventListener('click', (e) => {
    const sw = e.target.closest('[data-swap]');
    if (sw) {
      const x = sw.dataset.swap;
      const tx = r.teams[0].includes(x) ? 0 : 1;
      return apply(() => {
        if (tx !== t) {
          // Trade places: each takes the other's team and starting/sub slot.
          replace(r.teams[t], id, x); replace(r.teams[tx], x, id);
          replace(r.starters[t], id, x); replace(r.starters[tx], x, id);
          r.goal = r.goal.map((g) => (g === id ? x : g === x ? id : g));
        } else {
          // Same team: starter and sub change places.
          const [st, sub] = starting ? [id, x] : [x, id];
          replace(r.starters[t], st, sub);
          if (r.goal[t] === st) r.goal[t] = null;
        }
      }, `${byId(id).name} ⇄ ${byId(x).name}`);
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'goal') return apply(() => { r.goal[t] = id; }, `${p.name} in goal`);
    if (act === 'bench') return apply(() => { r.starters[t] = r.starters[t].filter((x) => x !== id); if (r.goal[t] === id) r.goal[t] = null; }, `${p.name} to the bench`);
    if (act === 'start') return apply(() => { r.starters[t].push(id); }, `${p.name} starts`);
    if (act === 'move') {
      return apply(() => {
        r.teams[t] = r.teams[t].filter((x) => x !== id);
        r.teams[o].push(id);
        r.starters[t] = r.starters[t].filter((x) => x !== id);
        if (r.goal[t] === id) r.goal[t] = null;
        if (r.starters[o].length < state.session.format) r.starters[o].push(id);
      }, `${p.name} → ${TEAM_NAMES[o]}`);
    }
  });
}

// Cards fly in from a shuffled pile in the middle.
function revealTeams() {
  if (reduced()) return;
  const slots = [...app.querySelectorAll('.slot')];
  const versus = app.querySelector('.versus');
  if (!versus) return;
  const box = versus.getBoundingClientRect();
  const cx = box.left + box.width / 2;
  const cy = box.top + Math.min(box.height / 2, 200);
  slots.forEach((s) => {
    const r = s.getBoundingClientRect();
    const rot = (Math.random() - 0.5) * 50;
    s.style.transform = `translate(${cx - (r.left + r.width / 2)}px, ${cy - (r.top + r.height / 2)}px) rotate(${rot}deg) scale(.85)`;
    s.style.opacity = '0';
  });
  void versus.offsetWidth;
  const order = slots.map((s, i) => [s, i]).sort(() => Math.random() - 0.5);
  order.forEach(([s], k) => {
    s.classList.add('flying');
    s.style.transitionDelay = `${120 + k * 55}ms`;
    s.style.transform = '';
    s.style.opacity = '';
    s.addEventListener('transitionend', () => { s.classList.remove('flying'); s.style.transitionDelay = ''; }, { once: true });
  });
}

function snapshot(root) {
  const map = new Map();
  root.querySelectorAll('.slot').forEach((s) => map.set(s.dataset.id, s.getBoundingClientRect()));
  return map;
}

function flip(root, before, ids) {
  root.querySelectorAll('.slot').forEach((s) => {
    const from = before.get(s.dataset.id);
    if (!from) return;
    const to = s.getBoundingClientRect();
    const dx = from.left - to.left, dy = from.top - to.top;
    const moved = dx || dy;
    if (moved) {
      s.animate([{ transform: `translate(${dx}px, ${dy}px) rotate(${moved && Math.abs(dx) > 20 ? 6 : 0}deg)` }, { transform: 'none' }],
        { duration: reduced() ? 1 : 560, easing: 'cubic-bezier(.16,1,.3,1)' });
    }
    if (moved || ids.includes(s.dataset.id)) s.classList.add('flash');
  });
}

// ---------- sheets ----------
let activeSheet = null;
function openSheet(html) {
  closeSheet();
  const backdrop = h('<div class="backdrop"></div>');
  const sheet = h(`<div class="sheet" role="dialog" aria-modal="true"><button class="sheet-close" aria-label="Close">✕</button>${html}</div>`);
  sheetRoot.append(backdrop, sheet);
  backdrop.addEventListener('click', closeSheet);
  sheet.querySelector('.sheet-close').addEventListener('click', closeSheet);
  activeSheet = { backdrop, sheet };
  return sheet;
}
function closeSheet() {
  if (!activeSheet) return;
  const { backdrop, sheet } = activeSheet;
  activeSheet = null;
  backdrop.classList.add('closing');
  sheet.classList.add('closing');
  setTimeout(() => { backdrop.remove(); sheet.remove(); }, reduced() ? 0 : 280);
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

function openPlayerSheet({ player = null, guest = false }) {
  const draft = player ? { ...player, pos: player.pos ?? 'MID' } : { id: uid(), name: '', att: 2, def: 2, phy: 2, fb: 2, gk: 1, pos: 'MID', alt: null };
  // New guests start as name-only; ratings are optional.
  let rated = !(guest && !player);
  const posButtons = () => POSITIONS.map((v) => `<button type="button" data-v="${v}" class="${draft.pos === v ? 'on' : ''}">${v}</button>`).join('');
  const altButtons = () => ['', ...POSITIONS].map((v) => `
    <button type="button" data-v="${v}" class="${(draft.alt ?? '') === v ? 'on' : ''}" ${v && v === draft.pos ? 'disabled' : ''}>${v || '—'}</button>`).join('');
  const sheet = openSheet(`
    <span class="mono">${player ? 'Edit player' : guest ? 'Tonight only' : 'New regular'}</span>
    <h2 class="display">${player ? esc(player.name) : guest ? 'Guest' : 'New player'}</h2>
    <label class="field"><input type="text" maxlength="18" placeholder="Name" autocomplete="off" value="${esc(draft.name)}"></label>
    ${rated ? '' : '<button type="button" class="reveal-stats" data-rate>+ Add stats & position <small>optional</small></button>'}
    ${player?.unrated ? '<p class="sheet-note">No stats yet. Rate them below, or leave as is to keep them average.</p>' : ''}
    <div class="details" ${rated ? '' : 'hidden'}>
    <div class="pos-block">
      <div class="lbl-row"><b>Main position</b><small data-pos-name>${POS_LABEL[draft.pos]}</small></div>
      <div class="seg pos-seg" data-pos>${posButtons()}</div>
      <div class="lbl-row"><b>Backup</b><small>Optional</small></div>
      <div class="seg pos-seg alt" data-alt>${altButtons()}</div>
    </div>
    ${RATINGS.map(([k, , label, help]) => `
      <div class="rate" data-k="${k}">
        <div class="lbl"><b>${label}</b><small>${help}</small></div>
        <div class="pips">${[1, 2, 3].map((n) => `<button type="button" data-n="${n}" class="${draft[k] >= n ? 'f' : ''}" aria-label="${label} ${n}">${n}</button>`).join('')}</div>
      </div>`).join('')}
    </div>
    ${guest ? '<label class="check"><input type="checkbox" data-keep> Add to the squad too</label>' : ''}
    <div class="actions">
      ${player ? '<button class="btn ghost small" data-del><span>Delete</span></button>' : ''}
      <button class="btn" data-save>${guest ? 'Add guest' : 'Save'}</button>
    </div>`);

  const input = sheet.querySelector('input[type="text"]');
  if (!player) setTimeout(() => input.focus(), 350);
  let touched = false;

  sheet.addEventListener('click', (e) => {
    if (e.target.closest('[data-rate]')) {
      rated = true;
      e.target.closest('[data-rate]').remove();
      const details = sheet.querySelector('.details');
      details.hidden = false;
      details.animate([{ opacity: 0, transform: 'translateY(12px)' }, { opacity: 1, transform: 'none' }], { duration: 300, easing: 'cubic-bezier(.16,1,.3,1)' });
      return;
    }
    const pipBtn = e.target.closest('.pips button');
    if (pipBtn) {
      touched = true;
      const k = pipBtn.closest('.rate').dataset.k;
      draft[k] = Number(pipBtn.dataset.n);
      pipBtn.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('f', Number(b.dataset.n) <= draft[k]));
      return;
    }
    const posBtn = e.target.closest('[data-pos] button');
    if (posBtn) {
      touched = true;
      draft.pos = posBtn.dataset.v;
      if (draft.alt === draft.pos) draft.alt = null;
      sheet.querySelector('[data-pos]').innerHTML = posButtons();
      sheet.querySelector('[data-alt]').innerHTML = altButtons();
      sheet.querySelector('[data-pos-name]').textContent = POS_LABEL[draft.pos];
      return;
    }
    const altBtn = e.target.closest('[data-alt] button');
    if (altBtn) {
      touched = true;
      draft.alt = altBtn.dataset.v || null;
      sheet.querySelector('[data-alt]').innerHTML = altButtons();
      return;
    }
    if (e.target.closest('[data-del]')) {
      state.pool = state.pool.filter((p) => p.id !== player.id);
      state.session.guests = state.session.guests.filter((p) => p.id !== player.id);
      prune();
      closeSheet();
      toast(`${player.name} removed`);
      return show(routeFromHash(), false);
    }
    if (e.target.closest('[data-save]')) {
      draft.name = input.value.trim();
      if (!draft.name) {
        input.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-8px)' }, { transform: 'translateX(8px)' }, { transform: 'translateX(0)' }], { duration: 260 });
        return input.focus();
      }
      // Stay unrated unless stats were opened (new guest) or changed (unrated player).
      const keepUnrated = player ? player.unrated && !touched : !rated;
      if (keepUnrated) Object.assign(draft, unratedStats(draft));
      else delete draft.unrated;
      const s = state.session;
      if (player) {
        const list = player.guest ? s.guests : state.pool;
        list[list.findIndex((p) => p.id === player.id)] = draft;
      } else if (guest && !sheet.querySelector('[data-keep]').checked) {
        s.guests.push({ ...draft, guest: true });
        s.picked.push(draft.id);
      } else {
        state.pool.push(draft);
        if (guest) s.picked.push(draft.id);
      }
      save();
      closeSheet();
      toast(player ? 'Saved' : `${draft.name} added`);
      show(routeFromHash(), false);
    }
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') sheet.querySelector('[data-save]').click(); });
}

async function openShareSheet() {
  const r = currentResult();
  const payload = {
    lineups: r.lineups, names: TEAM_NAMES, balance: r.balance, date: dateLabel(), format: state.session.format,
  };
  const text = shareText(payload);
  const sheet = openSheet(`
    <span class="mono">Group chat</span>
    <h2 class="display">Send it</h2>
    <img class="share-preview" alt="Team sheet preview">
    <div class="share-opts">
      <button class="btn" data-native hidden>Share image ↗</button>
      <button class="btn paper" data-copy-img style="box-shadow:inset 0 0 0 2px var(--ink)">Copy image</button>
      <button class="btn orange" data-copy-text>Copy text</button>
      <button class="btn ghost small" data-download><span>Download image</span></button>
    </div>`);

  const blob = await renderShareImage(payload);
  const url = URL.createObjectURL(blob);
  sheet.querySelector('img').src = url;
  const file = new File([blob], 'teams.png', { type: 'image/png' });
  const native = sheet.querySelector('[data-native]');
  if (navigator.canShare && navigator.canShare({ files: [file] })) native.hidden = false;

  sheet.addEventListener('click', async (e) => {
    try {
      if (e.target.closest('[data-native]')) {
        await navigator.share({ files: [file], text });
      } else if (e.target.closest('[data-copy-img]')) {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        toast('Image copied, paste it in the chat');
      } else if (e.target.closest('[data-copy-text]')) {
        await navigator.clipboard.writeText(text);
        toast('Text copied');
      } else if (e.target.closest('[data-download]')) {
        const a = document.createElement('a');
        a.href = url;
        a.download = `teams-${new Date().toISOString().slice(0, 10)}.png`;
        a.click();
      }
    } catch (err) {
      if (err.name !== 'AbortError') toast('Couldn\'t do that here, try download');
    }
  });
}

// ---------- boot ----------
removeDemoPlayers();
prune();
show(routeFromHash(), false);
