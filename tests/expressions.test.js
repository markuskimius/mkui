// Run with: node --test tests/expressions.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveExpr, resolveObject } from "../mkui/static/src/lib/expressions.js";

// ── resolveExpr ─────────────────────────────────────────────────────────

test("returns non-string values unchanged", () => {
  assert.equal(resolveExpr(42, {}), 42);
  assert.equal(resolveExpr(null, {}), null);
  assert.equal(resolveExpr(true, {}), true);
});

test("returns plain strings unchanged", () => {
  assert.equal(resolveExpr("hello", {}), "hello");
  assert.equal(resolveExpr("no expressions here", {}), "no expressions here");
});

test("resolves a simple path", () => {
  assert.equal(resolveExpr("${row.id}", { row: { id: 42 } }), 42);
});

test("pure expression preserves raw type", () => {
  assert.equal(resolveExpr("${row.price}", { row: { price: 3.14 } }), 3.14);
  assert.equal(typeof resolveExpr("${row.price}", { row: { price: 3.14 } }), "number");
  assert.equal(resolveExpr("${row.active}", { row: { active: true } }), true);
});

test("mixed template returns string", () => {
  assert.equal(resolveExpr("Order #${row.id}", { row: { id: 42 } }), "Order #42");
  assert.equal(typeof resolveExpr("Order #${row.id}", { row: { id: 42 } }), "string");
});

test("multiple expressions in one template", () => {
  assert.equal(
    resolveExpr("${row.side} ${row.qty} ${row.symbol}", { row: { side: "Buy", qty: 100, symbol: "AAPL" } }),
    "Buy 100 AAPL",
  );
});

test("missing path returns empty string", () => {
  assert.equal(resolveExpr("${row.missing}", { row: {} }), "");
  assert.equal(resolveExpr("${nothing}", {}), "");
});

test("null in path returns empty string", () => {
  assert.equal(resolveExpr("${row.a.b}", { row: { a: null } }), "");
});

test("deeply nested path", () => {
  assert.equal(resolveExpr("${a.b.c.d}", { a: { b: { c: { d: "deep" } } } }), "deep");
});

// ── resolveObject ───────────────────────────────────────────────────────

test("resolves strings in an object", () => {
  const ctx = { row: { id: 1, name: "test" } };
  const result = resolveObject({ id: "${row.id}", label: "${row.name}" }, ctx);
  assert.deepEqual(result, { id: 1, label: "test" });
});

test("resolves strings in arrays", () => {
  const ctx = { row: { x: "a" } };
  assert.deepEqual(resolveObject(["${row.x}", "literal"], ctx), ["a", "literal"]);
});

test("resolves nested objects", () => {
  const ctx = { row: { id: 5 } };
  const result = resolveObject({ outer: { inner: "${row.id}" } }, ctx);
  assert.deepEqual(result, { outer: { inner: 5 } });
});

test("passes through non-string primitives", () => {
  const result = resolveObject({ a: 1, b: true, c: null }, {});
  assert.deepEqual(result, { a: 1, b: true, c: null });
});

test("returns null/undefined unchanged", () => {
  assert.equal(resolveObject(null, {}), null);
  assert.equal(resolveObject(undefined, {}), undefined);
});
