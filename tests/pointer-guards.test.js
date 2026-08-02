// Run with: node --test tests/pointer-guards.test.js
//
// Mouse-button guards: every mousedown/pointerdown that opens a menu or
// starts an action/drag must act on the primary button only — right and
// middle clicks are inert (the browser's context menu stays meaningful,
// and a middle-click paste/scroll gesture can't tear the UI). Covers the
// menubar (open + item activation), frame resize handles, splitters, the
// tab-bar drag region, and tab pointerdown. The frame-raise mousedown is
// deliberately unguarded (any-button raise matches OS convention) and is
// asserted as such.
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.HTMLElement = class {};
globalThis.customElements = { get: () => undefined, define: () => {} };
globalThis.ResizeObserver = class { observe() {} disconnect() {} };

// Minimal DOM: children, class list, event listeners, remove().
function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    style: {},
    className: "",
    textContent: "",
    title: "",
    parentElement: null,
    _ch: [],
    _listeners: {},
    appendChild(c) { el._ch.push(c); c.parentElement = el; return c; },
    remove() { el.removed = true; },
    setAttribute(name, v) { if (name === "class") el.className = String(v); },
    getAttribute() { return null; },
    addEventListener(name, fn) { (el._listeners[name] ??= []).push(fn); },
    querySelector() { return null; },
    closest() { return null; },
    classList: {
      contains: (c) => el.className.split(/\s+/).includes(c),
      add: (c) => { if (!el.classList.contains(c)) el.className = (el.className + " " + c).trim(); },
      remove: (c) => { el.className = el.className.split(/\s+/).filter((x) => x !== c).join(" "); },
      toggle(c, force) {
        const has = el.classList.contains(c);
        const want = force ?? !has;
        if (want !== has) (want ? el.classList.add : el.classList.remove)(c);
        return want;
      },
    },
  };
  return el;
}
globalThis.document = {
  createElement: makeEl,
  createElementNS: (_ns, tag) => makeEl(tag),
  createTextNode: (text) => ({ textContent: text }),
  addEventListener() {},
};

const { MkuiMenubar } = await import("../mkui/static/src/components/menubar.js");
const { MkuiFrame } = await import("../mkui/static/src/components/frame.js");
const { normalize } = await import("../mkui/static/src/layout/tree.js");

const fire = (el, name, ev = {}) =>
  (el._listeners[name] ?? []).forEach((fn) =>
    fn({ stopPropagation() {}, preventDefault() {}, ...ev }));

// ── Menubar ─────────────────────────────────────────────────────────

function makeMenubar(menus, onAction) {
  const mb = new MkuiMenubar();
  mb._ch = [];
  mb.appendChild = (el) => { mb._ch.push(el); return el; };
  mb._app = { config: { menubar: menus }, fireAction: onAction ?? (() => {}) };
  mb._render();
  // Top-level labels are the children appended by _render (popups come later).
  return { mb, labels: mb._ch.filter((c) => c.className === "mkui-menu") };
}

test("right/middle mousedown on a menu label does not open the menu", () => {
  const { mb, labels } = makeMenubar([{ label: "File", items: [] }]);
  fire(labels[0], "mousedown", { button: 2 });
  assert.equal(mb._rootAnchor, null, "right click must not open");
  fire(labels[0], "mousedown", { button: 1 });
  assert.equal(mb._rootAnchor, null, "middle click must not open");
  fire(labels[0], "mousedown", { button: 0 });
  assert.equal(mb._rootAnchor, labels[0], "left click opens");
});

test("non-primary press/release on a menu item does not fire its action", () => {
  const actions = [];
  const { mb, labels } = makeMenubar(
    [{ label: "File", items: [{ label: "Quit", action: "app.quit" }] }],
    (name, args) => actions.push([name, args]),
  );
  fire(labels[0], "mousedown", { button: 0 }); // open the popup
  const popup = mb._ch.find((c) => c.className === "mkui-menu-popup");
  const item = popup._ch.find((c) => String(c.className).includes("mkui-menu-item"));

  fire(item, "mousedown", { button: 2 });
  fire(item, "mouseup", { button: 2 });
  assert.deepEqual(actions, [], "right click must not activate");
  assert.equal(mb._rootAnchor, labels[0], "menu stays open");

  fire(item, "mousedown", { button: 1 });
  fire(item, "mouseup", { button: 1 });
  assert.deepEqual(actions, [], "middle click must not activate");

  fire(item, "mousedown", { button: 0 });
  fire(item, "mouseup", { button: 0 });
  assert.deepEqual(actions, [["app.quit", undefined]], "left click activates");
  assert.equal(mb._rootAnchor, null, "menu closes on activation");
});

// ── Frame resize handles ────────────────────────────────────────────

function makeBuiltFrame() {
  const frame = new MkuiFrame();
  frame._ch = [];
  frame.appendChild = (el) => { frame._ch.push(el); return el; };
  frame.addEventListener = () => {}; // capture-phase raise handler, unused here
  frame._build();
  return frame;
}

test("resize handles start a resize on the left button only", () => {
  const frame = makeBuiltFrame();
  const calls = [];
  frame._workspace = { _beginFrameResize: (_ev, _frame, dir) => calls.push(dir) };
  const handles = frame._ch.filter((c) => String(c.className).includes("mkui-frame-resize"));
  assert.equal(handles.length, 8, "8-way handles built");
  for (const h of handles) {
    fire(h, "mousedown", { button: 2 });
    fire(h, "mousedown", { button: 1 });
  }
  assert.deepEqual(calls, [], "right/middle must not resize");
  fire(handles[0], "mousedown", { button: 0 });
  assert.deepEqual(calls, ["n"], "left click starts the resize");
});

// ── Splitters, drag region, and tabs (via a rendered layout) ────────

function makeRenderedFrame() {
  const frame = makeBuiltFrame();
  Object.assign(frame._bodyEl, { clientWidth: 400, clientHeight: 300, children: [] });
  const origAppend = frame._bodyEl.appendChild;
  frame._bodyEl.appendChild = (el) => { frame._bodyEl.children.push(el); return origAppend(el); };
  frame._workspace = {
    calls: [],
    getPaneSpec: () => null,
    _ensurePaneEl: (id) => Object.assign(makeEl("mkui-pane"), { getAttribute: () => id }),
    _beginFrameResize(...a) { this.calls.push(["resize", a[2]]); },
    _beginFrameMove() { this.calls.push(["move"]); },
    _beginPaneDrag(_ev, _frame, id) { this.calls.push(["paneDrag", id]); },
  };
  frame._tree = normalize({
    type: "split", dir: "h", ratios: [0.5, 0.5], children: ["a", "b"],
  });
  frame._renderInternal();
  return frame;
}

test("splitter drag starts on the left button only", () => {
  const frame = makeRenderedFrame();
  const drags = [];
  frame._beginSplitterDrag = (_ev, sp) => drags.push(sp.dir);
  const splitter = frame._chromeEls.find((c) => String(c.className).includes("mkui-splitter"));
  assert.ok(splitter, "splitter rendered for the split tree");
  fire(splitter, "mousedown", { button: 2 });
  fire(splitter, "mousedown", { button: 1 });
  assert.deepEqual(drags, [], "right/middle must not drag the splitter");
  fire(splitter, "mousedown", { button: 0 });
  assert.deepEqual(drags, ["h"], "left click starts the drag");
});

function findAll(el, pred, out = []) {
  for (const c of el._ch ?? []) { if (pred(c)) out.push(c); findAll(c, pred, out); }
  return out;
}

test("tab-bar drag region moves the frame on the left button only", () => {
  const frame = makeRenderedFrame();
  const bars = frame._chromeEls.filter((c) => String(c.className).includes("mkui-tabbar"));
  const drag = findAll(bars[0], (c) => String(c.className).includes("mkui-frame-drag"))[0];
  assert.ok(drag, "drag region rendered");
  fire(drag, "mousedown", { button: 2 });
  fire(drag, "mousedown", { button: 1 });
  assert.deepEqual(frame._workspace.calls, [], "right/middle must not move");
  fire(drag, "mousedown", { button: 0 });
  assert.deepEqual(frame._workspace.calls, [["move"]], "left click starts the move");
});

test("tab pointerdown starts a pane drag on the left button only", () => {
  const frame = makeRenderedFrame();
  const bars = frame._chromeEls.filter((c) => String(c.className).includes("mkui-tabbar"));
  const tab = findAll(bars[0], (c) => /(^| )mkui-tab( |$)/.test(String(c.className)))[0];
  assert.ok(tab, "tab rendered");
  fire(tab, "pointerdown", { button: 2 });
  fire(tab, "pointerdown", { button: 1 });
  assert.deepEqual(frame._workspace.calls, [], "right/middle must not start a drag");
  fire(tab, "pointerdown", { button: 0 });
  assert.deepEqual(frame._workspace.calls, [["paneDrag", "a"]], "left click starts the drag");
});

test("frame raise fires on any button (matches OS convention)", () => {
  // The capture-phase raise handler is intentionally unguarded: right-click
  // raising the window under the cursor is standard window-manager behavior.
  const raised = [];
  const frame = new MkuiFrame();
  frame._ch = [];
  frame.appendChild = (el) => { frame._ch.push(el); return el; };
  const captured = {};
  frame.addEventListener = (name, fn) => { captured[name] = fn; };
  frame._build();
  frame._workspace = { _raiseFrame: () => raised.push(1) };
  frame._activateTabGroupFromEvent = () => {};
  for (const button of [0, 1, 2])
    captured.mousedown({ button, target: { closest: () => null } });
  assert.equal(raised.length, 3);
});
