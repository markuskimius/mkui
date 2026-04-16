// <mkui-statusbar> — bottom strip with widget slots on the left and right.
// Config:
//   [statusbar]
//   left  = [{ type = "text", bind = "status.message" }]
//   right = [{ type = "text", text = "v0.1" }]

import { getWidget } from "../core.js";

class MkuiStatusbar extends HTMLElement {
  setApp(app) {
    this._app = app;
    this._render();
  }
  _render() {
    this.innerHTML = "";
    const cfg = this._app?.config?.statusbar ?? {};
    const left = document.createElement("div");
    left.className = "mkui-status-side";
    const right = document.createElement("div");
    right.className = "mkui-status-side";
    for (const w of cfg.left ?? []) {
      const fn = getWidget(w.type);
      if (fn) fn(w, this._app, left);
    }
    for (const w of cfg.right ?? []) {
      const fn = getWidget(w.type);
      if (fn) fn(w, this._app, right);
    }
    this.appendChild(left);
    this.appendChild(right);
  }
}

if (!customElements.get("mkui-statusbar")) customElements.define("mkui-statusbar", MkuiStatusbar);
export { MkuiStatusbar };
