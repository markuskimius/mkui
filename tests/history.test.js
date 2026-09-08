// Run with: node --test tests/history.test.js
//
// lib/history.js is DOM-free, so the whole of it is testable here: the
// naming convention, the `_mkio` capability read, the `history` pane-spec
// parser, and the logic over a record's chain of versions.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HISTORY_SUFFIX, historyTable, isHistoryTable,
  MKIO_FIELDS, SHOWABLE_COLUMNS, MKIO_LABELS,
  historyCapabilities, parseHistorySpec,
  parseChain, cursorOf, diffVersions, changedOnly, sameValue, blame,
} from "../mkui/static/src/lib/history.js";

// Collects the warnings a parse emits instead of printing them.
function warner() {
  const msgs = [];
  const warn = (m) => msgs.push(m);
  warn.msgs = msgs;
  return warn;
}

/* ── Naming convention ────────────────────────────────────────────────── */

test("historyTable follows mkio's convention", () => {
  assert.equal(HISTORY_SUFFIX, "__history");
  assert.equal(historyTable("orders"), "orders__history");
  assert.equal(historyTable("orders", "_hist"), "orders_hist");
});

test("isHistoryTable matches only a trailing suffix", () => {
  assert.ok(isHistoryTable("orders__history"));
  assert.ok(!isHistoryTable("history_of_orders"));
  assert.ok(!isHistoryTable("__history"), "the suffix alone is not a history table");
  assert.ok(!isHistoryTable(null));
});

/* ── Showable mkio columns ────────────────────────────────────────────── */

test("the showable mkio columns are the data ones, never the identity ones", () => {
  assert.ok(SHOWABLE_COLUMNS.has("_mkio_version"));
  assert.ok(SHOWABLE_COLUMNS.has("_mkio_op"));
  assert.ok(SHOWABLE_COLUMNS.has("_mkio_user"));
  assert.ok(SHOWABLE_COLUMNS.has("_mkio_service"));
  assert.ok(SHOWABLE_COLUMNS.has("_mkio_ref"), "a stream row's ref is its timestamp");
  assert.ok(!SHOWABLE_COLUMNS.has("_mkio_row"));
  assert.ok(!SHOWABLE_COLUMNS.has("_mkio_topic"));
  for (const col of SHOWABLE_COLUMNS) assert.ok(MKIO_LABELS[col], `${col} has a default label`);
  assert.equal(MKIO_FIELDS.version, "_mkio_version");
});

/* ── Capability read ──────────────────────────────────────────────────── */

test("historyCapabilities reads the versioned tables and the suffix", () => {
  const caps = historyCapabilities({ versioned: ["orders", "trades"], history_suffix: "__history" });
  assert.deepEqual(caps, { versioned: ["orders", "trades"], suffix: "__history" });
});

test("historyCapabilities defaults the suffix and drops non-names", () => {
  const caps = historyCapabilities({ versioned: ["orders", 7, ""] });
  assert.deepEqual(caps, { versioned: ["orders"], suffix: "__history" });
});

test("historyCapabilities returns null when the reply cannot say", () => {
  // An older server, and the limited reply an unauthenticated client gets
  // from a server with auth on — neither means "nothing is versioned".
  assert.equal(historyCapabilities({ name: "srv", protocol: "1.0" }), null);
  assert.equal(historyCapabilities(null), null);
  assert.equal(historyCapabilities("no"), null);
  // An empty list, though, is an answer.
  assert.deepEqual(historyCapabilities({ versioned: [] }), { versioned: [], suffix: "__history" });
});

/* ── The `history` block ──────────────────────────────────────────────── */

test("parseHistorySpec normalizes a full block", () => {
  const warn = warner();
  const h = parseHistorySpec({
    table: "orders",
    key: "id",
    versions: "order_versions",
    state: "order_state",
    feed: "order_history",
    undo: { service: "orders", op: "undo_order" },
    redo: "orders",
    columns: ["qty", "price"],
    fields: { version: "v" },
    confirm: false,
  }, { warn });
  assert.deepEqual(warn.msgs, []);
  assert.deepEqual(h, {
    table: "orders",
    key: ["id"],
    versions: "order_versions",
    state: "order_state",
    feed: "order_history",
    undo: { service: "orders", op: "undo_order", label: "Undo" },
    redo: { service: "orders", op: "redo", label: "Redo" },
    columns: ["qty", "price"],
    fields: { version: "v" },
    confirm: false,
  });
});

test("parseHistorySpec: no block is not a warning", () => {
  const warn = warner();
  for (const v of [undefined, null, "", false]) assert.equal(parseHistorySpec(v, { warn }), null);
  assert.deepEqual(warn.msgs, []);
});

test("parseHistorySpec rejects a non-table block", () => {
  const warn = warner();
  assert.equal(parseHistorySpec(["orders"], { warn }), null);
  assert.equal(parseHistorySpec("orders", { warn }), null);
  assert.equal(warn.msgs.length, 2);
  assert.match(warn.msgs[0], /^bad history:/);
});

test("parseHistorySpec defaults: everything optional, confirm on", () => {
  const warn = warner();
  const h = parseHistorySpec({}, { warn });
  assert.deepEqual(warn.msgs, []);
  assert.equal(h.confirm, true, "undo confirms unless the config says not to");
  assert.equal(h.versions, null);
  assert.equal(h.undo, null);
  assert.deepEqual(h.fields, {});
});

test("parseHistorySpec: a bad key is dropped, the rest survives", () => {
  const warn = warner();
  const h = parseHistorySpec({ versions: "order_versions", undo: 42, key: [7] }, { warn });
  assert.equal(h.versions, "order_versions", "a broken undo does not take history down with it");
  assert.equal(h.undo, null);
  assert.equal(h.key, null);
  assert.equal(warn.msgs.length, 2);
  assert.match(warn.msgs.join("\n"), /bad history\.undo/);
  assert.match(warn.msgs.join("\n"), /bad history\.key/);
});

test("parseHistorySpec warns on an unknown key", () => {
  const warn = warner();
  parseHistorySpec({ undoo: "orders" }, { warn });
  assert.deepEqual(warn.msgs, ["bad history: unknown key 'undoo'"]);
});

test("parseHistorySpec: undo/redo shapes", () => {
  const warn = warner();
  assert.deepEqual(parseHistorySpec({ undo: "orders" }, { warn }).undo, { service: "orders", op: "undo", label: "Undo" });
  assert.deepEqual(parseHistorySpec({ redo: "orders" }, { warn }).redo, { service: "orders", op: "redo", label: "Redo" });
  assert.deepEqual(parseHistorySpec({ undo: { service: "o", op: "back" } }, { warn }).undo, { service: "o", op: "back", label: "Undo" });
  assert.deepEqual(parseHistorySpec({ undo: { service: "o", label: "Revert" } }, { warn }).undo, { service: "o", op: "undo", label: "Revert" });
  assert.equal(parseHistorySpec({ undo: false }, { warn }).undo, null, "false switches a direction off");
  assert.deepEqual(warn.msgs, []);
  assert.equal(parseHistorySpec({ undo: { op: "back" } }, { warn }).undo, null);
  assert.equal(warn.msgs.length, 1);
});

test("parseHistorySpec: fields takes only known roles", () => {
  const warn = warner();
  const h = parseHistorySpec({ fields: { version: "v", user: "who", nope: "x", op: 3 } }, { warn });
  assert.deepEqual(h.fields, { version: "v", user: "who" });
  assert.equal(warn.msgs.length, 2);
});

test("parseHistorySpec: a service name must be a string", () => {
  const warn = warner();
  const h = parseHistorySpec({ versions: 3, state: "", feed: "tape" }, { warn });
  assert.equal(h.versions, null);
  assert.equal(h.state, null, "an empty name is no service, not an error");
  assert.equal(h.feed, "tape");
  assert.equal(warn.msgs.length, 1);
});

/* ── The chain ────────────────────────────────────────────────────────── */

const hrow = (version, op, user, values, extra = {}) => ({
  _mkio_version: version, _mkio_op: op, _mkio_user: user,
  _mkio_ref: `2026090${version} 09:00:00.000000000000`, _mkio_service: "orders",
  ...values, ...extra,
});

const chainRows = [
  hrow(2, "update", "alice", { id: "O1", qty: 750, status: "accepted" }),
  hrow(1, "insert", "alice", { id: "O1", qty: 500, status: "pending" }),
  hrow(3, "update", "bob",   { id: "O1", qty: 750, status: "filled" }),
];

test("parseChain sorts ascending and splits meta from source columns", () => {
  const chain = parseChain(chainRows);
  assert.deepEqual(chain.versions.map((v) => v.version), [1, 2, 3]);
  assert.equal(chain.bottom, 1);
  assert.equal(chain.top, 3);
  assert.deepEqual(chain.gaps, []);
  assert.equal(chain.dropped, 0);
  assert.deepEqual(chain.columns, ["id", "qty", "status"], "the _mkio_ fields are not source columns");
  const v2 = chain.byVersion.get(2);
  assert.deepEqual(v2.values, { id: "O1", qty: 750, status: "accepted" });
  assert.equal(v2.op, "update");
  assert.equal(v2.user, "alice");
  assert.equal(v2.service, "orders");
  assert.ok(v2.ref.startsWith("2026"));
  assert.equal(v2.row._mkio_version, 2, "the raw row is kept for expression scopes");
});

test("parseChain falls back to the bare names a reply block gives", () => {
  // [services.order_versions.reply] renames the meta columns on the way
  // out — version = "_mkio_version", user = "_mkio_user ?? '(system)'".
  const chain = parseChain([
    { version: 1, op: "insert", user: "alice", time: "09:15", qty: 500 },
    { version: 2, op: "update", user: "bob", time: "09:20", qty: 750 },
  ]);
  assert.deepEqual(chain.versions.map((v) => v.version), [1, 2]);
  assert.equal(chain.byVersion.get(2).user, "bob");
  assert.deepEqual(chain.columns, ["time", "qty"], "only the five meta roles are stripped");
});

test("parseChain takes a configured field name over both", () => {
  const chain = parseChain([{ v: 3, qty: 1, version: 99 }], { fields: { version: "v" } });
  assert.equal(chain.top, 3);
  assert.deepEqual(chain.columns, ["qty", "version"], "the unnamed 'version' is now just a column");
});

test("parseChain: string version numbers, duplicates, and junk", () => {
  const chain = parseChain([
    { _mkio_version: "2", qty: 2 },
    { _mkio_version: "1", qty: 1 },
    { _mkio_version: 2, qty: 22 },      // a later row for the same version wins
    { _mkio_version: null, qty: 0 },
    { qty: 0 },
    null,
  ]);
  assert.deepEqual(chain.versions.map((v) => v.version), [1, 2]);
  assert.equal(chain.byVersion.get(2).values.qty, 22);
  assert.equal(chain.dropped, 3);
});

test("parseChain reports the gaps an archive left", () => {
  const chain = parseChain([hrow(1, "insert", "a", {}), hrow(5, "update", "a", {}), hrow(6, "update", "a", {})]);
  assert.deepEqual(chain.gaps, [[2, 4]]);
  assert.equal(chain.bottom, 1);
  assert.equal(chain.top, 6);
});

test("parseChain of nothing is an empty chain", () => {
  const chain = parseChain([]);
  assert.deepEqual(chain.versions, []);
  assert.equal(chain.top, 0);
  assert.equal(chain.bottom, 0);
  assert.deepEqual(chain.columns, []);
  assert.deepEqual(parseChain(undefined).versions, []);
});

/* ── The cursor ───────────────────────────────────────────────────────── */

test("cursorOf: mid-chain, the row can step both ways", () => {
  const c = cursorOf(parseChain(chainRows), 2);
  assert.equal(c.current, 2);
  assert.equal(c.top, 3);
  assert.equal(c.at.op, "update");
  assert.ok(c.canUndo);
  assert.ok(c.canRedo);
  assert.equal(c.ahead, 1, "one version left to redo onto");
  assert.equal(c.behind, 1);
});

test("cursorOf: at the top there is nothing to redo", () => {
  const c = cursorOf(parseChain(chainRows), 3);
  assert.ok(c.canUndo);
  assert.ok(!c.canRedo);
  assert.equal(c.ahead, 0);
});

test("cursorOf: at version 1 undo deletes the row", () => {
  const c = cursorOf(parseChain(chainRows), 1);
  assert.ok(c.canUndo, "mkio removes the row and keeps its versions");
  assert.ok(c.canRedo);
  assert.equal(c.behind, 0);
});

test("cursorOf: an absent row sits at 0 and can only be rebuilt", () => {
  for (const absent of [null, undefined, 0, ""]) {
    const c = cursorOf(parseChain(chainRows), absent);
    assert.equal(c.current, 0);
    assert.equal(c.at, null);
    assert.ok(!c.canUndo);
    assert.ok(c.canRedo, "redo rebuilds it at version 1");
    assert.equal(c.ahead, 3);
  }
});

test("cursorOf: an archived predecessor blocks undo", () => {
  const chain = parseChain([hrow(1, "insert", "a", {}), hrow(4, "update", "a", {}), hrow(5, "update", "a", {})]);
  const c = cursorOf(chain, 4);
  assert.ok(!c.canUndo, "version 3 is in a CSV somewhere; there is nothing to step onto");
  assert.ok(c.canRedo);
});

test("cursorOf: an unloaded chain claims nothing", () => {
  const c = cursorOf(parseChain([]), 3);
  assert.ok(!c.canUndo);
  assert.ok(!c.canRedo);
  assert.equal(c.top, 0);
});

/* ── Diffs ────────────────────────────────────────────────────────────── */

test("sameValue compares numbers as numbers and blanks as blanks", () => {
  assert.ok(sameValue(1, "1.0"), "SQLite hands the same number back either way");
  assert.ok(sameValue("500", 500));
  assert.ok(sameValue(null, ""));
  assert.ok(sameValue(undefined, null));
  assert.ok(!sameValue(0, ""), "zero is a value, blank is not");
  assert.ok(!sameValue("a", "b"));
  assert.ok(sameValue("a", "a"));
});

test("diffVersions classifies each field", () => {
  const chain = parseChain(chainRows);
  const d = diffVersions(chain.byVersion.get(2), chain.byVersion.get(3));
  assert.deepEqual(d, [
    { col: "id", from: "O1", to: "O1", kind: "same" },
    { col: "qty", from: 750, to: 750, kind: "same" },
    { col: "status", from: "accepted", to: "filled", kind: "changed" },
  ]);
  assert.deepEqual(changedOnly(d).map((x) => x.col), ["status"]);
});

test("diffVersions: set and cleared", () => {
  const d = diffVersions({ values: { a: "", b: "x", c: 1 } }, { values: { a: "y", b: null, c: 1 } });
  assert.deepEqual(d.map((x) => x.kind), ["set", "cleared", "same"]);
});

test("diffVersions against nothing reads as an insert", () => {
  const chain = parseChain(chainRows);
  const d = changedOnly(diffVersions(null, chain.byVersion.get(1)));
  assert.deepEqual(d.map((x) => x.col), ["id", "qty", "status"]);
  assert.ok(d.every((x) => x.kind === "set"));
  const gone = changedOnly(diffVersions(chain.byVersion.get(1), null));
  assert.ok(gone.every((x) => x.kind === "cleared"));
});

test("diffVersions takes plain value maps and a column list", () => {
  const d = diffVersions({ qty: 1, note: "x" }, { qty: 2, note: "y" }, ["qty"]);
  assert.deepEqual(d, [{ col: "qty", from: 1, to: 2, kind: "changed" }]);
});

test("diffVersions unions the columns of both sides, in order", () => {
  const d = diffVersions({ a: 1, b: 2 }, { b: 2, c: 3 });
  assert.deepEqual(d.map((x) => x.col), ["a", "b", "c"]);
});

/* ── Blame ────────────────────────────────────────────────────────────── */

test("blame reports the version that last set each field", () => {
  const b = blame(parseChain(chainRows));
  assert.equal(b.id.version, 1);
  assert.equal(b.id.user, "alice");
  assert.equal(b.qty.version, 2, "qty last moved at v2, and v3 left it alone");
  assert.deepEqual([b.qty.from, b.qty.to], [500, 750]);
  assert.equal(b.status.version, 3);
  assert.equal(b.status.user, "bob");
  assert.equal(b.status.op, "update");
});

test("blame stops at the cursor, so a redo branch is not credited", () => {
  const b = blame(parseChain(chainRows), { upto: 2 });
  assert.equal(b.status.version, 2);
  assert.equal(b.status.to, "accepted");
});

test("blame leaves a never-set column unblamed", () => {
  const chain = parseChain([hrow(1, "insert", "a", { id: "O1", note: "" }), hrow(2, "update", "a", { id: "O1", note: null })]);
  assert.equal(blame(chain).note, null);
  assert.equal(blame(chain).id.version, 1);
});

test("blame takes an explicit column list", () => {
  const b = blame(parseChain(chainRows), { columns: ["status"] });
  assert.deepEqual(Object.keys(b), ["status"]);
});

/* ── Capability wiring in <mkui-app> ──────────────────────────────────── */
// <mkui-app> can't be instantiated here (it needs the DOM), so guard the
// wiring at the source: the `_mkio` reply is the only place the client
// learns what the server records, and with auth on it has to be asked
// again after the login, since the pre-login reply does not say.

const appSrc = await (async () => {
  const { readFileSync } = await import("node:fs");
  return readFileSync(new URL("../mkui/static/src/components/app.js", import.meta.url), "utf8");
})();

test("the verify reply is where capabilities are captured", () => {
  assert.match(appSrc, /st\.set\("mkio\.server\.mkio",\s+info\.mkio\s+\?\? null\);\n\s*capture\(info\);/);
  assert.match(appSrc, /const caps = historyCapabilities\(info\);\n\s*if \(caps\) \{/);
  assert.match(appSrc, /st\.set\("mkio\.server\.versioned", caps\.versioned\);/);
  assert.match(appSrc, /st\.set\("mkio\.server\.historySuffix", caps\.suffix\);/);
  assert.match(appSrc, /if \(info\.services && typeof info\.services === "object"\) st\.set\("mkio\.server\.services", info\.services\);/);
});

test("with auth on, the capabilities are probed after login and on every reconnect", () => {
  assert.match(appSrc, /if \(!hasAuth\) this\._verify\(client\);\n\s*else if \(st\.get\("auth\.authenticated"\)\) this\._probe\(client\);/);
  assert.match(appSrc, /if \(this\._probe && config\.mkio\?\.url\) this\._probe\(client \?\? await ensureMkio\(config\.mkio\.url\)\);/);
});
