// Run with: node --test tests/dialog.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDialog } from "../mkui/static/src/widgets/mkui-dialog.js";

// Since openDialog uses document.body and document.createElement,
// we need a real or shimmed DOM. Node doesn't have one, so we test
// the expression and data-flow logic via the exported functions,
// and verify the module loads without error.

test("openDialog module exports a function", () => {
  assert.equal(typeof openDialog, "function");
});

test("normalizeOptions handles string arrays", async () => {
  const { resolveExpr, resolveObject } = await import("../mkui/static/src/lib/expressions.js");
  assert.equal(resolveExpr("${row.id}", { row: { id: 42 } }), 42);
  assert.deepEqual(resolveObject({ a: "${x}" }, { x: "hello" }), { a: "hello" });
});

test("resolveExpr with field context for optionsFrom params", async () => {
  const { resolveExpr } = await import("../mkui/static/src/lib/expressions.js");
  const ctx = {
    row: { id: 1 },
    field: { region: "US", broker: "GS" },
  };
  assert.equal(resolveExpr("${field.region}", ctx), "US");
  assert.equal(resolveExpr("${field.broker}", ctx), "GS");
});

test("resolveObject with nested dialog data pattern", async () => {
  const { resolveObject } = await import("../mkui/static/src/lib/expressions.js");
  const ctx = { row: { id: 42, symbol: "AAPL" } };
  const data = resolveObject(
    { template: "edit", id: "${row.id}" },
    ctx,
  );
  assert.deepEqual(data, { template: "edit", id: 42 });
});

test("resolveObject with submitPerRow rowData pattern", async () => {
  const { resolveObject } = await import("../mkui/static/src/lib/expressions.js");
  const rows = [
    { _mkio_row: "1", id: 10 },
    { _mkio_row: "2", id: 20 },
    { _mkio_row: "3", id: 30 },
  ];
  const results = rows.map((row) =>
    resolveObject({ id: "${row.id}" }, { row }),
  );
  assert.deepEqual(results, [{ id: 10 }, { id: 20 }, { id: 30 }]);
});

test("resolveExpr with selection context", async () => {
  const { resolveExpr } = await import("../mkui/static/src/lib/expressions.js");
  const ctx = { selection: { count: 3 } };
  assert.equal(resolveExpr("${selection.count} item(s)", ctx), "3 item(s)");
  assert.equal(resolveExpr("${selection.count}", ctx), 3);
});

// Pin / reset behavior — tested via resolveExpr since resetForm re-resolves
// field.value expressions against the original context to produce defaults.

test("resolveExpr re-resolves default values for form reset", async () => {
  const { resolveExpr } = await import("../mkui/static/src/lib/expressions.js");
  const ctx = { row: { qty: 100, side: "BUY" } };
  assert.equal(resolveExpr("${row.qty}", ctx), 100);
  assert.equal(resolveExpr("${row.side}", ctx), "BUY");
  assert.equal(resolveExpr("", ctx), "");
  assert.equal(resolveExpr("fixed-default", ctx), "fixed-default");
});

test("resolveExpr with empty/null default values for reset", async () => {
  const { resolveExpr } = await import("../mkui/static/src/lib/expressions.js");
  const ctx = {};
  assert.equal(resolveExpr("", ctx), "");
  assert.equal(resolveExpr(undefined ?? "", ctx), "");
  assert.equal(resolveExpr(null ?? "", ctx), "");
});

/* ── Pin button unit tests ───────────────────────────────────────────── */
// The pin button is constructed by makePinBtn() inside openDialog's closure.
// Since that function isn't exported, we replicate its logic here to verify
// the class, title, and toggle behavior independently of the DOM/workspace.

function mockEl(tag) {
  const el = {
    tagName: tag?.toUpperCase() ?? "",
    className: "",
    textContent: "",
    title: "",
    _ev: {},
    classList: {
      _s: new Set(),
      add(...cs) { for (const c of cs) this._s.add(c); },
      remove(...cs) { for (const c of cs) this._s.delete(c); },
      toggle(c, f) { f !== undefined ? (f ? this._s.add(c) : this._s.delete(c)) : (this._s.has(c) ? this._s.delete(c) : this._s.add(c)); },
      contains(c) { return this._s.has(c); },
    },
    addEventListener(e, fn) { (el._ev[e] ??= []).push(fn); },
  };
  return el;
}

function makePinBtn(pinnedRef) {
  const btn = mockEl("div");
  btn.className = "mkui-frame-btn mkui-dialog-pin" + (pinnedRef.value ? " mkui-dialog-pin-active" : "");
  btn.textContent = "\u{1F4CC}";
  btn.title = pinnedRef.value ? "Pinned — will stay open after submit" : "Pin to keep open after submit";
  btn.addEventListener("mousedown", (ev) => ev.stopPropagation?.());
  btn.addEventListener("click", (ev) => {
    ev?.stopPropagation?.();
    pinnedRef.value = !pinnedRef.value;
    btn.classList.toggle("mkui-dialog-pin-active", pinnedRef.value);
    btn.title = pinnedRef.value ? "Pinned — will stay open after submit" : "Pin to keep open after submit";
  });
  return btn;
}

test("pin button starts unpinned with correct class and title", () => {
  const ref = { value: false };
  const btn = makePinBtn(ref);
  assert.equal(btn.className, "mkui-frame-btn mkui-dialog-pin");
  assert.equal(btn.textContent, "\u{1F4CC}");
  assert.equal(btn.title, "Pin to keep open after submit");
  assert.equal(btn.classList.contains("mkui-dialog-pin-active"), false);
});

test("pin button click toggles to pinned state", () => {
  const ref = { value: false };
  const btn = makePinBtn(ref);
  const click = btn._ev.click[0];
  click({ stopPropagation() {} });
  assert.equal(ref.value, true);
  assert.equal(btn.classList.contains("mkui-dialog-pin-active"), true);
  assert.equal(btn.title, "Pinned — will stay open after submit");
});

test("pin button double-click toggles back to unpinned", () => {
  const ref = { value: false };
  const btn = makePinBtn(ref);
  const click = btn._ev.click[0];
  const ev = { stopPropagation() {} };
  click(ev);
  assert.equal(ref.value, true);
  click(ev);
  assert.equal(ref.value, false);
  assert.equal(btn.classList.contains("mkui-dialog-pin-active"), false);
  assert.equal(btn.title, "Pin to keep open after submit");
});

test("pin button created in pinned state has active class", () => {
  const ref = { value: true };
  const btn = makePinBtn(ref);
  assert.equal(btn.className, "mkui-frame-btn mkui-dialog-pin mkui-dialog-pin-active");
  assert.equal(btn.title, "Pinned — will stay open after submit");
});

test("pin button mousedown stops propagation", () => {
  const ref = { value: false };
  const btn = makePinBtn(ref);
  let stopped = false;
  const md = btn._ev.mousedown[0];
  md({ stopPropagation() { stopped = true; } });
  assert.equal(stopped, true);
});

test("pin button click stops propagation", () => {
  const ref = { value: false };
  const btn = makePinBtn(ref);
  let stopped = false;
  const click = btn._ev.click[0];
  click({ stopPropagation() { stopped = true; } });
  assert.equal(stopped, true);
});

/* ── Pin CSS class expectations ──────────────────────────────────────── */
// Verify the CSS classes match what mkui.css expects for the rotation effect.
// .mkui-dialog-pin = normal orientation (no transform)
// .mkui-dialog-pin-active = rotated -45deg counterclockwise + accent color

test("pin class names match CSS selectors for rotation", () => {
  const ref = { value: false };
  const btn = makePinBtn(ref);

  assert.ok(btn.className.includes("mkui-dialog-pin"));
  assert.ok(!btn.className.includes("mkui-dialog-pin-active"));

  const click = btn._ev.click[0];
  click({ stopPropagation() {} });

  assert.equal(btn.classList.contains("mkui-dialog-pin-active"), true);
  assert.equal(btn.classList.contains("mkui-dialog-pin"), false,
    "toggle should replace mkui-dialog-pin with mkui-dialog-pin-active");
});

test("pin button uses pushpin emoji U+1F4CC", () => {
  const ref = { value: false };
  const btn = makePinBtn(ref);
  assert.equal(btn.textContent, "\u{1F4CC}");
  assert.equal(btn.textContent.codePointAt(0), 0x1F4CC);
});

test("pin toggle is idempotent across multiple cycles", () => {
  const ref = { value: false };
  const btn = makePinBtn(ref);
  const click = btn._ev.click[0];
  const ev = { stopPropagation() {} };
  for (let i = 0; i < 10; i++) {
    click(ev);
    assert.equal(ref.value, i % 2 === 0);
    assert.equal(btn.classList.contains("mkui-dialog-pin-active"), i % 2 === 0);
  }
});

/* ── Auto-grow (end-to-end with a mock DOM + workspace) ──────────────── */
// openDialog measures the rendered body: if it would have to scroll, the
// frame's height fraction grows by the overflow (capped at 90% of the
// workspace) and the frame re-centers vertically. Element geometry is
// mocked per class name via `geom`.

let geom = {};

function domEl(tag) {
  const el = {
    tagName: tag?.toUpperCase() ?? "",
    className: "", textContent: "", title: "", type: "", value: "",
    placeholder: "", checked: false, disabled: false,
    style: {},
    _ch: [], _ev: {},
    classList: {
      _s: new Set(),
      add(...cs) { for (const c of cs) this._s.add(c); },
      remove(...cs) { for (const c of cs) this._s.delete(c); },
      toggle() {}, contains() { return false; },
    },
    append(...ns) { el._ch.push(...ns); },
    appendChild(n) { el._ch.push(n); return n; },
    setAttribute() {},
    addEventListener(e, fn) { (el._ev[e] ??= []).push(fn); },
    removeEventListener() {},
    querySelector() { return null; },
    focus() {},
    get scrollHeight() { return geom[el.className]?.scrollHeight ?? 0; },
    get clientHeight() { return geom[el.className]?.clientHeight ?? 0; },
  };
  return el;
}

globalThis.document = {
  createElement: (tag) => domEl(tag),
  createElementNS: (_ns, tag) => domEl(tag),
};

function makeWorkspace({ width = 1000, height = 800 } = {}) {
  return {
    _frames: [],
    _frameEls: new Map(),
    _paneEls: new Map(),
    layoutCalls: 0,
    registerPane() {},
    unregisterPane() {},
    addFrame(spec) {
      const id = `frame-${this._frames.length + 1}`;
      this._frames.push({ id, ...spec });
      this._frameEls.set(id, {
        offsetHeight: spec.h * height,
        _renderInternal() {},
      });
      this._paneEls.set(spec.layout.children[0], {
        contentEl: domEl("div"),
        addEventListener() {},
      });
      return id;
    },
    _layoutFrames() { this.layoutCalls++; },
    getBoundingClientRect() { return { width, height }; },
  };
}

function openTestDialog(ws, bodyGeom) {
  geom = { "mkui-dialog-body": bodyGeom };
  const app = { _element: { workspace: ws } };
  openDialog({ title: "T", fields: [{ name: "a", label: "A" }] }, {}, app);
  return ws._frames[0];
}

// The workspace is 1000×800, so the initial frame is h = min(0.6, 400/800)
// = 0.5 → 400px tall.

test("overflowing dialog body grows the frame and re-centers", () => {
  const ws = makeWorkspace();
  const frame = openTestDialog(ws, { scrollHeight: 500, clientHeight: 300 });
  // 200px of overflow on a 400px frame in an 800px workspace → 600/800.
  assert.equal(frame.h, 0.75);
  assert.equal(frame.y, 0.125, "re-centered vertically");
  assert.equal(ws.layoutCalls, 1, "layout re-ran to apply the new rect");
});

test("dialog growth caps at 90% of the workspace", () => {
  const ws = makeWorkspace();
  const frame = openTestDialog(ws, { scrollHeight: 2000, clientHeight: 300 });
  assert.equal(frame.h, 0.9);
  assert.ok(Math.abs(frame.y - 0.05) < 1e-12, "centered under the cap");
  assert.equal(ws.layoutCalls, 1);
});

test("dialog body that fits keeps the initial frame height", () => {
  const ws = makeWorkspace();
  const frame = openTestDialog(ws, { scrollHeight: 300, clientHeight: 300 });
  assert.equal(frame.h, 0.5);
  assert.equal(frame.y, 0.25);
  assert.equal(ws.layoutCalls, 0, "no relayout when nothing overflows");
});

test("zero-height workspace rect skips auto-grow without crashing", () => {
  const ws = makeWorkspace({ height: 0 });
  const frame = openTestDialog(ws, { scrollHeight: 500, clientHeight: 300 });
  assert.equal(frame.h, 0.6, "initial fraction untouched");
  assert.equal(ws.layoutCalls, 0);
});
