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

// ── Tab overflow (shrink → arrows) ────────────────────────────────────────
// Tabs shrink to fit their bar before anything overflows; past the 3em
// label minimum the strip clips with no scrollbar and the ‹ › scroll
// arrows are the only way to reach off-screen tabs.

test("tabs shrink to fit, floored at 3em of label", () => {
  assert.equal(declaration(".mkui-tab", "flex-shrink"), "1");
  assert.equal(declaration(".mkui-tab", "min-width"), "3em");
  // Content-box: box-sizing would make the 3em include the 28px padding,
  // leaving ~8px of label.
  assert.ok(!/box-sizing/.test(rule(".mkui-tab")),
    "tab min-width must apply to the label area (content-box)");
});

test("tab strip clips overflow with no scrollbar", () => {
  assert.equal(declaration(".mkui-tabs", "overflow-x"), "hidden");
  assert.ok(!/\.mkui-tabs[^{]*scrollbar/.test(css),
    "the strip must not style a scrollbar it no longer shows");
});

test("strip always keeps one min-width tab visible", () => {
  // 3em label @12px (36) + 28px tab padding + 12px strip padding.
  assert.equal(declaration(".mkui-tabs", "min-width"), "76px");
});

test("scroll arrows appear only while the bar overflows", () => {
  assert.equal(declaration(".mkui-tab-scroll", "display"), "none");
  assert.equal(
    declaration(".mkui-tabbar-overflow > .mkui-tab-scroll", "display"), "flex");
});

test("arrows never shrink and ignore clicks when at their end", () => {
  assert.equal(declaration(".mkui-tab-scroll", "flex"), "0 0 auto");
  const body = rule(".mkui-tab-scroll.mkui-disabled");
  assert.match(body, /pointer-events:\s*none/);
});

test("overflowing bar trades drag whitespace for tab room", () => {
  assert.equal(declaration(".mkui-frame-drag", "min-width"), "40px");
  assert.equal(
    declaration(".mkui-tabbar-overflow > .mkui-frame-drag", "min-width"), "12px");
});

// ── No-wrap chrome ────────────────────────────────────────────────────────
// Buttons and table cells keep their content on one line; header cells
// use a flex row (not a float) so the filter button can't overlap the
// label when columns are squeezed.

test("buttons never wrap their labels", () => {
  assert.equal(declaration(".mkui-btn", "white-space"), "nowrap");
});

test("table cells never wrap", () => {
  assert.equal(
    declaration(".mkui-table th, .mkui-table td", "white-space"), "nowrap");
});

test("fixed-width table stretches via the filler column only", () => {
  // Column widths are locked from the measured header row and live on the
  // <colgroup> cols. The table must lay out at width:100% (from
  // .mkui-table) under table-layout:fixed: the used width is then
  // max(pane, sum of cols), so data columns keep their exact widths and a
  // wider pane only grows the auto-width filler column (which is what
  // extends the header to the pane edge). A pixel width or min-width here
  // would pin the column distribution and leave the filler at zero.
  assert.equal(declaration(".mkui-table", "width"), "100%");
  assert.equal(declaration(".mkui-table-fixed", "table-layout"), "fixed");
  assert.ok(!/min-width|(?:^|;)\s*width\s*:/.test(rule(".mkui-table-fixed")),
    "mkui-table-fixed must not declare width/min-width — width:100% + fixed layout does the work");
});

test("numeric cells right-align and pad to the decimal point", () => {
  assert.equal(declaration(".mkui-table td.mkui-num", "text-align"), "right");
  assert.match(declaration(".mkui-table td.mkui-num", "padding-right"),
    /var\(--mkui-num-pad/, "per-cell ch padding aligns the decimal points");
});

test("filter dropdown numeric values align like the cells", () => {
  // ch padding is only exact in a monospace font, so the value spans must
  // opt into the table's mono font.
  assert.equal(declaration(".mkui-filter-item .mkui-filter-num", "font-family"),
    "var(--mkui-font-mono)");
  assert.match(declaration(".mkui-filter-item .mkui-filter-num", "padding-left"),
    /var\(--mkui-num-pad/);
});

test("columns are separated by subtle dividers", () => {
  const div = declaration(".mkui-table th, .mkui-table td", "border-right");
  assert.match(div, /1px solid/);
  assert.match(div, /color-mix|rgba/, "divider should be softer than the full border color");
});

test("header cells lay out as a flex row, filter button un-floated", () => {
  assert.equal(declaration(".mkui-th-inner", "display"), "flex");
  assert.ok(!/float/.test(rule(".mkui-filter-btn")),
    "a floated filter button overlaps nowrap header text when squeezed");
});

test("sort/filter icons pin to the header cell's right edge", () => {
  // The label claims all free space, pushing the icons right regardless of
  // how wide the column is.
  assert.match(declaration(".mkui-th-label", "flex"), /^1\b/);
});

test("multi-sort priority digit overlays inside the caret", () => {
  assert.equal(declaration(".mkui-sort-num", "position"), "absolute");
  // Knocked out in the header background color so it reads as a cutout of
  // the filled caret rather than a stray character next to it.
  assert.equal(declaration(".mkui-sort-num", "color"), "var(--mkui-bg-alt)");
  // The caret lives inside the filter button, whose hover pill changes the
  // background — the knockout must track it or the digit stops reading as
  // a hole in the caret.
  assert.equal(declaration(".mkui-filter-btn:hover .mkui-sort-num", "color"),
    "var(--mkui-bg-hover)");
  // Digit sits in the triangle's wide half: base-side offset per direction.
  assert.ok(declaration(".mkui-sort-asc  .mkui-sort-num", "bottom"));
  assert.ok(declaration(".mkui-sort-desc .mkui-sort-num", "top"));
  // The digit is positioned against the caret's box, so the indicator must
  // establish the containing block.
  assert.equal(declaration(".mkui-sort-indicator", "position"), "relative");
});

test("sort caret and filter hamburger are the same 16px size", () => {
  // The caret has to be big enough for the priority digit to fit inside its
  // wide half; the hamburger matches it so the header icons read as one set.
  assert.equal(declaration(".mkui-sort-indicator .mkui-icon", "width"), "16px");
  assert.equal(declaration(".mkui-sort-indicator .mkui-icon", "height"), "16px");
  assert.equal(declaration(".mkui-filter-btn .mkui-icon", "width"), "16px");
  assert.equal(declaration(".mkui-filter-btn .mkui-icon", "height"), "16px");
});

test("filter button's padding is margin-cancelled on both axes", () => {
  // The padding inflates the hover pill but must not add to the button's
  // footprint: no header height beyond the 16px icon, and no extra
  // distance from the sort caret or the cell's padding edge — the pill
  // overhangs its neighbors instead of pushing them away.
  const [vpad, hpad] = declaration(".mkui-filter-btn", "padding").split(/\s+/);
  const [vmargin, hmargin] = declaration(".mkui-filter-btn", "margin").split(/\s+/);
  assert.equal(vmargin, "-" + vpad);
  assert.equal(hmargin, "-" + hpad);
});

test("header cells keep icons snug to the right edge but clear of the label", () => {
  // th right padding is tighter than the td's 8px: the cell ends in the
  // icon, whose shape already reads as padding.
  assert.equal(declaration(".mkui-table th", "padding-right"), "4px");
  // A visible gap between the label text and the icon.
  assert.equal(declaration(".mkui-th-inner", "gap"), "4px");
});

// SVG icons must never intercept pointer events: click/drag handlers
// hit-test against the hosting button (e.g. closest(".mkui-filter-btn")
// works, but tab-drag and column-drag target checks assume the button
// element itself is the event target).
test("icons are transparent to pointer events", () => {
  assert.equal(declaration(".mkui-icon", "pointer-events"), "none");
});
