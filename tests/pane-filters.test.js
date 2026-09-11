// Run with: node --test tests/pane-filters.test.js
//
// Programmatic column filters: the workspace routes setPaneFilters /
// getPaneFilters (and the `table.filter` action built on them) to a pane's
// `_filters` hook — by id, building a never-shown pane first, or to the
// focused frame's active pane when no id is given.
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.HTMLElement = class {};
globalThis.customElements = { get: () => undefined, define: () => {} };
globalThis.document = {
  createElement(tag) {
    const el = {
      tagName: tag.toUpperCase(), className: "", textContent: "",
      style: {}, _ev: {}, _ch: [],
      appendChild(n) { el._ch.push(n); return n; },
      addEventListener(name, fn) { (el._ev[name] ??= []).push(fn); },
    };
    return el;
  },
  createTextNode: (text) => ({ textContent: text, nodeType: 3 }),
};

const { MkuiWorkspace } = await import("../mkui/static/src/components/workspace.js");

function hook(log, name) {
  let current = {};
  return {
    set(map, opts) { log.push([name, map, opts]); current = map; },
    get() { return current; },
  };
}

function makeWorkspace(log) {
  const ws = new MkuiWorkspace();
  const tree = { type: "tabs", active: 1, children: ["a", "b"] };
  ws._frames = [{ id: "f1" }];
  ws._frameEls = new Map([["f1", { _activeTabGroup: tree, getTree: () => tree }]]);
  ws._focusedId = "f1";
  ws._panes = new Map([["a", {}], ["b", {}], ["plain", {}], ["parked", {}]]);
  ws._paneEls = new Map([
    ["a", { _filters: hook(log, "a") }],
    ["b", { _filters: hook(log, "b") }],
    ["plain", {}],
  ]);
  ws._ensurePaneEl = (id) => {
    let el = ws._paneEls.get(id);
    if (!el) { el = { _filters: hook(log, id) }; ws._paneEls.set(id, el); }
    return el;
  };
  return ws;
}

test("setPaneFilters reaches the named pane's hook and returns whether it did", () => {
  const log = [];
  const ws = makeWorkspace(log);
  assert.equal(ws.setPaneFilters("a", { status: ["open"] }, { merge: true }), true);
  assert.deepEqual(log, [["a", { status: ["open"] }, { merge: true }]]);
  assert.deepEqual(ws.getPaneFilters("a"), { status: ["open"] });
  assert.equal(ws.setPaneFilters("plain", {}), false, "a pane without the hook declines");
  assert.equal(ws.setPaneFilters("nope", {}), false, "an unknown id declines");
  assert.equal(ws.getPaneFilters("plain"), null);
});

test("a pane that was never shown is built so filters can be set ahead of opening it", () => {
  const log = [];
  const ws = makeWorkspace(log);
  assert.equal(ws.setPaneFilters("parked", { qty: { from: 1 } }), true);
  assert.deepEqual(log, [["parked", { qty: { from: 1 } }, {}]]);
});

test("no id targets the focused frame's active pane", () => {
  const log = [];
  const ws = makeWorkspace(log);
  assert.equal(ws.setPaneFilters(null, { x: [] }), true);
  assert.equal(log[0][0], "b", "tab index 1 of the focused frame");
  assert.deepEqual(ws.getPaneFilters(), { x: [] });
});

/* ── Built-in actions ─────────────────────────────────────────────────── */
// <mkui-app> can't be instantiated here (it needs the DOM), so guard the
// wiring at the source: the table.* actions must hand their args to the
// workspace routes above, defaulting the pane to the focused one.

test("table.filter and table.sort actions route to the workspace", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../mkui/static/src/components/app.js", import.meta.url), "utf8");
  assert.match(src, /registerAction\("table\.filter",\s*\(app, a = \{\}\) => ws\.setPaneFilters\(a\.pane \?\? null, a\.filters \?\? \{\}, \{ merge: a\.merge === true \}\)\)/);
  assert.match(src, /registerAction\("table\.sort",\s*\(app, a = \{\}\) => ws\.setPaneSort\(a\.pane \?\? null, a\.sort \?\? null\)\)/);
  assert.match(src, /registerAction\("table\.columns",\s*\(app, a = \{\}\) => ws\.setPaneColumns\(a\.pane \?\? null, a\.visible \?\? null\)\)/);
});

/* ── Sort routing ─────────────────────────────────────────────────────── */
// setPaneSort / getPaneSort go through the same resolution to a pane's
// `_sort` hook.

function makeSortWorkspace(log) {
  const ws = makeWorkspace(log);
  for (const [id, el] of ws._paneEls) if (el._filters) el._sort = hook(log, "sort:" + id);
  const ensure = ws._ensurePaneEl;
  ws._ensurePaneEl = (id) => {
    const el = ensure(id);
    if (el._filters) el._sort ??= hook(log, "sort:" + id);
    return el;
  };
  return ws;
}

test("setPaneSort reaches the named pane's sort hook; getPaneSort reads it back", () => {
  const log = [];
  const ws = makeSortWorkspace(log);
  assert.equal(ws.setPaneSort("a", "-ts"), true);
  assert.deepEqual(log, [["sort:a", "-ts", undefined]]);
  assert.equal(ws.getPaneSort("a"), "-ts");
  assert.equal(ws.setPaneSort("plain", "x"), false, "a pane without the hook declines");
  assert.equal(ws.setPaneSort("nope", "x"), false);
  assert.equal(ws.getPaneSort("plain"), null);
  assert.equal(ws.setPaneSort("parked", [{ col: "a", dir: "desc" }]), true, "never-shown pane is built first");
  assert.equal(ws.setPaneSort(null, null), true, "no id targets the focused pane");
  assert.equal(log.at(-1)[0], "sort:b");
});

/* ── Columns routing ──────────────────────────────────────────────────── */
// setPaneColumns / getPaneColumns reach a pane's `_columns` hook the same way.

function makeColumnsWorkspace(log) {
  const ws = makeWorkspace(log);
  for (const [id, el] of ws._paneEls) if (el._filters) el._columns = hook(log, "cols:" + id);
  const ensure = ws._ensurePaneEl;
  ws._ensurePaneEl = (id) => {
    const el = ensure(id);
    if (el._filters) el._columns ??= hook(log, "cols:" + id);
    return el;
  };
  return ws;
}

test("setPaneColumns reaches the named pane's columns hook; getPaneColumns reads it back", () => {
  const log = [];
  const ws = makeColumnsWorkspace(log);
  assert.equal(ws.setPaneColumns("a", ["id", "qty"]), true);
  assert.deepEqual(log, [["cols:a", ["id", "qty"], undefined]]);
  assert.deepEqual(ws.getPaneColumns("a"), ["id", "qty"]);
  assert.equal(ws.setPaneColumns("plain", ["x"]), false, "a pane without the hook declines");
  assert.equal(ws.setPaneColumns("nope", ["x"]), false);
  assert.equal(ws.getPaneColumns("plain"), null);
  assert.equal(ws.setPaneColumns("parked", "id"), true, "never-shown pane is built first");
  assert.equal(ws.setPaneColumns(null, null), true, "no id targets the focused pane; null shows all");
  assert.deepEqual(log.at(-1), ["cols:b", null, undefined]);
});

/* ── Tree routing ─────────────────────────────────────────────────────── */
// expandPane reaches a tree table's `_tree` hook; `table.expand` wraps it.

test("expandPane reaches the named pane's tree hook; panes without one decline", () => {
  const log = [];
  const ws = makeWorkspace(log);
  for (const [id, el] of ws._paneEls) if (el._filters) el._tree = { expand: (d) => log.push(["tree:" + id, d]) };
  assert.equal(ws.expandPane("a", 2), true);
  assert.deepEqual(log, [["tree:a", 2]]);
  assert.equal(ws.expandPane("plain", 1), false, "a flat table has no tree hook");
  assert.equal(ws.expandPane("nope", 1), false);
  assert.equal(ws.expandPane(null, "all"), true, "no id targets the focused pane");
  assert.deepEqual(log.at(-1), ["tree:b", "all"]);
});

test("table.expand action routes to the workspace", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../mkui/static/src/components/app.js", import.meta.url), "utf8");
  assert.match(src, /registerAction\("table\.expand",\s*\(app, a = \{\}\) => ws\.expandPane\(a\.pane \?\? null, a\.depth \?\? 0\)\)/);
});

/* ── Selection routing ────────────────────────────────────────────────── */
// selectPane reaches a table's `_select` hook and returns its result;
// `table.select` wraps it.

test("selectPane reaches the named pane's select hook and returns its result; no pane declines", () => {
  const log = [];
  const ws = makeWorkspace(log);
  for (const [id, el] of ws._paneEls) if (el._filters) el._select = {
    set: (keys, opts) => { log.push(["sel:" + id, keys, opts]); return { ok: true, selected: keys, missing: [], hidden: [] }; },
    get: () => ({ keys: ["k"], focus: "k" }),
  };
  assert.deepEqual(ws.selectPane("a", ["1", "2"], { focus: false }), { ok: true, selected: ["1", "2"], missing: [], hidden: [] });
  assert.deepEqual(log, [["sel:a", ["1", "2"], { focus: false }]]);
  assert.equal(ws.selectPane("plain", ["1"]), false, "a pane without the hook declines");
  assert.equal(ws.selectPane("nope", ["1"]), false);
  assert.ok(ws.selectPane(null, []).ok, "no id targets the focused pane");
  assert.deepEqual(log.at(-1), ["sel:b", [], {}]);
  assert.deepEqual(ws.getPaneSelection("a"), { keys: ["k"], focus: "k" });
  assert.equal(ws.getPaneSelection("plain"), null);
});

test("selectPane builds a never-shown pane, and declines while its table has no hook yet", () => {
  const log = [];
  const ws = makeWorkspace(log);
  for (const [, el] of ws._paneEls) if (el._filters) el._select = { set: () => ({ ok: true }), get: () => null };
  // "parked" is in the config but was never shown: _ensurePaneEl builds it,
  // and an async table factory has not installed `_select` yet.
  assert.equal(ws.selectPane("parked", ["1"]), false);
  assert.ok(ws._paneEls.has("parked"), "the pane was still built, as the other setters do");
  ws._paneEls.get("parked")._select = { set: (keys) => ({ ok: true, selected: keys, missing: [], hidden: [] }), get: () => null };
  assert.deepEqual(ws.selectPane("parked", ["1"]).selected, ["1"], "it takes them once the hook exists");
});

test("table.select action routes to the workspace with the focus flag", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../mkui/static/src/components/app.js", import.meta.url), "utf8");
  assert.match(src, /registerAction\("table\.select",\s*\(app, a = \{\}\) => ws\.selectPane\(a\.pane \?\? null, a\.keys \?\? \[\], \{ focus: a\.focus !== false \}\)\)/);
});

test("setPaneLink / getPaneLink reach the pane's `_link` hook the same way", () => {
  const log = [];
  const ws = makeWorkspace(log);
  ws._paneEls.get("a")._link = hook(log, "a-link");
  assert.equal(ws.setPaneLink("a", { broadcast: { k: "id" } }, { merge: true }), true);
  assert.deepEqual(log, [["a-link", { broadcast: { k: "id" } }, { merge: true }]]);
  assert.deepEqual(ws.getPaneLink("a"), { broadcast: { k: "id" } });
  assert.equal(ws.setPaneLink("plain", {}), false, "a pane without the hook declines");
  assert.equal(ws.getPaneLink("plain"), null);
});

/* ── Record history routing ───────────────────────────────────────────── */
// `showPaneHistory` opens one history pane per table pane and points it at
// whatever that table has selected; `table.history` is the action over it.

function historyWorkspace(log) {
  const ws = makeWorkspace(log);
  for (const [id, el] of ws._paneEls) {
    el.dataset = { id };
    if (el._filters) {
      el._history = { spec: { table: "orders", versions: "order_versions" }, rows: () => [{ id: "O1" }] };
      el._select = {
        set: (keys, opts) => { log.push(["sel:" + id, keys, opts]); return { ok: true }; },
        get: () => null,
        on: (fn) => { log.push(["on:" + id]); return () => log.push(["off:" + id]); },
      };
    }
  }
  ws.registerPane = (id, spec) => { log.push(["register", id, spec]); ws._panes.set(id, spec); };
  ws.showPane = (id) => log.push(["show", id]);
  return ws;
}

test("showPaneHistory registers one history pane per table and shows it", () => {
  const log = [];
  const ws = historyWorkspace(log);
  ws._panes.set("a", { title: "Orders" });
  assert.equal(ws.showPaneHistory("a"), true);
  assert.deepEqual(log[0], ["register", "_history:a", {
    // Plain: the record it lands on names the tab from here.
    type: "mkio-history", source: "a", title: "History",
  }]);
  assert.deepEqual(log[1], ["show", "_history:a"]);

  // Again: the same pane, registered once, re-pointed at the selection.
  const el = { _record: { refresh: () => log.push(["refresh"]) } };
  ws._paneEls.set("_history:a", el);
  log.length = 0;
  ws.showPaneHistory("a");
  assert.deepEqual(log, [["show", "_history:a"], ["refresh"]]);
});

/* ── Detail windows ───────────────────────────────────────────────────── */

// A pane with a `_record` hook, as `attachRecord` installs it.
function recordPane(log, id, spec = { listening: true, retain: false }) {
  let record = null;
  return {
    dataset: { id },
    _record: {
      get: () => record,
      set: (key) => { record = key ? { key, row: key, of: 1, from: "manual" } : null; log.push(["set", id, key]); },
      follow: (s, o) => { log.push(["follow", id, s, o]); spec = { ...spec, ...(s ?? {}) }; return true; },
      config: () => spec,
      on: (fn) => { log.push(["on", id]); return () => log.push(["off", id]); },
      refresh: () => log.push(["refresh", id]),
    },
  };
}

test("the record API reaches the pane's hook, and says when there is none", () => {
  const log = [];
  const ws = makeWorkspace(log);
  ws._panes.set("detail", {});
  ws._paneEls.set("detail", recordPane(log, "detail"));

  assert.equal(ws.setPaneRecord("detail", { id: 4711 }), true);
  assert.deepEqual(ws.getPaneRecord("detail").key, { id: 4711 });
  assert.equal(ws.setPaneRecordSource("detail", { listen: { order_id: "id" } }, { merge: true }), true);
  assert.deepEqual(ws.getPaneRecordSource("detail"), { listening: true, retain: false, listen: { order_id: "id" } });
  assert.equal(typeof ws.onPaneRecord("detail", () => {}), "function");

  // A table has no record to show, and says so rather than throwing.
  assert.equal(ws.setPaneRecord("a", { id: 1 }), false);
  assert.equal(ws.getPaneRecord("a"), null);
  assert.equal(ws.getPaneRecordSource("a"), null);
  assert.equal(ws.onPaneRecord("a", () => {}), null);
});

test("paneRows reads the rows a pane's selection implies, history hook first", () => {
  const ws = makeWorkspace([]);
  const rows = [{ id: 1 }];
  ws._paneEls.set("h", { _history: { rows: () => rows }, _data: { selected: () => [] } });
  ws._paneEls.set("t", { _data: { selected: () => rows } });
  ws._paneEls.set("bare", {});
  assert.deepEqual(ws.paneRows("h"), rows, "a table with a history block knows which rows are records");
  assert.deepEqual(ws.paneRows("t"), rows);
  assert.deepEqual(ws.paneRows("bare"), []);
  assert.deepEqual(ws.paneRows("never-opened"), [], "an unopened pane has no selection to speak of");
});

test("showPaneRecord raises the window and hands it the table's row", () => {
  const log = [];
  const ws = makeWorkspace(log);
  const row = { id: 5, symbol: "AAPL" };
  ws._panes.set("detail", {});
  ws._paneEls.set("orders", { _data: { selected: () => [row] } });
  ws._paneEls.set("detail", recordPane(log, "detail"));
  ws.showPane = (id) => log.push(["show", id]);

  assert.equal(ws.showPaneRecord("detail", { from: "orders" }), true);
  assert.deepEqual(log, [["show", "detail"], ["set", "detail", row]],
    "every field goes, so the pane picks whichever columns are its key");
  assert.equal(ws.showPaneRecord(null), false, "a detail window has to be named");
});

test("showPaneRecord waits for a pane whose factory is still settling", async () => {
  const log = [];
  const ws = makeWorkspace(log);
  ws._panes.set("detail", {});
  ws._paneEls.set("orders", { _data: { selected: () => [{ id: 5 }] } });
  let resolve;
  const el = { dataset: { id: "detail" }, _ready: new Promise((r) => { resolve = r; }) };
  ws._paneEls.set("detail", el);
  ws.showPane = () => {};
  assert.equal(ws.showPaneRecord("detail", { from: "orders" }), true);
  Object.assign(el, recordPane(log, "detail"));
  resolve();
  await el._ready;
  await Promise.resolve();
  assert.deepEqual(log.at(-1), ["set", "detail", { id: 5 }]);
});

test("a detail window names its own tab, until the user names it", () => {
  const ws = makeWorkspace([]);
  const rendered = [];
  ws._retitle = (id) => rendered.push(id);
  ws._panes.set("detail", { title: "Order" });

  assert.equal(ws.setPaneAutoTitle("detail", "4711"), true);
  assert.equal(ws._panes.get("detail").title, "Order — 4711");
  assert.equal(ws.setPaneAutoTitle("detail", "4711"), false, "the same record does not re-render the tab");
  // The suffix never accumulates: the configured title is remembered.
  ws.setPaneAutoTitle("detail", "4712");
  assert.equal(ws._panes.get("detail").title, "Order — 4712");
  ws.setPaneAutoTitle("detail", "");
  assert.equal(ws._panes.get("detail").title, "Order", "an empty window goes back to its plain name");

  ws.renamePane("detail", "My order");
  assert.equal(ws.setPaneAutoTitle("detail", "4713"), false, "the name the user typed is theirs");
  assert.equal(ws._panes.get("detail").title, "My order");
  assert.equal(ws.setPaneAutoTitle("never-registered", "x"), false);
});

test("showPaneHistory declines a pane with no history to read", () => {
  const log = [];
  const ws = historyWorkspace(log);
  assert.equal(ws.showPaneHistory("plain"), false);
  assert.equal(ws.showPaneHistory("nope"), false);
  assert.deepEqual(log, []);
});

test("showPaneHistory selects the named keys in the table first", () => {
  const log = [];
  const ws = historyWorkspace(log);
  ws.showPaneHistory("a", ["O7"]);
  assert.deepEqual(log[0], ["sel:a", ["O7"], {}], "the record is selected, then its history opens");
  assert.equal(log[1][0], "register");
});

test("showPaneHistory with no id follows the focused pane", () => {
  const log = [];
  const ws = historyWorkspace(log);
  assert.equal(ws.showPaneHistory(null), true);
  assert.deepEqual(log[0][1], "_history:b", "tab index 1 of the focused frame");
});

test("a pane still building gets its record once its factory settles", async () => {
  const log = [];
  const ws = historyWorkspace(log);
  let resolve;
  const el = { _ready: new Promise((r) => { resolve = r; }) };
  ws._paneEls.set("_history:a", el);
  ws.showPaneHistory("a");
  el._record = { refresh: () => log.push(["refresh"]) };
  resolve();
  await el._ready;
  await Promise.resolve();
  assert.deepEqual(log.at(-1), ["refresh"]);
});

test("paneHistory and onPaneSelection reach the pane's hooks", () => {
  const log = [];
  const ws = historyWorkspace(log);
  assert.equal(ws.paneHistory("a").spec.versions, "order_versions");
  assert.equal(ws.paneHistory("plain"), null);
  const off = ws.onPaneSelection("a", () => {});
  assert.deepEqual(log, [["on:a"]]);
  off();
  assert.deepEqual(log.at(-1), ["off:a"]);
  assert.equal(ws.onPaneSelection("plain", () => {}), null);
});

test("table.history action routes to the workspace", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../mkui/static/src/components/app.js", import.meta.url), "utf8");
  assert.match(src, /registerAction\("table\.history",\s*\(app, a = \{\}\) => ws\.showPaneHistory\(a\.pane \?\? null, a\.keys \?\? null\)\)/);
});

test("a pane joins the workspace before its content is built", () => {
  // A pane factory that looks up the workspace it lives in — mkio-history
  // does, to follow another pane — sees a detached element if the build
  // runs first, and reads it as "no such pane".
  const ws = new MkuiWorkspace();
  const order = [];
  ws._panes = new Map([["p", { type: "whatever" }]]);
  ws._paneEls = new Map();
  ws._pool = { appendChild: (el) => order.push(["pool", el.tagName]) };
  ws._buildPaneContent = () => { order.push(["build"]); return null; };
  const origCreate = document.createElement;
  document.createElement = (tag) => ({
    tagName: tag.toUpperCase(), _built: false, contentEl: { textContent: "" },
    setAttribute() {}, _build() { this._built = true; },
  });
  try {
    ws._ensurePaneEl("p");
  } finally {
    document.createElement = origCreate;
  }
  assert.deepEqual(order, [["pool", "MKUI-PANE"], ["build"]]);
});
