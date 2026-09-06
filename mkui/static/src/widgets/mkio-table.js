import { registerPaneType } from "../core.js";
import { ensureMkio } from "../mkio-bridge.js";
import { resolveExpr, resolveObject, evalExpr, compileExpr, compileTemplate, expr } from "../lib/expressions.js";
import { icon } from "../lib/icons.js";
import { gridToTSV, gridToHTML } from "../lib/copy.js";
import { isRich, richText, richToHTML, renderRich } from "../lib/rich.js";
import {
  detectTimeKind, parseTime, kindForSpec, kindForFormat, inputToBound, boundToInput,
  inputTypeForKind, presetBounds, PRESETS,
} from "../lib/timeparse.js";

function midnightRef() {
  const d = new Date();
  const m = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const p = (n) => String(n).padStart(2, "0");
  return `${m.getUTCFullYear()}${p(m.getUTCMonth() + 1)}${p(m.getUTCDate())} ${p(m.getUTCHours())}:${p(m.getUTCMinutes())}:${p(m.getUTCSeconds())}.000000000000`;
}

function refToLocal(ref) {
  return new Date(Date.UTC(
    parseInt(ref.slice(0, 4)), parseInt(ref.slice(4, 6)) - 1, parseInt(ref.slice(6, 8)),
    parseInt(ref.slice(9, 11)), parseInt(ref.slice(12, 14)), parseInt(ref.slice(15, 17)),
  ));
}

function fmtTime(d) {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function fmtShortDate(d) {
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[d.getMonth()]} ${d.getDate()}`;
}

function refSubSec(ref) {
  const dot = ref.indexOf(".");
  return dot >= 0 ? ref.slice(dot + 1) : "";
}

function timePrec(fRef, lRef) {
  const a = refToLocal(fRef), b = refToLocal(lRef);
  if (a.getHours() !== b.getHours() || a.getMinutes() !== b.getMinutes()) return 0;
  if (a.getSeconds() !== b.getSeconds()) return 1;
  const as = refSubSec(fRef), bs = refSubSec(lRef);
  for (let t = 0; t < 3; t++) {
    const i = t * 3;
    if (as.slice(i, i + 3).padEnd(3, "0") !== bs.slice(i, i + 3).padEnd(3, "0")) return t + 2;
  }
  return 4;
}

function fmtTimePrec(d, ref, prec) {
  let s = fmtTime(d);
  if (prec >= 1) s += `:${String(d.getSeconds()).padStart(2, "0")}`;
  if (prec >= 2) {
    const sub = refSubSec(ref);
    const n = (prec - 1) * 3;
    s += `.${sub.slice(0, n).padEnd(n, "0")}`;
  }
  return s;
}

function fmtRefStart(ref) {
  const d = refToLocal(ref);
  const today = new Date();
  const same = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  return same ? fmtTime(d) : `${fmtShortDate(d)} ${fmtTime(d)}`;
}

function formatTimeRange(fRef, lRef) {
  if (!fRef && !lRef) return "No data";
  if (!lRef || fRef === lRef) return fmtRefStart(fRef || lRef);
  const a = refToLocal(fRef);
  const b = refToLocal(lRef);
  const today = new Date();
  const sameDay = (x, y) =>
    x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
  const prec = timePrec(fRef, lRef);
  if (sameDay(a, b)) {
    const prefix = sameDay(a, today) ? "" : fmtShortDate(a) + " ";
    return `${prefix}${fmtTimePrec(a, fRef, prec)} – ${fmtTimePrec(b, lRef, prec)}`;
  }
  return `${fmtShortDate(a)} ${fmtTimePrec(a, fRef, prec)} – ${fmtShortDate(b)} ${fmtTimePrec(b, lRef, prec)}`;
}

let _subCounter = 0;

registerPaneType("mkio-table", async (spec, app, host) => {
  const wsUrl = app.config?.mkio?.url;
  if (!wsUrl) {
    host.textContent = "[mkio-table] no mkio.url configured";
    return;
  }

  const protocol = spec.protocol ?? "query";
  const idKey = protocol === "stream" ? "_mkio_ref" : protocol === "subpub" ? "_mkio_topic" : "_mkio_row";
  const maxcount = spec.maxcount !== undefined ? spec.maxcount : 200;
  const isPaged = protocol === "stream" && maxcount > 0;
  const rowColumn = spec.rowColumn !== false; // row-number column, on by default
  const getStartRef = () => isPaged && (spec.start ?? "today") === "today" ? midnightRef() : null;
  const startLive = isPaged && spec.live === true;

  const table = document.createElement("table");
  table.className = "mkui-table";
  const colgroup = document.createElement("colgroup");
  const thead = document.createElement("thead");
  const tbody = document.createElement("tbody");
  table.append(colgroup, thead, tbody);

  // Spacer rows above/below the rendered slice fake the full scroll height
  // so only visible rows need DOM elements (see "Virtualized rows" below).
  // The spacer colspan must equal the real column count (kept in sync by
  // renderHead): a larger colspan would add that many phantom columns to
  // the fixed layout, and they — not the filler column — would swallow the
  // pane-width leftover, ~0px each.
  const makeSpacer = () => {
    const tr = document.createElement("tr");
    tr.className = "mkui-vspacer";
    const td = document.createElement("td");
    tr.appendChild(td);
    return [tr, td];
  };
  const [topSpacer, topSpacerTd] = makeSpacer();
  const [botSpacer, botSpacerTd] = makeSpacer();
  tbody.append(topSpacer, botSpacer);

  /* ── DOM structure ───────────────────────────────────────────────── */

  // The pane is a flex column: [toolbar] [scroll area] [progress | paging].
  // The table always lives in its own scroll area so the toolbar — the
  // selection buttons on the left, the sort/filter chips on the right —
  // stays put while the table scrolls under it. The toolbar is in the DOM
  // only while it has something to show: always with buttons, otherwise
  // while a sort or filter is active (see "Sort & filter chips").
  host.style.overflow = "hidden";
  host.style.padding = "0";
  host.style.display = "flex";
  host.style.flexDirection = "column";

  const scrollArea = document.createElement("div");
  scrollArea.className = "mkui-table-scroll";
  // The Columns button is pinned to the header row's right edge: a
  // zero-height sticky anchor ahead of the table (so it stays put under
  // both scroll axes and sits left of the scrollbar) carrying the button
  // at its right end. Always present — it is the one way into the column
  // picker — with a badge counting hidden columns.
  const colsAnchor = document.createElement("div");
  colsAnchor.className = "mkui-columns-anchor";
  const colsBtn = document.createElement("button");
  colsBtn.className = "mkui-columns-btn";
  colsBtn.type = "button";
  colsBtn.title = "Columns";
  colsBtn.disabled = true;
  const colsBadge = document.createElement("span");
  colsBadge.className = "mkui-columns-badge";
  colsBadge.hidden = true;
  colsBtn.append(icon("columns"), colsBadge);
  colsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (picker) closePicker(); else openColumnsPicker(colsBtn);
  });
  colsAnchor.appendChild(colsBtn);
  scrollArea.append(colsAnchor, table);
  const scrollHost = scrollArea;
  host.appendChild(scrollArea);

  let pagingToolbar = null;
  let prevBtn = null, nextBtn = null, pageInfo = null, liveBtn = null, refreshBtn = null;

  if (isPaged) {
    pagingToolbar = document.createElement("div");
    pagingToolbar.className = "mkui-table-paging";
    prevBtn = document.createElement("button");
    prevBtn.className = "mkui-btn mkui-paging-btn";
    prevBtn.append(icon("chevron-left"), "Earlier");
    prevBtn.disabled = true;
    pageInfo = document.createElement("span");
    pageInfo.className = "mkui-paging-info";
    nextBtn = document.createElement("button");
    nextBtn.className = "mkui-btn mkui-paging-btn";
    nextBtn.append("Later", icon("chevron-right"));
    nextBtn.disabled = true;
    liveBtn = document.createElement("button");
    liveBtn.className = "mkui-btn mkui-paging-live";
    liveBtn.append(icon("dot"), "Live");
    refreshBtn = document.createElement("button");
    refreshBtn.className = "mkui-btn mkui-paging-btn";
    refreshBtn.appendChild(icon("refresh"));
    refreshBtn.title = "Refresh page";
    pagingToolbar.append(prevBtn, pageInfo, nextBtn, liveBtn, refreshBtn);
    host.appendChild(pagingToolbar);
  }

  const progress = document.createElement("div");
  progress.className = "mkui-table-progress";
  progress.style.display = "none";
  if (!isPaged) host.appendChild(progress);

  /* ── Find state ──────────────────────────────────────────────────── */

  // The find strip (see "Find" below) sits between the toolbar and the
  // scroll area while open. Declared ahead of the toolbar, which inserts
  // itself relative to it.
  let findBar = null, findOpen = false;
  let findInput = null, findCount = null;
  let findQuery = "", findRegex = false, findCase = false;
  let findRe = null;         // the matcher; null while closed, empty, or invalid
  let findError = null;      // the RegExp error message, if any
  let findMatches = [];      // [{ key, col, idx }] — key null (idx -1) for a header
  let findPos = -1;          // index of the current match in findMatches, -1 = none
  let findScanGen = 0;       // cancels a stale chunked scan
  let findScanRev = -1;      // the viewRev the match list was built for
  let findScanning = false;
  let findInputTimer = null, findDataTimer = null;

  /* ── Toolbar (buttons + chips) ──────────────────────────────────── */

  const hasButtons = Array.isArray(spec.buttons) && spec.buttons.length > 0;
  const toolbar = document.createElement("div");
  toolbar.className = "mkui-table-toolbar";
  const buttonEls = [];
  if (hasButtons) {
    for (const btnSpec of spec.buttons) {
      const btn = document.createElement("button");
      btn.className = "mkui-btn mkui-toolbar-btn";
      btn.textContent = btnSpec.label ?? "Button";
      btn.disabled = true;
      btn.addEventListener("click", () => handleButtonClick(btnSpec));
      toolbar.appendChild(btn);
      buttonEls.push({ el: btn, spec: btnSpec });
    }
  }
  // Buttons keep the first slots (tests and users find them there); the
  // chip cluster is the last child, pushed to the right edge by CSS.
  const chipsEl = document.createElement("div");
  chipsEl.className = "mkui-table-chips";
  toolbar.appendChild(chipsEl);
  let toolbarShown = false;
  function syncToolbar() {
    const show = hasButtons || chipsEl.children.length > 0;
    if (show === toolbarShown) return;
    toolbarShown = show;
    if (show) host.insertBefore(toolbar, findOpen ? findBar : scrollArea); else toolbar.remove();
  }
  syncToolbar();

  const rows = new Map();          // key -> row, all data
  const rowEls = new Map();        // key -> tr, rendered slice only
  let baseOrder = [];              // keys in display (insertion) order
  let view = [];                   // keys filtered + sorted, drives rendering
  let viewDirty = false;           // view needs a full rebuild from baseOrder
  let viewRev = 0;                 // bumped on any change that affects the view
  let columns = spec.columns ?? null;
  // Which columns show, and in what order. `null` — the default — is every
  // known column in `columns` order, so a column that appears later (a new
  // field in the data, or one added to `columns` in config) shows up on its
  // own. An array is exactly these, in this order: whatever the user hid,
  // and whatever arrived since, stays out until asked for — that is what
  // lets a config add a column without disturbing a saved layout. Header
  // reorder and hiding both materialise the list; "Show all" returns to
  // null. Seeded from `visible` in the pane spec (loadVisibleSpec).
  let visible = null;
  let defaultVisible = null;   // the configured list — "Reset to default"
  const colWidths = new Map();
  let widthsInited = false;
  let widthsDirty = false;     // a ratchet grew a column — colgroup refresh pending
  const userSized = new Set(); // manually resized columns: auto-grow keeps hands off
  const headerMeasured = new Set(); // columns whose header width has been taken
  let dataSeen = false;        // some row has been measured since the last width reset
  let growSuspended = false;   // page load after first data: ratchet off, widths hold
  let rowNumDigits = 2;        // row-number column width follows the digit count
  const MIN_COL_W = 40;
  const CELL_CHROME = 17;      // 8px cell padding each side + 1px divider (mkui.css)
  const labels = spec.labels ?? {};
  const label = (col) => labels[col] ?? col;

  // Column groups (categories): `groups = [{ label, columns }, …]` in the
  // pane spec, an ordered array so the picker can section hundreds of
  // columns. Structure only — `visible` stays the one source of truth for
  // what shows. A column in two groups warns and keeps the first; a name
  // that is no known column is kept and skipped (it may arrive with the
  // data); a bad entry warns `bad groups[i]` and is dropped.
  const colGroupsSpec = []; // [{ label, columns }]
  {
    const gs = spec.groups;
    const seen = new Set();
    if (gs != null && gs !== "" && !Array.isArray(gs)) {
      console.warn("[mkio-table] bad groups: expected an array of { label, columns }");
    } else if (Array.isArray(gs)) {
      gs.forEach((g, i) => {
        if (!g || typeof g !== "object" || typeof g.label !== "string" || !g.label || !Array.isArray(g.columns)) {
          console.warn(`[mkio-table] bad groups[${i}]: expected { label, columns }`);
          return;
        }
        if (colGroupsSpec.some((x) => x.label === g.label)) {
          console.warn(`[mkio-table] bad groups[${i}]: label '${g.label}' used twice`);
          return;
        }
        const cols = [];
        for (const c of g.columns) {
          if (typeof c !== "string" || !c) {
            console.warn(`[mkio-table] bad groups[${i}]: expected column names`);
            return;
          }
          if (seen.has(c)) { console.warn(`[mkio-table] groups: '${c}' is already in a group`); continue; }
          seen.add(c);
          cols.push(c);
        }
        colGroupsSpec.push({ label: g.label, columns: cols });
      });
    }
  }

  // Column filter types. Range filtering is offered on numeric columns and
  // on columns whose every value is a time (see lib/timeparse.js for what
  // is recognised natively); `types = { col = "time" | "number" | "text" |
  // { type = "time", parse = "%d/%m/%Y", tz = "local", unit = "ms" } }`
  // overrides that inference — the only way to range-filter a column in a
  // format the table would otherwise refuse to guess.
  const colTypes = {}; // col -> { type, parse?, tz?, unit? }
  for (const [c, t] of Object.entries(spec.types ?? {})) {
    const o = typeof t === "string" ? { type: t } : { ...t };
    if (!["number", "time", "text"].includes(o.type)) {
      console.warn(`[mkio-table] bad types.${c}: type must be number, time, or text`);
      continue;
    }
    if (o.type === "time" && o.parse && !kindForFormat(String(o.parse))) {
      console.warn(`[mkio-table] bad types.${c}: parse format has no date or time fields`);
      continue;
    }
    colTypes[c] = o;
  }

  // Tree rows: `tree = { child, parent, expand, filterScope, orphans,
  // column }` nests rows like a file navigator. A row whose `child` fields
  // (x, y, z) are all empty is a root; otherwise its parent is the row whose
  // `parent` fields (a, b, c) carry the same values. The tree only shapes
  // the view — `view` becomes the pre-order flattening of the rows whose
  // ancestors are all expanded — so selection, copy, keyboard navigation,
  // and Ctrl-A, which all walk `view`, see exactly the rows on screen.
  // `expand` is the depth open at load (0 = roots only, or "all");
  // `filterScope` is the default scope of a new filter; `orphans` says
  // whether a child whose parent is absent shows as a root or hides;
  // `column` pins the caret to a column (default: the first visible one).
  const TREE_INDENT = 16;   // px per level, matches --mkui-tree-indent
  const TREE_TOGGLE_W = 16; // px the caret (12px icon + gap) adds to the cell
  const TREE_SCOPES = ["roots", "children", "all"];
  let tree = null;
  {
    const t = spec.tree;
    if (t != null && t !== "") {
      const strs = (v) => typeof v === "string" ? (v ? [v] : []) : Array.isArray(v) ? v : null;
      const child = strs(t.child), parent = strs(t.parent);
      if (typeof t !== "object" || !child || !parent || !child.length || child.length !== parent.length ||
          [...child, ...parent].some((f) => typeof f !== "string" || !f)) {
        console.warn("[mkio-table] bad tree: expected { child, parent } as column names of equal count");
      } else {
        let expand = t.expand ?? 0;
        if (expand === "all") expand = Infinity;
        else if (typeof expand !== "number" || !(expand >= 0)) {
          console.warn(`[mkio-table] bad tree.expand '${t.expand}': expected a depth or "all"`);
          expand = 0;
        }
        let filterScope = t.filterScope ?? "roots";
        if (!TREE_SCOPES.includes(filterScope)) {
          console.warn(`[mkio-table] bad tree.filterScope '${filterScope}': use roots, children, or all`);
          filterScope = "all";
        }
        let orphans = t.orphans ?? "root";
        if (orphans !== "root" && orphans !== "hide") {
          console.warn(`[mkio-table] bad tree.orphans '${orphans}': use root or hide`);
          orphans = "root";
        }
        tree = { child, parent, expand, filterScope, orphans,
                 column: typeof t.column === "string" && t.column ? t.column : null };
      }
    }
  }
  // Data columns: everything known except mkio's identity fields.
  const dataColumns = () => columns.filter((c) => !c.startsWith("_mkio_"));
  // Names in `visible` that aren't (yet) known columns are skipped rather
  // than rendered empty — config may name a column ahead of the data, and
  // it takes its place as soon as the data carries it. Cached on the
  // identity of both arrays (they are always reassigned, never mutated):
  // this runs in the render and selection hot paths.
  let visCache = null, visCacheCols = null, visCacheList = null;
  const visibleColumns = () => {
    if (visCache && visCacheCols === columns && visCacheList === visible) return visCache;
    const known = dataColumns();
    visCache = visible ? visible.filter((c) => known.includes(c)) : known;
    visCacheCols = columns;
    visCacheList = visible;
    return visCache;
  };
  // Known columns not shown, in `columns` order — the badge and picker.
  const hiddenColumns = () => {
    if (!columns) return [];
    const vis = new Set(visibleColumns());
    return dataColumns().filter((c) => !vis.has(c));
  };
  // The groups as the picker sections them: configured groups cut down to
  // known columns, then an implicit "Other" for whatever no group names.
  // null while the table has no columns or no groups are configured.
  function colGroups() {
    if (!columns || !colGroupsSpec.length) return null;
    const known = dataColumns();
    const grouped = new Set();
    const out = [];
    for (const g of colGroupsSpec) {
      const cols = g.columns.filter((c) => known.includes(c));
      for (const c of cols) grouped.add(c);
      if (cols.length) out.push({ label: g.label, columns: cols, other: false });
    }
    const rest = known.filter((c) => !grouped.has(c));
    if (rest.length) out.push({ label: "Other", columns: rest, other: true });
    return out;
  }
  // Columns inferred from the first row keep the row's key order — unless
  // groups are configured, when grouped columns come first in group order
  // so a category's columns sit together without writing `columns` too.
  function inferColumns(row) {
    const keys = Object.keys(row);
    if (!colGroupsSpec.length) return keys;
    const ordered = [];
    for (const g of colGroupsSpec)
      for (const c of g.columns) if (keys.includes(c) && !ordered.includes(c)) ordered.push(c);
    for (const k of keys) if (!ordered.includes(k)) ordered.push(k);
    return ordered;
  }

  /* ── Cell values ──────────────────────────────────────────────────── */

  // Every column value the table shows, sorts, filters, measures, or copies
  // goes through cellValue, so a derived column behaves like a real field
  // everywhere. `values = { col = "<expr>" }` derives a column with an
  // expression over the row — it may invent a column that no row carries
  // (list it in `columns`; inference only sees keys present on the data).
  // Button action payloads deliberately bypass this: they carry raw row
  // fields so a display format can't change what gets sent to a service.
  //
  // Cell scope: `value` (the raw row[col]), `row`, `col`, and `state` (app
  // state) first, then (for style rules) the derived columns, then the row's
  // own fields by name — so a column that happens to be called `value` or
  // `state` is reached as `row.value`. Built as a Scope chain rather than a
  // spread so per-cell cost stays at a few small objects.
  const valueExprs = {}; // col -> Compiled
  for (const [c, src] of Object.entries(spec.values ?? {})) {
    try { valueExprs[c] = compileExpr(String(src)); }
    catch (e) { console.warn(`[mkio-table] bad values expression for ${c}: ${e.message}`); }
  }
  const hasValues = Object.keys(valueExprs).length > 0;
  const warnedExprs = new Set();
  const stateRoot = () => app.state?.get?.() ?? {};

  // Derived columns as a lazy frame: own getters so `notional` resolves in
  // style rules without computing every derived column per lookup. Not used
  // for `values` expressions themselves (a derived column can't depend on
  // another — that would recurse).
  function derivedFrame(row) {
    const frame = {};
    for (const c of Object.keys(valueExprs)) {
      Object.defineProperty(frame, c, { enumerable: true, get: () => cellValue(row, c) });
    }
    return frame;
  }

  function cellScope(row, col, withDerived = false) {
    const specials = { value: row?.[col] ?? null, row: row ?? null, col, state: stateRoot() };
    const fields = new expr.Scope(row ?? {}, null, false);
    const parent = withDerived && hasValues ? new expr.Scope(derivedFrame(row), fields, false) : fields;
    return new expr.Scope(specials, parent, false);
  }

  // Row scope (rowStyle, and anything else about the whole record): `row`
  // and `state` first, then derived columns, then the row's fields — no
  // `value`/`col`, so a column called `value` is reachable by its plain name.
  function rowScope(row) {
    const fields = new expr.Scope(row ?? {}, null, false);
    const parent = hasValues ? new expr.Scope(derivedFrame(row), fields, false) : fields;
    return new expr.Scope({ row: row ?? null, state: stateRoot() }, parent, false);
  }

  function runCompiled(c, scope, label) {
    try { return c.evaluate(scope); }
    catch (e) {
      if (!warnedExprs.has(label)) {
        warnedExprs.add(label);
        console.warn(`[mkio-table] expression error in ${label}: ${e.message}`);
      }
      return null;
    }
  }

  function cellValue(row, col) {
    const c = valueExprs[col];
    if (c) return runCompiled(c, cellScope(row, col), `values.${col}`);
    return row?.[col];
  }

  function cellText(row, col) {
    const v = cellValue(row, col);
    return v == null ? "" : String(v);
  }

  /* ── Display templates ────────────────────────────────────────────── */

  // `display = { col = "<template>" }` controls presentation only: what the
  // cell shows (plain text or rich segments from the `mkui` library —
  // BOLD, COLOR, ICON, BADGE, BAR, …), what width stats measure, and what
  // the clipboard carries. Sorting, filtering, and numeric alignment still
  // use the (derived) value. Scope: the cell scope with `value` = cellValue
  // and derived columns visible. An evaluation error renders `#ERR` with
  // the message as the cell's tooltip.
  const displayExprs = {}; // col -> CompiledTemplate
  for (const [c, src] of Object.entries(spec.display ?? {})) {
    try { displayExprs[c] = compileTemplate(String(src)); }
    catch (e) { console.warn(`[mkio-table] bad display template for ${c}: ${e.message}`); }
  }
  const hasDisplay = Object.keys(displayExprs).length > 0;

  // -> { text, rich | null, error | null }
  function cellDisplay(row, col) {
    const t = displayExprs[col];
    if (!t) return { text: cellText(row, col), rich: null, error: null };
    const scope = cellScope(row, col, true);
    scope.vars.value = cellValue(row, col);
    try {
      const v = t.evaluate(scope);
      if (isRich(v)) return { text: richText(v), rich: v, error: null };
      return { text: v == null ? "" : expr.toString(v), rich: null, error: null };
    } catch (e) {
      const label = `display.${col}`;
      if (!warnedExprs.has(label)) {
        warnedExprs.add(label);
        console.warn(`[mkio-table] expression error in ${label}: ${e.message}`);
      }
      return { text: "#ERR", rich: null, error: e.message };
    }
  }

  const displayText = (row, col) => cellDisplay(row, col).text;

  // Width that icon and bar segments add beyond the flattened text (the
  // CSS sizes in mkui.css: 12px icons, 60px bars, plus a little air).
  function richExtraWidth(rich) {
    let w = 0;
    for (const s of rich.segments) {
      if (s.icon != null) w += 14;
      else if (s.bar != null) w += 64;
    }
    return w;
  }

  // Render a cell's content; remembers the flattened text on the element
  // so live updates can skip cells whose display didn't change.
  function renderCell(td, row, col) {
    const d = cellDisplay(row, col);
    td._mkuiText = d.text;
    const target = td._mkuiTreeText ?? td; // a tree cell keeps its caret
    if (d.error) {
      target.textContent = "#ERR";
      td.classList.add("mkui-cell-err");
      td.title = d.error;
      return;
    }
    if (td.classList.contains("mkui-cell-err")) { td.classList.remove("mkui-cell-err"); td.title = ""; }
    if (d.rich) renderRich(target, d.rich);
    else target.textContent = d.text;
  }

  /* ── Conditional styling ──────────────────────────────────────────── */

  // `styles = { col = <styler> }` styles a cell; `rowStyle = <styler>` styles
  // the whole row. A styler is a rule array evaluated first-match-wins —
  // each rule is `{ when = "<expr>", ...style keys }`, and a rule with no
  // `when` always matches (fallback) — or a single expression string that
  // yields a style map (or NULL). Style keys: color, background, bold,
  // italic, underline, strike, class (own CSS classes), css (extra inline
  // properties); string values may be ${...} templates. Cell expressions see
  // the cell scope with `value` = cellValue (the derived value); row
  // expressions see the row scope.
  const STYLE_KEYS = ["color", "background", "bold", "italic", "underline", "strike", "class", "css"];

  function compileRules(rules, label) {
    const compiled = rules.map((rule, i) => {
      let test = null;
      if (rule.when != null) {
        try { test = compileExpr(String(rule.when)); }
        catch (e) {
          console.warn(`[mkio-table] bad style rule in ${label}: ${e.message}`);
          test = { evaluate: () => false };
        }
      }
      const style = {};
      const dynamic = [];
      const dynamicCss = []; // [prop, CompiledTemplate] inside `css`
      const tmpl = (v) => {
        try { return compileTemplate(v); }
        catch (e) { console.warn(`[mkio-table] bad style template in ${label}: ${e.message}`); return null; }
      };
      for (const k of STYLE_KEYS) {
        if (!(k in rule)) continue;
        const v = rule[k];
        if (typeof v === "string" && v.includes("${")) {
          const t = tmpl(v);
          if (t) dynamic.push([k, t]);
        } else if (k === "css" && v && typeof v === "object") {
          const css = {};
          for (const [prop, pv] of Object.entries(v)) {
            if (typeof pv === "string" && pv.includes("${")) { const t = tmpl(pv); if (t) dynamicCss.push([prop, t]); }
            else css[prop] = pv;
          }
          style.css = css;
        } else style[k] = v;
      }
      return { test, style, dynamic, dynamicCss, label: `${label}[${i}]` };
    });
    return (scope) => {
      for (const r of compiled) {
        if (r.test && !expr.truthy(runCompiled(r.test, scope, r.label))) continue;
        if (!r.dynamic.length && !r.dynamicCss.length) return r.style;
        const out = { ...r.style };
        for (const [k, t] of r.dynamic) {
          const v = runCompiled(t, scope, r.label);
          if (v == null || v === "") continue;
          out[k] = typeof v === "object" ? v : String(v);
        }
        if (r.dynamicCss.length) {
          out.css = { ...(out.css ?? {}) };
          for (const [prop, t] of r.dynamicCss) {
            const v = runCompiled(t, scope, r.label);
            if (v != null && v !== "") out.css[prop] = String(v);
          }
        }
        return out;
      }
      return null;
    };
  }

  function compileStyler(spec_, label) {
    if (Array.isArray(spec_)) return compileRules(spec_, label);
    let c;
    try { c = compileExpr(String(spec_)); }
    catch (e) {
      console.warn(`[mkio-table] bad styler expression in ${label}: ${e.message}`);
      return () => null;
    }
    return (scope) => {
      const v = runCompiled(c, scope, label);
      return v && typeof v === "object" && !Array.isArray(v) ? v : null;
    };
  }

  const cellStylers = {}; // col -> (value, row, col) => style | null
  for (const [c, s] of Object.entries(spec.styles ?? {})) {
    const fn = compileStyler(s, `styles.${c}`);
    cellStylers[c] = (value, row, col) => {
      const scope = cellScope(row, col, true);
      scope.vars.value = value;
      return fn(scope);
    };
  }
  const rowStyler = spec.rowStyle == null ? null // (row) => style | null
    : (() => { const fn = compileStyler(spec.rowStyle, "rowStyle"); return (row) => fn(rowScope(row)); })();
  const hasStylers = rowStyler != null || Object.keys(cellStylers).length > 0;

  // Apply a style result to a cell/row element, first clearing whatever
  // the previous one set. Backgrounds ride a custom property + marker
  // class so the stylesheet stays in charge of precedence — selection
  // tints blend with (rather than vanish under) a styled background.
  function applyStyle(el, style, bgProp, bgClass) {
    const prev = el._mkuiStyle;
    if (!prev && !style) return;
    if (prev) {
      el.style.color = "";
      el.style.fontWeight = "";
      el.style.fontStyle = "";
      el.style.textDecoration = "";
      el.style.removeProperty(bgProp);
      el.classList.remove(bgClass);
      if (prev.class) el.classList.remove(...String(prev.class).split(/\s+/));
      if (prev.css) for (const k of Object.keys(prev.css)) el.style.removeProperty(k);
    }
    el._mkuiStyle = style ?? null;
    if (!style) return;
    if (style.color) el.style.color = style.color;
    if (style.bold) el.style.fontWeight = "bold";
    if (style.italic) el.style.fontStyle = "italic";
    const deco = [style.underline && "underline", style.strike && "line-through"]
      .filter(Boolean).join(" ");
    if (deco) el.style.textDecoration = deco;
    if (style.background) {
      el.style.setProperty(bgProp, style.background);
      el.classList.add(bgClass);
    }
    if (style.class) el.classList.add(...String(style.class).split(/\s+/));
    if (style.css)
      for (const [k, v] of Object.entries(style.css)) el.style.setProperty(k, v);
  }

  function styleCellStyler(td, row, col) {
    const fn = cellStylers[col];
    if (fn)
      applyStyle(td, fn(cellValue(row, col), row, col), "--mkui-cell-bg", "mkui-cell-styled");
  }

  function styleRowStyler(tr, row) {
    if (rowStyler) applyStyle(tr, rowStyler(row), "--mkui-row-bg", "mkui-row-styled");
  }

  // Recompute every styler-driven style on a rendered row — a replace can
  // flip the row's or any cell's styling even where the text didn't change
  // (both may condition on other columns).
  function restyleRowStylers(tr, row) {
    if (!hasStylers) return;
    styleRowStyler(tr, row);
    for (const col of Object.keys(cellStylers)) {
      const td = tr.querySelector(`td[data-col="${CSS.escape(col)}"]`);
      if (td) styleCellStyler(td, row, col);
    }
  }

  // Raw row keys plus formatter-only columns, so derived values feed the
  // same numeric-alignment and width stats as real fields.
  function statColumns(row) {
    const cols = Object.keys(row);
    if (hasValues) {
      for (const k in valueExprs) if (!(k in row)) cols.push(k);
    }
    return cols;
  }

  /* ── Numeric column alignment ─────────────────────────────────────── */

  // Columns whose every non-empty value is numeric are right-aligned with
  // per-cell right padding so decimal points line up down the column. The
  // pad is (column's widest fraction - this cell's fraction) in ch, which
  // is exact in the table's monospace font. maxFrac is a one-way ratchet
  // (deletes don't shrink it), reset when the data is cleared.
  // `temporal`/`timeKind` ratchet the same way for time columns (see
  // lib/timeparse.js), and `min`/`max` track the value range of numeric and
  // temporal columns for the range filter's placeholders.
  const colStats = new Map(); // col -> { numeric, maxFrac, maxIntW, maxTextW, temporal, timeKind, min, max }

  // Canvas text measurement in the table font — lets ingestion grow column
  // widths from raw values without touching DOM layout. chW is the width of
  // one mono character ("0"), the same unit as maxFrac's ch padding.
  let measureCtx = null, chW = 0;
  function ensureMeasureCtx() {
    if (measureCtx) return true;
    if (typeof getComputedStyle !== "function") return false;
    const cs = getComputedStyle(table);
    if (!cs.fontSize || cs.fontSize === "0px") return false; // not styled yet
    const ctx = document.createElement("canvas").getContext?.("2d");
    if (!ctx) return false;
    ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const w = ctx.measureText("0").width;
    if (!(w > 0)) return false;
    measureCtx = ctx;
    chW = w;
    return true;
  }

  // Length of the "." + fraction-digits suffix, 0 for integers.
  const fracLen = (s) => {
    const i = s.indexOf(".");
    return i < 0 ? 0 : s.length - i;
  };

  function styleCell(td, col) {
    const st = colStats.get(col);
    const s = td.textContent;
    if (st && st.numeric && s !== "") {
      td.classList.add("mkui-num");
      const pad = st.maxFrac - fracLen(s);
      if (pad > 0) td.style.setProperty("--mkui-num-pad", pad + "ch");
      else td.style.removeProperty("--mkui-num-pad");
    } else {
      td.classList.remove("mkui-num");
      td.style.removeProperty("--mkui-num-pad");
    }
  }

  function restyleColumn(col) {
    for (const tr of rowEls.values()) {
      const td = tr.querySelector(`td[data-col="${CSS.escape(col)}"]`);
      if (td) styleCell(td, col);
    }
  }

  // Temporal detection: every non-empty value must be a natively recognised
  // time string, and their kinds must agree (dates and date-times mix as
  // date-times; a clock time next to a date is not a time column).
  function bumpTemporal(st, v) {
    const kind = typeof v === "string" ? detectTimeKind(v) : null;
    if (!kind || (st.timeKind && st.timeKind !== kind && (kind === "time" || st.timeKind === "time"))) {
      st.temporal = false;
      st.timeKind = null;
      if (!st.numeric) st.min = st.max = null;
      return;
    }
    if (!st.timeKind || kind === "datetime") st.timeKind = kind;
    if (st.numeric) return; // a numeric column keeps its numeric range
    const secs = parseTime(v);
    if (secs === null) return;
    if (st.min === null || secs < st.min) st.min = secs;
    if (st.max === null || secs > st.max) st.max = secs;
  }

  function bumpStats(row) {
    dataSeen = true;
    const canMeasure = ensureMeasureCtx();
    for (const k of statColumns(row)) {
      if (k.startsWith("_mkio_")) continue;
      const v = cellValue(row, k);
      if (v == null || v === "") continue;
      let st = colStats.get(k);
      if (!st) {
        st = { numeric: true, maxFrac: 0, maxIntW: 0, maxTextW: 0, temporal: true, timeKind: null, min: null, max: null };
        colStats.set(k, st);
      }
      // Widths and decimal padding measure what's shown (the display text,
      // plus the boxes icons and bars occupy); whether the column is numeric
      // is judged on the value.
      const d = displayExprs[k] ? cellDisplay(row, k) : null;
      const s = d ? d.text : String(v);
      let extraW = d?.rich ? richExtraWidth(d.rich) : 0;
      // The caret column carries the indent and the toggle too.
      if (tree && k === treeCol()) extraW += TREE_TOGGLE_W + rowDepth(row[idKey]) * TREE_INDENT;
      let grew = false;
      if (st.numeric) {
        let changed = false;
        const n = Number(String(v));
        if (isNaN(n)) {
          st.numeric = false;
          st.min = st.max = null;
          changed = true;
        } else {
          const f = fracLen(s);
          if (f > st.maxFrac) { st.maxFrac = f; changed = grew = true; }
          if (st.min === null || n < st.min) st.min = n;
          if (st.max === null || n > st.max) st.max = n;
        }
        if (changed) restyleColumn(k);
      }
      if (st.temporal) bumpTemporal(st, v);
      if (!canMeasure) continue;
      // Width ratchet: numeric strings are ASCII, exactly 1ch per char in
      // the mono table font; text is canvas-measured, skipped when even at
      // 2ch per char (fullwidth glyphs) it can't beat the current max.
      let w;
      if (st.numeric) w = s.length * chW + extraW;
      else if (2 * s.length * chW + extraW <= st.maxTextW) w = 0;
      else w = measureCtx.measureText(s).width + extraW;
      if (w > st.maxTextW) { st.maxTextW = w; grew = true; }
      if (st.numeric) {
        const iw = w - fracLen(s) * chW; // width of the integer part
        if (iw > st.maxIntW) { st.maxIntW = iw; grew = true; }
      }
      if (grew) growColWidth(k, st);
    }
  }

  /* ── Tree rows ────────────────────────────────────────────────────── */

  // Structure lives beside `rows`: `parentOf` (key → parent key, null for a
  // root), `kids` (parent key, null for the roots → child keys in
  // insertion order), `depthOf`, and `expanded`. Linking is by value:
  // `byParentVals` maps a row's `parent` field values (joined) to the keys
  // carrying them — the first is the parent — and `pendingKids` holds the
  // children whose parent has not arrived (a later page, or a stream
  // ordered child-first); when it does, they re-parent. Sorting is per
  // sibling group (`sortedKids`, cached per parent and dropped when the
  // group's membership or a member's sort key changes).
  const parentOf = new Map();
  const kids = new Map();
  const depthOf = new Map();
  const expanded = new Set();
  const byParentVals = new Map(); // vals → Set<key>
  const pendingKids = new Map();  // vals → Set<key>
  const sortedKidsCache = new Map();
  const warnedTree = new Set();
  const EMPTY = [];

  const fieldVals = (row, fields) => {
    let allEmpty = true;
    const parts = fields.map((f) => {
      const v = cellValue(row, f);
      if (v != null && v !== "") allEmpty = false;
      return v == null ? "" : String(v);
    });
    return allEmpty ? null : parts.join("\0");
  };
  const childVals = (row) => fieldVals(row, tree.child);
  const parentVals = (row) => fieldVals(row, tree.parent);
  const rowDepth = (key) => depthOf.get(key) ?? 0;
  const isRootKey = (key) => (parentOf.get(key) ?? null) === null;
  const hasKids = (key) => (kids.get(key)?.length ?? 0) > 0;

  function addKid(pk, key, at = -1) {
    let a = kids.get(pk);
    if (!a) kids.set(pk, (a = []));
    if (at >= 0 && at < a.length) a.splice(at, 0, key); else a.push(key);
    sortedKidsCache.delete(pk);
  }
  function dropKid(pk, key) {
    const a = kids.get(pk);
    if (!a) return;
    const i = a.indexOf(key);
    if (i >= 0) a.splice(i, 1);
    if (!a.length && pk !== null) kids.delete(pk);
    sortedKidsCache.delete(pk);
  }
  const addTo = (map, k, key) => { let s = map.get(k); if (!s) map.set(k, (s = new Set())); s.add(key); };
  const dropFrom = (map, k, key) => { const s = map.get(k); if (s) { s.delete(key); if (!s.size) map.delete(k); } };

  function setDepth(key, d) {
    if (depthOf.get(key) !== d) {
      depthOf.set(key, d);
      syncDepth(key, d); // a re-parented row's element may be on screen
    }
    if (d < tree.expand) expanded.add(key);
    for (const c of kids.get(key) ?? EMPTY) setDepth(c, d + 1);
  }

  // Re-indent a rendered row (render() reuses keyed elements, so a moved
  // subtree keeps its trs).
  function syncDepth(key, d) {
    const tr = rowEls.get(key);
    if (!tr) return;
    tr.dataset.depth = String(d);
    for (const td of tr.children) {
      if (!td._mkuiTreeText) continue;
      if (d) td.style.setProperty("--mkui-tree-depth", String(d));
      else td.style.removeProperty("--mkui-tree-depth");
    }
  }

  // Would making `pk` the parent of `key` close a loop?
  function wouldCycle(key, pk) {
    for (let k = pk; k != null; k = parentOf.get(k) ?? null) if (k === key) return true;
    return false;
  }

  // Attach `key` under `pk` (null = root). Returns whether the view needs
  // a rebuild (a re-parent moves a subtree; a fresh leaf does not).
  function attach(key, pk, at = -1) {
    parentOf.set(key, pk);
    addKid(pk, key, at);
    setDepth(key, pk === null ? 0 : rowDepth(pk) + 1);
  }

  // Link a new row: publish its parent values so pending children find
  // it, then find its own parent (or wait for one). Returns true when the
  // view needs a full rebuild — orphans re-parented under this row.
  function linkRow(row) {
    const key = row[idKey];
    let rebuild = false;
    const pv = parentVals(row);
    if (pv !== null) {
      addTo(byParentVals, pv, key);
      const waiting = pendingKids.get(pv);
      if (waiting && [...byParentVals.get(pv)][0] === key) {
        pendingKids.delete(pv);
        for (const ck of waiting) {
          if (wouldCycle(ck, key)) continue; // stays an orphan
          if (parentOf.has(ck)) dropKid(parentOf.get(ck), ck);
          attach(ck, key);
          rebuild = true;
        }
      }
    }
    const cv = childVals(row);
    let pk = null;
    if (cv !== null) {
      const cands = byParentVals.get(cv);
      const cand = cands ? [...cands][0] : undefined;
      if (cand !== undefined && cand !== key && !wouldCycle(key, cand)) pk = cand;
      else {
        if (cand !== undefined && !warnedTree.has("cycle")) {
          warnedTree.add("cycle");
          console.warn("[mkio-table] tree: a row descends from itself; shown as a root");
        }
        addTo(pendingKids, cv, key);
        if (tree.orphans === "hide") { parentOf.set(key, undefined); depthOf.set(key, 0); return rebuild; }
      }
    }
    attach(key, pk);
    return rebuild;
  }

  // Forget a row: its children become orphans (roots, or hidden), still
  // waiting on the parent values they name. Returns whether the view needs
  // a rebuild (the row had children).
  function unlinkRow(row) {
    const key = row[idKey];
    const pv = parentVals(row);
    if (pv !== null) dropFrom(byParentVals, pv, key);
    const cv = childVals(row);
    if (cv !== null) dropFrom(pendingKids, cv, key);
    const pk = parentOf.get(key);
    // Where the row sat among the roots: orphaned children take its place
    // rather than trailing the list.
    let slot = pk === null ? kids.get(null)?.indexOf(key) ?? -1 : -1;
    if (pk !== undefined) dropKid(pk, key);
    parentOf.delete(key);
    depthOf.delete(key);
    expanded.delete(key);
    sortedKidsCache.delete(key);
    const children = kids.get(key);
    if (!children) return false;
    kids.delete(key);
    const next = pv !== null ? [...byParentVals.get(pv) ?? []][0] : undefined;
    for (const ck of children) {
      if (next !== undefined && !wouldCycle(ck, next)) { attach(ck, next); continue; }
      const ccv = childVals(rows.get(ck));
      if (ccv !== null) addTo(pendingKids, ccv, ck);
      if (tree.orphans === "hide") { parentOf.set(ck, undefined); setDepth(ck, 0); }
      else attach(ck, null, slot < 0 ? -1 : slot++);
    }
    return true;
  }

  // Hidden orphans (`orphans = "hide"`) have parentOf === undefined; a
  // linked row has a key (or null for a root).
  const isLinked = (key) => parentOf.get(key) !== undefined;

  function sortedKids(pk) {
    const a = kids.get(pk) ?? EMPTY;
    if (!sortKeys.length || a.length < 2) return a;
    let s = sortedKidsCache.get(pk);
    if (!s) {
      s = a.slice().sort((x, y) => compareRows(rows.get(x), rows.get(y)));
      sortedKidsCache.set(pk, s);
    }
    return s;
  }

  // Whether a row shows under the filters. Top-level and children-scoped
  // filters judge a row on its own and a miss hides its subtree
  // (`matchesFilters`). A "branch" filter judges every row but
  // keeps the way to a match: a row whose own values miss still shows
  // when any descendant matches, and a row with no match anywhere below
  // it goes — so `subtreeOk` (rebuilt with the view whenever such a filter
  // is active, else null) holds the post-order verdict per row.
  let subtreeOk = null;
  const allScopeActive = () => { if (!tree) return false; for (const k of filters.keys()) if (k.endsWith("\0all")) return true; return false; };
  const treeShown = (key) => matchesFilters(rows.get(key)) && (!subtreeOk || subtreeOk.get(key) === true);

  function buildSubtreeOk() {
    subtreeOk = new Map();
    const walk = (key) => {
      const row = rows.get(key);
      // Off-scope filters prune first (with the subtree); the rest decide
      // between the row's own values and its descendants'.
      if (!matchesFilters(row)) { subtreeOk.set(key, false); return false; }
      let ok = passesAllScoped(row);
      for (const c of kids.get(key) ?? EMPTY) if (walk(c)) ok = true;
      subtreeOk.set(key, ok);
      return ok;
    };
    for (const key of kids.get(null) ?? EMPTY) walk(key);
  }

  // Row numbers in a tree are positions: a row's 1-based rank among its
  // siblings in the current order — top-level rows 1..n, the children of
  // row 5 are 5.1..5.m, and so on. A filtered-out row keeps its slot, so
  // the numbers around it show the gap. `rankOf` holds the rank of every
  // row in an expanded group (a collapsed group's entries are stale and
  // rewritten on expansion); the dotted label is built on demand by
  // `rowLabel` from the ancestors' ranks, so shifting a row's siblings
  // never touches its descendants. Ranks are written by the walks that
  // already flatten the tree (`flattenVisible`, `rebuildView`) and nudged
  // by one per later sibling on a live insert or delete (`shiftRanks`).
  // A flat table numbers by view position until a filter is active; then
  // `rankOf` holds positions over every row in sort order (`flatRanks`),
  // kept by O(n) passes on live inserts and deletes.
  const rankOf = new Map();
  const flatRanked = () => !tree && filters.size > 0;
  function flatRanks() {
    const all = sortKeys.length ? baseOrder.slice().sort((a, b) => compareRows(rows.get(a), rows.get(b))) : baseOrder;
    let i = 0;
    for (const key of all) rankOf.set(key, ++i);
  }
  // A new row's rank among every row: after all rows that sort before it
  // (ties keep arrival order, so after equals too); later rows move down.
  function flatRankInsert(row) {
    const key = row[idKey];
    if (!sortKeys.length) { rankOf.set(key, baseOrder.length); return; }
    let rank = 1;
    for (const k of baseOrder) {
      if (k === key) continue;
      if (compareRows(rows.get(k), row) <= 0) rank++;
      else rankOf.set(k, (rankOf.get(k) ?? 0) + 1);
    }
    rankOf.set(key, rank);
  }
  function flatRankDelete(key) {
    const r = rankOf.get(key);
    if (r == null) return;
    rankOf.delete(key);
    for (const [k, v] of rankOf) if (v > r) rankOf.set(k, v - 1);
  }
  function rowLabel(key, memo) {
    let s = memo?.get(key);
    if (s !== undefined) return s;
    const p = parentOf.get(key);
    s = p == null ? String(rankOf.get(key) ?? 0) : rowLabel(p, memo) + "." + (rankOf.get(key) ?? 0);
    memo?.set(key, s);
    return s;
  }
  // Move the ranks of `key`'s later siblings (shown or not) by `delta`.
  function shiftRanks(pk, key, delta) {
    const sibs = sortedKids(pk);
    for (let j = sibs.indexOf(key) + 1; j < sibs.length; j++) {
      const s = sibs[j];
      rankOf.set(s, (rankOf.get(s) ?? 0) + delta);
    }
  }

  // The visible flattening of `key`'s subtree, `key` first: children of an
  // expanded row in sibling-sorted order, each pruned with its subtree when
  // a filter hides it, ranked as they go.
  function flattenVisible(key, out = []) {
    out.push(key);
    if (!expanded.has(key)) return out;
    let i = 0;
    for (const c of sortedKids(key)) {
      rankOf.set(c, ++i); // every sibling takes a number, hidden ones too
      if (!treeShown(c)) continue;
      flattenVisible(c, out);
    }
    return out;
  }

  // Index of the last view row inside the subtree that starts at view
  // index vi — pre-order keeps a subtree contiguous.
  function subtreeEnd(vi) {
    const d = rowDepth(view[vi]);
    let j = vi + 1;
    while (j < view.length && rowDepth(view[j]) > d) j++;
    return j - 1;
  }

  // Splice a freshly linked row (and whatever of its subtree shows) into
  // the view: right after the parent, or after the visible subtree of its
  // nearest visible earlier sibling. Nothing to do when the parent is
  // collapsed or itself off-view.
  function treeInsertIntoView(key) {
    if (!isLinked(key)) return;
    const pk = parentOf.get(key);
    let base = -1;
    if (pk !== null) {
      base = view.indexOf(pk);
      if (base < 0 || !expanded.has(pk)) return;
    }
    const sibs = sortedKids(pk);
    const si = sibs.indexOf(key);
    rankOf.set(key, si + 1); // its slot among all siblings, shown or not
    shiftRanks(pk, key, 1);
    if (!treeShown(key)) return;
    let pos = base + 1;
    for (let j = si - 1; j >= 0; j--) {
      const vi = view.indexOf(sibs[j]);
      if (vi >= 0) { pos = subtreeEnd(vi) + 1; break; }
    }
    view.splice(pos, 0, ...flattenVisible(key));
  }

  // Drop hidden rows from the selection (a collapse, like a filter, takes
  // them off the table the user sees). Cell rects lose the rows from their
  // key snapshots; a rect left empty goes.
  function pruneSelection(gone) {
    if (!gone.size) return;
    for (const k of gone) selectedKeys.delete(k);
    if (selectedAnchor != null && gone.has(selectedAnchor)) selectedAnchor = null;
    if (cellRects.length) {
      for (const r of cellRects) if (r.keys) for (const k of gone) r.keys.delete(k);
      cellRects = cellRects.filter((r) => r.keys?.size);
    }
    if (cellOff.size)
      for (const k of [...cellOff]) if (gone.has(k.slice(0, k.indexOf("\0")))) cellOff.delete(k);
  }

  // Expand or collapse one row. Incremental: an expansion splices the
  // visible subtree in after the row, a collapse cuts the contiguous run
  // of its descendants; both O(subtree) plus one splice. The focused cell
  // inside a collapsing subtree lands on the row that swallowed it.
  function setExpanded(key, on) {
    if (!tree || expanded.has(key) === on) return false;
    if (on) expanded.add(key); else expanded.delete(key);
    if (!hasKids(key)) return true; // remembered; nothing to show yet
    const vi = viewDirty ? -1 : view.indexOf(key);
    if (vi >= 0) {
      if (on) {
        const sub = flattenVisible(key);
        sub.shift();
        view.splice(vi + 1, 0, ...sub);
      } else {
        const gone = new Set(view.splice(vi + 1, subtreeEnd(vi) - vi));
        pruneSelection(gone);
        if (focusCell && gone.has(focusCell.key)) focusCell = { key, col: focusCell.col, idx: vi };
      }
      viewRev++;
    }
    syncToggle(key);
    syncTreeAll();
    render();
    if (hasButtons) updateButtonStates();
    publishSelection();
    return true;
  }

  // Expand a whole subtree (shift+click, `*`) or collapse it.
  function setExpandedDeep(key, on) {
    const walk = (k) => { if (on) expanded.add(k); else expanded.delete(k); for (const c of kids.get(k) ?? EMPTY) walk(c); };
    if (on) { walk(key); setExpandedApplied(); return; }
    // Collapse the top first (one incremental cut), then forget the rest.
    setExpanded(key, false);
    walk(key);
  }

  // Open every row above `depth` (Infinity = all) and close the rest.
  function setExpandDepth(depth) {
    if (!tree) return;
    expanded.clear();
    for (const [k, d] of depthOf) if (d < depth) expanded.add(k);
    setExpandedApplied();
  }

  // After bulk changes to `expanded`: rebuild, prune what left the view.
  function setExpandedApplied() {
    markViewDirty();
    rebuildView();
    const inView = new Set(view);
    const gone = new Set();
    for (const k of selectedKeys) if (!inView.has(k)) gone.add(k);
    for (const r of cellRects) for (const k of r.keys ?? EMPTY) if (!inView.has(k)) gone.add(k);
    pruneSelection(gone);
    if (focusCell && !inView.has(focusCell.key)) {
      // Climb to the nearest shown ancestor.
      let k = parentOf.get(focusCell.key);
      while (k != null && !inView.has(k)) k = parentOf.get(k);
      focusCell = k != null ? { key: k, col: focusCell.col, idx: view.indexOf(k) } : null;
    }
    for (const key of rowEls.keys()) syncToggle(key);
    syncTreeAll();
    render();
    if (hasButtons) updateButtonStates();
    publishSelection();
  }

  const anyExpanded = () => { for (const k of expanded) if (hasKids(k)) return true; return false; };

  // The column that carries the carets: the configured one while it shows,
  // else the first visible column.
  function treeCol() {
    if (!tree || !columns) return null;
    const vis = visibleColumns();
    return tree.column && vis.includes(tree.column) ? tree.column : vis[0] ?? null;
  }

  function makeToggle(key) {
    const t = document.createElement("span");
    t.className = "mkui-tree-toggle";
    t.appendChild(icon("chevron-right"));
    t.addEventListener("pointerdown", (e) => { e.stopPropagation(); });
    t.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!hasKids(key)) return;
      if (e.shiftKey) setExpandedDeep(key, !expanded.has(key));
      else setExpanded(key, !expanded.has(key));
    });
    return t;
  }

  // The caret reflects the row: open, closed, or a leaf (kept as a blank
  // of the same width so text stays aligned per level).
  function syncToggle(key, tr = rowEls.get(key)) {
    const t = tr?.querySelector(".mkui-tree-toggle");
    if (!t) return;
    const leaf = !hasKids(key);
    t.classList.toggle("mkui-tree-leaf", leaf);
    t.classList.toggle("open", !leaf && expanded.has(key));
    t.title = leaf ? "" : expanded.has(key) ? "Collapse (shift: whole subtree)" : "Expand (shift: whole subtree)";
  }

  function syncTreeAll() {
    const t = thead.querySelector?.(".mkui-tree-all");
    if (!t) return;
    const open = anyExpanded();
    t.classList.toggle("open", open);
    t.title = open ? "Collapse all" : "Expand all roots (shift: every level)";
  }

  function onTreeKey(e) {
    if (!tree || e.ctrlKey || e.metaKey || e.altKey) return false;
    if (e.key !== "Enter" && e.key !== "*") return false;
    if (!ensureFocusCell()) return false;
    const key = focusCell.key;
    if (!hasKids(key)) return false;
    if (e.key === "*") setExpandedDeep(key, true);
    else setExpanded(key, !expanded.has(key));
    return true;
  }

  /* ── Virtualized rows ─────────────────────────────────────────────── */

  // Only the rows overlapping the viewport (plus OVERSCAN each side) exist
  // in the DOM; the spacer rows carry the height of everything else. Data
  // lives in `rows`/`baseOrder`, display order in `view` (keys). This keeps
  // scrolling, pane resizing, and frame moves O(visible), independent of
  // row count.
  const OVERSCAN = 10;
  let rowH = 21;
  let rowHMeasured = false;
  let renderedStart = -1, renderedEnd = -1, renderedRev = -1;

  function markViewDirty() { viewDirty = true; viewRev++; }

  function rebuildView() {
    view = [];
    if (tree) {
      // Pre-order over the roots: a row shows when it passes the filters,
      // its children when it is expanded too (see "Tree rows").
      subtreeOk = null;
      if (allScopeActive()) buildSubtreeOk();
      let i = 0;
      for (const key of sortedKids(null)) {
        rankOf.set(key, ++i);
        if (treeShown(key)) flattenVisible(key, view);
      }
      viewDirty = false;
      return;
    }
    for (const key of baseOrder) {
      const r = rows.get(key);
      if (r && matchesFilters(r)) view.push(key);
    }
    if (sortKeys.length) view.sort((a, b) => compareRows(rows.get(a), rows.get(b)));
    if (flatRanked()) flatRanks();
    viewDirty = false;
  }

  // Binary-search insert position for `row` in the sorted view.
  function viewInsertPos(row) {
    if (!sortKeys.length) return view.length;
    let lo = 0, hi = view.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (compareRows(rows.get(view[mid]), row) <= 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function viewIndexOf(row) {
    const key = row[idKey];
    if (!sortKeys.length || tree) return view.indexOf(key); // a tree view is sorted per group, not globally
    // binary search to the start of the equal-compare range, then scan it
    let lo = 0, hi = view.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (compareRows(rows.get(view[mid]), row) < 0) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < view.length && compareRows(rows.get(view[i]), row) === 0; i++)
      if (view[i] === key) return i;
    return view.indexOf(key); // row no longer matches its view slot — linear fallback
  }

  // Data-level insert; the DOM row appears via render(). In a tree the row
  // is linked first (its depth sizes the caret column), then spliced into
  // the view incrementally — unless `deferView` (bulk ingestion: one
  // rebuild per chunk beats a splice per row) or a re-parent made the
  // view stale anyway.
  function insertRow(row, deferView = false) {
    const key = row[idKey];
    rows.set(key, row);
    baseOrder.push(key);
    if (tree) {
      const rebuild = linkRow(row);
      bumpStats(row);
      // A "branch" filter can change an ancestor's verdict: rebuild.
      if (rebuild || deferView || allScopeActive()) markViewDirty();
      else if (!viewDirty) treeInsertIntoView(key);
      const pk = parentOf.get(key);
      if (pk != null) syncToggle(pk); // the parent may have just become one
      viewRev++;
      return;
    }
    bumpStats(row);
    if (flatRanked() && !deferView) flatRankInsert(row);
    if (matchesFilters(row)) {
      if (sortKeys.length) view.splice(viewInsertPos(row), 0, key);
      else view.push(key);
    }
    viewRev++;
  }

  function clearData() {
    rows.clear();
    rowEls.clear();
    colStats.clear();
    parentOf.clear(); kids.clear(); depthOf.clear(); expanded.clear();
    byParentVals.clear(); pendingKids.clear(); sortedKidsCache.clear(); rankOf.clear();
    if (tree) { rowNumDigits = 2; widthsDirty = true; } // the label-width ratchet restarts with the data
    baseOrder = [];
    view = [];
    viewDirty = false;
    viewRev++;
    renderedStart = renderedEnd = renderedRev = -1;
    tbody.innerHTML = "";
    topSpacerTd.style.height = "0px";
    botSpacerTd.style.height = "0px";
    tbody.append(topSpacer, botSpacer);
  }

  function render() {
    if (rowColumn && !tree) {
      const d = String(Math.max(1, rows.size)).length; // numbers span every row, filtered or not
      if (d !== rowNumDigits) {
        rowNumDigits = d;
        if (widthsInited) widthsDirty = true;
      }
    }
    if (widthsDirty) {
      widthsDirty = false;
      if (widthsInited) renderColgroup();
    }
    if (viewDirty) rebuildView();
    // A data change under an open find strip: rescan after a pause.
    if (findRe && findScanRev !== viewRev) scheduleFindRescan();
    const total = view.length;
    const vh = scrollHost.clientHeight || 400;
    const st = scrollHost.scrollTop || 0;
    const start = Math.max(0, Math.floor(st / rowH) - OVERSCAN);
    const end = Math.min(total, Math.ceil((st + vh) / rowH) + OVERSCAN);
    if (start === renderedStart && end === renderedEnd && viewRev === renderedRev) return;
    renderedStart = start; renderedEnd = end; renderedRev = viewRev;

    topSpacerTd.style.height = (start * rowH) + "px";
    botSpacerTd.style.height = ((total - end) * rowH) + "px";

    // Walk the slice in order, moving/creating only rows that are out of
    // place — untouched rows keep their running CSS flash animations.
    let cursor = topSpacer;
    const labels = tree && rowColumn ? new Map() : null; // rowLabel memo for this slice
    let labelW = 0;
    for (let i = start; i < end; i++) {
      const key = view[i];
      let tr = rowEls.get(key);
      if (!tr) {
        tr = buildRow(rows.get(key));
        rowEls.set(key, tr);
      }
      if (cursor.nextSibling !== tr) tbody.insertBefore(tr, cursor.nextSibling);
      cursor = tr;
      tr._viewIdx = i;
      if (rowColumn) {
        const nd = tr.children[0];
        const num = labels ? rowLabel(key, labels) : flatRanked() ? String(rankOf.get(key) ?? i + 1) : String(i + 1);
        if (num.length > labelW) labelW = num.length;
        if (nd && nd.textContent !== num) nd.textContent = num;
      }
      styleRowSelection(tr, key, i);
    }
    if (rowEls.size > end - start) {
      const want = new Set();
      for (let i = start; i < end; i++) want.add(view[i]);
      for (const [key, tr] of rowEls) {
        if (!want.has(key)) { tr.remove(); rowEls.delete(key); }
      }
    }
    // Tree labels ratchet the number column: the widest label painted so
    // far sets it (reset with the data), so it never jitters as you scroll.
    if (labels && labelW > rowNumDigits) {
      rowNumDigits = labelW;
      if (widthsInited) renderColgroup();
    }

    if (!rowHMeasured && end > start) {
      // Measure the row PITCH (top-to-top of adjacent rows) when two rows
      // are rendered: border-collapse splits row borders across neighbors,
      // so a single row's rect height is ~0.5px short of the true pitch —
      // an error that compounds linearly with the row index.
      const r1 = rowEls.get(view[start])?.getBoundingClientRect();
      const r2 = end - start > 1
        ? rowEls.get(view[start + 1])?.getBoundingClientRect() : null;
      const h = r2 && r1 && r2.top > r1.top ? r2.top - r1.top : r1?.height;
      if (h) {
        rowHMeasured = true;
        if (h !== rowH) { rowH = h; renderedStart = -2; render(); }
      }
    }
  }

  /* ── Sort & filter state ──────────────────────────────────────────── */

  const sortKeys = [];
  // col -> { kind: "values", mode: "include" | "exclude", values: Set<string> }
  //      | { kind: "range", type: "number" | "time", lo, hi, preset, empty,
  //          timeKind, spec, localTz }
  // A values filter keeps display texts and the side they live on: `exclude`
  // hides the listed values and lets everything else through (values the
  // dropdown has never seen included), `include` shows only the listed
  // ones. The dropdown picks the mode from the last bulk action — "Select
  // all" (and the untouched all-checked start) then unchecking builds an
  // exclusion; "Clear" then checking builds an inclusion — so live inserts,
  // updates, and stream pages are judged by the intent, not by the value
  // list at the time. A range filter keeps
  // bounds in the column's frame (numbers, or seconds — see
  // lib/timeparse.js; a number `hi` is inclusive, a time `hi` exclusive
  // so that a typed date/minute covers its whole unit), the typed bound
  // texts (`loText`/`hiText`) for restoring the inputs, `preset` naming a
  // relative range resolved against the clock on each evaluation, and
  // `empty` whether unparseable/blank values pass. One filter per column —
  // per scope on a tree table, where a column can carry a top, a child,
  // and a branch filter at once: the map is keyed by `fkey(col, scope)`
  // and every filter records its `col` (and `scope`). The dropdown's
  // Values/Range modes replace each other within one filter.
  const filters = new Map();
  const fkey = (col, scope) => tree ? col + "\0" + (scope ?? tree.filterScope) : col;
  // A column's filters in scope order (top, child, branch).
  function colFilters(col) {
    if (!tree) { const f = filters.get(col); return f ? [f] : []; }
    const out = [];
    for (const sc of TREE_SCOPES) { const f = filters.get(fkey(col, sc)); if (f) out.push(f); }
    return out;
  }
  let dropdown = null;
  let dropdownCol = null;
  let dropdownScope = null; // the scope tab open in a tree table's dropdown
  let dropdownCleanup = null;
  let suppressClick = false;

  /* ── Selection state ──────────────────────────────────────────────── */

  // Two mutually exclusive selection modes plus an always-present focused
  // cell (the keyboard cursor):
  //  - row mode:  selectedKeys (row keys) + selectedAnchor
  //  - cell mode: cellRects — rectangles stored as anchor/focus (key, col)
  //    pairs plus a `keys` snapshot of the row keys spanned when the rect
  //    was last user-modified. Membership is that key set × the column
  //    range, resolved lazily to view/column indices, so sorts and filters
  //    move the same records around instead of reinterpreting the
  //    anchor→focus span (and live inserts inside the span don't join the
  //    selection). aIdx/fIdx remember last-known positions for extension
  //    anchoring when a row was deleted. cellOff holds ctrl-toggled-off
  //    cells inside rects.
  // The focused cell is the implicit selection when neither mode has an
  // explicit one — copy and row-unit buttons fall back to it.

  const selectStatePath = spec.select?.state ?? null;
  let lastPublishedRow = undefined; // undefined = nothing published yet
  const selectedKeys = new Set();
  let selectedAnchor = null;
  let cellRects = [];         // [{ aKey, aCol, aIdx, fKey, fCol, fIdx }]
  const cellOff = new Set();  // "key\0col" cells toggled off inside rects
  let focusCell = null;       // { key, col, idx }
  let selRev = 0;             // bumped on any selection change

  const colIndex = (col) => (columns ? visibleColumns().indexOf(col) : -1);

  // Resolve a row key to its view index, falling back to its last-known
  // index (clamped) when the row was deleted or filtered out.
  function keyViewIdx(key, lastIdx) {
    if (lastIdx != null && view[lastIdx] === key) return lastIdx;
    const i = view.indexOf(key);
    if (i >= 0) return i;
    return Math.max(0, Math.min(lastIdx ?? 0, view.length - 1));
  }

  // Snapshot the row keys a rect spans in the current view order — called
  // whenever a user gesture creates or extends the rect. From then on the
  // rect's row membership is these records, wherever they move.
  function snapRectKeys(r) {
    const a = keyViewIdx(r.aKey, r.aIdx), f = keyViewIdx(r.fKey, r.fIdx);
    r.aIdx = a; r.fIdx = f;
    const keys = new Set();
    for (let i = Math.min(a, f); i <= Math.max(a, f); i++) keys.add(view[i]);
    r.keys = keys;
  }

  // Rect bounds in (view row idx, visible col idx) space, cached per
  // view/selection revision — rendering tests visible cells against these.
  // Each rect's key snapshot resolves to one or more contiguous row runs
  // (sorting can scatter the member rows), each × the rect's column range;
  // keys not in the view (deleted or filtered out) simply don't resolve.
  let rectCacheKey = "";
  let rectBoundsCache = [];
  function rectBounds() {
    if (!cellRects.length) return (rectBoundsCache = []);
    const ck = viewRev + ":" + selRev;
    if (rectCacheKey === ck) return rectBoundsCache;
    rectCacheKey = ck;
    rectBoundsCache = [];
    if (!columns || !view.length) return rectBoundsCache;
    const cols = visibleColumns();
    const viewIdx = new Map();
    for (let i = 0; i < view.length; i++) viewIdx.set(view[i], i);
    for (const r of cellRects) {
      const a = viewIdx.get(r.aKey);
      if (a != null) r.aIdx = a;
      const f = viewIdx.get(r.fKey);
      if (f != null) r.fIdx = f;
      const ca = cols.indexOf(r.aCol), cf = cols.indexOf(r.fCol);
      if (ca < 0 || cf < 0 || !r.keys?.size) continue;
      const c1 = Math.min(ca, cf), c2 = Math.max(ca, cf);
      const idxs = [];
      for (const k of r.keys) {
        const i = viewIdx.get(k);
        if (i != null) idxs.push(i);
      }
      idxs.sort((x, y) => x - y);
      for (let s = 0; s < idxs.length; ) {
        let e = s;
        while (e + 1 < idxs.length && idxs[e + 1] === idxs[e] + 1) e++;
        rectBoundsCache.push({ r1: idxs[s], r2: idxs[e], c1, c2 });
        s = e + 1;
      }
    }
    return rectBoundsCache;
  }

  function cellSelected(viewIdx, colIdx, key, col) {
    if (cellOff.has(key + "\0" + col)) return false;
    for (const b of rectBounds())
      if (viewIdx >= b.r1 && viewIdx <= b.r2 && colIdx >= b.c1 && colIdx <= b.c2)
        return true;
    return false;
  }

  function rowInRects(viewIdx) {
    for (const b of rectBounds())
      if (viewIdx >= b.r1 && viewIdx <= b.r2) return true;
    return false;
  }

  // Whether a row is among those the buttons act on: row-selected, focused,
  // or spanned by a cell rect. Live changes to such a row re-gate the buttons;
  // changes to any other row cannot alter what `enable.when` sees.
  function rowInSelection(key) {
    if (selectedKeys.has(key)) return true;
    if (focusCell != null && focusCell.key === key) return true;
    if (!cellRects.length) return false;
    const row = rows.get(key);
    if (!row) return false;
    const vi = viewIndexOf(row);
    return vi >= 0 && rowInRects(vi);
  }

  // Merged [lo, hi] view-index intervals covered by the cell rects — row
  // counts and row materialization work off these without enumerating
  // cells.
  function selectedRowIntervals() {
    const bs = rectBounds();
    if (!bs.length) return [];
    const iv = bs.map((b) => [b.r1, b.r2]).sort((x, y) => x[0] - y[0]);
    const out = [iv[0].slice()];
    for (let i = 1; i < iv.length; i++) {
      const last = out[out.length - 1];
      if (iv[i][0] <= last[1] + 1) last[1] = Math.max(last[1], iv[i][1]);
      else out.push(iv[i].slice());
    }
    return out;
  }

  // Snap the focused cell back onto a live view row (its row may have been
  // deleted or filtered out); establish it if the table has data but no
  // focus yet. Returns false when there is nothing to focus.
  function ensureFocusCell() {
    if (!columns || !view.length) return false;
    const cols = visibleColumns();
    if (!cols.length) return false;
    if (focusCell) {
      const idx = keyViewIdx(focusCell.key, focusCell.idx);
      const col = cols.includes(focusCell.col) ? focusCell.col : cols[0];
      focusCell = { key: view[idx], col, idx };
    } else {
      focusCell = { key: view[0], col: cols[0], idx: 0 };
    }
    return true;
  }

  function styleRowSelection(tr, key, viewIdx) {
    const rowSel = selectedKeys.has(key);
    tr.classList.toggle("mkui-selected", rowSel);
    const hl = (focusCell != null && focusCell.key === key) ||
      (cellRects.length > 0 && rowInRects(viewIdx));
    tr.classList.toggle("mkui-row-hl", !rowSel && hl);
    let ci = 0;
    for (const td of tr.children) {
      const col = td.dataset?.col;
      if (col == null) continue; // row-number cell
      td.classList.toggle("mkui-cell-sel",
        cellRects.length > 0 && cellSelected(viewIdx, ci, key, col));
      td.classList.toggle("mkui-cell-focus",
        focusCell != null && focusCell.key === key && focusCell.col === col);
      // Find: the cell's shown text (renderCell keeps it) against the matcher.
      td.classList.toggle("mkui-cell-match", findRe != null && findRe.test(td._mkuiText ?? ""));
      ci++;
    }
  }

  // Restyle the rendered slice after a selection change (data changes go
  // through render(), which restyles as it walks the slice).
  function refreshSelectionStyles() {
    selRev++;
    for (const [key, tr] of rowEls) {
      if (tr._viewIdx == null) continue;
      styleRowSelection(tr, key, tr._viewIdx);
    }
    if (hasButtons) updateButtonStates();
    publishSelection();
  }

  // `select = { state = "path" }` mirrors the current row into app state so
  // other panes (a detail view, a chart) can follow it. The current row is
  // the cursor's row, else the first selected row in view order, else null —
  // so clearing the selection publishes null rather than a stale row.
  function publishSelection() {
    if (!selectStatePath) return;
    let key = focusCell?.key ?? null;
    if (key == null && selectedKeys.size) {
      for (const k of view) {
        if (selectedKeys.has(k)) { key = k; break; }
      }
    }
    publishRow(key == null ? null : rows.get(key) ?? null);
  }

  // Publish a specific row object. Deduped, so the followers of a state path
  // only see a change when the row they track actually changed.
  function publishRow(row) {
    if (!selectStatePath || row === lastPublishedRow) return;
    lastPublishedRow = row;
    app.state.set(selectStatePath, row);
  }

  function clearCellSelection() {
    cellRects = [];
    cellOff.clear();
  }

  // Full selection reset — for data-reset paths (new snapshot, page fetch,
  // pane reopen) where even the focused cell's row is gone.
  function clearSelection() {
    selectedKeys.clear();
    selectedAnchor = null;
    clearCellSelection();
    focusCell = null;
    refreshSelectionStyles();
  }

  // Esc: drop the selection but keep the cursor. Returns whether there was
  // anything to clear (the caller decides whether to swallow the key).
  function clearSelectionKeepFocus() {
    const had = selectedKeys.size > 0 || cellRects.length > 0;
    selectedKeys.clear();
    selectedAnchor = null;
    clearCellSelection();
    refreshSelectionStyles();
    return had;
  }

  function selectAllRows() {
    if (!view.length) return;
    clearCellSelection();
    selectedKeys.clear();
    for (const key of view) selectedKeys.add(key);
    selectedAnchor = view[0];
    refreshSelectionStyles();
  }

  /* ── Selection interaction (pointer) ──────────────────────────────── */

  // Row-number clicks: plain selects, ctrl/cmd toggles, shift range-selects
  // from the anchor. Row and cell selection are mutually exclusive.
  function handleRowClick(key, e) {
    const metaKey = e.ctrlKey || e.metaKey;
    clearCellSelection();
    if (e.shiftKey && selectedAnchor != null) {
      const anchorIdx = view.indexOf(selectedAnchor);
      const targetIdx = view.indexOf(key);
      if (anchorIdx >= 0 && targetIdx >= 0) {
        if (!metaKey) selectedKeys.clear();
        const lo = Math.min(anchorIdx, targetIdx);
        const hi = Math.max(anchorIdx, targetIdx);
        for (let i = lo; i <= hi; i++) selectedKeys.add(view[i]);
      }
    } else if (metaKey) {
      if (selectedKeys.has(key)) selectedKeys.delete(key);
      else selectedKeys.add(key);
      selectedAnchor = key;
    } else {
      selectedKeys.clear();
      selectedKeys.add(key);
      selectedAnchor = key;
    }
    refreshSelectionStyles();
  }

  function handleCellPointerDown(key, col, e) {
    const meta = e.ctrlKey || e.metaKey;
    const idx = view.indexOf(key);
    if (idx < 0) return;
    selectedKeys.clear(); // cell mode is exclusive with row mode
    selectedAnchor = null;
    let dragRect = null;
    if (e.shiftKey) {
      // Extend the active rect from its anchor (or from the focused cell).
      const last = cellRects[cellRects.length - 1];
      const a = last
        ? { key: last.aKey, col: last.aCol, idx: last.aIdx }
        : { key: focusCell?.key ?? key, col: focusCell?.col ?? col,
            idx: focusCell?.idx ?? idx };
      if (!meta) clearCellSelection();
      else if (last) cellRects.pop();
      dragRect = { aKey: a.key, aCol: a.col, aIdx: a.idx,
                   fKey: key, fCol: col, fIdx: idx };
      snapRectKeys(dragRect);
      cellRects.push(dragRect);
    } else if (meta) {
      const ci = colIndex(col);
      if (cellSelected(idx, ci, key, col)) {
        cellOff.add(key + "\0" + col);
        focusCell = { key, col, idx };
        refreshSelectionStyles();
        return; // a toggle-off doesn't start a drag
      }
      cellOff.delete(key + "\0" + col);
      // A plain-clicked focus cell is implicitly selected — materialize it
      // so ctrl-click extends rather than replaces it (Excel behavior).
      if (!cellRects.length && focusCell && rows.has(focusCell.key) &&
          (focusCell.key !== key || focusCell.col !== col)) {
        const fi = keyViewIdx(focusCell.key, focusCell.idx);
        cellRects.push({ aKey: focusCell.key, aCol: focusCell.col, aIdx: fi,
                         fKey: focusCell.key, fCol: focusCell.col, fIdx: fi,
                         keys: new Set([focusCell.key]) });
      }
      dragRect = { aKey: key, aCol: col, aIdx: idx,
                   fKey: key, fCol: col, fIdx: idx, keys: new Set([key]) };
      cellRects.push(dragRect);
    } else {
      // Plain click: selection collapses to the focused cell (implicit —
      // no rect until an actual drag extends it).
      clearCellSelection();
    }
    focusCell = { key, col, idx };
    refreshSelectionStyles();
    if (e.pointerType !== "touch")
      startCellDrag(e, key, col, idx, dragRect);
  }

  function handleRowPointerDown(key, e) {
    if (e.button !== 0 && e.button !== undefined) return;
    scrollHost.focus?.({ preventScroll: true });
    const td = e.target;
    if (td?.dataset?.col != null) {
      if (e.pointerType === "touch") return; // touch scrolls, no cell drag
      handleCellPointerDown(key, td.dataset.col, e);
    } else {
      // Row-number cell (the only other cell in a data row).
      handleRowClick(key, e);
      const cols = columns ? visibleColumns() : [];
      focusCell = { key, col: cols[0] ?? null, idx: view.indexOf(key) };
      refreshSelectionStyles();
      startRowDrag(e);
    }
  }

  /* ── Drag-to-select ───────────────────────────────────────────────── */

  // Map a pointer position to a (row key, column) cell. Works outside the
  // scroll area too — coordinates clamp to the nearest row/column — so a
  // drag can keep extending while autoscrolling.
  function cellFromPoint(x, y) {
    const rect = scrollHost.getBoundingClientRect?.();
    if (!rect || !view.length || !columns) return null;
    const headH = thead.clientHeight || 0;
    const yy = (y - rect.top) - headH + scrollHost.scrollTop;
    const idx = Math.max(0, Math.min(view.length - 1, Math.floor(yy / rowH)));
    let col = null, best = null, bestDist = Infinity;
    for (const th of thead.querySelectorAll("th")) {
      if (!th.dataset.col) continue;
      const r = th.getBoundingClientRect();
      if (x >= r.left && x < r.right) { col = th.dataset.col; break; }
      const d = x < r.left ? r.left - x : x - r.right;
      if (d < bestDist) { bestDist = d; best = th.dataset.col; }
    }
    col = col ?? best;
    if (col == null) return null;
    return { key: view[idx], col, idx };
  }

  // Shared drag loop: rAF-throttled, autoscrolls when the pointer leaves
  // the scroll area (and keeps scrolling while it stays outside).
  function startSelDrag(e, onCell) {
    const pid = e.pointerId;
    let raf = 0, lastEv = e, done = false;
    const step = () => {
      raf = 0;
      if (done) return;
      const ev = lastEv;
      const rect = scrollHost.getBoundingClientRect?.();
      if (!rect) return;
      const headH = thead.clientHeight || 0;
      let scrolled = false;
      if (ev.clientY < rect.top + headH) {
        scrollHost.scrollTop -= Math.min(40, rect.top + headH - ev.clientY);
        scrolled = true;
      } else if (ev.clientY > rect.bottom) {
        scrollHost.scrollTop += Math.min(40, ev.clientY - rect.bottom);
        scrolled = true;
      }
      if (ev.clientX < rect.left) {
        scrollHost.scrollLeft -= Math.min(40, rect.left - ev.clientX);
        scrolled = true;
      } else if (ev.clientX > rect.right) {
        scrollHost.scrollLeft += Math.min(40, ev.clientX - rect.right);
        scrolled = true;
      }
      if (scrolled) render();
      const hit = cellFromPoint(ev.clientX, ev.clientY);
      if (hit) onCell(hit.key, hit.col, hit.idx);
      if (scrolled) raf = requestAnimationFrame(step);
    };
    const onMove = (ev) => {
      if (ev.pointerId !== pid) return;
      lastEv = ev;
      if (!raf) raf = requestAnimationFrame(step);
    };
    const onUp = (ev) => {
      if (ev.pointerId !== pid) return;
      done = true;
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  }

  // `rect` is the active rect to extend (shift / ctrl starts); a plain
  // click passes null and the rect materializes on the first real move.
  function startCellDrag(e, aKey, aCol, aIdx, rect) {
    startSelDrag(e, (key, col, idx) => {
      if (!rect) {
        if (key === aKey && col === aCol) return;
        rect = { aKey, aCol, aIdx, fKey: key, fCol: col, fIdx: idx };
        snapRectKeys(rect);
        cellRects.push(rect);
      } else if (rect.fKey === key && rect.fCol === col) {
        return;
      } else {
        rect.fKey = key; rect.fCol = col; rect.fIdx = idx;
        snapRectKeys(rect);
      }
      focusCell = { key, col, idx };
      refreshSelectionStyles();
    });
  }

  function startRowDrag(e) {
    const base = (e.ctrlKey || e.metaKey) ? new Set(selectedKeys) : null;
    const aIdx = keyViewIdx(selectedAnchor, 0);
    startSelDrag(e, (key, col, idx) => {
      selectedKeys.clear();
      if (base) for (const k of base) selectedKeys.add(k);
      const lo = Math.min(aIdx, idx), hi = Math.max(aIdx, idx);
      for (let i = lo; i <= hi; i++) selectedKeys.add(view[i]);
      focusCell = { key, col: focusCell?.col ?? col, idx };
      refreshSelectionStyles();
    });
  }

  /* ── Keyboard navigation ──────────────────────────────────────────── */

  function scrollFocusIntoView() {
    if (!focusCell) return;
    const idx = keyViewIdx(focusCell.key, focusCell.idx);
    const headH = thead.clientHeight || 0;
    // Coarse pass: rowH-based estimate, enough to get the row rendered.
    const top = idx * rowH;
    const viewH = (scrollHost.clientHeight || 0) - headH;
    if (top < scrollHost.scrollTop) scrollHost.scrollTop = top;
    else if (top + rowH > scrollHost.scrollTop + viewH)
      scrollHost.scrollTop = top + rowH - viewH;
    render();
    // Exact pass: any residual rowH drift (sub-pixel pitch, zoom) still
    // accumulates over hundreds of rows, so measure the rendered row's
    // real rect and correct by the exact overshoot. Skipped when the
    // viewport is shorter than the sticky header (degenerate layout).
    const ftr = rowEls.get(focusCell.key);
    if (ftr?.getBoundingClientRect && scrollHost.getBoundingClientRect) {
      const rr = ftr.getBoundingClientRect();
      const hr = scrollHost.getBoundingClientRect();
      if (rr.height > 0 && hr.bottom > hr.top + headH) {
        if (rr.top < hr.top + headH) {
          scrollHost.scrollTop -= hr.top + headH - rr.top;
          render();
        } else if (rr.bottom > hr.bottom) {
          scrollHost.scrollTop += rr.bottom - hr.bottom;
          render();
        }
      }
    }
    const th = focusCell.col != null && thead.querySelector
      ? thead.querySelector(`th[data-col="${CSS.escape(focusCell.col)}"]`) : null;
    if (th) scrollHeaderIntoView(th);
    render();
  }

  // Horizontal scroll so a header cell is fully visible, clear of the
  // sticky row-number column.
  function scrollHeaderIntoView(th) {
    if (!th.getBoundingClientRect || !scrollHost.getBoundingClientRect) return;
    const tr = th.getBoundingClientRect();
    const hr = scrollHost.getBoundingClientRect();
    const stickyW = rowColumn
      ? (thead.querySelector(".mkui-th-rownum")?.getBoundingClientRect()?.width ?? 0)
      : 0;
    if (tr.left < hr.left + stickyW)
      scrollHost.scrollLeft -= hr.left + stickyW - tr.left;
    else if (tr.right > hr.right)
      scrollHost.scrollLeft += tr.right - hr.right;
  }

  function onTableKeyDown(e) {
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (!columns || !view.length) return;
    const meta = e.ctrlKey || e.metaKey;
    const cols = visibleColumns();

    // Find strip open: F3 / ctrl-cmd+G step the matches (shift reverses).
    if (findOpen && typeof e.key === "string" && !e.altKey &&
        (e.key === "F3" || (meta && e.key.toLowerCase() === "g"))) {
      findGo(e.shiftKey ? -1 : 1);
      e.preventDefault?.();
      return;
    }

    // Tree: Enter toggles the focused row, `*` opens its whole subtree.
    if (onTreeKey(e)) { e.preventDefault?.(); return; }

    if (e.key === " ") {
      // Spacebar selects the focused row (shift+space is the same, Excel
      // muscle memory); ctrl/cmd+space toggles it within the set.
      if (!ensureFocusCell()) return;
      clearCellSelection();
      const key = focusCell.key;
      if (meta) {
        if (selectedKeys.has(key)) selectedKeys.delete(key);
        else selectedKeys.add(key);
      } else {
        selectedKeys.clear();
        selectedKeys.add(key);
      }
      selectedAnchor = key;
      refreshSelectionStyles();
      e.preventDefault?.();
      return;
    }

    const nav = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    let move = nav[e.key] ??
      (e.key === "Home" ? "home" : e.key === "End" ? "end" :
       e.key === "PageUp" ? "pgup" : e.key === "PageDown" ? "pgdn" : null);
    if (move == null) return;
    const hadFocus = focusCell != null;
    if (!ensureFocusCell()) return;
    if (!hadFocus) move = [0, 0]; // first keystroke just places the cursor

    let idx = keyViewIdx(focusCell.key, focusCell.idx);
    let ci = Math.max(0, cols.indexOf(focusCell.col));
    const headH = thead.clientHeight || 0;
    const page = Math.max(1, Math.floor(((scrollHost.clientHeight || 0) - headH) / rowH));
    if (Array.isArray(move)) { idx += move[0]; ci += move[1]; }
    else if (move === "home") { ci = 0; if (meta) idx = 0; }
    else if (move === "end")  { ci = cols.length - 1; if (meta) idx = view.length - 1; }
    else if (move === "pgup") idx -= page;
    else if (move === "pgdn") idx += page;
    idx = Math.max(0, Math.min(view.length - 1, idx));
    ci = Math.max(0, Math.min(cols.length - 1, ci));
    const key = view[idx], col = cols[ci];

    if (e.shiftKey && selectedKeys.size > 0) {
      // Row mode: shift+arrows grow the row range from the anchor.
      const aIdx = keyViewIdx(selectedAnchor, idx);
      selectedKeys.clear();
      const lo = Math.min(aIdx, idx), hi = Math.max(aIdx, idx);
      for (let i = lo; i <= hi; i++) selectedKeys.add(view[i]);
      focusCell = { key, col, idx };
    } else if (e.shiftKey) {
      // Cell mode: extend the active rect from its anchor.
      let r = cellRects[cellRects.length - 1];
      if (!r) {
        r = { aKey: focusCell.key, aCol: focusCell.col,
              aIdx: keyViewIdx(focusCell.key, focusCell.idx) };
        cellRects.push(r);
      }
      r.fKey = key; r.fCol = col; r.fIdx = idx;
      snapRectKeys(r);
      focusCell = { key, col, idx };
    } else {
      // Plain move: selection collapses to the focused cell.
      selectedKeys.clear();
      selectedAnchor = null;
      clearCellSelection();
      focusCell = { key, col, idx };
    }
    refreshSelectionStyles();
    scrollFocusIntoView();
    e.preventDefault?.();
  }

  scrollHost.setAttribute?.("tabindex", "0");
  scrollHost.classList?.add("mkui-table-keys");
  scrollHost.addEventListener("keydown", onTableKeyDown);

  /* ── Find ─────────────────────────────────────────────────────────── */

  // Ctrl/Cmd+F (or the `edit.find` action) opens a find strip between the
  // toolbar and the header — in the DOM only while open, so it costs no
  // room otherwise. It navigates rather than filters: stepping to a match
  // moves the keyboard cursor (a plain move, so the selection collapses as
  // with an arrow key) and scrolls it into view; a header match scrolls
  // sideways. Matched cells in the rendered slice carry .mkui-cell-match,
  // matched headers .mkui-th-match (.mkui-th-match-current for the current
  // one; a cell match's current is the cursor). Simple mode is a
  // case-insensitive substring, escaped into a RegExp so both modes share
  // one matcher; `.*` switches to a regular expression, `Aa` to
  // case-sensitive; an invalid pattern tints the input and matches
  // nothing. Cells match on what they show (the display text), so a
  // `display` column is searched as read; hidden columns and collapsed
  // subtrees are out of reach, as they are off the screen. The match list
  // — header matches first, then (key, col) pairs in view order — comes
  // from a scan in requestAnimationFrame chunks, the first one
  // synchronous so a small table answers at once. A data, sort, filter,
  // or column change under an open strip rescans after a pause, keeping
  // the current match by identity where it survives. Keys: typing finds
  // as you go (jumping to the first match at or after the cursor), Enter
  // / shift+Enter step, Escape closes; in the table F3 / ctrl-cmd+G step
  // and Escape closes once there is no selection left to clear.
  const FIND_INPUT_MS = 100, FIND_DATA_MS = 250, FIND_CHUNK = 2000;

  function buildFindBar() {
    findBar = document.createElement("div");
    findBar.className = "mkui-table-find";
    const ico = document.createElement("span");
    ico.className = "mkui-find-icon";
    ico.appendChild(icon("search"));
    findInput = document.createElement("input");
    findInput.type = "text";
    findInput.className = "mkui-find-input";
    findInput.placeholder = "Find…";
    findInput.value = findQuery;
    findInput.addEventListener("input", () => {
      findQuery = findInput.value ?? "";
      if (findInputTimer) clearTimeout(findInputTimer);
      findInputTimer = setTimeout(() => { findInputTimer = null; applyFind(true); }, FIND_INPUT_MS);
    });
    findInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault?.();
        if (findInputTimer) { clearTimeout(findInputTimer); findInputTimer = null; applyFind(true); }
        else findGo(e.shiftKey ? -1 : 1);
      } else if (e.key === "Escape") {
        e.preventDefault?.();
        closeFind();
      }
    });
    const toggle = (name, title, isOn, set) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "mkui-find-toggle";
      b.title = title;
      b.appendChild(icon(name));
      b.addEventListener("click", () => {
        set(!isOn());
        b.classList.toggle("active", isOn());
        applyFind(true);
        findInput.focus?.();
      });
      return b;
    };
    const regexBtn = toggle("regex", "Regular expression", () => findRegex, (v) => { findRegex = v; });
    const caseBtn = toggle("case-sensitive", "Match case", () => findCase, (v) => { findCase = v; });
    findCount = document.createElement("span");
    findCount.className = "mkui-find-count";
    const button = (name, title, fn) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "mkui-find-btn";
      b.title = title;
      b.appendChild(icon(name));
      b.addEventListener("click", fn);
      return b;
    };
    const prev = button("chevron-up", "Previous match (Shift+Enter)", () => findGo(-1));
    const next = button("chevron-down", "Next match (Enter)", () => findGo(1));
    const close = button("close", "Close (Escape)", () => closeFind());
    close.classList.add("mkui-find-close");
    findBar.append(ico, findInput, regexBtn, caseBtn, findCount, prev, next, close);
  }

  function openFind() {
    if (!findBar) buildFindBar();
    if (!findOpen) {
      findOpen = true;
      host.insertBefore(findBar, scrollArea);
      // Reopened with its last query: show the matches, leave the cursor.
      if (findQuery) applyFind(false);
    }
    findInput.focus?.();
    findInput.select?.();
  }

  function closeFind() {
    if (!findOpen) return false;
    findOpen = false;
    findBar.remove();
    if (findInputTimer) { clearTimeout(findInputTimer); findInputTimer = null; }
    if (findDataTimer) { clearTimeout(findDataTimer); findDataTimer = null; }
    findScanGen++;
    findRe = null; findError = null;
    findMatches = []; findPos = -1; findScanning = false; findScanRev = -1;
    refreshFindStyles();
    scrollHost.focus?.();
    return true;
  }

  function compileFind() {
    findRe = null; findError = null;
    if (findQuery !== "") {
      const src = findRegex ? findQuery : findQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      try { findRe = new RegExp(src, findCase ? "" : "i"); }
      catch (e) { findError = e.message; }
    }
    if (findInput) {
      findInput.classList.toggle("mkui-find-error", findError != null);
      findInput.title = findError ?? "";
    }
  }

  // Recompile and rescan; `jump` moves to the first match at or after the
  // cursor once the scan is in (unless the current match still matches).
  function applyFind(jump) {
    compileFind();
    refreshFindStyles();
    scanFind(jump);
  }

  function headerMatches(col) {
    if (!findRe) return false;
    const l = label(col);
    return findRe.test(l) || (l !== col && findRe.test(col));
  }

  function scanFind(jump = false) {
    const gen = ++findScanGen;
    findScanRev = viewRev;
    const cur = findPos >= 0 ? findMatches[findPos] : null;
    findMatches = [];
    findPos = -1;
    if (!findRe || !columns) { findScanning = false; updateFindCount(); refreshFindHeaderStyles(); return; }
    const cols = visibleColumns();
    for (const c of cols) if (headerMatches(c)) findMatches.push({ key: null, col: c, idx: -1 });
    const texts = cols.map((c) => displayExprs[c]
      ? (row) => cellDisplay(row, c).text
      : (row) => cellText(row, c));
    const chunk = Math.max(FIND_CHUNK, Math.ceil(view.length / 50));
    let i = 0;
    findScanning = true;
    const step = () => {
      if (gen !== findScanGen) return;
      const end = Math.min(view.length, i + chunk);
      for (; i < end; i++) {
        const key = view[i], row = rows.get(key);
        if (!row) continue;
        for (let ci = 0; ci < cols.length; ci++)
          if (findRe.test(texts[ci](row))) findMatches.push({ key, col: cols[ci], idx: i });
      }
      if (i < view.length) { updateFindCount(); requestAnimationFrame(step); return; }
      findScanning = false;
      if (cur) findPos = findMatches.findIndex((m) => m.key === cur.key && m.col === cur.col);
      if (jump && findPos < 0) findGo(1);
      else { updateFindCount(); refreshFindStyles(); }
    };
    step();
  }

  function scheduleFindRescan() {
    if (findDataTimer) return;
    findDataTimer = setTimeout(() => {
      findDataTimer = null;
      if (findOpen && findRe) scanFind(false);
    }, FIND_DATA_MS);
  }

  // Step to the next (dir 1) or previous (dir -1) match, wrapping; with
  // no current match, from the cursor's position in the view.
  function findGo(dir) {
    const n = findMatches.length;
    if (!n) { updateFindCount(); return; }
    let pos;
    if (findPos >= 0) pos = (findPos + dir + n) % n;
    else {
      const cols = visibleColumns();
      const ci = focusCell ? keyViewIdx(focusCell.key, focusCell.idx) : -1;
      const cc = focusCell ? cols.indexOf(focusCell.col) : -1;
      const atOrAfter = (m) => m.idx > ci || (m.idx === ci && cols.indexOf(m.col) >= cc);
      const first = findMatches.findIndex(atOrAfter);
      if (dir > 0) pos = first < 0 ? 0 : first;
      else pos = first < 0 ? n - 1 : (first - 1 + n) % n;
    }
    findPos = pos;
    showMatch(findMatches[pos]);
    updateFindCount();
  }

  function showMatch(m) {
    if (m.key == null) {
      const th = thead.querySelector?.(`th[data-col="${CSS.escape(m.col)}"]`);
      if (th) scrollHeaderIntoView(th);
      refreshFindHeaderStyles();
      return;
    }
    const idx = keyViewIdx(m.key, m.idx);
    if (view[idx] !== m.key) return; // gone since the scan; the rescan catches up
    selectedKeys.clear();
    selectedAnchor = null;
    clearCellSelection();
    focusCell = { key: m.key, col: m.col, idx };
    refreshSelectionStyles();
    scrollFocusIntoView();
    refreshFindHeaderStyles();
  }

  function updateFindCount() {
    if (!findCount) return;
    const n = findMatches.length;
    let text;
    if (findError != null) text = "Invalid pattern";
    else if (!findRe) text = "";
    else if (findScanning) text = n ? `${n}…` : "…";
    else if (!n) text = "No matches";
    else if (findPos >= 0) text = `${findPos + 1} of ${n}`;
    else text = `${n} match${n === 1 ? "" : "es"}`;
    findCount.textContent = text;
    findCount.classList.toggle("mkui-find-none", findError != null || (findRe != null && !findScanning && n === 0));
  }

  function refreshFindHeaderStyles() {
    if (!thead.querySelectorAll) return;
    const cur = findPos >= 0 ? findMatches[findPos] : null;
    for (const th of thead.querySelectorAll("th")) {
      const col = th.dataset?.col;
      if (col == null) continue;
      const hit = headerMatches(col);
      th.classList.toggle("mkui-th-match", hit);
      th.classList.toggle("mkui-th-match-current", hit && cur != null && cur.key == null && cur.col === col);
    }
  }

  // Restyle the rendered slice for the current matcher (selection styles
  // ride along — styleRowSelection paints both).
  function refreshFindStyles() {
    for (const [key, tr] of rowEls) {
      if (tr._viewIdx == null) continue;
      styleRowSelection(tr, key, tr._viewIdx);
    }
    refreshFindHeaderStyles();
  }

  /* ── Clipboard copy ───────────────────────────────────────────────── */

  // Rows selected → rows × all visible columns, plus a label header row.
  // Cells selected → the bounding grid of selected rows × selected
  // columns, blanks for cells outside every rect. Neither → the focused
  // cell. Only view (filtered) rows are ever copied.
  function buildCopyGrid() {
    if (!columns) return null;
    const cols = visibleColumns();
    // Clipboard cells carry the display: flattened text for TSV, styled
    // markup for the HTML flavor when the cell rendered rich content.
    const cellVal = (row, col) => {
      const d = cellDisplay(row, col);
      return d.rich ? { text: d.text, html: richToHTML(d.rich) } : d.text;
    };
    if (selectedKeys.size) {
      const grid = [cols.map(label)];
      for (const key of view) {
        if (!selectedKeys.has(key)) continue;
        const row = rows.get(key);
        grid.push(cols.map((c) => cellVal(row, c)));
      }
      return grid.length > 1
        ? { grid, headerRows: 1, what: plural(grid.length - 1, "row") } : null;
    }
    const bounds = rectBounds();
    if (bounds.length) {
      const rowIdxs = new Set(), colIdxs = new Set();
      for (const b of bounds) {
        for (let r = b.r1; r <= b.r2; r++) rowIdxs.add(r);
        for (let c = b.c1; c <= b.c2; c++) colIdxs.add(c);
      }
      const rs = [...rowIdxs].sort((x, y) => x - y);
      const cs = [...colIdxs].sort((x, y) => x - y);
      let nCells = 0;
      const grid = rs.map((r) => {
        const key = view[r], row = rows.get(key);
        return cs.map((c) => {
          if (!cellSelected(r, c, key, cols[c])) return "";
          nCells++;
          return cellVal(row, cols[c]);
        });
      });
      return { grid, headerRows: 0, what: plural(nCells, "cell") };
    }
    if (focusCell && ensureFocusCell()) {
      const row = rows.get(focusCell.key);
      if (row) return { grid: [[cellVal(row, focusCell.col)]], headerRows: 0,
                        what: "1 cell" };
    }
    return null;
  }

  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

  // Copy feedback: pulse the copied rows/cells in place…
  function flashCopied() {
    if (selectedKeys.size) {
      for (const [key, tr] of rowEls)
        if (selectedKeys.has(key)) flash(tr, "mkui-flash-copy");
    } else if (cellRects.length) {
      for (const tr of rowEls.values())
        for (const td of tr.children)
          if (td.classList.contains("mkui-cell-sel")) flash(td, "mkui-flash-copy");
    } else if (focusCell) {
      const tr = rowEls.get(focusCell.key);
      const td = tr?.querySelector?.(`td[data-col="${CSS.escape(focusCell.col)}"]`);
      if (td) flash(td, "mkui-flash-copy");
    }
  }

  // …and announce it on the statusbar's conventional state path, reverting
  // after a moment. The revert only fires if the message is still ours, so
  // a connection-status update landing mid-timeout is never clobbered;
  // back-to-back copies keep the original message to restore.
  let copyStatusTimer = null;
  let copyStatusPrev = null;
  function showCopyStatus(msg) {
    const st = app.state;
    if (!st?.get || !st?.set) return;
    if (copyStatusTimer) clearTimeout(copyStatusTimer);
    else copyStatusPrev = st.get("status.message");
    st.set("status.message", msg);
    copyStatusTimer = setTimeout(() => {
      copyStatusTimer = null;
      if (st.get("status.message") === msg)
        st.set("status.message", copyStatusPrev ?? "");
    }, 2000);
  }

  // Very large grids skip the HTML flavor to halve peak string memory —
  // TSV alone still pastes into spreadsheets.
  const HTML_COPY_MAX_ROWS = 100000;

  function copySelection() {
    const g = buildCopyGrid();
    if (!g) return false;
    const clip = typeof navigator !== "undefined" ? navigator.clipboard : null;
    if (!clip) return false;
    const tsv = gridToTSV(g.grid);
    flashCopied();
    (async () => {
      if (clip.write && typeof ClipboardItem !== "undefined" &&
          typeof Blob !== "undefined" && g.grid.length <= HTML_COPY_MAX_ROWS) {
        try {
          const html = gridToHTML(g.grid, g.headerRows);
          await clip.write([new ClipboardItem({
            "text/plain": new Blob([tsv], { type: "text/plain" }),
            "text/html": new Blob([html], { type: "text/html" }),
          })]);
          showCopyStatus(`Copied ${g.what}`);
          return;
        } catch { /* fall through to writeText */ }
      }
      try {
        await clip.writeText(tsv);
        showCopyStatus(`Copied ${g.what}`);
      } catch {
        showCopyStatus("Copy failed");
      }
    })();
    return true;
  }

  /* ── Button enablement & click ────────────────────────────────────── */

  let mkioConnected = false;

  // Rows the selection implies, in view order: explicit row selection,
  // else the rows containing selected cells, else the focused cell's row.
  function getSelectedRows() {
    const out = [];
    if (selectedKeys.size) {
      for (const key of view) if (selectedKeys.has(key)) out.push(rows.get(key));
      return out;
    }
    for (const [a, b] of selectedRowIntervals())
      for (let i = a; i <= b; i++) out.push(rows.get(view[i]));
    if (!out.length && focusCell && ensureFocusCell()) {
      const row = rows.get(focusCell.key);
      if (row) out.push(row);
    }
    return out;
  }

  function effectiveRowCount() {
    if (selectedKeys.size) return selectedKeys.size;
    const iv = selectedRowIntervals();
    if (iv.length) return iv.reduce((n, [a, b]) => n + (b - a + 1), 0);
    return focusCell && rows.has(focusCell.key) ? 1 : 0;
  }

  // Exact until `limit`, then stops — enablement only compares thresholds,
  // so a huge shift-selected rect never gets fully enumerated per keypress.
  function countCellsUpTo(limit) {
    if (!columns) return 0;
    const cols = visibleColumns();
    const iv = selectedRowIntervals();
    if (!iv.length)
      return focusCell && rows.has(focusCell.key) ? 1 : 0;
    let n = 0;
    for (const [a, b] of iv) {
      for (let r = a; r <= b; r++) {
        const key = view[r];
        for (let c = 0; c < cols.length; c++)
          if (cellSelected(r, c, key, cols[c]) && ++n > limit) return n;
      }
    }
    return n;
  }

  function getSelectedCells() {
    const out = [];
    if (!columns) return out;
    const cols = visibleColumns();
    for (const [a, b] of selectedRowIntervals()) {
      for (let r = a; r <= b; r++) {
        const key = view[r], row = rows.get(key);
        for (let c = 0; c < cols.length; c++)
          if (cellSelected(r, c, key, cols[c]))
            out.push({ row, column: cols[c], value: row?.[cols[c]] ?? "" });
      }
    }
    if (!out.length && focusCell && ensureFocusCell()) {
      const row = rows.get(focusCell.key);
      if (row) out.push({ row, column: focusCell.col, value: row[focusCell.col] ?? "" });
    }
    return out;
  }

  const buttonUnit = (bs) => bs.unit ?? bs.enable?.unit ?? "rows";

  function updateButtonStates() {
    const rowCount = effectiveRowCount();
    let matRows = null; // materialized lazily, only for `when`
    for (const { el, spec: bs } of buttonEls) {
      const en = bs.enable ?? {};
      const unit = buttonUnit(bs);
      const cellUnit = unit === "cell" || unit === "cells";
      const single = unit === "cell" || unit === "row";
      let count;
      if (cellUnit) {
        const lim = Math.max(en.minSelected ?? 0, en.maxSelected ?? 0, 1) + 1;
        count = countCellsUpTo(lim);
      } else {
        count = rowCount;
      }
      let ok = true;
      if (en.connected && !mkioConnected) ok = false;
      // Singular units imply exactly-one unless the config says otherwise.
      const min = en.minSelected ?? (single ? 1 : null);
      const max = en.maxSelected ?? (single ? 1 : null);
      if (ok && min != null && count < min) ok = false;
      if (ok && max != null && count > max) ok = false;
      // `when = "<expr>"` — scope: rows (the rows the selection implies),
      // row (the first of them or NULL), cells, selection, connected, state.
      if (ok && en.when != null) {
        matRows ??= getSelectedRows();
        const cells = cellUnit ? getSelectedCells() : [];
        ok = expr.truthy(evalExpr(String(en.when), {
          rows: matRows, row: matRows[0] ?? null, cells,
          selection: { count, rowCount: matRows.length, cellCount: cellUnit ? cells.length : undefined, unit },
          connected: mkioConnected, state: stateRoot(),
        }));
      }
      el.disabled = !ok;
    }
  }

  async function handleButtonClick(btnSpec) {
    const action = btnSpec.action;
    if (!action) return;
    const unit = buttonUnit(btnSpec);
    const cellUnit = unit === "cell" || unit === "cells";
    const selected = getSelectedRows();
    const cells = cellUnit ? getSelectedCells() : [];
    const first = selected[0] ?? {};
    const ctx = {
      row: first, rows: selected,
      cell: cells[0] ?? null, cells,
      selection: { count: selected.length, rowCount: selected.length,
                   cellCount: cellUnit ? cells.length : undefined, unit },
      state: app.state.get(),
    };

    if (action.type === "transaction") {
      if (cellUnit) {
        for (const cell of cells) {
          const cellCtx = { ...ctx, cell, row: cell.row };
          const data = resolveObject(action.data ?? {}, cellCtx);
          client.send(action.service, data, { op: action.op });
        }
      } else {
        for (const row of selected) {
          const rowCtx = { ...ctx, row };
          const data = resolveObject(action.data ?? {}, rowCtx);
          client.send(action.service, data, { op: action.op });
        }
      }
    } else if (action.type === "dialog") {
      let dialogSpec;
      if (action.dialog) {
        dialogSpec = action.dialog;
      } else if (action.dialogService) {
        const reqData = resolveObject(action.dialogService.data ?? {}, ctx);
        try {
          dialogSpec = await client.request(action.dialogService.service, reqData);
        } catch (e) {
          console.error("[mkui-table] dialog service error:", e);
          return;
        }
      }
      if (!dialogSpec) return;

      const tableRows = rows;
      const { openDialog } = await import("./mkui-dialog.js");
      await openDialog(dialogSpec, ctx, app, { client, tableRows });
    } else if (action.type === "action") {
      app.fireAction(action.name, action.args);
    }
  }

  function closeDropdown() {
    if (dropdown) { rememberListHeight(dropdown, "filter"); dropdown.remove(); dropdown = null; dropdownCol = null; dropdownScope = null; }
    if (dropdownCleanup) { dropdownCleanup(); dropdownCleanup = null; }
  }

  /* ── Dropdown list sizing ─────────────────────────────────────────── */

  // The value list (filter dropdown) and the column list (picker) open as
  // tall as their content, capped so the dropdown's bottom stays above the
  // app's statusbar (the viewport's bottom without one) — the cap is the
  // list's max-height, which CSS `resize: vertical` also respects, so the
  // user can drag the list shorter (or back up to the cap) by its corner
  // grip. A dragged height is kept per kind for the table's life: the
  // browser writes it as an inline `height`, read back when the dropdown
  // closes. Skipped where there is nothing to measure against (tests).
  const listHeights = { filter: null, picker: null };
  const LIST_MIN_H = 40, VIEWPORT_GAP = 8; // LIST_MIN_H matches .mkui-filter-list min-height
  function dropdownFloor() {
    const bar = document.querySelector?.("mkui-statusbar");
    const top = bar?.getBoundingClientRect().top;
    if (top > 0) return top;
    const vh = window.innerHeight;
    return vh > 0 ? vh : null;
  }
  function fitList(dd, list, kind) {
    dd._mkuiList = list;
    const floor = dropdownFloor();
    if (floor == null) return;
    const listH = list.getBoundingClientRect().height;
    const overflow = dd.getBoundingClientRect().bottom - (floor - VIEWPORT_GAP);
    const maxH = Math.max(LIST_MIN_H, overflow > 0 ? listH - overflow : listH);
    list.style.maxHeight = maxH + "px";
    const kept = listHeights[kind];
    if (kept > 0) list.style.height = Math.min(kept, maxH) + "px";
  }
  function rememberListHeight(dd, kind) {
    const h = parseFloat(dd._mkuiList?.style.height);
    if (h > 0) listHeights[kind] = h;
  }

  // Right-align a mounted dropdown under its anchor, clamped to the
  // viewport. Measured after mount: the dropdown is max-content wide (up
  // to a CSS cap), so a column of long values widens it rather than
  // wrapping them, and the width isn't known until it renders.
  function placeDropdown(dd, anchorRect, fallbackW) {
    const w = dd.getBoundingClientRect().width || fallbackW;
    let left = anchorRect.right - w;
    if (left < 4) left = 4;
    if (left + w > window.innerWidth) left = Math.max(4, window.innerWidth - w - 4);
    dd.style.left = left + "px";
    dd.style.top = (anchorRect.bottom + 1) + "px";
  }

  function compareValues(a, b) {
    if (a == null) a = "";
    if (b == null) b = "";
    const na = Number(a), nb = Number(b);
    if (a !== "" && b !== "" && !isNaN(na) && !isNaN(nb)) return na - nb;
    return String(a).localeCompare(String(b));
  }

  function compareRows(a, b) {
    for (const { col, dir } of sortKeys) {
      const cmp = compareValues(cellValue(a, col), cellValue(b, col));
      if (cmp !== 0) return dir === "desc" ? -cmp : cmp;
    }
    return 0;
  }

  function matchesFilters(row) {
    const root = tree ? isRootKey(row[idKey]) : true;
    for (const f of filters.values()) {
      if (tree && f.scope) {
        // Scoped filters (tree tables): top and child filters judge only
        // their level; branch ones are judged by the subtree pass
        // (buildSubtreeOk), not here.
        if (f.scope === "all") continue;
        if ((f.scope === "roots") !== root) continue;
      }
      if (!passesFilter(row, f.col, f)) return false;
    }
    return true;
  }

  // The branch filters alone, on the row's own values.
  function passesAllScoped(row) {
    for (const f of filters.values()) if (f.scope === "all" && !passesFilter(row, f.col, f)) return false;
    return true;
  }

  function passesFilter(row, col, f) {
    if (f.kind === "range") return inRange(row, col, f);
    return f.values.has(cellText(row, col)) !== (f.mode === "exclude");
  }

  // The filter type a column offers: explicit `types` first, then the
  // ratchets in colStats (numeric wins over temporal — a column of epoch
  // numbers is a number column unless `types` says `time`).
  function filterType(col) {
    const t = colTypes[col];
    if (t) return t.type;
    const st = colStats.get(col);
    if (!st) return "text";
    return st.numeric ? "number" : st.temporal ? "time" : "text";
  }
  const timeSpec = (col) => colTypes[col]?.type === "time" ? colTypes[col] : {};
  const timeKindOf = (col) => kindForSpec(timeSpec(col)) ?? colStats.get(col)?.timeKind ?? "datetime";
  const isLocalCol = (col) => colTypes[col]?.tz === "local";

  // Preset bounds move with the clock; memoised per second so a full view
  // rebuild costs one resolution, not one per row.
  function rangeBounds(f) {
    if (!f.preset) return f;
    const sec = Math.floor(Date.now() / 1000);
    if (f._at !== sec) {
      f._at = sec;
      f._bounds = presetBounds(f.preset, f.timeKind, sec, f.localTz);
    }
    return f._bounds;
  }

  function rangeValue(v, f) {
    if (f.type === "number") {
      if (v == null || v === "") return null;
      const n = Number(v);
      return isNaN(n) ? null : n;
    }
    try { return parseTime(v, f.spec); } catch { return null; }
  }

  function inRange(row, col, f) {
    const n = rangeValue(cellValue(row, col), f);
    if (n === null) return f.empty;
    const { lo, hi } = rangeBounds(f);
    if (lo != null && n < lo) return false;
    if (hi == null) return true;
    return f.type === "time" ? n < hi : n <= hi;
  }

  // While a relative preset ("last hour") is active, re-apply the view
  // periodically so rows age out even when no data arrives to trigger it.
  let presetTimer = null;
  function syncPresetTimer() {
    const active = [...filters.values()].some((f) => f.kind === "range" && f.preset);
    if (!active) { if (presetTimer) { clearTimeout(presetTimer); presetTimer = null; } return; }
    if (presetTimer) return;
    const tick = () => {
      presetTimer = null;
      if (closed) return;
      applyVisibility();
      syncPresetTimer();
    };
    presetTimer = setTimeout(tick, 30000);
  }

  // Human-readable summary of a range filter for the header tooltip.
  function describeRange(f) {
    if (f.preset) return PRESETS[f.preset].label;
    const lo = f.lo == null ? null : f.loText.replace("T", " ");
    const hi = f.hi == null ? null : f.hiText.replace("T", " ");
    let s = lo !== null && hi !== null ? `${lo} – ${hi}` : lo !== null ? `≥ ${lo}` : hi !== null ? `≤ ${hi}` : "";
    if (f.empty) s += " (+ empty)";
    return s;
  }

  // The same summary the header tooltip and the toolbar chip show.
  function describeFilter(f) {
    const s = f.kind === "range" ? describeRange(f)
      : f.mode === "exclude" ? `All but ${f.values.size} values` : `${f.values.size} values`;
    if (!tree || !f.scope || f.scope === "roots") return s;
    return `${s} (${f.scope === "children" ? "child" : "branch"})`;
  }

  /* ── Sort specs ───────────────────────────────────────────────────── */

  // Like filters, the sort can be described as well as clicked: `sort =
  // <spec>` in the pane spec seeds the order before any data and is
  // restored on pane reopen; `paneEl._sort.set/get`, the workspace's
  // `setPaneSort`, and the `table.sort` action take the same shape. A spec
  // is a column name (`"-col"` for descending), `{ col, dir }`, or an array
  // of those in priority order; null / "" / [] clears the sort. A bad spec
  // warns and leaves the current sort alone.
  function sortFromSpec(s) {
    if (s == null || s === "") return [];
    const out = [];
    for (const item of Array.isArray(s) ? s : [s]) {
      let col, dir;
      if (typeof item === "string") {
        dir = item[0] === "-" ? "desc" : "asc";
        col = dir === "desc" ? item.slice(1) : item;
      } else if (item && typeof item === "object") {
        col = item.col;
        dir = item.dir ?? "asc";
        if (dir !== "asc" && dir !== "desc") throw new Error(`bad dir '${dir}': use asc or desc`);
      } else {
        throw new Error("expected a column name or { col, dir }");
      }
      if (typeof col !== "string" || !col) throw new Error("expected a column name");
      if (out.some((k) => k.col === col)) throw new Error(`column '${col}' listed twice`);
      out.push({ col, dir });
    }
    return out;
  }

  function loadSortSpec(s) {
    try {
      const keys = sortFromSpec(s);
      sortKeys.length = 0;
      sortKeys.push(...keys);
    } catch (e) {
      console.warn(`[mkio-table] bad sort: ${e.message}`);
    }
  }

  function applySort() {
    sortedKidsCache.clear();
    updateHeaderState();
    if (sortKeys.length) reorder(); else resetOrder();
  }

  function setSort(s) {
    loadSortSpec(s);
    applySort();
  }

  function getSort() {
    return sortKeys.map(({ col, dir }) => ({ col, dir }));
  }

  /* ── Column visibility ────────────────────────────────────────────── */

  // Which columns show can be described as well as clicked. `visible =
  // [...]` in the pane spec seeds the set before any data and is restored
  // on pane reopen; `paneEl._columns.set/get`, the workspace's
  // `setPaneColumns`, and the `table.columns` action take the same shape:
  // a column name or an array of them in display order, or null / "" / []
  // for all columns (following new ones as they appear). A name that isn't
  // a configured column warns but is kept — it may arrive with the data.
  // A bad spec warns and leaves the current state alone.
  function visibleFromSpec(s) {
    if (s == null || s === "") return null;
    const list = Array.isArray(s) ? s : [s];
    if (!list.length) return null;
    const out = [];
    for (const c of list) {
      if (typeof c !== "string" || !c) throw new Error("expected a column name");
      if (out.includes(c)) throw new Error(`column '${c}' listed twice`);
      out.push(c);
    }
    if (spec.columns)
      for (const c of out) if (!spec.columns.includes(c))
        console.warn(`[mkio-table] visible: '${c}' is not in columns`);
    return out;
  }

  function loadVisibleSpec(s) {
    try {
      visible = visibleFromSpec(s);
    } catch (e) {
      console.warn(`[mkio-table] bad visible: ${e.message}`);
    }
  }

  // Re-render for a changed column set or order: header (and with it the
  // colgroup and spacer spans), every rendered row, header state and
  // chips. Widths and stats are keyed by name and cover hidden columns
  // too, so a column comes back at the width it had; one shown for the
  // first time is measured from its header like any new column.
  function applyVisible() {
    closeDropdown();
    if (!columns) { updateHeaderState(); return; } // no header yet: chips only
    renderHead();
    initNewColWidths();
    rebuildAllRows();
    render();
    if (findRe) scanFind(false);
  }

  function setVisible(s) {
    loadVisibleSpec(s);
    applyVisible();
  }

  // null in the default state — so set(get()) round-trips "all columns,
  // following new ones" rather than freezing today's list.
  function getVisible() {
    return visible ? visible.slice() : null;
  }

  // A hidden column goes back where it came from: after the nearest shown
  // column that precedes it in `columns` order, else before the nearest one
  // that follows, else at the end. Pure: returns the new list.
  function insertShown(list, col) {
    const all = dataColumns();
    const at = all.indexOf(col);
    const shown = list.filter((c) => all.includes(c));
    let i = list.length;
    const before = [...all.slice(0, at)].reverse().find((c) => shown.includes(c));
    const after = all.slice(at + 1).find((c) => shown.includes(c));
    if (before !== undefined) i = list.indexOf(before) + 1;
    else if (after !== undefined) i = list.indexOf(after);
    return [...list.slice(0, i), col, ...list.slice(i)];
  }

  // Show some hidden columns (in `columns` order) — one re-render.
  function showColumns(cols) {
    if (!columns || !visible) return; // null: everything already shows
    const known = dataColumns();
    let list = visible;
    for (const c of known) if (cols.includes(c) && !list.includes(c)) list = insertShown(list, c);
    if (list === visible) return;
    visible = list;
    applyVisible();
  }
  const showColumn = (col) => showColumns([col]);

  // Hide some columns. The last visible column stays — a table with no
  // columns has no header to bring anything back from — so hiding all of
  // them keeps the first.
  function hideColumns(cols) {
    if (!columns) return;
    const cur = visibleColumns();
    let next = cur.filter((c) => !cols.includes(c));
    if (!next.length) next = [cur[0]];
    if (next.length === cur.length) return;
    visible = next;
    applyVisible();
  }
  const hideColumn = (col) => hideColumns([col]);

  function showAllColumns() {
    if (!visible) return;
    visible = null;
    applyVisible();
  }

  // Back to the configured `visible` list (or all, without one).
  const sameList = (a, b) => a === b || (!!a && !!b && a.length === b.length && a.every((c, i) => c === b[i]));
  const isDefaultVisible = () => sameList(visible, defaultVisible);
  function resetVisible() {
    if (isDefaultVisible()) return;
    visible = defaultVisible;
    applyVisible();
  }

  /* ── Filter specs ─────────────────────────────────────────────────── */

  // A filter can be described as well as clicked. `filters = { col =
  // <filter> }` in the pane spec seeds the table — applied before any data
  // arrives, and again on pane reopen, which drops whatever was set
  // interactively. The same shape drives the programmatic hook
  // (`paneEl._filters.set(map, { merge })` / `.get()`), the workspace's
  // `setPaneFilters`, and the `table.filter` action. Shapes:
  //   ["a", "b"]                            show only those values
  //   { include = [...] } / { exclude = [...] }   values filter with intent
  //   { from = 100, to = 500, empty = true }      number range
  //   { from = "2026-03-01", to = "2026-03-02T09:30" }   time range
  //   { preset = "today" | "1h" | "15m" }         relative time range
  //   { type = "number" | "time", ... }     fixes a range's frame when the
  //                                         bounds don't (`types` wins)
  //   null / ""                              clears the column
  // A range's frame is inferred from the bounds — numbers make a number
  // range, strings a time range — because config is parsed before the data
  // that would otherwise say. Time bounds take the input-control forms
  // (`YYYY-MM-DD`, `YYYY-MM-DD HH:MM[:SS]`, `HH:MM[:SS]`; a date on a
  // date-time column covers the whole day, like the dropdown), or epoch
  // numbers on a `unit` column. A bad entry warns and is skipped.
  function filterFromSpec(col, s) {
    const f = filterFromSpecBase(col, s);
    if (!f) return f;
    f.col = col;
    if (!tree) return f;
    // Tree tables: `scope` says which rows the filter judges — roots,
    // children, or all (the table's `tree.filterScope` default).
    const scope = s.scope ?? tree.filterScope;
    if (!TREE_SCOPES.includes(scope)) throw new Error(`bad scope '${scope}': use roots, children, or all`);
    f.scope = scope;
    return f;
  }

  // A column's spec is one filter, or — on a tree table — an array of
  // filter objects, one per scope (a bare array of values is still an
  // include list). Returns the filters to key into the map.
  function filtersFromSpec(col, s) {
    const many = Array.isArray(s) && s.length > 0 && s.every((x) => x && typeof x === "object" && !Array.isArray(x));
    if (!many) { const f = filterFromSpec(col, s); return f ? [f] : []; }
    if (!tree) throw new Error("one filter per column without a tree");
    const out = new Map();
    for (const item of s) {
      const f = filterFromSpec(col, item);
      if (!f) continue;
      if (out.has(f.scope)) throw new Error(`two filters for scope '${f.scope}'`);
      out.set(f.scope, f);
    }
    return [...out.values()];
  }

  function filterFromSpecBase(col, s) {
    if (s == null || s === "") return null;
    if (Array.isArray(s)) s = { include: s };
    if (typeof s !== "object") throw new Error("expected a value list or an object");
    const strs = (a) => (Array.isArray(a) ? a : [a]).map((v) => v == null ? "" : String(v));
    if (s.include !== undefined || s.exclude !== undefined) {
      if (s.include !== undefined && s.exclude !== undefined) throw new Error("include and exclude are exclusive");
      const mode = s.include !== undefined ? "include" : "exclude";
      const values = new Set(strs(s[mode]));
      return mode === "exclude" && values.size === 0 ? null : { kind: "values", mode, values };
    }
    const preset = s.preset ?? null;
    const empty = s.empty === true;
    const blank = (v) => v == null || v === "";
    if (blank(s.from) && blank(s.to) && !preset && !empty) throw new Error("expected include, exclude, from, to, or preset");
    const declared = colTypes[col]?.type;
    const type = declared ?? s.type ?? (preset ? "time" : typeof (blank(s.from) ? s.to : s.from) === "number" ? "number" : "time");
    if (type === "text") throw new Error("a text column has no range");
    if (type !== "number" && type !== "time") throw new Error(`unknown type '${type}'`);
    if (type === "number") {
      if (preset) throw new Error("presets need a time column");
      const num = (v) => {
        if (blank(v)) return null;
        const n = Number(v);
        if (!Number.isFinite(n)) throw new Error(`bad bound '${v}'`);
        return n;
      };
      const lo = num(s.from), hi = num(s.to);
      return {
        kind: "range", type, lo, hi, preset: null, empty,
        loText: lo === null ? "" : String(lo), hiText: hi === null ? "" : String(hi),
        timeKind: null, spec: {}, localTz: false,
      };
    }
    if (preset && !PRESETS[preset]) throw new Error(`unknown preset '${preset}': use ${Object.keys(PRESETS).join(", ")}`);
    const tspec = timeSpec(col), localTz = isLocalCol(col);
    const norm = (v) => blank(v) ? null : typeof v === "number" ? v : String(v).trim().replace(" ", "T");
    const from = preset ? null : norm(s.from), to = preset ? null : norm(s.to);
    const textKind = (v) => typeof v === "string" ? detectTimeKind(v) : null;
    const kind = kindForSpec(tspec) ?? textKind(from) ?? textKind(to) ?? colStats.get(col)?.timeKind ?? "datetime";
    // Seconds for a bound plus the text the dropdown restores: the typed
    // text when it is already in the column's form, else the bound
    // converted (a date on a date-time column ends the day at 23:59:59, so
    // re-committing the text reproduces the exclusive midnight).
    const bound = (v, edge) => {
      if (v === null) return { secs: null, text: "" };
      const name = edge === "lo" ? "from" : "to";
      if (typeof v === "number") {
        if (!tspec.unit) throw new Error(`${name} is a number but the column is not an epoch (types.${col}.unit)`);
        const secs = parseTime(v, tspec);
        return { secs, text: boundToInput(edge === "hi" ? secs - 1 : secs, kind, localTz) };
      }
      const k = detectTimeKind(v);
      if (!k || (k === "time") !== (kind === "time")) throw new Error(`bad ${name} '${v}' for a ${kind} column`);
      const secs = inputToBound(v, k, edge, localTz);
      if (secs === null) throw new Error(`bad ${name} '${v}' for a ${kind} column`);
      const text = k === kind ? v : boundToInput(edge === "hi" ? secs - 1 : secs, kind, localTz);
      return { secs, text };
    };
    const lo = bound(from, "lo"), hi = bound(to, "hi");
    return {
      kind: "range", type, lo: lo.secs, hi: hi.secs, preset, empty,
      loText: lo.text, hiText: hi.text, timeKind: kind, spec: tspec, localTz,
    };
  }

  // The inverse: a filter in the shape filterFromSpec reads, so filters
  // round-trip through get/set and can be saved as config.
  function filterToSpec(f) {
    let out;
    if (f.kind === "values") out = { [f.mode]: [...f.values] };
    else {
      out = { type: f.type };
      if (f.preset) out.preset = f.preset;
      else {
        out.from = f.type === "number" ? f.lo : (f.loText || null);
        out.to = f.type === "number" ? f.hi : (f.hiText || null);
      }
      out.empty = f.empty;
    }
    if (tree) out.scope = f.scope ?? tree.filterScope;
    return out;
  }

  function loadFilterSpecs(map, merge = false) {
    if (!merge) filters.clear();
    if (map == null) return;
    if (typeof map !== "object" || Array.isArray(map)) {
      console.warn("[mkio-table] filters must map column names to filters");
      return;
    }
    for (const [col, s] of Object.entries(map)) {
      try {
        const fs = filtersFromSpec(col, s);
        for (const f of colFilters(col)) filters.delete(fkey(col, f.scope)); // an entry replaces the column's filters
        for (const f of fs) filters.set(fkey(col, f.scope), f);
      } catch (e) {
        console.warn(`[mkio-table] bad filters.${col}: ${e.message}`);
      }
    }
  }

  function setFilters(map, { merge = false } = {}) {
    closeDropdown();
    loadFilterSpecs(map, merge);
    updateHeaderState();
    applyVisibility();
    syncPresetTimer();
  }

  function getFilters() {
    const out = {};
    for (const f of filters.values()) {
      const spec = filterToSpec(f);
      if (!(f.col in out)) out[f.col] = spec;
      else if (Array.isArray(out[f.col])) out[f.col].push(spec);
      else out[f.col] = [out[f.col], spec]; // several scopes: an array of filters
    }
    return out;
  }

  function applyVisibility() {
    markViewDirty();
    // Selection follows visibility: filtered-out rows drop from the row
    // selection so counts, copies, and actions only ever see view rows.
    if (selectedKeys.size) {
      let inView = null;
      if (tree) { rebuildView(); inView = new Set(view); } // a subtree hides with its root
      for (const key of [...selectedKeys]) {
        const r = rows.get(key);
        if (!r || (inView ? !inView.has(key) : !matchesFilters(r))) selectedKeys.delete(key);
      }
    }
    render();
    if (hasButtons) updateButtonStates();
    // Pruning can retire the published row, or promote a different one.
    publishSelection();
  }

  function reorder() { markViewDirty(); render(); }

  function resetOrder() { markViewDirty(); render(); }

  function getUniqueValues(col) {
    const s = new Set();
    for (const r of rows.values()) s.add(cellText(r, col));
    return [...s].sort(compareValues);
  }

  /* ── Column widths ────────────────────────────────────────────────── */

  // Widths are keyed by column name in colWidths so they survive reorder,
  // resubscribe, and paging-mode switches. Until widthsInited the table
  // auto-lays-out; after init a <colgroup> + table-layout:fixed pins each
  // column and overflowing cell text is clipped with an ellipsis. Init
  // happens as soon as the header can be measured — before any data — so
  // columns start at header width and only grow from there as records
  // arrive (growColWidth, driven by bumpStats).

  const rowNumColW = () =>
    Math.ceil(Math.max(2, rowNumDigits) * (chW || 7.2)) + CELL_CHROME;

  function renderColgroup() {
    colgroup.innerHTML = "";
    if (!widthsInited || !columns) {
      table.classList.remove("mkui-table-fixed");
      table.style.width = "";
      return;
    }
    if (rowColumn) {
      const col = document.createElement("col");
      col.style.width = rowNumColW() + "px";
      colgroup.appendChild(col);
    }
    for (const c of visibleColumns()) {
      const col = document.createElement("col");
      col.style.width = (colWidths.get(c) ?? MIN_COL_W * 2) + "px";
      colgroup.appendChild(col);
    }
    // Auto-width filler col. With table-layout:fixed and width:100%, the
    // used table width is max(pane width, sum of col widths): data columns
    // always keep their exact <col> widths and the filler takes whatever
    // is left, extending the header row to the pane's right edge. (An
    // inline pixel width here would pin the distribution to that width —
    // min-width can stretch the table box afterwards but never re-runs
    // the distribution, leaving the filler at 0 and dead space beyond
    // the last column.)
    colgroup.appendChild(document.createElement("col"));
    table.classList.add("mkui-table-fixed");
    table.style.width = ""; // width:100% from .mkui-table; also undoes the max-content measuring width
  }

  const maxColWidth = () => {
    const hostW = scrollHost.clientWidth || window.innerWidth || 0;
    return hostW > 0 ? Math.max(MIN_COL_W, hostW / 2) : Infinity;
  };

  // Ratchet a column up to fit its widest measured content: numeric columns
  // need max-integer + max-fraction so decimal points align, text columns
  // just the widest string. Never shrinks, never overrides a manual resize,
  // capped at half the pane. Paging suspends it once any data has been
  // measured (growSuspended): the first page sizes the columns, later pages
  // — next/prev, Earlier in live mode, exit-live refetch — must not make
  // them jump. The colgroup refresh is deferred to the next
  // render() so a snapshot chunk costs one refresh, not one per row.
  function growColWidth(col, st) {
    if (userSized.has(col) || growSuspended) return;
    const content = st.numeric ? st.maxIntW + st.maxFrac * chW : st.maxTextW;
    const needed = Math.min(Math.ceil(content) + CELL_CHROME, maxColWidth());
    if (needed > (colWidths.get(col) ?? 0)) {
      colWidths.set(col, needed);
      widthsDirty = true;
    }
  }

  // Initial width = the column's header width, measured under max-content
  // (the default width:100% would stretch the headers across the pane
  // first), capped at half the pane. Runs as soon as the header exists —
  // before any data — so the table starts at header widths and only grows
  // from there. If the pane isn't laid out yet the measurement reads 0 and
  // widths stay un-inited; data events and the visibility observer retry.
  function maybeInitWidths() {
    if (widthsInited || !columns) return;
    const ths = thead.querySelectorAll("th");
    if (!ths.length) return;
    const maxW = maxColWidth();
    const prevWidth = table.style.width;
    table.style.width = "max-content";
    let measured = false;
    for (const th of ths) {
      if (!th.dataset.col) continue; // filler cell
      const w = th.getBoundingClientRect().width;
      if (w > 0) {
        colWidths.set(th.dataset.col,
          Math.min(Math.max(w, colWidths.get(th.dataset.col) ?? 0, MIN_COL_W), maxW));
        headerMeasured.add(th.dataset.col);
        measured = true;
      }
    }
    if (!measured) { table.style.width = prevWidth; return; } // pane hidden — retry later
    widthsInited = true;
    renderColgroup();
  }

  // A column shown after the initial measurement was hidden then, so its
  // header was never measured (its data may have been — stats and the
  // ratchet cover hidden columns too): take the header width now, the
  // same way, and keep whatever the data already asked for.
  function initNewColWidths() {
    if (!widthsInited) return;
    const fresh = visibleColumns().filter((c) => !headerMeasured.has(c));
    if (!fresh.length) return;
    const maxW = maxColWidth();
    const prevWidth = table.style.width;
    table.style.width = "max-content";
    for (const th of thead.querySelectorAll("th")) {
      const c = th.dataset.col;
      if (!c || !fresh.includes(c)) continue;
      const w = th.getBoundingClientRect().width;
      if (!(w > 0)) continue; // pane hidden — stays unmeasured for next time
      colWidths.set(c, Math.min(Math.max(w, colWidths.get(c) ?? 0, MIN_COL_W), maxW));
      headerMeasured.add(c);
    }
    table.style.width = prevWidth;
    widthsDirty = false;
    renderColgroup();
  }

  function resetColWidths() {
    colWidths.clear();
    userSized.clear();
    headerMeasured.clear();
    dataSeen = false;
    growSuspended = false;
    widthsInited = false;
    widthsDirty = false;
    colgroup.innerHTML = "";
    table.classList.remove("mkui-table-fixed");
    table.style.width = "";
  }

  // Sync stored widths to what's actually rendered, so a resize starts
  // from the on-screen width (it may precede the first measurement, where
  // columns are still auto-laid-out).
  function syncRenderedWidths() {
    for (const th of thead.querySelectorAll("th")) {
      if (!th.dataset.col) continue; // filler cell
      const w = th.getBoundingClientRect().width;
      if (w > 0) colWidths.set(th.dataset.col, w);
    }
    widthsInited = true;
    renderColgroup();
  }

  // Width that exactly fits a column: the widest ingested value (colStats,
  // numeric columns keep decimal alignment) or the header label + its icon,
  // whichever is wider — capped at 80% of the viewport, unlike auto-grow's
  // half-pane cap, since an explicit fit request means "show it all".
  const HEADER_CHROME = 33; // 8px + 4px th padding + 4px gap + 16px icon + 1px divider
  function fitColWidth(col) {
    const st = colStats.get(col);
    let w = st
      ? (st.numeric ? st.maxIntW + st.maxFrac * chW : st.maxTextW) + CELL_CHROME
      : 0;
    if (ensureMeasureCtx())
      w = Math.max(w, measureCtx.measureText(label(col)).width + HEADER_CHROME);
    const viewportW = window.innerWidth || scrollHost.clientWidth || 0;
    const cap = viewportW > 0 ? Math.ceil(viewportW * 0.8) : Infinity;
    return Math.max(MIN_COL_W, Math.min(Math.ceil(w), cap));
  }

  // Columns covered by the current selection: row mode spans every visible
  // column, cell mode is the union of the rects' column ranges.
  function selectedColumns() {
    const cols = visibleColumns();
    const out = new Set();
    if (selectedKeys.size) for (const c of cols) out.add(c);
    else for (const b of rectBounds())
      for (let ci = b.c1; ci <= b.c2; ci++) out.add(cols[ci]);
    return out;
  }

  // Double-click on a divider grip: auto-size to fit. When the divider's
  // column is part of the selection (select-all via Ctrl+A or the corner
  // cell spans every column), the whole selection is fitted at once.
  function autoSizeColumn(col) {
    if (!widthsInited) syncRenderedWidths(); // baseline for non-target columns
    const sel = selectedColumns();
    for (const c of sel.has(col) ? sel : [col]) {
      userSized.delete(c); // fitted width tracks incoming data again
      colWidths.set(c, fitColWidth(c));
    }
    renderColgroup();
  }

  function initColResize(col, e) {
    closeDropdown();
    syncRenderedWidths();

    const pid = e.pointerId;
    const startX = e.clientX;
    const startW = colWidths.get(col) ?? MIN_COL_W;

    function onMove(e2) {
      if (e2.pointerId !== pid) return;
      userSized.add(col); // manual width — stop auto-growing this column
      colWidths.set(col, Math.max(MIN_COL_W, startW + (e2.clientX - startX)));
      renderColgroup();
    }
    function onUp(e2) {
      if (e2.pointerId !== pid) return;
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 200);
    }
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  }

  /* ── Header rendering ─────────────────────────────────────────────── */

  function makeResizer(col) {
    const r = document.createElement("div");
    r.className = "mkui-col-resizer";
    r.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      initColResize(col, e);
    });
    r.addEventListener("click", (e) => e.stopPropagation());
    r.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      e.preventDefault();
      autoSizeColumn(col);
    });
    return r;
  }

  function renderHead() {
    thead.innerHTML = "";
    const tr = document.createElement("tr");
    const visCols = visibleColumns();
    if (rowColumn) {
      // Top-left corner cell of the row-number column: click selects all.
      const th = document.createElement("th");
      th.className = "mkui-th-rownum";
      th.title = "Select all";
      th.addEventListener("click", (e) => {
        if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
        selectAllRows();
      });
      tr.appendChild(th);
    }
    for (let vi = 0; vi < visCols.length; vi++) {
      const c = visCols[vi];
      const th = document.createElement("th");
      th.dataset.col = c;

      const filterBtn = document.createElement("span");
      filterBtn.className = "mkui-filter-btn";
      filterBtn.appendChild(icon("filter"));

      const labelEl = document.createElement("span");
      labelEl.className = "mkui-th-label";
      labelEl.textContent = label(c);

      const inner = document.createElement("div");
      inner.className = "mkui-th-inner";
      if (tree && c === treeCol()) {
        // Expand / collapse all, ahead of the label like the row carets.
        const all = document.createElement("span");
        all.className = "mkui-tree-toggle mkui-tree-all";
        all.appendChild(icon("chevron-right"));
        all.addEventListener("pointerdown", (e) => { e.stopPropagation(); });
        all.addEventListener("click", (e) => {
          e.stopPropagation();
          if (e.ctrlKey || e.metaKey || e.altKey) return;
          setExpandDepth(e.shiftKey ? Infinity : anyExpanded() ? 0 : 1);
        });
        inner.appendChild(all);
      }
      inner.append(labelEl, filterBtn);
      th.appendChild(inner);

      // The grip that resizes column N straddles the divider at N's right
      // edge, so it lives on the LEFT edge of cell N+1 (the divider's other
      // side): later cells paint above earlier ones, keeping the overhang
      // clickable, whereas a right-edge overhang would be covered by the
      // next cell.
      if (vi > 0) th.appendChild(makeResizer(visCols[vi - 1]));

      th.addEventListener("click", (e) => {
        if (suppressClick) { suppressClick = false; return; }
        if (e.target.closest(".mkui-filter-btn") || e.target.closest(".mkui-tree-all")) return;
        // Shift builds multi-column sort; other modifiers are inert so a
        // stray ctrl/cmd/alt+click can't wipe an existing sort stack.
        if (e.ctrlKey || e.metaKey || e.altKey) return;

        const idx = sortKeys.findIndex((k) => k.col === c);
        if (e.shiftKey) {
          if (idx >= 0) {
            if (sortKeys[idx].dir === "asc") sortKeys[idx].dir = "desc";
            else sortKeys.splice(idx, 1);
          } else {
            sortKeys.push({ col: c, dir: "asc" });
          }
        } else {
          if (idx >= 0 && sortKeys.length === 1) {
            if (sortKeys[0].dir === "asc") sortKeys[0].dir = "desc";
            else sortKeys.length = 0;
          } else {
            sortKeys.length = 0;
            sortKeys.push({ col: c, dir: "asc" });
          }
        }
        applySort();
      });

      filterBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (dropdownCol === c) { closeDropdown(); return; }
        openFilterDropdown(c, th, { advanced: e.altKey }); // alt/option: scope row (tree tables)
      });

      th.addEventListener("pointerdown", (e) => {
        if (e.target.closest(".mkui-filter-btn") || e.target.closest(".mkui-tree-all")) return;
        if (e.button !== 0) return;
        initColumnDrag(vi, e);
      });

      tr.appendChild(th);
    }
    // Filler cell: absorbs pane width beyond the data columns so the header
    // background/border run the full pane width without stretching columns.
    const filler = document.createElement("th");
    filler.className = "mkui-th-filler";
    if (visCols.length) filler.appendChild(makeResizer(visCols[visCols.length - 1]));
    tr.appendChild(filler);
    thead.appendChild(tr);
    const spacerSpan = visCols.length + 1 + (rowColumn ? 1 : 0);
    topSpacerTd.colSpan = spacerSpan;
    botSpacerTd.colSpan = spacerSpan;
    renderColgroup();
    maybeInitWidths();
    updateHeaderState(); // sort/filter marks on the new cells, and the chips
    syncTreeAll();
  }

  function updateHeaderState() {
    for (const th of thead.querySelectorAll("th")) {
      const col = th.dataset.col;
      if (!col) continue; // filler cell
      // One icon slot: the filter button shows the hamburger until the column
      // is sorted, then turns into the sort caret. Either way it still
      // opens the filter dropdown; filter state stays visible as color.
      const btn = th.querySelector(".mkui-filter-btn");
      btn.innerHTML = "";
      const si = sortKeys.findIndex((k) => k.col === col);
      if (si >= 0) {
        const dir = sortKeys[si].dir;
        const ind = document.createElement("span");
        ind.className = "mkui-sort-indicator " +
          (dir === "asc" ? "mkui-sort-asc" : "mkui-sort-desc");
        ind.appendChild(icon(dir === "asc" ? "caret-up" : "caret-down"));
        if (sortKeys.length > 1) {
          // Priority digit overlaid inside the caret (see .mkui-sort-num).
          const num = document.createElement("span");
          num.className = "mkui-sort-num";
          num.textContent = String(si + 1);
          ind.appendChild(num);
        }
        btn.appendChild(ind);
      } else {
        btn.appendChild(icon("filter"));
      }
      const fs = colFilters(col);
      btn.classList.toggle("active", fs.length > 0);
      btn.title = fs.map(describeFilter).join("; ");
    }
    updateColumnsBtn();
    renderChips();
    refreshFindHeaderStyles();
  }

  // The Columns button's badge counts hidden columns; its tooltip gives
  // the whole picture. Its height follows the header row so it reads as
  // part of it.
  function updateColumnsBtn() {
    const n = hiddenColumns().length;
    colsBadge.textContent = n ? String(n) : "";
    colsBadge.hidden = !n;
    colsBtn.classList.toggle("active", n > 0);
    colsBtn.disabled = !columns;
    colsBtn.title = columns
      ? `Columns: ${visibleColumns().length} of ${dataColumns().length} shown`
      : "Columns";
    const h = thead.getBoundingClientRect?.().height;
    if (h > 0) colsBtn.style.height = h + "px";
  }

  /* ── Sort & filter chips ──────────────────────────────────────────── */

  // The toolbar's right side summarises the view so nothing has to be
  // scrolled into sight to be seen or undone: one chip per sort key in
  // priority order (click flips the direction, × drops the key) and one
  // per filtered column (click opens that column's dropdown, × clears it).
  // Each group leads with its icon, which clears the whole group. The
  // cluster is empty — and the toolbar gone, absent buttons — while
  // nothing is active.
  // Drop filters by map key (a column, or column + scope on a tree).
  function clearFilters(keys) {
    for (const k of keys) filters.delete(k);
    if (dropdownCol && !colFilters(dropdownCol).length) closeDropdown();
    updateHeaderState();
    applyVisibility();
    syncPresetTimer();
  }

  function makeChip(cls, col, text, title, onClick, onClear) {
    const chip = document.createElement("span");
    chip.className = "mkui-chip " + cls;
    chip.dataset.col = col;
    chip.title = title;
    const main = document.createElement("button");
    main.className = "mkui-chip-main";
    main.type = "button";
    const label = document.createElement("span");
    label.className = "mkui-chip-text";
    label.textContent = text;
    main.appendChild(label);
    main.addEventListener("click", onClick);
    const x = document.createElement("button");
    x.className = "mkui-chip-x";
    x.type = "button";
    x.title = "Remove";
    x.appendChild(icon("close"));
    x.addEventListener("click", (e) => { e.stopPropagation(); onClear(); });
    chip.append(main, x);
    return { chip, main };
  }

  function makeGroup(cls, iconName, title, onClear, chips) {
    const group = document.createElement("span");
    group.className = "mkui-chip-group " + cls;
    // The icon travels with the first chip so a wrapped line never starts
    // with an orphaned icon (see .mkui-chip-lead).
    const lead = document.createElement("span");
    lead.className = "mkui-chip-lead";
    const btn = document.createElement("button");
    btn.className = "mkui-chip-icon";
    btn.type = "button";
    btn.title = title;
    // The group's icon with an × badge in its corner: it is a clear
    // button, not a state indicator like the header's tinted icon.
    const badge = document.createElement("span");
    badge.className = "mkui-chip-icon-x";
    badge.appendChild(icon("close"));
    btn.append(icon(iconName), badge);
    btn.addEventListener("click", onClear);
    lead.append(btn, chips[0]);
    group.appendChild(lead);
    for (const c of chips.slice(1)) group.appendChild(c);
    return group;
  }

  function renderChips() {
    chipsEl.innerHTML = "";
    if (sortKeys.length) {
      const chips = sortKeys.map((k, i) => {
        const dir = k.dir;
        const { chip, main } = makeChip("mkui-chip-sort", k.col, label(k.col),
          `Sorted ${dir === "asc" ? "ascending" : "descending"} — click to flip`,
          () => { sortKeys[i].dir = dir === "asc" ? "desc" : "asc"; applySort(); },
          () => { sortKeys.splice(i, 1); applySort(); });
        main.appendChild(icon(dir === "asc" ? "caret-up" : "caret-down"));
        return chip;
      });
      chipsEl.appendChild(makeGroup("mkui-chips-sort", "sort", "Clear sort",
        () => { sortKeys.length = 0; applySort(); }, chips));
    }
    if (filters.size) {
      const chips = [...filters].map(([key, f]) => {
        const col = f.col;
        const text = `${label(col)}: ${describeFilter(f)}`;
        const { chip } = makeChip("mkui-chip-filter", col, text, text,
          (e) => {
            if (dropdownCol === col && dropdownScope === (f.scope ?? null)) { closeDropdown(); return; }
            if (columns && !visibleColumns().includes(col)) showColumn(col); // hidden: bring it back first
            const th = thead.querySelector?.(`th[data-col="${CSS.escape(col)}"]`);
            if (!th) return;
            scrollHeaderIntoView(th);
            openFilterDropdown(col, th, { advanced: !!e?.altKey, scope: f.scope });
          },
          () => clearFilters([key]));
        if (f.scope) chip.dataset.scope = f.scope;
        return chip;
      });
      chipsEl.appendChild(makeGroup("mkui-chips-filter", "filter", "Clear all filters",
        () => clearFilters([...filters.keys()]), chips));
    }
    syncToolbar();
  }

  /* ── Column picker ────────────────────────────────────────────────── */

  // The one place columns are chosen in bulk, opened from the Columns
  // button. A checkbox per known column — tick to show (back at its
  // place), untick to hide, applied at once — flat in `columns` order, or
  // sectioned by group when groups are configured: each section has a
  // tri-state checkbox that shows or hides the whole group (bounded, its
  // size printed beside it, one more click reverses it) and collapses
  // unless it holds a shown column. The actions row under the search
  // mirrors the filter dropdown's: "Show all" / "Hide all" / "Reset" (to
  // the configured list). While a query narrows the list the first two
  // scope themselves to the matches ("Show N matching"). Unscoped "Show
  // all" is two-step — click, then confirm within a few seconds — since on
  // a wide table an accidental show-all is the one action that hurts;
  // "Hide all" keeps the last column, and is where a user starts when
  // picking a few columns out of hundreds. The picker survives the
  // re-render each change causes — it lives in its own slot and re-syncs.
  let picker = null;
  let pickerCleanup = null;
  const pickerExpanded = new Map(); // group label -> expanded, kept while the table lives
  const SHOW_ALL_ARM_MS = 4000;

  function closePicker() {
    if (picker) { rememberListHeight(picker, "picker"); picker.remove(); picker = null; }
    if (pickerCleanup) { pickerCleanup(); pickerCleanup = null; }
  }

  function openColumnsPicker(anchorEl) {
    closeDropdown();
    closePicker();
    if (!columns) return;
    const rect = anchorEl.getBoundingClientRect();
    const dd = document.createElement("div");
    dd.className = "mkui-filter-dropdown mkui-columns-picker";
    dd.style.position = "fixed";
    dd.style.zIndex = "10001";

    const title = document.createElement("div");
    title.className = "mkui-columns-title";
    dd.appendChild(title);

    const search = document.createElement("input");
    search.type = "text";
    search.className = "mkui-filter-search";
    search.placeholder = "Search columns…";
    dd.appendChild(search);

    // Show all / Hide all / Reset — the filter dropdown's row, for columns.
    const actions = document.createElement("div");
    actions.className = "mkui-filter-actions mkui-columns-actions";
    const showAll = document.createElement("span");
    showAll.className = "mkui-filter-action mkui-columns-showall";
    const hideAll = document.createElement("span");
    hideAll.className = "mkui-filter-action mkui-columns-hideall";
    const reset = document.createElement("span");
    reset.className = "mkui-filter-action mkui-columns-reset";
    reset.textContent = "Reset";
    reset.title = "Back to the configured columns";
    actions.append(showAll, hideAll, reset);
    dd.appendChild(actions);

    const list = document.createElement("div");
    list.className = "mkui-filter-list";
    const items = [];  // { col, cb, el }
    const groups = []; // { label, columns, cb, head, body, caret, count }
    const makeItem = (c, parent) => {
      const lbl = document.createElement("label");
      lbl.className = "mkui-filter-item";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.dataset.col = c;
      const txt = document.createElement("span");
      txt.textContent = label(c);
      lbl.append(cb, txt);
      parent.appendChild(lbl);
      items.push({ col: c, cb, el: lbl });
      cb.addEventListener("change", () => {
        if (cb.checked) showColumn(c); else hideColumn(c);
        sync(); // a refused hide (last column) snaps the box back
      });
    };
    const sections = colGroups();
    if (sections) {
      for (const g of sections) {
        const sec = document.createElement("div");
        sec.className = "mkui-columns-group";
        const head = document.createElement("div");
        head.className = "mkui-columns-group-head";
        const caret = document.createElement("span");
        caret.className = "mkui-columns-caret";
        caret.appendChild(icon("chevron-right"));
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.dataset.group = g.label;
        const txt = document.createElement("span");
        txt.className = "mkui-columns-group-label";
        txt.textContent = g.label;
        const count = document.createElement("span");
        count.className = "mkui-columns-count";
        head.append(caret, cb, txt, count);
        const body = document.createElement("div");
        body.className = "mkui-columns-items";
        sec.append(head, body);
        list.appendChild(sec);
        for (const c of g.columns) makeItem(c, body);
        const gr = { label: g.label, columns: g.columns, cb, head, body, caret, count, el: sec };
        groups.push(gr);
        if (!pickerExpanded.has(g.label))
          pickerExpanded.set(g.label, g.columns.some((c) => visibleColumns().includes(c)));
        head.addEventListener("click", (e) => {
          if (e.target === cb) return; // the checkbox is its own control
          pickerExpanded.set(g.label, !pickerExpanded.get(g.label));
          sync();
        });
        cb.addEventListener("change", () => {
          if (cb.checked) showColumns(g.columns); else hideColumns(g.columns);
          sync();
        });
      }
    } else {
      for (const c of dataColumns()) makeItem(c, list);
    }
    dd.appendChild(list);

    let armed = false, armTimer = null;
    const disarm = () => {
      armed = false;
      if (armTimer) { clearTimeout(armTimer); armTimer = null; }
    };
    reset.addEventListener("click", () => { disarm(); resetVisible(); sync(); });

    // The query narrows items; a group label match keeps its whole group.
    const query = () => String(search.value ?? "").trim().toLowerCase();
    const matches = (c, q) => !q || label(c).toLowerCase().includes(q) || c.toLowerCase().includes(q);
    const matching = () => {
      const q = query();
      if (!q) return items.map((it) => it.col);
      const out = [];
      if (groups.length) {
        for (const g of groups) {
          const whole = g.label.toLowerCase().includes(q);
          for (const c of g.columns) if (whole || matches(c, q)) out.push(c);
        }
      } else {
        for (const it of items) if (matches(it.col, q)) out.push(it.col);
      }
      return out;
    };
    showAll.addEventListener("click", () => {
      if (query()) { showColumns(matching()); sync(); return; } // scoped: bounded, one click
      if (!visible) return; // already showing everything
      if (!armed) {
        armed = true;
        armTimer = setTimeout(() => { disarm(); sync(); }, SHOW_ALL_ARM_MS);
      } else {
        disarm();
        showAllColumns();
      }
      sync();
    });
    hideAll.addEventListener("click", () => { disarm(); hideColumns(matching()); sync(); });

    function sync() {
      const vis = new Set(visibleColumns());
      const all = dataColumns();
      const q = query();
      const hit = new Set(matching());
      title.textContent = `Columns · ${vis.size} of ${all.length} shown`;
      for (const it of items) {
        it.cb.checked = vis.has(it.col);
        it.el.style.display = hit.has(it.col) ? "" : "none";
      }
      for (const g of groups) {
        const shown = g.columns.filter((c) => vis.has(c)).length;
        g.cb.checked = shown === g.columns.length;
        g.cb.indeterminate = shown > 0 && shown < g.columns.length;
        g.count.textContent = `${shown} of ${g.columns.length}`;
        const any = g.columns.some((c) => hit.has(c));
        g.el.style.display = any ? "" : "none";
        const open = q ? true : !!pickerExpanded.get(g.label);
        g.body.hidden = !open;
        g.caret.classList.toggle("open", open);
      }
      const toShow = [...hit].filter((c) => !vis.has(c)).length;
      const toHide = [...hit].filter((c) => vis.has(c)).length;
      if (q) {
        disarm();
        showAll.textContent = `Show ${toShow} matching`;
        showAll.classList.toggle("mkui-filter-action-off", toShow === 0);
        hideAll.textContent = `Hide ${toHide} matching`;
        hideAll.classList.toggle("mkui-filter-action-off", toHide === 0);
      } else {
        showAll.textContent = armed ? `Show all ${all.length}? Confirm` : "Show all";
        showAll.classList.toggle("mkui-filter-action-off", !visible);
        hideAll.textContent = "Hide all";
        hideAll.classList.toggle("mkui-filter-action-off", vis.size <= 1);
      }
      showAll.classList.toggle("mkui-columns-confirm", armed);
      reset.classList.toggle("mkui-filter-action-off", isDefaultVisible());
    }
    sync();
    search.addEventListener("input", sync);
    dd.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { closePicker(); e.stopPropagation(); }
    });

    host.appendChild(dd);
    picker = dd;
    placeDropdown(dd, rect, 240);
    fitList(dd, list, "picker");
    search.focus();
    requestAnimationFrame(() => {
      const onDown = (e) => {
        if (e.target.closest(".mkui-columns-btn")) return; // the button toggles
        if (dd.contains(e.target)) return;
        closePicker();
      };
      document.addEventListener("mousedown", onDown, true);
      pickerCleanup = () => {
        document.removeEventListener("mousedown", onDown, true);
        disarm();
      };
    });
  }

  /* ── Column drag ──────────────────────────────────────────────────── */

  function initColumnDrag(fromIdx, e) {
    const pid = e.pointerId;
    const startX = e.clientX;
    let active = false;
    let ghost = null;
    let indicator = null;
    let dropIdx = fromIdx;

    function cleanup() {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", cleanup);
      if (ghost) ghost.remove();
      if (indicator) indicator.remove();
    }

    function onMove(e2) {
      if (e2.pointerId !== pid) return;
      if (!active) {
        if (Math.abs(e2.clientX - startX) < 5) return;
        active = true;
        closeDropdown();
        ghost = document.createElement("div");
        ghost.className = "mkui-col-drag-ghost";
        ghost.textContent = label(visibleColumns()[fromIdx]);
        host.appendChild(ghost);
        indicator = document.createElement("div");
        indicator.className = "mkui-col-drop-indicator";
        const hr = thead.getBoundingClientRect();
        indicator.style.height = hr.height + "px";
        indicator.style.top = hr.top + "px";
        host.appendChild(indicator);
      }
      ghost.style.left = (e2.clientX + 12) + "px";
      ghost.style.top = (e2.clientY - 10) + "px";

      // Skip the row-number th: dropIdx must stay aligned with visCols
      // indices (the filler th marks the after-last-column slot).
      const ths = [...thead.querySelectorAll("th")]
        .filter((t) => !String(t.className).includes("mkui-th-rownum"));
      dropIdx = ths.length;
      for (let i = 0; i < ths.length; i++) {
        const r = ths[i].getBoundingClientRect();
        if (e2.clientX < r.left + r.width / 2) { dropIdx = i; break; }
      }
      let x;
      if (dropIdx < ths.length) x = ths[dropIdx].getBoundingClientRect().left;
      else x = ths[ths.length - 1].getBoundingClientRect().right;
      indicator.style.left = (x - 1) + "px";
    }

    function onUp(e2) {
      if (e2.pointerId !== pid) return;
      cleanup();
      if (active) {
        suppressClick = true;
        setTimeout(() => { suppressClick = false; }, 200);
        moveColumn(fromIdx, dropIdx);
      }
    }

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", cleanup);
  }

  function moveColumn(fromVisIdx, toDropIdx) {
    const effective = toDropIdx > fromVisIdx ? toDropIdx - 1 : toDropIdx;
    if (effective === fromVisIdx) return;
    const order = visibleColumns().slice();
    const [col] = order.splice(fromVisIdx, 1);
    order.splice(effective, 0, col);
    visible = order;
    applyVisible();
  }

  function rebuildAllRows() {
    for (const [key, tr] of rowEls) {
      const row = rows.get(key);
      if (!row) continue;
      const fresh = buildRow(row);
      tr.replaceWith(fresh);
      rowEls.set(key, fresh);
    }
  }

  /* ── Filter dropdown ──────────────────────────────────────────────── */

  function openFilterDropdown(col, thEl, { advanced = false, scope: wantScope = null } = {}) {
    closeDropdown();
    closePicker();
    dropdownCol = col;

    const rect = thEl.getBoundingClientRect();
    const dd = document.createElement("div");
    dd.className = "mkui-filter-dropdown";
    dd.style.position = "fixed";
    dd.style.zIndex = "10001";

    // Tree tables: one filter per scope, the scope row picking which the
    // dropdown edits — the default scope, else the first scoped one the
    // column has. A plain open on a column filtered only at the top looks
    // like a flat table's; alt/option-click, a filter (or the default
    // scope) off the top, or an asked-for scope shows the row.
    const mine = tree ? colFilters(col) : [];
    const scope = !tree ? null
      : wantScope ?? (filters.has(fkey(col, tree.filterScope)) ? tree.filterScope : mine[0]?.scope ?? tree.filterScope);
    dropdownScope = scope;
    const cur = tree ? filters.get(fkey(col, scope)) : filters.get(col);
    const type = filterType(col);
    // Numeric and time columns get a Values | Range mode switch; text
    // columns look exactly as before. A range filter on a column that has
    // since ratcheted to text still opens in Range so it can be cleared.
    const rangeable = type !== "text" || cur?.kind === "range";
    let mode = cur?.kind === "range" ? "range" : "values";
    // Time columns widen the dropdown for the native date/time pickers
    // (matches .mkui-filter-wide in the stylesheet).
    const wide = type === "time" || cur?.kind === "range" && cur.type === "time";
    if (wide) dd.classList.add("mkui-filter-wide");

    // The one column control here is scoped to this column: hide it.
    // Choosing the set (and groups) is the Columns button's job.
    const colOps = document.createElement("div");
    colOps.className = "mkui-filter-actions mkui-filter-colops";
    const hideOp = document.createElement("span");
    hideOp.className = "mkui-filter-action";
    hideOp.textContent = "Hide column";
    if (visibleColumns().length <= 1) {
      hideOp.classList.add("mkui-filter-action-off");
      hideOp.title = "The last column can't be hidden";
    } else {
      hideOp.addEventListener("click", () => hideColumn(col)); // closes the dropdown
    }
    colOps.appendChild(hideOp);
    dd.appendChild(colOps);

    // The scope row: tabs, one filter each. Switching reopens the dropdown
    // on that scope's filter (or an empty one); a tab whose scope holds a
    // filter is marked.
    if (tree && (advanced || scope !== "roots" || mine.some((f) => f.scope !== "roots"))) {
      const scopes = document.createElement("div");
      scopes.className = "mkui-filter-modes mkui-filter-scopes";
      const sbtns = TREE_SCOPES.map((sc) => {
        const b = document.createElement("span");
        b.className = "mkui-filter-mode mkui-filter-scope";
        b.dataset.scope = sc;
        b.textContent = sc === "roots" ? "Top" : sc === "children" ? "Child" : "Branch";
        b.title = sc === "roots" ? "Filter top-level rows; their children show with them"
          : sc === "children" ? "Filter child rows; every top-level row shows"
          : "Filter every row; a branch stays while any row on it matches";
        b.classList.toggle("active", sc === scope);
        b.classList.toggle("mkui-filter-scope-set", filters.has(fkey(col, sc)));
        b.addEventListener("click", () => {
          if (sc !== scope) openFilterDropdown(col, thEl, { advanced: true, scope: sc });
        });
        return b;
      });
      scopes.append(...sbtns);
      dd.appendChild(scopes);
    }

    const rangePanel = document.createElement("div");
    rangePanel.className = "mkui-filter-range";

    if (rangeable) {
      const modes = document.createElement("div");
      modes.className = "mkui-filter-modes";
      const mk = (m, text) => {
        const b = document.createElement("span");
        b.className = "mkui-filter-mode";
        b.dataset.mode = m;
        b.textContent = text;
        b.addEventListener("click", () => setMode(m));
        return b;
      };
      const btns = [mk("values", "Values"), mk("range", "Range")];
      modes.append(...btns);
      dd.appendChild(modes);
      var setMode = (m) => {
        mode = m;
        for (const b of btns) b.classList.toggle("active", b.dataset.mode === m);
        for (const el of [search, actions, list]) el.hidden = m !== "values";
        rangePanel.hidden = m !== "range";
        (m === "range" ? loInput : search).focus();
      };
    }

    /* ── Values mode (checkbox per unique value) ── */

    const search = document.createElement("input");
    search.type = "text";
    search.className = "mkui-filter-search";
    search.placeholder = "Search…";
    dd.appendChild(search);

    const actions = document.createElement("div");
    actions.className = "mkui-filter-actions";
    const selAll = document.createElement("span");
    selAll.className = "mkui-filter-action";
    selAll.textContent = "Select all";
    const clrAll = document.createElement("span");
    clrAll.className = "mkui-filter-action";
    clrAll.textContent = "Clear";
    actions.append(selAll, clrAll);
    dd.appendChild(actions);

    const list = document.createElement("div");
    list.className = "mkui-filter-list";

    const vals = getUniqueValues(col);
    const curVals = cur?.kind === "values" ? cur.values : null;
    // Which side the checkboxes describe: flipped by Select all / Clear.
    let side = cur?.kind === "values" ? cur.mode : "exclude";
    const isChecked = (v) => !curVals || curVals.has(v) === (side === "include");
    const cbs = [];

    // Decimal-align numeric values, matching the column's cells: values are
    // left-anchored next to their checkboxes, so left-pad by the integer-
    // width deficit (in ch, mono font) to line the decimal points up.
    const st = colStats.get(col);
    const intLen = (s) => {
      const i = s.indexOf(".");
      return i < 0 ? s.length : i;
    };
    let maxInt = 0;
    if (st?.numeric) {
      for (const v of vals) if (v !== "") maxInt = Math.max(maxInt, intLen(v));
    }

    for (const v of vals) {
      const lbl = document.createElement("label");
      lbl.className = "mkui-filter-item";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = isChecked(v);
      cb.dataset.val = v;
      const txt = document.createElement("span");
      txt.textContent = v === "" ? "(empty)" : v;
      if (st?.numeric && v !== "") {
        txt.classList.add("mkui-filter-num");
        const pad = maxInt - intLen(v);
        if (pad > 0) txt.style.setProperty("--mkui-num-pad", pad + "ch");
      }
      lbl.append(cb, txt);
      list.appendChild(lbl);
      cbs.push(cb);
      cb.addEventListener("change", commitValues);
    }
    dd.appendChild(list);

    function commitValues() {
      const listed = cbs
        .filter((c) => c.checked === (side === "include"))
        .map((c) => c.dataset.val);
      // An exclusion of nothing is no filter; an inclusion always is —
      // "Clear, then tick every value" still means only those values.
      const key = fkey(col, scope);
      if (side === "exclude" && listed.length === 0) filters.delete(key);
      else filters.set(key, { kind: "values", mode: side, values: new Set(listed), col, scope });
      updateHeaderState();
      applyVisibility();
      syncPresetTimer();
    }

    selAll.addEventListener("click", () => {
      side = "exclude";
      for (const c of cbs) c.checked = true;
      commitValues();
    });
    clrAll.addEventListener("click", () => {
      side = "include";
      for (const c of cbs) c.checked = false;
      commitValues();
    });

    search.addEventListener("input", () => {
      const q = search.value.toLowerCase();
      for (const c of cbs)
        c.parentElement.style.display =
          c.dataset.val.toLowerCase().includes(q) ? "" : "none";
    });

    /* ── Range mode (lo/hi bounds, presets for time columns) ── */

    const rType = cur?.kind === "range" ? cur.type : type;
    const kind = rType === "time" ? (cur?.kind === "range" ? cur.timeKind : timeKindOf(col)) : null;
    const localTz = cur?.kind === "range" ? cur.localTz : isLocalCol(col);
    let preset = cur?.kind === "range" ? cur.preset : null;
    const presetBtns = [];

    if (rType === "time") {
      const row = document.createElement("div");
      row.className = "mkui-filter-presets";
      for (const [name, p] of Object.entries(PRESETS)) {
        const b = document.createElement("span");
        b.className = "mkui-filter-preset";
        b.dataset.preset = name;
        b.textContent = p.label;
        b.addEventListener("click", () => {
          preset = preset === name ? null : name;
          loInput.value = hiInput.value = "";
          commitRange();
        });
        presetBtns.push(b);
        row.appendChild(b);
      }
      rangePanel.appendChild(row);
    }

    const mkBound = (labelText, edge) => {
      const wrap = document.createElement("label");
      wrap.className = "mkui-filter-bound";
      const l = document.createElement("span");
      l.textContent = labelText;
      const inp = document.createElement("input");
      inp.className = "mkui-filter-bound-input";
      inp.dataset.edge = edge;
      if (rType === "number") {
        inp.type = "number";
        inp.step = "any";
        const b = edge === "lo" ? st?.min : st?.max;
        if (b != null) inp.placeholder = String(b);
      } else {
        inp.type = inputTypeForKind(kind);
        inp.step = "1";
        const b = edge === "lo" ? st?.min : st?.max;
        if (b != null && !st?.numeric) inp.placeholder = boundToInput(b, kind, localTz);
      }
      wrap.append(l, inp);
      return [wrap, inp];
    };
    const [loWrap, loInput] = mkBound("From", "lo");
    const [hiWrap, hiInput] = mkBound("To", "hi");
    rangePanel.append(loWrap, hiWrap);

    const emptyWrap = document.createElement("label");
    emptyWrap.className = "mkui-filter-item mkui-filter-empty";
    const emptyCb = document.createElement("input");
    emptyCb.type = "checkbox";
    emptyCb.checked = cur?.kind === "range" ? cur.empty : false;
    const emptyTxt = document.createElement("span");
    emptyTxt.textContent = "Include empty";
    emptyWrap.append(emptyCb, emptyTxt);
    rangePanel.appendChild(emptyWrap);

    const rangeActions = document.createElement("div");
    rangeActions.className = "mkui-filter-actions";
    const clrRange = document.createElement("span");
    clrRange.className = "mkui-filter-action";
    clrRange.textContent = "Clear";
    rangeActions.appendChild(clrRange);
    rangePanel.appendChild(rangeActions);

    if (cur?.kind === "range" && !cur.preset) {
      loInput.value = cur.loText;
      hiInput.value = cur.hiText;
    }

    function readBound(inp, edge) {
      const v = inp.value;
      if (v === "" || v == null) return null;
      if (rType === "number") { const n = Number(v); return isNaN(n) ? null : n; }
      return inputToBound(v, kind, edge, localTz);
    }

    function commitRange() {
      const lo = readBound(loInput, "lo"), hi = readBound(hiInput, "hi");
      for (const b of presetBtns) b.classList.toggle("active", b.dataset.preset === preset);
      const key = fkey(col, scope);
      if (preset === null && lo === null && hi === null && !emptyCb.checked) filters.delete(key);
      else filters.set(key, {
        kind: "range", type: rType, lo, hi, preset, empty: emptyCb.checked,
        loText: lo === null ? "" : String(loInput.value), hiText: hi === null ? "" : String(hiInput.value),
        timeKind: kind, spec: timeSpec(col), localTz, col, scope,
      });
      updateHeaderState();
      applyVisibility();
      syncPresetTimer();
    }

    // Typing applies after a short pause (a keystroke-per-rebuild would
    // hurt on big tables); Enter applies at once. Typing a bound drops the
    // preset — the two are alternative ways of saying the same thing.
    let typeTimer = null;
    const onType = () => {
      preset = null;
      if (typeTimer) clearTimeout(typeTimer);
      typeTimer = setTimeout(() => { typeTimer = null; commitRange(); }, 150);
    };
    for (const inp of [loInput, hiInput]) {
      inp.addEventListener("input", onType);
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          if (typeTimer) { clearTimeout(typeTimer); typeTimer = null; }
          preset = null;
          commitRange();
        }
      });
    }
    emptyCb.addEventListener("change", commitRange);
    clrRange.addEventListener("click", () => {
      preset = null;
      loInput.value = hiInput.value = "";
      emptyCb.checked = false;
      commitRange();
    });
    for (const b of presetBtns) b.classList.toggle("active", b.dataset.preset === preset);

    if (rangeable) dd.appendChild(rangePanel);

    dd.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { closeDropdown(); e.stopPropagation(); }
    });

    host.appendChild(dd);
    dropdown = dd;
    // Place and size in values mode — range panel out of the way, list
    // shown — whatever mode the dropdown then opens in.
    rangePanel.hidden = true;
    placeDropdown(dd, rect, wide ? 280 : 200);
    fitList(dd, list, "filter");
    if (rangeable) setMode(mode); else search.focus();

    requestAnimationFrame(() => {
      const onDown = (e) => {
        if (e.target.closest(".mkui-filter-btn")) return;
        if (dd.contains(e.target)) return;
        closeDropdown();
      };
      document.addEventListener("mousedown", onDown, true);
      dropdownCleanup = () =>
        document.removeEventListener("mousedown", onDown, true);
    });
  }

  // Which columns show is seeded before the header first renders.
  loadVisibleSpec(spec.visible);
  defaultVisible = visible;
  if (columns) renderHead();

  /* ── Row building ─────────────────────────────────────────────────── */

  function buildRow(row) {
    const tr = document.createElement("tr");
    const key = row[idKey];
    tr.dataset.ref = key;
    if (rowColumn) {
      // Number text is filled in by render() — it depends on view position.
      const td = document.createElement("td");
      td.className = "mkui-td-rownum";
      tr.appendChild(td);
    }
    const tc = treeCol();
    for (const c of visibleColumns()) {
      const td = document.createElement("td");
      td.dataset.col = c;
      if (c === tc) {
        // Caret + indented text; renderCell writes into the text span.
        td.classList.add("mkui-tree-cell");
        const depth = rowDepth(key);
        if (depth) td.style.setProperty("--mkui-tree-depth", String(depth));
        const text = document.createElement("span");
        text.className = "mkui-tree-text";
        td._mkuiTreeText = text;
        td.append(makeToggle(key), text);
      }
      renderCell(td, row, c);
      styleCell(td, c);
      styleCellStyler(td, row, c);
      tr.appendChild(td);
    }
    if (tc !== null) {
      tr.dataset.depth = String(rowDepth(key));
      syncToggle(key, tr);
    }
    styleRowStyler(tr, row);
    tr.addEventListener("pointerdown", (e) => handleRowPointerDown(key, e));
    return tr;
  }

  function flash(el, cls) {
    el.classList.remove("mkui-flash-in", "mkui-flash-out", "mkui-flash-update");
    void el.offsetWidth;
    el.classList.add(cls);
    el.addEventListener("animationend", () => el.classList.remove(cls), { once: true });
  }

  /* ── Snapshot ingestion (chunked for large datasets) ─────────────── */

  let snapshotGen = 0;
  const CHUNK = 100;

  function applySnapshot(snap) {
    const gen = ++snapshotGen;
    if (protocol !== "stream") {
      clearData();
      clearSelection();
    }
    if (!columns && snap.length > 0) {
      columns = inferColumns(snap[0]);
      renderHead();
    }
    maybeInitWidths(); // lock header widths before rows render, not after
    // At least CHUNK per frame, but never more than ~50 frames total —
    // a million-row snapshot ingests in 20k-row chunks, not 10k frames.
    const chunkSize = Math.max(CHUNK, Math.ceil(snap.length / 50));
    let i = 0;
    const ingest = (until) => {
      for (; i < until; i++) {
        const row = snap[i];
        if (rows.has(row[idKey])) applyReplace(row);
        else insertRow(row, tree !== null);
      }
      render();
    };
    if (snap.length <= chunkSize) {
      ingest(snap.length);
      maybeRestoreScroll();
      return;
    }

    progress.textContent = `Loading 0 / ${snap.length}…`;
    progress.style.display = "";

    function renderChunk() {
      if (gen !== snapshotGen) return;
      ingest(Math.min(i + chunkSize, snap.length));
      if (i < snap.length) {
        progress.textContent = `Loading ${i} / ${snap.length}…`;
        requestAnimationFrame(renderChunk);
      } else {
        progress.style.display = "none";
        maybeRestoreScroll();
      }
    }
    renderChunk();
  }

  function applyInsert(row) {
    if (!columns) {
      columns = inferColumns(row);
      renderHead();
    }
    maybeInitWidths(); // lock header widths before the row renders
    insertRow(row);
    render();
    const tr = rowEls.get(row[idKey]);
    if (tr) flash(tr, "mkui-flash-in");
  }

  function applyDelete(row) {
    const key = row[idKey];
    const prev = rows.get(key);
    const gated = hasButtons && rowInSelection(key);
    const vi = viewIndexOf(prev ?? row);
    if (tree && prev) {
      // Its children re-home (orphans become roots or hide): rebuild. A
      // childless row just leaves its slot, its later siblings moving up.
      const pk = parentOf.get(key);
      if (pk !== undefined) shiftRanks(pk, key, -1); // its later siblings move up, shown or not
      if (unlinkRow(prev) || allScopeActive()) markViewDirty();
      else if (vi >= 0) view.splice(vi, 1);
      if (pk != null) syncToggle(pk); // may have lost its last child
    } else {
      if (flatRanked()) flatRankDelete(key);
      if (vi >= 0) view.splice(vi, 1);
    }
    const bi = baseOrder.indexOf(key);
    if (bi >= 0) baseOrder.splice(bi, 1);
    rows.delete(key);
    selectedKeys.delete(key);
    if (cellOff.size)
      for (const k of [...cellOff])
        if (k.startsWith(key + "\0")) cellOff.delete(k);
    viewRev++;
    const tr = rowEls.get(key);
    if (tr) {
      // Fade out in place; render() no longer tracks this element, so it
      // is removed for real when the animation ends.
      rowEls.delete(key);
      flash(tr, "mkui-flash-out");
      tr.addEventListener("animationend", () => tr.remove(), { once: true });
    }
    render();
    // A selected row leaving the table changes the count the buttons see.
    if (gated) updateButtonStates();
    // The published row may be the one that just went away.
    publishSelection();
  }

  function applyReplace(row) {
    const key = row[idKey];
    const prev = rows.get(key);
    if (!prev) {
      applyInsert(row);
      return;
    }
    bumpStats(row);
    let sortChanged = false;
    const changed = [];
    for (const c of visibleColumns()) {
      const newVal = cellText(row, c);
      const oldVal = cellText(prev, c);
      if (newVal !== oldVal) {
        changed.push([c, newVal]);
        if (sortKeys.some((k) => k.col === c)) sortChanged = true;
      }
    }
    const wasVis = matchesFilters(prev) && passesAllScoped(prev);
    const isVis = matchesFilters(row) && passesAllScoped(row);
    if (tree && (childVals(row) !== childVals(prev) || parentVals(row) !== parentVals(prev))) {
      // Its place in the tree changed: relink and rebuild (its subtree
      // moves with it; children that named the old values re-home).
      unlinkRow(prev);
      rows.set(key, row);
      linkRow(row);
      markViewDirty();
      render();
    } else if (sortChanged || wasVis !== isVis) {
      if (tree) {
        // Sibling order or a subtree's visibility changed: rebuild.
        rows.set(key, row);
        sortedKidsCache.delete(parentOf.get(key) ?? null);
        markViewDirty();
        render();
      } else {
        // Reposition: remove at the old view slot (found via prev, still in
        // rows), then re-insert at the slot the new values sort into.
        if (wasVis) {
          const vi = viewIndexOf(prev);
          if (vi >= 0) view.splice(vi, 1);
        }
        rows.set(key, row);
        if (isVis) view.splice(viewInsertPos(row), 0, key);
        if (flatRanked() && sortChanged) { flatRankDelete(key); flatRankInsert(row); }
        viewRev++;
        render();
      }
    } else {
      rows.set(key, row);
    }
    const tr = rowEls.get(key);
    if (tr) {
      const changedCols = new Set(changed.map(([c]) => c));
      for (const c of visibleColumns()) {
        // Cells whose value changed re-render; display cells also re-render
        // when their template's output changed (it may read other columns).
        const isChanged = changedCols.has(c);
        if (!isChanged && !displayExprs[c]) continue;
        const td = tr.querySelector(`td[data-col="${CSS.escape(c)}"]`);
        if (!td) continue;
        if (!isChanged && displayText(row, c) === td._mkuiText) continue;
        renderCell(td, row, c);
        styleCell(td, c);
        flash(td, "mkui-flash-update");
      }
      restyleRowStylers(tr, row);
      if (findRe && tr._viewIdx != null) styleRowSelection(tr, key, tr._viewIdx);
    }
    // New text under an open find strip: the match list follows (an
    // in-place replace bumps no viewRev, so render() won't notice).
    if (findRe && changed.length) scheduleFindRescan();
    // A live update to a row the buttons act on can flip an `enable.when`
    // verdict (a status column crossing a gate), so re-evaluate them.
    if (hasButtons && rowInSelection(key)) updateButtonStates();
    // A live update to the published row replaces the object it points at,
    // so followers see the new values instead of a snapshot.
    if (lastPublishedRow === prev) publishRow(row);
  }

  /* ── Subscription ─────────────────────────────────────────────────── */

  let client;
  try {
    client = await ensureMkio(wsUrl);
  } catch (e) {
    host.textContent = "[mkio-table] " + e.message;
    return;
  }

  let lastRef = null;

  const callbacks = {
    onSnapshot: (snap) => {
      const follow = shouldFollowTail();
      applySnapshot(snap);
      if (protocol === "stream" && snap.length > 0) {
        const ref = snap[snap.length - 1]._mkio_ref;
        if (ref) lastRef = ref;
      }
      if (follow) scrollToTail();
    },
    onDelta: (changes) => {
      const follow = shouldFollowTail();
      for (const ch of changes) {
        if (ch.op === "insert") applyInsert(ch.row);
        else if (ch.op === "delete") applyDelete(ch.row);
        else applyReplace(ch.row);
      }
      if (protocol === "stream" && changes.length > 0) {
        const ref = changes[changes.length - 1].row._mkio_ref;
        if (ref) lastRef = ref;
      }
      if (follow) scrollToTail();
      else maybeRestoreScroll();
    },
    onUpdate: (op, row) => {
      const follow = shouldFollowTail();
      if (op === "insert") applyInsert(row);
      else if (op === "delete") applyDelete(row);
      else applyReplace(row);
      if (protocol === "stream" && row._mkio_ref) lastRef = row._mkio_ref;
      if (follow) scrollToTail();
      else maybeRestoreScroll();
    },
  };

  const subid = `mkui-table-${++_subCounter}`;
  const pageSubId = subid + "-page";
  let subscribed = false;
  let closed = false;
  let liveMode = !isPaged;

  let savedScrollTop = 0;
  let restoreScrollTarget = 0;
  let tailPending = false;

  scrollHost.addEventListener("scroll", () => {
    savedScrollTop = scrollHost.scrollTop;
    render();
  });

  function maybeRestoreScroll() {
    if (!restoreScrollTarget) return;
    const target = restoreScrollTarget;
    restoreScrollTarget = 0;
    requestAnimationFrame(() => { scrollHost.scrollTop = target; render(); });
  }

  // A live stream reads like a terminal: keep the newest row in view while
  // the user is parked at the tail, but never yank a viewport they have
  // scrolled up to inspect. `tailPending` forces one jump on entering live.
  function shouldFollowTail() {
    if (protocol !== "stream" || !liveMode) return false;
    if (tailPending) return true;
    return scrollHost.scrollTop + scrollHost.clientHeight >= scrollHost.scrollHeight - 8;
  }

  function scrollToTail() {
    tailPending = false;
    restoreScrollTarget = 0;
    requestAnimationFrame(() => {
      scrollHost.scrollTop = scrollHost.scrollHeight;
      render();
    });
  }

  function sub() {
    if (closed || subscribed) return;
    subscribed = true;
    ++snapshotGen;
    const resuming = protocol === "stream" && lastRef;
    if (!resuming) {
      restoreScrollTarget = savedScrollTop;
      clearData();
      clearSelection();
    }
    const opts = { subid, topic: spec.topic, filter: spec.filter, ...callbacks };
    if (protocol === "query" && maxcount) opts.maxcount = maxcount;
    if (resuming) opts.ref = lastRef;
    client.subscribe(spec.service, protocol, opts);
  }

  function unsub() {
    if (!subscribed) return;
    subscribed = false;
    client.unsubscribe(subid);
  }

  /* ── Paging (stream) ──────────────────────────────────────────────── */

  let pageHasMore = false;
  let pageHasPrev = false;
  let firstRef = null;
  let pageLoadRef = getStartRef();
  let pageLoadBefore = false;
  let savedPageState = null;
  let pageFetchPending = false;
  let hasEarlierPages = false;

  let prevPageLoadRef = null;
  let prevPageLoadBefore = false;
  let noPrev = false;

  // `live = true` still loads the start page first, then hands off to the
  // live stream — subscribing live from the outset would ignore `start` and
  // replay the whole buffer.
  let autoLivePending = startLive;

  function fetchPage(ref, before) {
    if (closed) return;
    unsub();
    subscribed = true;
    clearData();
    prevPageLoadRef = pageLoadRef;
    prevPageLoadBefore = pageLoadBefore;
    pageLoadRef = ref;
    pageLoadBefore = !!before;
    const opts = {
      subid,
      maxcount,
      ref: ref ?? null,
      updates: false,
      topic: spec.topic,
      filter: spec.filter,
      onPage: (pageRows, info) => {
        if (before) {
          pageHasPrev = info.hasmore;
          pageHasMore = true;
        } else {
          pageHasMore = info.hasmore;
          if (noPrev) { pageHasPrev = false; noPrev = false; }
          else pageHasPrev = ref != null;
        }
        if (pageRows.length > 0) {
          if (!columns) { columns = inferColumns(pageRows[0]); renderHead(); }
          maybeInitWidths(); // lock header widths before rows render
          growSuspended = dataSeen; // only the first data sizes the columns
          for (const row of pageRows) insertRow(row);
          growSuspended = false;
          render();
          firstRef = pageRows[0]._mkio_ref;
          lastRef = pageRows[pageRows.length - 1]._mkio_ref;
        } else if (before && prevPageLoadRef != null) {
          noPrev = true;
          fetchPage(prevPageLoadRef, prevPageLoadBefore);
          return;
        } else {
          firstRef = ref;
        }
        updatePagingUI();
        if (autoLivePending) {
          autoLivePending = false;
          // An empty start page leaves lastRef null, and sub() with no ref
          // streams the buffer from the beginning — anchor to the start ref.
          if (lastRef == null) lastRef = getStartRef();
          goLive();
        }
      },
    };
    if (before) opts.before = true;
    client.subscribe(spec.service, "stream", opts);
  }

  function goLive() {
    savedPageState = { pageLoadRef, pageLoadBefore };
    liveMode = true;
    hasEarlierPages = false;
    tailPending = true;
    unsub();
    sub();
    scrollToTail();
    updatePagingUI();
  }

  function exitLive() {
    liveMode = false;
    hasEarlierPages = false;
    unsub();
    client.unsubscribe(pageSubId);
    pageFetchPending = false;
    clearSelection();

    if (savedPageState) {
      const ref = savedPageState.pageLoadRef;
      const before = savedPageState.pageLoadBefore;
      savedPageState = null;
      fetchPage(ref, before);
    } else {
      lastRef = null;
      firstRef = null;
      pageHasMore = false;
      pageHasPrev = false;
      fetchPage(getStartRef());
    }

    updatePagingUI();
  }

  function fetchPrevLive() {
    if (!pageHasPrev || closed || pageFetchPending) return;
    pageFetchPending = true;
    updatePagingUI();
    client.subscribe(spec.service, "stream", {
      subid: pageSubId,
      maxcount,
      ref: firstRef,
      before: true,
      updates: false,
      topic: spec.topic,
      filter: spec.filter,
      onPage: (pageRows, info) => {
        pageFetchPending = false;
        pageHasPrev = info.hasmore;
        if (pageRows.length > 0) {
          hasEarlierPages = true;
          if (!columns) { columns = inferColumns(pageRows[0]); renderHead(); }
          maybeInitWidths(); // lock header widths before rows render
          // Prepend the earlier page in display order without disturbing
          // the live rows below it.
          const keys = [];
          growSuspended = dataSeen;
          for (const row of pageRows) {
            bumpStats(row);
            const key = row[idKey];
            if (!rows.has(key)) keys.push(key);
            rows.set(key, row);
          }
          growSuspended = false;
          baseOrder = keys.concat(baseOrder);
          markViewDirty();
          render();
          firstRef = pageRows[0]._mkio_ref;
        }
        updatePagingUI();
      },
    });
  }

  mkioConnected = !!app.state.get("mkio.connected");
  app.state.subscribe("mkio.connected", (v) => {
    mkioConnected = !!v;
    if (hasButtons) updateButtonStates();
    updatePagingUI();
  });

  function updatePagingUI() {
    if (!pagingToolbar) return;
    if (liveMode) {
      prevBtn.disabled = !pageHasPrev || pageFetchPending;
      nextBtn.disabled = true;
      refreshBtn.disabled = true;
      const suffix = mkioConnected ? "Live" : "Disconnected";
      pageInfo.textContent = hasEarlierPages && firstRef
        ? `${fmtRefStart(firstRef)} – ${suffix}` : suffix;
      liveBtn.classList.toggle("active", mkioConnected);
      liveBtn.classList.toggle("disconnected", !mkioConnected);
    } else {
      prevBtn.disabled = !pageHasPrev;
      nextBtn.disabled = !pageHasMore;
      refreshBtn.disabled = false;
      if (rows.size > 0 && firstRef && lastRef) {
        let text = formatTimeRange(firstRef, lastRef);
        if (!pageHasPrev && !pageHasMore) text += " (all)";
        else if (!pageHasPrev) text += " (start)";
        else if (!pageHasMore) text += " (end)";
        pageInfo.textContent = text;
      } else {
        pageInfo.textContent = "No data";
      }
      liveBtn.classList.remove("active");
      liveBtn.classList.remove("disconnected");
    }
  }

  if (isPaged) {
    prevBtn.addEventListener("click", () => {
      if (!pageHasPrev) return;
      if (liveMode) { fetchPrevLive(); return; }
      fetchPage(firstRef, true);
    });
    nextBtn.addEventListener("click", () => {
      if (pageHasMore) fetchPage(lastRef);
    });
    liveBtn.addEventListener("click", () => liveMode ? exitLive() : goLive());
    refreshBtn.addEventListener("click", () => {
      if (!liveMode) fetchPage(pageLoadRef, pageLoadBefore);
    });
  }

  /* ── Visibility-aware sub/unsub ─────────────────────────────────── */

  let hideTimer = null;
  const HIDE_TIMEOUT = 5 * 60 * 1000;

  // Default filters from config, before any data (and before the observer
  // can subscribe): the header, if already rendered, shows them as active.
  loadFilterSpecs(spec.filters);
  loadSortSpec(spec.sort);
  updateHeaderState();
  syncPresetTimer();

  const paneEl = host.closest("mkui-pane");
  if (paneEl) {
    // Edit hook: the workspace routes Ctrl/Cmd+C, Ctrl/Cmd+A, Ctrl/Cmd+F,
    // Escape, and the edit.* menu actions to the focused frame's active
    // pane. Escape clears the selection first, then closes the find strip.
    paneEl._editActions = {
      copy: () => copySelection(),
      selectAll: () => { selectAllRows(); return true; },
      clearSelection: () => clearSelectionKeepFocus() || closeFind(),
      find: () => { openFind(); return true; },
    };
    // Filter hook: `workspace.setPaneFilters` / `getPaneFilters` and the
    // `table.filter` action reach the column filters through it.
    paneEl._filters = { set: setFilters, get: getFilters };
    // Sort hook: `workspace.setPaneSort` / `getPaneSort` and `table.sort`.
    paneEl._sort = { set: setSort, get: getSort };
    // Columns hook: `workspace.setPaneColumns` / `getPaneColumns` and
    // `table.columns` set which columns show.
    paneEl._columns = { set: setVisible, get: getVisible };
    // Tree hook (tree tables only): `workspace.expandPane` and
    // `table.expand` open rows to a depth (a number, or "all"; 0 closes
    // every row); `toggle(key)` flips one row by its identity.
    if (tree) {
      paneEl._tree = {
        expand: (depth) => setExpandDepth(depth === "all" ? Infinity : Math.max(0, Number(depth) || 0)),
        toggle: (key, on) => setExpanded(key, on ?? !expanded.has(key)),
        expanded: () => [...expanded].filter(hasKids),
      };
    }
    paneEl.addEventListener("mkui-pane-close", () => {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
      if (presetTimer) { clearTimeout(presetTimer); presetTimer = null; }
      closed = true;
      closeDropdown();
      closePicker();
      closeFind();
      io.disconnect();
      ro.disconnect();
      subscribed = false;
      pageFetchPending = false;
      client.unsubscribe(subid);
      client.unsubscribe(pageSubId);
      // Nothing is selected in a closed table, so followers stop showing
      // a row the user can no longer see.
      publishRow(null);
    });
    paneEl.addEventListener("mkui-pane-open", () => {
      closed = false;
      subscribed = false;
      lastRef = null;
      clearData();
      closeDropdown();
      closePicker();
      closeFind();
      columns = spec.columns ?? null;
      loadVisibleSpec(spec.visible);
      loadSortSpec(spec.sort);
      loadFilterSpecs(spec.filters);
      resetColWidths();
      // A configured header re-renders for the configured column set (an
      // inferred one waits for data, as at first open).
      if (columns) renderHead(); else updateHeaderState();
      syncPresetTimer();
      clearSelection();
      if (isPaged) {
        liveMode = false;
        savedPageState = null;
        pageFetchPending = false;
        hasEarlierPages = false;
        pageHasMore = false;
        pageHasPrev = false;
        firstRef = null;
        pageLoadRef = getStartRef();
        pageLoadBefore = false;
        prevPageLoadRef = null;
        prevPageLoadBefore = false;
        autoLivePending = startLive;
      }
      io.observe(host);
      ro.observe(scrollHost);
    });
  }

  const io = new IntersectionObserver((entries) => {
    const visible = entries[0].intersectionRatio > 0;
    if (visible) {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
      maybeInitWidths(); // header wasn't measurable while hidden
      render(); // viewport may have appeared/changed while hidden
      if (isPaged && !liveMode) {
        if (!subscribed) fetchPage(pageLoadRef, pageLoadBefore);
      } else {
        sub();
      }
    } else {
      closeDropdown();
      if (subscribed) {
        hideTimer = setTimeout(() => {
          hideTimer = null;
          unsub();
        }, HIDE_TIMEOUT);
      }
    }
  });
  io.observe(host);

  // Re-slice when the pane is resized: the visible row window changes but
  // no data does, so this is O(visible rows).
  const ro = new ResizeObserver(() => render());
  ro.observe(scrollHost);
});
