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
      if (c.className === "mkui-dialog-section") {
        const head = c._ch[0];
        groups.push({
          el: c, head, body: c._ch[1],
          label: head._ch.find((x) => x.className === "mkui-dialog-group-label"),
          summary: head._ch.find((x) => x.className === "mkui-dialog-group-summary"),
          open: () => !c.classList.contains("mkui-dialog-collapsed"),
          click: (ev = {}) => head.fire("click", ev),
          key: (key, ev = {}) => head.fire("keydown", { key, preventDefault() {}, stopPropagation() {}, ...ev }),
        });
      }
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
  const flat = (items) => { for (const i of items) { if (i.group != null) { if (i.fields) flat(i.fields); } else if (i.row) flat(i.row); else if (i.type !== "hidden") names.push(i.name); } };
  flat(spec.fields ?? []);
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
  assert.equal(d.groups[0].label.textContent, "Shipping to Oslo");
  assert.equal(d.groups[0].el.style.display, "");
  assert.equal(d.rows[0].style.display, "");
  d.type("city", "Bergen");
  assert.equal(d.groups[0].label.textContent, "Shipping to Bergen");
  d.check("ship", false);
  assert.equal(d.groups[0].el.style.display, "none");
  assert.equal(d.rows[0].style.display, "none");
  const data = await d.submit();
  assert.deepEqual(data, { ship: false });
});

/* ── Sections ────────────────────────────────────────────────────────── */
// A `{ group }` heads a section holding every item up to the next header.
// `collapsible = true` folds it behind the head (click, Enter, Space;
// alt/option for every section), `collapsed` picks the start, `remember`
// keeps the fold in storage, and a folded head wears a summary — the
// `summary` template, else how many fields were edited under it.

const SECTIONED = { fields: [
  { name: "symbol", value: "AAPL" },
  { group: "Execution", collapsible: true, collapsed: true },
  { name: "tif", type: "select", options: ["Day", "GTC"] },
  { name: "note" },
  { group: "Notes" },
  { name: "memo" },
] };

test("a group's showWhen hides its section and drops its fields; a plain group has no caret", async () => {
  const d = openForm({ fields: [
    { name: "more", type: "checkbox", value: "${TRUE}" },
    { group: "More" },
    { name: "extra", value: "x" },
    { group: "Always", showWhen: "!more" },
    { name: "tail", value: "y" },
  ] });
  assert.equal(d.groups.length, 2);
  assert.equal(d.groups[0].summary, undefined, "a plain group is a header, not a button");
  assert.equal(d.groups[0].head._attrs.role, undefined);
  assert.equal(d.groups[1].el.style.display, "none");
  assert.deepEqual(await d.submit(), { more: true, extra: "x" });
});

test("a collapsible section starts folded, unfolds by click, Enter or Space, and its fields still submit", async () => {
  const d = openForm(SECTIONED);
  const [exec, notes] = d.groups;
  assert.ok(exec.el.classList.contains("mkui-dialog-collapsible"));
  assert.equal(exec.head._attrs.role, "button");
  assert.equal(exec.open(), false);
  assert.equal(exec.head._attrs["aria-expanded"], "false");
  assert.equal(notes.open(), true, "a plain group is always open");
  exec.click();
  assert.equal(exec.open(), true);
  assert.equal(exec.head._attrs["aria-expanded"], "true");
  exec.key("Enter");
  assert.equal(exec.open(), false);
  exec.key(" ");
  assert.equal(exec.open(), true);
  exec.key("x");
  assert.equal(exec.open(), true, "other keys are not toggles");
  exec.click();
  d.type("note", "hidden but live");
  assert.deepEqual(await d.submit(), { symbol: "AAPL", tif: "Day", note: "hidden but live", memo: "" });
});

test("a folded head counts the fields edited under it; a summary template replaces the count", () => {
  const d = openForm(SECTIONED);
  const exec = d.groups[0];
  assert.equal(exec.summary.textContent, "", "nothing changed yet");
  d.type("note", "careful");
  assert.equal(exec.summary.textContent, "1 changed");
  d.pick("tif", "GTC");
  assert.equal(exec.summary.textContent, "2 changed");
  d.type("symbol", "MSFT");
  assert.equal(exec.summary.textContent, "2 changed", "a field outside the section is not its business");
  exec.click();
  assert.equal(exec.summary.textContent, "", "open, the fields speak for themselves");
  exec.click();
  d.type("note", "");
  assert.equal(exec.summary.textContent, "1 changed", "back to what it opened with");

  const e = openForm({ fields: [
    { group: "Execution", collapsible: true, collapsed: "TRUE", summary: "${tif} · ${note}" },
    { name: "tif", value: "Day" },
    { name: "note", value: "" },
  ] });
  assert.equal(e.groups[0].open(), false, "collapsed takes an expression");
  assert.equal(e.groups[0].summary.textContent, "Day · ");
  e.type("note", "x");
  assert.equal(e.groups[0].summary.textContent, "Day · x");
});

test("alt-click folds or unfolds every collapsible section together", () => {
  const d = openForm({ fields: [
    { group: "A", collapsible: true },
    { name: "a" },
    { group: "B", collapsible: true, collapsed: true },
    { name: "b" },
    { group: "C" },
    { name: "c" },
  ] });
  const [a, b, c] = d.groups;
  assert.deepEqual([a.open(), b.open(), c.open()], [true, false, true]);
  a.click({ altKey: true });
  assert.deepEqual([a.open(), b.open(), c.open()], [false, false, true], "all take the clicked head's new state");
  b.click({ altKey: true });
  assert.deepEqual([a.open(), b.open(), c.open()], [true, true, true]);
});

test("remember keeps a section's fold across openings, stored as it changes", () => {
  const store = new Map();
  const storage = { getItem: (k) => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, v) };
  const spec = { fields: [
    { group: "Execution", collapsible: true, collapsed: true, remember: "orders.exec" },
    { name: "tif" },
  ] };
  let d = openForm(spec, {}, { storage });
  assert.equal(d.groups[0].open(), false);
  d.groups[0].click();
  assert.equal(store.get("orders.exec"), "open", "kept at the toggle, not at submit");
  d = openForm(spec, {}, { storage });
  assert.equal(d.groups[0].open(), true, "the remembered fold beats `collapsed`");
  store.set("orders.exec", "junk");
  d = openForm(spec, {}, { storage });
  assert.equal(d.groups[0].open(), false, "an unreadable value falls back to the config");
});

test("validation unfolds the section hiding a failing field, without remembering it", async () => {
  const store = new Map();
  const storage = { getItem: (k) => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, v) };
  const d = openForm({ fields: [
    { name: "symbol", value: "AAPL" },
    { group: "Execution", collapsible: true, collapsed: true, remember: "x" },
    { name: "account", required: true },
  ] }, {}, { storage });
  assert.equal(d.groups[0].open(), false);
  d.submit();
  await Promise.resolve();
  assert.deepEqual(d.errors(), ["account"]);
  assert.equal(d.groups[0].open(), true, "the error must be seen to be fixed");
  assert.equal(store.has("x"), false);
});

test("a group's `fields` bound its section; what follows returns to the enclosing scope", async () => {
  const d = openForm({ fields: [
    { name: "symbol", value: "AAPL" },
    { group: "Advanced", collapsible: true, collapsed: true, showWhen: "symbol != 'X'",
      fields: [{ row: [{ name: "expire", value: "" }] }, { name: "save_as", value: "t" }] },
    { name: "preview", type: "readonly", compute: "Terms: ${symbol}" },
    { group: "Notes" },
    { name: "memo", value: "m" },
    { group: "Inner", collapsible: true, fields: [{ name: "deep", value: "d" }] },
    { name: "after", value: "a" },
  ] });
  const [adv, notes, inner] = d.groups;
  const holds = (sec, name) => {
    const el = d.f(name).el;
    return sec.body._ch.includes(el) || sec.body._ch.some((c) => c._ch?.includes(el));
  };
  assert.ok(holds(adv, "expire") && holds(adv, "save_as"));
  assert.equal(holds(adv, "preview"), false, "the preview follows the folded section at the root");
  assert.equal(adv.open(), false);
  assert.equal(d.f("preview").ro.textContent, "Terms: AAPL");
  assert.ok(holds(notes, "memo"));
  assert.ok(notes.body._ch.includes(inner.el), "a bounded section nests inside the open one");
  assert.ok(holds(inner, "deep"));
  assert.ok(holds(notes, "after") && !holds(inner, "after"), "and the outer section resumes after it");
  d.type("symbol", "X");
  assert.equal(adv.el.style.display, "none");
  assert.equal(d.f("preview").el.style.display, "", "a bounded group's showWhen covers only its own fields");
  assert.deepEqual(await d.submit(), { symbol: "X", memo: "m", deep: "d", after: "a" });
});

test("a bounded section folds, remembers, counts edits and unfolds on a validation error like an open-ended one", async () => {
  const store = new Map();
  const storage = { getItem: (k) => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, v) };
  const spec = { fields: [
    { name: "symbol", value: "AAPL" },
    { group: "Advanced", collapsible: true, collapsed: true, remember: "adv",
      fields: [{ name: "expire", value: "" }, { name: "account", required: true }] },
    { name: "preview", type: "readonly", compute: "${symbol}" },
  ] };
  let d = openForm(spec, {}, { storage });
  const adv = d.groups[0];
  assert.equal(adv.open(), false);
  d.type("expire", "20260914");
  assert.equal(adv.summary.textContent, "1 changed", "a folded head counts its own fields");
  d.submit();
  await Promise.resolve();
  assert.deepEqual(d.errors(), ["account"]);
  assert.equal(adv.open(), true, "the error under the bounded head unfolds it");
  assert.equal(store.has("adv"), false, "an unfold for validation is not a preference");
  adv.click();
  assert.equal(store.get("adv"), "closed");
  d = openForm(spec, {}, { storage });
  assert.equal(d.groups[0].open(), false, "remembered");
  d.type("account", "A1");
  assert.deepEqual(await d.submit(), { symbol: "AAPL", expire: "", account: "A1" }, "folded fields submit; the readonly line does not");
});

test("unfolding a section grows the frame downward from its title bar, never shrinks it", () => {
  const d = openForm(SECTIONED);
  const frame = d.ws._frames[0];
  assert.equal(frame.h, 0.5, "the folded form fits the initial guess");
  assert.equal(frame.y, 0.25, "centered at open");
  assert.equal(d.ws.layoutCalls, 0);
  geom = { "mkui-dialog-body": { scrollHeight: 500, clientHeight: 300 } };
  d.groups[0].click();
  assert.equal(frame.h, 0.75, "200px of overflow on a 400px frame in an 800px workspace");
  assert.equal(frame.y, 0.25, "the title bar stays put; only the bottom edge moves");
  assert.equal(d.ws.layoutCalls, 1);
  d.groups[0].click();
  assert.equal(frame.h, 0.75, "folding leaves the room");
  assert.equal(d.ws.layoutCalls, 1);
});

test("a dialog dragged low moves up only by what would fall off the bottom when it unfolds", () => {
  let d = openForm(SECTIONED);
  let frame = d.ws._frames[0];
  frame.y = 0.4; // dragged: bottom at 0.9
  geom = { "mkui-dialog-body": { scrollHeight: 500, clientHeight: 300 } };
  d.groups[0].click();
  assert.equal(frame.h, 0.75);
  assert.equal(frame.y, 0.25, "0.4 + 0.75 overshoots by 0.15, so the top rises by 0.15 — not to center");
  d = openForm(SECTIONED);
  frame = d.ws._frames[0];
  frame.y = 0.1; // dragged up: room below
  geom = { "mkui-dialog-body": { scrollHeight: 500, clientHeight: 300 } };
  d.groups[0].click();
  assert.equal(frame.h, 0.75);
  assert.equal(frame.y, 0.1, "the top does not move at all");
});

test("a pinned reset re-baselines what a folded head counts as changed, keeping the fold", async () => {
  const d = openForm(SECTIONED);
  const pin = d.ws._frameEls.get(d.ws._frames[0].id)._extraControls()[0];
  pin.fire("click", { stopPropagation() {} });
  d.groups[0].click();
  d.type("note", "x");
  d.groups[0].click();
  assert.equal(d.groups[0].summary.textContent, "1 changed");
  d.submit();
  await Promise.resolve();
  assert.equal(d.f("note").input.value, "", "reset to the default");
  assert.equal(d.groups[0].summary.textContent, "", "and that is the new baseline");
  assert.equal(d.groups[0].open(), false, "the fold is a preference the reset leaves alone");
});

test("the changed count skips hidden, readonly, nameless and showWhen-hidden fields; rows nest in the section", () => {
  const d = openForm({ fields: [
    { name: "kind", type: "select", options: ["a", "b"] },
    { group: "Details", collapsible: true, collapsed: true },
    { row: [{ name: "x", value: "1" }, { name: "y", value: "2" }] },
    { name: "_scratch", type: "hidden", compute: "kind" },
    { name: "total", type: "readonly", compute: "x" },
    { type: "readonly", value: "a line" },
    { name: "only_b", showWhen: "kind == 'b'" },
  ] });
  const sec = d.groups[0];
  assert.equal(d.rows[0]._parent, sec.body, "a { row } under the header lives in the section body");
  assert.equal(d.f("total").el._parent, sec.body);
  assert.equal(sec.summary.textContent, "");
  d.pick("kind", "b");
  assert.equal(sec.summary.textContent, "", "a compute moving a hidden or readonly field is not an edit");
  d.type("only_b", "z");
  assert.equal(sec.summary.textContent, "1 changed");
  d.pick("kind", "a");
  assert.equal(sec.summary.textContent, "", "a field showWhen hides no longer counts");
  d.type("x", "10");
  assert.equal(sec.summary.textContent, "1 changed", "readonly total moved with it, uncounted");
});

test("Enter and Space on a head are consumed, so the dialog's Enter-to-submit never fires", () => {
  const d = openForm({ fields: [
    { group: "More", collapsible: true },
    { name: "a" },
  ] });
  const calls = [];
  const ev = (key) => ({ key, preventDefault: () => calls.push(`pd:${key}`), stopPropagation: () => calls.push(`sp:${key}`) });
  d.groups[0].head.fire("keydown", ev("Enter"));
  d.groups[0].head.fire("keydown", ev(" "));
  d.groups[0].head.fire("keydown", ev("Tab"));
  assert.deepEqual(calls, ["pd:Enter", "sp:Enter", "pd: ", "sp: "], "Tab passes through untouched");
  assert.equal(d.groups[0].open(), true, "two toggles: back where it started");
});

test("ctrl/cmd+Enter submits from anywhere, a textarea included; plain Enter there is a newline", async () => {
  for (const mod of ["ctrlKey", "metaKey"]) {
    const d = openForm({ fields: [{ name: "note", type: "textarea", value: "hi" }] });
    const ta = d.f("note").input;
    const calls = [];
    const key = (ev) => d.host.fire("keydown", { key: "Enter", target: ta, preventDefault: () => calls.push("pd"), ...ev });
    key({});
    let settled = false;
    d.promise.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(settled, false, "plain Enter in a textarea does not submit");
    assert.deepEqual(calls, [], "and keeps its default, the newline");
    key({ [mod]: true });
    assert.deepEqual(await d.promise, { note: "hi" }, `${mod}+Enter submits`);
    assert.deepEqual(calls, ["pd"], "the browser's own Enter handling is stopped");
  }
});

test("mod+Enter on a section head submits instead of folding it", async () => {
  const d = openForm({ fields: [
    { group: "More", collapsible: true },
    { name: "a", value: "1" },
  ] });
  const calls = [];
  const ev = { key: "Enter", metaKey: true, target: d.groups[0].head, preventDefault: () => calls.push("pd"), stopPropagation: () => calls.push("sp") };
  d.groups[0].head.fire("keydown", ev);
  assert.deepEqual(calls, [], "the head lets a modified Enter bubble");
  assert.equal(d.groups[0].open(), true, "and does not fold");
  d.host.fire("keydown", ev);
  assert.deepEqual(await d.promise, { a: "1" });
});

test("the OK button's tooltip names the submit shortcut in the platform's spelling", async () => {
  const { formatShortcut } = await import("../mkui/static/src/lib/shortcut.js");
  const d = openForm({ fields: [{ name: "a", value: "1" }] });
  const okBtn = d.footer._ch[2];
  assert.equal(okBtn.textContent, "OK");
  assert.equal(okBtn.title, formatShortcut("mod+Enter"));
  assert.equal(okBtn.title, "Ctrl+Enter", "node has no Apple navigator");
  d.footer._ch[1].fire("click");
  assert.equal(await d.promise, null);
});

test("plain Enter on a footer button is the browser's click, not a submit", async () => {
  const d = openForm({ fields: [{ name: "a", value: "1" }] });
  const cancelBtn = d.footer._ch[1];
  d.host.fire("keydown", { key: "Enter", target: cancelBtn, preventDefault() {} });
  let settled = false;
  d.promise.then(() => { settled = true; });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(settled, false, "Enter on Cancel must not submit before the click cancels");
  cancelBtn.fire("click");
  assert.equal(await d.promise, null);
  const d2 = openForm({ fields: [{ name: "a", value: "1" }] });
  d2.host.fire("keydown", { key: "Enter", target: d2.f("a").input, preventDefault() {} });
  assert.deepEqual(await d2.promise, { a: "1" }, "Enter in a single-line field still submits");
});

test("a non-collapsible group ignores collapsed and remember, and a collapsible one with no fields still folds", async () => {
  const store = new Map();
  const storage = { getItem: (k) => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, v) };
  const d = openForm({ fields: [
    { group: "Plain", collapsed: true, remember: "plain" },
    { name: "a", value: "1" },
    { group: "Empty", collapsible: true },
  ] }, {}, { storage });
  assert.equal(d.groups[0].open(), true, "collapsed means nothing without collapsible");
  assert.equal(d.groups[0].summary, undefined);
  d.groups[1].click();
  assert.equal(d.groups[1].open(), false);
  assert.equal(d.groups[1].summary.textContent, "");
  assert.equal(store.size, 0, "no remember key, nothing stored");
  assert.deepEqual(await d.submit(), { a: "1" });
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

/* ── pin: "keep" ──────────────────────────────────────────── */
// `pin = "keep"` on the spec makes a pinned submit hold the entered values
// (and their dirty marks, so a compute stays off them) for the next one;
// a field's own `pin: "reset"` still goes back to its default.

function pinIt(d) {
  const pin = d.ws._frameEls.get(d.ws._frames[0].id)._extraControls()[0];
  pin.fire("click", { stopPropagation() {} });
}

// Escape cancels the dialog unless it is pinned. From a field the form's own
// keydown handler decides; with focus outside the form the workspace routes
// the window's Escape to the pane's `_editActions.cancel` — same answer.

function paneOf(d) {
  return d.ws._paneEls.get(d.ws._frames[0].layout.children[0]);
}

async function settled(promise) {
  let done = false;
  promise.then(() => { done = true; });
  await new Promise((r) => setTimeout(r, 0));
  return done;
}

test("Escape in a field cancels an unpinned dialog and claims the key", async () => {
  const d = openForm({ fields: [{ name: "a", value: "1" }] });
  let prevented = false;
  d.host.fire("keydown", { key: "Escape", target: d.f("a").input, preventDefault() { prevented = true; } });
  assert.equal(await d.promise, null);
  assert.equal(prevented, true);
});

test("Escape in a field does nothing to a pinned dialog", async () => {
  const d = openForm({ fields: [{ name: "a", value: "1" }] });
  pinIt(d);
  let prevented = false;
  d.host.fire("keydown", { key: "Escape", target: d.f("a").input, preventDefault() { prevented = true; } });
  assert.equal(await settled(d.promise), false, "still open");
  assert.equal(prevented, false, "browser default kept (an open select list still shuts)");
  d.type("a", "2");
  pinIt(d);
  d.host.fire("keydown", { key: "Escape", target: d.f("a").input, preventDefault() {} });
  assert.equal(await d.promise, null, "unpinned again, Escape cancels");
});

test("the pane's _editActions.cancel closes an unpinned dialog, refuses a pinned one", async () => {
  const d = openForm({ fields: [{ name: "a", value: "1" }] });
  const pane = paneOf(d);
  pinIt(d);
  assert.equal(pane._editActions.cancel(), false);
  assert.equal(await settled(d.promise), false, "pinned: still open");
  pinIt(d);
  assert.equal(pane._editActions.cancel(), true);
  assert.equal(await d.promise, null);
  assert.equal(pane._editActions.cancel(), false, "already closed");
});

test("pin keep: a pinned submit holds the entered values and a compute stays off them", async () => {
  const sent = [];
  const client = { send: async (svc, data) => { sent.push(data); return { type: "ok" }; } };
  const d = openForm({
    pin: "keep",
    submit: { service: "orders" },
    fields: [{ name: "symbol", value: "AAPL" }, { name: "note", compute: "'Order for ' + symbol" }, { name: "qty", value: "1" }],
  }, {}, { client });
  pinIt(d);
  d.type("note", "custom");
  d.type("symbol", "MSFT");
  d.submit();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(sent, [{ symbol: "MSFT", note: "custom", qty: "1" }]);
  assert.equal(d.f("symbol").input.value, "MSFT", "kept");
  assert.equal(d.f("note").input.value, "custom", "the typed note is still dirty, so the compute leaves it");
  d.type("qty", "2");
  d.submit();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(sent[1], { symbol: "MSFT", note: "custom", qty: "2" }, "the next submit sends the kept terms");
  assert.equal(d.f("note").input.value, "custom");
});

test("pin keep: a field's own pin reset goes back to its default while its neighbours keep", async () => {
  const store = new Map();
  const storage = { getItem: (k) => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, v) };
  const client = {
    send: async () => ({ type: "ok" }),
    request: async () => [{ id: 1, name: "big", symbol: "AAPL", qty: "500" }],
  };
  const d = openForm({
    pin: "keep",
    submit: { service: "orders" },
    fields: [
      { name: "_template", type: "select", optionsFrom: { service: "t", params: {}, value: "name", label: "name" },
        fill: { symbol: "symbol", qty: "qty" },
        remember: { key: "app.template", value: "IF(COALESCE(save_as, '') != '', save_as, _template)" } },
      { name: "symbol" },
      { name: "qty", type: "number" },
      { name: "save_as", pin: "reset" },
    ],
  }, {}, { client, storage });
  await Promise.resolve();
  pinIt(d);
  d.pick("_template", "big");
  d.type("qty", "7");
  d.type("save_as", "mine");
  d.submit();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(store.get("app.template"), "mine", "remember still stores at the submit");
  assert.equal(d.f("save_as").input.value, "", "the save-as name resets so the next submit does not re-save");
  assert.equal(d.f("_template").input.value, "big", "the pick stays");
  assert.equal(d.f("symbol").input.value, "AAPL");
  assert.equal(d.f("qty").input.value, "7", "the edit over the template stays, and the pick's fill does not run again");
});

test("pin keep: errors clear, the changed count re-baselines, and an unpinned or refused submit is as before", async () => {
  const d = openForm({ pin: "keep", fields: [
    { name: "symbol", value: "AAPL" },
    { group: "Execution", collapsible: true, collapsed: true },
    { name: "note" },
    { name: "account", required: true },
  ] });
  pinIt(d);
  d.groups[0].click();
  d.type("note", "x");
  d.groups[0].click();
  assert.equal(d.groups[0].summary.textContent, "1 changed");
  d.submit();
  await Promise.resolve();
  assert.deepEqual(d.errors(), ["account"], "a refused submit keeps the form as it was");
  assert.equal(d.f("note").input.value, "x");
  d.type("account", "A1");
  d.submit();
  await Promise.resolve();
  assert.deepEqual(d.errors(), [], "the confirmed submit clears the error marker");
  assert.equal(d.f("note").input.value, "x", "kept");
  assert.equal(d.f("account").input.value, "A1");
  assert.equal(d.groups[0].summary.textContent, "", "what is kept is the new baseline");

  const plain = openForm({ pin: "keep", fields: [{ name: "symbol", value: "AAPL" }] });
  plain.type("symbol", "MSFT");
  assert.deepEqual(await plain.submit(), { symbol: "MSFT" }, "unpinned, keep changes nothing: the dialog closes");
});

test("pin defaults to reset, and an unknown value resets too", async () => {
  for (const pin of [undefined, "reset", "bogus"]) {
    const d = openForm({ pin, fields: [{ name: "symbol", value: "AAPL" }] });
    pinIt(d);
    d.type("symbol", "MSFT");
    d.submit();
    await Promise.resolve();
    assert.equal(d.f("symbol").input.value, "AAPL", `pin=${pin}`);
  }
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

/* ── Message boxes and buttons ───────────────────────────────────────── */
// `message` / `heading` / `facts` / `links` / `kind` lead the body with
// what the dialog says; `buttons` replace the Cancel / OK pair and the
// answer becomes `{ button, data }`. A spec with neither is the form it
// always was (everything above).

import { normalizeButtons, hasMessage } from "../mkui/static/src/widgets/mkui-dialog.js";

const messageOf = (d) => d.host._ch[0]._ch[0]._ch.find((c) => c.className.startsWith("mkui-dialog-message"));
const buttonsOf = (d) => d.footer._ch.filter((c) => c.tagName === "BUTTON");
const button = (d, label) => buttonsOf(d).find((b) => b.textContent === label);
const key = (d, k, target = {}, ev = {}) => {
  let prevented = false;
  d.host.fire("keydown", { key: k, target, preventDefault() { prevented = true; }, ...ev });
  return prevented;
};
const deep = (n, cls) => n.className?.split(" ").includes(cls) ? n : n._ch.map((c) => deep(c, cls)).find(Boolean);

test("normalizeButtons: ids, the one cancel, and the default", () => {
  assert.equal(normalizeButtons({}), null);
  assert.equal(normalizeButtons({ buttons: [] }), null);
  const b = normalizeButtons({ buttons: ["Save", { label: "Discard", kind: "danger" }, { id: "no", label: "Cancel", cancel: true }, { label: "Close", cancel: true }] });
  assert.deepEqual(b.map((x) => x.id), ["save", "discard", "no", "close"]);
  assert.deepEqual(b.map((x) => x.cancel), [false, false, true, false], "the first cancel is the cancel");
  assert.deepEqual(b.map((x) => x.default), [true, false, false, false]);
  assert.equal(b[0].kind, "plain", "a kind was given somewhere: nothing is promoted");
  const plain = normalizeButtons({ buttons: [{ label: "Cancel", cancel: true }, "OK"] });
  assert.equal(plain[1].kind, "primary", "with no kind anywhere the default wears primary");
});

test("normalizeButtons: a danger dialog defaults to Cancel, and never to a danger button", () => {
  const warn = console.warn; const warned = []; console.warn = (...a) => warned.push(a.join(" "));
  try {
    const d = normalizeButtons({ kind: "danger", buttons: [{ label: "Cancel", cancel: true }, { label: "Delete", kind: "danger" }] });
    assert.deepEqual(d.map((x) => x.default), [true, false]);
    const forced = normalizeButtons({ buttons: [{ label: "Cancel", cancel: true }, { label: "Delete", kind: "danger", default: true }] });
    assert.deepEqual(forced.map((x) => x.default), [false, false], "a danger button is no default, said or not");
    assert.ok(warned.some((w) => w.includes("cannot be the default")));
    const dup = normalizeButtons({ buttons: ["OK", "ok", { kind: "primary" }] });
    assert.deepEqual(dup.map((x) => x.id), ["ok"]);
    assert.equal(warned.filter((w) => w.includes("bad buttons")).length, 2);
  } finally { console.warn = warn; }
});

test("hasMessage: any of message, heading, image, facts, links", () => {
  assert.equal(hasMessage({ fields: [] }), false);
  assert.equal(hasMessage({ facts: [] }), false);
  for (const s of [{ message: "" }, { heading: "h" }, { image: "x.png" }, { facts: [{}] }, { links: [{}] }]) assert.equal(hasMessage(s), true);
});

test("a message box renders its icon, heading, paragraphs, facts and links", () => {
  const warn = console.warn; const warned = []; console.warn = (...a) => warned.push(a.join(" "));
  let d;
  try {
    d = openForm({
      kind: "warn", heading: "Hello ${who}", message: ["One", "Two ${n + 1}"],
      facts: [{ label: "Server", value: "${srv}" }, { label: "Gone", value: "${nope}" }, { label: "Off", value: "x", showWhen: "false" }],
      links: [{ label: "Site", href: "https://example.com" }, { label: "Bad", href: "javascript:alert(1)" }, { href: "/docs" }],
      fields: [],
    }, { who: "Ann", n: 1, srv: "orders 2.1" });
  } finally { console.warn = warn; }
  const box = messageOf(d);
  assert.equal(box.className, "mkui-dialog-message mkui-dialog-kind-warn");
  assert.equal(deep(box, "mkui-dialog-message-icon")._ch[0]._attrs.class, "mkui-icon mkui-icon-triangle-alert");
  assert.equal(deep(box, "mkui-dialog-heading").textContent, "Hello Ann");
  const text = deep(box, "mkui-dialog-message-text");
  assert.deepEqual(text._ch.filter((c) => c.className === "mkui-dialog-para").map((p) => p.textContent), ["One", "Two 2"]);
  assert.deepEqual(deep(box, "mkui-dialog-facts")._ch.map((c) => c.textContent), ["Server", "orders 2.1"], "a blank or hidden fact drops its line");
  const links = deep(box, "mkui-dialog-links")._ch;
  assert.deepEqual(links.map((a) => [a.textContent, a.href, a.target, a.rel]), [
    ["Site", "https://example.com", "_blank", "noopener noreferrer"],
    ["/docs", "/docs", "_blank", "noopener noreferrer"],
  ]);
  assert.ok(warned.some((w) => w.includes("bad links[1]")), "javascript: is not a link");
});

test("a message follows the form, like every other template", () => {
  const d = openForm({ message: "Delete ${name}?", fields: [{ name: "name" }] });
  const para = deep(messageOf(d), "mkui-dialog-para");
  assert.equal(para.textContent, "Delete ?");
  d.type("name", "AAPL");
  assert.equal(para.textContent, "Delete AAPL?");
});

test("a message box opens short and grows to its content; a form keeps its height", () => {
  geom = {};
  const ws = makeWorkspace();
  openDialog({ message: "hi" }, {}, { _element: { workspace: ws } });
  assert.equal(ws._frames[0].h, 140 / 800);
  const ws2 = makeWorkspace();
  openDialog({ message: "hi", height: 320 }, {}, { _element: { workspace: ws2 } });
  assert.equal(ws2._frames[0].h, 0.4);
  geom = { "mkui-dialog-body": { scrollHeight: 160, clientHeight: 60 } };
  const ws3 = makeWorkspace();
  openDialog({ message: "hi" }, {}, { _element: { workspace: ws3 } });
  assert.equal(ws3._frames[0].h, 240 / 800, "grown by the overflow");
  geom = {};
});

test("buttons replace the pair and the pin; the answer is { button, data }", async () => {
  const d = openForm({ message: "Save changes?", fields: [{ name: "note", value: "n" }],
    buttons: [{ label: "Cancel", cancel: true }, { label: "Discard", submit: false }, { label: "Save", default: true }] });
  assert.deepEqual(buttonsOf(d).map((b) => [b.textContent, b.className]),
    [["Cancel", "mkui-btn"], ["Discard", "mkui-btn"], ["Save", "mkui-btn mkui-btn-primary"]]);
  assert.deepEqual(d.ws._frameEls.get(d.ws._frames[0].id)._extraControls(), [], "no pin");
  button(d, "Save").fire("click");
  assert.deepEqual(await d.promise, { button: "save", data: { note: "n" } });
});

test("pin = false drops the pin from a plain form", () => {
  const d = openForm({ pin: false, fields: [{ name: "a" }] });
  assert.deepEqual(d.ws._frameEls.get(d.ws._frames[0].id)._extraControls(), []);
  const e = openForm({ fields: [{ name: "a" }] });
  assert.equal(e.ws._frameEls.get(e.ws._frames[0].id)._extraControls().length, 1);
});

test("a submit = false button answers without validating; the others validate", async () => {
  const spec = { fields: [{ name: "a", required: true }], buttons: [{ label: "Discard", submit: false }, "Save"] };
  const d = openForm(spec);
  button(d, "Save").fire("click");
  assert.equal(await settled(d.promise), false, "a required field holds Save back");
  assert.deepEqual(d.errors(), ["a"]);
  button(d, "Discard").fire("click");
  assert.deepEqual(await d.promise, { button: "discard", data: { a: "" } });
});

test("Cancel, Escape and the pane's cancel all resolve null and run the cancel button's effects", async () => {
  for (const how of ["click", "escape", "hook"]) {
    const fired = [];
    const d = openForm({ message: "?", buttons: [{ label: "No", cancel: true, action: "demo.no", args: { b: "${button}" } }, "Yes"] },
      {}, {}, { fireAction: (...a) => fired.push(a) });
    if (how === "click") button(d, "No").fire("click");
    else if (how === "escape") assert.equal(key(d, "Escape"), true);
    else assert.equal(paneOf(d)._editActions.cancel(), true);
    assert.equal(await d.promise, null);
    assert.deepEqual(fired, [["demo.no", { b: "no" }]], how);
  }
});

test("a button sets state and fires its action after the dialog has answered", async () => {
  const log = [];
  const app = { fireAction: (...a) => log.push(["fire", ...a]), state: { set: (p, v) => log.push(["set", p, v]) } };
  const d = openForm({ fields: [{ name: "qty", type: "number", value: "3" }],
    submit: { then: { action: "demo.then" } },
    buttons: [{ label: "Go", set: { "ui.last": "${qty}", "ui.by": "${button}" }, action: "demo.go", args: { n: "${form.qty}", who: "${user}" } }] },
    { user: "ann" }, {}, app);
  d.promise.then(() => log.push(["resolved"]));
  button(d, "Go").fire("click");
  await d.promise;
  assert.deepEqual(log, [
    ["fire", "demo.then", null],
    ["set", "ui.last", "3"], ["set", "ui.by", "go"],
    ["fire", "demo.go", { n: "3", who: "ann" }],
    ["resolved"],
  ]);
});

test("a button's op stands in for submit.op", async () => {
  const sent = [];
  const client = { send: async (svc, data, opts) => { sent.push([svc, data, opts]); return { type: "ack" }; } };
  const d = openForm({ fields: [{ name: "id", value: "7" }], submit: { service: "orders", op: "save" },
    buttons: [{ label: "Cancel", cancel: true }, { label: "Save" }, { label: "Save & fill", op: "fill" }] }, {}, { client });
  button(d, "Save & fill").fire("click");
  assert.deepEqual(await d.promise, { button: "save & fill", data: { id: "7" } });
  assert.deepEqual(sent, [["orders", { id: "7" }, { op: "fill" }]]);
});

test("a refused send re-enables every button and keeps the dialog open", async () => {
  const client = { send: async () => ({ type: "error", message: "nope" }) };
  const d = openForm({ fields: [], submit: { service: "s" }, buttons: [{ label: "Cancel", cancel: true }, "Go"] }, {}, { client });
  button(d, "Go").fire("click");
  assert.deepEqual(buttonsOf(d).map((b) => b.disabled), [true, true], "busy while sending");
  assert.equal(await settled(d.promise), false);
  assert.deepEqual(buttonsOf(d).map((b) => b.disabled), [false, false]);
  assert.equal(d.footer._ch[0].textContent, "nope");
});

test("Enter presses the default button — Cancel in a danger dialog, never the danger button", async () => {
  const d = openForm({ fields: [{ name: "a" }], buttons: [{ label: "Cancel", cancel: true }, "OK"] });
  key(d, "Enter", { tagName: "INPUT" });
  assert.deepEqual(await d.promise, { button: "ok", data: { a: "" } });

  const x = openForm({ kind: "danger", message: "Delete?", buttons: [{ label: "Cancel", cancel: true }, { label: "Delete", kind: "danger" }] });
  assert.equal(button(x, "Delete").className, "mkui-btn mkui-btn-danger");
  assert.equal(key(x, "Enter", { tagName: "DIV" }, { ctrlKey: true }), true);
  assert.equal(await x.promise, null, "ctrl+Enter is the default too: Cancel");

  const y = openForm({ message: "Delete?", buttons: [{ label: "Delete", kind: "danger" }] });
  key(y, "Enter", { tagName: "DIV" });
  assert.equal(await settled(y.promise), false, "no default: Enter does nothing");
});

test("Enter on a button or a link is the browser's own", async () => {
  const d = openForm({ message: "?", links: [{ href: "/x" }], buttons: [{ label: "Cancel", cancel: true }, "OK"] });
  key(d, "Enter", { tagName: "BUTTON" });
  key(d, "Enter", { tagName: "A" });
  assert.equal(await settled(d.promise), false);
});

test("the focus starts on the default button when no input takes it, and arrows walk the footer", () => {
  const focused = [];
  const d = openForm({ message: "?", buttons: [{ label: "Cancel", cancel: true }, "Maybe", "OK"] });
  for (const b of buttonsOf(d)) b.focus = () => focused.push(b.textContent);
  assert.equal(key(d, "ArrowRight", button(d, "OK")), true);
  assert.equal(key(d, "ArrowLeft", button(d, "OK")), true);
  assert.equal(key(d, "ArrowLeft", button(d, "Cancel")), true);
  assert.deepEqual(focused, ["Cancel", "Maybe", "OK"], "wrapping both ways");
  assert.equal(key(d, "ArrowLeft", { tagName: "INPUT" }), false, "an input keeps its arrows");
});

test("a message box says what it is to a screen reader", () => {
  geom = {};
  const ws = makeWorkspace();
  const attrs = {};
  const addFrame = ws.addFrame.bind(ws);
  ws.addFrame = (spec) => { const id = addFrame(spec); ws._paneEls.get(spec.layout.children[0]).setAttribute = (k, v) => { attrs[k] = v; }; return id; };
  openDialog({ title: "Careful", kind: "danger", message: "x" }, {}, { _element: { workspace: ws } });
  assert.equal(attrs.role, "alertdialog");
  assert.equal(attrs["aria-label"], "Careful");
  assert.match(attrs["aria-describedby"], /^_dialog-\d+-message$/);
});

test("copy takes what the box says: the pane's hook, or a copy button that stays open", async () => {
  const wrote = [];
  const nav = globalThis.navigator ?? (globalThis.navigator = {});
  Object.defineProperty(nav, "clipboard", { value: { writeText: async (t) => { wrote.push(t); } }, configurable: true });
  const d = openForm({ title: "About X", heading: "X 1.2", message: "An app.", facts: [{ label: "mkui", value: "1.8.0" }],
    links: [{ label: "Site", href: "https://x.test" }],
    buttons: [{ label: "Copy details", copy: true }, { label: "Copy id", copy: "id=${id}" }, { label: "OK", cancel: true, default: true }] }, { id: 9 });
  assert.equal(paneOf(d)._editActions.copy(), true);
  button(d, "Copy details").fire("click");
  button(d, "Copy id").fire("click");
  await new Promise((r) => setTimeout(r, 0));
  const whole = "About X\nX 1.2\nAn app.\nmkui: 1.8.0\nSite: https://x.test";
  assert.deepEqual(wrote, [whole, whole, "id=9"]);
  assert.equal(d.footer._ch[0].textContent, "Copied");
  assert.equal(await settled(d.promise), false, "a copy button leaves the dialog open");
  assert.equal(openForm({ fields: [{ name: "a" }] }).ws._paneEls.values().next().value._editActions.copy, undefined, "a plain form has no copy");
});

/* ── Message boxes: enable, arm, timeout, details, suppress, id, live ── */

import { specStatePaths } from "../mkui/static/src/widgets/mkui-dialog.js";
import { State } from "../mkui/static/src/core.js";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function memStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get length() { return store.size; },
    key: (i) => [...store.keys()][i] ?? null,
    getItem: (k) => store.has(k) ? store.get(k) : null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
}

test("specStatePaths: every state path a spec reads, templates and expressions alike", () => {
  const paths = specStatePaths({
    title: "Hi ${state.auth.user}", message: ["${state.mkio.connected}", "plain state.no"],
    facts: [{ label: "L", value: "${state.a.b} ${other}", showWhen: "state.flags.x" }],
    fields: [{ name: "f", compute: "state.c + 1", label: "state.not.an.expr" }],
    buttons: [{ label: "Go", enable: "state.ready && typed == 'X'" }],
  });
  assert.deepEqual([...paths].sort(), ["a.b", "auth.user", "c", "flags.x", "mkio.connected", "ready"]);
});

test("a button's enable follows the form: type the name to delete it", async () => {
  const d = openForm({ kind: "danger", message: "Type ${name} to delete it.",
    fields: [{ name: "typed", label: "Name" }],
    buttons: [{ label: "Cancel", cancel: true }, { label: "Delete", kind: "danger", enable: "typed == name" }] }, { name: "AAPL" });
  assert.equal(button(d, "Delete").disabled, true);
  button(d, "Delete").fire("click");
  assert.equal(await settled(d.promise), false, "a disabled button does not answer");
  d.type("typed", "AAPL");
  assert.equal(button(d, "Delete").disabled, false);
  d.type("typed", "AAP");
  assert.equal(button(d, "Delete").disabled, true);
  d.type("typed", "AAPL");
  button(d, "Delete").fire("click");
  assert.deepEqual(await d.promise, { button: "delete", data: { typed: "AAPL" } });
});

test("Enter does not press a default button its enable has shut", async () => {
  const d = openForm({ fields: [{ name: "ok", type: "checkbox" }], buttons: [{ label: "Cancel", cancel: true }, { label: "Go", enable: "ok" }] });
  key(d, "Enter", { tagName: "INPUT" });
  assert.equal(await settled(d.promise), false);
  d.check("ok", true);
  key(d, "Enter", { tagName: "INPUT" });
  assert.deepEqual(await d.promise, { button: "go", data: { ok: true } });
});

test("arm keeps a button shut, counting down in its label, then opens it", async () => {
  const d = openForm({ kind: "danger", message: "Delete?", buttons: [{ label: "Cancel", cancel: true }, { label: "Delete", kind: "danger", arm: 0.3 }] });
  const del = buttonsOf(d)[1];
  assert.equal(del.disabled, true);
  assert.equal(del.textContent, "Delete (1)");
  assert.equal(buttonsOf(d)[0].disabled, false, "Cancel is never armed");
  await wait(600);
  assert.equal(del.disabled, false);
  assert.equal(del.textContent, "Delete");
  del.fire("click");
  assert.deepEqual(await d.promise, { button: "delete", data: {} });
});

test("timeout presses the default button when it runs out, counting down on it", async () => {
  const d = openForm({ message: "Saved.", timeout: 0.3, buttons: [{ label: "OK", cancel: true, default: true }] });
  assert.equal(buttonsOf(d)[0].textContent, "OK (1)");
  await wait(600);
  assert.equal(await d.promise, null, "the default here is the cancel button: a dismissal");

  const e = openForm({ message: "Continue?", timeout: 0.3, buttons: [{ label: "Cancel", cancel: true }, "Continue"] });
  await wait(600);
  assert.deepEqual(await e.promise, { button: "continue", data: {} });
});

test("a key or a press in the box calls the timeout off", async () => {
  for (const how of ["key", "mouse"]) {
    const d = openForm({ message: "Saved.", timeout: 0.3, buttons: [{ label: "OK", cancel: true, default: true }] });
    if (how === "key") key(d, "Shift", { tagName: "DIV" }); else d.host.fire("mousedown");
    assert.equal(buttonsOf(d)[0].textContent, "OK", how);
    await wait(500);
    assert.equal(await settled(d.promise), false, how);
    key(d, "Escape");
  }
});

test("details fold under the message, copy on their own, and ride the whole copy", async () => {
  const wrote = [];
  const nav = globalThis.navigator ?? (globalThis.navigator = {});
  Object.defineProperty(nav, "clipboard", { value: { writeText: async (t) => { wrote.push(t); } }, configurable: true });
  geom = {};
  const d = openForm({ title: "Failed", kind: "danger", message: "The order was refused.", details: { label: "Server said", text: "E42: ${why}" },
    buttons: [{ label: "OK", cancel: true, default: true }] }, { why: "limit" });
  const box = deep(messageOf(d), "mkui-dialog-details");
  assert.equal(box.classList.contains("mkui-dialog-details-open"), false, "folded at first");
  const toggle = deep(box, "mkui-dialog-details-toggle");
  assert.equal(toggle._ch[1].textContent, "Server said");
  assert.equal(deep(box, "mkui-dialog-details-text").textContent, "E42: limit");
  toggle.fire("click");
  assert.equal(box.classList.contains("mkui-dialog-details-open"), true);
  assert.equal(toggle._attrs["aria-expanded"], "true");
  deep(box, "mkui-dialog-details-copy").fire("click");
  paneOf(d)._editActions.copy();
  await wait(0);
  assert.deepEqual(wrote, ["E42: limit", "Failed\nThe order was refused.\n\nE42: limit"]);

  const blank = openForm({ message: "x", details: "${nope}", buttons: ["OK"] });
  assert.equal(deep(messageOf(blank), "mkui-dialog-details").style.display, "none", "blank details show nothing");
  const open = openForm({ message: "x", details: { text: "t", open: true }, buttons: ["OK"] });
  assert.equal(deep(messageOf(open), "mkui-dialog-details").classList.contains("mkui-dialog-details-open"), true);
});

test("suppress: a ticked box remembers the answer, and the next opening gives it without opening", async () => {
  const storage = memStorage();
  const fired = [];
  const spec = { message: "Fill it?", suppress: "fill", buttons: [{ label: "Cancel", cancel: true }, { label: "Fill", action: "demo.fill" }] };
  const stateSets = [];
  const appExtra = { fireAction: (...a) => fired.push(a), state: { set: (p, v) => stateSets.push([p, v]) } };

  let d = openForm(spec, {}, { storage }, appExtra);
  const box = deep(d.host, "mkui-dialog-suppress");
  assert.equal(box._ch[1].textContent, "Don't ask again");
  box._ch[0].checked = true;
  button(d, "Cancel").fire("click");
  assert.equal(await d.promise, null);
  assert.equal(storage.store.size, 0, "a cancel is never remembered");

  d = openForm(spec, {}, { storage }, appExtra);
  button(d, "Fill").fire("click");
  await d.promise;
  assert.equal(storage.store.size, 0, "nor an answer given with the box unticked");

  d = openForm(spec, {}, { storage }, appExtra);
  deep(d.host, "mkui-dialog-suppress")._ch[0].checked = true;
  button(d, "Fill").fire("click");
  await d.promise;
  assert.deepEqual([...storage.store], [["mkui.suppress.fill", "fill"]]);
  assert.deepEqual(stateSets, [["dialog.suppressed", { fill: "fill" }]], "and the app state hears of it, once");

  geom = {};
  const ws = makeWorkspace();
  const res = await openDialog(spec, {}, { _element: { workspace: ws }, ...appExtra }, { storage });
  assert.deepEqual(res, { button: "fill", data: {}, suppressed: true });
  assert.equal(ws._frames.length, 0, "nothing opened");
  assert.equal(fired.length, 3, "the button's action fires each time, suppressed or not");

  storage.store.set("mkui.suppress.fill", "gone");
  assert.equal(openForm(spec, {}, { storage }).ws._frames.length, 1, "an answer no button gives any more is ignored");
});

test("suppress: a notice's only button is remembered, as a dismissal", async () => {
  const storage = memStorage();
  const spec = { message: "Tip of the day", suppress: { key: "tip", label: "Enough tips" }, buttons: [{ label: "OK", cancel: true, default: true }] };
  const d = openForm(spec, {}, { storage });
  const box = deep(d.host, "mkui-dialog-suppress");
  assert.equal(box._ch[1].textContent, "Enough tips");
  assert.equal(deep(openForm({ ...spec, suppress: "tip2" }, {}, { storage }).host, "mkui-dialog-suppress")._ch[1].textContent, "Don't show this again");
  box._ch[0].checked = true;
  button(d, "OK").fire("click");
  await d.promise;
  assert.equal(storage.store.get("mkui.suppress.tip"), "ok");
  geom = {};
  const ws = makeWorkspace();
  assert.equal(await openDialog(spec, {}, { _element: { workspace: ws } }, { storage }), null);
  assert.equal(ws._frames.length, 0);
  assert.equal(deep(openForm({ message: "no buttons", suppress: "x" }).host, "mkui-dialog-suppress"), undefined, "a plain form has no such box");
});

test("id: firing a dialog again replaces the open one where it stands, quietly", async () => {
  geom = {};
  const ws = makeWorkspace();
  const closed = [];
  ws.closeFrame = (id) => closed.push(id);
  const fired = [];
  const app = { _element: { workspace: ws }, fireAction: (...a) => fired.push(a) };
  const spec = (n) => ({ id: "notice", message: `Retry ${n}`, buttons: [{ label: "OK", cancel: true, action: "demo.dismissed" }] });
  const first = openDialog(spec(1), {}, app);
  ws._frames[0].x = 0.1; ws._frames[0].y = 0.2;   // dragged
  const second = openDialog(spec(2), {}, app);
  assert.equal(await first, null);
  assert.deepEqual(fired, [], "replaced is not dismissed: no cancel effects");
  assert.deepEqual(closed, ["frame-1"]);
  assert.deepEqual([ws._frames[1].x, ws._frames[1].y], [0.1, 0.2], "the new one stands where the old one stood");
  const other = openDialog({ ...spec(3), id: "other" }, {}, app);
  assert.deepEqual(closed, ["frame-1"], "another id stacks");
  void second; void other;
});

test("modal rides the frame spec", () => {
  geom = {};
  const ws = makeWorkspace();
  openDialog({ message: "x", modal: true }, {}, { _element: { workspace: ws } });
  openDialog({ message: "y" }, {}, { _element: { workspace: ws } });
  assert.deepEqual(ws._frames.map((f) => f.modal), [true, false]);
});

test("a box follows the app state it reads while open, and lets go when closed", async () => {
  const state = new State({ mkio: { connected: true }, n: 1 });
  const d = openForm({ message: "${IF(state.mkio.connected, 'Online', 'Offline')}", facts: [{ label: "n", value: "${state.n}" }],
    buttons: [{ label: "Cancel", cancel: true }, { label: "Go", enable: "state.mkio.connected" }] }, { state: state.get() }, {}, { state });
  const para = deep(messageOf(d), "mkui-dialog-para");
  assert.equal(para.textContent, "Online");
  state.set("mkio.connected", false);
  assert.equal(para.textContent, "Offline");
  assert.equal(button(d, "Go").disabled, true);
  state.set("n", 2);
  assert.deepEqual(deep(messageOf(d), "mkui-dialog-facts")._ch.map((c) => c.textContent), ["n", "2"]);
  button(d, "Cancel").fire("click");
  await d.promise;
  assert.equal([...state._subs.values()].reduce((n, set) => n + set.size, 0), 0, "unsubscribed");
});

/* ── A button's own submit: the answer as a transaction ──────────────── */

test("a button's submit sends its own service, op and data; a refusal keeps the box open", async () => {
  const sent = [];
  let refuse = true;
  const client = { send: async (svc, data, opts) => { sent.push([svc, data, opts]); return refuse ? { type: "error", message: "closed" } : { type: "ack" }; } };
  const spec = { message: "Roll ${n} orders?", fields: [{ name: "note", value: "eod" }], submit: { service: "ignored", op: "nope" },
    buttons: [{ label: "No", cancel: true }, { label: "Roll", submit: { service: "orders", op: "roll", data: { desk: "${desk}", by: "${button}", note2: "${note}!" } } }] };
  const d = openForm(spec, { n: 3, desk: "fx" }, { client });
  button(d, "Roll").fire("click");
  assert.equal(await settled(d.promise), false);
  assert.equal(d.footer._ch[0].textContent, "closed");
  assert.deepEqual(sent, [["orders", { note: "eod", desk: "fx", by: "roll", note2: "eod!" }, { op: "roll" }]]);
  refuse = false;
  button(d, "Roll").fire("click");
  assert.deepEqual(await d.promise, { button: "roll", data: { note: "eod" } });

  const e = openForm(spec, { n: 1 }, { client });
  sent.length = 0;
  button(e, "No").fire("click");
  assert.equal(await e.promise, null);
  assert.deepEqual(sent, [], "cancelling sends nothing");
});

test("a button's submit with nobody to send it to says so instead of pretending", async () => {
  const d = openForm({ message: "?", buttons: [{ label: "No", cancel: true }, { label: "Yes", submit: { service: "votes" } }] });
  button(d, "Yes").fire("click");
  assert.equal(await settled(d.promise), false);
  assert.equal(d.footer._ch[0].textContent, "Not connected");
});
