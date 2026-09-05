// Run with: node --test tests/layouts.test.js
//
// Saved window layouts: the snapshot format and its validation
// (lib/layouts.js), the two stores, the workspace's getLayout / setLayout /
// resetLayout, the LayoutManager's actions and startup restore, and the
// menubar's `{ layouts = ... }` submenu. The components are browser custom
// elements, so the few globals their module scope needs are stubbed;
// frames and panes are fakes that mimic the real ones' pooling contract.
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.HTMLElement = class {};
globalThis.customElements = { get: () => undefined, define: () => {} };

class FakePane {
  constructor(id) {
    this.tagName = "MKUI-PANE";
    this.id = id;
    this.style = {};
    this._built = true;
    this.contentEl = {};
    this.parentElement = null;
    this.events = [];
  }
  _build() {}
  setAttribute() {}
  dispatchEvent(ev) { this.events.push(ev.type); }
}

class FakeFrame {
  constructor() {
    this.style = {};
    this.attrs = {};
    this.bodyEl = { children: [] };
    this._built = true;
    this.removed = false;
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  removeAttribute(k) { delete this.attrs[k]; }
  setup(ws, app, spec) {
    this._tree = normalize(spec.layout);
    this.bodyEl.children = listPanes(this._tree).map((id) => {
      const el = ws._ensurePaneEl(id);
      el.parentElement = this;
      return el;
    });
  }
  getTree() { return this._tree; }
  remove() { this.removed = true; }
}

globalThis.document = {
  createElement(tag) {
    if (tag === "mkui-frame") return new FakeFrame();
    if (tag === "mkui-pane") return new FakePane();
    const classes = new Set();
    const el = {
      tagName: tag.toUpperCase(), className: "", textContent: "", style: {}, _ev: {}, _ch: [],
      classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
      appendChild(n) { el._ch.push(n); n.parentElement = el; return n; },
      addEventListener(name, fn) { (el._ev[name] ??= []).push(fn); },
      fire(name, ev = {}) { ev.stopPropagation ??= () => {}; for (const fn of el._ev[name] ?? []) fn(ev); },
    };
    return el;
  },
  createTextNode: (text) => ({ textContent: text, nodeType: 3 }),
};

const { normalize, listPanes } = await import("../mkui/static/src/layout/tree.js");
const {
  LAYOUT_VERSION, pruneTree, sanitizeLayout, parseSaved, formatSaved, entryLabel,
  retained, sameLayout, LocalLayoutStore, MkioLayoutStore,
} = await import("../mkui/static/src/lib/layouts.js");
const { MkuiWorkspace } = await import("../mkui/static/src/components/workspace.js");
const { MkuiMenubar } = await import("../mkui/static/src/components/menubar.js");
const { LayoutManager, flashStatus } = await import("../mkui/static/src/layouts.js");
const { App } = await import("../mkui/static/src/core.js");

const tabs = (...children) => ({ type: "tabs", active: 0, children });
const tick = () => new Promise(r => setTimeout(r, 0));
const known = new Set(["a", "b", "c", "d"]);

// ── pruneTree / sanitizeLayout ──────────────────────────────────────

test("pruneTree drops unknown panes and keeps the active tab on the same pane", () => {
  const dropped = [];
  const t = pruneTree({ type: "tabs", active: 2, children: ["a", "zz", "c"] }, known, dropped);
  assert.deepEqual(t, { type: "tabs", active: 1, children: ["a", "c"] });
  assert.deepEqual(dropped, ["zz"]);
  assert.equal(pruneTree(tabs("zz"), known, dropped), null);
  assert.equal(pruneTree("a", known), "a", "a bare leaf survives for normalize");
  assert.equal(pruneTree(42, known), null);
});

test("pruneTree keeps a split's surviving children with their ratios", () => {
  const dropped = [];
  const t = pruneTree({
    type: "split", dir: "v", ratios: [0.5, 0.3, 0.2],
    children: [tabs("a"), tabs("zz"), tabs("b", "c")],
  }, known, dropped);
  assert.deepEqual(t, {
    type: "split", dir: "v", ratios: [0.5, 0.2],
    children: [tabs("a"), tabs("b", "c")],
  });
  assert.deepEqual(dropped, ["zz"]);
  assert.equal(normalize(t).ratios.reduce((a, b) => a + b, 0).toFixed(6), "1.000000");
});

test("sanitizeLayout validates frames, drops empty ones, and keeps state for open panes only", () => {
  const clean = sanitizeLayout({
    version: 1,
    frames: [
      { id: "main", title: null, x: 0.1, y: 0.1, w: 0.5, h: 0.5, layout: tabs("a", "b") },
      { id: "gone", x: 0, y: 0, w: 0.3, h: 0.3, layout: tabs("zz") },
      { id: 7, x: "x", y: NaN, w: 0, h: -1, layout: "c" },
      "junk",
    ],
    focused: "main",
    panes: { a: { filters: { s: ["x"] }, sort: "-s", visible: null }, d: { sort: "s" }, b: "junk", c: { extra: 1 } },
  }, known);
  assert.deepEqual(clean.frames, [
    { id: "main", title: null, x: 0.1, y: 0.1, w: 0.5, h: 0.5, layout: tabs("a", "b") },
    { id: null, title: null, x: 0.2, y: 0.2, w: 0.4, h: 0.4, layout: "c" },
  ]);
  assert.equal(clean.focused, "main");
  assert.deepEqual(clean.panes, { a: { filters: { s: ["x"] }, sort: "-s", visible: null }, c: {} });
  assert.deepEqual(clean.dropped, ["zz"]);
  assert.equal(clean.version, LAYOUT_VERSION);
});

test("sanitizeLayout rejects what isn't a layout and versions it doesn't know", () => {
  assert.throws(() => sanitizeLayout(null, known), /not an object/);
  assert.throws(() => sanitizeLayout({ frames: "x" }, known), /no frames/);
  assert.throws(() => sanitizeLayout({ version: 99, frames: [] }, known), /newer/);
  const empty = sanitizeLayout({ frames: [] }, known);
  assert.deepEqual(empty.frames, []);
  assert.equal(empty.focused, null);
});

test("focused must name a surviving frame", () => {
  const clean = sanitizeLayout({ frames: [{ id: "f", layout: tabs("a") }], focused: "other" }, known);
  assert.equal(clean.focused, null);
});

// ── timestamps ──────────────────────────────────────────────────────

test("parseSaved reads SQLite's UTC form and ISO strings", () => {
  assert.equal(parseSaved("2026-09-05 13:02:00").toISOString(), "2026-09-05T13:02:00.000Z");
  assert.equal(parseSaved("2026-09-05T13:02:00Z").toISOString(), "2026-09-05T13:02:00.000Z");
  assert.equal(parseSaved("nope"), null);
  assert.equal(parseSaved(12), null);
});

test("formatSaved shortens to what distinguishes the save from now, always with seconds", () => {
  const now = new Date(2026, 8, 5, 15, 0);
  const today = new Date(2026, 8, 5, 9, 7, 3);
  const thisYear = new Date(2026, 2, 1, 23, 59, 40);
  const lastYear = new Date(2025, 11, 31, 8, 30, 0);
  assert.equal(formatSaved(today, now), "09:07:03");
  assert.equal(formatSaved(thisYear, now), "1 Mar 23:59:40");
  assert.equal(formatSaved(lastYear, now), "31 Dec 2025 08:30:00");
  assert.equal(formatSaved("garbage", now), "");
});

test("entryLabel is the save time, falling back to the id", () => {
  const now = new Date(2026, 8, 5, 15, 0);
  const saved = new Date(2026, 8, 5, 9, 7, 3).toISOString();
  assert.equal(entryLabel({ id: 3, saved }, now), "09:07:03");
  assert.equal(entryLabel({ id: 3, saved: "bad" }, now), "3");
});

// ── retention ───────────────────────────────────────────────────────

const day = 86400000;
function history(now, ...agesInDays) {
  // newest first, ids descending, one entry per age
  return agesInDays.map((age, i) => ({ id: 100 - i, saved: new Date(now.getTime() - age * day).toISOString() }));
}

test("retained keeps the newest `keep` or the last `keepDays`, whichever is more", () => {
  const now = new Date(2026, 8, 5, 12, 0);
  const busy = history(now, 0, 0.5, 1, 2, 3, 4, 5, 6, 6.9, 7.1, 8, 30);   // 12 entries, 9 within a week
  assert.deepEqual(retained(busy, { keep: 3, keepDays: 7, now }).map(e => e.id),
    [100, 99, 98, 97, 96, 95, 94, 93, 92], "a full week beats keep=3");
  const quiet = history(now, 10, 20, 30, 40, 50);
  assert.deepEqual(retained(quiet, { keep: 3, keepDays: 7, now }).map(e => e.id),
    [100, 99, 98], "keep=3 beats an empty week");
  assert.deepEqual(retained(busy, { keep: 10, keepDays: 7, now }).length, 10);
});

test("retained: either limit at 0 disables that half; both at 0 keeps everything; bad dates count as old", () => {
  const now = new Date(2026, 8, 5, 12, 0);
  const h = history(now, 0, 3, 10, 20);
  assert.deepEqual(retained(h, { keep: 0, keepDays: 7, now }).map(e => e.id), [100, 99]);
  assert.deepEqual(retained(h, { keep: 1, keepDays: 0, now }).map(e => e.id), [100]);
  assert.equal(retained(h, { keep: 0, keepDays: 0, now }).length, 4);
  assert.deepEqual(retained([{ id: 1, saved: "x" }, { id: 2, saved: "y" }], { keep: 1, keepDays: 7, now }).map(e => e.id), [1]);
});

test("sameLayout ignores key order and object identity", () => {
  assert.equal(sameLayout({ frames: [{ x: 1, y: 2 }], panes: {} }, { panes: {}, frames: [{ y: 2, x: 1 }] }), true);
  assert.equal(sameLayout({ frames: [{ x: 1 }] }, { frames: [{ x: 2 }] }), false);
  assert.equal(sameLayout({ a: [1, 2] }, { a: [2, 1] }), false, "array order matters");
});

// ── stores ──────────────────────────────────────────────────────────

function fakeStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), map: m };
}

test("LocalLayoutStore keeps a per-owner history newest first and survives garbage", async () => {
  const storage = fakeStorage({ "mkui.layouts.t": "{not json" });
  const store = new LocalLayoutStore(storage, "mkui.layouts.t");
  assert.deepEqual(await store.list(""), []);
  await store.save("", { frames: [1] });
  await store.save("alice", { frames: [2] });
  await store.save("", { frames: [3] });
  const mine = await store.list("");
  assert.deepEqual(mine.map(e => e.id), [3, 1]);
  assert.deepEqual(Object.keys(mine[0]), ["id", "saved"]);
  assert.ok(parseSaved(mine[0].saved), "saved is a parseable timestamp");
  assert.deepEqual((await store.list("alice")).map(e => e.id), [2]);
  assert.deepEqual((await store.load(2)).layout, { frames: [2] });
  assert.equal(await store.load(9), null);
  await store.remove(1);
  assert.deepEqual((await store.list("")).map(e => e.id), [3]);
  assert.equal(typeof storage.map.get("mkui.layouts.t"), "string");
});

function fakeClient(replies = {}) {
  const calls = [];
  return {
    calls,
    request(service, data) {
      calls.push(["request", service, data]);
      const r = replies[service];
      return Promise.resolve(typeof r === "function" ? r(data) : r ?? { type: "reply", rows: [] });
    },
    send(service, data, opts) {
      calls.push(["send", service, data, opts]);
      const r = replies[`${service}:${opts.op}`];
      return Promise.resolve(typeof r === "function" ? r(data) : r ?? { type: "result" });
    },
  };
}

test("MkioLayoutStore speaks the scaffolded services and surfaces error envelopes", async () => {
  const client = fakeClient({
    mkui_layouts_list: { type: "reply", rows: [{ id: 5, saved: "2026-09-05 13:02:00" }] },
    mkui_layouts_get: (d) => d.id === 5
      ? { type: "reply", rows: [{ id: 5, saved: "s", layout: JSON.stringify({ frames: [] }) }] }
      : { type: "reply", rows: [] },
    "mkui_layouts:delete": { type: "error", message: "permission denied" },
  });
  const store = new MkioLayoutStore(client, { app: "orders", timeout: 50 });
  assert.deepEqual(await store.list("alice"), [{ id: 5, saved: "2026-09-05 13:02:00" }]);
  assert.deepEqual(client.calls[0], ["request", "mkui_layouts_list", { app: "orders", owner: "alice" }]);
  await store.save("alice", { frames: [] });
  assert.deepEqual(client.calls[1], ["send", "mkui_layouts",
    { app: "orders", owner: "alice", layout: "{\"frames\":[]}" }, { op: "save" }]);
  assert.deepEqual((await store.load(5)).layout, { frames: [] });
  assert.equal(await store.load(6), null);
  await assert.rejects(() => store.remove(5), /permission denied/);
  assert.deepEqual(client.calls.at(-1), ["send", "mkui_layouts", { id: 5 }, { op: "delete" }]);
});

test("MkioLayoutStore times out a call the server never answers", async () => {
  const client = { request: () => new Promise(() => {}), send: () => new Promise(() => {}) };
  const store = new MkioLayoutStore(client, { timeout: 10 });
  await assert.rejects(() => store.list(""), /timeout/);
});

test("MkioLayoutStore rejects a stored blob that isn't JSON", async () => {
  const client = fakeClient({ mkui_layouts_get: { type: "reply", rows: [{ id: 1, layout: "{oops" }] } });
  const store = new MkioLayoutStore(client);
  await assert.rejects(() => store.load(1), /not valid JSON/);
});

// ── workspace getLayout / setLayout / resetLayout ───────────────────

function hook(initial) {
  const h = { value: initial, sets: [], set(v) { h.sets.push(v); h.value = v; }, get() { return h.value; } };
  return h;
}

function makeWorkspace(frames, config = {}) {
  const ws = new MkuiWorkspace();
  ws.appendChild = () => {};
  ws.clientWidth = 0; ws.clientHeight = 0;
  ws._pool = { appendChild(el) { el.parentElement = ws._pool; } };
  const app = new App({ panes: { a: {}, b: {}, c: {}, d: {} }, ...config });
  ws._app = app;
  ws._panes = new Map(Object.entries(app.config.panes));
  ws._frames = frames;
  for (const spec of frames) ws._mountFrame(spec);
  ws._focusedId = frames.at(-1)?.id ?? null;
  return ws;
}

const rect = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };

test("getLayout snapshots docked frames, focus, and open panes' view state", () => {
  const ws = makeWorkspace([
    { id: "main", title: null, ...rect, layout: { type: "tabs", active: 1, children: ["a", "b"] } },
    { id: "side", title: "Side", x: 0.5, y: 0.5, w: 0.2, h: 0.2, layout: tabs("c") },
    { id: "dlg", x: 0, y: 0, w: 0.1, h: 0.1, layout: tabs("d"), stayOnTop: true, noDock: true },
  ]);
  const a = ws._paneEls.get("a");
  a._filters = hook({ s: ["x"] }); a._sort = hook([{ col: "s", dir: "desc" }]); a._columns = hook(null);
  ws._paneEls.get("c")._columns = hook(["x", "y"]);
  ws._paneEls.get("d")._filters = hook({ d: ["1"] });
  ws._focusedId = "side";
  const l = ws.getLayout();
  assert.equal(l.version, LAYOUT_VERSION);
  assert.deepEqual(l.frames, [
    { id: "main", title: null, ...rect, layout: { type: "tabs", active: 1, children: ["a", "b"] } },
    { id: "side", title: "Side", x: 0.5, y: 0.5, w: 0.2, h: 0.2, layout: tabs("c") },
  ]);
  assert.equal(l.focused, "side");
  assert.deepEqual(l.panes, {
    a: { filters: { s: ["x"] }, sort: [{ col: "s", dir: "desc" }], visible: null },
    c: { visible: ["x", "y"] },
  }, "dialog panes and hookless panes carry no state");
  assert.equal(JSON.stringify(sanitizeLayout(l, ws._panes).frames), JSON.stringify(l.frames),
    "a snapshot round-trips through sanitizeLayout unchanged");
});

test("setLayout moves staying panes, closes leaving ones, opens arriving ones, then applies state", () => {
  const ws = makeWorkspace([
    { id: "main", ...rect, layout: tabs("a", "b") },
    { id: "dlg", x: 0, y: 0, w: 0.1, h: 0.1, layout: tabs("d"), stayOnTop: true, noDock: true },
  ]);
  const a = ws._paneEls.get("a"); a._filters = hook({ old: [1] }); a._sort = hook([]);
  const b = ws._paneEls.get("b");
  const oldMain = ws._frameEls.get("main");
  const clean = ws.setLayout({
    frames: [
      { id: "main", ...rect, layout: tabs("a") },
      { id: "dlg", x: 0.5, y: 0.5, w: 0.3, h: 0.3, layout: tabs("c", "zz") },
    ],
    focused: "dlg",
    panes: { a: { filters: { s: ["y"] } }, c: { sort: "-x" } },
  });
  assert.ok(oldMain.removed, "docked frames are rebuilt");
  assert.deepEqual(a.events, [], "a stayed open: no close/open");
  assert.deepEqual(a._filters.sets, [{ s: ["y"] }], "saved state applied on top");
  assert.deepEqual(a._sort.sets, [], "state not in the layout is left alone");
  assert.deepEqual(b.events, ["mkui-pane-close"]);
  assert.equal(b.parentElement, ws._pool, "a closed pane is parked");
  const c = ws._paneEls.get("c");
  assert.deepEqual(c.events, ["mkui-pane-open"]);
  assert.deepEqual(ws._paneEls.get("d").events, [], "the dialog's pane is untouched");
  assert.deepEqual(clean.dropped, ["zz"]);
  const ids = ws._frames.map(f => f.id);
  assert.equal(ids[0], "main");
  assert.match(ids[1], /^frame-\d+$/, "an id already taken by the dialog is regenerated");
  assert.equal(ids[2], "dlg", "the stayOnTop frame stays on top");
  assert.equal(ws._focusedId, ids[1], "focus follows the renamed frame");
  assert.equal(ws._frameEls.get("dlg").getTree().children[0], "d");
  assert.deepEqual(ws._frameEls.get(ids[1]).getTree(), tabs("c"));
});

test("setLayout applies view state once an async pane factory has installed its hooks", async () => {
  const ws = makeWorkspace([{ id: "main", ...rect, layout: tabs("a") }]);
  let ready;
  ws._ensurePaneEl = ((orig) => function (id) {
    const el = orig.call(ws, id);
    if (id === "c" && !el._ready) el._ready = new Promise(r => { ready = () => { el._filters = hook({}); r(); }; });
    return el;
  })(ws._ensurePaneEl);
  ws.setLayout({ frames: [{ id: "main", ...rect, layout: tabs("c") }], panes: { c: { filters: { s: [1] } } } });
  const c = ws._paneEls.get("c");
  assert.equal(c._filters, undefined, "hooks aren't there yet");
  ready();
  await tick();
  assert.deepEqual(c._filters.sets, [{ s: [1] }], "applied after the factory resolved");
});

test("a later setLayout supersedes view state still waiting on a pane's factory", async () => {
  const ws = makeWorkspace([{ id: "main", ...rect, layout: tabs("a") }]);
  let ready;
  ws._ensurePaneEl = ((orig) => function (id) {
    const el = orig.call(ws, id);
    if (id === "c" && !el._ready) el._ready = new Promise(r => { ready = () => { el._filters = hook({}); r(); }; });
    return el;
  })(ws._ensurePaneEl);
  ws.setLayout({ frames: [{ id: "main", ...rect, layout: tabs("c") }], panes: { c: { filters: { s: [1] } } } });
  ws.setLayout({ frames: [{ id: "main", ...rect, layout: tabs("c") }], panes: { c: { filters: { s: [2] } } } });
  ready();
  await tick();
  assert.deepEqual(ws._paneEls.get("c")._filters.sets, [{ s: [2] }], "only the newest layout's state lands");
});

test("setLayout bumps the frame id sequence past saved ids and defaults focus to the top frame", () => {
  const ws = makeWorkspace([{ id: "main", ...rect, layout: tabs("a") }]);
  ws.setLayout({ frames: [
    { id: "frame-7", ...rect, layout: tabs("a") },
    { id: "frame-2", ...rect, layout: tabs("b") },
  ] });
  assert.equal(ws._frameSeq, 7);
  assert.equal(ws._nextFrameId(), "frame-8");
  assert.equal(ws._focusedId, "frame-2");
});

test("setLayout rejects a non-layout without touching the frames", () => {
  const ws = makeWorkspace([{ id: "main", ...rect, layout: tabs("a") }]);
  assert.throws(() => ws.setLayout({ frames: "nope" }), /frames/);
  assert.equal(ws._frameEls.get("main").removed, false);
});

test("resetLayout rebuilds the config frames and reopens every pane", () => {
  const ws = makeWorkspace(
    [{ id: "main", ...rect, layout: tabs("a", "b") }, { id: "extra", ...rect, layout: tabs("c") }],
    { frames: [{ id: "main", x: 0.02, y: 0.03, w: 0.6, h: 0.9, layout: tabs("a") }, { layout: "b" }] },
  );
  const a = ws._paneEls.get("a"), c = ws._paneEls.get("c");
  a._filters = hook({ s: [1] });
  ws.resetLayout();
  assert.deepEqual(a.events, ["mkui-pane-close", "mkui-pane-open"], "a staying pane is reopened so its config defaults apply");
  assert.deepEqual(a._filters.sets, [], "no saved state is pushed on a reset");
  assert.deepEqual(c.events, ["mkui-pane-close"]);
  const specs = ws._frames;
  assert.equal(specs.length, 2);
  assert.deepEqual([specs[0].id, specs[0].x, specs[0].w], ["main", 0.02, 0.6]);
  assert.match(specs[1].id, /^frame-\d+$/);
  assert.deepEqual(ws._frameEls.get(specs[1].id).getTree(), tabs("b"));
});

// ── LayoutManager ───────────────────────────────────────────────────

function memoryStore(clock) {
  const entries = [];
  let seq = 0;
  return {
    entries,
    async list(owner) {
      return entries.filter(e => e.owner === owner).sort((a, b) => b.id - a.id)
        .map(({ id, saved }) => ({ id, saved }));
    },
    async save(owner, layout) { entries.push({ id: ++seq, owner, saved: clock().toISOString(), layout }); },
    async load(id) { return entries.find(e => e.id === id) ?? null; },
    async remove(id) { const i = entries.findIndex(e => e.id === id); if (i >= 0) entries.splice(i, 1); },
  };
}

function fakeWs() {
  let current = { version: 1, frames: [{ id: "main", layout: tabs("a") }], panes: {} };
  const ws = {
    sets: [], resets: 0,
    arrange(x) { current = { ...current, frames: [{ id: "main", x, layout: tabs("a") }] }; },
    getLayout: () => structuredClone(current),
    setLayout(l) { ws.sets.push(l); return sanitizeLayout(l, new Set(["a"])); },
    resetLayout() { ws.resets++; },
  };
  return ws;
}

function makeManager(config = {}) {
  const app = new App({ layouts: {}, ...config });
  let t = new Date(2026, 8, 5, 12, 0, 0).getTime();
  const clock = { now: () => new Date(t), advance(ms) { t += ms; } };
  const store = memoryStore(clock.now);
  const ws = fakeWs();
  const mgr = new LayoutManager(app.config, app, ws, { store, now: clock.now });
  return { app, store, ws, mgr, clock };
}

test("the owner is the login name, or the default history without one", () => {
  const { app, mgr } = makeManager();
  assert.equal(mgr.owner(), "");
  app.state.set("auth.authenticated", true);
  app.state.set("auth.user", "alice");
  assert.equal(mgr.owner(), "alice");
});

test("layout.save saves at once under the owner and lists newest first with time labels", async () => {
  const { app, store, ws, mgr, clock } = makeManager();
  app.state.set("auth.authenticated", true);
  app.state.set("auth.user", "alice");
  assert.equal(await app.fireAction("layout.save"), true);
  assert.deepEqual(store.entries.map(e => e.owner), ["alice"]);
  assert.equal(app.state.get("status.message"), "Layout saved");
  clock.advance(60000); ws.arrange(0.5);
  await mgr.save();
  const list = app.state.get("layouts.list");
  assert.deepEqual(list.map(e => e.id), [2, 1]);
  assert.deepEqual(list.map(e => e.label), ["12:01:00", "12:00:00"]);
});

test("saving an unchanged layout adds nothing to the history", async () => {
  const { app, store, mgr } = makeManager();
  assert.equal(await mgr.save(), true);
  assert.equal(await mgr.save(), false);
  assert.equal(store.entries.length, 1);
  assert.equal(app.state.get("status.message"), "Layout unchanged");
});

test("saving prunes to the newest `keep` or the last `keepDays`, whichever is more", async () => {
  const { store, ws, mgr, clock } = makeManager({ layouts: { keep: 2, keepDays: 7 } });
  // Five saves one day apart, then one 30 days later: the week keeps 3 of the 6.
  for (let i = 0; i < 5; i++) { ws.arrange(i); await mgr.save(); clock.advance(day); }
  assert.equal(store.entries.length, 5, "all within a week so far");
  clock.advance(25 * day); ws.arrange(9); await mgr.save();
  assert.deepEqual(store.entries.map(e => e.id), [5, 6], "keep=2 wins once the week is empty of older saves");
  // A quiet owner still keeps their last `keep` regardless of age.
  clock.advance(365 * day); ws.arrange(10); await mgr.save();
  assert.deepEqual(store.entries.map(e => e.id), [6, 7]);
});

test("the displayed history applies the retention rule without deleting", async () => {
  const { app, store, mgr, clock } = makeManager({ layouts: { keep: 1, keepDays: 7 } });
  await mgr.save();
  clock.advance(8 * day);
  store.entries.push({ id: 99, owner: "", saved: clock.now().toISOString(), layout: {} });
  await mgr.refresh();
  assert.deepEqual(app.state.get("layouts.list").map(e => e.id), [99], "the old save aged out of view");
  assert.equal(store.entries.length, 2, "nothing deleted on display");
});

test("layout.restore applies the entry; a missing one reports and refreshes", async () => {
  const { app, store, ws, mgr } = makeManager();
  await store.save("", { frames: [{ id: "f", layout: tabs("a") }] });
  assert.equal(await app.fireAction("layout.restore", 1), true);
  assert.equal(ws.sets.length, 1);
  assert.match(app.state.get("status.message"), /^Layout restored: \d\d:\d\d:\d\d$/);
  assert.equal(await mgr.restore(99), false);
  assert.equal(app.state.get("status.message"), "Layout no longer exists");
});

test("a layout whose panes all vanished falls back to the default layout", async () => {
  const { app, store, ws, mgr } = makeManager();
  await store.save("", { frames: [{ id: "f", layout: tabs("gone") }] });
  assert.equal(await mgr.restore(1), false);
  assert.equal(ws.resets, 1);
  assert.equal(app.state.get("status.message"), "Layout's panes no longer exist");
});

test("a corrupt entry is reported, not applied", async () => {
  const { app, store, mgr } = makeManager();
  await store.save("", "not a layout");
  assert.equal(await mgr.restore(1), false);
  assert.match(app.state.get("status.message"), /^Couldn't restore layout/);
});

test("no delete action is registered", () => {
  const { app } = makeManager();
  assert.equal(app.actions.has("layout.delete"), false);
  assert.equal(app.actions.has("layout.load"), false);
});

test("layout.reset resets the workspace", () => {
  const { app, ws } = makeManager();
  app.fireAction("layout.reset");
  assert.equal(ws.resets, 1);
  assert.equal(app.state.get("status.message"), "Layout reset");
});

test("restoreLatest applies the owner's newest layout, or nothing", async () => {
  const { app, store, ws, mgr } = makeManager();
  assert.equal(await mgr.restoreLatest(), false, "empty history");
  await store.save("", { frames: [{ id: "x", layout: tabs("a") }] });
  await store.save("", { frames: [{ id: "y", layout: tabs("a") }] });
  await store.save("bob", { frames: [{ id: "z", layout: tabs("a") }] });
  assert.equal(await mgr.restoreLatest(), true);
  assert.equal(ws.sets.at(-1).frames[0].id, "y");
  assert.deepEqual(app.state.get("layouts.list").map(e => e.id), [2, 1]);
});

test("restoreLatest is off with autoload = false and bounded by the timeout", async () => {
  const off = makeManager({ layouts: { autoload: false } });
  await off.store.save("", { frames: [] });
  assert.equal(await off.mgr.restoreLatest(), false);
  const slow = makeManager({ layouts: { timeout: 10 } });
  slow.store.list = () => new Promise(() => {});
  assert.equal(await slow.mgr.restoreLatest(), false);
});

test("store calls are refused while the mkio store is disconnected", async () => {
  const { app, store, mgr } = makeManager({ mkio: { url: "ws://x/ws" } });
  app.state.set("mkio.connected", false);
  assert.equal(await mgr.restore(1), false);
  assert.equal(app.state.get("status.message"), "Couldn't restore layout: not connected");
  app.state.set("mkio.connected", true);
  await store.save("", { frames: [] });
  assert.equal(await mgr.restore(1), true);
});

test("a store failure is reported and the manager stays usable", async () => {
  const { app, store, mgr } = makeManager();
  store.save = async () => { throw new Error("permission denied"); };
  assert.equal(await mgr.save(), false);
  assert.equal(app.state.get("status.message"), "Couldn't save layout: permission denied");
  assert.equal(mgr._busy, false);
});

test("flashStatus restores the previous message unless something else replaced it", async () => {
  const app = new App({ state: { status: { message: "Connected" } } });
  flashStatus(app, "Hi");
  assert.equal(app.state.get("status.message"), "Hi");
  app.state.set("status.message", "Other");
  await new Promise(r => setTimeout(r, 2100));
  assert.equal(app.state.get("status.message"), "Other");
});

// ── menubar `{ layouts = ... }` ─────────────────────────────────────

test("a layouts marker expands into a submenu of the saved history", () => {
  const app = new App({});
  const fired = [];
  app.registerAction("layout.refresh", () => fired.push("refresh"));
  app.state.set("layouts.list", [{ id: 2, label: "09:07:03" }, { id: 1, label: "08:00:00" }]);
  const mb = new MkuiMenubar();
  mb._app = app;
  const items = mb._expandItems([
    { label: "Restore Layout", layouts: true },
    { label: "Reset", action: "layout.reset" },
  ]);
  assert.deepEqual(items, [
    { label: "Restore Layout", items: [
      { label: "09:07:03", action: "layout.restore", args: 2 },
      { label: "08:00:00", action: "layout.restore", args: 1 },
    ] },
    { label: "Reset", action: "layout.reset" },
  ]);
  assert.deepEqual(fired, ["refresh"], "building the submenu asks for a fresh list");
});

test("an empty history renders one disabled entry and no refresh without a manager", () => {
  const app = new App({});
  const mb = new MkuiMenubar();
  mb._app = app;
  const [item] = mb._expandItems([{ label: "Restore Layout", layouts: true }]);
  assert.deepEqual(item, { label: "Restore Layout", items: [{ label: "No saved layouts", disabled: true }] });
});

test("a disabled leaf renders muted and is inert on click", () => {
  const app = new App({});
  const fired = [];
  app.registerAction("layout.restore", (_, id) => fired.push(id));
  const mb = new MkuiMenubar();
  mb._app = app;
  const popup = mb._buildPopup([
    { label: "No saved layouts", disabled: true },
    { label: "09:07:03", action: "layout.restore", args: 2 },
  ], 0);
  const [dead, live] = popup._ch;
  assert.equal(dead.classList.contains("mkui-menu-item-disabled"), true);
  assert.equal(live.classList.contains("mkui-menu-item-disabled"), false);
  dead.fire("mousedown", { button: 0 });
  dead.fire("mouseup", { button: 0 });
  assert.deepEqual(fired, [], "a disabled leaf fires nothing");
  live.fire("mousedown", { button: 0 });
  live.fire("mouseup", { button: 0 });
  assert.deepEqual(fired, [2], "its live sibling still does");
});
