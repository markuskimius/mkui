// Saved window layouts: the snapshot format, its validation against the
// panes an app actually has, and the two stores a layout history lives in
// (the browser's localStorage, or an mkio server). Pure — no DOM — so the
// whole module is unit-testable; `src/layouts.js` wires it to the app.
//
// A layout is what `workspace.getLayout()` returns:
//
//   { version: 1,
//     frames: [{ id, title, x, y, w, h, layout: <tree> }, ...],   // z-order
//     focused: <frame id> | null,
//     panes: { <pane id>: { filters, sort, visible } } }           // open panes
//
// Frame rects are workspace fractions, so a layout saved on one monitor
// lays out proportionally on another; every restored rect still passes
// `clampToDock`. Only panes open in a frame carry view state — a table's
// filters, sort, and visible columns — never a paged table's position.

export const LAYOUT_VERSION = 1;

// Store entry: { id, saved, layout? } — `saved` is an ISO-8601 or SQLite
// "YYYY-MM-DD HH:MM:SS" (UTC) timestamp. Saves are unnamed: the newest
// entry is the owner's layout, older ones are the history behind it.

const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);
const num = (v, dflt) => (typeof v === "number" && Number.isFinite(v)) ? v : dflt;

// Drop panes the app no longer has from a tree, keeping the tab group's
// active tab pointed at the same pane where it survives. Returns null for a
// node with nothing left; `normalize` (in frame setup) collapses the rest.
// `dropped` collects the ids removed.
export function pruneTree(node, known, dropped = []) {
  if (node == null) return null;
  if (typeof node === "string") {
    if (known.has(node)) return node;
    dropped.push(node);
    return null;
  }
  if (!isObj(node)) return null;
  if (node.type === "tabs") {
    const src = Array.isArray(node.children) ? node.children : [];
    const children = [];
    for (const c of src) {
      if (typeof c !== "string") continue;
      if (known.has(c)) children.push(c); else dropped.push(c);
    }
    if (!children.length) return null;
    const wanted = src[num(node.active, 0)];
    const active = Math.max(0, children.indexOf(wanted));
    return { type: "tabs", active, children };
  }
  if (node.type === "split") {
    const src = Array.isArray(node.children) ? node.children : [];
    const ratios = Array.isArray(node.ratios) ? node.ratios : [];
    const children = [], kept = [];
    src.forEach((c, i) => {
      const p = pruneTree(c, known, dropped);
      if (p == null) return;
      children.push(p);
      kept.push(num(ratios[i], 1));
    });
    if (!children.length) return null;
    return { type: "split", dir: node.dir === "v" ? "v" : "h", ratios: kept, children };
  }
  return null;
}

// Validate a stored layout against the app's panes (`known`: anything with
// `.has(id)`). Throws on a layout that isn't one at all; otherwise returns
// a clean copy plus `dropped`, the pane ids that no longer exist — a frame
// left empty by that goes too, and the caller decides whether an empty
// result is worth applying.
export function sanitizeLayout(raw, known) {
  if (!isObj(raw)) throw new Error("layout is not an object");
  const version = num(raw.version, 1);
  if (version > LAYOUT_VERSION) throw new Error(`layout version ${version} is newer than ${LAYOUT_VERSION}`);
  if (!Array.isArray(raw.frames)) throw new Error("layout has no frames array");
  const dropped = [];
  const frames = [];
  for (const f of raw.frames) {
    if (!isObj(f)) continue;
    const tree = pruneTree(f.layout, known, dropped);
    if (tree == null) continue;
    const w = num(f.w, 0), h = num(f.h, 0);
    frames.push({
      id: typeof f.id === "string" && f.id ? f.id : null,
      title: typeof f.title === "string" ? f.title : null,
      x: num(f.x, 0.2), y: num(f.y, 0.2),
      w: w > 0 ? w : 0.4, h: h > 0 ? h : 0.4,
      layout: tree,
    });
  }
  const open = new Set();
  for (const f of frames) collectPanes(f.layout, open);
  const panes = {};
  if (isObj(raw.panes)) {
    for (const [id, st] of Object.entries(raw.panes)) {
      if (!open.has(id) || !isObj(st)) continue;
      const out = {};
      if ("filters" in st) out.filters = isObj(st.filters) ? st.filters : {};
      if ("sort" in st) out.sort = st.sort ?? null;
      if ("visible" in st) out.visible = st.visible ?? null;
      if ("link" in st) out.link = isObj(st.link) ? st.link : null;
      panes[id] = out;
    }
  }
  const focused = typeof raw.focused === "string" && frames.some(f => f.id === raw.focused)
    ? raw.focused : null;
  return { version: LAYOUT_VERSION, frames, focused, panes, dropped: [...new Set(dropped)] };
}

function collectPanes(node, out) {
  if (node == null) return;
  if (typeof node === "string") { out.add(node); return; }
  if (node.type === "tabs") { for (const c of node.children) out.add(c); return; }
  if (node.type === "split") for (const c of node.children) collectPanes(c, out);
}

// Timestamps ──────────────────────────────────────────────────────────

const SQLITE_TS = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

// SQLite's CURRENT_TIMESTAMP is UTC without a zone marker; ISO strings
// carry their own. Returns a Date, or null for garbage.
export function parseSaved(saved) {
  if (saved instanceof Date) return Number.isNaN(saved.getTime()) ? null : saved;
  if (typeof saved !== "string") return null;
  const m = SQLITE_TS.exec(saved);
  const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : new Date(saved);
  return Number.isNaN(d.getTime()) ? null : d;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n) => String(n).padStart(2, "0");

// Local-time label for a save: "14:02:07" today, "5 Sep 14:02:07" this
// year, "5 Sep 2025 14:02:07" otherwise. Seconds, so two saves a minute
// apart never read the same.
export function formatSaved(saved, now = new Date()) {
  const d = parseSaved(saved);
  if (!d) return "";
  const time = `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate();
  if (sameDay) return time;
  const day = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === now.getFullYear()
    ? `${day} ${time}` : `${day} ${d.getFullYear()} ${time}`;
}

// Menu label for a history entry: its save time, else the id.
export function entryLabel(entry, now) {
  return formatSaved(entry.saved, now) || String(entry.id);
}

// Retention: an entry stays while it is one of the `keep` newest *or* was
// saved within `keepDays` days — whichever keeps more. Either limit at 0
// switches that half off; both at 0 keeps everything. Entries must be
// newest first (a store's `list` order); an unparseable `saved` counts
// as old. Shared by display and pruning so both stores agree.
export function retained(entries, { keep = 10, keepDays = 7, now = new Date() } = {}) {
  const n = Number.isFinite(keep) && keep > 0 ? Math.floor(keep) : 0;
  const days = Number.isFinite(keepDays) && keepDays > 0 ? keepDays : 0;
  if (!n && !days) return entries.slice();
  const cutoff = days ? now.getTime() - days * 86400000 : null;
  return entries.filter((e, i) => {
    if (n && i < n) return true;
    if (cutoff == null) return false;
    const d = parseSaved(e.saved);
    return d != null && d.getTime() >= cutoff;
  });
}

// Two layouts are the same save when their canonical JSON matches.
export function sameLayout(a, b) {
  return canon(a) === canon(b);
}
function canon(v) {
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (v != null && typeof v === "object") {
    return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
  }
  return JSON.stringify(v) ?? "null";
}

// Stores ──────────────────────────────────────────────────────────────
//
// Both stores share one async interface, entries newest first:
//   list(owner)         → [{ id, saved }]
//   save(owner, layout) → void
//   load(id)            → { id, saved, layout } | null
//   remove(id)          → void   (pruning)
// `owner` is the login name, or "" for the default (anonymous) history.

// localStorage (or any getItem/setItem object) under one key: every owner's
// history in one JSON document.
export class LocalLayoutStore {
  constructor(storage, key = "mkui.layouts") {
    this._storage = storage;
    this._key = key;
  }

  _read() {
    let doc = null;
    try { doc = JSON.parse(this._storage.getItem(this._key) ?? "null"); } catch { doc = null; }
    if (!isObj(doc) || !Array.isArray(doc.entries)) doc = { seq: 0, entries: [] };
    doc.seq = num(doc.seq, 0);
    doc.entries = doc.entries.filter(isObj);
    return doc;
  }

  _write(doc) {
    this._storage.setItem(this._key, JSON.stringify(doc));
  }

  async list(owner) {
    return this._read().entries
      .filter(e => (e.owner ?? "") === owner)
      .sort((a, b) => b.id - a.id)
      .map(({ id, saved }) => ({ id, saved }));
  }

  async save(owner, layout) {
    const doc = this._read();
    doc.seq += 1;
    doc.entries.push({ id: doc.seq, owner, saved: new Date().toISOString(), layout });
    this._write(doc);
  }

  async load(id) {
    const e = this._read().entries.find(e => e.id === id);
    return e ? { id: e.id, saved: e.saved, layout: e.layout } : null;
  }

  async remove(id) {
    const doc = this._read();
    doc.entries = doc.entries.filter(e => e.id !== id);
    this._write(doc);
  }
}

// An mkio server: one transaction service (ops `save` and `delete`) and two
// reqrep services (`list`, `get`) over one table — the shapes `mkui init`
// scaffolds. The client's send/request resolve with error envelopes rather
// than rejecting, so every call checks the reply type. `app` tells layouts
// of several mkui apps sharing a server apart.
export class MkioLayoutStore {
  constructor(client, opts = {}) {
    this._client = client;
    this._app = opts.app ?? "";
    this._service = opts.service ?? "mkui_layouts";
    this._list = opts.list ?? `${this._service}_list`;
    this._get = opts.get ?? `${this._service}_get`;
    this._timeout = opts.timeout ?? 5000;
  }

  _call(p) {
    return Promise.race([
      p,
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), this._timeout)),
    ]).then((resp) => {
      if (resp?.type === "error") throw new Error(resp.message || "request failed");
      return resp;
    });
  }

  async list(owner) {
    const resp = await this._call(this._client.request(this._list, { app: this._app, owner }));
    return (resp.rows ?? []).map(r => ({ id: r.id, saved: r.saved ?? "" }));
  }

  async save(owner, layout) {
    await this._call(this._client.send(this._service,
      { app: this._app, owner, layout: JSON.stringify(layout) }, { op: "save" }));
  }

  async load(id) {
    const resp = await this._call(this._client.request(this._get, { id }));
    const row = resp.rows?.[0] ?? resp.row ?? null;
    if (!row) return null;
    let layout = row.layout;
    if (typeof layout === "string") {
      try { layout = JSON.parse(layout); } catch { throw new Error("stored layout is not valid JSON"); }
    }
    return { id: row.id, saved: row.saved ?? "", layout };
  }

  async remove(id) {
    await this._call(this._client.send(this._service, { id }, { op: "delete" }));
  }
}
