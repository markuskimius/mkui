import { registerPaneType } from "../core.js";
import { ensureMkio } from "../mkio-bridge.js";
import { resolveExpr, resolveObject } from "../lib/expressions.js";

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

  const table = document.createElement("table");
  table.className = "mkui-table";
  const thead = document.createElement("thead");
  const tbody = document.createElement("tbody");
  table.append(thead, tbody);

  /* ── DOM structure ───────────────────────────────────────────────── */

  let scrollHost = host;
  let pagingToolbar = null;
  let prevBtn = null, nextBtn = null, pageInfo = null, liveBtn = null;

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
    prevBtn.textContent = "◀ Prev";
    prevBtn.disabled = true;
    pageInfo = document.createElement("span");
    pageInfo.className = "mkui-paging-info";
    nextBtn = document.createElement("button");
    nextBtn.className = "mkui-btn mkui-paging-btn";
    nextBtn.textContent = "Next ▶";
    nextBtn.disabled = true;
    liveBtn = document.createElement("button");
    liveBtn.className = "mkui-btn mkui-paging-live";
    liveBtn.textContent = "● Live";
    pagingToolbar.append(prevBtn, pageInfo, nextBtn, liveBtn);

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

  const rows = new Map();
  const rowEls = new Map();
  let columns = spec.columns ?? null;
  let displayOrder = null;
  const labels = spec.labels ?? {};
  const label = (col) => labels[col] ?? col;
  const visibleColumns = () =>
    displayOrder || columns.filter((c) => !c.startsWith("_mkio_"));

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
      const trList = [...tbody.children].filter((tr) => tr.style.display !== "none");
      const anchorIdx = trList.findIndex((tr) => tr.dataset.ref === String(selectedAnchor));
      const targetIdx = trList.findIndex((tr) => tr.dataset.ref === String(key));
      if (anchorIdx >= 0 && targetIdx >= 0) {
        if (!metaKey) clearSelection();
        const lo = Math.min(anchorIdx, targetIdx);
        const hi = Math.max(anchorIdx, targetIdx);
        for (let i = lo; i <= hi; i++) setRowSelected(trList[i].dataset.ref, true);
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

  function applyVisibility() {
    for (const [key, row] of rows) {
      const tr = rowEls.get(key);
      if (tr) tr.style.display = matchesFilters(row) ? "" : "none";
    }
  }

  function reorder() {
    if (!sortKeys.length) return;
    const sorted = [...rows.values()].sort(compareRows);
    for (const r of sorted) {
      const tr = rowEls.get(r[idKey]);
      if (tr) tbody.appendChild(tr);
    }
  }

  function resetOrder() {
    for (const key of rows.keys()) {
      const tr = rowEls.get(key);
      if (tr) tbody.appendChild(tr);
    }
  }

  function sortedInsertPos(row) {
    if (!sortKeys.length) return -1;
    const ch = tbody.children;
    for (let i = 0; i < ch.length; i++) {
      const other = rows.get(ch[i].dataset.ref);
      if (!other) continue;
      if (compareRows(row, other) < 0) return i;
    }
    return -1;
  }

  function getUniqueValues(col) {
    const s = new Set();
    for (const r of rows.values()) s.add(r[col] == null ? "" : String(r[col]));
    return [...s].sort(compareValues);
  }

  /* ── Header rendering ─────────────────────────────────────────────── */

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
      filterBtn.textContent = "▾";

      const sortInd = document.createElement("span");
      sortInd.className = "mkui-sort-indicator";

      th.append(filterBtn, document.createTextNode(label(c)), sortInd);

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
    thead.appendChild(tr);
  }

  function updateHeaderState() {
    for (const th of thead.querySelectorAll("th")) {
      const col = th.dataset.col;
      const ind = th.querySelector(".mkui-sort-indicator");
      const si = sortKeys.findIndex((k) => k.col === col);
      if (si >= 0) {
        const arrow = sortKeys[si].dir === "asc" ? "▲" : "▼";
        ind.textContent = sortKeys.length > 1
          ? ` ${arrow}${SUPER[si] || si + 1}`
          : ` ${arrow}`;
      } else {
        ind.textContent = "";
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
    for (const [key, row] of rows) {
      const old = rowEls.get(key);
      if (!old) continue;
      const hidden = old.style.display === "none";
      const tr = buildRow(row);
      if (hidden) tr.style.display = "none";
      old.replaceWith(tr);
      rowEls.set(key, tr);
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

    let left = rect.left;
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

    for (const v of vals) {
      const lbl = document.createElement("label");
      lbl.className = "mkui-filter-item";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !cur || cur.has(v);
      cb.dataset.val = v;
      const txt = document.createElement("span");
      txt.textContent = v === "" ? "(empty)" : v;
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

  function insertRow(row) {
    rows.set(row[idKey], row);
    const tr = buildRow(row);
    rowEls.set(row[idKey], tr);
    const idx = sortedInsertPos(row);
    if (idx >= 0) tbody.insertBefore(tr, tbody.children[idx]);
    else tbody.appendChild(tr);
    if (!matchesFilters(row)) tr.style.display = "none";
    return tr;
  }

  /* ── Snapshot rendering (chunked for large datasets) ────────────── */

  let snapshotGen = 0;
  const CHUNK = 100;

  function applySnapshot(snap) {
    const gen = ++snapshotGen;
    if (snap.length <= CHUNK) {
      for (const row of snap) {
        const key = row[idKey];
        if (rows.has(key)) {
          applyReplace(row);
        } else {
          if (!columns) {
            columns = Object.keys(row);
            renderHead();
          }
          insertRow(row);
        }
      }
      if (sortKeys.length) reorder();
      maybeRestoreScroll();
      return;
    }

    let i = 0;
    if (!columns && snap.length > 0) {
      columns = Object.keys(snap[0]);
      renderHead();
    }
    progress.textContent = `Loading 0 / ${snap.length}…`;
    progress.style.display = "";

    function renderChunk() {
      if (gen !== snapshotGen) return;
      const end = Math.min(i + CHUNK, snap.length);
      for (; i < end; i++) {
        const row = snap[i];
        const key = row[idKey];
        if (rows.has(key)) applyReplace(row);
        else insertRow(row);
      }
      if (i < snap.length) {
        progress.textContent = `Loading ${i} / ${snap.length}…`;
        requestAnimationFrame(renderChunk);
      } else {
        progress.style.display = "none";
        if (sortKeys.length) reorder();
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
    const tr = insertRow(row);
    if (matchesFilters(row)) flash(tr, "mkui-flash-in");
  }

  function applyDelete(row) {
    const key = row[idKey];
    rows.delete(key);
    selectedKeys.delete(key);
    const tr = rowEls.get(key);
    if (!tr) return;
    rowEls.delete(key);
    flash(tr, "mkui-flash-out");
    tr.addEventListener("animationend", () => tr.remove(), { once: true });
  }

  function applyReplace(row) {
    const key = row[idKey];
    const prev = rows.get(key);
    rows.set(key, row);
    const tr = rowEls.get(key);
    if (!tr) {
      applyInsert(row);
      return;
    }
    let sortChanged = false;
    for (const c of visibleColumns()) {
      const newVal = row[c] == null ? "" : String(row[c]);
      const oldVal = prev?.[c] == null ? "" : String(prev[c]);
      if (newVal !== oldVal) {
        const td = tr.querySelector(`td[data-col="${CSS.escape(c)}"]`);
        if (td) {
          td.textContent = newVal;
          flash(td, "mkui-flash-update");
        }
        if (sortKeys.some((k) => k.col === c)) sortChanged = true;
      }
    }
    tr.style.display = matchesFilters(row) ? "" : "none";
    if (sortChanged) reorder();
  }

  /* ── Subscription ─────────────────────────────────────────────────── */

  let client;
  try {
    client = await ensureMkio(wsUrl);
  } catch (e) {
    host.textContent = "[mkio-table] " + e.message;
    return;
  }

  if (hasButtons) {
    mkioConnected = !!app.state.get("mkio.connected");
    app.state.subscribe("mkio.connected", (v) => {
      mkioConnected = !!v;
      updateButtonStates();
    });
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

  scrollHost.addEventListener("scroll", () => { savedScrollTop = scrollHost.scrollTop; });

  function maybeRestoreScroll() {
    if (!restoreScrollTarget) return;
    const target = restoreScrollTarget;
    restoreScrollTarget = 0;
    requestAnimationFrame(() => { scrollHost.scrollTop = target; });
  }

  function sub() {
    if (closed || subscribed) return;
    subscribed = true;
    ++snapshotGen;
    const resuming = protocol === "stream" && lastRef;
    if (!resuming) {
      restoreScrollTarget = savedScrollTop;
      rows.clear();
      rowEls.clear();
      tbody.innerHTML = "";
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

  let currentPage = 0;
  let pageHasMore = false;
  let pageHasPrev = false;
  let firstRef = null;
  let pageLoadRef = null;
  let pageLoadBefore = false;
  let savedPageState = null;
  let pageFetchPending = false;

  function fetchPage(ref, before) {
    if (closed) return;
    unsub();
    subscribed = true;
    rows.clear();
    rowEls.clear();
    tbody.innerHTML = "";
    if (ref == null && !before) currentPage = 1;
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
          pageHasPrev = ref != null;
        }
        if (pageRows.length > 0) {
          if (!columns) { columns = Object.keys(pageRows[0]); renderHead(); }
          for (const row of pageRows) insertRow(row);
          if (sortKeys.length) reorder();
          firstRef = pageRows[0]._mkio_ref;
          lastRef = pageRows[pageRows.length - 1]._mkio_ref;
        } else {
          firstRef = null;
        }
        updatePagingUI();
      },
    };
    if (before) opts.before = true;
    client.subscribe(spec.service, "stream", opts);
  }

  function goLive() {
    savedPageState = {
      page: currentPage || 1,
      pageHasMore,
      pageHasPrev,
      firstRef,
      pageLoadRef,
      pageLoadBefore,
      rows: new Map(rows),
    };
    liveMode = true;
    unsub();
    sub();
    updatePagingUI();
  }

  function exitLive() {
    liveMode = false;
    unsub();
    client.unsubscribe(pageSubId);
    pageFetchPending = false;
    rows.clear();
    rowEls.clear();
    tbody.innerHTML = "";
    clearSelection();

    if (savedPageState) {
      currentPage = savedPageState.page;
      pageHasMore = savedPageState.pageHasMore;
      pageHasPrev = savedPageState.pageHasPrev;
      firstRef = savedPageState.firstRef;
      pageLoadRef = savedPageState.pageLoadRef;
      pageLoadBefore = savedPageState.pageLoadBefore;
      for (const [, row] of savedPageState.rows) insertRow(row);
      if (sortKeys.length) reorder();
      const savedRows = [...savedPageState.rows.values()];
      if (savedRows.length > 0) {
        const ref = savedRows[savedRows.length - 1]._mkio_ref;
        if (ref != null) lastRef = ref;
      }
      savedPageState = null;
    } else {
      lastRef = null;
      firstRef = null;
      currentPage = 0;
      pageHasMore = false;
      pageHasPrev = false;
      fetchPage(null);
    }

    updatePagingUI();
  }

  function fetchPrevLive() {
    if (!pageHasPrev || closed || pageFetchPending) return;
    pageFetchPending = true;
    currentPage--;
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
          if (!columns) { columns = Object.keys(pageRows[0]); renderHead(); }
          const frag = document.createDocumentFragment();
          for (const row of pageRows) {
            rows.set(row[idKey], row);
            const tr = buildRow(row);
            rowEls.set(row[idKey], tr);
            if (!matchesFilters(row)) tr.style.display = "none";
            frag.appendChild(tr);
          }
          tbody.insertBefore(frag, tbody.firstChild);
          if (sortKeys.length) reorder();
          firstRef = pageRows[0]._mkio_ref;
        }
        updatePagingUI();
      },
    });
  }

  function updatePagingUI() {
    if (!pagingToolbar) return;
    if (liveMode) {
      const savedPage = savedPageState?.page ?? currentPage;
      prevBtn.disabled = !pageHasPrev || pageFetchPending;
      nextBtn.disabled = true;
      pageInfo.textContent = currentPage < savedPage
        ? `Page ${currentPage} · Live` : "Live";
      liveBtn.classList.add("active");
    } else {
      prevBtn.disabled = !pageHasPrev;
      nextBtn.disabled = !pageHasMore;
      pageInfo.textContent = `Page ${currentPage}`;
      liveBtn.classList.remove("active");
    }
  }

  if (isPaged) {
    prevBtn.addEventListener("click", () => {
      if (!pageHasPrev) return;
      if (liveMode) { fetchPrevLive(); return; }
      currentPage--;
      fetchPage(firstRef, true);
    });
    nextBtn.addEventListener("click", () => {
      if (pageHasMore) { currentPage++; fetchPage(lastRef); }
    });
    liveBtn.addEventListener("click", () => liveMode ? exitLive() : goLive());
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
      subscribed = false;
      pageFetchPending = false;
      client.unsubscribe(subid);
      client.unsubscribe(pageSubId);
    });
    paneEl.addEventListener("mkui-pane-open", () => {
      closed = false;
      subscribed = false;
      lastRef = null;
      rows.clear();
      rowEls.clear();
      tbody.innerHTML = "";
      columns = spec.columns ?? null;
      displayOrder = null;
      sortKeys.length = 0;
      filters.clear();
      clearSelection();
      if (isPaged) {
        liveMode = false;
        savedPageState = null;
        pageFetchPending = false;
        currentPage = 0;
        pageHasMore = false;
        pageHasPrev = false;
        firstRef = null;
        pageLoadRef = null;
        pageLoadBefore = false;
      }
      io.observe(host);
    });
  }

  const io = new IntersectionObserver((entries) => {
    const visible = entries[0].intersectionRatio > 0;
    if (visible) {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
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
});
