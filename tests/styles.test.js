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

// ── Tab strip ─────────────────────────────────────────────────────────────
// Tabs are flush shapes with rounded top corners and outward-curving bottom
// flares. The bar's bottom edge is an ::after overlay (not a border) so the
// selected tab can stack above it — that line break is what marks selection.

// Find the declaration block whose selector list contains `needle`
// (handles multi-selector rules the exact-match helper can't).
function ruleContaining(needle) {
  const i = css.indexOf(needle);
  assert.ok(i >= 0, `no rule mentions: ${needle}`);
  const open = css.indexOf("{", i);
  return css.slice(open + 1, css.indexOf("}", open));
}

test("tab bar draws its bottom line as an overlay, not a border", () => {
  // A real border would sit below the tabs' stacking context; the active
  // tab could never cover it and would always show a line at its base.
  assert.ok(!/border-bottom/.test(rule(".mkui-tabbar")),
    "tab bar must not use border-bottom");
  assert.equal(declaration(".mkui-tabbar::after", "height"), "1px");
  assert.equal(declaration(".mkui-tabbar::after", "background"), "var(--mkui-border)");
});

test("the selected tab stacks above the bar's bottom line", () => {
  assert.equal(declaration(".mkui-tab.active", "z-index"), "1");
});

test("tab body and its corner flares share one background variable", () => {
  // The flares are painted by ::after gradients; if they ever stop
  // following --mkui-tab-bg they desync from the body on hover/active.
  assert.equal(declaration(".mkui-tab", "background"), "var(--mkui-tab-bg)");
  const flares = declaration(".mkui-tab::after", "background");
  assert.equal((flares.match(/var\(--mkui-tab-bg\)/g) ?? []).length, 2,
    "both flare gradients must use var(--mkui-tab-bg)");
});

test("tabs are flush: no side margins, bar padding fits the 6px flares", () => {
  assert.equal(declaration(".mkui-tab", "margin-top"), "4px");
  assert.ok(!/(?:^|;)\s*margin\s*:/.test(rule(".mkui-tab")),
    "tabs must not re-introduce side gaps via margin");
  assert.equal(declaration(".mkui-tabs", "padding"), "0 6px");
});

test("both themes define the selected-tab color", () => {
  assert.equal(declaration(":root", "--mkui-tab-active"), "#2d2d2e");
  assert.equal(declaration('mkui-app[theme="light"]', "--mkui-tab-active"), "#e9e9e9");
});

test("selected tabs outside the keyboard-focused group flatten to idle", () => {
  const body = ruleContaining(
    'mkui-frame[data-focused] .mkui-tabbar:not(.mkui-tabbar-focused) .mkui-tab.active');
  assert.match(body, /--mkui-tab-bg:\s*var\(--mkui-bg\)/);
  assert.match(body, /color:\s*var\(--mkui-fg-mute\)/);
  // The same block must also cover unfocused frames.
  const selStart = css.lastIndexOf("}", css.indexOf(
    'mkui-frame[data-focused] .mkui-tabbar:not(.mkui-tabbar-focused) .mkui-tab.active'));
  const selector = css.slice(selStart, css.indexOf("{", selStart));
  assert.match(selector, /mkui-frame:not\(\[data-focused\]\) \.mkui-tab\.active/);
});

test("nodock (dialog) tab bars opt out of the tab silhouette", () => {
  const body = ruleContaining(".mkui-tabbar-nodock .mkui-tab::before");
  assert.match(body, /display:\s*none/);
  assert.equal(declaration(".mkui-tabbar-nodock .mkui-tab", "margin"), "0");
});
