// Run with: node --test tests/styles.test.js
//
// Regression tests for mkui.css invariants that JS can't enforce at runtime.
// The workspace is positioned with `top: var(--mkui-menubar-h)` and
// `bottom: var(--mkui-statusbar-h)`, so the menubar and statusbar must render
// at *exactly* those heights. Both bars carry a 1px border facing the
// workspace; without border-box sizing they overhang by that pixel and paint
// over the border of any frame snapped to the top or bottom edge.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const cssPath = fileURLToPath(new URL("../mkui/static/styles/mkui.css", import.meta.url));
const css = readFileSync(cssPath, "utf8");

// Extract the declaration block for an exact top-level selector.
function rule(selector) {
  const re = new RegExp(`(?:^|[}])\\s*${selector.replace(/[[\]]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "m");
  const m = css.match(re);
  assert.ok(m, `rule not found for selector: ${selector}`);
  return m[1];
}

function declaration(selector, property) {
  const body = rule(selector);
  const m = body.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, "m"));
  assert.ok(m, `${selector} is missing declaration: ${property}`);
  return m[1].trim();
}

// ── Chrome bar sizing ─────────────────────────────────────────────────────

test("menubar height comes from the layout variable", () => {
  assert.equal(declaration("mkui-menubar", "height"), "var(--mkui-menubar-h)");
});

test("statusbar height comes from the layout variable", () => {
  assert.equal(declaration("mkui-statusbar", "height"), "var(--mkui-statusbar-h)");
});

test("menubar is border-box so its border fits inside --mkui-menubar-h", () => {
  // A content-box menubar renders 1px taller than the workspace offset and
  // paints over the top border of a frame snapped to the top edge.
  assert.equal(declaration("mkui-menubar", "box-sizing"), "border-box");
});

test("statusbar is border-box so its border fits inside --mkui-statusbar-h", () => {
  assert.equal(declaration("mkui-statusbar", "box-sizing"), "border-box");
});

// ── Workspace / bar agreement ─────────────────────────────────────────────

test("workspace offsets use the same variables as the bar heights", () => {
  assert.equal(declaration("mkui-workspace", "top"), "var(--mkui-menubar-h)");
  assert.equal(declaration("mkui-workspace", "bottom"), "var(--mkui-statusbar-h)");
});

test("frames are border-box so a snapped frame's border stays in its rect", () => {
  assert.equal(declaration("mkui-frame", "box-sizing"), "border-box");
});
