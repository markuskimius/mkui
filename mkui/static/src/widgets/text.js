import { registerWidget } from "../core.js";
import { resolveExpr, statePaths } from "../lib/expressions.js";

// A text widget. Renders static text, a ${...} template over app state, or
// binds to a state path.
//
// Config:
//   { type: "text", text: "Hello" }
//   { type: "text", text: "${state.auth.user ?? 'anonymous'} · ${state.status.message}" }
//   { type: "text", bind: "status.message" }
//
// A template re-renders whenever one of the `state.<path>`s it reads changes.
registerWidget("text", (spec, app, host) => {
  const span = document.createElement("span");
  if (spec.bind) {
    app.state.subscribe(spec.bind, v => { span.textContent = v ?? ""; });
  } else if (typeof spec.text === "string" && spec.text.includes("${")) {
    const render = () => { span.textContent = String(resolveExpr(spec.text, { state: app.state.get() })); };
    const paths = statePaths(spec.text, { template: true });
    if (paths.size === 0) render();
    else for (const p of paths) app.state.subscribe(p, render);
  } else {
    span.textContent = spec.text ?? "";
  }
  if (spec.class) span.className = spec.class;
  host.appendChild(span);
});
