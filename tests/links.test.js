// Run with: node --test tests/links.test.js
//
// The table-link hub (lib/links.js): retained values per name, queued
// delivery, source-scoped retraction, state mirroring, and the chain cap.
import { test } from "node:test";
import assert from "node:assert/strict";

const { LinkHub, sameValues, MAX_CHAIN } = await import("../mkui/static/src/lib/links.js");

function fakeState() {
  const data = new Map();
  return { set: (k, v) => data.set(k, v), get: (k) => data.get(k), data };
}

test("sameValues compares lists element-wise and null only to null", () => {
  assert.equal(sameValues(["a", "b"], ["a", "b"]), true);
  assert.equal(sameValues(["a", "b"], ["b", "a"]), false);
  assert.equal(sameValues(["a"], ["a", "b"]), false);
  assert.equal(sameValues(null, null), true);
  assert.equal(sameValues(null, []), false);
});

test("publish delivers to subscribers of the name, stringified, with the source", () => {
  const hub = new LinkHub();
  const got = [];
  hub.subscribe("order_id", (values, source, name) => got.push([values, source, name]));
  assert.deepEqual(hub.publish("orders", { order_id: [1, 2], other: ["x"] }), ["order_id", "other"]);
  assert.deepEqual(got, [[["1", "2"], "orders", "order_id"]]);
  assert.deepEqual(hub.current("order_id"), { values: ["1", "2"], source: "orders" });
  assert.deepEqual(hub.names(), ["order_id", "other"]);
});

test("a scalar becomes a one-element list", () => {
  const hub = new LinkHub();
  hub.publish("a", { k: 7 });
  assert.deepEqual(hub.current("k").values, ["7"]);
});

test("the same list from the same source is not redelivered", () => {
  const hub = new LinkHub();
  let n = 0;
  hub.subscribe("k", () => n++);
  hub.publish("a", { k: ["1"] });
  hub.publish("a", { k: ["1"] });
  assert.equal(n, 1);
  hub.publish("a", { k: ["2"] });
  assert.equal(n, 2);
});

test("null retracts a name and delivers null; a null with nothing retained is a no-op", () => {
  const hub = new LinkHub();
  const got = [];
  hub.subscribe("k", (v) => got.push(v));
  assert.deepEqual(hub.publish("a", { k: null }), []);
  hub.publish("a", { k: ["1"] });
  hub.publish("a", { k: null });
  assert.deepEqual(got, [["1"], null]);
  assert.equal(hub.current("k"), null);
  assert.deepEqual(hub.names(), []);
});

test("only the source that set a value may retract it", () => {
  const hub = new LinkHub();
  hub.publish("a", { k: ["1"] });
  assert.deepEqual(hub.publish("b", { k: null }), []);
  assert.deepEqual(hub.current("k"), { values: ["1"], source: "a" });
  // Another source may replace it, and then owns it.
  hub.publish("b", { k: ["2"] });
  assert.deepEqual(hub.current("k"), { values: ["2"], source: "b" });
  assert.deepEqual(hub.publish("a", { k: null }), []);
  assert.deepEqual(hub.publish("b", { k: null }), ["k"]);
});

test("retract drops every name a source holds", () => {
  const hub = new LinkHub();
  hub.publish("a", { x: ["1"], y: ["2"] });
  hub.publish("b", { z: ["3"] });
  assert.deepEqual(hub.retract("a").sort(), ["x", "y"]);
  assert.deepEqual(hub.names(), ["z"]);
});

test("values mirror into state at link.<name>", () => {
  const st = fakeState();
  const hub = new LinkHub(st);
  hub.publish("a", { order_id: ["1", "2"] });
  assert.deepEqual(st.get("link.order_id"), ["1", "2"]);
  hub.publish("a", { order_id: null });
  assert.equal(st.get("link.order_id"), null);
  const lazy = new LinkHub(() => st);
  lazy.publish("a", { k: ["9"] });
  assert.deepEqual(st.get("link.k"), ["9"]);
});

test("unsubscribe stops delivery", () => {
  const hub = new LinkHub();
  let n = 0;
  const off = hub.subscribe("k", () => n++);
  hub.publish("a", { k: ["1"] });
  off();
  hub.publish("a", { k: ["2"] });
  assert.equal(n, 1);
});

test("a publish from inside a delivery is queued, not nested", () => {
  const hub = new LinkHub();
  const order = [];
  hub.subscribe("x", (v) => { order.push("x:" + v); hub.publish("mid", { y: ["from-x"] }); order.push("x-done"); });
  hub.subscribe("y", (v) => order.push("y:" + v));
  hub.publish("a", { x: ["1"] });
  assert.deepEqual(order, ["x:1", "x-done", "y:from-x"]);
});

test("a listener that throws does not stop the others", () => {
  const hub = new LinkHub();
  const warn = console.warn;
  const warned = [];
  console.warn = (m) => warned.push(m);
  try {
    let n = 0;
    hub.subscribe("k", () => { throw new Error("boom"); });
    hub.subscribe("k", () => n++);
    hub.publish("a", { k: ["1"] });
    assert.equal(n, 1);
    assert.match(warned[0], /listener for 'k' failed: boom/);
  } finally { console.warn = warn; }
});

test("an endless chain is cut at MAX_CHAIN with one warning", () => {
  const hub = new LinkHub();
  const warn = console.warn;
  const warned = [];
  console.warn = (m) => warned.push(m);
  try {
    let n = 0;
    hub.subscribe("ping", (v) => { n++; hub.publish("b", { pong: [String(Number(v[0]) + 1)] }); });
    hub.subscribe("pong", (v) => { n++; hub.publish("a", { ping: [String(Number(v[0]) + 1)] }); });
    hub.publish("a", { ping: ["0"] });
    assert.equal(n, MAX_CHAIN);
    assert.equal(warned.length, 1);
    assert.match(warned[0], /broadcast chain cut/);
    // Later publishes still work.
    hub.subscribe("z", () => n++);
    hub.publish("c", { z: ["1"] });
    assert.equal(n, MAX_CHAIN + 1);
  } finally { console.warn = warn; }
});
