// Run with: node --test tests/sloppy-focus.test.js
//
// Sloppy focus: lib/wm.js (which keys and clicks do what, the z-order a
// lower makes, the Window menu's items, the per-user preferences) and the
// workspace acting on it — focus following the pointer without raising,
// the title bar's still click, the modifier clicks and drags, the keys,
// the virtual cursor, the nudge.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  NUDGE, CURVES, Mover, wmKey, takesFromField, realMove, clickOp, plainPress, stillClick, lowerOrder,
  wmMenuItems, readWmPrefs, writeWmPrefs, isApple, WM_PREFIX, installWm,
} from "../mkui/static/src/lib/wm.js";

globalThis.HTMLElement = class {};
globalThis.customElements = { get: () => undefined, define: () => {} };
// The window's listeners, by type, capture ones included.
const winEv = {};
globalThis.window = {
  innerWidth: 1400, innerHeight: 900,
  addEventListener(name, fn) { (winEv[name] ??= new Set()).add(fn); },
  removeEventListener(name, fn) { winEv[name]?.delete(fn); },
};
const fireWin = (name, ev) => { for (const fn of [...(winEv[name] ?? [])]) fn({ type: name, ...ev }); };
// Enough DOM for the virtual cursor: an element, its svg, the root's attribute.
const stubEl = () => {
  const el = {
    style: {}, attrs: {}, children: [], parent: null,
    addEventListener() {},
    setAttribute(k, v) { el.attrs[k] = v; },
    removeAttribute(k) { delete el.attrs[k]; },
    appendChild(c) { c.parent = el; el.children.push(c); return c; },
    remove() { if (el.parent) el.parent.children = el.parent.children.filter((c) => c !== el); el.parent = null; },
  };
  return el;
};
globalThis.document = {
  activeElement: null,
  createElement: () => stubEl(),
  createElementNS: () => stubEl(),
  documentElement: stubEl(),
  body: stubEl(),
  addEventListener() {},
  removeEventListener() {},
};

const { MkuiWorkspace } = await import("../mkui/static/src/components/workspace.js");
const { MkuiFrame } = await import("../mkui/static/src/components/frame.js");
const { MkuiMenubar } = await import("../mkui/static/src/components/menubar.js");
const { State } = await import("../mkui/static/src/core.js");

// ── lib/wm.js ───────────────────────────────────────────────────────

test("wmKey: alt/option moves the cursor, shift added the window; matched on the physical key", () => {
  assert.deepEqual(wmKey({ altKey: true, code: "KeyN", key: "˜" }), { op: "front" }, "option+N is a dead key on a Mac");
  assert.deepEqual(wmKey({ altKey: true, code: "KeyP", key: "π" }), { op: "back" });
  for (const [code, dir] of [["KeyH", [-1, 0]], ["ArrowLeft", [-1, 0]], ["KeyJ", [0, 1]], ["ArrowDown", [0, 1]],
    ["KeyK", [0, -1]], ["ArrowUp", [0, -1]], ["KeyL", [1, 0]], ["ArrowRight", [1, 0]]]) {
    assert.deepEqual(wmKey({ altKey: true, code }), { op: "point", code, dir }, code);
    assert.deepEqual(wmKey({ altKey: true, shiftKey: true, code }), { op: "move", code, dir }, `shift+${code}`);
  }
  assert.deepEqual(wmKey({ altKey: true, key: "ArrowUp" }), { op: "point", code: "ArrowUp", dir: [0, -1] }, "no code: an arrow's key will do");
  assert.equal(wmKey({ altKey: true, key: "n" }), null, "no code: a letter's key is not trusted");
  assert.equal(wmKey({ altKey: true, shiftKey: true, code: "KeyN" }), null, "shift+N is nothing");
  for (const mods of [{}, { ctrlKey: true }, { metaKey: true }])
    assert.equal(wmKey({ altKey: !!Object.keys(mods).length, ...mods, code: "KeyH" }), null, JSON.stringify(mods));
  assert.equal(wmKey({ altKey: true, code: "KeyX" }), null);
});

test("takesFromField: alt+H/J/K/L off a Mac, never the arrows", () => {
  const k = (code, shiftKey = false) => wmKey({ altKey: true, shiftKey, code });
  for (const c of ["KeyH", "KeyJ", "KeyK", "KeyL"]) {
    assert.equal(takesFromField(k(c)), true, c);
    assert.equal(takesFromField(k(c, true)), true, `shift+${c}`);
    assert.equal(takesFromField(k(c), true), false, `${c} on a Mac types a character`);
  }
  assert.equal(takesFromField(k("ArrowLeft")), false, "a word jump");
  assert.equal(takesFromField(k("KeyN")), false);
  assert.equal(takesFromField(null), false);
});

test("Mover: a first step at once, then after the delay a glide that speeds up", () => {
  const m = new Mover();
  assert.equal(m.active, false);
  assert.deepEqual(m.press("point", "KeyL", [1, 0], 1000), { dx: NUDGE, dy: 0 });
  assert.equal(m.press("point", "KeyL", [1, 0], 1030), null, "the OS's key repeat is not a step");
  assert.deepEqual(m.tick(1200), { dx: 0, dy: 0 }, "still in the delay");
  const c = CURVES.point;
  let d = m.tick(1000 + c.delay + 100);                 // 100 ms of glide, from the delay on
  assert.ok(Math.abs(d.dx - (c.from + (c.to - c.from) * 0.1) * 0.1) < 1e-9, "only the time past the delay counts");
  d = m.tick(1000 + c.delay + c.ramp + 100);
  assert.ok(Math.abs(d.dx - c.to * (c.ramp / 1000)) < 1e-9, "at full speed once the ramp is over");
  assert.ok(CURVES.move.to < CURVES.point.to, "a window glides slower than the cursor");
});

test("Mover: diagonals as fast as a straight line; opposite keys cancel; release, rekind, clear", () => {
  const m = new Mover();
  m.press("point", "KeyL", [1, 0], 0);
  assert.deepEqual(m.press("point", "KeyJ", [0, 1], 10), { dx: 0, dy: NUDGE }, "a second key steps too");
  m.tick(CURVES.point.delay);
  const d = m.tick(CURVES.point.delay + 100);
  assert.ok(Math.abs(Math.hypot(d.dx, d.dy) - CURVES.point.from * 0.1 - (CURVES.point.to - CURVES.point.from) * 0.01) < 1e-9);
  assert.ok(Math.abs(d.dx - d.dy) < 1e-9, "down-right");
  m.press("point", "KeyH", [-1, 0], 400);
  m.release("KeyJ");
  assert.deepEqual(m.tick(500), { dx: 0, dy: 0 }, "left and right cancel");
  m.rekind("move", 600);
  assert.equal(m.kind, "move");
  assert.deepEqual(m.tick(700), { dx: 0, dy: 0 }, "the other thing's curve starts over, its delay first");
  assert.deepEqual(m.press("point", "KeyK", [0, -1], 800), { dx: 0, dy: -NUDGE }, "a press of the other kind starts afresh");
  assert.deepEqual([...m.held.keys()], ["KeyK"]);
  m.release("KeyK");
  assert.equal(m.active, false);
  assert.equal(m.kind, null);
  m.press("move", "KeyL", [1, 0], 900);
  m.clear();
  assert.equal(m.active, false);
  assert.deepEqual(m.tick(5000), { dx: 0, dy: 0 });
});

test("realMove: presses and wheels always, a move only if it moved", () => {
  const at = { screenX: 10, screenY: 20 };
  assert.equal(realMove({ type: "pointerdown" }, at), true);
  assert.equal(realMove({ type: "wheel" }, at), true);
  assert.equal(realMove({ type: "pointermove", movementX: 0, movementY: 0, screenX: 10, screenY: 20 }, at), false, "the page changed under a still pointer");
  assert.equal(realMove({ type: "pointermove", movementX: 1, movementY: 0, screenX: 10, screenY: 20 }, at), true);
  assert.equal(realMove({ type: "pointermove", movementX: 0, movementY: 0, screenX: 11, screenY: 20 }, at), true);
  assert.equal(realMove({ type: "pointermove", movementX: 0, movementY: 0, screenX: 11, screenY: 20 }, null), false);
});

test("clickOp: the windowClick modifier raises, shift added lowers", () => {
  const press = (mods) => ({ button: 0, ...mods });
  assert.deepEqual(clickOp(press({ altKey: true })), { op: "raise" });
  assert.deepEqual(clickOp(press({ altKey: true, shiftKey: true })), { op: "lower" });
  assert.equal(clickOp(press({ altKey: true, ctrlKey: true })), null, "alt mode: ctrl+alt is not it");
  assert.equal(clickOp(press({ altKey: true }), "alt", false) != null, true);
  assert.equal(clickOp({ button: 2, altKey: true }), null, "primary button only");
  assert.equal(clickOp(press({ altKey: true, metaKey: true })), null);
  assert.equal(clickOp(press({})), null);

  assert.deepEqual(clickOp(press({ altKey: true, ctrlKey: true }), "ctrl+alt"), { op: "raise" });
  assert.deepEqual(clickOp(press({ altKey: true, ctrlKey: true, shiftKey: true }), "ctrl+alt"), { op: "lower" });
  assert.equal(clickOp(press({ altKey: true }), "ctrl+alt"), null, "ctrl+alt mode: alt alone is not it");

  // Apple platforms: always option (ctrl-click is a right-click there).
  assert.deepEqual(clickOp(press({ altKey: true }), "ctrl+alt", true), { op: "raise" });
  assert.equal(clickOp(press({ altKey: true, ctrlKey: true }), "ctrl+alt", true), null);
});

test("plainPress and stillClick", () => {
  assert.equal(plainPress({ button: 0 }), true);
  for (const m of ["altKey", "ctrlKey", "metaKey", "shiftKey"]) assert.equal(plainPress({ button: 0, [m]: true }), false, m);
  assert.equal(plainPress({ button: 1 }), false);
  assert.equal(stillClick({ x: 3, y: 4 }, { x: 3, y: 4 }), true);
  assert.equal(stillClick({ x: 3, y: 4 }, { x: 4, y: 4 }), false, "a pixel is a drag");
  assert.equal(stillClick(null, { x: 0, y: 0 }), false);
});

test("lowerOrder: the bottom of the frame's own band; a modal stays", () => {
  const f = (id, o = {}) => ({ id, ...o });
  const frames = [f("a"), f("b"), f("c"), f("d", { stayOnTop: true }), f("e", { stayOnTop: true })];
  assert.deepEqual(lowerOrder(frames, "c").map((x) => x.id), ["c", "a", "b", "d", "e"]);
  assert.deepEqual(lowerOrder(frames, "e").map((x) => x.id), ["a", "b", "c", "e", "d"], "under the other on-top frames, over the normal ones");
  assert.equal(lowerOrder(frames, "a"), null, "already at the bottom");
  assert.equal(lowerOrder(frames, "d"), null, "already the bottom of its band");
  assert.equal(lowerOrder([f("a"), f("m", { stayOnTop: true, modal: true })], "m"), null);
  assert.equal(lowerOrder(frames, "zz"), null);
  assert.deepEqual(lowerOrder([f("a"), f("t", { stayOnTop: true }), f("b")], "b").map((x) => x.id), ["b", "a", "t"],
    "a normal frame pushed after an on-top one still goes first");
});

test("wmMenuItems: shift offers it, on keeps it, the ctrl+alt switch needs both and no Mac", () => {
  assert.deepEqual(wmMenuItems({}), []);
  assert.deepEqual(wmMenuItems({ shift: true }), [
    { sep: true }, { label: "Sloppy Focus", action: "focus.sloppy", checked: false },
  ]);
  assert.deepEqual(wmMenuItems({ sloppy: true }), [
    { sep: true }, { label: "Sloppy Focus", action: "focus.sloppy", checked: true },
  ], "on: shown without shift, no ctrl+alt switch");
  assert.deepEqual(wmMenuItems({ sloppy: true, shift: true }).at(-1),
    { label: "Raise with Ctrl+Alt-click", action: "focus.windowClick", args: "ctrl+alt", checked: false });
  assert.deepEqual(wmMenuItems({ sloppy: true, shift: true, windowClick: "ctrl+alt" }).at(-1),
    { label: "Raise with Ctrl+Alt-click", action: "focus.windowClick", args: "alt", checked: true }, "ticked; a click turns it back");
  assert.equal(wmMenuItems({ sloppy: true, shift: true, apple: true }).length, 2, "never on a Mac");
});

test("isApple reads the platform", () => {
  assert.equal(isApple({ platform: "MacIntel" }), true);
  assert.equal(isApple({ platform: "Win32" }), false);
  assert.equal(isApple(null), false);
});

function memStore() {
  const m = new Map();
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}

test("prefs: per user, merged, validated; blocked storage reads as nothing chosen", () => {
  const s = memStore();
  assert.deepEqual(readWmPrefs(s, ""), {});
  writeWmPrefs(s, "", { sloppyFocus: true });
  writeWmPrefs(s, "", { windowClick: "ctrl+alt" });
  assert.deepEqual(readWmPrefs(s, ""), { sloppyFocus: true, windowClick: "ctrl+alt" }, "a write merges");
  assert.deepEqual(readWmPrefs(s, "ann"), {}, "another user has chosen nothing");
  writeWmPrefs(s, "ann", { sloppyFocus: false });
  assert.deepEqual(readWmPrefs(s, "ann"), { sloppyFocus: false });
  assert.ok(s.m.has(`${WM_PREFIX}:ann`) && s.m.has(WM_PREFIX));
  s.setItem(WM_PREFIX, JSON.stringify({ sloppyFocus: "yes", windowClick: "super" }));
  assert.deepEqual(readWmPrefs(s, ""), {}, "bad values are not choices");
  s.setItem(WM_PREFIX, "{not json");
  assert.deepEqual(readWmPrefs(s, ""), {});
  const blocked = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } };
  assert.deepEqual(readWmPrefs(blocked, ""), {});
  assert.doesNotThrow(() => writeWmPrefs(blocked, "", { sloppyFocus: true }));
  assert.deepEqual(readWmPrefs(null), {});
});

// ── the workspace ───────────────────────────────────────────────────

// A frame element stub: `contains` by walking `parentElement`.
function frameEl(ws, id) {
  const el = {
    id, style: {}, attrs: {}, parentElement: ws, isConnected: true, _frame: true,
    getAttribute(k) { return k === "data-id" ? id : this.attrs[k] ?? null; },
    setAttribute(k, v) { this.attrs[k] = v; },
    removeAttribute(k) { delete this.attrs[k]; },
    contains(n) { for (let x = n; x; x = x.parentElement) if (x === el) return true; return false; },
    closest(sel) { return sel === "mkui-frame" ? el : null; },
  };
  return el;
}
// A node inside `parent` carrying classes `cls`; closest() walks up by
// class, or to the frame for "mkui-frame".
function node(parent, cls = [], extra = {}) {
  const n = {
    parentElement: parent, tagName: "DIV", _cls: cls, ...extra,
    closest(sel) {
      const names = sel.split(",").map((x) => x.trim());
      for (let x = n; x; x = x.parentElement) {
        if (names.includes("mkui-frame") && x._frame) return x;
        if (x._cls && names.some((nm) => nm.startsWith(".") && x._cls.includes(nm.slice(1)))) return x;
      }
      return null;
    },
  };
  return n;
}

function makeWs(ids = ["a", "b", "c"], { w = 1000, h = 800 } = {}) {
  const ws = new MkuiWorkspace();
  ws._isWs = true;
  Object.defineProperty(ws, "clientWidth", { value: w });
  Object.defineProperty(ws, "clientHeight", { value: h });
  const state = new Map();
  ws._app = { state: { set: (k, v) => state.set(k, v) }, _element: { _menubar: {} } };
  ws._frames = ids.map((id, i) => ({ id, x: 0.1 * i, y: 0.1, w: 0.3, h: 0.3 }));
  ws._frameEls = new Map(ids.map((id) => [id, frameEl(ws, id)]));
  ws._focusedId = ids.at(-1);
  ws._applyScrim = () => {};
  ws._applyZOrder();
  return { ws, state, el: (id) => ws._frameEls.get(id), order: () => ws._frames.map((f) => f.id) };
}

test("setters mirror into state; a bad windowClick warns and is alt", (t) => {
  const { ws, state } = makeWs();
  ws.setSloppyFocus(true);
  assert.equal(ws.sloppyFocus(), true);
  assert.equal(state.get("focus.sloppy"), true);
  ws.setWindowClick("ctrl+alt");
  assert.equal(state.get("focus.windowClick"), "ctrl+alt");
  const warn = t.mock.method(console, "warn", () => {});
  ws.setWindowClick("super");
  assert.equal(ws.windowClick(), "alt");
  assert.equal(warn.mock.callCount(), 1);
});

test("the pointer focuses the frame it enters without raising it; off, it does nothing", () => {
  const { ws, el, order } = makeWs();
  const move = (id, extra = {}) => ws._onPointerMove({ clientX: 5, clientY: 6, buttons: 0, target: node(el(id)), ...extra });
  move("a");
  assert.equal(ws._focusedId, "c", "off: hover changes nothing");
  ws.setSloppyFocus(true);
  move("a");
  assert.equal(ws._focusedId, "a");
  assert.ok("data-focused" in el("a").attrs && !("data-focused" in el("c").attrs));
  assert.deepEqual(order(), ["a", "b", "c"], "not raised");
  move("b", { target: { closest: () => null } });
  assert.equal(ws._focusedId, "a", "empty workspace keeps the focus");
  move("b", { buttons: 1 });
  assert.equal(ws._focusedId, "a", "a held button (a drag) holds it");
  ws._app._element._menubar._rootAnchor = {};
  move("b");
  assert.equal(ws._focusedId, "a", "an open menu holds it");
  ws._app._element._menubar._rootAnchor = null;
  ws._frames[1].modal = true;
  move("b");
  assert.equal(ws._focusedId, "a", "a modal holds it");
  ws._frames[1].modal = false;
  move("b");
  assert.equal(ws._focusedId, "b");
});

test("focus moving takes the keyboard along, leaving a field being typed in alone", () => {
  const { ws, el } = makeWs();
  ws.setSloppyFocus(true);
  const focused = [];
  const inA = node(el("a"), [], { isConnected: true, focus: () => focused.push("a") });
  el("a")._lastFocus = inA;
  const inC = node(el("c"), [], { blurred: 0, blur() { this.blurred++; } });
  document.activeElement = inC;
  ws._focusFrame("a");
  assert.deepEqual(focused, ["a"], "a gets back what it had focused");
  ws._focusFrame("b");
  assert.equal(inC.blurred, 1, "nothing to restore in b: c's element lets go");
  document.activeElement = node(el("c"), [], { tagName: "INPUT", blur() { assert.fail("typing keeps its field"); } });
  ws._focusFrame("a");
  assert.equal(ws._focusedId, "a");
  document.activeElement = null;
  ws._onFocusIn({ target: inC });
  assert.equal(el("c")._lastFocus, inC, "focusin records a frame's element");
});

test("a plain press focuses without raising under sloppy focus, raises without it", () => {
  const { ws, el, order } = makeWs();
  ws._pressFrame(el("a"));
  assert.deepEqual(order(), ["b", "c", "a"]);
  ws.setSloppyFocus(true);
  ws._pressFrame(el("b"));
  assert.equal(ws._focusedId, "b");
  assert.deepEqual(order(), ["b", "c", "a"]);
});

test("the title bar raises on a still click only", () => {
  const { ws, el, order } = makeWs();
  ws.setSloppyFocus(true);
  const bar = node(el("a"), ["mkui-tabbar-top"]);
  const tab = node(node(bar, ["mkui-tabs"]), ["mkui-tab"]);
  const press = (target, x = 10, y = 10, mods = {}) => ws._framePointerDown({ button: 0, clientX: x, clientY: y, target, ...mods }, el("a"));

  press(tab);
  fireWin("pointerup", { clientX: 12, clientY: 10 });
  assert.deepEqual(order(), ["a", "b", "c"], "moved between press and release: a drag, not raised");
  press(tab);
  fireWin("pointerup", { clientX: 10, clientY: 10 });
  assert.deepEqual(order(), ["b", "c", "a"], "a still click on a tab raises");

  ws._raiseFrame(el("b")); ws._raiseFrame(el("c"));
  press(bar);
  fireWin("pointercancel", {});
  fireWin("pointerup", { clientX: 10, clientY: 10 });
  assert.deepEqual(order(), ["a", "b", "c"], "a cancelled press never raises");
  press(bar);
  fireWin("pointerup", { clientX: 10, clientY: 10 });
  assert.deepEqual(order(), ["b", "c", "a"], "the drag strip raises too");

  ws._raiseFrame(el("b")); ws._raiseFrame(el("c"));
  for (const t of [node(node(bar, ["mkui-frame-actions"]), ["mkui-frame-btn"]), node(bar, ["mkui-tab-scroll"]), node(el("a"), ["mkui-pane"])]) {
    press(t);
    fireWin("pointerup", { clientX: 10, clientY: 10 });
  }
  assert.deepEqual(order(), ["a", "b", "c"], "buttons, scroll arrows and content are not the title bar");
  press(tab, 10, 10, { ctrlKey: true });
  fireWin("pointerup", { clientX: 10, clientY: 10 });
  assert.deepEqual(order(), ["a", "b", "c"], "a modified click is not a plain one");
  assert.equal(winEv.pointerup.size, 0, "no listener left behind");
});

// The workspace's move needs its rect and the snap lines; none here.
function movable(ws) {
  ws.getBoundingClientRect = () => ({ left: 0, top: 0 });
  ws._getSnapLines = () => ({ vLines: [], hLines: [] });
  return ws;
}

test("an alt press is the window's: released in place it raises (shift: lowers), dragged it moves", async () => {
  const { ws, el, order } = makeWs();
  movable(ws);
  let stopped = 0, prevented = 0;
  const ev = (mods, x = 100, y = 100) => ({ button: 0, clientX: x, clientY: y, target: node(el("a")),
    preventDefault() { prevented++; }, stopPropagation() { stopped++; }, ...mods });
  const release = async (x = 100, y = 100) => { fireWin("pointerup", { clientX: x, clientY: y }); await new Promise((r) => setTimeout(r, 0)); };

  ws._framePointerDown(ev({ altKey: true }), el("a"));
  assert.deepEqual(order(), ["a", "b", "c"], "off: nothing");
  assert.equal(stopped, 0);
  ws.setSloppyFocus(true);

  ws._framePointerDown(ev({ altKey: true }), el("a"));
  assert.deepEqual(order(), ["a", "b", "c"], "not raised on the press");
  assert.equal(ws._focusedId, "a", "focused, though");
  assert.equal(stopped, 1, "the press goes no further");
  assert.equal(prevented, 1, "and its mouse events are held back");
  assert.equal(winEv.click?.size, 1, "nor does the click it makes");
  let clickStopped = false;
  fireWin("click", { preventDefault() {}, stopPropagation() { clickStopped = true; } });
  assert.ok(clickStopped);
  await release();
  assert.deepEqual(order(), ["b", "c", "a"], "released in place: raised");
  assert.equal(winEv.click.size, 0, "the click is the content's again");

  ws._framePointerDown(ev({ altKey: true, shiftKey: true }), el("a"));
  await release();
  assert.deepEqual(order(), ["a", "b", "c"], "shift: lowered");

  // Dragged: moved where it is, not raised.
  const spec = ws._frames.find((f) => f.id === "a");
  const x0 = spec.x * 1000, y0 = spec.y * 800;
  ws._framePointerDown(ev({ altKey: true }), el("a"));
  fireWin("pointermove", { clientX: 130, clientY: 120 });
  await release(130, 120);
  assert.deepEqual(order(), ["a", "b", "c"], "a drag doesn't raise");
  assert.ok(Math.abs(spec.x * 1000 - (x0 + 30)) < 1e-9 && Math.abs(spec.y * 800 - (y0 + 20)) < 1e-9, "moved by the drag");
  assert.equal(el("a").style.left, `${Math.round(x0 + 30)}px`);
  ws._framePointerDown(ev({ altKey: true, shiftKey: true }), el("a"));
  fireWin("pointermove", { clientX: 110, clientY: 100 });
  await release(110, 100);
  assert.ok(Math.abs(spec.x * 1000 - (x0 + 40)) < 1e-9, "shift+alt drags too");
  assert.deepEqual(order(), ["a", "b", "c"]);
  ws._framePointerDown(ev({ altKey: true }), el("a"));
  fireWin("pointercancel", {});
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(order(), ["a", "b", "c"], "a cancelled press does nothing");
  for (const t of ["pointermove", "pointerup", "pointercancel", "click"]) assert.equal(winEv[t]?.size ?? 0, 0, `no ${t} listener left`);

  ws.setWindowClick("ctrl+alt");
  stopped = 0;
  ws._framePointerDown(ev({ altKey: true }), el("b"));
  assert.equal(stopped, 0, "ctrl+alt mode: an alt press is the content's");
  ws._framePointerDown(ev({ altKey: true, ctrlKey: true }), el("b"));
  await release();
  assert.deepEqual(order(), ["a", "c", "b"]);
  assert.equal(stopped, 1);
});

test("a lower hands the focus to the frame now under the pointer", () => {
  const { ws, el, order } = makeWs();
  ws.setSloppyFocus(true);
  ws._pointer = { x: 50, y: 50 };
  document.elementFromPoint = () => node(el("b"));
  ws._lowerFrame(el("c"));
  assert.deepEqual(order(), ["c", "a", "b"]);
  assert.equal(ws._focusedId, "b");
  delete document.elementFromPoint;
});

const keyEv = (code, extra = {}) => ({ type: "keydown", altKey: true, code, key: code, target: null,
  preventDefault() { keyEv.prevented++; }, stopPropagation() {}, ...extra });
keyEv.prevented = 0;

test("keys: alt+N/P raise and lower; alt+shift+H/J/K/L and arrows move the focused frame", () => {
  const { ws, order } = makeWs();
  const key = (code, extra) => ws._onWmKey(keyEv(code, extra));
  const before = keyEv.prevented;
  key("KeyP");
  assert.deepEqual(order(), ["a", "b", "c"], "off: nothing");
  assert.equal(keyEv.prevented, before);
  ws.setSloppyFocus(true);
  ws._focusFrame("a");
  key("KeyN");
  assert.deepEqual(order(), ["b", "c", "a"]);
  key("KeyP");
  assert.deepEqual(order(), ["a", "b", "c"]);
  const spec = ws._frames.find((f) => f.id === "a");
  const x0 = spec.x * 1000, y0 = spec.y * 800;
  // Each a fresh press (released between): one 5 px step apiece.
  for (const code of ["KeyL", "ArrowRight", "KeyJ", "KeyK", "KeyK", "ArrowUp"]) {
    key(code, { shiftKey: true });
    ws._onWmKeyUp({ altKey: true, shiftKey: true, code, key: code });
  }
  assert.ok(Math.abs(spec.x * 1000 - (x0 + 10)) < 1e-9, "right twice");
  assert.ok(Math.abs(spec.y * 800 - (y0 - 10)) < 1e-9, "down once, up three times");
  key("KeyL", { shiftKey: true });
  key("KeyL", { shiftKey: true, repeat: true });
  assert.ok(Math.abs(spec.x * 1000 - (x0 + 15)) < 1e-9, "a repeat is not a step: the glide is");
  ws._onWmKeyUp({ altKey: false, code: "AltLeft", key: "Alt" });
  assert.equal(ws._mover.active, false, "alt let go ends it");
  assert.equal(ws._vcOn, false, "a window move shows no cursor");
});

test("keys: text fields keep the arrows, and the letters on a Mac", (t) => {
  const { ws } = makeWs();
  ws.setSloppyFocus(true);
  ws._pointer = { x: 100, y: 100 };
  const before = keyEv.prevented;
  const input = { tagName: "INPUT" };
  ws._onWmKey(keyEv("ArrowLeft", { target: input }));
  ws._onWmKey(keyEv("KeyN", { target: { tagName: "TEXTAREA" } }));
  assert.equal(keyEv.prevented, before, "a field keeps these");
  const had = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  t.after(() => { if (had) Object.defineProperty(globalThis, "navigator", had); else delete globalThis.navigator; });
  Object.defineProperty(globalThis, "navigator", { value: { platform: "Linux x86_64" }, configurable: true, writable: true });
  ws._onWmKey(keyEv("KeyH", { target: input }));
  assert.equal(keyEv.prevented, before + 1, "off a Mac, alt+H types nothing: the cursor takes it");
  ws._hideVCursor();
  Object.defineProperty(globalThis, "navigator", { value: { platform: "MacIntel" }, configurable: true, writable: true });
  ws._onWmKey(keyEv("KeyJ", { target: input }));
  assert.equal(keyEv.prevented, before + 1, "on a Mac option+J types ∆");
  ws._onWmKey(keyEv("KeyX"));
  assert.equal(keyEv.prevented, before + 1, "an unbound key passes");
});

test("the virtual cursor: shown by alt+H/J/K/L where the pointer was, it focuses what it crosses", () => {
  const { ws, el, order } = makeWs();
  ws.setSloppyFocus(true);
  ws._onTrackPointer({ type: "pointermove", clientX: 100, clientY: 100, screenX: 300, screenY: 400, movementX: 3 });
  const hits = { a: [0, 150], b: [150, 300] };      // x ranges; beyond, empty workspace
  document.elementFromPoint = (x) => {
    for (const [id, [lo, hi]] of Object.entries(hits)) if (x >= lo && x < hi) return { closest: () => el(id) };
    return { closest: () => null };
  };
  ws._focusFrame("a");
  ws._onWmKey(keyEv("KeyL"));
  assert.equal(ws._vcOn, true);
  assert.deepEqual(ws._pointer, { x: 100 + NUDGE, y: 100 });
  assert.ok("data-mkui-vcursor" in document.documentElement.attrs, "the real cursor is hidden");
  assert.equal(ws._vc.parent, document.body);
  assert.equal(ws._vc.style.transform, `translate(${100 + NUDGE}px, 100px)`);
  ws._moveVCursor(60, 0);
  assert.equal(ws._focusedId, "b", "crossing into b focuses it");
  assert.deepEqual(order(), ["a", "b", "c"], "without raising it");
  ws._moveVCursor(400, 0);
  assert.equal(ws._focusedId, "b", "empty workspace keeps the focus");
  ws._moveVCursor(-100000, -100000);
  assert.deepEqual(ws._pointer, { x: 0, y: 0 }, "kept on the page");
  assert.equal(ws._focusedId, "a", "back over a");
  ws._frames[0].modal = true;
  ws._moveVCursor(200, 0);
  assert.equal(ws._focusedId, "a", "a modal holds the focus");
  ws._frames[0].modal = false;

  // A lower refocuses under the virtual cursor, not the real one.
  ws._pointer = { x: 200, y: 50 };
  ws._lowerFrame(el("b"));
  assert.equal(ws._focusedId, "b", "b is still under it (the stub says so)");
  delete document.elementFromPoint;
  ws._hideVCursor();
});

test("the real mouse takes back over: a real move, press or wheel; not a still one", () => {
  const { ws } = makeWs();
  ws.setSloppyFocus(true);
  ws._onTrackPointer({ type: "pointermove", clientX: 100, clientY: 100, screenX: 300, screenY: 400, movementX: 1 });
  ws._onWmKey(keyEv("KeyJ"));
  ws._onWmKeyUp({ altKey: true, code: "KeyJ", key: "j" });
  assert.equal(ws._vcOn, true);
  ws._onTrackPointer({ type: "pointermove", clientX: 100, clientY: 100, screenX: 300, screenY: 400, movementX: 0, movementY: 0 });
  assert.equal(ws._vcOn, true, "the page moving under a still pointer is not the mouse");
  assert.deepEqual(ws._pointer, { x: 100, y: 100 + NUDGE }, "and the cursor keeps the pointer's part");
  ws._onPointerMove({ buttons: 0, target: { closest: () => ws._frameEls.get("b") } });
  assert.notEqual(ws._focusedId, "b", "the hidden real pointer focuses nothing");
  ws._onTrackPointer({ type: "pointermove", clientX: 104, clientY: 100, screenX: 304, screenY: 400, movementX: 4 });
  assert.equal(ws._vcOn, false);
  assert.ok(!("data-mkui-vcursor" in document.documentElement.attrs), "the real cursor is back");
  assert.equal(ws._vc.parent, null);
  assert.deepEqual(ws._pointer, { x: 104, y: 100 });
  for (const type of ["pointerdown", "wheel"]) {
    ws._onWmKey(keyEv("KeyJ"));
    ws._onWmKeyUp({ altKey: true, code: "KeyJ", key: "j" });
    ws._onTrackPointer({ type, clientX: 7, clientY: 8 });
    assert.equal(ws._vcOn, false, type);
  }
  ws._onWmKey(keyEv("KeyJ"));
  ws.setSloppyFocus(false);
  assert.equal(ws._vcOn, false, "sloppy focus off hides it");
  assert.equal(ws._mover.active, false);
});

test("a held key: blur, alt let go or shift turns it over", () => {
  const { ws } = makeWs();
  ws.setSloppyFocus(true);
  ws._pointer = { x: 10, y: 10 };
  ws._onWmKey(keyEv("KeyL"));
  assert.equal(ws._mover.kind, "point");
  ws._onWmKey(keyEv("ShiftLeft", { key: "Shift", shiftKey: true }));
  assert.equal(ws._mover.kind, "move", "shift pressed mid-hold: the window");
  ws._onWmKeyUp({ altKey: true, code: "ShiftLeft", key: "Shift" });
  assert.equal(ws._mover.kind, "point", "and let go: the cursor again");
  ws._onWmBlur();
  assert.equal(ws._mover.active, false, "a lost focus drops held keys");
  ws._onWmKey(keyEv("KeyL"));
  ws._onWmKey({ type: "keydown", altKey: false, code: "KeyQ", key: "q", target: null });
  assert.equal(ws._mover.active, false, "a key without alt: alt went unheard");
  ws._hideVCursor();
});

test("nudgeFrame clamps to the workspace, clears tile state, leaves a maximized frame", () => {
  const { ws, el } = makeWs(["a"]);
  const spec = ws._frames[0];
  Object.assign(spec, { x: 0, y: 0, w: 0.5, h: 0.5, preTileRect: { x: 0.2, y: 0.2, w: 0.3, h: 0.3 } });
  assert.equal(ws.nudgeFrame("a", -5, 0), true);
  assert.equal(spec.x, 0, "clamped at the left edge");
  assert.equal(spec.preTileRect, undefined, "a moved tile is a plain frame");
  ws.nudgeFrame("a", 5, 5);
  assert.equal(el("a").style.left, "5px");
  assert.equal(el("a").style.top, "5px");
  assert.equal(el("a").style.width, "500px", "the size stays");
  ws._maximized = { frameId: "a" };
  assert.equal(ws.nudgeFrame("a", 5, 0), false);
  assert.equal(ws.nudgeFrame("zz", 5, 0), false);
});

// ── wiring: the app's preferences and actions, the frame, the menubar ──

// An app as installWm sees it: a real State, the actions it registers.
function wmApp(config = {}) {
  const actions = new Map();
  const app = { config, state: new State({}), registerAction: (n, fn) => actions.set(n, fn) };
  return { app, fire: (n, ...a) => actions.get(n)(app, ...a), actions };
}
function wsStub() {
  return {
    on: false, mod: "alt", sets: 0,
    setSloppyFocus(v) { this.on = v; this.sets++; }, sloppyFocus() { return this.on; },
    setWindowClick(m) { this.mod = m === "ctrl+alt" ? m : "alt"; }, windowClick() { return this.mod; },
  };
}

test("installWm: the config's default until the user chooses; the actions choose and keep it", () => {
  const store = memStore();
  let { app, fire, actions } = wmApp({ app: { sloppyFocus: true } });
  let ws = wsStub();
  installWm(app, ws, store);
  assert.deepEqual([...actions.keys()], ["focus.sloppy", "focus.windowClick"]);
  assert.equal(ws.on, true, "app.sloppyFocus is the default");
  fire("focus.sloppy");
  assert.equal(ws.on, false, "no args: a toggle");
  assert.deepEqual(readWmPrefs(store), { sloppyFocus: false }, "kept");
  fire("focus.sloppy", true);
  fire("focus.sloppy", true);
  assert.equal(ws.on, true, "true sets, not toggles");
  fire("focus.windowClick", "ctrl+alt");
  assert.equal(ws.mod, "ctrl+alt");
  fire("focus.windowClick", "super");
  assert.equal(ws.mod, "alt");
  assert.deepEqual(readWmPrefs(store), { sloppyFocus: true, windowClick: "alt" }, "what the workspace took is kept, not the bad value");

  // Another page load: the choice beats the config.
  ({ app } = wmApp({ app: { sloppyFocus: false } }));
  ws = wsStub();
  installWm(app, ws, store);
  assert.equal(ws.on, true);
  ({ app } = wmApp({}));
  ws = wsStub();
  installWm(app, ws, memStore());
  assert.equal(ws.on, false, "nothing chosen, nothing configured: off");
});

test("installWm under a login: each user's own choice, re-read as the user changes", () => {
  const store = memStore();
  writeWmPrefs(store, "ann", { sloppyFocus: true, windowClick: "ctrl+alt" });
  const { app, fire } = wmApp({});
  app.state.set("auth.user", "");
  const ws = wsStub();
  installWm(app, ws, store, { auth: true });
  assert.equal(ws.on, false, "before the login: the bare key's (nothing)");
  app.state.set("auth.user", "ann");
  assert.equal(ws.on, true, "ann's");
  assert.equal(ws.mod, "ctrl+alt");
  fire("focus.sloppy", false);
  assert.deepEqual(readWmPrefs(store, "ann"), { sloppyFocus: false, windowClick: "ctrl+alt" }, "saved under ann");
  assert.deepEqual(readWmPrefs(store, ""), {}, "not under the bare key");
  app.state.set("auth.user", "bob");
  assert.equal(ws.mod, "alt", "bob chose nothing");
  const unauthed = wmApp({});
  const ws2 = wsStub();
  installWm(unauthed.app, ws2, store);
  const n = ws2.sets;
  unauthed.app.state.set("auth.user", "ann");
  assert.equal(ws2.sets, n, "without a login block the user is not followed");
});

test("frame.js hands every press to the workspace first, in the capture phase", (t) => {
  globalThis.ResizeObserver ??= class { observe() {} disconnect() {} };
  const frame = new MkuiFrame();
  frame.appendChild = (c) => c;
  const listeners = [];
  frame.addEventListener = (name, fn, capture) => listeners.push({ name, fn, capture });
  frame._build();
  const pd = listeners.find((l) => l.name === "pointerdown");
  assert.ok(pd && pd.capture === true, "a capture-phase pointerdown");
  const seen = [];
  frame._workspace = { _framePointerDown: (ev, f) => seen.push([ev.button, f]), _pressFrame: () => seen.push("press") };
  pd.fn({ button: 0 });
  assert.deepEqual(seen, [[0, frame]]);
  const md = listeners.find((l) => l.name === "mousedown");
  frame._activateTabGroupFromEvent = () => {};
  md.fn({ target: { closest: () => null } });
  assert.deepEqual(seen.at(-1), "press", "the mousedown raises — or, sloppy, focuses — through _pressFrame");
});

test("the menubar's hover swap between menus carries shift too", () => {
  const mb = new MkuiMenubar();
  const labels = [];
  mb.appendChild = (el) => { labels.push(el); return el; };
  mb._app = { config: { menubar: [{ label: "A", items: [] }, { label: "Window", items: [{ windows: true }] }] } };
  const opened = [];
  mb._openRoot = (anchor, menu, ev) => { opened.push([menu.label, !!ev?.shiftKey]); mb._rootAnchor = anchor; };
  mb._closeAll = () => { mb._rootAnchor = null; };
  const realDoc = globalThis.document;
  globalThis.document = { ...realDoc, createElement: () => { const e = stubEl(); e.addEventListener = (n, fn) => { (e._ev ??= {})[n] = fn; }; return e; }, addEventListener() {} };
  try {
    mb._render();
  } finally { globalThis.document = realDoc; }
  labels[0]._ev.mousedown({ button: 0, shiftKey: false, stopPropagation() {} });
  labels[1]._ev.mouseenter({ shiftKey: true });
  assert.deepEqual(opened, [["A", false], ["Window", true]]);
});
