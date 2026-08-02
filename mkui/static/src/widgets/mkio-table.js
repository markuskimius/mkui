import { registerPaneType } from "../core.js";
import { ensureMkio } from "../mkio-bridge.js";
import { resolveExpr, resolveObject } from "../lib/expressions.js";
import { icon } from "../lib/icons.js";
import { gridToTSV, gridToHTML } from "../lib/copy.js";

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

  let scrollHost = host;
  let pagingToolbar = null;
  let prevBtn = null, nextBtn = null, pageInfo = null, liveBtn = null, refreshBtn = null;

  if (isPaged) {
    host.style.overflow = "hidden";
    host.style.padding = "0";
    host.style.display = "flex";
    host.style.flexDirection = "column";

    const scrollArea = document.createElement("div");
    scrollArea.className = "mkui-table-scroll";
    scrollArea.appendChild(table);
    scrollHost = scrollArea;

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

    host.append(scrollArea, pagingToolbar);
  } else {
    host.appendChild(table);
  }

  const progress = document.createElement("div");
  progress.className = "mkui-table-progress";
  progress.style.display = "none";
  if (!isPaged) host.appendChild(progress);

  /* ── Toolbar (buttons) ──────────────────────────────────────────── */

  const hasButtons = Array.isArray(spec.buttons) && spec.buttons.length > 0;
  let toolbar = null;
  const buttonEls = [];

  if (hasButtons && !isPaged) {
    host.style.overflow = "hidden";
    host.style.padding = "0";
    host.style.display = "flex";
    host.style.flexDirection = "column";

    const scrollArea = document.createElement("div");
    scrollArea.className = "mkui-table-scroll";
    host.removeChild(table);
    scrollArea.appendChild(table);
    if (!isPaged) host.removeChild(progress);
    scrollHost = scrollArea;
    host.appendChild(scrollArea);
    if (!isPaged) host.appendChild(progress);
  }

  if (hasButtons) {
    toolbar = document.createElement("div");
    toolbar.className = "mkui-table-toolbar";
    for (const btnSpec of spec.buttons) {
      const btn = document.createElement("button");
      btn.className = "mkui-btn mkui-toolbar-btn";
      btn.textContent = btnSpec.label ?? "Button";
      btn.disabled = true;
      btn.addEventListener("click", () => handleButtonClick(btnSpec));
      toolbar.appendChild(btn);
      buttonEls.push({ el: btn, spec: btnSpec });
    }
    host.insertBefore(toolbar, host.firstChild);
  }

  const rows = new Map();          // key -> row, all data
  const rowEls = new Map();        // key -> tr, rendered slice only
  let baseOrder = [];              // keys in display (insertion) order
  let view = [];                   // keys filtered + sorted, drives rendering
  let viewDirty = false;           // view needs a full rebuild from baseOrder
  let viewRev = 0;                 // bumped on any change that affects the view
  let columns = spec.columns ?? null;
  let displayOrder = null;
  const colWidths = new Map();
  let widthsInited = false;
  let widthsDirty = false;     // a ratchet grew a column — colgroup refresh pending
  const userSized = new Set(); // manually resized columns: auto-grow keeps hands off
  let rowNumDigits = 2;        // row-number column width follows the digit count
  const MIN_COL_W = 40;
  const CELL_CHROME = 17;      // 8px cell padding each side + 1px divider (mkui.css)
  const labels = spec.labels ?? {};
  const label = (col) => labels[col] ?? col;
  const visibleColumns = () =>
    displayOrder || columns.filter((c) => !c.startsWith("_mkio_"));

  /* ── Numeric column alignment ─────────────────────────────────────── */

  // Columns whose every non-empty value is numeric are right-aligned with
  // per-cell right padding so decimal points line up down the column. The
  // pad is (column's widest fraction - this cell's fraction) in ch, which
  // is exact in the table's monospace font. maxFrac is a one-way ratchet
  // (deletes don't shrink it), reset when the data is cleared.
  const colStats = new Map(); // col -> { numeric, maxFrac, maxIntW, maxTextW }

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

  function bumpStats(row) {
    const canMeasure = ensureMeasureCtx();
    for (const k in row) {
      if (k.startsWith("_mkio_")) continue;
      const v = row[k];
      if (v == null || v === "") continue;
      let st = colStats.get(k);
      if (!st) { st = { numeric: true, maxFrac: 0, maxIntW: 0, maxTextW: 0 }; colStats.set(k, st); }
      const s = String(v);
      let grew = false;
      if (st.numeric) {
        let changed = false;
        if (isNaN(Number(s))) {
          st.numeric = false;
          changed = true;
        } else {
          const f = fracLen(s);
          if (f > st.maxFrac) { st.maxFrac = f; changed = grew = true; }
        }
        if (changed) restyleColumn(k);
      }
      if (!canMeasure) continue;
      // Width ratchet: numeric strings are ASCII, exactly 1ch per char in
      // the mono table font; text is canvas-measured, skipped when even at
      // 2ch per char (fullwidth glyphs) it can't beat the current max.
      let w;
      if (st.numeric) w = s.length * chW;
      else if (2 * s.length * chW <= st.maxTextW) w = 0;
      else w = measureCtx.measureText(s).width;
      if (w > st.maxTextW) { st.maxTextW = w; grew = true; }
      if (st.numeric) {
        const iw = w - fracLen(s) * chW; // width of the integer part
        if (iw > st.maxIntW) { st.maxIntW = iw; grew = true; }
      }
      if (grew) growColWidth(k, st);
    }
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
    for (const key of baseOrder) {
      const r = rows.get(key);
      if (r && matchesFilters(r)) view.push(key);
    }
    if (sortKeys.length) view.sort((a, b) => compareRows(rows.get(a), rows.get(b)));
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
    if (!sortKeys.length) return view.indexOf(key);
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

  // Data-level insert; the DOM row appears via render().
  function insertRow(row) {
    bumpStats(row);
    const key = row[idKey];
    rows.set(key, row);
    baseOrder.push(key);
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
    if (rowColumn) {
      const d = String(Math.max(1, view.length)).length;
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
        const num = String(i + 1);
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
  const filters = new Map();
  let dropdown = null;
  let dropdownCol = null;
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
    if (th?.getBoundingClientRect && scrollHost.getBoundingClientRect) {
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
    render();
  }

  function onTableKeyDown(e) {
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (!columns || !view.length) return;
    const meta = e.ctrlKey || e.metaKey;
    const cols = visibleColumns();

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

  /* ── Clipboard copy ───────────────────────────────────────────────── */

  // Rows selected → rows × all visible columns, plus a label header row.
  // Cells selected → the bounding grid of selected rows × selected
  // columns, blanks for cells outside every rect. Neither → the focused
  // cell. Only view (filtered) rows are ever copied.
  function buildCopyGrid() {
    if (!columns) return null;
    const cols = visibleColumns();
    const cellVal = (row, c) => {
      const v = row?.[c];
      return v == null ? "" : String(v);
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
    let matRows = null; // materialized lazily, only for rowMatch
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
      if (ok && en.rowMatch) {
        if (count === 0) ok = false;
        else {
          matRows ??= getSelectedRows();
          for (const [field, expected] of Object.entries(en.rowMatch)) {
            const vals = Array.isArray(expected) ? expected : [expected];
            if (!matRows.every((r) => vals.includes(r[field] == null ? "" : String(r[field])))) {
              ok = false;
              break;
            }
          }
        }
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
    if (dropdown) { dropdown.remove(); dropdown = null; dropdownCol = null; }
    if (dropdownCleanup) { dropdownCleanup(); dropdownCleanup = null; }
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
      const cmp = compareValues(a[col], b[col]);
      if (cmp !== 0) return dir === "desc" ? -cmp : cmp;
    }
    return 0;
  }

  function matchesFilters(row) {
    for (const [col, allowed] of filters) {
      if (!allowed) continue;
      const v = row[col] == null ? "" : String(row[col]);
      if (!allowed.has(v)) return false;
    }
    return true;
  }

  function applyVisibility() {
    markViewDirty();
    // Selection follows visibility: filtered-out rows drop from the row
    // selection so counts, copies, and actions only ever see view rows.
    if (selectedKeys.size) {
      for (const key of [...selectedKeys]) {
        const r = rows.get(key);
        if (!r || !matchesFilters(r)) selectedKeys.delete(key);
      }
    }
    render();
    if (hasButtons) updateButtonStates();
  }

  function reorder() { markViewDirty(); render(); }

  function resetOrder() { markViewDirty(); render(); }

  function getUniqueValues(col) {
    const s = new Set();
    for (const r of rows.values()) s.add(r[col] == null ? "" : String(r[col]));
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
  // capped at half the pane. The colgroup refresh is deferred to the next
  // render() so a snapshot chunk costs one refresh, not one per row.
  function growColWidth(col, st) {
    if (userSized.has(col)) return;
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
        measured = true;
      }
    }
    if (!measured) { table.style.width = prevWidth; return; } // pane hidden — retry later
    widthsInited = true;
    renderColgroup();
  }

  function resetColWidths() {
    colWidths.clear();
    userSized.clear();
    widthsInited = false;
    widthsDirty = false;
    colgroup.innerHTML = "";
    table.classList.remove("mkui-table-fixed");
    table.style.width = "";
  }

  function initColResize(col, e) {
    closeDropdown();
    // Sync stored widths to what's actually rendered, so the drag starts
    // from the on-screen width (a drag may precede the first measurement,
    // where columns are still auto-laid-out).
    for (const th of thead.querySelectorAll("th")) {
      if (!th.dataset.col) continue; // filler cell
      const w = th.getBoundingClientRect().width;
      if (w > 0) colWidths.set(th.dataset.col, w);
    }
    widthsInited = true;
    renderColgroup();

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
        if (e.target.closest(".mkui-filter-btn")) return;
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
        updateHeaderState();
        if (sortKeys.length) reorder(); else resetOrder();
      });

      filterBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (dropdownCol === c) { closeDropdown(); return; }
        openFilterDropdown(c, th);
      });

      th.addEventListener("pointerdown", (e) => {
        if (e.target.closest(".mkui-filter-btn")) return;
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
      btn.classList.toggle("active", filters.has(col));
    }
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
    displayOrder = order;
    renderHead();
    rebuildAllRows();
    updateHeaderState();
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

  function openFilterDropdown(col, thEl) {
    closeDropdown();
    dropdownCol = col;

    const rect = thEl.getBoundingClientRect();
    const dd = document.createElement("div");
    dd.className = "mkui-filter-dropdown";
    dd.style.position = "fixed";
    dd.style.zIndex = "10001";

    let left = rect.right - 200;
    if (left < 4) left = 4;
    if (left + 200 > window.innerWidth) left = Math.max(4, window.innerWidth - 204);
    dd.style.left = left + "px";
    dd.style.top = (rect.bottom + 1) + "px";

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
    const cur = filters.get(col);
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
      cb.checked = !cur || cur.has(v);
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
      cb.addEventListener("change", commit);
    }
    dd.appendChild(list);

    function commit() {
      const checked = cbs.filter((c) => c.checked).map((c) => c.dataset.val);
      if (checked.length === vals.length) filters.delete(col);
      else filters.set(col, new Set(checked));
      updateHeaderState();
      applyVisibility();
    }

    selAll.addEventListener("click", () => {
      for (const c of cbs) c.checked = true;
      commit();
    });
    clrAll.addEventListener("click", () => {
      for (const c of cbs) c.checked = false;
      commit();
    });

    search.addEventListener("input", () => {
      const q = search.value.toLowerCase();
      for (const c of cbs)
        c.parentElement.style.display =
          c.dataset.val.toLowerCase().includes(q) ? "" : "none";
    });

    dd.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { closeDropdown(); e.stopPropagation(); }
    });

    host.appendChild(dd);
    dropdown = dd;
    search.focus();

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
    for (const c of visibleColumns()) {
      const td = document.createElement("td");
      td.dataset.col = c;
      const v = row[c];
      td.textContent = v == null ? "" : String(v);
      styleCell(td, c);
      tr.appendChild(td);
    }
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
      columns = Object.keys(snap[0]);
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
        else insertRow(row);
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
      columns = Object.keys(row);
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
    const vi = viewIndexOf(prev ?? row);
    if (vi >= 0) view.splice(vi, 1);
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
      const newVal = row[c] == null ? "" : String(row[c]);
      const oldVal = prev[c] == null ? "" : String(prev[c]);
      if (newVal !== oldVal) {
        changed.push([c, newVal]);
        if (sortKeys.some((k) => k.col === c)) sortChanged = true;
      }
    }
    const wasVis = matchesFilters(prev);
    const isVis = matchesFilters(row);
    if (sortChanged || wasVis !== isVis) {
      // Reposition: remove at the old view slot (found via prev, still in
      // rows), then re-insert at the slot the new values sort into.
      if (wasVis) {
        const vi = viewIndexOf(prev);
        if (vi >= 0) view.splice(vi, 1);
      }
      rows.set(key, row);
      if (isVis) view.splice(viewInsertPos(row), 0, key);
      viewRev++;
      render();
    } else {
      rows.set(key, row);
    }
    const tr = rowEls.get(key);
    if (tr) {
      for (const [c, newVal] of changed) {
        const td = tr.querySelector(`td[data-col="${CSS.escape(c)}"]`);
        if (td) {
          td.textContent = newVal;
          styleCell(td, c);
          flash(td, "mkui-flash-update");
        }
      }
    }
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
      applySnapshot(snap);
      if (protocol === "stream" && snap.length > 0) {
        const ref = snap[snap.length - 1]._mkio_ref;
        if (ref) lastRef = ref;
      }
    },
    onDelta: (changes) => {
      for (const ch of changes) {
        if (ch.op === "insert") applyInsert(ch.row);
        else if (ch.op === "delete") applyDelete(ch.row);
        else applyReplace(ch.row);
      }
      if (protocol === "stream" && changes.length > 0) {
        const ref = changes[changes.length - 1].row._mkio_ref;
        if (ref) lastRef = ref;
      }
      maybeRestoreScroll();
    },
    onUpdate: (op, row) => {
      if (op === "insert") applyInsert(row);
      else if (op === "delete") applyDelete(row);
      else applyReplace(row);
      if (protocol === "stream" && row._mkio_ref) lastRef = row._mkio_ref;
      maybeRestoreScroll();
    },
  };

  const subid = `mkui-table-${++_subCounter}`;
  const pageSubId = subid + "-page";
  let subscribed = false;
  let closed = false;
  let liveMode = !isPaged;

  let savedScrollTop = 0;
  let restoreScrollTarget = 0;

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
          if (!columns) { columns = Object.keys(pageRows[0]); renderHead(); }
          maybeInitWidths(); // lock header widths before rows render
          for (const row of pageRows) insertRow(row);
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
      },
    };
    if (before) opts.before = true;
    client.subscribe(spec.service, "stream", opts);
  }

  function goLive() {
    savedPageState = { pageLoadRef, pageLoadBefore };
    liveMode = true;
    hasEarlierPages = false;
    unsub();
    sub();
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
          if (!columns) { columns = Object.keys(pageRows[0]); renderHead(); }
          maybeInitWidths(); // lock header widths before rows render
          // Prepend the earlier page in display order without disturbing
          // the live rows below it.
          const keys = [];
          for (const row of pageRows) {
            bumpStats(row);
            const key = row[idKey];
            if (!rows.has(key)) keys.push(key);
            rows.set(key, row);
          }
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

  const paneEl = host.closest("mkui-pane");
  if (paneEl) {
    // Edit hook: the workspace routes Ctrl/Cmd+C, Ctrl/Cmd+A, Escape, and
    // the edit.* menu actions to the focused frame's active pane.
    paneEl._editActions = {
      copy: () => copySelection(),
      selectAll: () => { selectAllRows(); return true; },
      clearSelection: () => clearSelectionKeepFocus(),
    };
    paneEl.addEventListener("mkui-pane-close", () => {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
      closed = true;
      io.disconnect();
      ro.disconnect();
      subscribed = false;
      pageFetchPending = false;
      client.unsubscribe(subid);
      client.unsubscribe(pageSubId);
    });
    paneEl.addEventListener("mkui-pane-open", () => {
      closed = false;
      subscribed = false;
      lastRef = null;
      clearData();
      columns = spec.columns ?? null;
      displayOrder = null;
      sortKeys.length = 0;
      filters.clear();
      resetColWidths();
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
