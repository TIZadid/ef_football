import {
  balance, evaluate, lineup, BalanceError, POSITIONS, suggestKeepers, keeperScore,
} from './balance.js';
import { renderShareImage, shareText } from './share.js';
import { mergeDocs, FIELDS, RECENT_SIZE } from './sync.js';
import { confettiFrom, countUp, heroShapes } from './fx.js';

const app = document.getElementById('app');
const sheetRoot = document.getElementById('sheet-root');

// ---------- rooms & storage ----------
// Each group has a room (a code plus a PIN). This device remembers the room
// it's in, and keeps a local copy of that room's data under its own prefix.
const raw = {
  get(key) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch { return null; } },
  set(key, value) { try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ } },
};
const ROOM = raw.get('gameon.room'); // { code, pin, name } or null
const LEGACY_ROOM = '9999';
const LOCAL_KEYS = ['pool', 'session', 'settings', 'history', 'recent', 'deleted', 'recentCleared', 'stamps'];
// Data saved before rooms existed belongs to room 9999.
if (ROOM?.code === LEGACY_ROOM && raw.get(`gameon.${LEGACY_ROOM}.pool`) === null && raw.get('gameon.pool') !== null) {
  for (const k of LOCAL_KEYS) { const v = raw.get(`gameon.${k}`); if (v !== null) raw.set(`gameon.${LEGACY_ROOM}.${k}`, v); }
}
const store = {
  get(key, fallback) { const v = raw.get(`gameon.${ROOM?.code ?? 'none'}.${key}`); return v === null ? fallback : v; },
  set(key, value) { raw.set(`gameon.${ROOM?.code ?? 'none'}.${key}`, value); },
};
const roomHeaders = () => (ROOM ? { 'X-Room': ROOM.code, 'X-Pin': ROOM.pin } : {});

// Rooms used on this device, newest first, for quick switching.
const myRooms = () => raw.get('gameon.rooms') ?? (ROOM ? [ROOM] : []);
function rememberRoom(room) {
  raw.set('gameon.rooms', [room, ...myRooms().filter((r) => r.code !== room.code)].slice(0, 8));
}
function enterRoom(code, pin, name) {
  rememberRoom({ code, pin, name });
  raw.set('gameon.room', { code, pin, name });
  location.hash = 'home';
  location.reload();
}

function leaveRoom(message, forget = false) {
  if (forget && ROOM) raw.set('gameon.rooms', myRooms().filter((r) => r.code !== ROOM.code));
  raw.set('gameon.room', null);
  if (message) raw.set('gameon.gateMessage', message);
  location.hash = '';
  location.reload();
}

const RATINGS = [
  ['att', 'ATT', 'Attack', 'Goal threat'],
  ['def', 'DEF', 'Defense', '4+ = centre-back'],
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
const DEFAULTS = { att: 3, def: 3, phy: 3, fb: 3, gk: 1 };
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
  // Ratings used to be 1–3; players saved then are moved onto 1–5 (1→1, 2→3, 3→5).
  const old = p.s !== 5;
  const clamp = (v, d = 3) => {
    if (v === null || p.unrated) return null;
    const n = Math.round(Number(v) || (old ? { 3: 2, 1: 1 }[d] ?? 2 : d));
    return old ? { 1: 1, 2: 3, 3: 5 }[Math.min(3, Math.max(1, n))] : Math.min(5, Math.max(1, n));
  };
  const [legacyPos, legacyAlt] = LEGACY_POS[p.pos] ?? [];
  const pos = POSITIONS.includes(p.pos) ? p.pos : p.pos === null || p.unrated ? null : legacyPos ?? 'MID';
  const alt = POSITIONS.includes(p.alt) && p.alt !== pos ? p.alt : legacyPos ? legacyAlt : null;
  return {
    id: String(p.id || uid()), name: String(p.name).trim().slice(0, 18).toUpperCase(),
    att: clamp(p.att), def: clamp(p.def), phy: clamp(p.phy), fb: clamp(p.fb), gk: clamp(p.gk, 1),
    pos, alt, s: 5, ...(p.guest ? { guest: true } : {}), ...(p.t ? { t: p.t } : {}),
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
const keeperLikely = (p) => p.pos === 'GK' || p.alt === 'GK' || p.gk >= 4;

// An overall rating, 40–99, for the player cards.
function ovr(p) {
  const r = (k) => p[k] ?? 3;
  const outfield = 40 + ((r('att') + r('def') + 0.8 * r('phy') + 0.7 * r('fb') - 3.5) / 14) * 59;
  const keeper = p.pos === 'GK' ? 40 + (((p.gk ?? 2) - 1) / 4) * 59 : 0;
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
// Everything in the shared doc (see sync.js) goes to /api/state: the squad,
// settings and this week's picks, guests and teams. View preferences and the
// undo history stay on this device.
const SYNC_LABEL = { local: 'Not syncing', syncing: 'Saving…', synced: 'Saved', offline: 'Offline' };
let syncReason = 'Checking…';
let lastSaved = 0;
const sharedField = (f) => (f === 'settings' ? state.settings : f === 'history' ? state.history : state.session[f]);
function setSharedField(f, v) {
  if (f === 'settings') state.settings = { ...DEFAULT_MATCH, ...v };
  else if (f === 'history') state.history = v;
  else if (f === 'match') state.session.match = { override: null, off: [], ...v };
  else if (f === 'guests') state.session.guests = (v ?? []).map(normalise);
  else if (f === 'result') state.session.result = v && v.starters ? v : null;
  else state.session[f] = v;
}
const localDoc = () => ({
  pool: state.pool, deleted: state.deleted, recent: state.recent, recentCleared: state.recentCleared, stamps: state.stamps,
  ...Object.fromEntries(FIELDS.map((f) => [f, sharedField(f)])),
});

// Edit times use the server's clock, so devices whose clocks disagree still
// agree on which change came last.
let clockOffset = 0;
const now = () => Date.now() + clockOffset;
function readClock(res) {
  const t = Number(res.headers.get('X-Server-Time'));
  if (t) clockOffset = t - Date.now();
}

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
  const t = now();
  const ids = new Set();
  for (const p of state.pool) {
    ids.add(p.id);
    if (snap.pool.get(p.id) !== strip(p)) p.t = t;
  }
  for (const id of snap.pool.keys()) if (!ids.has(id)) state.deleted[id] = t;
  for (const f of FIELDS) if (snap.fields[f] !== JSON.stringify(sharedField(f))) state.stamps[f] = t;
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

function setSync(value, reason) {
  state.sync = value;
  if (reason) syncReason = reason;
  if (value === 'synced') lastSaved = Date.now();
  document.querySelectorAll('[data-sync]').forEach((el) => { el.dataset.state = value; el.title = SYNC_LABEL[value]; el.querySelector('span').textContent = SYNC_LABEL[value]; });
}

let syncTimer;
function scheduleSync() {
  if (state.sync === 'local') return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(pushState, 400);
}

// Re-render after synced changes; the address wins, so a link to the teams
// opens them once they've arrived from another device.
const refreshScreen = () => { if (!activeSheet && state.screen) show(routeFromHash(), false); };

// Send now instead of waiting for the debounce (e.g. locking the teams, or
// the app going to the background).
function pushNow() {
  if (state.sync === 'local') return;
  clearTimeout(syncTimer);
  pushState();
}

async function pushState() {
  setSync('syncing');
  try {
    // keepalive lets the request finish even if the page is being hidden.
    const res = await fetch('/api/state', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json', ...roomHeaders() }, body: JSON.stringify(localDoc()) });
    if (await accessLost(res)) return;
    if (!res.ok) throw new Error(res.status);
    readClock(res);
    if (applyDoc(await res.json())) refreshScreen();
    setSync('synced', 'Every change is saved online and shows up on your other devices within about 15 seconds.');
  } catch {
    setSync('offline', 'Couldn\'t reach the server. Changes are kept on this device and sent when you\'re back online.');
  }
}

// The server said this room's code or PIN no longer works.
async function accessLost(res) {
  const json = (res.headers.get('Content-Type') || '').includes('json');
  if (!json || ![401, 404, 429].includes(res.status)) return false;
  const { error } = await res.json().catch(() => ({}));
  if (res.status === 429) { setSync('offline', error || 'Too many wrong PINs. Try again later.'); return true; }
  if (res.status === 401 && ROOM) raw.set('gameon.gateCode', ROOM.code);
  leaveRoom(res.status === 401
    ? 'The PIN for this room has changed. Enter the new PIN to get back in.'
    : error || 'That room code or PIN doesn\'t work any more.');
  return true;
}

async function pullState() {
  try {
    const res = await fetch('/api/state', { cache: 'no-store', headers: roomHeaders() });
    if (await accessLost(res)) return;
    // No storage connected (or running locally): keep everything on this device.
    if (res.status === 503) return setSync('local', 'The site is running, but its storage isn\'t connected. In Vercel: Storage → connect Upstash Redis to this project, then redeploy.');
    if (res.status === 404) return setSync('local', 'This copy of the site has no storage server (for example when running it on your computer). Changes stay on this device.');
    if (!res.ok) throw new Error(res.status);
    readClock(res);
    const remote = await res.json();
    let changed = applyDoc(remote);
    // The other device may not have moved on to the new week yet.
    const before = JSON.stringify(state.session.result);
    rollover();
    syncTeamsWithPicks();
    if (JSON.stringify(state.session.result) !== before) { save(); changed = true; }
    setSync('synced', 'Every change is saved online and shows up on your other devices within about 15 seconds.');
    if (changed) refreshScreen();
    // Send up anything only this device had.
    if (JSON.stringify(localDoc()) !== JSON.stringify(mergeDocs(remote, {}))) pushState();
  } catch {
    setSync('offline', 'Couldn\'t reach the server. Changes are kept on this device and sent when you\'re back online.');
  }
}
window.addEventListener('visibilitychange', () => {
  if (state.sync === 'local') return;
  if (document.visibilityState === 'visible') pullState();
  else pushNow();
});
window.addEventListener('pagehide', pushNow);
// While the app is open, check for changes from other devices.
setInterval(() => {
  if (document.visibilityState === 'visible' && state.sync !== 'local' && !activeSheet) pullState();
}, 15000);
window.addEventListener('online', () => { if (state.sync === 'offline') pullState(); });

// Remember a guest in the recent list, newest first.
function rememberGuest(g) {
  const { t, ...rest } = g;
  state.recent = [{ ...rest, guest: true, t: now() }, ...state.recent.filter((x) => x.id !== g.id)].slice(0, RECENT_SIZE);
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

// ---------- the week's lifecycle ----------
// Teams belong to one matchday. Once that day has passed they're archived
// (they feed the fresh-match-ups preference) and tonight's picks start over.
const GUEST_EXPIRY_DAYS = 30;
function rollover() {
  const s = state.session;
  const key = iso(matchInfo().date);
  if (s.result && s.result.match && s.result.match < key) {
    state.history = [s.result.teams, ...state.history].slice(0, HISTORY_SIZE);
    s.lastGame = {
      match: s.result.match,
      teams: s.result.teams.map((t) => t.map((id) => byId(id)?.name).filter(Boolean)),
      balance: s.result.balance ?? null,
    };
    s.lastPicked = s.result.teams.flat();
    s.result = null;
    s.picked = [];
    s.guests = [];
    s.keepers = [];
    s.newWeek = true;
  }
  // Teams but no picks (e.g. cleared by mistake): picks follow the teams.
  if (s.result && !s.picked.length) s.picked = s.result.teams.flat();
  // Guests who haven't played for a month drop off the list.
  const cutoff = Date.now() - GUEST_EXPIRY_DAYS * 864e5;
  state.recent = state.recent.filter((g) => (g.t ?? 0) >= cutoff || s.guests.some((x) => x.id === g.id));
}

// 'none' (no teams this week), 'ready', or 'stale' (who's in changed since).
function teamsStatus() {
  const s = state.session;
  if (!s.result || s.result.match !== iso(matchInfo().date)) return { state: 'none', added: 0, removed: 0 };
  const inTeams = new Set(s.result.teams.flat());
  const picked = new Set(s.picked);
  const added = s.picked.filter((id) => !inTeams.has(id)).length;
  const removed = [...inTeams].filter((id) => !picked.has(id)).length;
  return { state: added || removed ? 'stale' : 'ready', added, removed };
}
const changeText = ({ added, removed }) => [added && `${added} added`, removed && `${removed} removed`].filter(Boolean).join(', ');

// ---------- shared bits ----------
const bars = (p) => `<div class="bars">${RATINGS.map(([k, short]) => `
  <div class="${isEmpty(p, k) ? 'unk' : ''}"><span>${short}</span><p>${isEmpty(p, k) ? '<i></i><b>?</b><i></i>' : [1, 2, 3, 4, 5].map((n) => `<i class="${p[k] >= n ? 'f' : ''}"></i>`).join('')}</p></div>`).join('')}</div>`;

// Top bar: brand, which room you're in, and the save status. Navigation
// lives in the bottom bar.
function appbar() {
  return `
    <header class="appbar">
      <button class="brand" data-go="home" aria-label="Home">Game<span>On</span><i>.</i></button>
      <button class="appbar-room" data-go="room" aria-label="Room settings"><span>${esc(ROOM?.name || 'Room')}</span><b>#${esc(ROOM?.code || '')}</b></button>
      <button class="sync" data-sync data-state="${state.sync}" title="${SYNC_LABEL[state.sync]}" aria-label="Sync status"><i></i><span>${SYNC_LABEL[state.sync]}</span></button>
    </header>`;
}

// ---------- bottom bar ----------
// Thumb-reach navigation. Teams sits in the middle: it's what most people
// open the app for.
const tabbar = document.createElement('nav');
tabbar.className = 'tabbar';
tabbar.setAttribute('aria-label', 'Main');
tabbar.hidden = true;
document.body.append(tabbar);
const TAB_ICON = {
  home: '<svg viewBox="0 0 24 24"><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>',
  squad: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5"/><circle cx="17" cy="9" r="2.6"/><path d="M16 14.6c2.8.1 4.8 1.7 5.4 4.9"/></svg>',
  pick: '<svg viewBox="0 0 24 24"><rect x="4" y="3" width="16" height="18" rx="3"/><path d="M8 9l2 2 4-4M8 15h8"/></svg>',
  room: '<svg viewBox="0 0 24 24"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/><circle cx="12" cy="15.5" r="1.4"/></svg>',
};
// A wavy 12-point starburst for the Teams sticker.
const STARBURST = (() => {
  const pts = [];
  for (let i = 0; i < 24; i++) {
    const r = i % 2 ? 40 : 49;
    const a = (Math.PI * 2 * i) / 24 - Math.PI / 2;
    pts.push(`${(50 + r * Math.cos(a)).toFixed(1)} ${(50 + r * Math.sin(a)).toFixed(1)}`);
  }
  return `M${pts.join(' L')}Z`;
})();

function paintTabbar(active) {
  if (!ROOM) { tabbar.hidden = true; return; }
  tabbar.hidden = false;
  const s = state.session;
  const status = teamsStatus().state;
  const badge = isLocked() ? '🔒' : status === 'ready' ? '✓' : status === 'stale' ? '!' : '';
  const flow = ['rules', 'result'].includes(active);
  const tab = (route, label, extra = '') => `
    <button class="tab ${active === route ? 'on' : ''}" data-go="${route}" aria-current="${active === route ? 'page' : 'false'}">
      ${TAB_ICON[route]}<span>${label}</span>${extra}
    </button>`;
  tabbar.innerHTML = `
    ${tab('home', 'Home')}
    ${tab('squad', 'Players')}
    <button class="tab-main ${flow ? 'on' : ''}" data-go="${s.result ? 'result' : 'pick'}" aria-label="Teams">
      <span class="tab-vs" aria-hidden="true">
        <svg viewBox="0 0 100 100"><path d="${STARBURST}"/></svg>
        <b>VS</b>
      </span><span class="tab-main-label">Teams</span>${badge ? `<i class="tab-badge ${status}">${badge}</i>` : ''}
    </button>
    ${tab('pick', "Who's in", s.picked.length ? `<i class="tab-count">${s.picked.length}</i>` : '')}
    ${tab('room', 'Room')}`;
}

function stepper(active) {
  const s = state.session;
  const n = s.picked.length;
  const rulesCount = s.together.filter((r) => r.every(isPlaying)).length + s.apart.filter((r) => r.every(isPlaying)).length;
  const status = teamsStatus().state;
  const steps = [
    ['pick', "Who's in", `${n} in`, false],
    ['rules', 'Rules', rulesCount ? plural(rulesCount, 'rule') : 'optional', false],
    ['result', 'Teams', status === 'ready' ? 'ready' : status === 'stale' ? 'out of date' : 'not made yet', !s.result],
  ];
  return `
    <nav class="stepper" aria-label="Steps">
      ${steps.map(([route, label, sub, disabled], i) => `
        <button data-go="${route}" class="${route === active ? 'on' : ''} ${route === 'result' && status === 'stale' ? 'stale' : ''}" ${disabled ? 'disabled' : ''}>
          <b>${i + 1}</b><span>${label}<small data-step-sub="${route}">${sub}</small></span>
        </button>`).join('')}
    </nav>`;
}

// ---------- routing ----------
const ROUTES = { home, squad, pick, rules, result, room: roomScreen };
const ORDER = { home: 0, squad: 1, pick: 2, rules: 3, result: 4, room: 5 };

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
    paintTabbar(name);
    window.scrollTo(0, 0);
    if (name === 'result' && state.reveal) { state.reveal = false; requestAnimationFrame(() => { revealTeams(); celebrate(); }); }
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
  if (e.target.closest('[data-sync]')) return openSyncSheet();
  const target = e.target.closest('[data-go]');
  if (!target || target.disabled) return;
  // Every new game starts as 5-a-side.
  if (target.hasAttribute('data-new-game')) { state.session.format = DEFAULT_FORMAT; save(); }
  go(target.dataset.go);
});

function openSyncSheet() {
  const ago = lastSaved ? Math.max(1, Math.round((Date.now() - lastSaved) / 1000)) : 0;
  const sheet = openSheet(`
    <span class="mono">Saving & syncing</span>
    <h2 class="display">${state.sync === 'synced' ? 'All saved' : state.sync === 'syncing' ? 'Saving…' : state.sync === 'offline' ? 'Offline' : 'Not syncing'}</h2>
    <p class="sheet-note">${esc(syncReason)}</p>
    ${ago ? `<p class="sheet-note">Last saved ${ago < 60 ? `${ago}s` : `${Math.round(ago / 60)} min`} ago.</p>` : ''}
    <p class="sheet-note">Room <b>#${esc(ROOM?.code ?? '')}</b>. Synced: the squad, past guests, who's in, tonight's guests, rules, the teams and the matchday.</p>
    <div class="actions"><button class="btn" data-retry>Sync now</button></div>`);
  sheet.querySelector('[data-retry]').addEventListener('click', async () => {
    closeSheet();
    await pullState();
    if (state.sync !== 'local') await pushState();
    toast(state.sync === 'synced' ? 'Synced' : SYNC_LABEL[state.sync]);
  });
}

// ---------- home ----------
function home() {
  const s = state.session;
  const mi = matchInfo();
  const el = h(`
    <section class="screen home">
      ${appbar('home')}
      <div class="hero" style="--d:1">
        ${heroShapes()}
        <svg class="wiggle" viewBox="0 0 280 160" aria-hidden="true"><path d="M8 140 C 50 140, 40 30, 92 44 S 130 140, 172 104 S 206 12, 272 24" fill="none" stroke="var(--wiggle)" stroke-width="16" stroke-linecap="round"/></svg>
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
      ${homeStatus(mi)}
    </section>`);

  el.addEventListener('click', (e) => {
    const m = state.session.match;
    if (e.target.closest('[data-match-off]')) { m.off.push(iso(mi.date)); save(); toast('Game off this week'); return show('home', false); }
    if (e.target.closest('[data-match-on]')) { m.off = m.off.filter((d) => d !== iso(mi.date)); save(); toast('Game on!'); return show('home', false); }
    if (e.target.closest('[data-match-reset]')) { m.override = null; save(); return show('home', false); }
    if (e.target.closest('[data-match-edit]')) openMatchSheet(mi);
    if (e.target.closest('[data-same-as-last]')) {
      const s2 = state.session;
      s2.lastPicked.forEach(ensureGuest);
      s2.picked = s2.lastPicked.filter((id) => byId(id));
      s2.newWeek = false;
      save();
      return go('pick');
    }
    if (e.target.closest('[data-home-share]')) { go('result'); setTimeout(openShareSheet, 450); }
  });
  return el;
}

// Our sister site for finding keepers and opponents.
const KHELBI_NAKI_URL = 'https://khelbinaki.zlabz.workers.dev';

// The home menu: current teams first, then setup and the player pool.
function homeStatus(mi) {
  const s = state.session;
  const status = teamsStatus();
  const when = fmtDate(mi.off ? mi.next : mi.date);
  const rulesCount = s.together.length + s.apart.length;
  const canRepeat = !s.picked.length && s.lastPicked.some((id) => byId(id) || state.recent.some((g) => g.id === id));
  let teamsTile;
  if (status.state !== 'none') {
    const r = currentResult();
    const names = (t) => r.teams[t].map((p) => esc(p.name)).join(', ');
    const pill = isLocked() ? '🔒 Locked in' : status.state === 'ready' ? '✓ Set' : '⚠ Out of date';
    teamsTile = `
      <button class="tile teams-tile" data-go="result">
        <span class="tile-top"><span class="tile-label">Current teams</span><span class="status-pill ${isLocked() ? 'locked' : status.state}">${pill}</span></span>
        <span class="tile-big">${r.balance}<small>% balanced</small></span>
        <span class="mini-teams">
          <span><b class="bib a">Black</b> ${names(0)}</span>
          <span><b class="bib b">White</b> ${names(1)}</span>
        </span>
        <span class="tile-go">Open teams →</span>
      </button>
      <button class="btn ghost small tile-share" data-home-share><span>Send to the group ↗</span></button>`;
  } else {
    teamsTile = `
      <div class="tile teams-tile empty-tile">
        <span class="tile-top"><span class="tile-label">Current teams</span><span class="status-pill">${s.newWeek ? 'New week' : 'Not made yet'}</span></span>
        <span class="tile-big small">No teams for ${when} yet</span>
        <ol class="how">
          <li><b>1</b> Tap who's in</li>
          <li><b>2</b> Add rules <small>(optional)</small></li>
          <li><b>3</b> Split, lock in & send</li>
        </ol>
        <span class="tile-actions">
          <button class="btn" data-go="pick" ${s.picked.length ? '' : 'data-new-game'}>${s.picked.length ? `Continue (${s.picked.length} in)` : 'Make teams'} <span class="arrow">→</span></button>
          ${canRepeat ? '<button class="btn ghost small" data-same-as-last><span>Same as last</span></button>' : ''}
        </span>
      </div>`;
  }
  const guestsCount = allGuests().length;
  return `
    <section class="tiles" style="--d:3">
      ${teamsTile}
      <button class="tile small-tile" data-go="pick">
        <span class="tile-label">Who's in & setup</span>
        <span class="tile-big">${s.picked.length}<small> in</small></span>
        <span class="tile-sub">${s.format}-a-side · ${rulesCount ? plural(rulesCount, 'rule') : 'no rules'}${isLocked() ? ' · locked' : ''}</span>
      </button>
      <button class="tile small-tile" data-go="squad">
        <span class="tile-label">Player pool</span>
        <span class="tile-big">${state.pool.length}<small> regulars</small></span>
        <span class="tile-sub">${guestsCount ? plural(guestsCount, 'past guest') : 'no past guests'}</span>
      </button>
    </section>
    ${s.lastGame ? `<p class="last-game mono muted">Last game ${fmtDate(parseIso(s.lastGame.match))}${s.lastGame.balance ? ` · ${s.lastGame.balance}% balanced` : ''}</p>` : ''}
    <a class="partner" href="${KHELBI_NAKI_URL}" target="_blank" rel="noopener" style="--d:4">
      <span class="partner-brand">
        <svg class="partner-logo" viewBox="0 0 64 64" aria-hidden="true">
          <circle cx="32" cy="32" r="21" fill="#a8e23a"/>
          <g stroke="#03110b" stroke-width="2.6" stroke-linecap="round">
            <line x1="32" y1="24.5" x2="32" y2="11"/><line x1="39.1" y1="29.7" x2="52" y2="25.5"/>
            <line x1="36.4" y1="38.1" x2="44.3" y2="49"/><line x1="27.6" y1="38.1" x2="19.7" y2="49"/>
            <line x1="24.9" y1="29.7" x2="12" y2="25.5"/>
          </g>
          <polygon points="32,24.5 39.1,29.7 36.4,38.1 27.6,38.1 24.9,29.7" fill="#03110b" stroke="#03110b" stroke-width="1.5" stroke-linejoin="round"/>
        </svg>
        <span class="partner-word">Khelbi <em>Naki?</em></span>
      </span>
      <span class="partner-head">Need a goalkeeper, or a team to play against?</span>
      <span class="partner-sub">Bangladesh's free futsal board. No sign-up.</span>
      <span class="partner-cta">Open Khelbi Naki <span aria-hidden="true">↗</span></span>
    </a>`;
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
// Tonight's guests plus guests from earlier games (the recent list).
function allGuests() {
  const s = state.session;
  const past = state.recent.filter((g) => !s.guests.some((x) => x.id === g.id)).map(({ t, ...g }) => ({ ...g, guest: true }));
  return [...s.guests, ...past];
}

// Make a guest from an earlier game part of tonight's list.
function ensureGuest(id) {
  const s = state.session;
  if (s.guests.some((g) => g.id === id)) return;
  const g = state.recent.find((x) => x.id === id);
  if (!g) return;
  const { t, ...guest } = g;
  s.guests.push({ ...guest, guest: true });
}

function pick() {
  const s = state.session;
  announceTeamChanges(syncTeamsWithPicks());
  const guests = allGuests();
  // Regulars always show; guests only when picked or when "Show guests" is on.
  const list = [...state.pool.slice().sort(byName), ...guests.filter((g) => isPlaying(g.id) || s.showRecent)];
  const canRepeat = s.lastPicked.length && s.lastPicked.some((id) => byId(id)) && s.lastPicked.join() !== s.picked.join();
  const el = h(`
    <section class="screen">
      ${appbar('pick')}
      ${stepper('pick')}
      <div class="title-row" style="--d:1">
        <h1 class="display title">Who's in?</h1>
        <span class="mono muted">${matchLabel()}</span>
      </div>
      <div class="banner-slot" data-banner style="--d:1">${pickBanner()}</div>
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
          ${guests.length ? `<button class="switch ${s.showRecent ? 'on' : ''}" data-toggle-guests role="switch" aria-checked="${s.showRecent}"><i></i>Past guests (${guests.length})</button>` : ''}
        </div>
      </div>
      <div class="grid" style="--d:3">
        ${list.map((p, i) => ticket(p, i)).join('')}
        <button class="add-tile" data-guest><b>+</b>Guest</button>
      </div>
      ${state.pool.length ? '' : `<div class="empty" style="--d:4;margin-top:14px"><p class="muted">No squad yet. Add guests, or set up your regulars.</p><button class="btn small paper" data-go="squad">Set up squad</button></div>`}
      <div class="dock"><div class="dock-inner">
        <div class="tally"><span class="count" data-count>${pad(s.picked.length)}</span><span class="mono muted" data-split-info></span></div>
        <button class="btn ghost small" data-go="rules"><span>Rules</span></button>
        <button class="btn" data-split>Split ⚡</button>
      </div></div>
    </section>`);

  const count = el.querySelector('[data-count]');
  const info = el.querySelector('[data-split-info]');
  const splitBtn = el.querySelector('[data-split]');
  const sync = (animate = true) => {
    const n = s.picked.length;
    const subs = Math.max(0, n - 2 * s.format);
    count.textContent = pad(n);
    if (animate) bump(count);
    info.textContent = n < 2 ? 'pick 2+' : subs ? `${s.format}v${s.format} +${subs} sub${subs > 1 ? 's' : ''}` : `${Math.floor(n / 2)}v${Math.ceil(n / 2)}`;
    splitBtn.disabled = n < 2;
    const sub = el.querySelector('[data-step-sub="pick"]');
    if (sub) sub.textContent = `${n} in`;
    const status = teamsStatus().state;
    const teamsSub = el.querySelector('[data-step-sub="result"]');
    if (teamsSub) teamsSub.textContent = status === 'ready' ? 'ready' : status === 'stale' ? 'out of date' : 'not made yet';
    el.querySelector('.stepper [data-go="result"]')?.classList.toggle('stale', status === 'stale');
    el.querySelector('[data-banner]').innerHTML = pickBanner();
    paintTabbar('pick');
    splitBtn.innerHTML = isLocked() ? 'Open teams →' : status === 'none' ? 'Split ⚡' : 'Split again ⚡';
    save();
  };
  const setPicked = (ids) => {
    s.picked = ids;
    announceTeamChanges(syncTeamsWithPicks());
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
    if (editGuest) {
      const id = editGuest.closest('.ticket').dataset.id;
      ensureGuest(id);
      return openPlayerSheet({ player: byId(id) });
    }
    if (e.target.closest('[data-toggle-guests]')) {
      s.showRecent = !s.showRecent;
      save();
      const y = window.scrollY;
      show('pick', false);
      window.scrollTo(0, y);
      return;
    }
    const t = e.target.closest('.ticket');
    if (t && isLocked()) return toast('Teams are locked. Unlock them to change who\'s in');
    if (t) {
      const id = t.dataset.id;
      ensureGuest(id);
      buzz(8);
      if (!isPlaying(id)) confettiFrom(t, 8, 0.45);
      return setPicked(isPlaying(id) ? s.picked.filter((x) => x !== id) : [...s.picked, id]);
    }
    if (isLocked() && e.target.closest('[data-all], [data-none], [data-repeat], [data-guest]')) return toast('Teams are locked. Unlock them to change who\'s in');
    if (e.target.closest('[data-repeat]')) {
      e.target.closest('[data-repeat]').remove();
      s.lastPicked.forEach(ensureGuest);
      return setPicked(s.lastPicked.filter((id) => byId(id)));
    }
    // All in = every regular; guests already picked stay picked.
    if (e.target.closest('[data-all]')) return setPicked([...state.pool.map((p) => p.id), ...s.picked.filter((id) => !state.pool.some((p) => p.id === id))]);
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

function pickBanner() {
  const status = teamsStatus();
  if (isLocked()) {
    return `<div class="banner ok"><span>🔒 This week's teams are locked in. Unlock them on the Teams screen to change who's in.</span><button class="chip" data-go="result">Open teams</button></div>`;
  }
  if (status.state === 'ready') {
    return `<div class="banner ok"><span>✓ Teams are set. Changes here update them automatically. Split again for a completely new split.</span><button class="chip" data-go="result">View teams</button></div>`;
  }
  if (status.state === 'stale') {
    return `<div class="banner warn"><span>⚠ Players changed since the teams were made (${changeText(status)}). Split again to update.</span><button class="chip" data-go="result">Old teams</button></div>`;
  }
  return '';
}

const isLocked = () => !!state.session.result?.locked && teamsStatus().state !== 'none';

// Keep the teams in step with who's in: removed players leave, new players
// join whichever team stays most balanced. Returns what changed, or null.
function syncTeamsWithPicks() {
  const s = state.session;
  const r = s.result;
  if (!r || r.locked || teamsStatus().state !== 'stale') return null;
  const picked = new Set(s.picked);
  const before = r.teams.map((t) => t.slice());
  const removed = before.flat().filter((id) => !picked.has(id));
  pushUndo();
  r.teams = r.teams.map((t) => t.filter((id) => picked.has(id)));
  const balanceOf = (teams) => {
    const all = new Map(resolveAll(teams.flat().map(byId).filter(Boolean)).map((p) => [p.id, p]));
    const [A, B] = teams.map((t) => t.map((id) => all.get(id)).filter(Boolean));
    let score = evaluate(A, B, balanceOpts()).balance;
    // House rules come first.
    const side = (id) => (teams[0].includes(id) ? 0 : teams[1].includes(id) ? 1 : -1);
    for (const [x, y] of s.together) if (side(x) >= 0 && side(y) >= 0 && side(x) !== side(y)) score -= 50;
    for (const [x, y] of s.apart) if (side(x) >= 0 && side(x) === side(y)) score -= 50;
    return score;
  };
  const added = [];
  const swaps = [];
  for (const id of s.picked.filter((x) => !r.teams.flat().includes(x))) {
    let best = null;
    for (const t of [0, 1]) {
      const trial = r.teams.map((x, i) => (i === t ? [...x, id] : x));
      if (Math.abs(trial[0].length - trial[1].length) > 1) continue;
      const score = balanceOf(trial);
      if (!best || score > best.score) best = { t, score };
    }
    r.teams[best.t].push(id);
    added.push([id, best.t]);
  }
  // Removals can leave the sizes lopsided: move whoever balances best.
  while (Math.abs(r.teams[0].length - r.teams[1].length) > 1) {
    const big = r.teams[0].length > r.teams[1].length ? 0 : 1;
    let best = null;
    for (const id of r.teams[big]) {
      const trial = r.teams.map((x, i) => (i === big ? x.filter((y) => y !== id) : [...x, id]));
      const score = balanceOf(trial);
      if (!best || score > best.score) best = { id, score, trial };
    }
    r.teams = best.trial;
    added.push([best.id, 1 - big]);
  }
  // Then up to two swaps, only when they clearly even things out, so the
  // teams stay recognisable.
  for (let round = 0; round < 2; round++) {
    const current = balanceOf(r.teams);
    let best = null;
    for (const x of r.teams[0]) {
      for (const y of r.teams[1]) {
        const trial = [r.teams[0].map((id) => (id === x ? y : id)), r.teams[1].map((id) => (id === y ? x : id))];
        const score = balanceOf(trial);
        if (score >= current + 3 && (!best || score > best.score)) best = { score, trial, x, y };
      }
    }
    if (!best) break;
    r.teams = best.trial;
    swaps.push([best.x, best.y]);
  }
  // The shown line-up is rebuilt for the new squads.
  const all = new Map(resolveAll(r.teams.flat().map(byId)).map((p) => [p.id, p]));
  const ups = r.teams.map((t) => lineup(t.map((id) => all.get(id)), balanceOpts()));
  r.starters = ups.map((u) => u.starters.map((p) => p.id));
  r.goal = ups.map((u) => u.keeper?.id ?? null);
  r.signature = null;
  r.edited = true;
  save();
  return { added, removed, swaps };
}

function announceTeamChanges(change) {
  if (!change) return;
  const name = (id) => byId(id)?.name ?? 'Player';
  const parts = [
    ...change.added.map(([id, t]) => `+${name(id)} → ${TEAM_NAMES[t]}`),
    ...change.removed.map((id) => `−${name(id)}`),
    ...(change.swaps ?? []).map(([x, y]) => `${name(x)} ⇄ ${name(y)}`),
  ];
  toast(`Teams updated: ${parts.slice(0, 3).join(', ')}${parts.length > 3 ? '…' : ''}`);
}

function startSplit() {
  if (isLocked()) return go('result');
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
      balance: r.balance,
    };
    s.lastPicked = s.picked.slice();
    s.newWeek = false;
    undoStack.length = 0;
    // Guests who play stay on the list for another month.
    s.guests.filter((g) => isPlaying(g.id)).forEach(rememberGuest);
    save();
    return true;
  } catch (err) {
    toast(err instanceof BalanceError ? err.message : 'Something went wrong');
    console.error(err);
    return false;
  }
}

// Hand edits to the teams can be undone, back to the last split.
const undoStack = [];
const snapshotResult = () => JSON.parse(JSON.stringify(state.session.result));
function pushUndo() {
  undoStack.push(snapshotResult());
  if (undoStack.length > 30) undoStack.shift();
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
      <div class="dock"><div class="dock-inner" data-dock></div></div>
    </section>`);
  const dock = el.querySelector('[data-dock]');
  const paintDock = () => {
    dock.innerHTML = isLocked() ? `
      <button class="btn ghost small" data-unlock-teams><span>🔓 Unlock</span></button>
      <button class="btn" data-share>Send <span class="arrow">↗</span></button>` : `
      <button class="btn orange small regen" data-shuffle aria-label="Regenerate teams"><span class="spin">↻</span></button>
      <button class="btn paper small" data-lock-teams>🔒 Lock in</button>
      <button class="btn" data-share>Send <span class="arrow">↗</span></button>`;
  };
  const body = el.querySelector('[data-body]');

  const paint = () => {
    const r = currentResult();
    s.result.balance = r.balance;
    const status = teamsStatus();
    const [a, b] = r.stats;
    const units = [
      ['Attack', a.atk, b.atk],
      ['Back line', a.back, b.back],
      ['Engine', a.eng, b.eng],
    ];
    body.innerHTML = `
      ${r.edited && r.balance < 90 && !isLocked() ? `<div class="banner warn"><span>Changes made the teams less even (${r.balance}%). Regenerate for a fairer split.</span><button class="chip" data-resplit>Regenerate</button></div>` : ''}
      ${status.state === 'stale' ? `<div class="banner warn"><span>⚠ Who's in changed since these teams were made (${changeText(status)}).</span><button class="chip" data-resplit>Split again</button></div>` : ''}
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
      <div class="view-row">
        <div class="seg view-toggle">
          <button data-view="pitch" class="${s.view === 'pitch' ? 'on' : ''}">Pitch</button>
          <button data-view="list" class="${s.view === 'list' ? 'on' : ''}">List</button>
        </div>
        ${isLocked() ? '<span class="locked-tag">🔒 Locked in</span>' : '<button class="chip" data-swap-colours title="Swap which team is Black and which is White">⇄ Swap colours</button>'}
        ${undoStack.length && !isLocked() ? `<button class="chip undo" data-undo title="Undo the last change">↶ Undo${undoStack.length > 1 ? ` (${undoStack.length})` : ''}</button>` : ''}
      </div>
      ${s.view === 'pitch' ? pitchView(r) : `<div class="versus"><span class="vs">VS</span>${r.lineups.map((u, t) => teamPanel(u, t)).join('')}</div>`}
      ${r.warnings.map((w) => `<div class="warn">⚠ ${esc(w)}</div>`).join('')}
      ${isLocked()
        ? '<p class="edit-hint"><span>🔒</span> These are this week\'s teams. Unlock to make changes.</p>'
        : '<p class="edit-hint"><span>✎</span> Tap any player to swap, move, bench or put them in goal. Happy with them? Lock them in.</p>'}
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
    if (e.target.closest('[data-undo]')) {
      if (!undoStack.length) return;
      const before = snapshot(body);
      s.result = undoStack.pop();
      save();
      paint();
      flip(body, before, []);
      buzz(8);
      return toast('Undone');
    }
    if (e.target.closest('[data-swap-colours]')) {
      pushUndo();
      const res = s.result;
      res.teams.reverse(); res.starters.reverse(); res.goal.reverse();
      save();
      paint();
      revealTeams();
      confettiFrom(el.querySelector('[data-swap-colours]'), 10, 0.5);
      buzz(10);
      return toast('Colours swapped');
    }
    if (e.target.closest('[data-resplit]')) {
      if (runSplit()) { paint(); revealTeams(); celebrate(); }
      return;
    }
    const v = e.target.closest('[data-view]');
    if (v) { s.view = v.dataset.view; save(); paint(); revealTeams(); return; }
    if (e.target.closest('[data-lock-teams]')) {
      s.result.locked = true;
      undoStack.length = 0;
      save();
      pushNow();
      paint();
      paintDock();
      confettiFrom(dock, 26, 0.9);
      buzz([10, 40, 10]);
      return toast('Teams locked in for the week');
    }
    if (e.target.closest('[data-unlock-teams]')) {
      s.result.locked = false;
      save();
      pushNow();
      paint();
      paintDock();
      return toast('Unlocked. You can edit again');
    }
    const pl = e.target.closest('.pl');
    if (pl) {
      if (isLocked()) return toast('Teams are locked. Tap Unlock to edit');
      return openEditSheet(pl.dataset.id, body, paint);
    }
    const regen = e.target.closest('[data-shuffle]');
    if (regen) {
      if (runSplit(s.result.signature)) {
        requestAnimationFrame(() => celebrate(12));
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
  paintDock();
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
  // Subs sit on the bench beside their own half, shown like everyone else.
  const bench = (t) => `<div class="bench ${t ? 'top' : 'bottom'}">
    ${r.lineups[t].subs.map((p) => chipHtml(p, null, 'SUB', t)).join('')}</div>`;
  const hasSubs = r.lineups.some((u) => u.subs.length);
  const pitch = `
    <div class="pitch">
      <span class="team-tag top">White</span>
      ${half(1)}
      <div class="halfway"></div>
      ${half(0)}
      <span class="team-tag bottom">Black</span>
    </div>`;
  return hasSubs ? `
    <div class="pitch-wrap">
      ${pitch}
      <div class="sideline"><span class="sideline-label mono">Bench</span>${bench(1)}${bench(0)}</div>
    </div>` : pitch;
}

function chipHtml(p, keeper, role, t) {
  const isGk = p === keeper;
  const tip = isGk ? `Keeper · GK ${p.empty?.includes('gk') ? '?' : p.gk}` : `OVR ${ovr(p)} · ${role === 'SUB' ? 'Sub' : role === 'ANY' ? 'Any position' : POS_LABEL[role] ?? role}`;
  return `<button class="pl pchip ${t ? 'b' : 'a'} ${isGk ? 'gk' : ''}" data-id="${p.id}" data-tip="${esc(tip)}">
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
    pushUndo();
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
// The balance % counts up and the shapes pop when teams land.
function celebrate(count = 30) {
  const pct = app.querySelector('.balance-row .pct');
  if (!pct) return;
  countUp(pct, Number(pct.firstChild.nodeValue), 40);
  setTimeout(() => confettiFrom(pct, count, 1), 350);
}

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
      ? { id: uid(), name: '', att: null, def: null, phy: null, fb: null, gk: null, pos: null, alt: null, s: 5 }
      : { id: uid(), name: '', att: 3, def: 3, phy: 3, fb: 3, gk: 1, pos: 'MID', alt: null, s: 5 };
  const showDetails = !(isGuest && !player);
  const noneLabel = isGuest ? '?' : 'None';
  const posButtons = () => ['', ...POSITIONS].map((v) => `
    <button type="button" data-v="${v}" class="${(draft.pos ?? '') === v ? 'on' : ''}">${v || noneLabel}</button>`).join('');
  const altButtons = () => ['', ...POSITIONS].map((v) => `
    <button type="button" data-v="${v}" class="${(draft.alt ?? '') === v ? 'on' : ''}" ${v && v === draft.pos ? 'disabled' : ''}>${v || '—'}</button>`).join('');
  const pips = (k, label) => [...(allowEmpty ? [''] : []), 1, 2, 3, 4, 5].map((n) => {
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
      if (player.guest) state.recent = state.recent.filter((p) => p.id !== player.id);
      prune();
      closeSheet();
      toast(`${player.name} removed`);
      return show(routeFromHash(), false);
    }
    if (e.target.closest('[data-save]')) {
      draft.name = input.value.trim().toUpperCase();
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

// ---------- rooms: forms, gate, Room screen ----------
const roomApi = async (body) => {
  const res = await fetch('/api/room', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = (res.headers.get('Content-Type') || '').includes('json') ? await res.json() : null;
  return { res, json };
};
const DIGITS = /^\d{4,8}$/;

function joinForm(prefix) {
  return `
    <form class="room-form" data-form="join">
      <label class="field"><span class="mono">Room code</span><input id="${prefix}-code" inputmode="numeric" autocomplete="off" maxlength="8" placeholder="4–8 digits" data-code></label>
      <label class="field"><span class="mono">PIN</span><input id="${prefix}-pin" type="password" inputmode="numeric" autocomplete="current-password" maxlength="8" placeholder="4–8 digits" data-pin></label>
      <p class="gate-msg" data-msg hidden></p>
      <button class="btn" type="submit">Enter room <span class="arrow">→</span></button>
    </form>`;
}

function createForm(prefix) {
  return `
    <form class="room-form" data-form="create">
      <label class="field"><span class="mono">Room name</span><input id="${prefix}-name" maxlength="30" placeholder="e.g. Friday Offside crew" data-name></label>
      <div class="pin-pair">
        <label class="field"><span class="mono">PIN</span><input id="${prefix}-pin" type="password" inputmode="numeric" autocomplete="new-password" maxlength="8" placeholder="4–8 digits" data-pin></label>
        <label class="field"><span class="mono">PIN again</span><input id="${prefix}-pin2" type="password" inputmode="numeric" autocomplete="new-password" maxlength="8" data-pin2></label>
      </div>
      <details class="more"><summary>Choose your own code</summary>
        <label class="field"><span class="mono">Room code (4–8 digits)</span><input id="${prefix}-code" inputmode="numeric" maxlength="8" placeholder="leave blank for a random one" data-code></label>
      </details>
      <p class="gate-msg" data-msg hidden></p>
      <button class="btn" type="submit">Create room <span class="arrow">→</span></button>
      <div data-created hidden></div>
    </form>`;
}

function resetForm(prefix) {
  return `
    <form class="room-form" data-form="reset">
      <p class="gate-note">Forgot the PIN? Use the room's recovery key to set a new one.</p>
      <label class="field"><span class="mono">Room code</span><input id="${prefix}-code" inputmode="numeric" autocomplete="off" maxlength="8" placeholder="4–8 digits" data-code></label>
      <label class="field"><span class="mono">Recovery key</span><input id="${prefix}-key" autocomplete="off" autocapitalize="characters" maxlength="16" placeholder="XXXX-XXXX-XXXX" data-key></label>
      <div class="pin-pair">
        <label class="field"><span class="mono">New PIN</span><input id="${prefix}-pin" type="password" inputmode="numeric" autocomplete="new-password" maxlength="8" placeholder="4–8 digits" data-pin></label>
        <label class="field"><span class="mono">New PIN again</span><input id="${prefix}-pin2" type="password" inputmode="numeric" autocomplete="new-password" maxlength="8" data-pin2></label>
      </div>
      <p class="gate-msg" data-msg hidden></p>
      <button class="btn" type="submit">Reset PIN <span class="arrow">→</span></button>
      <div data-created hidden></div>
    </form>`;
}

// Wire the join/create forms inside `root`.
function wireRoomForms(root) {
  const msg = (form, text, bad = true) => {
    const m = form.querySelector('[data-msg]');
    m.hidden = !text;
    m.textContent = text || '';
    m.classList.toggle('warn', bad);
  };
  root.querySelectorAll('[data-form="join"]').forEach((f) => f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = f.querySelector('[data-code]').value.trim();
    const pin = f.querySelector('[data-pin]').value.trim();
    if (!DIGITS.test(code)) return msg(f, 'Room codes are 4 to 8 digits.');
    if (!DIGITS.test(pin)) return msg(f, 'PINs are 4 to 8 digits.');
    if (ROOM?.code === code) return msg(f, 'You\'re already in this room.');
    msg(f, 'Checking…', false);
    try {
      const { res, json } = await roomApi({ action: 'join', code, pin });
      // No room server here (e.g. running on a computer): keep it on this device.
      if (!json && res.status === 404) return enterRoom(code, pin, `Room ${code}`);
      if (!res.ok) return msg(f, json?.error || 'Couldn\'t open that room.');
      enterRoom(code, pin, json.name);
    } catch {
      msg(f, 'Couldn\'t reach the server. Check your connection and try again.');
    }
  }));
  root.querySelectorAll('[data-form="reset"]').forEach((f) => f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = f.querySelector('[data-code]').value.trim();
    const recoveryKey = f.querySelector('[data-key]').value.trim();
    const pin = f.querySelector('[data-pin]').value.trim();
    const pin2 = f.querySelector('[data-pin2]').value.trim();
    if (!DIGITS.test(code)) return msg(f, 'Room codes are 4 to 8 digits.');
    if (recoveryKey.replace(/[^a-z0-9]/gi, '').length !== 12) return msg(f, 'Recovery keys look like XXXX-XXXX-XXXX.');
    if (!DIGITS.test(pin)) return msg(f, 'PINs are 4 to 8 digits.');
    if (pin !== pin2) return msg(f, 'The two PINs don\'t match.');
    msg(f, 'Checking…', false);
    try {
      const { res, json } = await roomApi({ action: 'reset-pin', code, recoveryKey, newPin: pin });
      if (!json) return msg(f, 'Resetting a PIN needs the online server.');
      if (!res.ok) return msg(f, json.error || 'Couldn\'t reset the PIN.');
      msg(f, '');
      updateSavedPin(code, pin);
      f.querySelectorAll('.gate-note, .field, .pin-pair, button[type=submit]').forEach((x) => { x.hidden = true; });
      const box = f.querySelector('[data-created]');
      box.hidden = false;
      box.innerHTML = `
        <p class="gate-note">PIN reset for <b>${esc(json.name)}</b>. Everyone else will need the new PIN.</p>
        ${recoveryBox(json.recoveryKey, 'Your old recovery key no longer works. Save this new one somewhere safe.')}
        <div class="tile-actions"><button class="btn" type="button" data-enter>Go to room <span class="arrow">→</span></button></div>`;
      box.querySelector('[data-enter]').addEventListener('click', () => enterRoom(code, pin, json.name));
    } catch {
      msg(f, 'Couldn\'t reach the server. Check your connection and try again.');
    }
  }));
  root.querySelectorAll('[data-form="change-pin"]').forEach((f) => f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const current = f.querySelector('[data-current]').value.trim();
    const pin = f.querySelector('[data-pin]').value.trim();
    const pin2 = f.querySelector('[data-pin2]').value.trim();
    if (!DIGITS.test(pin)) return msg(f, 'The new PIN must be 4 to 8 digits.');
    if (pin !== pin2) return msg(f, 'The two new PINs don\'t match.');
    msg(f, 'Saving…', false);
    try {
      const { res, json } = await roomApi({ action: 'change-pin', code: ROOM.code, pin: current, newPin: pin });
      if (!json) return msg(f, 'Changing the PIN needs the online server.');
      if (!res.ok) return msg(f, json.error || 'Couldn\'t change the PIN.');
      updateSavedPin(ROOM.code, pin);
      f.reset();
      msg(f, 'PIN changed. Other devices will be asked for the new PIN.', false);
      toast('PIN changed');
    } catch {
      msg(f, 'Couldn\'t reach the server. Check your connection and try again.');
    }
  }));
  root.querySelectorAll('[data-new-key]').forEach((b) => b.addEventListener('click', async () => {
    const area = b.closest('[data-key-area]');
    b.disabled = true;
    try {
      const { res, json } = await roomApi({ action: 'recovery-key', code: ROOM.code, pin: ROOM.pin });
      if (!json || !res.ok) { b.disabled = false; return toast(json?.error || 'Making a recovery key needs the online server'); }
      area.innerHTML = recoveryBox(json.recoveryKey, 'Any older recovery key for this room no longer works. Save this one somewhere safe; it won\'t be shown again.');
    } catch {
      b.disabled = false;
      toast('Couldn\'t reach the server');
    }
  }));
  root.querySelectorAll('[data-form="create"]').forEach((f) => f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = f.querySelector('[data-name]').value.trim() || 'Our group';
    const pin = f.querySelector('[data-pin]').value.trim();
    const pin2 = f.querySelector('[data-pin2]').value.trim();
    const code = f.querySelector('[data-code]').value.trim();
    if (!DIGITS.test(pin)) return msg(f, 'PINs are 4 to 8 digits.');
    if (pin !== pin2) return msg(f, 'The two PINs don\'t match.');
    if (code && !DIGITS.test(code)) return msg(f, 'Room codes are 4 to 8 digits.');
    msg(f, 'Creating…', false);
    try {
      const { res, json } = await roomApi({ action: 'create', name, pin, code: code || undefined });
      let made = json;
      if (!json && res.status === 404) made = { code: code || String(Math.floor(100000 + Math.random() * 900000)), name };
      else if (!res.ok) return msg(f, json?.error || 'Couldn\'t create the room.');
      msg(f, '');
      f.querySelectorAll('.field, .pin-pair, .more, button[type=submit]').forEach((x) => { x.hidden = true; });
      const box = f.querySelector('[data-created]');
      box.hidden = false;
      box.innerHTML = `
        <p class="gate-note">Room created. Share the code with your group, and the PIN only with people who should see and edit it.</p>
        <p class="room-code">${esc(made.code)}</p>
        <p class="mono">${esc(made.name)}</p>
        ${made.recoveryKey ? recoveryBox(made.recoveryKey, 'If anyone forgets the PIN, this key resets it. Save it somewhere safe, like your notes. It won\'t be shown again.') : ''}
        <div class="tile-actions">
          <button class="btn ghost small" type="button" data-copy><span>Copy code</span></button>
          <button class="btn" type="button" data-enter>Go to room <span class="arrow">→</span></button>
        </div>`;
      rememberRoom({ code: made.code, pin, name: made.name });
      confettiFrom(box.querySelector('.room-code'), 30, 1);
      box.querySelector('[data-copy]').addEventListener('click', () => copyText(made.code, 'Code copied'));
      box.querySelector('[data-enter]').addEventListener('click', () => enterRoom(made.code, pin, made.name));
    } catch {
      msg(f, 'Couldn\'t reach the server. Check your connection and try again.');
    }
  }));
}

// A recovery key, shown once with a copy button.
const recoveryBox = (key, note) => `
  <div class="recovery">
    <span class="mono">Recovery key</span>
    <p class="recovery-key">${esc(key)}</p>
    <p class="recovery-note">${note}</p>
    <button class="btn ghost small" type="button" data-copy-key="${esc(key)}"><span>Copy recovery key</span></button>
  </div>`;
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-copy-key]');
  if (b) copyText(b.dataset.copyKey, 'Recovery key copied. Keep it somewhere safe');
});

function updateSavedPin(code, pin) {
  raw.set('gameon.rooms', myRooms().map((r) => (r.code === code ? { ...r, pin } : r)));
  if (ROOM?.code === code) { ROOM.pin = pin; raw.set('gameon.room', ROOM); }
}

async function copyText(text, done) {
  try { await navigator.clipboard.writeText(text); toast(done); } catch { toast(text); }
}

// First screen when this device isn't in a room yet.
function gate() {
  const message = raw.get('gameon.gateMessage');
  raw.set('gameon.gateMessage', null);
  const known = myRooms();
  const el = h(`
    <section class="screen gate">
      <div class="hero" style="--d:1">
        ${heroShapes()}
        <div class="badge-logo"><h1 class="headline"><span>Game</span><span>On</span></h1></div>
        <span class="sticker">Fair teams<br>every week</span>
      </div>
      <div class="gate-card" style="--d:2">
        ${message ? `<p class="gate-msg warn">${esc(message)}</p>` : ''}
        ${known.length ? `<div class="known-rooms"><span class="mono">Rooms on this phone</span>${known.map((r) => `
          <button class="known-room" data-known="${esc(r.code)}"><b>${esc(r.name || 'Room')}</b><span>#${esc(r.code)}</span><i>Open →</i></button>`).join('')}</div>` : ''}
        <div class="seg" role="tablist">
          <button data-tab="join" class="on">Enter a room</button>
          <button data-tab="create">Create a room</button>
        </div>
        <div data-pane="join"><p class="gate-note">Every group has its own room. Ask your organiser for the room code and PIN.</p>${joinForm('gate-join')}
          <button class="link-btn" type="button" data-show-reset>Forgot the PIN?</button></div>
        <div data-pane="reset" hidden>${resetForm('gate-reset')}<button class="link-btn" type="button" data-tab-back>← Back to entering a room</button></div>
        <div data-pane="create" hidden><p class="gate-note">Start a room for your group. You'll get a code to share.</p>${createForm('gate-create')}</div>
      </div>
    </section>`);
  el.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-tab]');
    if (tab) {
      el.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b === tab));
      el.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== tab.dataset.tab; });
    }
    const k = e.target.closest('[data-known]');
    if (k) { const r = myRooms().find((x) => x.code === k.dataset.known); if (r) enterRoom(r.code, r.pin, r.name); }
    if (e.target.closest('[data-show-reset]')) {
      el.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== 'reset'; });
      const code = el.querySelector('#gate-join-code').value;
      if (code) el.querySelector('#gate-reset-code').value = code;
    }
    if (e.target.closest('[data-tab-back]')) {
      el.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== 'join'; });
      el.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === 'join'));
    }
  });
  const lastCode = raw.get('gameon.gateCode');
  raw.set('gameon.gateCode', null);
  if (lastCode) el.querySelector('#gate-join-code').value = lastCode;
  wireRoomForms(el);
  return el;
}

// The Room tab: this room, other rooms, joining, creating, leaving.
function roomScreen() {
  const others = myRooms().filter((r) => r.code !== ROOM.code);
  const invite = `Join our football room on Game On ⚽\nRoom code: ${ROOM.code}\n(Ask me for the PIN.)\n${location.origin}`;
  const el = h(`
    <section class="screen">
      ${appbar()}
      <h1 class="display title" style="--d:1">Room</h1>
      <section class="card room-card" style="--d:2">
        <span class="mono muted">You're in</span>
        <h2 class="room-name">${esc(ROOM.name || `Room ${ROOM.code}`)}</h2>
        <p class="room-code">${esc(ROOM.code)}</p>
        <p class="hint">Everyone with this code and the PIN sees the same squad, guests and teams.</p>
        <div class="tile-actions">
          <button class="btn paper small" data-copy-code>Copy code</button>
          <button class="btn small" data-copy-invite>Copy group invite</button>
        </div>
      </section>
      ${others.length ? `
      <section class="card" style="--d:3">
        <h2>Your other rooms</h2>
        <p class="hint">Rooms you've used on this device. Tap to switch.</p>
        <div class="known-rooms">${others.map((r) => `
          <button class="known-room" data-known="${esc(r.code)}"><b>${esc(r.name || 'Room')}</b><span>#${esc(r.code)}</span><i>Switch →</i></button>`).join('')}</div>
      </section>` : ''}
      <section class="card" style="--d:4">
        <details class="room-section">
          <summary><h2>Join another room</h2><span class="mono muted">code + PIN</span></summary>
          ${joinForm('room-join')}
        </details>
      </section>
      <section class="card" style="--d:5">
        <details class="room-section">
          <summary><h2>Create a new room</h2><span class="mono muted">for another group</span></summary>
          ${createForm('room-create')}
        </details>
      </section>
      <section class="card" style="--d:6">
        <details class="room-section">
          <summary><h2>PIN & recovery</h2><span class="mono muted">change or reset</span></summary>
          <form class="room-form" data-form="change-pin">
            <p class="hint">Change the PIN everyone uses to open this room. Other devices will be asked for the new one.</p>
            <label class="field"><span class="mono">Current PIN</span><input id="cp-current" type="password" inputmode="numeric" autocomplete="current-password" maxlength="8" data-current></label>
            <div class="pin-pair">
              <label class="field"><span class="mono">New PIN</span><input id="cp-pin" type="password" inputmode="numeric" autocomplete="new-password" maxlength="8" placeholder="4–8 digits" data-pin></label>
              <label class="field"><span class="mono">New PIN again</span><input id="cp-pin2" type="password" inputmode="numeric" autocomplete="new-password" maxlength="8" data-pin2></label>
            </div>
            <p class="gate-msg" data-msg hidden></p>
            <button class="btn small" type="submit">Change PIN</button>
          </form>
          <div class="key-section" data-key-area>
            <p class="hint">A <b>recovery key</b> resets the PIN if everyone forgets it (use "Forgot the PIN?" on the entry screen). Making a new one replaces the old one.</p>
            <button class="btn ghost small" type="button" data-new-key><span>Make a recovery key</span></button>
          </div>
        </details>
      </section>
      <section class="card leave-card" style="--d:7">
        <h2>Leave this room</h2>
        <p class="hint">Takes this device out of <b>${esc(ROOM.name || ROOM.code)}</b>. Nothing is deleted: the squad and teams stay in the room for everyone else, and you can come back with the code and PIN.</p>
        <div data-leave-area><button class="btn ghost small" data-leave-ask><span>Leave room…</span></button></div>
      </section>
    </section>`);
  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-copy-code]')) return copyText(ROOM.code, 'Code copied');
    if (e.target.closest('[data-copy-invite]')) return copyText(invite, 'Invite copied. Paste it in the group chat');
    const k = e.target.closest('[data-known]');
    if (k) { const r = myRooms().find((x) => x.code === k.dataset.known); if (r) enterRoom(r.code, r.pin, r.name); return; }
    if (e.target.closest('[data-leave-ask]')) {
      el.querySelector('[data-leave-area]').innerHTML = `
        <div class="confirm">
          <p>Leave <b>${esc(ROOM.name || ROOM.code)}</b> on this device?</p>
          <label class="check"><input type="checkbox" data-forget> Also forget its PIN on this device</label>
          <div class="tile-actions">
            <button class="btn ghost small" data-leave-cancel><span>Cancel</span></button>
            <button class="btn orange small" data-leave-yes>Leave room</button>
          </div>
        </div>`;
      return;
    }
    if (e.target.closest('[data-leave-cancel]')) {
      el.querySelector('[data-leave-area]').innerHTML = '<button class="btn ghost small" data-leave-ask><span>Leave room…</span></button>';
      return;
    }
    if (e.target.closest('[data-leave-yes]')) leaveRoom(null, el.querySelector('[data-forget]')?.checked);
  });
  wireRoomForms(el);
  return el;
}

// ---------- boot ----------
if (!ROOM) {
  app.replaceChildren(gate());
} else {
  prune();
  rollover();
  syncTeamsWithPicks();
  save();
  takeSnap();
  show(routeFromHash(), false);
  pullState();
}
