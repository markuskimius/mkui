// Run with: node --test tests/subject.test.js
//
// The record subject (lib/subject.js): parsing the four modes, value
// coercion off the hub, the pin, retain, merging, and the follower's
// behaviour against a real LinkHub.
import { test } from "node:test";
import assert from "node:assert/strict";

const {
  parseRecordSpec, recordSpecToConfig, mergeRecordSpec, sameSubject,
  coerce, describeRecord, RecordFollower, MODES,
} = await import("../mkui/static/src/lib/subject.js");
const { LinkHub } = await import("../mkui/static/src/lib/links.js");
const { State } = await import("../mkui/static/src/core.js");

/* ── Parsing ─────────────────────────────────────────────────────────── */

test("a bare string is follow", () => {
  const s = parseRecordSpec("orders");
  assert.equal(s.mode, "follow");
  assert.equal(s.follow, "orders");
  assert.equal(s.listening, true);
  assert.equal(s.retain, false);
});

test("nothing at all is no mode", () => {
  for (const v of [null, "", undefined]) assert.equal(parseRecordSpec(v).mode, null);
});

test("listen takes a column name or { column, type }", () => {
  const s = parseRecordSpec({ listen: { order_id: "id", book: { column: "book", type: "string" } } });
  assert.equal(s.mode, "listen");
  assert.deepEqual(s.listen.order_id, { column: "id", type: "auto" });
  assert.deepEqual(s.listen.book, { column: "book", type: "string" });
});

test("state, key, and the flags", () => {
  assert.equal(parseRecordSpec({ state: "sel.order" }).mode, "state");
  const k = parseRecordSpec({ key: { id: 7 }, retain: true, listening: false, title: "#${id}" });
  assert.equal(k.mode, "key");
  assert.deepEqual(k.key, { id: 7 });
  assert.equal(k.retain, true);
  assert.equal(k.listening, false);
  assert.equal(k.title, "#${id}");
});

test("two modes at once is an error, as is a bad type or flag", () => {
  assert.throws(() => parseRecordSpec({ follow: "orders", state: "x" }), /pick one/);
  assert.throws(() => parseRecordSpec({ listen: { a: { column: "c", type: "date" } } }), /bad type/);
  assert.throws(() => parseRecordSpec({ follow: 7 }), /pane id/);
  assert.throws(() => parseRecordSpec({ retain: "yes" }), /true or false/);
  assert.throws(() => parseRecordSpec([1, 2]), /expected/);
});

test("an empty listen map names no mode", () => {
  assert.equal(parseRecordSpec({ listen: { a: "" } }).mode, null);
});

test("config round-trips", () => {
  for (const spec of [
    "orders",
    { listen: { order_id: "id" }, retain: true },
    { listen: { book: { column: "book", type: "string" } } },
    { state: "sel.order", listening: false },
    { key: { id: 4711 }, title: "Order ${id}" },
  ]) {
    const parsed = parseRecordSpec(spec);
    assert.deepEqual(parseRecordSpec(recordSpecToConfig(parsed)), parsed);
  }
});

/* ── Merging ─────────────────────────────────────────────────────────── */

test("merge changes only the keys given", () => {
  const base = parseRecordSpec({ listen: { order_id: "id" }, retain: true });
  const paused = mergeRecordSpec(base, { listening: false });
  assert.equal(paused.mode, "listen");
  assert.deepEqual(Object.keys(paused.listen), ["order_id"]);
  assert.equal(paused.retain, true);
  assert.equal(paused.listening, false);
});

test("merge adds and drops listen names", () => {
  const base = parseRecordSpec({ listen: { order_id: "id" } });
  const two = mergeRecordSpec(base, { listen: { book: "book" } });
  assert.deepEqual(Object.keys(two.listen).sort(), ["book", "order_id"]);
  const gone = mergeRecordSpec(two, { listen: { order_id: null } });
  assert.deepEqual(Object.keys(gone.listen), ["book"]);
});

test("merging a different mode replaces the old one", () => {
  const base = parseRecordSpec({ listen: { order_id: "id" } });
  const followed = mergeRecordSpec(base, { follow: "orders" });
  assert.equal(followed.mode, "follow");
  assert.deepEqual(followed.listen, {});
});

/* ── Coercion ────────────────────────────────────────────────────────── */

test("hub strings become numbers only when they round-trip", () => {
  assert.equal(coerce("4711", "auto"), 4711);
  assert.equal(coerce("007", "auto"), "007");   // an id, not seven
  assert.equal(coerce("1e5", "auto"), "1e5");
  assert.equal(coerce("4711", "string"), "4711");
  assert.equal(coerce("abc", "number"), "abc"); // unparseable: left alone
  assert.equal(coerce("true", "boolean"), true);
  assert.equal(coerce(null, "auto"), null);
});

/* ── The follower ────────────────────────────────────────────────────── */

const listener = () => {
  const seen = [];
  return { seen, fn: (r) => seen.push(r) };
};

test("listen: a broadcast becomes the record, a retraction empties it", () => {
  const hub = new LinkHub();
  const f = new RecordFollower({ spec: parseRecordSpec({ listen: { order_id: "id" } }), hub });
  const { seen, fn } = listener();
  f.on(fn);
  f.start();
  hub.publish("orders", { order_id: ["4711"] });
  assert.deepEqual(f.record.key, { id: 4711 });
  assert.equal(f.record.from, "listen");
  hub.publish("orders", { order_id: null });
  assert.equal(f.record, null);
  assert.equal(seen.length, 2);
});

test("listen: a window opened after the broadcast catches up at once", () => {
  const hub = new LinkHub();
  hub.publish("orders", { order_id: ["4711"] });
  const f = new RecordFollower({ spec: parseRecordSpec({ listen: { order_id: "id" } }), hub }).start();
  assert.deepEqual(f.record.key, { id: 4711 });
});

test("listen: several values show the first and count the rest", () => {
  const hub = new LinkHub();
  const f = new RecordFollower({ spec: parseRecordSpec({ listen: { order_id: "id" } }), hub }).start();
  hub.publish("orders", { order_id: ["1", "2", "3"] });
  assert.deepEqual(f.record.key, { id: 1 });
  assert.equal(f.record.of, 3);
});

test("listen: a composite key waits for every name", () => {
  const hub = new LinkHub();
  const f = new RecordFollower({
    spec: parseRecordSpec({ listen: { book: "book", order_id: "id" } }), hub,
  }).start();
  hub.publish("orders", { book: ["EU"] });
  assert.equal(f.record, null, "half a key is not a key");
  hub.publish("orders", { order_id: ["4711"] });
  assert.deepEqual(f.record.key, { book: "EU", id: 4711 });
});

test("retain keeps the last record when the broadcast retracts", () => {
  const hub = new LinkHub();
  const f = new RecordFollower({
    spec: parseRecordSpec({ listen: { order_id: "id" }, retain: true }), hub,
  }).start();
  hub.publish("orders", { order_id: ["4711"] });
  hub.publish("orders", { order_id: null });
  assert.deepEqual(f.record.key, { id: 4711 });
});

test("the pin freezes the window: deliveries arrive and are ignored", () => {
  const hub = new LinkHub();
  const f = new RecordFollower({ spec: parseRecordSpec({ listen: { order_id: "id" } }), hub }).start();
  hub.publish("orders", { order_id: ["1"] });
  f.setSpec({ listening: false }, { merge: true });
  hub.publish("orders", { order_id: ["2"] });
  assert.deepEqual(f.record.key, { id: 1 }, "still on the pinned record");
  f.setSpec({ listening: true }, { merge: true });
  assert.deepEqual(f.record.key, { id: 2 }, "unpinning catches up with the world");
});

test("a refresh does not undo the pin, or `retain`", () => {
  const hub = new LinkHub();
  const pinned = new RecordFollower({ spec: parseRecordSpec({ listen: { order_id: "id" } }), hub }).start();
  hub.publish("orders", { order_id: ["1"] });
  pinned.setSpec({ listening: false }, { merge: true });
  hub.publish("orders", { order_id: null });
  pinned.refresh();
  assert.deepEqual(pinned.record.key, { id: 1 }, "still pinned to its record");

  const kept = new RecordFollower({
    spec: parseRecordSpec({ listen: { order_id: "id" }, retain: true }), hub,
  }).start();
  hub.publish("orders", { order_id: ["2"] });
  hub.publish("orders", { order_id: null });
  kept.refresh();
  assert.deepEqual(kept.record.key, { id: 2 });
});

test("a refresh with nothing to show emits, so an empty window can say so", () => {
  const hub = new LinkHub();
  const f = new RecordFollower({ spec: parseRecordSpec({ listen: { order_id: "id" } }), hub }).start();
  const { seen, fn } = listener();
  f.on(fn);
  f.refresh();
  assert.deepEqual(seen, [null], "the pane is told, and renders what it is waiting for");
});

test("set puts a record on show whatever the mode, until the next delivery", () => {
  const hub = new LinkHub();
  const f = new RecordFollower({ spec: parseRecordSpec({ listen: { order_id: "id" } }), hub }).start();
  f.set({ id: 99 });
  assert.equal(f.record.from, "manual");
  assert.deepEqual(f.record.key, { id: 99 });
  hub.publish("orders", { order_id: ["1"] });
  assert.deepEqual(f.record.key, { id: 1 });
});

test("follow: the first selected row of another pane", () => {
  let notify = null;
  let rows = [];
  const panes = {
    on: (id, fn) => { notify = fn; return () => { notify = null; }; },
    rows: () => rows,
  };
  const f = new RecordFollower({ spec: parseRecordSpec("orders"), panes }).start();
  assert.equal(f.record, null);
  rows = [{ id: 1 }, { id: 2 }];
  notify();
  assert.equal(f.record.row.id, 1);
  assert.equal(f.record.of, 2);
  assert.equal(f.record.from, "follow");
  f.stop();
  assert.equal(notify, null, "stop releases the subscription");
});

test("state: a row published into app state", () => {
  const state = new State({});
  const f = new RecordFollower({ spec: parseRecordSpec({ state: "sel.order" }), state }).start();
  assert.equal(f.record, null);
  state.set("sel.order", { id: 3 });
  assert.equal(f.record.row.id, 3);
  state.set("sel.order", null);
  assert.equal(f.record, null);
});

test("key: pinned at the start and never moved", () => {
  const hub = new LinkHub();
  const f = new RecordFollower({ spec: parseRecordSpec({ key: { id: 4711 } }), hub }).start();
  assert.deepEqual(f.record.key, { id: 4711 });
  hub.publish("orders", { order_id: ["1"] });
  assert.deepEqual(f.record.key, { id: 4711 });
});

test("setSpec rejects a bad spec and keeps the old one", () => {
  const warned = [];
  const f = new RecordFollower({ spec: parseRecordSpec("orders"), warn: (m) => warned.push(m) });
  assert.equal(f.setSpec({ follow: 7 }), false);
  assert.equal(f.spec.follow, "orders");
  assert.match(warned[0], /bad record/);
});

/* ── Odds and ends ───────────────────────────────────────────────────── */

test("sameSubject compares keys by value and rows by identity", () => {
  const row = { id: 1 };
  assert.equal(sameSubject({ key: { id: 1 }, of: 1, from: "listen" },
                           { key: { id: "1" }, of: 1, from: "listen" }), true);
  assert.equal(sameSubject({ key: { id: 1 }, of: 1, from: "listen" },
                           { key: { id: 2 }, of: 1, from: "listen" }), false);
  assert.equal(sameSubject({ row, of: 1, from: "follow" }, { row, of: 1, from: "follow" }), true);
  assert.equal(sameSubject({ row, of: 1, from: "follow" }, { row: { ...row }, of: 1, from: "follow" }), false);
  // Two empty subjects are unchanged, which is what stops a retraction
  // re-emitting into an already-empty window.
  assert.equal(sameSubject(null, null), true);
  assert.equal(sameSubject(null, { row, of: 1, from: "follow" }), false);
});

test("the chip says what it is following and whether it is pinned", () => {
  const s = parseRecordSpec({ listen: { order_id: "id" } });
  const d = describeRecord(s, { of: 3, from: "listen" });
  assert.equal(d.text, "Listen: order_id");
  assert.equal(d.on, true);
  assert.match(d.title, /3 records broadcast/);
  const pinned = describeRecord(parseRecordSpec({ listen: { order_id: "id" }, listening: false }));
  assert.match(pinned.title, /pinned/i);
  assert.equal(describeRecord(parseRecordSpec("orders")).text, "Follows: orders");
  assert.equal(describeRecord(parseRecordSpec({ key: { id: 7 } })).text, "Pinned: 7");
  assert.equal(describeRecord(parseRecordSpec(null)), null);
});

test("MODES is the list the parser accepts", () => {
  assert.deepEqual(MODES, ["follow", "listen", "state", "key"]);
});

/* ── The configure form ──────────────────────────────────────────────── */

const { recordConfigForm, recordSpecFromForm } =
  await import("../mkui/static/src/lib/record-config.js");
const { resolveExpr } = await import("../mkui/static/src/lib/expressions.js");

const fieldsOf = (form) => Object.fromEntries(form.fields.map((f) => [f.name, f]));

test("the form opens on the configuration the window has", () => {
  const spec = parseRecordSpec({ listen: { order_id: "id" }, retain: true, title: "#${id}" });
  const f = fieldsOf(recordConfigForm(spec, { broadcast: ["order_id", "symbol"] }));
  assert.equal(f.mode.value, "listen");
  assert.equal(f.lname.value, "order_id");
  assert.equal(f.lcolumn.value, "id");
  assert.equal(f.retain.value, true);
  assert.equal(f.listening.value, true);
});

test("the form offers the panes a window may follow, and names what is broadcast", () => {
  const form = recordConfigForm(parseRecordSpec("orders"), {
    broadcast: ["order_id"], panes: [{ id: "orders", title: "Orders" }, { id: "tape" }],
  });
  assert.deepEqual(fieldsOf(form).pane.options,
    [{ value: "orders", label: "Orders" }, { value: "tape", label: "tape" }]);
  assert.match(form.footer.note, /Being broadcast now: order_id/);
  // The expression language has no ternary — a `?:` here renders nothing.
  assert.match(form.footer.note, /^\$\{IF\(/);
});

test("the form says so when nothing is broadcast, and warns about composite keys", () => {
  assert.match(recordConfigForm(parseRecordSpec("orders"), {}).footer.note,
    /Nothing is being broadcast yet/);
  const composite = parseRecordSpec({ listen: { book: "book", order_id: "id" } });
  assert.match(recordConfigForm(composite, { broadcast: ["book"] }).footer.note,
    /listens for 2 names; applying here replaces them with one/);
});

test("the note's literal survives an apostrophe", () => {
  // "a table's advanced header dropdown" — an unescaped quote would end
  // the string and the template would not compile.
  const note = recordConfigForm(parseRecordSpec("orders"), {}).footer.note;
  assert.match(resolveExpr(note, { mode: "listen" }), /advanced header dropdown/);
});

test("the form's answers become a record block", () => {
  const base = parseRecordSpec({ listen: { order_id: "id" }, title: "#${id}" });
  assert.deepEqual(
    recordSpecFromForm({ mode: "listen", lname: "trade_id", lcolumn: "tid", retain: true, listening: true }, base),
    { retain: true, listening: true, title: "#${id}", listen: { trade_id: "tid" } },
    "the title is not the form's to drop");
  assert.deepEqual(
    recordSpecFromForm({ mode: "follow", pane: "orders", retain: false, listening: false }, parseRecordSpec(null)),
    { retain: false, listening: false, follow: "orders" });
  assert.deepEqual(
    recordSpecFromForm({ mode: "state", path: "sel.order" }, parseRecordSpec(null)),
    { retain: false, listening: true, state: "sel.order" });
});

test("\"stay on one record\" writes down the record on show", () => {
  const next = recordSpecFromForm({ mode: "key" }, parseRecordSpec({ listen: { order_id: "id" } }),
                                  { key: { id: 4711 } });
  assert.deepEqual(next.key, { id: 4711 });
  assert.equal(next.listening, true, "a pinned-to-one-record window is not also paused");
});

test("an incomplete answer leaves the window following nothing rather than half a source", () => {
  const next = recordSpecFromForm({ mode: "listen", lname: "order_id", lcolumn: "" }, parseRecordSpec(null));
  assert.equal(parseRecordSpec(next).mode, null);
});
