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
  const visibleColumns = () => columns.filter((c) => !c.startsWith("_mkio_"));

  function renderHead() {
    thead.innerHTML = "";
    const tr = document.createElement("tr");
    for (const c of visibleColumns()) {
      const th = document.createElement("th");
      th.textContent = c;
      tr.appendChild(th);
    }
    thead.appendChild(tr);
  }

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
    tbody.appendChild(tr);
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
    maybeRestoreScroll();
  }

  function applyInsert(row) {
    if (!columns) {
      columns = Object.keys(row);
      renderHead();
    }
    const tr = insertRow(row);
    flash(tr, "mkui-flash-in");
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
    for (const c of visibleColumns()) {
      const newVal = row[c] == null ? "" : String(row[c]);
      const oldVal = prev?.[c] == null ? "" : String(prev[c]);
      if (newVal !== oldVal) {
        const td = tr.querySelector(`td[data-col="${CSS.escape(c)}"]`);
        if (td) {
          td.textContent = newVal;
          flash(td, "mkui-flash-update");
        }
      }
    }
  }

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
    if (visible) sub(); else unsub();
  });
  io.observe(host);
});
