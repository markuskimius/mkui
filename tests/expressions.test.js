// Run with: node --test tests/expressions.test.js
//
// Two layers: the vendored engine (lib/expr.js) runs mkio's conformance
// fixtures, and the mkui wrapper (lib/expressions.js) is tested for its
// lenient environment, ${...} resolution, caching, warnings, and state-path
// analysis.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as X from "../mkui/static/src/lib/expr.js";
import {
  resolveExpr, resolveObject, evalExpr, compileExpr, compileTemplate, statePaths,
  registerExprFunction, registerExprLibrary, registerExprType, env, expr,
} from "../mkui/static/src/lib/expressions.js";

// ── Conformance fixtures (shared with mkio) ─────────────────────────────

const { cases, language } = JSON.parse(readFileSync(fileURLToPath(new URL("./expr_cases.json", import.meta.url)), "utf8"));

test("fixture language version matches the vendored engine", () => {
  assert.equal(language, X.LANGUAGE_VERSION);
});

for (const c of cases) {
  test(`conformance: ${c.id} ${JSON.stringify(c.expr ?? c.template)}`, () => {
    const cenv = new X.Env({ strict: c.strict !== undefined ? c.strict : true });
    const run = () => ("template" in c ? X.compileTemplate(c.template, cenv) : X.compile(c.expr, cenv)).call(c.scope);
    if ("error" in c) {
      assert.throws(run, (e) => e instanceof X.ExprError && e.message.includes(c.error));
    } else {
      const got = run();
      assert.ok(X.equals(got, c.expect) && X.kind(got) === X.kind(c.expect), `got ${JSON.stringify(got)} want ${JSON.stringify(c.expect)}`);
    }
  });
}

// ── mkui wrapper: lenient environment ───────────────────────────────────

test("the mkui environment is lenient and sees every library", () => {
  assert.equal(env.strict, false);
  assert.equal(evalExpr("nope", {}), null);
  assert.equal(evalExpr("nope ?? 'd'", {}), "d");
  assert.equal(evalExpr("UPPER(a) + STR(SUM(xs))", { a: "x", xs: [1, 2] }), "X3");
});

test("evalExpr passes non-strings through (literal config values)", () => {
  assert.equal(evalExpr(true, {}), true);
  assert.equal(evalExpr(42, {}), 42);
  assert.equal(evalExpr(null, {}), null);
});

test("evalExpr warns once per source and yields null on error", () => {
  const warned = [];
  const orig = console.warn;
  console.warn = (...a) => warned.push(a.join(" "));
  try {
    assert.equal(evalExpr("1 / 0", {}), null);
    assert.equal(evalExpr("1 / 0", {}), null);
    assert.equal(evalExpr("1 +", {}), null);
    assert.equal(warned.filter(w => w.includes('"1 / 0"')).length, 1);
    assert.equal(warned.filter(w => w.includes('"1 +"')).length, 1);
  } finally {
    console.warn = orig;
  }
});

test("compiled expressions and templates are cached by source", () => {
  assert.equal(compileExpr("a + 1"), compileExpr("a + 1"));
  assert.equal(compileTemplate("x ${a}"), compileTemplate("x ${a}"));
  assert.notEqual(compileExpr("a + 1"), compileExpr("a + 2"));
});

// ── resolveExpr / resolveObject ─────────────────────────────────────────

test("returns non-string values unchanged", () => {
  assert.equal(resolveExpr(42, {}), 42);
  assert.equal(resolveExpr(null, {}), null);
  assert.equal(resolveExpr(true, {}), true);
});

test("returns plain strings unchanged", () => {
  assert.equal(resolveExpr("hello", {}), "hello");
  assert.equal(resolveExpr("no expressions here", {}), "no expressions here");
});

test("a pure template preserves the raw type", () => {
  assert.equal(resolveExpr("${row.id}", { row: { id: 42 } }), 42);
  assert.equal(resolveExpr("${row.price}", { row: { price: 3.14 } }), 3.14);
  assert.equal(resolveExpr("${row.active}", { row: { active: true } }), true);
  assert.deepEqual(resolveExpr("${row.tags}", { row: { tags: ["a"] } }), ["a"]);
});

test("a mixed template returns a string", () => {
  assert.equal(resolveExpr("Order #${row.id}", { row: { id: 42 } }), "Order #42");
  assert.equal(resolveExpr("${row.side} ${row.qty} ${row.symbol}", { row: { side: "Buy", qty: 100, symbol: "AAPL" } }), "Buy 100 AAPL");
});

test("missing or null values resolve to the empty string", () => {
  assert.equal(resolveExpr("${row.missing}", { row: {} }), "");
  assert.equal(resolveExpr("${nothing}", {}), "");
  assert.equal(resolveExpr("${row.a.b}", { row: { a: null } }), "");
  assert.equal(resolveExpr("[${row.missing}]", { row: {} }), "[]");
});

test("templates hold full expressions", () => {
  const ctx = { row: { qty: 3, price: 1.5, symbol: "aapl" } };
  assert.equal(resolveExpr("${UPPER(row.symbol)}: ${NUM(row.qty * row.price, digits: 2)}", ctx), "AAPL: 4.50");
  assert.equal(resolveExpr("${row.qty > 2 ? 1 : 0}", ctx), "", "syntax error yields empty");
  assert.equal(resolveExpr("${IF(row.qty > 2, 'big', 'small')}", ctx), "big");
  assert.equal(resolveExpr("$${row.qty}", ctx), "${row.qty}");
});

test("resolveObject resolves strings in objects and arrays, nested", () => {
  const ctx = { row: { id: 1, name: "test", x: "a" } };
  assert.deepEqual(resolveObject({ id: "${row.id}", label: "${row.name}" }, ctx), { id: 1, label: "test" });
  assert.deepEqual(resolveObject(["${row.x}", "literal"], ctx), ["a", "literal"]);
  assert.deepEqual(resolveObject({ outer: { inner: "${row.id}" } }, ctx), { outer: { inner: 1 } });
  assert.deepEqual(resolveObject({ a: 1, b: true, c: null }, {}), { a: 1, b: true, c: null });
  assert.equal(resolveObject(null, {}), null);
  assert.equal(resolveObject(undefined, {}), undefined);
});

// ── state paths ─────────────────────────────────────────────────────────

test("statePaths lists the state.* paths an expression reads", () => {
  assert.deepEqual([...statePaths("state.a.b + state.c")].sort(), ["a.b", "c"]);
  assert.deepEqual([...statePaths("${state.auth.user ?? 'x'} · ${state.status.message}", { template: true })].sort(), ["auth.user", "status.message"]);
  assert.deepEqual([...statePaths("row.state.x")], [], "only the root name `state` counts");
  assert.deepEqual([...statePaths("state")], [""], "bare state → root");
  assert.deepEqual([...statePaths("state[k].y + k")], [""], "computed key stops at the root");
  assert.deepEqual([...statePaths("1 +")], [], "unparseable → nothing");
});

// ── extension API ───────────────────────────────────────────────────────

test("registerExprFunction makes an app function callable from any expression", () => {
  registerExprFunction("SPREAD_BPS", (bid, ask) => ((ask - bid) / ask) * 1e4, { numeric: true, params: ["bid", "ask"] });
  assert.equal(evalExpr("ROUND(SPREAD_BPS(bid, ask), 1)", { bid: 99, ask: 100 }), 100);
  assert.equal(resolveExpr("${spread_bps(1, 2)}", {}), 5000);
  assert.equal(expr.defaultEnv.function("SPREAD_BPS").library, "app");
  expr.unregisterLibrary("app");
});

test("registerExprLibrary and registerExprType go through the engine", () => {
  registerExprLibrary("desk", { PNL_COLOR: [(v) => (v < 0 ? "red" : "green"), { params: ["v"] }] });
  assert.equal(evalExpr("PNL_COLOR(-1)", {}), "red");
  class Money { constructor(v) { this.v = v; } }
  registerExprType("money", (v) => v instanceof Money, { add: (a, b) => new Money(a.v + b.v), toString: (m) => `$${m.v.toFixed(2)}` });
  assert.equal(resolveExpr("${a + b}!", { a: new Money(1), b: new Money(2.5) }), "$3.50!");
  expr.unregisterLibrary("desk");
  expr.TYPES.delete("money");
});
