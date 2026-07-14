import { registerPaneType } from "../core.js";
import { ensureMkio } from "../mkio-bridge.js";
import { resolveExpr, resolveObject } from "../lib/expressions.js";
import { icon } from "../lib/icons.js";

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
  const MIN_COL_W = 40;
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
  const colStats = new Map(); // col -> { numeric, maxFrac }

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
    for (const k in row) {
      if (k.startsWith("_mkio_")) continue;
      const v = row[k];
      if (v == null || v === "") continue;
      let st = colStats.get(k);
      if (!st) { st = { numeric: true, maxFrac: 0 }; colStats.set(k, st); }
      if (!st.numeric) continue;
      const s = String(v);
      let changed = false;
      if (isNaN(Number(s))) {
        st.numeric = false;
        changed = true;
      } else {
        const f = fracLen(s);
        if (f > st.maxFrac) { st.maxFrac = f; changed = true; }
      }
      if (changed) restyleColumn(k);
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
    }
    if (rowEls.size > end - start) {
      const want = new Set();
      for (let i = start; i < end; i++) want.add(view[i]);
      for (const [key, tr] of rowEls) {
        if (!want.has(key)) { tr.remove(); rowEls.delete(key); }
      }
    }

    if (!rowHMeasured && end > start) {
      const h = rowEls.get(view[start])?.getBoundingClientRect().height;
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

  const selectedKeys = new Set();
  let selectedAnchor = null;

  function getSelectedRows() {
    const out = [];
    for (const key of selectedKeys) {
      const row = rows.get(key);
      if (row) out.push(row);
    }
    return out;
  }

  function setRowSelected(key, selected) {
    if (selected) selectedKeys.add(key);
    else selectedKeys.delete(key);
    const tr = rowEls.get(key);
    if (tr) tr.classList.toggle("mkui-selected", selected);
  }

  function clearSelection() {
    for (const key of selectedKeys) {
      const tr = rowEls.get(key);
      if (tr) tr.classList.remove("mkui-selected");
    }
    selectedKeys.clear();
  }

  function handleRowClick(key, e) {
    if (e.target.closest(".mkui-filter-btn")) return;
    const metaKey = e.ctrlKey || e.metaKey;
    if (e.shiftKey && selectedAnchor != null) {
      const anchorIdx = view.indexOf(selectedAnchor);
      const targetIdx = view.indexOf(key);
      if (anchorIdx >= 0 && targetIdx >= 0) {
        if (!metaKey) clearSelection();
        const lo = Math.min(anchorIdx, targetIdx);
        const hi = Math.max(anchorIdx, targetIdx);
        for (let i = lo; i <= hi; i++) setRowSelected(view[i], true);
      }
    } else if (metaKey) {
      setRowSelected(key, !selectedKeys.has(key));
      selectedAnchor = key;
    } else {
      clearSelection();
      setRowSelected(key, true);
      selectedAnchor = key;
    }
    updateButtonStates();
  }

  /* ── Button enablement & click ────────────────────────────────────── */

  let mkioConnected = false;

  function updateButtonStates() {
    const selected = getSelectedRows();
    const count = selected.length;
    for (const { el, spec: bs } of buttonEls) {
      const en = bs.enable ?? {};
      let ok = true;
      if (en.connected && !mkioConnected) ok = false;
      if (ok && en.minSelected != null && count < en.minSelected) ok = false;
      if (ok && en.maxSelected != null && count > en.maxSelected) ok = false;
      if (ok && en.rowMatch && count > 0) {
        for (const [field, expected] of Object.entries(en.rowMatch)) {
          const vals = Array.isArray(expected) ? expected : [expected];
          if (!selected.every((r) => vals.includes(r[field] == null ? "" : String(r[field])))) {
            ok = false;
            break;
          }
        }
      }
      if (ok && en.rowMatch && count === 0) ok = false;
      el.disabled = !ok;
    }
  }

  async function handleButtonClick(btnSpec) {
    const action = btnSpec.action;
    if (!action) return;
    const selected = getSelectedRows();
    const first = selected[0] ?? {};
    const ctx = { row: first, rows: selected, selection: { count: selected.length }, state: app.state.get() };

    if (action.type === "transaction") {
      for (const row of selected) {
        const rowCtx = { ...ctx, row };
        const data = resolveObject(action.data ?? {}, rowCtx);
        client.send(action.service, data, { op: action.op });
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

  const SUPER = "¹²³⁴⁵⁶⁷⁸⁹";

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

  function applyVisibility() { markViewDirty(); render(); }

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
  // column and overflowing cell text is clipped with an ellipsis.

  function renderColgroup() {
    colgroup.innerHTML = "";
    if (!widthsInited || !columns) {
      table.classList.remove("mkui-table-fixed");
      table.style.width = "";
      return;
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

  // Default width = the column's natural width from the initial snapshot
  // (auto layout puts the widest cell's width on the th), capped at half
  // the pane's visible width. Runs once, on the first data that renders.
  function maybeInitWidths() {
    if (widthsInited || rows.size === 0) return;
    const ths = thead.querySelectorAll("th");
    if (!ths.length) return;
    const hostW = scrollHost.clientWidth || window.innerWidth || 0;
    const maxW = hostW > 0 ? Math.max(MIN_COL_W, hostW / 2) : Infinity;
    // Measure natural content widths — max-content overrides the default
    // width:100% so columns aren't stretched to fill the pane first.
    const prevWidth = table.style.width;
    table.style.width = "max-content";
    let measured = false;
    for (const th of ths) {
      if (!th.dataset.col) continue; // filler cell
      const w = th.getBoundingClientRect().width;
      if (w > 0) {
        colWidths.set(th.dataset.col, Math.min(Math.max(w, MIN_COL_W), maxW));
        measured = true;
      }
    }
    if (!measured) { table.style.width = prevWidth; return; } // pane hidden — retry on next data
    widthsInited = true;
    renderColgroup();
  }

  function resetColWidths() {
    colWidths.clear();
    widthsInited = false;
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
    for (let vi = 0; vi < visCols.length; vi++) {
      const c = visCols[vi];
      const th = document.createElement("th");
      th.dataset.col = c;

      const filterBtn = document.createElement("span");
      filterBtn.className = "mkui-filter-btn";
      filterBtn.appendChild(icon("filter"));

      const sortInd = document.createElement("span");
      sortInd.className = "mkui-sort-indicator";

      const labelEl = document.createElement("span");
      labelEl.className = "mkui-th-label";
      labelEl.textContent = label(c);

      const inner = document.createElement("div");
      inner.className = "mkui-th-inner";
      inner.append(labelEl, sortInd, filterBtn);
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
    topSpacerTd.colSpan = visCols.length + 1;
    botSpacerTd.colSpan = visCols.length + 1;
    renderColgroup();
  }

  function updateHeaderState() {
    for (const th of thead.querySelectorAll("th")) {
      const col = th.dataset.col;
      if (!col) continue; // filler cell
      const ind = th.querySelector(".mkui-sort-indicator");
      const si = sortKeys.findIndex((k) => k.col === col);
      ind.textContent = "";
      if (si >= 0) {
        ind.appendChild(icon(sortKeys[si].dir === "asc" ? "caret-up" : "caret-down"));
        if (sortKeys.length > 1) ind.append(SUPER[si] || String(si + 1));
      }
      const btn = th.querySelector(".mkui-filter-btn");
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

      const ths = thead.querySelectorAll("th");
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
    for (const c of visibleColumns()) {
      const td = document.createElement("td");
      td.dataset.col = c;
      const v = row[c];
      td.textContent = v == null ? "" : String(v);
      styleCell(td, c);
      tr.appendChild(td);
    }
    if (selectedKeys.has(key)) tr.classList.add("mkui-selected");
    tr.addEventListener("click", (e) => handleRowClick(key, e));
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
      maybeInitWidths();
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
        maybeInitWidths();
      }
    }
    renderChunk();
  }

  function applyInsert(row) {
    if (!columns) {
      columns = Object.keys(row);
      renderHead();
    }
    insertRow(row);
    render();
    const tr = rowEls.get(row[idKey]);
    if (tr) flash(tr, "mkui-flash-in");
    maybeInitWidths();
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
          for (const row of pageRows) insertRow(row);
          render();
          firstRef = pageRows[0]._mkio_ref;
          lastRef = pageRows[pageRows.length - 1]._mkio_ref;
          maybeInitWidths();
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
          maybeInitWidths();
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
