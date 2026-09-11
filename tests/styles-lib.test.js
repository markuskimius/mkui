// Run with: node --test tests/styles-lib.test.js
//
// The styler (lib/styles.js): the three shapes a `styles` entry takes, the
// templates inside one, and what `applyStyle` writes to an element. Lifted
// out of `mkio-table` when `mkio-record` needed the same vocabulary, so a
// style map must mean the same thing in a cell and in a field.
import { test } from "node:test";
import assert from "node:assert/strict";

const { compileStyler, applyStyle, STYLE_KEYS, makeRunner } =
  await import("../mkui/static/src/lib/styles.js");
const { expr } = await import("../mkui/static/src/lib/expressions.js");

const scope = (vars) => new expr.Scope(vars, null, false);

// An element as `applyStyle` uses one.
function fakeEl() {
  const el = {
    style: {
      setProperty(k, v) { el.style[k] = v; },
      removeProperty(k) { delete el.style[k]; },
    },
    classList: {
      _s: new Set(),
      add(...cs) { for (const c of cs) this._s.add(c); },
      remove(...cs) { for (const c of cs) this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
  };
  return el;
}

/* ── Compiling ───────────────────────────────────────────────────────── */

test("a plain map is one unconditional rule", () => {
  const f = compileStyler({ bold: true, color: "red" }, "styles.qty");
  assert.deepEqual(f(scope({ value: 1 })), { bold: true, color: "red" });
});

test("rules are first-match-wins, and one without `when` is the fallback", () => {
  const f = compileStyler([
    { when: "value > 100", color: "red" },
    { when: "value > 10", color: "amber" },
    { color: "gray" },
  ], "styles.qty");
  assert.equal(f(scope({ value: 500 })).color, "red");
  assert.equal(f(scope({ value: 50 })).color, "amber");
  assert.equal(f(scope({ value: 1 })).color, "gray");
});

test("no rule matching is no style at all", () => {
  const f = compileStyler([{ when: "value > 100", color: "red" }], "styles.qty");
  assert.equal(f(scope({ value: 1 })), null);
});

test("an expression styler yields a map, and anything else reads as nothing", () => {
  const f = compileStyler("IF(value > 100, { color: 'red' }, NULL)", "styles.qty");
  assert.deepEqual(f(scope({ value: 500 })), { color: "red" });
  assert.equal(f(scope({ value: 1 })), null);
  const notAMap = compileStyler("'red'", "styles.qty");
  assert.equal(notAMap(scope({ value: 1 })), null, "a bare string is not a style map");
});

test("string values may be templates, evaluated against the same scope", () => {
  const f = compileStyler({ color: "${IF(value > 100, 'red', 'green')}", bold: true }, "styles.qty");
  assert.deepEqual(f(scope({ value: 500 })), { bold: true, color: "red" });
  assert.deepEqual(f(scope({ value: 1 })), { bold: true, color: "green" });
});

test("`css` takes raw properties, static and templated together", () => {
  const f = compileStyler({ css: { "border-left": "2px solid red", width: "${value}px" } }, "styles.qty");
  assert.deepEqual(f(scope({ value: 40 })).css, { "border-left": "2px solid red", width: "40px" });
});

test("an empty template value is left out rather than written blank", () => {
  const f = compileStyler({ color: "${NULL}" }, "styles.qty");
  assert.deepEqual(f(scope({ value: 1 })), {});
});

test("only the known style keys are carried", () => {
  const f = compileStyler({ color: "red", nonsense: "x" }, "styles.qty");
  assert.deepEqual(Object.keys(f(scope({ value: 1 }))), ["color"]);
  assert.ok(STYLE_KEYS.includes("background") && STYLE_KEYS.includes("caps"));
});

/* ── Failing gracefully ──────────────────────────────────────────────── */

test("a rule whose condition will not compile warns once and never matches", () => {
  const warned = [];
  const f = compileStyler([{ when: "value >", color: "red" }, { color: "gray" }],
                          "styles.qty", { warn: (m) => warned.push(m) });
  assert.equal(f(scope({ value: 1 })).color, "gray", "the fallback still applies");
  assert.equal(warned.length, 1);
  assert.match(warned[0], /bad style rule in styles\.qty/);
});

test("a styler expression that will not compile styles nothing, and says so", () => {
  const warned = [];
  const f = compileStyler("value >", "styles.qty", { warn: (m) => warned.push(m) });
  assert.equal(f(scope({ value: 1 })), null);
  assert.match(warned[0], /bad styler expression/);
});

test("a condition that fails at run time warns once, however often it runs", () => {
  const warned = [];
  const run = makeRunner((m) => warned.push(m));
  // Compiles fine; throws only once `value` turns out to be a number.
  const f = compileStyler([{ when: "value.missing > 1", color: "red" }, { color: "gray" }],
                          "styles.qty", { warn: (m) => warned.push(m), run });
  for (let i = 0; i < 5; i++) assert.equal(f(scope({ value: 1 })).color, "gray");
  assert.equal(warned.length, 1, "one warning, not one per render");
  assert.match(warned[0], /expression error in styles\.qty\[0\]/);
});

/* ── Applying ────────────────────────────────────────────────────────── */

test("a background never goes inline: it rides the variable and a marker class", () => {
  const el = fakeEl();
  applyStyle(el, { background: "pink", color: "red" }, "--mkui-cell-bg", "mkui-cell-styled");
  assert.equal(el.style["--mkui-cell-bg"], "pink");
  assert.equal(el.style.background, undefined, "the stylesheet decides how it blends with a selection tint");
  assert.equal(el.style.color, "red");
  assert.ok(el.classList.contains("mkui-cell-styled"));
});

test("the text styles map to what CSS calls them", () => {
  const el = fakeEl();
  applyStyle(el, { bold: true, italic: true, underline: true, strike: true, caps: true },
             "--mkui-cell-bg", "mkui-cell-styled");
  assert.equal(el.style.fontWeight, "bold");
  assert.equal(el.style.fontStyle, "italic");
  assert.equal(el.style.textDecoration, "underline line-through");
  assert.equal(el.style.textTransform, "uppercase");
});

test("applying a new style clears everything the last one set", () => {
  const el = fakeEl();
  applyStyle(el, { color: "red", background: "pink", bold: true, class: "hot",
                   css: { "border-left": "2px solid red" } }, "--mkui-cell-bg", "mkui-cell-styled");
  applyStyle(el, { color: "green" }, "--mkui-cell-bg", "mkui-cell-styled");
  assert.equal(el.style.color, "green");
  assert.equal(el.style.fontWeight, "");
  assert.equal(el.style["--mkui-cell-bg"], undefined);
  assert.equal(el.style["border-left"], undefined);
  assert.equal(el.classList.contains("hot"), false, "a rule's own classes go with it");
  assert.equal(el.classList.contains("mkui-cell-styled"), false);
});

test("styling nothing over nothing touches the element not at all", () => {
  const el = fakeEl();
  applyStyle(el, null, "--mkui-cell-bg", "mkui-cell-styled");
  assert.deepEqual(Object.keys(el.style).filter((k) => typeof el.style[k] === "string"), []);
  // ...and clearing a style that was set puts the element back.
  applyStyle(el, { color: "red" }, "--mkui-cell-bg", "mkui-cell-styled");
  applyStyle(el, null, "--mkui-cell-bg", "mkui-cell-styled");
  assert.equal(el.style.color, "");
});

test("custom classes and css properties go on, several at a time", () => {
  const el = fakeEl();
  applyStyle(el, { class: "hot urgent", css: { "border-left": "2px solid red", opacity: "0.5" } },
             "--mkui-row-bg", "mkui-row-styled");
  assert.ok(el.classList.contains("hot") && el.classList.contains("urgent"));
  assert.equal(el.style["border-left"], "2px solid red");
  assert.equal(el.style.opacity, "0.5");
});
