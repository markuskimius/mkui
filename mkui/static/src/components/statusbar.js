// <mkui-statusbar> — bottom strip with widget slots on the left and right.
// Config:
//   [statusbar]
//   left  = [{ type = "text", bind = "status.message" }]
//   right = [{ type = "text", text = "v0.1" }]

import { getWidget } from "../core.js";
import { icon } from "../lib/icons.js";
import { offlineOptions } from "../lib/connection.js";

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
    // The connection light: a dot the stylesheet colours by the root
    // `mkio` attribute, and the outage clock beside it while the server
    // is away. Built in, ahead of the config's widgets, whenever there is
    // an mkio server to watch (`mkio.offline.indicator = false` opts out);
    // the message itself stays whatever text widget the config binds.
    const mkio = this._app?.config?.mkio;
    if (mkio?.url && offlineOptions(mkio.offline).indicator) {
      const conn = document.createElement("span");
      conn.className = "mkui-status-conn";
      const dot = icon("dot");
      dot.classList.add("mkui-conn-dot");
      const down = document.createElement("span");
      down.className = "mkui-status-down";
      conn.append(dot, down);
      this._app.state.subscribe("mkio.downFor", (v) => {
        down.textContent = v ?? "";
        down.hidden = v == null;
      });
      left.appendChild(conn);
    }
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

    for (const [prop, path] of Object.entries(cfg.bindStyle ?? {})) {
      this._app.state.subscribe(path, (v) => {
        if (v == null || v === "") this.style.removeProperty(prop);
        else this.style.setProperty(prop, v);
      });
    }
  }
}

if (!customElements.get("mkui-statusbar")) customElements.define("mkui-statusbar", MkuiStatusbar);
export { MkuiStatusbar };
