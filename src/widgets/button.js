import { registerWidget } from "../core.js";

// Config:
//   { type: "button", label: "Run", action: "thing.do" }
registerWidget("button", (spec, app, host) => {
  const btn = document.createElement("button");
  btn.className = "mkui-btn";
  btn.textContent = spec.label ?? "Button";
  btn.addEventListener("click", () => {
    if (spec.action) app.fireAction(spec.action, spec.args);
  });
  host.appendChild(btn);
});
