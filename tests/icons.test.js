// Run with: node --test tests/icons.test.js
//
// Covers the SVG icon library: every registered icon builds a well-formed
// currentColor <svg>, outline icons carry stroke attributes while filled
// icons carry fill, and unknown names fail loudly rather than rendering
// an empty box.
import { test } from "node:test";
import assert from "node:assert/strict";

const SVG_NS = "http://www.w3.org/2000/svg";

function mockEl(ns, tag) {
  const el = {
    ns, tag,
    _attrs: {},
    _ch: [],
    setAttribute(name, v) { el._attrs[name] = String(v); },
    appendChild(c) { el._ch.push(c); return c; },
  };
  return el;
}
globalThis.document = {
  createElementNS: (ns, tag) => mockEl(ns, tag),
};

const { icon } = await import("../mkui/static/src/lib/icons.js");

const OUTLINE_NAMES = [
  "close", "maximize", "pin", "refresh", "chevron-left", "chevron-right",
];
const FILLED_NAMES = ["caret-up", "caret-down", "dot"];

test("unknown icon name throws", () => {
  assert.throws(() => icon("no-such-icon"), /unknown icon: no-such-icon/);
});

test("every icon builds an svg in the SVG namespace with a 24-box viewBox", () => {
  for (const name of [...OUTLINE_NAMES, ...FILLED_NAMES]) {
    const svg = icon(name);
    assert.equal(svg.ns, SVG_NS, name);
    assert.equal(svg.tag, "svg", name);
    assert.equal(svg._attrs.viewBox, "0 0 24 24", name);
    assert.equal(svg._attrs["aria-hidden"], "true", name);
  }
});

test("icons carry the shared class and a per-name class", () => {
  for (const name of [...OUTLINE_NAMES, ...FILLED_NAMES]) {
    const cls = icon(name)._attrs.class.split(/\s+/);
    assert.ok(cls.includes("mkui-icon"), name);
    assert.ok(cls.includes("mkui-icon-" + name), name);
  }
});

test("outline icons stroke with currentColor and no fill", () => {
  for (const name of OUTLINE_NAMES) {
    const a = icon(name)._attrs;
    assert.equal(a.fill, "none", name);
    assert.equal(a.stroke, "currentColor", name);
    assert.equal(a["stroke-width"], "2", name);
    assert.equal(a["stroke-linecap"], "round", name);
    assert.equal(a["stroke-linejoin"], "round", name);
  }
});

test("filled icons fill with currentColor and set no stroke", () => {
  for (const name of FILLED_NAMES) {
    const a = icon(name)._attrs;
    assert.equal(a.fill, "currentColor", name);
    assert.equal(a.stroke, undefined, name);
  }
});

test("every icon contains at least one path child with data", () => {
  for (const name of [...OUTLINE_NAMES, ...FILLED_NAMES]) {
    const svg = icon(name);
    assert.ok(svg._ch.length >= 1, name);
    for (const p of svg._ch) {
      assert.equal(p.ns, SVG_NS, name);
      assert.equal(p.tag, "path", name);
      assert.match(p._attrs.d, /^[Mm]/, name + ": path data starts with a move");
    }
  }
});

test("multi-stroke icons keep separate paths (close has 2, refresh has 4)", () => {
  assert.equal(icon("close")._ch.length, 2);
  assert.equal(icon("refresh")._ch.length, 4);
});

test("each call returns a fresh element — no shared mutable node", () => {
  const a = icon("close");
  const b = icon("close");
  assert.notEqual(a, b);
  assert.notEqual(a._ch[0], b._ch[0]);
});
