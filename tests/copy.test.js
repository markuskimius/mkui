// Run with: node --test tests/copy.test.js
//
// Clipboard grid serialization: the TSV flavor must match what Excel
// expects on paste (tabs between cells, CRLF between rows, quotes only
// when a value contains tab/newline/quote), and the HTML flavor must be a
// well-formed <table> with values escaped.
import { test } from "node:test";
import assert from "node:assert/strict";

import { tsvQuote, gridToTSV, gridToHTML, escapeHTML }
  from "../mkui/static/src/lib/copy.js";

// ── TSV quoting ─────────────────────────────────────────────────────

test("plain values pass through unquoted", () => {
  assert.equal(tsvQuote("hello"), "hello");
  assert.equal(tsvQuote("12.5"), "12.5");
  assert.equal(tsvQuote(""), "");
  assert.equal(tsvQuote(null), "");
});

test("values with tabs, newlines, or quotes get Excel quoting", () => {
  assert.equal(tsvQuote("a\tb"), '"a\tb"');
  assert.equal(tsvQuote("a\nb"), '"a\nb"');
  assert.equal(tsvQuote('say "hi"'), '"say ""hi"""');
});

test("grid serializes with tab separators and CRLF rows", () => {
  assert.equal(
    gridToTSV([["a", "b"], ["1", "2"]]),
    "a\tb\r\n1\t2");
});

test("single cell grid has no separators", () => {
  assert.equal(gridToTSV([["only"]]), "only");
});

// ── HTML flavor ─────────────────────────────────────────────────────

test("escapeHTML covers &, <, >", () => {
  assert.equal(escapeHTML("<a & b>"), "&lt;a &amp; b&gt;");
});

test("grid becomes a table with td cells", () => {
  assert.equal(
    gridToHTML([["a", "b"], ["1", "2"]]),
    "<table><tr><td>a</td><td>b</td></tr><tr><td>1</td><td>2</td></tr></table>");
});

test("headerRows renders leading rows as th", () => {
  assert.equal(
    gridToHTML([["Name"], ["v"]], 1),
    "<table><tr><th>Name</th></tr><tr><td>v</td></tr></table>");
});

test("HTML flavor escapes cell values", () => {
  assert.equal(
    gridToHTML([["<b>"]]),
    "<table><tr><td>&lt;b&gt;</td></tr></table>");
});

test("tabs and newlines survive as-is in HTML cells", () => {
  // This is exactly why the HTML flavor exists: structure is markup, so
  // whitespace inside a value can't split cells.
  assert.equal(
    gridToHTML([["a\tb\nc"]]),
    "<table><tr><td>a\tb\nc</td></tr></table>");
});
