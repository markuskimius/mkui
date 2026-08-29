// Run with: node --test tests/rich.test.js
//
// Rich cell text: the `rich` expression type, the `mkui` function library,
// and the clipboard HTML renderer. (DOM rendering is covered in table.test.js.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { Rich, isRich, toRich, richText, richToHTML, heat, mixHex } from "../mkui/static/src/lib/rich.js";
import { evalExpr, resolveExpr } from "../mkui/static/src/lib/expressions.js";

test("library functions wrap values into rich segments", () => {
  const r = evalExpr("BOLD('x')", {});
  assert.ok(isRich(r));
  assert.deepEqual(r.segments, [{ text: "x", style: { bold: true } }]);
  assert.equal(richText(evalExpr("COLOR(NUM(1234.5, digits: 2), 'red')", {})), "1234.50");
  assert.deepEqual(evalExpr("COLOR(1, 'red')", {}).segments[0].style, { color: "red" });
});

test("styles compose: nested functions merge onto each segment", () => {
  const r = evalExpr("BOLD(COLOR('x', 'red'))", {});
  assert.deepEqual(r.segments[0].style, { color: "red", bold: true });
  assert.deepEqual(evalExpr("STYLE('x', {italic: TRUE, badge: 'green', bogus: 1})", {}).segments[0].style, { italic: true, badge: "green" });
});

test("+ concatenates rich with strings and rich, both sides", () => {
  const r = evalExpr("BOLD(a) + ' ' + MUTED(b)", { a: "AAPL", b: "XNAS" });
  assert.equal(r.segments.length, 3);
  assert.equal(richText(r), "AAPL XNAS");
  assert.deepEqual(r.segments.map((s) => s.style), [{ bold: true }, {}, { muted: true }]);
  assert.equal(richText(evalExpr("'[' + BOLD('x')", {})), "[x");
});

test("templates keep rich values instead of flattening them", () => {
  const r = resolveExpr("${ICON('check')} ${TITLE(v)} (${n})", { v: "filled", n: 3 });
  assert.ok(isRich(r));
  assert.equal(richText(r), " Filled (3)");
  assert.equal(r.segments[0].icon, "check");
  assert.equal(resolveExpr("${UPPER(v)}!", { v: "a" }), "A!", "plain templates stay strings");
});

test("STR and truthiness see the flattened text", () => {
  assert.equal(evalExpr("STR(BOLD('ab')) + STR(ICON('check'))", {}), "ab");
  assert.equal(evalExpr("BOOL(BOLD(''))", {}), false);
  assert.equal(evalExpr("BOOL(BOLD('x'))", {}), true);
  assert.equal(evalExpr("TYPE(BOLD('x'))", {}), "rich");
  assert.equal(evalExpr("LEN(STR(BOLD('abc')))", {}), 3);
});

test("ICON, BADGE, BAR, LINK produce their segment kinds", () => {
  assert.deepEqual(evalExpr("ICON('clock')", {}).segments, [{ text: "", style: {}, icon: "clock" }]);
  assert.deepEqual(evalExpr("BADGE('Buy', 'green')", {}).segments[0].style, { badge: "green" });
  const bar = evalExpr("BAR(1.5, '#4caf50')", {}).segments[0];
  assert.equal(bar.bar, 1, "clamped to 1");
  assert.equal(bar.color, "#4caf50");
  assert.equal(evalExpr("BAR(-1)", {}).segments[0].bar, 0);
  assert.deepEqual(evalExpr("LINK('docs', 'https://x')", {}).segments[0].style, { href: "https://x" });
});

test("an unknown icon name warns once and renders an empty slot", async () => {
  const { renderRich } = await import("../mkui/static/src/lib/rich.js");
  const children = [];
  globalThis.document = { createElement: (tag) => ({ tagName: tag, style: {}, classList: { add() {} }, appendChild(c) { (this.children ??= []).push(c); }, set textContent(v) { this._t = v; } }) };
  const el = { set textContent(v) { this._t = v; }, appendChild: (c) => children.push(c) };
  const warned = [];
  const orig = console.warn;
  console.warn = (...a) => warned.push(a.join(" "));
  try {
    renderRich(el, evalExpr("ICON('nope') + ICON('nope')", {}));
    assert.equal(children.length, 2);
    assert.equal(warned.filter((w) => w.includes("unknown icon: nope")).length, 1);
  } finally {
    console.warn = orig;
    delete globalThis.document;
  }
});

test("NULL renders as nothing", () => {
  assert.deepEqual(toRich(null).segments, []);
  assert.equal(richText(evalExpr("BOLD(NULL)", {})), "");
});

test("HEAT blends two colors on a scale; NULL passes through", () => {
  assert.equal(heat(0, 0, 10, "#000000", "#ffffff"), "#000000");
  assert.equal(heat(10, 0, 10, "#000000", "#ffffff"), "#ffffff");
  assert.equal(heat(5, 0, 10, "#000000", "#ffffff"), "#808080");
  assert.equal(heat(50, 0, 10, "#000000", "#ffffff"), "#ffffff", "clamped");
  assert.equal(heat(null, 0, 10), null);
  assert.equal(mixHex("#ff0000", "#0000ff", 0.5), "#800080");
  assert.equal(evalExpr("HEAT(2, 0, 4)", {}), mixHex("#1b2a3a", "#e05252", 0.5));
  assert.equal(evalExpr("HEAT(1, 0, 1, 'red', 'blue')", {}), null, "bad color → error → null (warned)");
});

test("richToHTML emits inline-styled spans and drops icons and bars", () => {
  const r = evalExpr("ICON('check') + BOLD('a<b') + COLOR(' c', 'red') + BADGE('x', 'green') + LINK('d', 'https://x?a=1&b=2') + BAR(0.5) + 'plain'", {});
  assert.equal(richToHTML(r),
    '<span style="font-weight:bold">a&lt;b</span><span style="color:red"> c</span>' +
    '<span style="background:#4caf50;color:#fff;border-radius:8px;padding:0 6px">x</span>' +
    '<a href="https://x?a=1&amp;b=2">d</a>plain');
});
