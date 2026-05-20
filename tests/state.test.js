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

// ── Multi-field connection state maps ──────────────────────────────────

test("connected map with null values clears fields for subscribers", () => {
  const s = new State({
    status: { message: "Connecting...", color: "#000", background: "#b8b8b8" },
  });

  const msgs = [], colors = [], bgs = [];
  s.subscribe("status.message", (v) => msgs.push(v));
  s.subscribe("status.color", (v) => colors.push(v));
  s.subscribe("status.background", (v) => bgs.push(v));

  const apply = (map) => {
    for (const [path, value] of Object.entries(map)) s.set(path, value);
  };

  apply({ "status.message": "Connected", "status.color": null, "status.background": null });
  assert.deepEqual(msgs, ["Connecting...", "Connected"]);
  assert.deepEqual(colors, ["#000", null]);
  assert.deepEqual(bgs, ["#b8b8b8", null]);

  apply({ "status.message": "Disconnected", "status.color": "#000", "status.background": "#b8b8b8" });
  assert.deepEqual(msgs, ["Connecting...", "Connected", "Disconnected"]);
  assert.deepEqual(colors, ["#000", null, "#000"]);
  assert.deepEqual(bgs, ["#b8b8b8", null, "#b8b8b8"]);
});

// ── Server verification state lifecycle ────────────────────────────────

test("verification lifecycle: connect sets connected, verify sets verified and server info", () => {
  const s = new State({
    status: { message: "Connecting...", color: "#000", background: "#b8b8b8" },
  });

  const apply = (map) => {
    for (const [path, value] of Object.entries(map)) s.set(path, value);
  };

  // Phase 1: WebSocket opens
  s.set("mkio.connected", true);
  apply({ "status.message": "Connected", "status.color": null, "status.background": null });

  assert.equal(s.get("mkio.connected"), true);
  assert.equal(s.get("status.message"), "Connected");

  // Phase 2: _mkio verification succeeds
  s.set("mkio.verified", true);
  s.set("mkio.server.name", "order-book");
  s.set("mkio.server.version", "1.0.0");
  s.set("mkio.server.protocol", "1.0");
  s.set("mkio.server.mkio", "0.1.44");

  assert.equal(s.get("mkio.verified"), true);
  assert.equal(s.get("mkio.server.name"), "order-book");
  assert.equal(s.get("mkio.server.version"), "1.0.0");
  assert.equal(s.get("mkio.server.protocol"), "1.0");
  assert.equal(s.get("mkio.server.mkio"), "0.1.44");
});

test("verification failure applies incompatible state map", () => {
  const s = new State({
    status: { message: "Connecting...", color: "#000", background: "#b8b8b8" },
  });

  const apply = (map) => {
    for (const [path, value] of Object.entries(map)) s.set(path, value);
  };

  // WebSocket opens
  s.set("mkio.connected", true);
  apply({ "status.message": "Connected", "status.color": null, "status.background": null });

  // Verification fails (wrong name, incompatible version, or timeout)
  s.set("mkio.verified", false);
  apply({ "status.message": "Wrong server", "status.color": "#ffffff", "status.background": "#cc0000" });

  assert.equal(s.get("mkio.connected"), true);
  assert.equal(s.get("mkio.verified"), false);
  assert.equal(s.get("status.message"), "Wrong server");
  assert.equal(s.get("status.color"), "#ffffff");
  assert.equal(s.get("status.background"), "#cc0000");
});

test("disconnect clears verified and server state", () => {
  const s = new State({});

  const apply = (map) => {
    for (const [path, value] of Object.entries(map)) s.set(path, value);
  };

  // Connected and verified
  s.set("mkio.connected", true);
  s.set("mkio.verified", true);
  s.set("mkio.server", { name: "order-book", version: "1.0.0", protocol: "1.0", mkio: "0.1.44" });

  // Disconnect
  s.set("mkio.connected", false);
  s.set("mkio.verified", false);
  apply({ "status.message": "Disconnected", "status.color": "#000", "status.background": "#b8b8b8" });

  assert.equal(s.get("mkio.connected"), false);
  assert.equal(s.get("mkio.verified"), false);
  assert.equal(s.get("status.message"), "Disconnected");
});

test("subscribers see full verification lifecycle", () => {
  const s = new State({});

  const connected = [], verified = [];
  s.subscribe("mkio.connected", (v) => connected.push(v));
  s.subscribe("mkio.verified", (v) => verified.push(v));

  // Connect
  s.set("mkio.connected", true);
  s.set("mkio.verified", false);
  // Verify succeeds
  s.set("mkio.verified", true);
  // Disconnect
  s.set("mkio.connected", false);
  s.set("mkio.verified", false);
  // Reconnect + verify
  s.set("mkio.connected", true);
  s.set("mkio.verified", false);
  s.set("mkio.verified", true);

  assert.deepEqual(connected, [undefined, true, false, true]);
  assert.deepEqual(verified, [undefined, false, true, false, false, true]);
});

// ── Empty string as null (TOML compat) ─────────────────────────────────

test("empty string is equivalent to null for style clearing in state maps", () => {
  const s = new State({
    status: { message: "Connecting...", color: "#000", background: "#b8b8b8" },
  });

  const colors = [], bgs = [];
  s.subscribe("status.color", (v) => colors.push(v));
  s.subscribe("status.background", (v) => bgs.push(v));

  const apply = (map) => {
    for (const [path, value] of Object.entries(map)) s.set(path, value);
  };

  apply({ "status.color": "", "status.background": "" });
  assert.deepEqual(colors, ["#000", ""]);
  assert.deepEqual(bgs, ["#b8b8b8", ""]);

  apply({ "status.color": "#000", "status.background": "#b8b8b8" });
  assert.deepEqual(colors, ["#000", "", "#000"]);
  assert.deepEqual(bgs, ["#b8b8b8", "", "#b8b8b8"]);
});
