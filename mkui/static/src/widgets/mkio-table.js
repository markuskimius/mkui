import { registerPaneType } from "../core.js";
import { ensureMkio } from "../mkio-bridge.js";

let _subCounter = 0;

registerPaneType("mkio-table", async (spec, app, host) => {
  const wsUrl = app.config?.mkio?.url;
  if (!wsUrl) {
    host.textContent = "[mkio-table] no mkio.url configured";
    return;
  }

  const protocol = spec.protocol ?? "query";
  const idKey = protocol === "subpub" ? "_mkio_topic" : "_mkio_row";

  const table = document.createElement("table");
  table.className = "mkui-table";
  const thead = document.createElement("thead");
  const tbody = document.createElement("tbody");
  table.append(thead, tbody);
  host.appendChild(table);

  const rows = new Map();
  const rowEls = new Map();
  let columns = spec.columns ?? null;
  let displayOrder = null;
  const visibleColumns = () =>
    displayOrder || columns.filter((c) => !c.startsWith("_mkio_"));

  /* ── Sort & filter state ──────────────────────────────────────────── */

  const sortKeys = [];
  const filters = new Map();
  let dropdown = null;
  let dropdownCol = null;
  let dropdownCleanup = null;
  let suppressClick = false;

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

      th.append(filterBtn, document.createTextNode(c), sortInd);

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
        ghost.textContent = visibleColumns()[fromIdx];
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

  /* ── Row building ─────────────────────────────────────────────────── */

  function buildRow(row) {
    const tr = document.createElement("tr");
    tr.dataset.ref = row[idKey];
    for (const c of visibleColumns()) {
      const td = document.createElement("td");
      td.dataset.col = c;
      const v = row[c];
      td.textContent = v == null ? "" : String(v);
      tr.appendChild(td);
    }
    return tr;
  }

  function flash(el, cls) {
    el.classList.remove("mkui-flash-in", "mkui-flash-out", "mkui-flash-update");
    void el.offsetWidth;
    el.classList.add(cls);
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

  function applySnapshot(snap) {
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

  const callbacks = {
    onSnapshot: (snap) => applySnapshot(snap),
    onDelta: (changes) => {
      for (const ch of changes) {
        if (ch.op === "insert") applyInsert(ch.row);
        else if (ch.op === "delete") applyDelete(ch.row);
        else applyReplace(ch.row);
      }
      maybeRestoreScroll();
    },
    onUpdate: (op, row) => {
      if (op === "insert") applyInsert(row);
      else if (op === "delete") applyDelete(row);
      else applyReplace(row);
      maybeRestoreScroll();
    },
  };

  const subid = `mkui-table-${++_subCounter}`;
  let subscribed = false;
  let savedScrollTop = 0;
  let restoreScrollTarget = 0;

  host.addEventListener("scroll", () => { savedScrollTop = host.scrollTop; });

  function maybeRestoreScroll() {
    if (!restoreScrollTarget) return;
    const target = restoreScrollTarget;
    restoreScrollTarget = 0;
    requestAnimationFrame(() => { host.scrollTop = target; });
  }

  function sub() {
    if (subscribed) return;
    subscribed = true;
    restoreScrollTarget = savedScrollTop;
    rows.clear();
    rowEls.clear();
    tbody.innerHTML = "";
    client.subscribe(spec.service, protocol, {
      subid,
      topic: spec.topic,
      filter: spec.filter,
      ...callbacks,
    });
  }

  function unsub() {
    if (!subscribed) return;
    subscribed = false;
    client.unsubscribe(subid);
  }

  const io = new IntersectionObserver((entries) => {
    const visible = entries[0].intersectionRatio > 0;
    if (visible) sub(); else { closeDropdown(); unsub(); }
  });
  io.observe(host);
});
