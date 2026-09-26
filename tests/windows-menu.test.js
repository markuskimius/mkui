// Run with: node --test tests/windows-menu.test.js
//
// Covers the dynamic Window-menu listing (workspace.openPanes + the
// menubar's `{ windows: true }` expansion) and pane renaming
// (workspace.renamePane). The components are browser custom elements, so
// stub the few globals their module scope needs — the methods under test
// touch no DOM.
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.HTMLElement = class {};
globalThis.customElements = { get: () => undefined, define: () => {} };

globalThis.document = {
  createElement(tag) {
    const el = {
      tagName: tag.toUpperCase(),
      value: "",
      style: {},
      _ev: {},
      addEventListener(name, fn) { (el._ev[name] ??= []).push(fn); },
      fire(name, ev = {}) {
        ev.stopPropagation ??= () => {};
        for (const fn of el._ev[name] ?? []) fn(ev);
      },
      focus() { el.focused = true; },
      select() { el.selected = true; },
    };
    return el;
  },
};

const { MkuiWorkspace } = await import("../mkui/static/src/components/workspace.js");
const { MkuiMenubar } = await import("../mkui/static/src/components/menubar.js");
const { MkuiFrame } = await import("../mkui/static/src/components/frame.js");

// Build a workspace with fake frame elements: each frame is
// { id, tree, noDock? } and gets a stub el exposing getTree/_renderInternal.
function makeWorkspace(frames, panes = {}) {
  const ws = new MkuiWorkspace();
  ws._panes = new Map(Object.entries(panes));
  ws._frames = frames.map(f => ({ id: f.id, noDock: f.noDock ?? false }));
  ws._frameEls = new Map(frames.map(f => [f.id, {
    tree: f.tree,
    renders: 0,
    getTree() { return this.tree; },
    _renderInternal() { this.renders++; },
  }]));
  return ws;
}

const tabs = (...children) => ({ type: "tabs", active: 0, children });

// ── openPanes ───────────────────────────────────────────────────────

test("openPanes lists panes in frame order with spec titles", () => {
  const ws = makeWorkspace(
    [
      { id: "f1", tree: tabs("explorer", "editor") },
      { id: "f2", tree: tabs("console") },
    ],
    { explorer: { title: "Explorer" }, console: { title: "Console" } },
  );
  assert.deepEqual(ws.openPanes(), [
    { id: "explorer", title: "Explorer" },
    { id: "editor", title: "editor" }, // no spec title → id fallback
    { id: "console", title: "Console" },
  ]);
});

test("openPanes walks split trees", () => {
  const ws = makeWorkspace([{
    id: "f1",
    tree: { type: "split", dir: "h", ratios: [0.5, 0.5],
            children: [tabs("a"), tabs("b", "c")] },
  }]);
  assert.deepEqual(ws.openPanes().map(p => p.id), ["a", "b", "c"]);
});

test("openPanes excludes noDock frames and frames without a tree", () => {
  const ws = makeWorkspace([
    { id: "dialog", tree: tabs("login"), noDock: true },
    { id: "empty", tree: null },
    { id: "f1", tree: tabs("editor") },
  ]);
  assert.deepEqual(ws.openPanes().map(p => p.id), ["editor"]);
});

test("openPanes is empty on an empty workspace", () => {
  const ws = makeWorkspace([]);
  assert.deepEqual(ws.openPanes(), []);
});

// ── renamePane ──────────────────────────────────────────────────────

test("renamePane updates the spec and re-renders only owning frames", () => {
  const ws = makeWorkspace(
    [
      { id: "f1", tree: tabs("editor") },
      { id: "f2", tree: tabs("console") },
    ],
    { editor: { title: "Editor" }, console: { title: "Console" } },
  );
  ws.renamePane("editor", "Scratch");
  assert.equal(ws.getPaneSpec("editor").title, "Scratch");
  assert.equal(ws._frameEls.get("f1").renders, 1);
  assert.equal(ws._frameEls.get("f2").renders, 0);
  assert.deepEqual(ws.openPanes().map(p => p.title), ["Scratch", "Console"]);
});

test("renamePane creates a spec for an unregistered pane id", () => {
  const ws = makeWorkspace([{ id: "f1", tree: tabs("mystery") }]);
  ws.renamePane("mystery", "Named");
  assert.equal(ws.getPaneSpec("mystery").title, "Named");
});

test("renamePane on a parked pane updates the spec without re-rendering", () => {
  const ws = makeWorkspace(
    [{ id: "f1", tree: tabs("editor") }],
    { parked: { title: "Parked" } },
  );
  ws.renamePane("parked", "Renamed");
  assert.equal(ws.getPaneSpec("parked").title, "Renamed");
  assert.equal(ws._frameEls.get("f1").renders, 0);
});

// ── menubar { windows: true } expansion ─────────────────────────────

test("expandItems replaces the windows marker with pane.show leaves", () => {
  const ws = makeWorkspace(
    [{ id: "f1", tree: tabs("explorer", "editor") }],
    { explorer: { title: "Explorer" } },
  );
  const mb = new MkuiMenubar();
  mb._app = { _element: { workspace: ws } };
  const out = mb._expandItems([
    { windows: true },
    { sep: true },
    { label: "Cascade", action: "window.cascade" },
  ]);
  assert.deepEqual(out, [
    { label: "Explorer", action: "pane.show", args: "explorer" },
    { label: "editor", action: "pane.show", args: "editor" },
    { sep: true },
    { label: "Cascade", action: "window.cascade" },
  ]);
});

test("expandItems yields no entries when nothing is open or no workspace", () => {
  const mb = new MkuiMenubar();
  mb._app = { _element: { workspace: makeWorkspace([]) } };
  assert.deepEqual(mb._expandItems([{ windows: true }]), []);
  mb._app = null;
  assert.deepEqual(mb._expandItems([{ windows: true }]), []);
});

test("expandItems replaces the frames marker with frame.show leaves, one per configured window", () => {
  const ws = makeWorkspace([]);
  ws._app = { config: { frames: [
    { id: "main", layout: tabs("a") },
    { id: "desk", title: "Order Desk", open: false, layout: tabs("b") },
    { layout: tabs("c") },                       // no id: nothing to show by
  ] } };
  const mb = new MkuiMenubar();
  mb._app = { _element: { workspace: ws } };
  assert.deepEqual(mb._expandItems([{ frames: true }, { sep: true }]), [
    { label: "main", action: "frame.show", args: "main" },
    { label: "Order Desk", action: "frame.show", args: "desk" },
    { sep: true },
  ], "open or not, titled or by id");
  mb._app = null;
  assert.deepEqual(mb._expandItems([{ frames: true }]), []);
});

test("expandItems passes ordinary items through untouched", () => {
  const mb = new MkuiMenubar();
  const items = [{ label: "Quit", action: "app.quit" }];
  assert.deepEqual(mb._expandItems(items), items);
});

test("expandItems only expands its own level, leaving submenus intact", () => {
  const ws = makeWorkspace([{ id: "f1", tree: tabs("a") }]);
  const mb = new MkuiMenubar();
  mb._app = { _element: { workspace: ws } };
  const sub = { label: "Open", items: [{ windows: true }] };
  // Top-level pass leaves the submenu untouched...
  assert.deepEqual(mb._expandItems([sub]), [sub]);
  // ...and expanding the submenu's own items (as _buildPopup does when it
  // opens) produces the pane leaves.
  assert.deepEqual(mb._expandItems(sub.items), [
    { label: "a", action: "pane.show", args: "a" },
  ]);
});

// ── _beginTabRename ─────────────────────────────────────────────────

// Frame with one tab bar holding `group`; returns handles to the fakes.
function makeRenameFixture(group, specs) {
  const tabs = group.children.map(() => {
    const tab = {
      labelEl: { offsetWidth: 50, style: {} },
      querySelector(sel) {
        if (sel === ".mkui-tab-label") return tab.labelEl;
        if (sel === ".mkui-tab-rename") return tab.input ?? null;
        return null;
      },
    };
    tab.labelEl.after = (n) => { tab.input = n; };
    return tab;
  });
  const bar = {
    _tabGroup: group,
    classList: { contains: (c) => c === "mkui-tabbar" },
    querySelectorAll: () => tabs,
  };
  const calls = [];
  const frame = new MkuiFrame();
  frame._bodyEl = { children: [bar] };
  frame._activeTabGroup = group; // keep _setActiveTabGroup a no-op
  // A real re-render rebuilds the chrome, discarding any rename input.
  frame._renderInternal = () => {
    calls.push(["render"]);
    for (const t of tabs) t.input = null;
  };
  frame._workspace = {
    _raiseFrame: () => calls.push(["raise"]),
    getPaneSpec: (id) => specs[id],
    renamePane: (id, title) => calls.push(["rename", id, title]),
  };
  return { frame, tabs, calls };
}

test("ctrl-click rename commits a new title on Enter", () => {
  const group = tabs("editor", "console");
  const { frame, tabs: tabEls, calls } = makeRenameFixture(group, {
    console: { title: "Console" },
  });
  frame._beginTabRename("console", group);
  const input = tabEls[1].input;
  assert.equal(input.value, "Console");
  assert.equal(input.focused, true);
  assert.equal(input.selected, true);
  assert.equal(tabEls[1].labelEl.style.display, "none");

  input.value = "  Logs ";
  input.fire("keydown", { key: "Enter" });
  assert.deepEqual(calls, [["raise"], ["rename", "console", "Logs"]]);

  // The later blur (from the re-render removing the input) is a no-op.
  input.fire("blur");
  assert.equal(calls.length, 2);
});

test("rename falls back to the pane id when there is no spec title", () => {
  const group = tabs("mystery");
  const { frame, tabs: tabEls } = makeRenameFixture(group, {});
  frame._beginTabRename("mystery", group);
  assert.equal(tabEls[0].input.value, "mystery");
});

test("Escape cancels the rename and restores the label", () => {
  const group = tabs("editor");
  const { frame, tabs: tabEls, calls } = makeRenameFixture(group, {
    editor: { title: "Editor" },
  });
  frame._beginTabRename("editor", group);
  const input = tabEls[0].input;
  input.value = "Changed";
  input.fire("keydown", { key: "Escape" });
  assert.deepEqual(calls, [["raise"], ["render"]]);
});

test("blur with an unchanged or empty value does not rename", () => {
  const group = tabs("editor");
  const { frame, tabs: tabEls, calls } = makeRenameFixture(group, {
    editor: { title: "Editor" },
  });
  frame._beginTabRename("editor", group);
  tabEls[0].input.fire("blur"); // unchanged value
  assert.deepEqual(calls, [["raise"], ["render"]]);

  frame._beginTabRename("editor", group);
  const input2 = tabEls[0].input;
  input2.value = "   ";
  input2.fire("keydown", { key: "Enter" });
  assert.deepEqual(calls.slice(2), [["raise"], ["render"]]);
});

test("a second rename attempt while one is active is a no-op", () => {
  const group = tabs("editor");
  const { frame, tabs: tabEls, calls } = makeRenameFixture(group, {
    editor: { title: "Editor" },
  });
  frame._beginTabRename("editor", group);
  const first = tabEls[0].input;
  frame._beginTabRename("editor", group);
  assert.equal(tabEls[0].input, first); // no replacement input
  assert.deepEqual(calls, [["raise"], ["raise"]]);
});

test("pointer events inside the rename input do not propagate to the tab", () => {
  const group = tabs("editor");
  const { frame, tabs: tabEls } = makeRenameFixture(group, {
    editor: { title: "Editor" },
  });
  frame._beginTabRename("editor", group);
  const input = tabEls[0].input;
  for (const name of ["pointerdown", "mousedown", "click", "dblclick", "contextmenu", "keydown"]) {
    let stopped = false;
    input.fire(name, { key: "x", stopPropagation: () => { stopped = true; } });
    assert.equal(stopped, true, `${name} should stopPropagation`);
  }
});

// ── showPane selects the tab and focuses its tab group ──────────────

test("showPane activates the tab and marks its group active", () => {
  const group = tabs("a", "b");
  const ws = makeWorkspace([{ id: "f1", tree: group }], { a: {}, b: {} });
  const el = ws._frameEls.get("f1");
  el.getAttribute = () => "f1";
  el.style = {};
  el.setAttribute = () => {};
  el.removeAttribute = () => {};
  ws.showPane("b");
  assert.equal(group.active, 1);
  assert.equal(el._activeTabGroup, group);
  assert.equal(el.renders, 1);
  assert.equal(ws._focusedId, "f1");
});

// ── closeFrame hands the focus on ───────────────────────────────────
// A closed frame cannot stay the focused one: `activePaneEl` would find
// nothing, and Ctrl/Cmd+F, the Edit menu and a dialog button's `edit.*`
// action would have no pane to act on until a frame was clicked.

test("closing the focused frame focuses the top-most one left", () => {
  const ws = makeWorkspace(
    [{ id: "f1", tree: tabs("a") }, { id: "f2", tree: tabs("b") }, { id: "dlg", tree: tabs("d"), noDock: true }],
    { a: { title: "A" }, b: { title: "B" }, d: { title: "D" } },
  );
  const attrs = {};
  for (const [id, el] of ws._frameEls) {
    Object.assign(el, { style: {}, bodyEl: { children: [] }, remove() {},
      setAttribute(k) { (attrs[id] ??= new Set()).add(k); }, removeAttribute(k) { attrs[id]?.delete(k); } });
  }
  ws._paneEls = new Map([["b", { dataset: { id: "b" } }]]);
  ws._focusedId = "dlg";
  ws.closeFrame("dlg");
  assert.equal(ws._focusedId, "f2");
  assert.ok(attrs.f2.has("data-focused"));
  assert.equal(ws.activePaneEl(), ws._paneEls.get("b"));

  ws.closeFrame("f1");
  assert.equal(ws._focusedId, "f2", "closing an unfocused frame moves nothing");
  ws.closeFrame("f2");
  assert.equal(ws._focusedId, null);
});

// ── The modal scrim ─────────────────────────────────────────────────
// A `modal` frame puts `.mkui-scrim` just under itself — frames take two
// z-steps each so it fits — and stamps `[modal]` on the app root, which
// stills the menubar and statusbar (CSS). Closing the frame takes both away.

test("a modal frame gets a scrim right under it; closing it removes the scrim", () => {
  const ws = makeWorkspace(
    [{ id: "f1", tree: tabs("a") }, { id: "f2", tree: tabs("b") }, { id: "dlg", tree: tabs("d"), noDock: true }],
    { a: {}, b: {}, d: {} },
  );
  ws._frames[2].stayOnTop = true;
  ws._frames[2].modal = true;
  for (const el of ws._frameEls.values()) {
    Object.assign(el, { style: {}, bodyEl: { children: [] }, remove() {}, setAttribute() {}, removeAttribute() {} });
  }
  const rootAttrs = new Set();
  const appended = [];
  ws.closest = () => ({ setAttribute: (k) => rootAttrs.add(k), removeAttribute: (k) => rootAttrs.delete(k) });
  ws.appendChild = (n) => { appended.push(n); n.remove = () => appended.splice(appended.indexOf(n), 1); return n; };

  ws._applyZOrder();
  const z = (id) => ws._frameEls.get(id).style.zIndex;
  assert.deepEqual([z("f1"), z("f2"), z("dlg")], [10, 12, 14]);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].className, "mkui-scrim");
  assert.equal(appended[0].style.zIndex, 13, "between the dialog and everything under it");
  assert.ok(rootAttrs.has("modal"));

  ws._applyZOrder();
  assert.equal(appended.length, 1, "one scrim, reused");

  ws.closeFrame("dlg");
  assert.equal(appended.length, 0);
  assert.equal(rootAttrs.has("modal"), false);
});

// ── focusInfo: what a menu's expressions know about the focus ────────

test("focusInfo names the focused pane and sums up its selection", () => {
  const ws = makeWorkspace(
    [{ id: "f1", tree: tabs("orders", "notes") }],
    { orders: { title: "Orders", type: "mkio-table" }, notes: { title: "Notes" } },
  );
  assert.equal(ws.focusInfo(), null, "nothing focused");
  ws._focusedId = "f1";
  ws._paneEls = new Map([
    ["orders", { getAttribute: () => "orders", _editActions: { copy() {}, find() {}, redo: null }, _select: { get: () => ({ keys: ["1", "2"], focus: { id: 1 } }) } }],
    ["notes", { getAttribute: () => "notes" }],
  ]);
  assert.deepEqual(ws.focusInfo(), { pane: { id: "orders", type: "mkio-table", title: "Orders", can: { copy: true, find: true } }, selection: { count: 2, focused: true } });
  ws._frameEls.get("f1").tree.active = 1;
  assert.deepEqual(ws.focusInfo(), { pane: { id: "notes", type: null, title: "Notes", can: {} }, selection: null });
});
