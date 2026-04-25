// Run with: node --test tests/state.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { State, App } from "../mkui/static/src/core.js";

// ── State get / set ─────────────────────────────────────────────────────

test("State get returns nested value by dot path", () => {
  const s = new State({ a: { b: { c: 42 } } });
  assert.equal(s.get("a.b.c"), 42);
});

test("State get returns undefined for missing path", () => {
  const s = new State({ a: 1 });
  assert.equal(s.get("x.y.z"), undefined);
});

test("State set creates intermediate objects", () => {
  const s = new State({});
  s.set("a.b.c", 7);
  assert.equal(s.get("a.b.c"), 7);
});

test("State set overwrites existing value", () => {
  const s = new State({ status: { message: "old" } });
  s.set("status.message", "new");
  assert.equal(s.get("status.message"), "new");
});

test("State set to null stores null", () => {
  const s = new State({ bg: "red" });
  s.set("bg", null);
  assert.equal(s.get("bg"), null);
});

// ── State subscribe ─────────────────────────────────────────────────────

test("subscribe fires immediately with current value", () => {
  const s = new State({ x: 10 });
  const values = [];
  s.subscribe("x", (v) => values.push(v));
  assert.deepEqual(values, [10]);
});

test("subscribe fires on set", () => {
  const s = new State({ x: 1 });
  const values = [];
  s.subscribe("x", (v) => values.push(v));
  s.set("x", 2);
  s.set("x", 3);
  assert.deepEqual(values, [1, 2, 3]);
});

test("subscribe delivers null when value is set to null", () => {
  const s = new State({ bg: "#fff" });
  const values = [];
  s.subscribe("bg", (v) => values.push(v));
  s.set("bg", null);
  assert.deepEqual(values, ["#fff", null]);
});

test("unsubscribe stops notifications", () => {
  const s = new State({ x: 0 });
  const values = [];
  const unsub = s.subscribe("x", (v) => values.push(v));
  s.set("x", 1);
  unsub();
  s.set("x", 2);
  assert.deepEqual(values, [0, 1]);
});

test("subscribe to nested path fires on set", () => {
  const s = new State({ status: { background: null } });
  const values = [];
  s.subscribe("status.background", (v) => values.push(v));
  s.set("status.background", "#858585");
  s.set("status.background", null);
  assert.deepEqual(values, [null, "#858585", null]);
});

test("set notifies parent path subscribers", () => {
  const s = new State({ status: { message: "hi", bg: "blue" } });
  const snapshots = [];
  s.subscribe("status", (v) => snapshots.push({ ...v }));
  s.set("status.bg", "red");
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[1].bg, "red");
  assert.equal(snapshots[1].message, "hi");
});

// ── Connection state map pattern ────────────────────────────────────────

test("applying a connected/disconnected state map updates multiple paths", () => {
  const s = new State({ status: { message: "Connecting...", background: "#858585" } });

  const connected    = { "status.message": "Connected", "status.background": null };
  const disconnected = { "status.message": "Disconnected", "status.background": "#858585" };

  const apply = (map) => {
    for (const [path, value] of Object.entries(map)) s.set(path, value);
  };

  apply(connected);
  assert.equal(s.get("status.message"), "Connected");
  assert.equal(s.get("status.background"), null);

  apply(disconnected);
  assert.equal(s.get("status.message"), "Disconnected");
  assert.equal(s.get("status.background"), "#858585");
});

test("subscribers see every transition through connect/disconnect cycle", () => {
  const s = new State({ status: { message: "Connecting...", background: "#ccc" } });

  const msgs = [];
  const bgs = [];
  s.subscribe("status.message", (v) => msgs.push(v));
  s.subscribe("status.background", (v) => bgs.push(v));

  const apply = (map) => {
    for (const [path, value] of Object.entries(map)) s.set(path, value);
  };

  apply({ "status.message": "Connected", "status.background": null });
  apply({ "status.message": "Disconnected", "status.background": "#ccc" });
  apply({ "status.message": "Connected", "status.background": null });

  assert.deepEqual(msgs, ["Connecting...", "Connected", "Disconnected", "Connected"]);
  assert.deepEqual(bgs, ["#ccc", null, "#ccc", null]);
});

// ── App defaults ────────────────────────────────────────────────────────

test("App initializes State from config.state", () => {
  const app = new App({ state: { status: { message: "init" } } });
  assert.equal(app.state.get("status.message"), "init");
});

test("App without config.state starts with empty state", () => {
  const app = new App({});
  assert.equal(app.state.get("anything"), undefined);
});
