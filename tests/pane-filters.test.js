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
