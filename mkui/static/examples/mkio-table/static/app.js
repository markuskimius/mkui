// Example extensions. Both are plain registrations against the built-in
// mkio-table — neither requires writing a custom table.
//
// Importing mkui here (rather than from a second <script> tag) guarantees
// the registrations below run before <mkui-app> builds its panes.
import { registerFormatter, registerPaneType } from "/mkui/src/index.js";

// A virtual column: no row carries "notional", so client.toml lists it in
// `columns` explicitly. Formatted values are what the table sorts, filters
// and copies, so notional sorts numerically rather than as text.
registerFormatter("notional", (_value, row) => {
  const n = Number(row.qty) * Number(row.price);
  return Number.isFinite(n) ? n.toFixed(2) : "";
});

// A follower pane: `select = { state = "selected_order" }` on the table
// publishes the current row here, with no wiring between the two panes.
registerPaneType("order-detail", (spec, app, host) => {
  const path = spec.follow ?? "selected_order";
  host.style.padding = "8px";

  app.state.subscribe(path, (row) => {
    host.innerHTML = "";
    if (!row) {
      host.textContent = "Select an order to see its details.";
      return;
    }
    const dl = document.createElement("dl");
    dl.className = "order-detail";
    for (const [k, v] of Object.entries(row)) {
      if (k.startsWith("_mkio_")) continue;
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = String(v);
      dl.append(dt, dd);
    }
    host.appendChild(dl);
  });
});
