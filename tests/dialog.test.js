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
    className: "", textContent: "", title: "", type: "",
    placeholder: "", checked: false, disabled: false, readOnly: false,
    min: "", max: "", step: "",
    style: {},
    _ch: [], _ev: {}, _attrs: {},
    classList: {
      _s: new Set(),
      add(...cs) { for (const c of cs) this._s.add(c); },
      remove(...cs) { for (const c of cs) this._s.delete(c); },
      toggle(c, f) { f !== undefined ? (f ? this._s.add(c) : this._s.delete(c)) : (this._s.has(c) ? this._s.delete(c) : this._s.add(c)); },
      contains(c) { return this._s.has(c); },
    },
    append(...ns) { for (const n of ns) el.appendChild(n); },
    appendChild(n) { n._parent = el; el._ch.push(n); return n; },
    remove() { const p = el._parent; if (p) p._ch.splice(p._ch.indexOf(el), 1); },
    setAttribute(k, v) { el._attrs[k] = v; },
    removeAttribute(k) { delete el._attrs[k]; el[k] = ""; },
    addEventListener(e, fn) { (el._ev[e] ??= []).push(fn); },
    removeEventListener() {},
    fire(e, ev = {}) { for (const fn of el._ev[e] ?? []) fn(ev); },
    querySelector(sel) {
      if (!sel.startsWith(".")) return null;
      const cls = sel.slice(1);
      const walk = (n) => {
        for (const c of n._ch) {
          if (c.className?.split(" ").includes(cls)) return c;
          const r = walk(c);
          if (r) return r;
        }
        return null;
      };
      return walk(el);
    },
    focus() {},
    get options() { return el._ch.filter((c) => c.tagName === "OPTION"); },
    get scrollHeight() { return geom[el.className]?.scrollHeight ?? 0; },
    get clientHeight() { return geom[el.className]?.clientHeight ?? 0; },
  };
  // A select's value snaps to "" when no option carries it, as in a browser.
  let _value = "";
  Object.defineProperty(el, "value", {
    get() { return _value; },
    set(v) {
      v = String(v ?? "");
      _value = el.tagName === "SELECT" && !el.options.some((o) => o.value === v) ? "" : v;
    },
  });
  let _ih = "";
  Object.defineProperty(el, "innerHTML", {
    get() { return _ih; },
    set(v) { _ih = v; if (v === "") el._ch.length = 0; },
  });
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
    renames: [],
    registerPane() {},
    unregisterPane() {},
    renamePane(id, title) { this.renames.push(title); },
    closeFrame() {},
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

/* ── Dynamic forms (end-to-end with the mock DOM + workspace) ────────── */
// Every field property that may hold an expression is re-evaluated on each
// edit by the dialog's dynamic pass: `compute` values, `options`, `showWhen`
// on fields/rows/groups, labels, placeholders, `required`/`disabled`/
// `readonly` flags, `min`/`max`/`step`/`pattern`, the title, and the note.

function openForm(spec, context = {}, extra = {}, appExtra = {}) {
  geom = {};
  const ws = makeWorkspace();
  const app = { _element: { workspace: ws }, ...appExtra };
  const promise = openDialog(spec, context, app, extra);
  const host = ws._paneEls.values().next().value.contentEl;
  const body = host._ch[0]._ch[0];
  const footer = host._ch[0]._ch[1];
  const fields = {};
  const groups = [];
  const rows = [];
  const walk = (n) => {
    for (const c of n._ch) {
      if (c.className === "mkui-dialog-group") groups.push(c);
      if (c.className === "mkui-dialog-row") rows.push(c);
      if (c.className === "mkui-dialog-field") {
        const label = c._ch.find((x) => x.tagName === "LABEL");
        const input = c._ch.find((x) => ["INPUT", "SELECT", "TEXTAREA"].includes(x.tagName));
        const ro = c._ch.find((x) => x.className === "mkui-dialog-readonly");
        fields[c._mkuiName ?? Object.keys(fields).length] = { el: c, label, input, ro };
      }
      walk(c);
    }
  };
  walk(body);
  // Fields are found in declaration order; name them from the spec.
  const names = [];
  const flat = (items) => { for (const i of items) { if (i.group != null) continue; if (i.row) flat(i.row); else if (i.type !== "hidden") names.push(i.name); } };
  flat(spec.fields);
  const byName = {};
  Object.values(fields).forEach((f, i) => { byName[names[i]] = f; });
  const submitBtn = footer._ch[2];
  return {
    promise, ws, host, groups, rows, footer,
    f: (n) => byName[n],
    type(n, v) { const i = byName[n].input; i.value = v; i.fire("input"); },
    pick(n, v) { const i = byName[n].input; i.value = v; i.fire("change"); },
    check(n, v) { const i = byName[n].input; i.checked = v; i.fire("change"); },
    submit() { submitBtn.fire("click"); return promise; },
    errors: () => Object.entries(byName).filter(([, f]) => f.el.querySelector(".mkui-dialog-error")).map(([n]) => n),
  };
}

test("compute keeps a hidden total current and submits it as a number", async () => {
  const d = openForm({ fields: [
    { name: "qty", type: "number", value: "2" },
    { name: "price", type: "number", value: "10" },
    { name: "total", type: "hidden", compute: "qty * price" },
    { name: "shown", type: "readonly", compute: "Total: ${total}" },
  ] });
  assert.equal(d.f("shown").ro.textContent, "Total: 20");
  d.type("qty", "5");
  assert.equal(d.f("shown").ro.textContent, "Total: 50");
  const data = await d.submit();
  assert.deepEqual(data, { qty: "5", price: "10", total: 50 });
});

test("compute chains settle regardless of declaration order", () => {
  const d = openForm({ fields: [
    { name: "c", type: "readonly", compute: "b + 1" },
    { name: "b", type: "hidden", compute: "a + 1" },
    { name: "a", type: "number", value: "1" },
  ] });
  assert.equal(d.f("c").ro.textContent, "3");
  d.type("a", "10");
  assert.equal(d.f("c").ro.textContent, "12");
});

// A nameless field has no form state, but its value, compute, and showWhen
// still apply — a read-only confirmation line needs no name (0.2.21 blanked
// it: the value writer bailed on the missing name).
test("a nameless readonly field shows its value, computes, and hides", async () => {
  const d = openForm({ fields: [
    { name: "n", type: "number", value: "2" },
    { type: "readonly", value: "Delete ${row.id}?" },
    { type: "readonly", compute: "Rows: ${n}" },
    { type: "readonly", value: "Careful", showWhen: "n > 5" },
  ] }, { row: { id: 7 } });
  const ros = [];
  const walk = (el) => { for (const c of el._ch) { if (c.className === "mkui-dialog-field") ros.push(c); walk(c); } };
  walk(d.host);
  const text = (i) => ros[i]._ch.find((x) => x.className === "mkui-dialog-readonly").textContent;
  assert.equal(text(1), "Delete 7?");
  assert.equal(text(2), "Rows: 2");
  assert.equal(ros[3].style.display, "none");
  d.type("n", "9");
  assert.equal(text(2), "Rows: 9");
  assert.equal(ros[3].style.display, "");
  assert.equal(text(3), "Careful");
  const data = await d.submit();
  assert.deepEqual(data, { n: "9" });
});

test("nameless fields in rows follow the row's showWhen; an edited one keeps its text", async () => {
  const d = openForm({ fields: [
    { name: "mode", type: "select", options: ["add", "del"], value: "add" },
    { row: [
      { name: "qty", type: "number", value: "3" },
      { type: "readonly", compute: "x${qty}" },
    ], showWhen: "mode == 'add'" },
    { type: "readonly", value: "Remove it?", showWhen: "mode == 'del'" },
    { type: "text", compute: "${mode}-note" },
  ] });
  const fields = [];
  const walk = (el) => { for (const c of el._ch) { if (c.className === "mkui-dialog-field") fields.push(c); walk(c); } };
  walk(d.host);
  const ro = (i) => fields[i]._ch.find((x) => x.className === "mkui-dialog-readonly");
  const note = fields[4]._ch.find((x) => x.tagName === "INPUT");
  assert.equal(ro(2).textContent, "x3");
  assert.equal(d.rows[0].style.display, "");
  assert.equal(fields[3].style.display, "none");
  assert.equal(note.value, "add-note");
  d.type("qty", "8");
  assert.equal(ro(2).textContent, "x8");
  // A nameless editable field is still dirty-tracked: typing stops its compute.
  note.value = "mine"; note.fire("input");
  d.pick("mode", "del");
  assert.equal(d.rows[0].style.display, "none");
  assert.equal(fields[3].style.display, "");
  assert.equal(ro(3).textContent, "Remove it?");
  assert.equal(note.value, "mine");
  // Nameless fields never reach the payload, and never break validation.
  const data = await d.submit();
  assert.deepEqual(data, { mode: "del" });
});

test("a compute cycle warns once and stops", () => {
  const warns = [];
  const orig = console.warn;
  console.warn = (m) => warns.push(String(m));
  try {
    const d = openForm({ fields: [
      { name: "a", type: "hidden", compute: "b + 'x'" },
      { name: "b", type: "hidden", compute: "a + 'x'" },
      { name: "x", value: "" },
    ] });
    d.type("x", "1");
    d.type("x", "2");
  } finally { console.warn = orig; }
  const cyc = warns.filter((w) => w.includes("did not settle"));
  assert.equal(cyc.length, 1);
});

test("compute on an editable field yields to the user's edit until reset", async () => {
  const d = openForm({ fields: [
    { name: "symbol", value: "AAPL" },
    { name: "note", compute: "'Order for ' + symbol" },
  ] });
  assert.equal(d.f("note").input.value, "Order for AAPL");
  d.type("symbol", "MSFT");
  assert.equal(d.f("note").input.value, "Order for MSFT", "follows while untouched");
  d.type("note", "custom");
  d.type("symbol", "GOOG");
  assert.equal(d.f("note").input.value, "custom", "the user's text wins");
  const data = await d.submit();
  assert.equal(data.note, "custom");
});

test("required, min, max, and pattern evaluate against the form", async () => {
  const d = openForm({ fields: [
    { name: "kind", type: "select", options: ["stock", "other"] },
    { name: "detail", required: "kind == 'other'" },
    { name: "qty", type: "number", value: "5", max: "${IF(kind == 'stock', 10, 100)}" },
    { name: "code", pattern: "${IF(kind == 'stock', '^[A-Z]+$', '.*')}", value: "abc" },
  ] });
  assert.equal(d.f("qty").input.max, 10);
  d.submit();
  assert.deepEqual(d.errors(), ["code"], "stock: code must be upper-case, detail optional");
  d.pick("kind", "other");
  assert.equal(d.f("qty").input.max, 100);
  d.submit();
  assert.deepEqual(d.errors(), ["detail"], "other: detail required, any code passes");
  d.type("detail", "x");
  d.type("qty", "500");
  d.submit();
  assert.deepEqual(d.errors(), ["qty"]);
  d.type("qty", "50");
  const data = await d.submit();
  assert.equal(data.qty, "50");
});

test("labels, placeholders, disabled and readonly follow the form", () => {
  const d = openForm({ fields: [
    { name: "mode", type: "select", options: ["buy", "sell"] },
    { name: "px", label: "${TITLE(mode)} price", placeholder: "${mode} limit",
      readonly: "mode == 'sell'" },
    { name: "flag", type: "checkbox", disabled: "mode == 'sell'" },
  ] });
  assert.equal(d.f("px").label.textContent, "Buy price");
  assert.equal(d.f("px").input.placeholder, "buy limit");
  assert.equal(d.f("px").input.readOnly, false);
  assert.equal(d.f("flag").input.disabled, false);
  d.pick("mode", "sell");
  assert.equal(d.f("px").label.textContent, "Sell price");
  assert.equal(d.f("px").input.placeholder, "sell limit");
  assert.equal(d.f("px").input.readOnly, true);
  assert.equal(d.f("flag").input.disabled, true);
});

test("an options expression rebuilds the list, keeping the value when it survives", () => {
  const d = openForm({ fields: [
    { name: "region", type: "select", options: ["US", "UK"] },
    { name: "venue", type: "select",
      options: "IF(region == 'US', ['NYSE', 'NASDAQ', 'LSE'], [{value: 'LSE', label: 'London'}])" },
  ] });
  const venue = d.f("venue").input;
  assert.deepEqual(venue.options.map((o) => o.value), ["NYSE", "NASDAQ", "LSE"]);
  d.pick("venue", "LSE");
  d.pick("region", "UK");
  assert.deepEqual(venue.options.map((o) => [o.value, o.textContent]), [["LSE", "London"]]);
  assert.equal(venue.value, "LSE", "survives the rebuild");
  d.pick("venue", "LSE");
  d.pick("region", "US");
  d.pick("venue", "NASDAQ");
  d.pick("region", "UK");
  assert.equal(venue.value, "LSE", "falls back to the first option");
});

test("static options keep a configured default", () => {
  const d = openForm({ fields: [
    { name: "side", type: "select", options: ["buy", "sell"], value: "sell" },
  ] });
  assert.equal(d.f("side").input.value, "sell");
});

test("rows and groups hide with showWhen; hidden rows leave the data", async () => {
  const d = openForm({ fields: [
    { name: "ship", type: "checkbox", value: "${TRUE}" },
    { group: "Shipping to ${city}", showWhen: "ship" },
    { row: [{ name: "city", value: "Oslo" }, { name: "zip", value: "0150" }], showWhen: "ship" },
  ] });
  assert.equal(d.groups[0].textContent, "Shipping to Oslo");
  assert.equal(d.groups[0].style.display, "");
  assert.equal(d.rows[0].style.display, "");
  d.type("city", "Bergen");
  assert.equal(d.groups[0].textContent, "Shipping to Bergen");
  d.check("ship", false);
  assert.equal(d.groups[0].style.display, "none");
  assert.equal(d.rows[0].style.display, "none");
  const data = await d.submit();
  assert.deepEqual(data, { ship: false });
});

test("title and footer note re-resolve, and the note leaves submit feedback alone", () => {
  const d = openForm({
    title: "Order ${symbol}",
    footer: { note: "${qty} shares" },
    fields: [{ name: "symbol", value: "AAPL" }, { name: "qty", type: "number", value: "1" }],
  });
  assert.equal(d.ws.renames.at(-1), "Order AAPL", "the empty-form title is replaced once fields exist");
  assert.equal(d.footer._ch[0].textContent, "1 shares");
  d.type("symbol", "MSFT");
  assert.equal(d.ws.renames.at(-1), "Order MSFT");
  const n = d.ws.renames.length;
  d.type("qty", "3");
  assert.equal(d.ws.renames.length, n, "no rename when the title is unchanged");
  assert.equal(d.footer._ch[0].textContent, "3 shares");
  d.footer._ch[0].textContent = "OK";
  d.type("symbol", "X");
  assert.equal(d.footer._ch[0].textContent, "OK", "an unchanged note does not overwrite feedback");
});

test("a compute that moves a field re-fetches the options depending on it", async () => {
  const requests = [];
  const client = { request: async (svc, params) => { requests.push(params); return [{ id: "a", name: "A" }]; } };
  const d = openForm({ fields: [
    { name: "region", type: "select", options: ["US", "UK"] },
    { name: "market", type: "hidden", compute: "region + '-eq'" },
    { name: "venue", type: "select", optionsFrom: { service: "venues", params: { market: "${field.market}" }, value: "id", label: "name" } },
  ] }, {}, { client });
  await Promise.resolve();
  assert.deepEqual(requests, [{ market: "US-eq" }]);
  d.pick("region", "UK");
  await Promise.resolve();
  assert.deepEqual(requests.at(-1), { market: "UK-eq" });
});

test("a select with fill copies the picked row into named fields, skipping blanks", async () => {
  const client = { request: async () => [
    { id: 1, name: "Big", symbol: "AAPL", qty: "500", note: "" },
    { id: 2, name: "Small", symbol: "", qty: "5", note: "tiny" },
  ] };
  const d = openForm({ fields: [
    { name: "_template", type: "select", optionsFrom: { service: "templates", params: {}, value: "id", label: "name" },
      fill: { symbol: "symbol", qty: "qty", note: "note", missing: "qty" } },
    { name: "symbol", value: "MSFT" },
    { name: "qty", type: "number" },
    { name: "note", compute: "'Order for ' + symbol" },
  ] }, {}, { client });
  await Promise.resolve();
  d.pick("_template", "1");
  assert.equal(d.f("symbol").input.value, "AAPL");
  assert.equal(d.f("qty").input.value, "500");
  assert.equal(d.f("note").input.value, "Order for AAPL", "a blank column leaves the compute in charge");
  d.pick("_template", "2");
  assert.equal(d.f("symbol").input.value, "AAPL", "a blank column keeps the field's value");
  assert.equal(d.f("qty").input.value, "5");
  assert.equal(d.f("note").input.value, "tiny", "a filled field counts as edited: its compute yields");
  d.type("symbol", "GOOG");
  d.pick("_template", "1");
  assert.equal(d.f("symbol").input.value, "AAPL", "a later pick overrides a typed value");
  d.pick("_template", "");
  assert.equal(d.f("symbol").input.value, "AAPL", "clearing the pick moves nothing");
  const data = await d.submit();
  assert.deepEqual(Object.keys(data), ["symbol", "qty", "note"], "the pick itself is never submitted");
  assert.deepEqual([data.symbol, String(data.qty), data.note], ["AAPL", "500", "tiny"]);
});

test("a fill re-fetches the options that depend on a filled field", async () => {
  const requests = [];
  const client = { request: async (svc, params) => {
    requests.push([svc, params]);
    return svc === "templates" ? [{ id: 1, name: "UK", market: "LSE" }] : [{ id: "a", name: "A" }];
  } };
  const d = openForm({ fields: [
    { name: "_template", type: "select", optionsFrom: { service: "templates", params: {}, value: "id", label: "name" }, fill: { market: "market" } },
    { name: "market", value: "NYSE" },
    { name: "venue", type: "select", optionsFrom: { service: "venues", params: { market: "${field.market}" }, value: "id", label: "name" } },
  ] }, {}, { client });
  await Promise.resolve();
  assert.deepEqual(requests.filter(([s]) => s === "venues").at(-1), ["venues", { market: "NYSE" }]);
  d.pick("_template", "1");
  await Promise.resolve();
  assert.deepEqual(requests.filter(([s]) => s === "venues").at(-1), ["venues", { market: "LSE" }]);
});

test("remember restores a field and a template pick, storing what the form says", async () => {
  const store = new Map();
  const storage = { getItem: (k) => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, v) };
  const client = { request: async () => [
    { id: 1, name: "big", symbol: "AAPL", qty: "500" },
    { id: 2, name: "small", symbol: "MSFT", qty: "5" },
  ] };
  const spec = { fields: [
    { name: "_template", type: "select", optionsFrom: { service: "t", params: {}, value: "name", label: "name" },
      fill: { symbol: "symbol", qty: "qty" },
      remember: { key: "app.template", value: "IF(COALESCE(save_as, '') != '', save_as, _template)" } },
    { name: "symbol" },
    { name: "qty", type: "number" },
    { name: "account", remember: "app.account" },
    { name: "save_as" },
  ] };
  let d = openForm(spec, {}, { client, storage });
  await Promise.resolve();
  assert.equal(d.f("symbol").input.value, "", "nothing remembered yet");
  d.pick("_template", "big");
  d.type("account", "ACC1");
  let data = await d.submit();
  assert.deepEqual([store.get("app.template"), store.get("app.account")], ["big", "ACC1"]);

  d = openForm(spec, {}, { client, storage });
  assert.equal(d.f("account").input.value, "ACC1", "a plain field comes back at once");
  await Promise.resolve();
  assert.equal(d.f("_template").input.value, "big", "the pick comes back once the options load");
  assert.equal(d.f("symbol").input.value, "AAPL", "and fills as a pick would");
  d.type("save_as", "mine");
  data = await d.submit();
  assert.equal(data.save_as, "mine");
  assert.equal(store.get("app.template"), "mine", "a typed name wins over the pick");

  store.set("app.template", "gone");
  d = openForm(spec, {}, { client, storage });
  await Promise.resolve();
  assert.equal(d.f("_template").input.value, "", "a name the options lack is left alone");
  assert.equal(d.f("symbol").input.value, "");
  d.pick("_template", "");
  await d.submit();
  assert.equal(store.get("app.template"), "", "a cleared pick is remembered as none");
});

test("a value given to a service-backed select before its options arrive is kept once they hold it", async () => {
  // Two lists load at open: a remembered template fills the session as soon
  // as the templates arrive, and the session list must not wipe it when it
  // lands afterwards (nor a default, when the list simply comes late).
  const store = new Map([["app.template", "big"]]);
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const deferred = {};
  const client = { request: (svc) => new Promise((res) => { deferred[svc] = res; }) };
  const d = openForm({ fields: [
    { name: "_template", type: "select", optionsFrom: { service: "templates", params: {}, value: "name", label: "name" },
      fill: { session: "session", symbol: "symbol" }, remember: "app.template" },
    { name: "session", type: "select", optionsFrom: { service: "sessions", params: {}, value: "id", label: "id" } },
    { name: "venue", type: "select", value: "LSE", optionsFrom: { service: "venues", params: {}, value: "id", label: "id" } },
    { name: "symbol" },
  ] }, {}, { client, storage });
  deferred.templates([{ name: "big", session: "S2", symbol: "AAPL" }]);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(d.f("symbol").input.value, "AAPL", "the template filled before the sessions came");
  deferred.sessions([{ id: "S1" }, { id: "S2" }]);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(d.f("session").input.value, "S2", "the fill survives the session list's arrival");
  deferred.venues([{ id: "NYSE" }, { id: "LSE" }]);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(d.f("venue").input.value, "LSE", "so does a plain default");
  const data = await d.submit();
  assert.deepEqual([data.session, data.venue, data.symbol], ["S2", "LSE", "AAPL"]);
});

test("a service-backed select whose list lacks the value it was given starts blank", async () => {
  const client = { request: async () => [{ id: "S1" }] };
  const d = openForm({ fields: [
    { name: "session", type: "select", value: "GONE", optionsFrom: { service: "sessions", params: {}, value: "id", label: "id" } },
  ] }, {}, { client });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(d.f("session").input.value, "");
  const data = await d.submit();
  assert.equal(data.session, "");
});

test("a required checkbox must be checked", () => {
  const d = openForm({ fields: [{ name: "agree", type: "checkbox", required: true }] });
  d.submit();
  assert.deepEqual(d.errors(), ["agree"]);
  d.check("agree", true);
  d.submit();
  assert.deepEqual(d.errors(), []);
});

test("empty number fields read as NULL in the form scope", () => {
  const d = openForm({ fields: [
    { name: "qty", type: "number" },
    { name: "ok", type: "readonly", compute: "IF((qty ?? 0) > 0, 'yes', 'no')" },
    { name: "isnull", type: "readonly", compute: "qty == NULL" },
  ] });
  assert.equal(d.f("ok").ro.textContent, "no");
  assert.equal(d.f("isnull").ro.textContent, "true");
  d.type("qty", "3");
  assert.equal(d.f("ok").ro.textContent, "yes");
  assert.equal(d.f("isnull").ro.textContent, "false");
});

test("a pinned submit resets the form and a compute takes the field back", async () => {
  let sent = [];
  const client = { send: async (svc, data) => { sent.push(data); return { type: "ok" }; } };
  const d = openForm({
    submit: { service: "orders" },
    fields: [{ name: "symbol", value: "AAPL" }, { name: "note", compute: "'Order for ' + symbol" }],
  }, {}, { client });
  // Pin via the frame control the dialog injects.
  const pin = d.ws._frameEls.get("frame-1")._extraControls()[0];
  pin._ev.click[0]({ stopPropagation() {} });
  d.type("note", "custom");
  d.type("symbol", "MSFT");
  assert.equal(d.f("note").input.value, "custom");
  d.submit();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(sent, [{ symbol: "MSFT", note: "custom" }]);
  assert.equal(d.f("symbol").input.value, "AAPL", "defaults restored");
  assert.equal(d.f("note").input.value, "Order for AAPL", "compute applies again after reset");
  d.type("symbol", "GOOG");
  assert.equal(d.f("note").input.value, "Order for GOOG", "and follows again");
});

/* ── submit.then ─────────────────────────────────────────────────────── */
// A confirmed submit may fire one mkui action with args resolved against
// what was sent — the way a table's own buttons resolve theirs against the
// selection — so a dialog that files a record on some pane can select it
// there and let the linked panes follow.

test("submit.then fires after a confirmed submit, args resolved against the data", async () => {
  const sent = [], fired = [];
  const client = { send: async (svc, data) => { sent.push(data); return { type: "ok" }; } };
  const d = openForm({
    submit: { service: "tasks", op: "add_ref",
              then: { action: "table.select", args: { pane: "tasks", keys: ["${task_id}"], from: "${row.id}" } } },
    fields: [{ name: "task_id", value: "T1" }, { name: "_scratch", value: "never sent" }],
  }, { row: { id: 7 } }, { client }, { fireAction: (name, args) => fired.push([name, args]) });
  const data = await d.submit();
  assert.deepEqual(data, { task_id: "T1" }, "scratch fields stay out of the submit");
  assert.deepEqual(sent, [{ task_id: "T1" }]);
  assert.deepEqual(fired, [["table.select", { pane: "tasks", keys: ["T1"], from: 7 }]],
    "the args see the submitted fields over the opening context");
});

test("submit.then stays quiet on a refused submit and fires on every pinned confirmation", async () => {
  let refuse = true;
  const fired = [];
  const client = { send: async () => refuse ? { type: "error", message: "no" } : { type: "ok" } };
  const d = openForm({
    submit: { service: "tasks", then: { action: "table.select", args: { keys: ["${task_id}"] } } },
    fields: [{ name: "task_id", value: "T1" }],
  }, {}, { client }, { fireAction: (name, args) => fired.push(args.keys[0]) });
  const pin = d.ws._frameEls.get("frame-1")._extraControls()[0];
  pin._ev.click[0]({ stopPropagation() {} });
  d.submit();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(fired, [], "a refusal fires nothing");
  refuse = false;
  d.type("task_id", "T2");
  d.submit();
  await new Promise((r) => setTimeout(r, 0));
  d.type("task_id", "T3");
  d.submit();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(fired, ["T2", "T3"], "each confirmed submit of a pinned dialog fires once");
});

test("submit.then without a service fires on the resolve, and a bad spec warns instead of throwing", async () => {
  const fired = [], warned = [];
  const warn = console.warn;
  console.warn = (m) => warned.push(m);
  try {
    const d = openForm({ submit: { then: { action: "pane.show", args: { pane: "x" } } },
                         fields: [{ name: "a", value: "1" }] }, {}, {},
                       { fireAction: (name, args) => fired.push([name, args]) });
    assert.deepEqual(await d.submit(), { a: "1" });
    assert.deepEqual(fired, [["pane.show", { pane: "x" }]]);
    const bad = openForm({ submit: { then: "table.select" }, fields: [{ name: "a", value: "1" }] }, {}, {},
                         { fireAction: () => fired.push("bad") });
    assert.deepEqual(await bad.submit(), { a: "1" }, "the submit itself is unaffected");
    assert.equal(fired.length, 1);
    assert.ok(warned.some((m) => m.includes("submit.then")), "the shape is named once");
  } finally {
    console.warn = warn;
  }
});

test("readonly on a select or checkbox disables it; a dynamic min validates", () => {
  const d = openForm({ fields: [
    { name: "lock", type: "checkbox" },
    { name: "side", type: "select", options: ["buy", "sell"], readonly: "lock" },
    { name: "agree", type: "checkbox", readonly: "lock" },
    { name: "qty", type: "number", value: "5", min: "${IF(lock, 10, 1)}" },
  ] });
  assert.equal(d.f("side").input.disabled, false);
  d.check("lock", true);
  assert.equal(d.f("side").input.disabled, true);
  assert.equal(d.f("agree").input.disabled, true);
  assert.equal(d.f("qty").input.min, 10);
  d.submit();
  assert.deepEqual(d.errors(), ["qty"]);
  assert.equal(d.f("qty").el.querySelector(".mkui-dialog-error").textContent, "Min: 10");
  d.check("lock", false);
  d.submit();
  assert.deepEqual(d.errors(), []);
});

test("per-option showWhen still filters a static list", () => {
  const d = openForm({ fields: [
    { name: "pro", type: "checkbox" },
    { name: "type", type: "select", options: ["market", { value: "iceberg", label: "Iceberg", showWhen: "pro" }] },
  ] });
  assert.deepEqual(d.f("type").input.options.map((o) => o.value), ["market"]);
  d.check("pro", true);
  assert.deepEqual(d.f("type").input.options.map((o) => o.value), ["market", "iceberg"]);
  d.pick("type", "iceberg");
  d.check("pro", false);
  assert.equal(d.f("type").input.value, "market", "a vanished option falls back to the first");
});

test("invalidMessage is a template over the form", () => {
  const d = openForm({ fields: [
    { name: "kind", value: "stock" },
    { name: "code", required: true, invalidMessage: "A ${kind} needs a code" },
  ] });
  d.submit();
  assert.equal(d.f("code").el.querySelector(".mkui-dialog-error").textContent, "A stock needs a code");
});

test("a field declared disabled stays disabled through an options load", async () => {
  let resolveReq;
  const client = { request: () => new Promise((r) => { resolveReq = r; }) };
  const d = openForm({ fields: [
    { name: "venue", type: "select", disabled: true, optionsFrom: { service: "v", params: {}, value: "id", label: "name" } },
    { name: "note", type: "select", optionsFrom: { service: "v", params: {}, value: "id", label: "name" } },
  ] }, {}, { client });
  assert.equal(d.f("note").input.disabled, true, "disabled while loading");
  resolveReq([{ id: "a", name: "A" }]);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(d.f("note").input.disabled, false, "enabled once loaded");
  assert.equal(d.f("venue").input.disabled, true, "configured disabled survives the load");
  assert.deepEqual(d.f("note").input.options.map((o) => o.value), ["", "a"]);
});

test("a compute or option expression that errors degrades to empty and warns once", () => {
  const warns = [];
  const orig = console.warn;
  console.warn = (m) => warns.push(String(m));
  try {
    const d = openForm({ fields: [
      { name: "a", type: "number", value: "1" },
      { name: "b", type: "readonly", compute: "a +" },
      { name: "c", type: "select", options: "NOPE(" },
    ] });
    assert.equal(d.f("b").ro.textContent, "");
    assert.deepEqual(d.f("c").input.options, []);
    d.type("a", "2");
    d.type("a", "3");
  } finally { console.warn = orig; }
  assert.equal(warns.filter((w) => w.includes('"a +"')).length, 1);
  assert.equal(warns.filter((w) => w.includes('"NOPE("')).length, 1);
});

/* ── Temporal fields ─────────────────────────────────────────────────── */
// The pickers are native; the dialog owns the conversion between what the
// picker shows (the browser's wall clock) and what is submitted (canonical
// UTC), so a server never has to guess the browser's zone.

const localInput = (iso) => {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

test("a datetime field submits the picked local time as a UTC instant", async () => {
  const d = openForm({ fields: [{ name: "at", type: "datetime" }] });
  assert.equal(d.f("at").input.type, "datetime-local");
  d.type("at", localInput("2026-09-12T21:00:00Z"));
  assert.deepEqual(await d.submit(), { at: "2026-09-12T21:00:00Z" });
});

test("a datetime default shows in local time and round-trips untouched", async () => {
  const d = openForm({ fields: [{ name: "at", type: "datetime", value: "2026-09-12T21:00:00Z" }] });
  assert.equal(d.f("at").input.value, localInput("2026-09-12T21:00:00Z"));
  assert.deepEqual(await d.submit(), { at: "2026-09-12T21:00:00Z" });
});

test("parse reads a default in another format, a list trying each in turn", async () => {
  const parse = ["%Y%m%d-%H:%M:%S.%f", "%Y%m%d-%H:%M:%S"];
  const d = openForm({ fields: [
    { name: "a", type: "datetime", parse, value: "20260912-21:00:00.123" },
    { name: "b", type: "datetime", parse, value: "20260912-21:00:00" },
    { name: "c", type: "datetime", parse, value: "not a time" },
  ] });
  assert.equal(d.f("a").input.value, localInput("2026-09-12T21:00:00Z"));
  assert.equal(d.f("b").input.value, localInput("2026-09-12T21:00:00Z"));
  assert.equal(d.f("c").input.value, "");
  assert.deepEqual(await d.submit(), { a: "2026-09-12T21:00:00.123Z", b: "2026-09-12T21:00:00Z", c: "" });
});

test("a date field is a calendar date, parsed and submitted without a zone", async () => {
  const d = openForm({ fields: [
    { name: "on", type: "date", parse: "%Y%m%d", value: "20260912" },
    { name: "blank", type: "date" },
  ] });
  assert.equal(d.f("on").input.type, "date");
  assert.equal(d.f("on").input.value, "2026-09-12");
  d.type("blank", "2026-12-31");
  assert.deepEqual(await d.submit(), { on: "2026-09-12", blank: "2026-12-31" });
});

test("a time field submits HH:MM:SS and an empty picker submits nothing", async () => {
  const d = openForm({ fields: [{ name: "t", type: "time", value: "09:30" }, { name: "u", type: "time" }] });
  assert.equal(d.f("t").input.value, "09:30:00");
  d.type("t", "16:00");
  assert.deepEqual(await d.submit(), { t: "16:00:00", u: "" });
});

// An optional-time field is a date picker beside a time picker under one
// name; the shim finds no direct input, so the pair is read from the field.
const pairOf = (d, n) => {
  const pair = d.f(n).el._ch.find((x) => x.className === "mkui-dialog-datetime");
  return { date: pair._ch[0], time: pair._ch[1] };
};

test("an optional-time datetime submits a bare date until a time is picked", async () => {
  const d = openForm({ fields: [{ name: "at", type: "datetime", time: "optional", step: 1 }] });
  const { date, time } = pairOf(d, "at");
  assert.equal(date.type, "date");
  assert.equal(time.type, "time");
  assert.equal(String(time.step), "1", "step belongs to the time picker");
  assert.equal(String(date.step), "");
  date.value = "2026-09-12"; date.fire("input");
  time.value = "21:00"; time.fire("input");
  time.value = ""; time.fire("input");
  assert.deepEqual(await d.submit(), { at: "2026-09-12" });
});

test("an optional-time datetime with both parts submits a UTC instant", async () => {
  const d = openForm({ fields: [{ name: "at", type: "datetime", time: "optional" }] });
  const { date, time } = pairOf(d, "at");
  const [ld, lt] = localInput("2026-09-12T21:00:00Z").split("T");
  date.value = ld; date.fire("input");
  time.value = lt; time.fire("input");
  assert.deepEqual(await d.submit(), { at: "2026-09-12T21:00:00Z" });
});

test("an optional-time default prefills a date alone or a date and local time", async () => {
  const parse = ["%Y%m%d-%H:%M:%S.%f", "%Y%m%d-%H:%M:%S", "%Y%m%d"];
  const d = openForm({ fields: [
    { name: "a", type: "datetime", time: "optional", parse, value: "20260912" },
    { name: "b", type: "datetime", time: "optional", parse, value: "20260912-21:00:00.000" },
    { name: "c", type: "datetime", time: "optional", value: "2026-09-12" },
    { name: "e", type: "datetime", time: "optional", value: "" },
  ] });
  const [ld, lt] = localInput("2026-09-12T21:00:00Z").split("T");
  assert.deepEqual([pairOf(d, "a").date.value, pairOf(d, "a").time.value], ["2026-09-12", ""]);
  assert.deepEqual([pairOf(d, "b").date.value, pairOf(d, "b").time.value], [ld, lt]);
  assert.deepEqual([pairOf(d, "c").date.value, pairOf(d, "c").time.value], ["2026-09-12", ""]);
  assert.deepEqual([pairOf(d, "e").date.value, pairOf(d, "e").time.value], ["", ""]);
  assert.deepEqual(await d.submit(), { a: "2026-09-12", b: "2026-09-12T21:00:00Z", c: "2026-09-12", e: "" });
});

test("a plain datetime never degrades to a date: a bare-date default is midnight UTC", async () => {
  const d = openForm({ fields: [{ name: "at", type: "datetime", value: "2026-09-12" }] });
  assert.equal(d.f("at").input.value, localInput("2026-09-12T00:00:00Z"));
  assert.deepEqual(await d.submit(), { at: "2026-09-12T00:00:00Z" });
});
