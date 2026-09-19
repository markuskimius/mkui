// Run with: node --test tests/menu.test.js
//
// What a menu item's `disabled` / `showWhen` see and decide (lib/menu.js).
// The popups that act on it are tests/windows-menu.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { menuScope, itemFlags, visibleItems, itemStatePaths } from "../mkui/static/src/lib/menu.js";

const app = (state = {}) => ({ state: { get: () => state }, config: { app: { title: "Orders" } } });

test("menuScope: state, the app block, the focused pane, its selection, the open panes", () => {
  const ws = {
    focusInfo: () => ({ pane: { id: "orders", type: "mkio-table", title: "Orders" }, selection: { count: 2, focused: true } }),
    openPanes: () => [{ id: "orders", title: "Orders" }, { id: "detail", title: "Detail" }],
  };
  assert.deepEqual(menuScope(app({ n: 1 }), ws), {
    state: { n: 1 }, app: { title: "Orders" },
    pane: { id: "orders", type: "mkio-table", title: "Orders" }, selection: { count: 2, focused: true },
    panes: ["orders", "detail"],
  });
  assert.deepEqual(menuScope(null, null), { state: {}, app: {}, pane: null, selection: null, panes: [] });
  assert.deepEqual(menuScope(app(), { focusInfo: () => null, openPanes: () => [] }).pane, null);
});

test("itemFlags: booleans, expressions, and the tooltip of an item that is off", () => {
  const scope = { state: { auth: { role: "admin" }, dialog: { suppressed: { "orders.fill": "ok" } } }, selection: { count: 0 }, pane: null };
  assert.deepEqual(itemFlags({ label: "x" }, scope), { disabled: false, hidden: false, title: "" });
  assert.deepEqual(itemFlags({ disabled: true, disabledTitle: "No" }, scope), { disabled: true, hidden: false, title: "No" });
  assert.equal(itemFlags({ disabled: "(selection.count ?? 0) == 0" }, scope).disabled, true);
  assert.equal(itemFlags({ disabled: "(selection.count ?? 0) == 0" }, { selection: { count: 3 } }).disabled, false);
  assert.equal(itemFlags({ disabled: "pane.type != 'mkio-table'" }, scope).disabled, true, "no focused pane: NULL is not a table");
  assert.equal(itemFlags({ disabled: "state.dialog.suppressed['orders.fill'] == NULL" }, scope).disabled, false);
  assert.equal(itemFlags({ disabled: "state.dialog.suppressed['orders.fill'] == NULL" }, { state: { dialog: { suppressed: {} } } }).disabled, true);
  assert.equal(itemFlags({ showWhen: "state.auth.role == 'admin'" }, scope).hidden, false);
  assert.equal(itemFlags({ showWhen: "state.auth.role == 'admin'" }, { state: {} }).hidden, true);
  assert.equal(itemFlags({ showWhen: false }, scope).hidden, true);
  assert.equal(itemFlags({ disabled: false, disabledTitle: "unused" }, scope).title, "", "no tooltip while the item is on");
});

test("a flag that does not compile leaves the item enabled and shown", () => {
  const warn = console.warn; let warned = 0; console.warn = () => { warned++; };
  try {
    assert.deepEqual(itemFlags({ disabled: "1 +", showWhen: "((" }, {}), { disabled: false, hidden: false, title: "" });
  } finally { console.warn = warn; }
  assert.ok(warned >= 1);
});

test("visibleItems: hidden items go, and no separator is left leading, trailing or doubled", () => {
  const items = [
    { sep: true },
    { label: "A", showWhen: "state.a" },
    { sep: true },
    { label: "B", showWhen: "state.b" },
    { sep: true },
    { label: "C" },
    { sep: true },
    { label: "D", showWhen: false },
  ];
  const labels = (state) => visibleItems(items, { state }).map((r) => r.item.sep ? "—" : r.item.label);
  assert.deepEqual(labels({ a: 1, b: 1 }), ["A", "—", "B", "—", "C"]);
  assert.deepEqual(labels({ a: 1 }), ["A", "—", "C"]);
  assert.deepEqual(labels({}), ["C"]);
  assert.deepEqual(visibleItems(null, {}), []);
});

test("visibleItems: a submenu with nothing live is disabled, with nothing shown is gone", () => {
  const sub = (kids) => [{ label: "Sub", items: kids }];
  const scope = { state: { on: false } };
  assert.deepEqual(visibleItems(sub([{ label: "a", disabled: true }, { sep: true }, { label: "b", disabled: "!state.on" }]), scope).map((r) => r.disabled), [true]);
  assert.deepEqual(visibleItems(sub([{ label: "a", disabled: true }, { label: "b" }]), scope).map((r) => r.disabled), [false]);
  assert.deepEqual(visibleItems(sub([{ label: "a", showWhen: "state.on" }]), scope), []);
  assert.equal(visibleItems([{ label: "Empty", items: [] }], scope).length, 1, "an empty `items` is a leaf, as before");
});

test("itemStatePaths: what the flags read, submenus included", () => {
  const paths = itemStatePaths([
    { label: "a", disabled: "state.dialog.suppressed['orders.fill'] == NULL" },
    { label: "b", showWhen: "state.auth.role == 'admin'", disabled: true },
    { label: "s", items: [{ label: "c", disabled: "!state.mkio.connected && selection.count > 0" }] },
    { label: "t", disabledTitle: "state.not.read" },
  ]);
  assert.deepEqual([...paths].sort(), ["auth.role", "dialog.suppressed.orders.fill", "mkio.connected"]);
});
