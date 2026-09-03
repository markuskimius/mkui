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
