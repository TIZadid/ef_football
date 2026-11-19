import {
  balance, evaluate, BalanceError, POSITIONS, isCB, suggestKeepers, keeperScore,
} from './balance.js';
import { renderShareImage, shareText } from './share.js';
import { mergeDocs, FIELDS, RECENT_SIZE } from './sync.js';

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
const TEAM_NAMES = ['Black', 'White'];
const DEFAULT_MATCH = { day: 5, time: '20:00', venue: 'Offside' }; // Fridays, 8pm, Offside
const HISTORY_SIZE = 6;

// Players saved before positions existed used wing / central / both.
const LEGACY_POS = { wing: ['WING', null], central: ['MID', null], both: ['MID', 'WING'] };
// Any stat can be left empty (null), e.g. for a guest nobody knows yet. Empty
// stats count as tonight's average and the algorithm spreads players with
// empty stats across the teams. A player with no position (null) simply has
// no set role.
const DEFAULTS = { att: 2, def: 2, phy: 2, fb: 2, gk: 1 };
const STAT_KEYS = Object.keys(DEFAULTS);
const isEmpty = (p, k) => p[k] === null;
const hasEmpty = (p) => STAT_KEYS.some((k) => isEmpty(p, k));

// Average of each stat among the given players who have it rated.
function groupAverages(players) {
  return Object.fromEntries(STAT_KEYS.map((k) => {
    const known = players.map((p) => p[k]).filter((v) => v !== null);
    return [k, known.length ? known.reduce((a, b) => a + b, 0) / known.length : DEFAULTS[k]];
  }));
}

// Copies with empty stats filled in, for the balancing algorithm.
function resolveAll(players) {
  const avg = groupAverages(players);
  return players.map((p) => ({
    ...p,
    ...Object.fromEntries(STAT_KEYS.map((k) => [k, p[k] ?? avg[k]])),
    empty: STAT_KEYS.filter((k) => isEmpty(p, k)),
  }));
}

function normalise(p) {
  // null = deliberately empty; missing = an old record, use the default.
  const clamp = (v, d = 2) => (v === null || p.unrated ? null : Math.min(3, Math.max(1, Math.round(Number(v) || d))));
  const [legacyPos, legacyAlt] = LEGACY_POS[p.pos] ?? [];
  const pos = POSITIONS.includes(p.pos) ? p.pos : p.pos === null || p.unrated ? null : legacyPos ?? 'MID';
  const alt = POSITIONS.includes(p.alt) && p.alt !== pos ? p.alt : legacyPos ? legacyAlt : null;
  return {
    id: String(p.id || uid()), name: String(p.name).slice(0, 18),
    att: clamp(p.att), def: clamp(p.def), phy: clamp(p.phy), fb: clamp(p.fb), gk: clamp(p.gk, 1),
    pos, alt, ...(p.guest ? { guest: true } : {}), ...(p.t ? { t: p.t } : {}),
  };
}

const state = {
  pool: store.get('pool', []).map(normalise),
  settings: { ...DEFAULT_MATCH, ...store.get('settings', {}) },
  history: store.get('history', []), // finished matchdays' teams, newest first
  recent: store.get('recent', []).map(normalise), // recently used guests, newest first
  deleted: store.get('deleted', {}), // squad deletions, for syncing
  recentCleared: store.get('recentCleared', 0),
  stamps: store.get('stamps', {}), // last-edit times of the shared fields
  sync: 'local', // 'local' | 'syncing' | 'synced' | 'offline'
  session: {
    picked: [], guests: [], together: [], apart: [], keepers: [], keeperMode: 'auto', format: DEFAULT_FORMAT,
    result: null, lastPicked: [], match: { override: null, off: [] }, view: 'pitch', showRecent: false,
    ...store.get('session', {}),
  },
  reveal: false,
  screen: null,
};
state.session.guests = state.session.guests.map(normalise);
if (state.session.result && !state.session.result.starters) state.session.result = null;

// ---------- helpers ----------
function uid() { return Math.random().toString(36).slice(2, 10); }
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pad = (n) => String(n).padStart(2, '0');
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const buzz = (pattern) => navigator.vibrate && navigator.vibrate(pattern);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const posTag = (p) => (p.pos ? `${p.pos}${p.alt ? ` · ${p.alt}` : ''}` : p.guest && hasEmpty(p) ? '?' : 'ANY');
const keeperLikely = (p) => p.pos === 'GK' || p.alt === 'GK' || p.gk === 3;

// An overall rating, 40–99, for the player cards.
function ovr(p) {
  const r = (k) => p[k] ?? 2;
  const outfield = 40 + ((r('att') + r('def') + 0.8 * r('phy') + 0.7 * r('fb') - 3.5) / 7) * 59;
  const keeper = p.pos === 'GK' ? 40 + (((p.gk ?? 1.5) - 1) / 2) * 59 : 0;
  return Math.round(Math.max(outfield, keeper));
}

const everyone = () => [...state.pool, ...state.session.guests];
const byId = (id) => everyone().find((p) => p.id === id);
const playing = () => resolveAll(state.session.picked.map(byId).filter(Boolean));
const isPlaying = (id) => state.session.picked.includes(id);
const byName = (a, b) => a.name.localeCompare(b.name);

function persistLocal() {
  store.set('pool', state.pool);
  store.set('session', state.session);
  store.set('settings', state.settings);
  store.set('history', state.history);
  store.set('recent', state.recent);
  store.set('deleted', state.deleted);
  store.set('recentCleared', state.recentCleared);
  store.set('stamps', state.stamps);
}

function save() {
  stampChanges();
  persistLocal();
  scheduleSync();
}

// ---------- syncing across devices ----------
// Everything in the shared doc (see sync.js) goes to /api/state; tonight's
// picks, guests and teams stay on this device.
const SYNC_LABEL = { local: 'This device only', syncing: 'Syncing…', synced: 'Synced', offline: 'Offline' };
const sharedField = (f) => (f === 'settings' ? state.settings : f === 'history' ? state.history : state.session[f]);
function setSharedField(f, v) {
  if (f === 'settings') state.settings = { ...DEFAULT_MATCH, ...v };
  else if (f === 'history') state.history = v;
  else if (f === 'match') state.session.match = { override: null, off: [], ...v };
  else state.session[f] = v;
}
const localDoc = () => ({
  pool: state.pool, deleted: state.deleted, recent: state.recent, recentCleared: state.recentCleared, stamps: state.stamps,
  ...Object.fromEntries(FIELDS.map((f) => [f, sharedField(f)])),
});

// Compare against the last snapshot to stamp what changed with an edit time.
let snap = null;
const strip = ({ t, ...rest }) => JSON.stringify(rest);
function takeSnap() {
  snap = {
    pool: new Map(state.pool.map((p) => [p.id, strip(p)])),
    fields: Object.fromEntries(FIELDS.map((f) => [f, JSON.stringify(sharedField(f))])),
  };
}
function stampChanges() {
  if (!snap) return takeSnap();
  const now = Date.now();
  const ids = new Set();
  for (const p of state.pool) {
    ids.add(p.id);
    if (snap.pool.get(p.id) !== strip(p)) p.t = now;
  }
  for (const id of snap.pool.keys()) if (!ids.has(id)) state.deleted[id] = now;
  for (const f of FIELDS) if (snap.fields[f] !== JSON.stringify(sharedField(f))) state.stamps[f] = now;
  takeSnap();
}

// Merge a doc from the server into local state; true when anything changed.
function applyDoc(doc) {
  const before = JSON.stringify(localDoc());
  const merged = mergeDocs(localDoc(), doc);
  state.pool = merged.pool.map(normalise);
  state.deleted = merged.deleted;
  state.recent = merged.recent.map(normalise);
  state.recentCleared = merged.recentCleared;
  state.stamps = merged.stamps;
  for (const f of FIELDS) if (merged[f] !== undefined) setSharedField(f, merged[f]);
  takeSnap();
  persistLocal();
  return JSON.stringify(localDoc()) !== before;
}

function setSync(value) {
  state.sync = value;
  document.querySelectorAll('[data-sync]').forEach((el) => { el.dataset.state = value; el.title = SYNC_LABEL[value]; el.querySelector('span').textContent = SYNC_LABEL[value]; });
}

let syncTimer;
function scheduleSync() {
  if (state.sync === 'local') return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(pushState, 700);
}

const refreshScreen = () => { if (!activeSheet && state.screen) show(state.screen, false); };

async function pushState() {
  setSync('syncing');
  try {
    const res = await fetch('/api/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(localDoc()) });
    if (!res.ok) throw new Error(res.status);
    if (applyDoc(await res.json())) refreshScreen();
    setSync('synced');
  } catch {
    setSync('offline');
  }
}

async function pullState() {
  try {
    const res = await fetch('/api/state', { cache: 'no-store' });
    // No storage connected (or running locally): keep everything on this device.
    if (res.status === 503 || res.status === 404) return setSync('local');
    if (!res.ok) throw new Error(res.status);
    const remote = await res.json();
    const changed = applyDoc(remote);
    setSync('synced');
    if (changed) refreshScreen();
    // Send up anything only this device had.
    if (JSON.stringify(localDoc()) !== JSON.stringify(mergeDocs(remote, {}))) pushState();
  } catch {
    setSync('offline');
  }
}
window.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state.sync !== 'local') pullState(); });
window.addEventListener('online', () => { if (state.sync === 'offline') pullState(); });

// Remember a guest in the recent list, newest first.
function rememberGuest(g) {
  const { t, ...rest } = g;
  state.recent = [{ ...rest, guest: true, t: Date.now() }, ...state.recent.filter((x) => x.id !== g.id)].slice(0, RECENT_SIZE);
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

// ---------- matchday ----------
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseIso = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const fmtDate = (d) => d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' }).toUpperCase();
const fmtTime = (t) => {
  const [hh, mm] = t.split(':').map(Number);
  return `${((hh + 11) % 12) + 1}${mm ? `:${pad(mm)}` : ''} ${hh < 12 ? 'AM' : 'PM'}`;
};
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// The next regular game day; today's game counts until two hours after kick-off.
function regularDate(from = new Date()) {
  const { day, time } = state.settings;
  const [hh, mm] = time.split(':').map(Number);
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  let add = (day - d.getDay() + 7) % 7;
  if (add === 0 && from.getHours() * 60 + from.getMinutes() > hh * 60 + mm + 120) add = 7;
  d.setDate(d.getDate() + add);
  return d;
}

function matchInfo() {
  const m = state.session.match;
  const today = iso(new Date());
  if (m.override && m.override.date >= today) {
    return { date: parseIso(m.override.date), time: m.override.time, venue: m.override.venue, regular: false, off: false };
  }
  const date = regularDate();
  const off = m.off.includes(iso(date));
  const next = new Date(date);
  next.setDate(next.getDate() + 7);
  return { date, time: state.settings.time, venue: state.settings.venue, regular: true, off, next };
}
const matchLabel = (mi = matchInfo()) => `${fmtDate(mi.date)} · ${fmtTime(mi.time)} · ${mi.venue.toUpperCase()}`;

// ---------- shared bits ----------
const bars = (p) => `<div class="bars">${RATINGS.map(([k, short]) => `
  <div class="${isEmpty(p, k) ? 'unk' : ''}"><span>${short}</span><p>${isEmpty(p, k) ? '<i></i><b>?</b><i></i>' : [1, 2, 3].map((n) => `<i class="${p[k] >= n ? 'f' : ''}"></i>`).join('')}</p></div>`).join('')}</div>`;

function appbar(active) {
  const flow = ['pick', 'rules', 'result'].includes(active);
  return `
    <header class="appbar">
      <button class="brand" data-go="home" aria-label="Home">Game<span>On</span><i>.</i></button>
      <span class="sync" data-sync data-state="${state.sync}" title="${SYNC_LABEL[state.sync]}"><i></i><span>${SYNC_LABEL[state.sync]}</span></span>
      <nav>
        <button class="${active === 'home' ? 'on' : ''}" data-go="home">Home</button>
        <button class="${active === 'squad' ? 'on' : ''}" data-go="squad">Squad</button>
        <button class="${flow ? 'on' : ''}" data-go="${state.session.result && !flow ? 'result' : 'pick'}">Match</button>
      </nav>
    </header>`;
}

function stepper(active) {
  const s = state.session;
  const n = s.picked.length;
  const rulesCount = s.together.filter((r) => r.every(isPlaying)).length + s.apart.filter((r) => r.every(isPlaying)).length;
  const steps = [
    ['pick', "Who's in", `${n} in`, false],
    ['rules', 'Rules', rulesCount ? plural(rulesCount, 'rule') : 'optional', n < 2],
    ['result', 'Teams', s.result ? 'ready' : '—', !s.result],
  ];
  return `
    <nav class="stepper" aria-label="Steps">
      ${steps.map(([route, label, sub, disabled], i) => `
        <button data-go="${route}" class="${route === active ? 'on' : ''}" ${disabled ? 'disabled' : ''}>
          <b>${i + 1}</b><span>${label}<small data-step-sub="${route}">${sub}</small></span>
        </button>`).join('')}
    </nav>`;
}

// ---------- routing ----------
const ROUTES = { home, squad, pick, rules, result };
const ORDER = { home: 0, squad: 1, pick: 2, rules: 3, result: 4 };

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
  const from = state.screen;
  state.screen = name;
  const paint = (dir) => {
    const el = ROUTES[name]();
    if (dir) el.classList.add(`enter-${dir}`);
    app.replaceChildren(el);
    window.scrollTo(0, 0);
    if (name === 'result' && state.reveal) { state.reveal = false; requestAnimationFrame(revealTeams); }
  };
  if (!animate || reduced() || !from) return paint();
  if (state.reveal) {
    // The split gets the big lime wipe; everything else slides.
    const wipe = h('<div class="wipe"></div>');
    document.body.append(wipe);
    setTimeout(() => paint(), 290);
    wipe.addEventListener('animationend', () => wipe.remove());
    return;
  }
  const dir = (ORDER[name] ?? 0) >= (ORDER[from] ?? 0) ? 'fwd' : 'back';
  const old = app.firstElementChild;
  if (!old || from === name) return paint();
  old.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateX(${dir === 'fwd' ? -24 : 24}px)` }],
    { duration: 140, easing: 'ease-in' }).onfinish = () => paint(dir);
}

window.addEventListener('hashchange', () => { closeSheet(); show(routeFromHash()); });
document.addEventListener('click', (e) => {
  const target = e.target.closest('[data-go]');
  if (!target || target.disabled) return;
  // Every new game starts as 5-a-side.
  if (target.hasAttribute('data-new-game')) { state.session.format = DEFAULT_FORMAT; save(); }
  go(target.dataset.go);
});

// ---------- home ----------
function home() {
  const s = state.session;
  const mi = matchInfo();
  const ready = s.result && s.result.match === iso(mi.date);
  const words = ['Fair teams', 'Black vs White', 'Friday nights', 'No more arguments', 'Game on'];
  const el = h(`
    <section class="screen home">
      ${appbar('home')}
      <div class="hero" style="--d:1">
        <svg class="wiggle" viewBox="0 0 280 160" aria-hidden="true"><path d="M8 140 C 50 140, 40 30, 92 44 S 130 140, 172 104 S 206 12, 272 24" fill="none" stroke="var(--accent)" stroke-width="16" stroke-linecap="round"/></svg>
        <div class="badge-logo"><h1 class="headline"><span>Game</span><span>On</span></h1></div>
        <span class="sticker">Fair teams<br>every week</span>
      </div>
      <div class="match-card ${mi.off ? 'off' : ''}" style="--d:2">
        <span class="mono label">${mi.off ? 'This week' : mi.regular ? 'Next match' : 'Special match'}</span>
        ${mi.off ? `
          <p class="match-when strike">${fmtDate(mi.date)}</p>
          <p class="match-off">No game this week</p>
          <p class="mono muted">Next: ${fmtDate(mi.next)} · ${fmtTime(mi.time)} · ${esc(mi.venue)}</p>
          <div class="match-actions">
            <button class="chip" data-match-on>Game's back on</button>
            <button class="chip" data-match-edit>Play another day</button>
          </div>` : `
          <p class="match-when">${fmtDate(mi.date)}</p>
          <p class="match-where"><span>${fmtTime(mi.time)}</span> · <span>${esc(mi.venue)}</span></p>
          <div class="match-actions">
            <button class="chip" data-match-edit>Change</button>
            ${mi.regular ? '<button class="chip" data-match-off>Game off this week</button>' : '<button class="chip" data-match-reset>Back to regular</button>'}
          </div>`}
      </div>
      <div class="home-actions" style="--d:3">
        ${ready ? `
          <button class="btn" data-go="result">See teams <span class="arrow">→</span></button>
          <button class="btn ghost" data-go="pick"><span>Redo</span></button>` : `
          <button class="btn" data-go="pick" data-new-game>Make teams <span class="arrow">→</span></button>
          <button class="btn ghost" data-go="squad"><span>Squad</span></button>`}
      </div>
      <div class="tags" style="--d:4">
        <span class="tag">Squad <b>${pad(state.pool.length)}</b></span>
        <span class="tag">In <b>${pad(s.picked.length)}</b></span>
        <span class="tag">${s.format}-a-side</span>
      </div>
      <div class="ticker" style="--d:5" aria-hidden="true">
        <div>${[...words, ...words].map((w) => `<span>${w}</span>`).join('')}</div>
      </div>
    </section>`);

  el.addEventListener('click', (e) => {
    const m = state.session.match;
    if (e.target.closest('[data-match-off]')) { m.off.push(iso(mi.date)); save(); toast('Game off this week'); return show('home', false); }
    if (e.target.closest('[data-match-on]')) { m.off = m.off.filter((d) => d !== iso(mi.date)); save(); toast('Game on!'); return show('home', false); }
    if (e.target.closest('[data-match-reset]')) { m.override = null; save(); return show('home', false); }
    if (e.target.closest('[data-match-edit]')) openMatchSheet(mi);
  });
  return el;
}

function openMatchSheet(mi) {
  const date = mi.off ? mi.next : mi.date;
  const sheet = openSheet(`
    <span class="mono">Matchday</span>
    <h2 class="display">When & where</h2>
    <label class="field"><span class="mono">Date</span><input type="date" data-date value="${iso(date)}" min="${iso(new Date())}"></label>
    <label class="field"><span class="mono">Kick-off</span><input type="time" data-time value="${mi.time}"></label>
    <label class="field"><span class="mono">Venue</span><input type="text" data-venue value="${esc(mi.venue)}" maxlength="24"></label>
    <p class="sheet-note">Regular game: every ${DAY_NAMES[state.settings.day]} at ${fmtTime(state.settings.time)}, ${esc(state.settings.venue)}.</p>
    <label class="check"><input type="checkbox" data-make-regular> Make this the new regular game</label>
    <div class="actions"><button class="btn" data-save>Save</button></div>`);
  sheet.querySelector('[data-save]').addEventListener('click', () => {
    const d = sheet.querySelector('[data-date]').value;
    const time = sheet.querySelector('[data-time]').value || state.settings.time;
    const venue = sheet.querySelector('[data-venue]').value.trim() || state.settings.venue;
    if (!d) return;
    const m = state.session.match;
    if (sheet.querySelector('[data-make-regular]').checked) {
      state.settings = { day: parseIso(d).getDay(), time, venue };
      m.override = null;
    } else if (iso(regularDate()) === d && time === state.settings.time && venue === state.settings.venue) {
      m.override = null;
    } else {
      m.override = { date: d, time, venue };
    }
    m.off = m.off.filter((x) => x !== d);
    save();
    closeSheet();
    toast('Matchday saved');
    show('home', false);
  });
}

// ---------- squad ----------
function squad() {
  let sort = 'name';
  let query = '';
  const el = h(`
    <section class="screen">
      ${appbar('squad')}
      <h1 class="display title" style="--d:1">The squad</h1>
      <p class="sub" style="--d:2">Your regulars. Tap a card to edit ratings and position.
        ${state.sync === 'local' ? 'Saved on this device only.' : 'Synced across all your devices.'}</p>
      <div style="--d:3">
        ${state.pool.length ? `
          <div class="toolbar">
            <input class="search" type="search" placeholder="Search" data-search aria-label="Search players">
            <button class="chip on" data-sort="name">A–Z</button>
            <button class="chip" data-sort="ovr">Best</button>
          </div>` : `
          <div class="empty">
            <p class="display">Empty pitch</p>
            <p class="muted">Add your regulars to get started.</p>
            <button class="btn small paper" data-add>Add first player</button>
          </div>`}
        <div class="grid" data-grid></div>
        <div class="squad-actions">
          <button class="chip" data-export>Export squad</button>
          <label class="chip">Import squad<input type="file" accept="application/json" hidden data-import></label>
        </div>
      </div>
      <div class="dock"><div class="dock-inner">
        <button class="btn" data-go="pick" data-new-game>Make teams <span class="arrow">→</span></button>
      </div></div>
    </section>`);

  const grid = el.querySelector('[data-grid]');
  const paint = () => {
    const list = state.pool
      .filter((p) => p.name.toLowerCase().includes(query))
      .sort(sort === 'ovr' ? (a, b) => ovr(b) - ovr(a) || byName(a, b) : byName);
    grid.innerHTML = list.map((p, i) => ticket(p, i, false)).join('') + '<button class="add-tile" data-add><b>+</b>Player</button>';
  };
  el.addEventListener('click', (e) => {
    const t = e.target.closest('.ticket');
    if (t) return openPlayerSheet({ player: byId(t.dataset.id) });
    if (e.target.closest('[data-add]')) return openPlayerSheet({});
    const so = e.target.closest('[data-sort]');
    if (so) {
      sort = so.dataset.sort;
      el.querySelectorAll('[data-sort]').forEach((b) => b.classList.toggle('on', b === so));
      return paint();
    }
    if (e.target.closest('[data-export]')) return exportSquad();
  });
  el.querySelector('[data-search]')?.addEventListener('input', (e) => { query = e.target.value.trim().toLowerCase(); paint(); });
  el.querySelector('[data-import]').addEventListener('change', importSquad);
  paint();
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
function ticket(p, i, selectable = true, recent = false) {
  const on = selectable && isPlaying(p.id);
  return `
    <button class="ticket ${on ? 'on' : ''} ${p.guest ? 'guest' : ''} ${recent ? 'recent' : ''}" data-id="${p.id}" style="--i:${Math.min(i, 20)}" ${selectable ? `aria-pressed="${on}"` : ''}>
      ${selectable ? '<span class="stamp">IN</span>' : ''}
      <span class="top">
        <span class="ovr">${ovr(p)}${hasEmpty(p) ? '<small>~</small>' : ''}</span>
        <span class="name">${esc(p.name)}</span>
        ${keeperLikely(p) ? '<span class="glove" title="Likely keeper">🧤</span>' : ''}
      </span>
      ${bars(p)}
      <span class="row">
        <span class="pos">${posTag(p)}</span>
        ${recent ? '<span class="pos guest-tag">+ BRING BACK</span>'
          : p.guest ? '<span class="pos guest-tag" data-edit-guest title="Edit guest">GUEST ✎</span>' : '<span class="barcode"></span>'}
      </span>
    </button>`;
}

// ---------- step 1: pick ----------
function pick() {
  const s = state.session;
  const list = [...state.pool.slice().sort(byName), ...s.guests];
  const canRepeat = s.lastPicked.length && s.lastPicked.some((id) => byId(id)) && s.lastPicked.join() !== s.picked.join();
  const el = h(`
    <section class="screen">
      ${appbar('pick')}
      ${stepper('pick')}
      <div class="title-row" style="--d:1">
        <h1 class="display title">Who's in?</h1>
        <span class="mono muted">${matchLabel()}</span>
      </div>
      <div style="--d:2">
        <div class="format">
          <span class="mono muted">Players a side</span>
          <div class="format-opts">
            ${FORMATS.map((f) => `<button class="${s.format === f ? 'on' : ''}" data-format="${f}">${f}</button>`).join('')}
          </div>
        </div>
        <div class="toolbar">
          ${list.length > 10 ? '<input class="search" type="search" placeholder="Search" data-search aria-label="Search players">' : ''}
          ${canRepeat ? '<button class="chip" data-repeat>↺ Same as last game</button>' : ''}
          <button class="chip" data-all>All in</button>
          <button class="chip" data-none>Clear</button>
        </div>
      </div>
      <div class="grid" style="--d:3">
        ${list.map((p, i) => ticket(p, i)).join('')}
        <button class="add-tile" data-guest><b>+</b>Guest</button>
      </div>
      ${state.pool.length ? '' : `<div class="empty" style="--d:4;margin-top:14px"><p class="muted">No squad yet. Add guests, or set up your regulars.</p><button class="btn small paper" data-go="squad">Set up squad</button></div>`}
      ${recentGuestsBlock()}
      <div class="dock"><div class="dock-inner">
        <div class="tally"><span class="count" data-count>${pad(s.picked.length)}</span><span class="mono muted" data-split-info></span></div>
        <button class="btn ghost small" data-go="rules" data-rules-btn><span>Rules</span></button>
        <button class="btn" data-split>Split ⚡</button>
      </div></div>
    </section>`);

  const count = el.querySelector('[data-count]');
  const info = el.querySelector('[data-split-info]');
  const splitBtn = el.querySelector('[data-split]');
  const rulesBtn = el.querySelector('[data-rules-btn]');
  const sync = (animate = true) => {
    const n = s.picked.length;
    const subs = Math.max(0, n - 2 * s.format);
    count.textContent = pad(n);
    if (animate) bump(count);
    info.textContent = n < 2 ? 'pick 2+' : subs ? `${s.format}v${s.format} +${subs} sub${subs > 1 ? 's' : ''}` : `${Math.floor(n / 2)}v${Math.ceil(n / 2)}`;
    splitBtn.disabled = n < 2;
    rulesBtn.disabled = n < 2;
    const sub = el.querySelector('[data-step-sub="pick"]');
    if (sub) sub.textContent = `${n} in`;
    el.querySelector('.stepper [data-go="rules"]').disabled = n < 2;
    save();
  };
  const setPicked = (ids) => {
    s.picked = ids;
    el.querySelectorAll('.ticket').forEach((t) => {
      t.classList.toggle('on', isPlaying(t.dataset.id));
      t.setAttribute('aria-pressed', isPlaying(t.dataset.id));
    });
    sync();
  };

  el.addEventListener('click', (e) => {
    const f = e.target.closest('[data-format]');
    if (f) {
      s.format = Number(f.dataset.format);
      el.querySelectorAll('[data-format]').forEach((b) => b.classList.toggle('on', b === f));
      buzz(8);
      return sync(false);
    }
    const editGuest = e.target.closest('[data-edit-guest]');
    if (editGuest) return openPlayerSheet({ player: byId(editGuest.closest('.ticket').dataset.id) });
    if (e.target.closest('[data-toggle-recent]')) {
      s.showRecent = !s.showRecent;
      save();
      const n = el.querySelectorAll('.ticket.recent').length;
      el.querySelector('[data-recent-body]').hidden = !s.showRecent;
      const btn = e.target.closest('[data-toggle-recent]');
      btn.classList.toggle('on', s.showRecent);
      btn.textContent = s.showRecent ? 'Hide' : `Show ${n}`;
      return;
    }
    if (e.target.closest('[data-clear-recent]')) {
      state.recent = [];
      state.recentCleared = Date.now();
      save();
      el.querySelector('.recent-block')?.remove();
      return toast('Recent guests cleared');
    }
    const back = e.target.closest('.ticket.recent');
    if (back) {
      const g = state.recent.find((x) => x.id === back.dataset.id);
      const { t, ...guest } = g;
      s.guests.push({ ...guest, guest: true });
      s.picked.push(g.id);
      rememberGuest(g);
      save();
      toast(`${g.name} is back`);
      const y = window.scrollY;
      show('pick', false);
      window.scrollTo(0, y);
      return;
    }
    const t = e.target.closest('.ticket');
    if (t) {
      const id = t.dataset.id;
      buzz(8);
      return setPicked(isPlaying(id) ? s.picked.filter((x) => x !== id) : [...s.picked, id]);
    }
    if (e.target.closest('[data-repeat]')) {
      e.target.closest('[data-repeat]').remove();
      return setPicked(s.lastPicked.filter((id) => byId(id)));
    }
    if (e.target.closest('[data-all]')) return setPicked(everyone().map((p) => p.id));
    if (e.target.closest('[data-none]')) return setPicked([]);
    if (e.target.closest('[data-guest]')) return openPlayerSheet({ guest: true });
    if (e.target.closest('[data-split]')) startSplit();
  });
  el.querySelector('[data-search]')?.addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    el.querySelectorAll('.ticket').forEach((t) => { t.hidden = !byId(t.dataset.id).name.toLowerCase().includes(q); });
  });
  sync(false);
  return el;
}

function recentGuestsBlock() {
  const s = state.session;
  const list = state.recent.filter((g) => !s.guests.some((x) => x.id === g.id));
  if (!list.length) return '';
  return `
    <section class="recent-block" style="--d:5">
      <div class="recent-head">
        <div><h2 class="display">Recent guests</h2><span class="mono muted">Not in the squad · tap to bring back</span></div>
        <button class="chip ${s.showRecent ? 'on' : ''}" data-toggle-recent>${s.showRecent ? 'Hide' : `Show ${list.length}`}</button>
      </div>
      <div data-recent-body ${s.showRecent ? '' : 'hidden'}>
        <div class="grid">${list.map((p, i) => ticket(p, i, false, true)).join('')}</div>
        <button class="chip clear-recent" data-clear-recent>Clear list</button>
      </div>
    </section>`;
}

function startSplit() {
  if (runSplit()) { state.reveal = true; go('result'); }
}

// ---------- step 2: rules ----------
function rules() {
  const s = state.session;
  const players = playing().sort(byName);
  const active = (pair) => pair.every(isPlaying);
  const name = (id) => esc(byId(id).name);

  const el = h(`
    <section class="screen">
      ${appbar('rules')}
      ${stepper('rules')}
      <div class="title-row" style="--d:1">
        <h1 class="display title">House rules</h1>
        <span class="mono muted">All optional · skip to Split</span>
      </div>
      <section class="card" data-keepers style="--d:2"></section>
      <section class="card" style="--d:3">
        <div class="card-head">
          <div><h2>Same team</h2><p class="hint">Always on the same side, e.g. two mates who want to play together.</p></div>
          <button class="btn small paper" data-add-rule="together">+ Pair</button>
        </div>
        <div class="rules" data-list="together"></div>
      </section>
      <section class="card" style="--d:4">
        <div class="card-head">
          <div><h2>Opposite teams</h2><p class="hint">Never on the same side, e.g. your two best players.</p></div>
          <button class="btn small paper" data-add-rule="apart">+ Pair</button>
        </div>
        <div class="rules" data-list="apart"></div>
      </section>
      <div class="dock"><div class="dock-inner">
        <div class="tally"><span class="count">${pad(players.length)}</span><span class="mono muted">${s.format}-a-side</span></div>
        <button class="btn" data-split>Split ⚡</button>
      </div></div>
    </section>`);

  const $ = (sel) => el.querySelector(sel);
  let showAllKeepers = false;
  const refresh = () => {
    // Keepers
    const fixed = s.keeperMode !== 'none';
    const pinned = s.keepers.filter(isPlaying);
    const suggested = suggestKeepers(players);
    const ranked = players.slice().sort((a, b) => keeperScore(b) - keeperScore(a) || byName(a, b));
    // Likely keepers first; everyone else only on request.
    const likely = ranked.filter((p) => suggested.includes(p) || pinned.includes(p.id) || p.pos === 'GK' || p.alt === 'GK' || p.gk >= 3);
    const shown = showAllKeepers ? ranked : likely;
    $('[data-keepers]').innerHTML = `
      <div class="card-head"><div><h2>In goal</h2><p class="hint">Does someone stay in goal the whole game?</p></div></div>
      <div class="seg">
        <button data-k="auto" class="${fixed ? 'on' : ''}">Yes, keepers</button>
        <button data-k="none" class="${fixed ? '' : 'on'}">No, we rotate</button>
      </div>
      ${fixed ? `
        <p class="hint">${pinned.length
          ? `<b>${pinned.map(name).join(' & ')}</b> will start in goal${pinned.length === 2 ? ', on opposite teams' : ''}. Tap again to unpick.`
          : `Not picked yet, so each team's best keeper goes in. Suggested: <b>${suggested.map((p) => esc(p.name)).join(' & ')}</b>.`}</p>
        <div class="people">
          ${shown.map((p) => {
            const tags = [suggested.includes(p) ? 'Suggested' : '', p.pos === 'GK' ? 'Prefers GK' : p.alt === 'GK' ? 'Can keep' : ''].filter(Boolean);
            return `<button class="person ${pinned.includes(p.id) ? 'gk' : ''} ${suggested.includes(p) ? 'sugg' : ''}" data-keeper="${p.id}">
              <span>${esc(p.name)}</span><small>GK ${p.empty.includes('gk') ? '?' : p.gk}${tags.length ? ` · ${tags.join(' · ')}` : ''}</small>
            </button>`;
          }).join('')}
          ${!showAllKeepers && ranked.length > shown.length ? '<button class="person more" data-k-all><span>+ Someone else</span><small>show everyone</small></button>' : ''}
        </div>
        ${pinned.length ? '<button class="chip" data-k-clear>Let the app choose</button>' : `<button class="chip" data-k-suggest>Use suggested</button>`}`
        : '<p class="hint">Nobody stays in goal, so GK ratings are ignored.</p>'}`;

    // Pair rules, written out as sentences.
    for (const kind of ['together', 'apart']) {
      const list = s[kind].filter(active);
      const hidden = s[kind].length - list.length;
      $(`[data-list="${kind}"]`).innerHTML = (list.length ? list.map(([a, b]) => `
        <div class="rule ${kind}">
          <span class="label"><b>${name(a)}</b> ${kind === 'together' ? '&' : 'vs'} <b>${name(b)}</b></span>
          <span class="kind">${kind === 'together' ? 'same team' : 'opposite teams'}</span>
          <button data-del="${kind}:${a},${b}" aria-label="Remove rule">✕</button>
        </div>`).join('') : '<p class="none">No pairs yet.</p>')
        + (hidden ? `<p class="hint">+${plural(hidden, 'saved rule')} for players not in tonight.</p>` : '');
    }
  };

  const samePair = (a, b) => ([x, y]) => (x === a && y === b) || (x === b && y === a);
  el.addEventListener('click', (e) => {
    const k = e.target.closest('[data-k]');
    if (k) { s.keeperMode = k.dataset.k; save(); return refresh(); }
    if (e.target.closest('[data-k-suggest]')) { s.keepers = suggestKeepers(players).map((p) => p.id); s.keeperMode = 'auto'; save(); buzz(10); return refresh(); }
    if (e.target.closest('[data-k-clear]')) { s.keepers = []; save(); return refresh(); }
    if (e.target.closest('[data-k-all]')) { showAllKeepers = true; return refresh(); }
    const kp = e.target.closest('[data-keeper]');
    if (kp) {
      const id = kp.dataset.keeper;
      s.keepers = s.keepers.includes(id) ? s.keepers.filter((x) => x !== id) : [...s.keepers.filter(isPlaying), id].slice(-2);
      buzz(8);
      save();
      return refresh();
    }
    const add = e.target.closest('[data-add-rule]');
    if (add) return openPairSheet(add.dataset.addRule, players, refresh);
    const del = e.target.closest('[data-del]');
    if (del) {
      const [kind, list] = del.dataset.del.split(':');
      const [a, b] = list.split(',');
      s[kind] = s[kind].filter((r) => !samePair(a, b)(r));
      save();
      return refresh();
    }
    if (e.target.closest('[data-split]')) startSplit();
  });
  refresh();
  return el;
}

function openPairSheet(kind, players, done) {
  const s = state.session;
  let sel = [];
  const words = kind === 'together' ? 'the same team' : 'opposite teams';
  const sheet = openSheet(`
    <span class="mono">New rule</span>
    <h2 class="display">${kind === 'together' ? 'Same team' : 'Opposite teams'}</h2>
    <p class="sheet-note">Pick two players who should always be on <b>${words}</b>.</p>
    <div class="pair-pick">${players.map((p) => `<button class="pair-chip" data-id="${p.id}">${esc(p.name)}</button>`).join('')}</div>
    <p class="pair-preview" data-preview></p>
    <div class="actions"><button class="btn" data-add disabled>Add rule</button></div>`);
  const preview = sheet.querySelector('[data-preview]');
  const addBtn = sheet.querySelector('[data-add]');
  const paint = () => {
    sheet.querySelectorAll('.pair-chip').forEach((c) => c.classList.toggle('on', sel.includes(c.dataset.id)));
    const names = sel.map((id) => `<b>${esc(byId(id).name)}</b>`);
    preview.innerHTML = sel.length === 2
      ? `${names[0]} and ${names[1]} will always be on ${words}.`
      : sel.length === 1 ? `${names[0]} and… pick one more.` : 'Pick 2 players.';
    addBtn.disabled = sel.length !== 2;
  };
  sheet.addEventListener('click', (e) => {
    const c = e.target.closest('.pair-chip');
    if (c) {
      const id = c.dataset.id;
      sel = sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id].slice(-2);
      buzz(8);
      return paint();
    }
    if (e.target.closest('[data-add]') && sel.length === 2) {
      const [a, b] = sel;
      const same = ([x, y]) => (x === a && y === b) || (x === b && y === a);
      const other = kind === 'together' ? 'apart' : 'together';
      s[other] = s[other].filter((r) => !same(r));
      if (!s[kind].some(same)) s[kind].push([a, b]);
      save();
      closeSheet();
      toast('Rule added');
      done();
    }
  });
  paint();
}

function runSplit(exclude = null) {
  const s = state.session;
  const key = iso(matchInfo().date);
  // A new matchday: the previous one's teams join the history.
  if (s.result && s.result.match && s.result.match !== key) {
    state.history = [s.result.teams, ...state.history].slice(0, HISTORY_SIZE);
  }
  try {
    const r = balance(playing(), { ...balanceOpts(), exclude, history: state.history });
    s.result = {
      teams: r.teams.map((t) => t.map((p) => p.id)),
      starters: r.lineups.map((u) => u.starters.map((p) => p.id)),
      goal: r.lineups.map((u) => u.keeper?.id ?? null),
      signature: r.signature,
      options: r.options,
      edited: false,
      match: key,
    };
    s.lastPicked = s.picked.slice();
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
  const all = new Map(resolveAll(r.teams.flat().map(byId)).map((p) => [p.id, p]));
  const teams = r.teams.map((ids) => ids.map((id) => all.get(id)));
  const ev = evaluate(teams[0], teams[1], { ...balanceOpts(), starters: r.starters, goal: r.goal });
  const format = state.session.format;
  ev.lineups.forEach((u, t) => {
    const want = Math.min(format, teams[t].length);
    if (u.starters.length !== want) ev.warnings.push(`Team ${TEAM_NAMES[t]} has ${u.starters.length} starting (${want} needed).`);
  });
  return { teams, options: r.options, edited: r.edited, ...ev };
}

// ---------- step 3: result ----------
const verdict = (balance) => (balance >= 96 ? 'Dead even!' : balance >= 90 ? 'Very fair' : balance >= 80 ? 'Fair' : 'Lopsided');

function result() {
  const s = state.session;
  const el = h(`
    <section class="screen">
      ${appbar('result')}
      ${stepper('result')}
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
    const keepers = s.keeperMode !== 'none';
    const hasSubs = r.lineups.some((u) => u.subs.length);
    const units = [
      ['Attack', a.atk, b.atk],
      ['Back line', a.back, b.back],
      ['Engine', a.eng, b.eng],
      ...(keepers ? [['Keeper', a.gk, b.gk]] : []),
      ...(hasSubs ? [['Squad depth', a.rotation, b.rotation]] : []),
    ];
    body.innerHTML = `
      <div class="odds">
        <div class="odds-head">
          <span class="mono muted">${matchLabel()} · ${s.format}-a-side</span>
          <span class="verdict ${r.balance >= 90 ? 'good' : ''}">${verdict(r.balance)}</span>
        </div>
        <div class="balance-row">
          <b class="pct">${r.balance}<small>%</small></b>
          <span class="mono muted">squad<br>balance</span>
        </div>
        <div class="odds-bar"><i style="--a:${r.balance}%"></i></div>
      </div>
      <div class="seg view-toggle">
        <button data-view="pitch" class="${s.view === 'pitch' ? 'on' : ''}">Pitch</button>
        <button data-view="list" class="${s.view === 'list' ? 'on' : ''}">List</button>
      </div>
      ${s.view === 'pitch' ? pitchView(r) : `<div class="versus"><span class="vs">VS</span>${r.lineups.map((u, t) => teamPanel(u, t)).join('')}</div>`}
      ${r.warnings.map((w) => `<div class="warn">⚠ ${esc(w)}</div>`).join('')}
      <p class="edit-hint"><span>✎</span> Tap any player to swap, move, bench or put them in goal.</p>
      <section class="card units">
        <div class="units-head"><span class="a">Black</span><h3>Head to head</h3><span class="b">White</span></div>
        ${units.map(([k, va, vb]) => {
          const max = Math.max(va, vb, 0.01);
          return `<div class="cmp">
            <span class="v">${va.toFixed(1)}</span>
            <span class="track"><i style="--w:${(va / max) * 100}%"></i></span>
            <span class="k">${k}</span>
            <span class="track b"><i style="--w:${(vb / max) * 100}%"></i></span>
            <span class="v">${vb.toFixed(1)}</span>
          </div>`;
        }).join('')}
      </section>`;
  };

  el.addEventListener('click', (e) => {
    const v = e.target.closest('[data-view]');
    if (v) { s.view = v.dataset.view; save(); paint(); revealTeams(); return; }
    const pl = e.target.closest('.pl');
    if (pl) return openEditSheet(pl.dataset.id, body, paint);
    const regen = e.target.closest('[data-shuffle]');
    if (regen) {
      if (runSplit(s.result.signature)) {
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

// Players placed in formation. White defends the top goal, Black the bottom.
function pitchView(r) {
  const half = (t) => {
    const u = r.lineups[t];
    const roles = r.stats[t].roles;
    const outfield = u.starters.filter((p) => p !== u.keeper);
    const of = (role) => outfield.filter((p) => roles.get(p)?.role === role);
    const wings = of('WING');
    const mid = [...wings.filter((_, i) => i % 2 === 0), ...of('MID'), ...of('ANY'), ...wings.filter((_, i) => i % 2 === 1)];
    const lines = [u.keeper ? [u.keeper] : [], of('CB'), mid, of('ST')].filter((l) => l.length);
    const ordered = t === 1 ? lines : lines.slice().reverse();
    return `<div class="half ${t ? 'top' : 'bottom'}">${ordered.map((line) => `
      <div class="line">${line.map((p) => chipHtml(p, u.keeper, roles.get(p)?.role, t)).join('')}</div>`).join('')}</div>`;
  };
  const bench = (t) => (r.lineups[t].subs.length ? `
    <div class="bench-row ${t ? 'b' : 'a'}"><span class="mono">${TEAM_NAMES[t]} subs</span>
      ${r.lineups[t].subs.map((p) => `<button class="pl bench-chip" data-id="${p.id}">${esc(p.name)}</button>`).join('')}
    </div>` : '');
  return `
    ${bench(1)}
    <div class="pitch">
      <span class="team-tag top">White</span>
      ${half(1)}
      <div class="halfway"></div>
      ${half(0)}
      <span class="team-tag bottom">Black</span>
    </div>
    ${bench(0)}`;
}

function chipHtml(p, keeper, role, t) {
  const isGk = p === keeper;
  return `<button class="pl pchip ${t ? 'b' : 'a'} ${isGk ? 'gk' : ''}" data-id="${p.id}">
    <span class="dot">${isGk ? '🧤' : esc(p.name.slice(0, 1).toUpperCase())}</span>
    <span class="nm">${esc(p.name)}</span>
    <span class="role">${isGk ? `GK${p.empty?.includes('gk') ? '?' : p.gk}` : role === 'ANY' ? 'ANY' : role}</span>
  </button>`;
}

function slotHtml(p, keeper) {
  const isGk = p === keeper;
  return `
    <li><button class="pl slot ${isGk ? 'keeper' : ''}" data-id="${p.id}">
      <span class="nm">${isGk ? '🧤 ' : ''}${esc(p.name)}</span>
      <span class="badges">
        ${!isGk && isCB(p) ? '<span class="b cb">CB</span>' : ''}
        <span class="b">${isGk ? `GK${p.empty?.includes('gk') ? '?' : p.gk}` : p.pos ?? 'ANY'}</span>
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
  const chip = (x) => `<button class="swap-chip" data-swap="${x}">${name(x)}<small>${r.starters[r.teams[0].includes(x) ? 0 : 1].includes(x) ? (current.lineups.some((u) => u.keeper?.id === x) ? 'GK' : 'START') : 'SUB'}</small></button>`;
  const teammates = r.teams[t].filter((x) => x !== id && r.starters[t].includes(x) !== starting);
  const canStart = !starting && r.starters[t].length < Math.min(state.session.format, r.teams[t].length);

  const sheet = openSheet(`
    <span class="mono">Team ${TEAM_NAMES[t]} · ${status}</span>
    <h2 class="display">${esc(p.name)}</h2>
    <div class="quick">
      ${useKeepers && starting && !isGk ? '<button class="btn paper small" data-act="goal">🧤 Put in goal</button>' : ''}
      ${starting ? '<button class="btn paper small" data-act="bench">Bench</button>' : ''}
      ${canStart ? '<button class="btn paper small" data-act="start">Start</button>' : ''}
      <button class="btn small team-btn ${o ? 'white' : 'black'}" data-act="move">Move to ${TEAM_NAMES[o]} →</button>
    </div>
    <p class="mono sheet-label">Swap with ${TEAM_NAMES[o]}</p>
    <div class="swap-grid ${o ? 'b' : 'a'}">${r.teams[o].map(chip).join('')}</div>
    ${teammates.length ? `<p class="mono sheet-label">${starting ? 'Swap with a sub' : 'Swap with a starter'}</p>
    <div class="swap-grid same">${teammates.map(chip).join('')}</div>` : ''}`);

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

// Players fly in from a shuffled pile in the middle.
function revealTeams() {
  if (reduced()) return;
  const els = [...app.querySelectorAll('.pl')];
  const area = app.querySelector('.pitch, .versus');
  if (!area) return;
  const box = area.getBoundingClientRect();
  const cx = box.left + box.width / 2;
  const cy = box.top + Math.min(box.height / 2, 240);
  els.forEach((s) => {
    const r = s.getBoundingClientRect();
    const rot = (Math.random() - 0.5) * 50;
    s.style.transform = `translate(${cx - (r.left + r.width / 2)}px, ${cy - (r.top + r.height / 2)}px) rotate(${rot}deg) scale(.7)`;
    s.style.opacity = '0';
  });
  void area.offsetWidth;
  els.sort(() => Math.random() - 0.5).forEach((s, k) => {
    s.classList.add('flying');
    s.style.transitionDelay = `${100 + k * 45}ms`;
    s.style.transform = '';
    s.style.opacity = '';
    s.addEventListener('transitionend', () => { s.classList.remove('flying'); s.style.transitionDelay = ''; }, { once: true });
  });
}

function snapshot(root) {
  const map = new Map();
  root.querySelectorAll('.pl').forEach((s) => map.set(s.dataset.id, s.getBoundingClientRect()));
  return map;
}

function flip(root, before, ids) {
  root.querySelectorAll('.pl').forEach((s) => {
    const from = before.get(s.dataset.id);
    if (!from) return;
    const to = s.getBoundingClientRect();
    const dx = from.left - to.left, dy = from.top - to.top;
    const moved = Math.abs(dx) > 1 || Math.abs(dy) > 1;
    if (moved) {
      s.animate([{ transform: `translate(${dx}px, ${dy}px) rotate(${Math.abs(dx) > 20 ? 6 : 0}deg)` }, { transform: 'none' }],
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
  const sheet = h(`<div class="sheet" role="dialog" aria-modal="true"><span class="grabber"></span><button class="sheet-close" aria-label="Close">✕</button>${html}</div>`);
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
  const isGuest = guest || !!player?.guest;
  // Guests (and anyone already missing a stat) may leave stats empty.
  const allowEmpty = isGuest || (player && hasEmpty(player));
  const draft = player
    ? { ...player }
    : isGuest
      ? { id: uid(), name: '', att: null, def: null, phy: null, fb: null, gk: null, pos: null, alt: null }
      : { id: uid(), name: '', att: 2, def: 2, phy: 2, fb: 2, gk: 1, pos: 'MID', alt: null };
  const showDetails = !(isGuest && !player);
  const noneLabel = isGuest ? '?' : 'None';
  const posButtons = () => ['', ...POSITIONS].map((v) => `
    <button type="button" data-v="${v}" class="${(draft.pos ?? '') === v ? 'on' : ''}">${v || noneLabel}</button>`).join('');
  const altButtons = () => ['', ...POSITIONS].map((v) => `
    <button type="button" data-v="${v}" class="${(draft.alt ?? '') === v ? 'on' : ''}" ${v && v === draft.pos ? 'disabled' : ''}>${v || '—'}</button>`).join('');
  const pips = (k, label) => [...(allowEmpty ? [''] : []), 1, 2, 3].map((n) => {
    const on = n === '' ? draft[k] === null : draft[k] !== null && draft[k] >= n;
    return `<button type="button" data-n="${n}" class="${n === '' ? 'unk' : ''} ${on ? 'f' : ''}" aria-label="${label} ${n || 'unknown'}">${n || '?'}</button>`;
  }).join('');
  const posName = () => (draft.pos ? POS_LABEL[draft.pos] : isGuest ? 'Not sure' : 'No set position');
  const sheet = openSheet(`
    <span class="mono">${player ? (isGuest ? 'Edit guest' : 'Edit player') : isGuest ? 'Tonight only' : 'New regular'}</span>
    <h2 class="display">${player ? esc(player.name) : isGuest ? 'Guest' : 'New player'}</h2>
    <label class="field"><input type="text" maxlength="18" placeholder="Name" autocomplete="off" value="${esc(draft.name)}"></label>
    ${showDetails ? '' : '<button type="button" class="reveal-stats" data-rate>+ Add stats & position <small>optional</small></button>'}
    <div class="details" ${showDetails ? '' : 'hidden'}>
    ${allowEmpty ? '<p class="sheet-note">Leave anything you don\'t know on <b>?</b> and it counts as average.</p>' : ''}
    <div class="pos-block">
      <div class="lbl-row"><b>Main position</b><small data-pos-name>${posName()}</small></div>
      <div class="seg pos-seg" data-pos>${posButtons()}</div>
      <div class="lbl-row"><b>Backup</b><small>Optional</small></div>
      <div class="seg pos-seg alt" data-alt>${altButtons()}</div>
    </div>
    ${RATINGS.map(([k, , label, help]) => `
      <div class="rate" data-k="${k}">
        <div class="lbl"><b>${label}</b><small>${help}</small></div>
        <div class="pips">${pips(k, label)}</div>
      </div>`).join('')}
    </div>
    ${isGuest && !player ? '<label class="check"><input type="checkbox" data-keep> Add to the squad too</label>' : ''}
    <div class="actions">
      ${player ? `<button class="btn ghost small" data-del><span>${isGuest ? 'Remove' : 'Delete'}</span></button>` : ''}
      <button class="btn" data-save>${isGuest && !player ? 'Add guest' : 'Save'}</button>
    </div>`);

  const input = sheet.querySelector('input[type="text"]');
  if (!player) setTimeout(() => input.focus(), 350);

  sheet.addEventListener('click', (e) => {
    if (e.target.closest('[data-rate]')) {
      e.target.closest('[data-rate]').remove();
      const details = sheet.querySelector('.details');
      details.hidden = false;
      details.animate([{ opacity: 0, transform: 'translateY(12px)' }, { opacity: 1, transform: 'none' }], { duration: 300, easing: 'cubic-bezier(.16,1,.3,1)' });
      return;
    }
    const pipBtn = e.target.closest('.pips button');
    if (pipBtn) {
      const rate = pipBtn.closest('.rate');
      const k = rate.dataset.k;
      draft[k] = pipBtn.dataset.n ? Number(pipBtn.dataset.n) : null;
      rate.querySelector('.pips').innerHTML = pips(k, rate.querySelector('b').textContent);
      return;
    }
    const posBtn = e.target.closest('[data-pos] button');
    if (posBtn) {
      draft.pos = posBtn.dataset.v || null;
      if (draft.alt === draft.pos) draft.alt = null;
      sheet.querySelector('[data-pos]').innerHTML = posButtons();
      sheet.querySelector('[data-alt]').innerHTML = altButtons();
      sheet.querySelector('[data-pos-name]').textContent = posName();
      return;
    }
    const altBtn = e.target.closest('[data-alt] button');
    if (altBtn) {
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
      delete draft.unrated;
      const s = state.session;
      if (player) {
        const list = player.guest ? s.guests : state.pool;
        list[list.findIndex((p) => p.id === player.id)] = draft;
        if (player.guest) rememberGuest(draft);
      } else if (isGuest && !sheet.querySelector('[data-keep]').checked) {
        s.guests.push({ ...draft, guest: true });
        s.picked.push(draft.id);
        rememberGuest(draft);
      } else {
        state.pool.push(draft);
        if (isGuest) s.picked.push(draft.id);
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
    lineups: r.lineups, names: TEAM_NAMES, balance: r.balance, match: matchLabel(), format: state.session.format,
  };
  const text = shareText(payload);
  const sheet = openSheet(`
    <span class="mono">Group chat</span>
    <h2 class="display">Send it</h2>
    <img class="share-preview" alt="Team sheet preview">
    <div class="share-opts">
      <button class="btn" data-native hidden>Share image ↗</button>
      <button class="btn paper" data-copy-img>Copy image</button>
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
        a.download = `teams-${state.session.result.match}.png`;
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
takeSnap();
show(routeFromHash(), false);
pullState();
