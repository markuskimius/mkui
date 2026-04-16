import { registerPaneType } from "../core.js";
import { ensureMkio } from "../mkio-bridge.js";

// A built-in pane type that subscribes to an mkio subpub service and
// renders rows as a table. Config (under [panes.<id>] in the app config):
//
//   type    = "mkio-table"
//   service = "all_orders"
//   filter  = "status == 'pending'"   # optional
//   columns = ["id", "symbol", "qty", "price"]   # optional; defaults to row keys
registerPaneType("mkio-table", async (spec, app, host) => {
  const wsUrl = app.config?.mkio?.url;
  if (!wsUrl) {
    host.textContent = "[mkio-table] no [mkio.url] configured";
    return;
  }

  const table = document.createElement("table");
  table.className = "mkui-table";
  const thead = document.createElement("thead");
  const tbody = document.createElement("tbody");
  table.appendChild(thead);
  table.appendChild(tbody);
  host.appendChild(table);

  const rows = new Map();
  let columns = spec.columns ?? null;

  function renderHead() {
    thead.innerHTML = "";
    const tr = document.createElement("tr");
    for (const c of columns) {
      const th = document.createElement("th");
      th.textContent = c;
      tr.appendChild(th);
    }
    thead.appendChild(tr);
  }

  function renderBody() {
    tbody.innerHTML = "";
    for (const row of rows.values()) {
      const tr = document.createElement("tr");
      for (const c of columns) {
        const td = document.createElement("td");
        const v = row[c];
        td.textContent = v == null ? "" : String(v);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
  }

  let client;
  try {
    client = await ensureMkio(wsUrl);
  } catch (e) {
    host.textContent = "[mkio-table] " + e.message;
    return;
  }

  const idKey = spec.idKey ?? "id";
  client.subscribe(spec.service, {
    filter: spec.filter,
    onSnapshot: (snap) => {
      rows.clear();
      for (const row of snap) rows.set(row[idKey], row);
      if (!columns && snap.length > 0) columns = Object.keys(snap[0]);
      if (columns) { renderHead(); renderBody(); }
    },
    onUpdate: (op, row) => {
      if (op === "delete") rows.delete(row[idKey]);
      else rows.set(row[idKey], row);
      renderBody();
    },
  });
});
