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

test("nodock tab is a live drag surface (titlebar text moves the frame)", () => {
  // frame.js wires mousedown on the nodock tab to _beginFrameMove; a
  // pointer-events: none here would silently disconnect that.
  const rule = ruleContaining(".mkui-tabbar-nodock .mkui-tab {");
  assert.doesNotMatch(rule, /pointer-events:\s*none/);
  assert.equal(declaration(".mkui-tabbar-nodock .mkui-tab", "cursor"), "move");
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

test("conditional-style backgrounds ride custom properties and yield to selection", () => {
  // Stylers set --mkui-row-bg/--mkui-cell-bg + a marker class instead of an
  // inline background: an inline background would beat every class-based
  // selection tint. Precedence is source order, so the base styled rules
  // must appear BEFORE the selection rules they are meant to lose to.
  assert.equal(declaration(".mkui-table tr.mkui-row-styled", "background"),
    "var(--mkui-row-bg)");
  assert.equal(declaration(".mkui-table td.mkui-cell-styled", "background"),
    "var(--mkui-cell-bg)");
  assert.ok(css.indexOf(".mkui-table tr.mkui-row-styled")
    < css.indexOf(".mkui-table tr.mkui-selected"),
    "row-styled background must precede the row-selection tint");
  assert.ok(css.indexOf(".mkui-table td.mkui-cell-styled")
    < css.indexOf(".mkui-table td.mkui-cell-sel"),
    "cell-styled background must precede the cell-selection tint");
  // Where both apply, the tint blends with the styled background.
  assert.match(declaration(".mkui-table tr.mkui-selected.mkui-row-styled", "background"),
    /color-mix.*--mkui-row-bg/);
});

test("find matches tint by class and yield to selection", () => {
  // Like the styled-cell background: a match tint that came after the
  // selection rules would paint over a selected match.
  assert.equal(declaration(".mkui-table td.mkui-cell-match", "background"), "var(--mkui-match-bg)");
  assert.ok(css.indexOf(".mkui-table td.mkui-cell-match")
    < css.indexOf(".mkui-table td.mkui-cell-sel"),
    "match tint must precede the cell-selection tint");
  assert.ok(css.indexOf(".mkui-table td.mkui-cell-match")
    < css.indexOf(".mkui-table tr.mkui-selected"),
    "match tint must precede the row-selection tint");
  // Both themes define the tint.
  assert.equal((css.match(/--mkui-match-bg:/g) ?? []).length, 2);
  // The strip never scrolls with the table: it is a fixed flex row.
  assert.equal(declaration(".mkui-table-find", "flex-shrink"), "0");
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

// ── Table selection & row-number column ──────────────────────────────
// Cell/row selection replaces native text selection; the focused cell is
// the visible keyboard-focus indicator; the row-number column is sticky
// and opaque, so selection tints must be painted onto it explicitly.

test("tables opt out of native text selection (structured copy instead)", () => {
  assert.equal(declaration(".mkui-table", "user-select"), "none");
});

test("the focusable scroll container shows no focus ring of its own", () => {
  assert.equal(declaration(".mkui-table-keys:focus", "outline"), "none");
});

test("focused cell outline is inset so it doesn't bleed into neighbors", () => {
  assert.match(declaration(".mkui-table td.mkui-cell-focus", "outline"),
    /1px solid var\(--mkui-accent\)/);
  assert.equal(declaration(".mkui-table td.mkui-cell-focus", "outline-offset"), "-1px");
});

test("row highlight paints on the tr, far subtler than row selection", () => {
  // Painted on the tr (like mkui-selected) so td-level flash animations
  // still show; the td-level cell-sel tint matches row selection strength.
  const hl = declaration(".mkui-table tr.mkui-row-hl", "background");
  const sel = declaration(".mkui-table tr.mkui-selected", "background");
  assert.notEqual(hl, sel, "highlight must be visually distinct from selection");
  assert.equal(declaration(".mkui-table td.mkui-cell-sel", "background"), sel);
});

test("row-number cells are sticky-left and opaque", () => {
  const body = ruleContaining(".mkui-table td.mkui-td-rownum");
  assert.match(body, /position:\s*sticky/);
  assert.match(body, /left:\s*0/);
  // Opaque: rows scroll beneath the sticky cell.
  assert.match(body, /background:\s*var\(--mkui-bg-alt\)/);
});

test("rownum header corner stacks above rownum body cells", () => {
  // Match the standalone one-liner rules directly: the shared sticky rule
  // lists both selectors, so the generic helper would find that instead.
  const thZ = css.match(/th\.mkui-th-rownum\s*\{\s*z-index:\s*(\d+)/);
  const tdZ = css.match(/td\.mkui-td-rownum\s*\{\s*z-index:\s*(\d+)/);
  assert.ok(thZ && tdZ, "both rownum z-index rules must exist");
  assert.ok(parseInt(thZ[1]) > parseInt(tdZ[1]),
    "corner cell must cover scrolled rownum cells");
});

test("selected and highlighted rows tint their opaque rownum cell explicitly", () => {
  assert.match(
    declaration(".mkui-table tr.mkui-selected td.mkui-td-rownum", "background"),
    /color-mix|rgba/);
  assert.match(
    declaration(".mkui-table tr.mkui-row-hl td.mkui-td-rownum", "background"),
    /color-mix|rgba/);
});

// ── Menu shortcut labels ──────────────────────────────────────────────

test("menu shortcuts read as hints: muted, flipping with item hover", () => {
  assert.equal(declaration(".mkui-menu-shortcut", "color"), "var(--mkui-fg-mute)");
  assert.equal(
    declaration(".mkui-menu-item:hover .mkui-menu-shortcut", "color"),
    "var(--mkui-accent-fg)");
});

test("copy flash fades to each element's own resting background", () => {
  // The keyframes must start at the accent and declare NO end frame: the
  // animation then interpolates to the element's computed background (the
  // selection tint, the row highlight, or transparent). An explicit
  // `100% { transparent }` dips selected rows below their tint and snaps
  // back — it reads as a double flash.
  const i = css.indexOf("@keyframes mkui-flash-copy");
  assert.ok(i >= 0, "mkui-flash-copy keyframes must exist");
  const block = css.slice(i, css.indexOf("\n}", i) + 2);
  assert.match(block, /0%\s*\{\s*background:\s*var\(--mkui-accent\)/);
  assert.ok(!/100%|\bto\b|transparent/.test(block),
    "no end keyframe — the resting background is the implicit end state");
  assert.match(declaration(".mkui-flash-copy", "animation"), /mkui-flash-copy/);
});


// ── Rich cell content ─────────────────────────────────────────────────────

test("rich badges and bars are driven by custom properties set per segment", () => {
  assert.equal(declaration(".mkui-rich-badge", "background"), "var(--mkui-badge-color, var(--mkui-accent))");
  assert.equal(declaration(".mkui-rich-bar::before", "width"), "var(--mkui-bar-frac, 0%)");
  assert.equal(declaration(".mkui-rich-bar::before", "background"), "var(--mkui-bar-color, var(--mkui-accent))");
});

test("rich bars clip their fill and sit inline", () => {
  assert.equal(declaration(".mkui-rich-bar", "display"), "inline-block");
  assert.equal(declaration(".mkui-rich-bar", "overflow"), "hidden");
});

test("icons inside rich text flow inline (the base rule is display:block)", () => {
  assert.equal(declaration(".mkui-rich-icon .mkui-icon", "display"), "inline-block");
});

test("display errors are visibly marked", () => {
  assert.ok(rule(".mkui-table td.mkui-cell-err").includes("color"));
});

// ── Range filter dropdown ─────────────────────────────────────────────────

test("hidden mode controls stay hidden despite their flex display", () => {
  assert.match(declaration(".mkui-filter-dropdown [hidden]", "display"), /none\s*!important/);
  assert.equal(declaration(".mkui-filter-dropdown.mkui-filter-wide", "min-width"), "280px");
});

test("dropdowns widen to long values up to a cap, then scroll sideways — never wrap or truncate", () => {
  assert.equal(declaration(".mkui-filter-dropdown", "width"), "max-content");
  assert.ok(declaration(".mkui-filter-dropdown", "max-width"));
  assert.equal(declaration(".mkui-filter-item > span", "white-space"), "nowrap");
  assert.ok(!/text-overflow|overflow\s*:\s*hidden/.test(rule(".mkui-filter-item > span")), "no truncation");
  assert.equal(declaration(".mkui-filter-list", "overflow"), "auto", "both axes scroll");
  assert.equal(declaration(".mkui-filter-item", "min-width"), "100%");
  assert.equal(declaration(".mkui-filter-item", "width"), "max-content", "the hover band spans the scroll width");
});

test("range bounds use the mono font like the value list", () => {
  assert.equal(declaration(".mkui-filter-bound-input", "font-family"), "var(--mkui-font-mono)");
});

test("mode switch and presets mark the active choice with the accent", () => {
  assert.equal(declaration(".mkui-filter-mode.active", "border-bottom-color"), "var(--mkui-accent)");
  assert.equal(declaration(".mkui-filter-preset.active", "color"), "var(--mkui-accent)");
});

test("native date/time pickers follow the theme", () => {
  assert.equal(declaration("mkui-app", "color-scheme"), "dark");
  assert.equal(declaration('mkui-app[theme="light"]', "color-scheme"), "light");
});

// ── Table toolbar chips ──────────────────────────────────────────────────
// The toolbar holds the selection buttons on the left and the sort/filter
// chip cluster on the right. Flex line-breaking sizes the cluster at its
// max-content width, so it sits beside the buttons when it fits and drops
// to the next line as a whole when it doesn't — the buttons never move —
// and the chips inside wrap end-aligned. Nothing may scroll horizontally:
// a hidden chip defeats the strip's purpose.

test("toolbar wraps and the chip cluster is pushed to the right edge", () => {
  assert.equal(declaration(".mkui-table-toolbar", "flex-wrap"), "wrap");
  assert.equal(declaration(".mkui-table-chips", "margin-left"), "auto");
  assert.equal(declaration(".mkui-table-chips", "flex-wrap"), "wrap");
  assert.equal(declaration(".mkui-table-chips", "justify-content"), "flex-end");
  assert.ok(!/overflow/.test(rule(".mkui-table-chips")), "chips never scroll");
  assert.ok(!/overflow/.test(rule(".mkui-table-toolbar")));
});

test("chip groups dissolve into the cluster; a group icon sticks to its first chip", () => {
  assert.equal(declaration(".mkui-chip-group", "display"), "contents");
  assert.equal(declaration(".mkui-chip-lead", "white-space"), "nowrap");
});

test("group clear buttons carry an × badge anchored to the icon", () => {
  assert.equal(declaration(".mkui-chip-icon", "position"), "relative");
  assert.equal(declaration(".mkui-chip-icon-x", "position"), "absolute");
  assert.equal(declaration(".mkui-chip-icon-x", "background"), "var(--mkui-bg-alt)",
    "the badge masks the icon corner in the toolbar color");
});

test("the Columns button lives in a right gutter of the scroll area, clear of the last column's grip", () => {
  // The gutter: scroll-area end padding the button's width. The table ends
  // before it, so the filler's grip is never under the button — including
  // when the columns overflow and the table is scrolled fully right, since
  // end padding is part of a scroll container's scrollable overflow.
  assert.equal(declaration(".mkui-table-scroll", "padding-right"), "var(--mkui-columns-gutter)");
  assert.ok(declaration(".mkui-table-scroll", "--mkui-columns-gutter"));
  assert.equal(declaration(".mkui-columns-btn", "width"), "var(--mkui-columns-btn-w)", "narrower than the gutter: covers no header cell");
  assert.equal(declaration(".mkui-columns-btn", "right"), "calc(-1 * var(--mkui-columns-gutter))", "hangs off the anchor's end, flush with the pane edge");
  // The grip's hit zone straddles the table's edge by 3.5px; the gutter is
  // wider than the button by more than that, and the strip between them
  // is painted but inert so the grip stays draggable.
  assert.equal(parseInt(declaration(".mkui-table-scroll", "--mkui-columns-gutter")) - parseInt(declaration(".mkui-table-scroll", "--mkui-columns-btn-w")), 4);
  assert.equal(declaration(".mkui-columns-btn::before", "pointer-events"), "none");
  assert.equal(declaration(".mkui-columns-btn::before", "background"), "var(--mkui-bg-alt)");
  // The table's edge is the divider: the button draws none of its own and
  // centres its glyph across the whole gutter (right padding = the strip),
  // so the icon sits evenly between that edge and the pane's.
  assert.ok(!/border-left/.test(rule(".mkui-columns-btn")), "no divider on the button");
  assert.equal(declaration(".mkui-columns-btn", "padding"), "0 calc(var(--mkui-columns-gutter) - var(--mkui-columns-btn-w)) 0 0");
  assert.equal(declaration(".mkui-columns-btn", "justify-content"), "center");
  // Sticky on both axes: horizontal scroll must not carry the anchor off.
  assert.equal(declaration(".mkui-columns-anchor", "position"), "sticky");
  assert.equal(declaration(".mkui-columns-anchor", "top"), "0");
  assert.equal(declaration(".mkui-columns-anchor", "left"), "0");
  assert.equal(declaration(".mkui-columns-anchor", "height"), "0", "takes no space in the scroll area");
  assert.ok(parseInt(declaration(".mkui-columns-anchor", "z-index")) > 2, "above the sticky header cells (rownum corner is 2)");
  assert.equal(declaration(".mkui-columns-btn", "position"), "absolute");
  assert.equal(declaration(".mkui-columns-btn", "background"), "var(--mkui-bg-alt)", "opaque: continues the header row across the gutter");
  assert.equal(declaration(".mkui-columns-badge", "position"), "absolute", "the badge overlays the icon so the width stays fixed");
  assert.equal(declaration(".mkui-columns-badge[hidden]", "display"), "none");
  assert.ok(!/mkui-chip-columns/.test(css), "no hidden-columns chip any more");
});

test("dropdown lists size to the viewport, not a fixed cap, and resize vertically", () => {
  assert.equal(declaration(".mkui-filter-list", "resize"), "vertical");
  assert.ok(!/max-height/.test(rule(".mkui-filter-list")), "the cap is set per open from the viewport");
  assert.ok(/overflow(-y)?\s*:\s*auto/.test(rule(".mkui-filter-list")), "resize needs a non-visible overflow");
  assert.ok(declaration(".mkui-filter-list", "min-height"));
  assert.equal(declaration(".mkui-filter-list", "box-sizing"), "border-box", "the JS cap is a rect height, padding included");
});

test("inert dropdown actions read muted and lose their hover; Show all's confirm state stands out", () => {
  assert.equal(declaration(".mkui-columns-confirm", "font-weight"), "600");
  assert.equal(declaration(".mkui-filter-action-off", "color"), "var(--mkui-fg-mute)");
  assert.equal(declaration(".mkui-filter-action-off", "cursor"), "default");
  assert.equal(declaration(".mkui-filter-action-off:hover", "text-decoration"), "none");
});

test("chips are capped in width and ellipsize their text", () => {
  assert.ok(declaration(".mkui-chip", "max-width"));
  assert.equal(declaration(".mkui-chip-text", "text-overflow"), "ellipsis");
  assert.equal(declaration(".mkui-chip-text", "overflow"), "hidden");
});

// ── Tree rows ─────────────────────────────────────────────────────────────

test("tree cells indent by the depth variable the table sets per cell", () => {
  assert.match(declaration(".mkui-table td.mkui-tree-cell", "padding-left"),
    /var\(--mkui-tree-depth, 0\) \* var\(--mkui-tree-indent, 16px\)/);
});

test("tree carets are pointer targets, rotate when open, and leaves keep the box hidden", () => {
  assert.equal(declaration(".mkui-tree-toggle", "cursor"), "pointer");
  assert.match(declaration(".mkui-tree-toggle.open", "transform"), /rotate\(90deg\)/);
  assert.equal(declaration(".mkui-tree-toggle.mkui-tree-leaf", "visibility"), "hidden",
    "a leaf's blank caret keeps sibling text aligned");
  assert.doesNotMatch(rule(".mkui-tree-toggle"), /pointer-events\s*:\s*none/,
    "the caret must take the click the icon inside it passes through");
});
