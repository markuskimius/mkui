// Run with: node --test tests/copy.test.js
//
// Clipboard grid serialization: the TSV flavor must match what Excel
// expects on paste (tabs between cells, CRLF between rows, quotes only
// when a value contains tab/newline/quote), and the HTML flavor must be a
// well-formed <table> with values escaped.
import { test } from "node:test";
import assert from "node:assert/strict";

import { tsvQuote, gridToTSV, gridToHTML, escapeHTML, writeGrid, makeCopyStatus, HTML_COPY_MAX_ROWS }
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

test("object cells carry text for TSV and markup for HTML", () => {
  const grid = [["h"], [{ text: "a b", html: "<b>a</b> b" }], ["plain"]];
  assert.equal(gridToTSV(grid), "h\r\na b\r\nplain");
  assert.equal(gridToHTML(grid, 1), "<table><tr><th>h</th></tr><tr><td><b>a</b> b</td></tr><tr><td>plain</td></tr></table>");
  assert.equal(tsvQuote({ text: "a\tb" }), '"a\tb"');
});

test("tabs and newlines survive as-is in HTML cells", () => {
  // This is exactly why the HTML flavor exists: structure is markup, so
  // whitespace inside a value can't split cells.
  assert.equal(
    gridToHTML([["a\tb\nc"]]),
    "<table><tr><td>a\tb\nc</td></tr></table>");
});

/* ── Writing to the clipboard ─────────────────────────────────────────── */
// Both flavors when the browser can take them, plain text when it cannot,
// and an honest answer either way — a caller says "Copied" on the result,
// not on the attempt.

function fakeClipboard({ write, writeText } = {}) {
  const calls = [];
  const clip = {
    calls,
    write: write === null ? undefined : async (items) => {
      calls.push(["write", items[0]]);
      if (write === "throw") throw new Error("denied");
    },
    writeText: writeText === null ? undefined : async (text) => {
      calls.push(["writeText", text]);
      if (writeText === "throw") throw new Error("denied");
    },
  };
  globalThis.navigator = { clipboard: clip };
  globalThis.ClipboardItem = class { constructor(parts) { this.parts = parts; } };
  globalThis.Blob = class { constructor(parts, opts) { this.text = parts.join(""); this.type = opts?.type; } };
  return clip;
}

const GRID = [["", "a"], ["x", "1"]];

test("writeGrid puts both flavors on the clipboard and reports success", async () => {
  const clip = fakeClipboard();
  assert.equal(await writeGrid(GRID, { headerRows: 1 }), true);
  assert.equal(clip.calls.length, 1);
  const [how, item] = clip.calls[0];
  assert.equal(how, "write");
  assert.equal(item.parts["text/plain"].text, "\ta\r\nx\t1");
  assert.equal(item.parts["text/plain"].type, "text/plain");
  assert.match(item.parts["text/html"].text, /<th>a<\/th>/, "headerRows reaches the HTML flavor");
});

test("writeGrid falls back to plain text when the rich write is refused", async () => {
  const clip = fakeClipboard({ write: "throw" });
  assert.equal(await writeGrid(GRID), true);
  assert.deepEqual(clip.calls.map(c => c[0]), ["write", "writeText"]);
  assert.equal(clip.calls[1][1], "\ta\r\nx\t1");
});

test("writeGrid uses plain text where ClipboardItem is missing", async () => {
  const clip = fakeClipboard();
  delete globalThis.ClipboardItem;
  assert.equal(await writeGrid(GRID), true);
  assert.deepEqual(clip.calls.map(c => c[0]), ["writeText"]);
});

test("writeGrid says false when nothing lands, and when there is no clipboard", async () => {
  fakeClipboard({ write: "throw", writeText: "throw" });
  assert.equal(await writeGrid(GRID), false);
  globalThis.navigator = {};
  assert.equal(await writeGrid(GRID), false);
});

test("a grid past the HTML cap goes as plain text alone", async () => {
  const clip = fakeClipboard();
  // Sparse, so the row count is real without a million strings in memory.
  const grid = new Array(HTML_COPY_MAX_ROWS + 1);
  grid[0] = ["a"];
  await writeGrid(grid);
  assert.deepEqual(clip.calls.map(c => c[0]), ["writeText"], "the HTML flavor is what costs memory");
});

/* ── Announcing it ────────────────────────────────────────────────────── */

function fakeState(init = {}) {
  const store = new Map(Object.entries(init));
  return { get: (k) => store.get(k), set: (k, v) => store.set(k, v) };
}

test("makeCopyStatus says so, then puts back what was there", () => {
  const timers = [];
  const realTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => { timers.push(fn); return timers.length; };
  try {
    const state = fakeState({ "status.message": "Connected" });
    const say = makeCopyStatus(state);
    say("Copied 3 rows");
    assert.equal(state.get("status.message"), "Copied 3 rows");
    timers.pop()();
    assert.equal(state.get("status.message"), "Connected");
  } finally {
    globalThis.setTimeout = realTimeout;
  }
});

test("makeCopyStatus keeps the original across back-to-back copies", () => {
  const timers = [];
  const realTimeout = globalThis.setTimeout, realClear = globalThis.clearTimeout;
  globalThis.setTimeout = (fn) => { timers.push(fn); return timers.length; };
  globalThis.clearTimeout = () => {};
  try {
    const state = fakeState({ "status.message": "Connected" });
    const say = makeCopyStatus(state);
    say("Copied 1 row");
    say("Copied 2 rows");
    assert.equal(state.get("status.message"), "Copied 2 rows");
    timers.pop()();
    assert.equal(state.get("status.message"), "Connected", "not the first copy's message");
  } finally {
    globalThis.setTimeout = realTimeout;
    globalThis.clearTimeout = realClear;
  }
});

test("makeCopyStatus leaves a message someone else set alone", () => {
  const timers = [];
  const realTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => { timers.push(fn); return timers.length; };
  try {
    const state = fakeState({ "status.message": "Connected" });
    makeCopyStatus(state)("Copied 1 row");
    state.set("status.message", "Disconnected");   // the connection speaks
    timers.pop()();
    assert.equal(state.get("status.message"), "Disconnected", "the revert defers to it");
  } finally {
    globalThis.setTimeout = realTimeout;
  }
});

test("makeCopyStatus without a state store is a no-op", () => {
  assert.doesNotThrow(() => makeCopyStatus(null)("Copied"));
  assert.doesNotThrow(() => makeCopyStatus({})("Copied"));
});
