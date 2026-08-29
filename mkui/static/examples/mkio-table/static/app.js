// Example extensions. Both are plain registrations against the built-in
// mkio-table — neither requires writing a custom table.
//
// Importing mkui here (rather than from a second <script> tag) guarantees
// the registrations below run before <mkui-app> builds its panes.
import { registerExprFunction, registerPaneType } from "/mkui/src/index.js";

// An application function for the expression language. Anything config can
// express with the standard library needs no code at all (client.toml
// derives "notional" as `qty * price`); this is the escape hatch for logic
// that does. Call it from any expression: values = { spread = "SPREAD_BPS(bid, ask)" }.
registerExprFunction("SPREAD_BPS", (bid, ask) => ((ask - bid) / ask) * 1e4,
  { numeric: true, params: ["bid", "ask"], doc: "Bid/ask spread in basis points" });

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
