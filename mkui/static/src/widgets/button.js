import { registerWidget } from "../core.js";
import { asks, confirmed } from "../lib/dialogs.js";

// Config:
//   { type: "button", label: "Run", action: "thing.do", args: …, confirm: "Run it?" }
registerWidget("button", (spec, app, host) => {
  const btn = document.createElement("button");
  btn.className = "mkui-btn";
  btn.textContent = spec.label ?? "Button";
  // `confirm` asks first, as on a menu item.
  btn.addEventListener("click", async () => {
    if (!spec.action || (asks(spec) && !await confirmed(app, spec))) return;
    app.fireAction(spec.action, spec.args);
  });
  host.appendChild(btn);
});
