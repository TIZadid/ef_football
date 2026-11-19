// The shared state every device syncs, and how two copies merge.
// Used by the browser and by the /api/state function.
//
// doc = {
//   pool: [player…],            each player carries `t`, its last-edit time
//   deleted: { id: time },      squad deletions, so they don't come back
//   recent: [guest…],           recently used guests, `t` = last used
//   recentCleared: time,        "clear recent guests" time
//   settings, history, together, apart, match,   whole-value fields…
//   stamps: { field: time },    …each with its last-edit time
// }

export const FIELDS = ['settings', 'history', 'together', 'apart', 'match'];
export const RECENT_SIZE = 12;

export function emptyDoc() {
  return { pool: [], deleted: {}, recent: [], recentCleared: 0, stamps: {} };
}

function mergeById(a = [], b = []) {
  const byId = new Map();
  for (const p of [...a, ...b]) {
    const cur = byId.get(p.id);
    if (!cur || (p.t ?? 0) > (cur.t ?? 0)) byId.set(p.id, p);
  }
  return [...byId.values()];
}

export function mergeDocs(a, b) {
  a = { ...emptyDoc(), ...(a || {}) };
  b = { ...emptyDoc(), ...(b || {}) };
  const deleted = { ...a.deleted };
  for (const [id, t] of Object.entries(b.deleted)) deleted[id] = Math.max(deleted[id] ?? 0, t);

  const pool = mergeById(a.pool, b.pool).filter((p) => !(deleted[p.id] >= (p.t ?? 0)));
  const recentCleared = Math.max(a.recentCleared, b.recentCleared);
  const recent = mergeById(a.recent, b.recent)
    .filter((p) => (p.t ?? 0) > recentCleared)
    .sort((x, y) => (y.t ?? 0) - (x.t ?? 0))
    .slice(0, RECENT_SIZE);

  const out = { pool, deleted, recent, recentCleared, stamps: {} };
  for (const f of FIELDS) {
    const ta = a.stamps[f] ?? -1, tb = b.stamps[f] ?? -1;
    const pickB = tb > ta || (a[f] === undefined && b[f] !== undefined);
    out[f] = pickB ? b[f] : a[f];
    out.stamps[f] = Math.max(ta, tb, 0);
  }
  return out;
}
