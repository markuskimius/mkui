// Run with: node --test tests/edit-routing.test.js
//
// Edit shortcut routing: the workspace's window keydown handler forwards
// Ctrl/Cmd+C, Ctrl/Cmd+A, Ctrl/Cmd+F, and Escape to the focused frame's active pane
// via its _editActions hook, with guards so text inputs and native text
// selections keep the browser behavior. Also covers the menubar's
// `shortcut` display field.
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
const { formatShortcut } = await import("../mkui/static/src/components/menubar.js");

const tabs = (...children) => ({ type: "tabs", active: 0, children });

function makeWorkspace({ frames, focusedId, paneActions = {} }) {
  const ws = new MkuiWorkspace();
  ws._frames = frames.map((f) => ({ id: f.id }));
  ws._frameEls = new Map(frames.map((f) => [f.id, {
    tree: f.tree,
    _activeTabGroup: f.activeTabGroup ?? null,
    getTree() { return this.tree; },
  }]));
  ws._focusedId = focusedId;
  ws._paneEls = new Map(Object.entries(paneActions).map(([id, actions]) => [
    id, { _editActions: actions },
  ]));
  return ws;
}

function keyEvent(overrides) {
  return {
    key: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
    target: { tagName: "DIV" },
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    ...overrides,
  };
}

// ── activePaneEl / editAction ───────────────────────────────────────

test("editAction reaches the focused frame's active tab", () => {
  const calls = [];
  const ws = makeWorkspace({
    frames: [
      { id: "f1", tree: tabs("table-a") },
      { id: "f2", tree: tabs("table-b", "table-c") },
    ],
    focusedId: "f2",
    paneActions: {
      "table-a": { copy: () => { calls.push("a"); return true; } },
      "table-b": { copy: () => { calls.push("b"); return true; } },
    },
  });
  assert.equal(ws.editAction("copy"), true);
  assert.deepEqual(calls, ["b"]);
});

test("editAction respects the frame's active tab group and tab index", () => {
  const calls = [];
  const tg = { type: "tabs", active: 1, children: ["x", "y"] };
  const ws = makeWorkspace({
    frames: [{ id: "f1", tree: tg, activeTabGroup: tg }],
    focusedId: "f1",
    paneActions: {
      x: { copy: () => { calls.push("x"); return true; } },
      y: { copy: () => { calls.push("y"); return true; } },
    },
  });
  ws.editAction("copy");
  assert.deepEqual(calls, ["y"]);
});

test("editAction is false with no hook, no pane, or no frame", () => {
  const ws = makeWorkspace({
    frames: [{ id: "f1", tree: tabs("plain") }],
    focusedId: "f1",
  });
  assert.equal(ws.editAction("copy"), false);
  ws._focusedId = "missing";
  assert.equal(ws.editAction("copy"), false);
});

test("editAction propagates a false return (nothing to do)", () => {
  const ws = makeWorkspace({
    frames: [{ id: "f1", tree: tabs("t") }],
    focusedId: "f1",
    paneActions: { t: { clearSelection: () => false } },
  });
  assert.equal(ws.editAction("clearSelection"), false);
});

// ── keydown routing ─────────────────────────────────────────────────

function routedWorkspace() {
  const calls = [];
  const ws = makeWorkspace({
    frames: [{ id: "f1", tree: tabs("t") }],
    focusedId: "f1",
    paneActions: {
      t: {
        copy: () => { calls.push("copy"); return true; },
        selectAll: () => { calls.push("selectAll"); return true; },
        clearSelection: () => { calls.push("clear"); return true; },
        find: () => { calls.push("find"); return true; },
      },
    },
  });
  return { ws, calls };
}

test("ctrl+C and cmd+C both route to copy and swallow the key", () => {
  const { ws, calls } = routedWorkspace();
  const e1 = keyEvent({ key: "c", ctrlKey: true });
  ws._onKeyDown(e1);
  const e2 = keyEvent({ key: "c", metaKey: true });
  ws._onKeyDown(e2);
  assert.deepEqual(calls, ["copy", "copy"]);
  assert.ok(e1.defaultPrevented && e2.defaultPrevented);
});

test("ctrl+A routes to selectAll, Escape to clearSelection", () => {
  const { ws, calls } = routedWorkspace();
  ws._onKeyDown(keyEvent({ key: "a", ctrlKey: true }));
  ws._onKeyDown(keyEvent({ key: "Escape" }));
  assert.deepEqual(calls, ["selectAll", "clear"]);
});

test("ctrl+F and cmd+F route to find and swallow the browser's find", () => {
  const { ws, calls } = routedWorkspace();
  const e1 = keyEvent({ key: "f", ctrlKey: true });
  ws._onKeyDown(e1);
  const e2 = keyEvent({ key: "F", metaKey: true });
  ws._onKeyDown(e2);
  assert.deepEqual(calls, ["find", "find"]);
  assert.ok(e1.defaultPrevented && e2.defaultPrevented);
  // A pane without the hook leaves the browser's find alone.
  const bare = makeWorkspace({
    frames: [{ id: "f1", tree: tabs("t") }], focusedId: "f1",
    paneActions: { t: { copy: () => true } },
  });
  const e3 = keyEvent({ key: "f", ctrlKey: true });
  bare._onKeyDown(e3);
  assert.ok(!e3.defaultPrevented);
});

test("text inputs keep the browser behavior", () => {
  const { ws, calls } = routedWorkspace();
  for (const tagName of ["INPUT", "TEXTAREA"]) {
    ws._onKeyDown(keyEvent({ key: "c", ctrlKey: true, target: { tagName } }));
    ws._onKeyDown(keyEvent({ key: "a", ctrlKey: true, target: { tagName } }));
    ws._onKeyDown(keyEvent({ key: "Escape", target: { tagName } }));
  }
  ws._onKeyDown(keyEvent({
    key: "c", ctrlKey: true, target: { tagName: "DIV", isContentEditable: true },
  }));
  assert.deepEqual(calls, []);
});

test("a native text selection wins over table copy", () => {
  const { ws, calls } = routedWorkspace();
  globalThis.window = { getSelection: () => ({ isCollapsed: false }) };
  try {
    const e = keyEvent({ key: "c", ctrlKey: true });
    ws._onKeyDown(e);
    assert.deepEqual(calls, []);
    assert.equal(e.defaultPrevented, false);
  } finally {
    delete globalThis.window;
  }
});

test("unhandled panes leave the event alone (no preventDefault)", () => {
  const ws = makeWorkspace({
    frames: [{ id: "f1", tree: tabs("plain") }],
    focusedId: "f1",
  });
  const e = keyEvent({ key: "c", ctrlKey: true });
  ws._onKeyDown(e);
  assert.equal(e.defaultPrevented, false);
});

test("shift or alt with the modifier is not an edit shortcut", () => {
  const { ws, calls } = routedWorkspace();
  ws._onKeyDown(keyEvent({ key: "c", ctrlKey: true, shiftKey: true }));
  ws._onKeyDown(keyEvent({ key: "a", ctrlKey: true, altKey: true }));
  assert.deepEqual(calls, []);
});

// ── menubar shortcut labels ─────────────────────────────────────────

test("formatShortcut renders mod as Ctrl off Apple platforms", () => {
  // node has no navigator.platform → non-Apple branch.
  assert.equal(formatShortcut("mod+C"), "Ctrl+C");
  assert.equal(formatShortcut("mod+A"), "Ctrl+A");
});

test("formatShortcut passes non-mod tokens through", () => {
  assert.equal(formatShortcut("Esc"), "Esc");
  assert.equal(formatShortcut("Alt+Shift+Left"), "Alt+Shift+Left");
});
