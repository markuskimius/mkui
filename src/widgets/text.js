import { registerWidget } from "../core.js";

// A text widget. Either renders static text or binds to a state path.
//
// Config:
//   { type: "text", text: "Hello" }
//   { type: "text", bind: "status.message" }
registerWidget("text", (spec, app, host) => {
  const span = document.createElement("span");
  if (spec.bind) {
    app.state.subscribe(spec.bind, v => { span.textContent = v ?? ""; });
  } else {
    span.textContent = spec.text ?? "";
  }
  if (spec.class) span.className = spec.class;
  host.appendChild(span);
});
