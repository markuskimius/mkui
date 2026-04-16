// Run with: node --test tests/layout.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalize, findPane, listPanes, removePane, insertPane,
  setSplitRatio, layout, TABBAR_H,
} from "../src/layout/tree.js";
import {
  clampToDock, rectToFrac, fracToRect, dropZoneFor,
} from "../src/layout/drag.js";

// ── normalize ────────────────────────────────────────────────────────────

test("normalize wraps a bare leaf in a single-tab group", () => {
  const t = normalize("a");
  assert.deepEqual(t, { type: "tabs", active: 0, children: ["a"] });
});

test("normalize collapses a single-child split", () => {
  const t = normalize({ type: "split", dir: "h", children: ["a"] });
  assert.deepEqual(t, { type: "tabs", active: 0, children: ["a"] });
});

test("normalize returns null for an empty split", () => {
  assert.equal(normalize({ type: "split", dir: "h", children: [] }), null);
});

test("normalize fixes out-of-range tab active index", () => {
  const t = normalize({ type: "tabs", active: 99, children: ["a", "b"] });
  assert.equal(t.active, 1);
});

test("normalize is idempotent on a canonical tree", () => {
  const canon = {
    type: "split", dir: "h", ratios: [0.5, 0.5],
    children: [
      { type: "tabs", active: 0, children: ["a"] },
      { type: "tabs", active: 0, children: ["b", "c"] },
    ],
  };
  const once = normalize(canon);
  const twice = normalize(once);
  assert.deepEqual(once, twice);
});

// ── find / list / remove / insert ────────────────────────────────────────

test("findPane locates a pane inside a nested split", () => {
  const t = normalize({
    type: "split", dir: "h", children: [
      "a",
      { type: "split", dir: "v", children: ["b", "c"] },
    ],
  });
  const hit = findPane(t, "c");
  assert.ok(hit);
  assert.equal(hit.tabIndex, 0);
  assert.deepEqual(hit.tabGroup.children, ["c"]);
});

test("listPanes returns traversal order", () => {
  const t = normalize({
    type: "split", dir: "h", children: [
      { type: "tabs", children: ["a", "b"] },
      "c",
    ],
  });
  assert.deepEqual(listPanes(t), ["a", "b", "c"]);
});

test("removePane from a single-pane tab group returns null", () => {
  const t = normalize("a");
  assert.equal(removePane(t, "a"), null);
});

test("removePane collapses the containing split", () => {
  const t = normalize({
    type: "split", dir: "h", children: ["a", "b"],
  });
  const after = removePane(t, "a");
  assert.deepEqual(after, { type: "tabs", active: 0, children: ["b"] });
});

test("removePane leaves other panes intact in a multi-tab group", () => {
  const t = normalize({ type: "tabs", active: 1, children: ["a", "b", "c"] });
  const after = removePane(t, "b");
  assert.deepEqual(after.children, ["a", "c"]);
  assert.equal(after.active, 1);
});

test("insertPane center adds a tab to the target's tab group", () => {
  const t = normalize({ type: "tabs", children: ["a"] });
  const after = insertPane(t, "a", "center", "b");
  assert.deepEqual(after.children, ["a", "b"]);
  assert.equal(after.active, 1);
});

test("insertPane right wraps the target tab group in a new h-split", () => {
  const t = normalize({ type: "tabs", children: ["a"] });
  const after = insertPane(t, "a", "right", "b");
  assert.equal(after.type, "split");
  assert.equal(after.dir, "h");
  assert.equal(after.children[0].children[0], "a");
  assert.equal(after.children[1].children[0], "b");
});

test("insertPane top wraps the target tab group in a new v-split with new on top", () => {
  const t = normalize({ type: "tabs", children: ["a"] });
  const after = insertPane(t, "a", "top", "b");
  assert.equal(after.dir, "v");
  assert.equal(after.children[0].children[0], "b");
  assert.equal(after.children[1].children[0], "a");
});

test("insertPane into an empty tree creates a single-tab group", () => {
  const after = insertPane(null, "nonexistent", "right", "b");
  assert.deepEqual(after, { type: "tabs", active: 0, children: ["b"] });
});

// ── layout ───────────────────────────────────────────────────────────────

test("layout of a single-tab group: one tab bar + one visible pane", () => {
  const t = normalize("a");
  const { panes, tabBars, splitters } = layout(t, { x: 0, y: 0, w: 400, h: 300 });
  assert.equal(splitters.length, 0);
  assert.equal(tabBars.length, 1);
  assert.equal(tabBars[0].rect.h, TABBAR_H);
  const p = panes.get("a");
  assert.equal(p.visible, true);
  assert.equal(p.rect.y, TABBAR_H);
  assert.equal(p.rect.h, 300 - TABBAR_H);
});

test("layout of a 2-tab group: only active is visible", () => {
  const t = normalize({ type: "tabs", active: 1, children: ["a", "b"] });
  const { panes } = layout(t, { x: 0, y: 0, w: 400, h: 300 });
  assert.equal(panes.get("a").visible, false);
  assert.equal(panes.get("b").visible, true);
});

test("layout of an h-split produces one splitter and two pane rects", () => {
  const t = normalize({ type: "split", dir: "h", ratios: [0.3, 0.7], children: ["a", "b"] });
  const { panes, splitters } = layout(t, { x: 0, y: 0, w: 1000, h: 600 });
  assert.equal(splitters.length, 1);
  assert.equal(splitters[0].dir, "h");
  assert.equal(splitters[0].parentDim, 1000);
  assert.equal(panes.get("a").rect.w, 300);
  assert.equal(panes.get("b").rect.w, 700);
});

test("layout: nested split+tabs, splitters report correct parentDim", () => {
  const t = normalize({
    type: "split", dir: "h", ratios: [0.5, 0.5],
    children: [
      "a",
      { type: "split", dir: "v", ratios: [0.5, 0.5], children: ["b", "c"] },
    ],
  });
  const { splitters } = layout(t, { x: 0, y: 0, w: 1000, h: 600 });
  assert.equal(splitters.length, 2);
  const hSp = splitters.find(s => s.dir === "h");
  const vSp = splitters.find(s => s.dir === "v");
  assert.equal(hSp.parentDim, 1000);  // outer horizontal split's width
  assert.equal(vSp.parentDim, 600);   // inner vertical split's height
});

test("layout: proportional resize keeps ratios invariant", () => {
  const t = normalize({ type: "split", dir: "h", ratios: [0.25, 0.75], children: ["a", "b"] });
  const small = layout(t, { x: 0, y: 0, w: 800, h: 600 });
  const big   = layout(t, { x: 0, y: 0, w: 1600, h: 1200 });
  assert.equal(small.panes.get("a").rect.w / 800, 0.25);
  assert.equal(big.panes.get("a").rect.w / 1600, 0.25);
});

// ── clamping ─────────────────────────────────────────────────────────────

test("clampToDock pins a frame fully inside the workspace", () => {
  const ws = { x: 0, y: 0, w: 1000, h: 700 };
  const r = clampToDock({ x: 9999, y: 9999, w: 300, h: 200 }, ws);
  assert.ok(r.x + r.w <= ws.w);
  assert.ok(r.y + r.h <= ws.h);
  const r2 = clampToDock({ x: -999, y: -999, w: 300, h: 200 }, ws);
  assert.equal(r2.x, 0);
  assert.equal(r2.y, 0);
});

test("clampToDock shrinks oversized frames to fit", () => {
  const ws = { x: 0, y: 0, w: 400, h: 300 };
  const r = clampToDock({ x: 0, y: 0, w: 9999, h: 9999 }, ws);
  assert.equal(r.w, 400);
  assert.equal(r.h, 300);
});

test("rectToFrac / fracToRect round-trip", () => {
  const ws = { x: 0, y: 0, w: 1280, h: 700 };
  const orig = { x: 100, y: 50, w: 400, h: 300 };
  const back = fracToRect(rectToFrac(orig, ws), ws);
  assert.equal(back.x, orig.x);
  assert.equal(back.y, orig.y);
  assert.equal(back.w, orig.w);
  assert.equal(back.h, orig.h);
});

test("randomized clamp invariant (500 trials)", () => {
  const ws = { x: 0, y: 0, w: 1024, h: 700 };
  for (let i = 0; i < 500; i++) {
    const r = clampToDock({
      x: Math.random() * 3000 - 1500,
      y: Math.random() * 3000 - 1500,
      w: Math.random() * 2000 - 200,
      h: Math.random() * 2000 - 200,
    }, ws);
    assert.ok(r.x >= ws.x);
    assert.ok(r.y >= ws.y);
    assert.ok(r.x + r.w <= ws.x + ws.w + 1e-9);
    assert.ok(r.y + r.h <= ws.y + ws.h + 1e-9);
  }
});

// ── drop zones ───────────────────────────────────────────────────────────

test("dropZoneFor: center in the middle, edges near borders", () => {
  const r = { x: 0, y: 0, w: 100, h: 100 };
  assert.equal(dropZoneFor(r, 50, 50), "center");
  assert.equal(dropZoneFor(r, 5, 50),  "left");
  assert.equal(dropZoneFor(r, 95, 50), "right");
  assert.equal(dropZoneFor(r, 50, 5),  "top");
  assert.equal(dropZoneFor(r, 50, 95), "bottom");
  assert.equal(dropZoneFor(r, 200, 200), null);
});

// ── split ratios ─────────────────────────────────────────────────────────

test("setSplitRatio respects minimum and adjusts neighbor", () => {
  const t = normalize({ type: "split", dir: "h", ratios: [0.5, 0.5], children: ["a", "b"] });
  setSplitRatio(t, 0, 0.8);
  assert.ok(Math.abs(t.ratios[0] - 0.8) < 1e-9);
  assert.ok(Math.abs(t.ratios[1] - 0.2) < 1e-9);
  setSplitRatio(t, 0, 0.001);
  assert.ok(Math.abs(t.ratios[0] - 0.05) < 1e-9);
  assert.ok(Math.abs(t.ratios[1] - 0.95) < 1e-9);
});

// ── end-to-end docking flow ──────────────────────────────────────────────

test("tear-out → drop-right flow preserves all panes", () => {
  // Start: frame with two tabs [a, b]. Tear b out, then drop b onto a's right edge.
  let tree = normalize({ type: "tabs", children: ["a", "b"] });
  // Tear-out: remove b from the source frame's tree.
  tree = removePane(tree, "b");
  assert.deepEqual(listPanes(tree), ["a"]);
  // Drop b onto the right edge of a.
  tree = insertPane(tree, "a", "right", "b");
  assert.deepEqual(listPanes(tree).sort(), ["a", "b"]);
  assert.equal(tree.type, "split");
  assert.equal(tree.dir, "h");
});
