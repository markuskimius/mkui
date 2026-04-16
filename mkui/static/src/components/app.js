// <mkui-app> — top-level shell. Either fetches a JSON config from its
// `config` attribute, or accepts a config object via setConfig() in
// library mode. Builds menubar / workspace / statusbar children and hands
// each of them an App instance.
//
// The workspace is where all windows live — as floating frames, not a
// single docked tree. Docking happens inside each frame.

import { App } from "../core.js";
import "./menubar.js";
import "./statusbar.js";
import "./workspace.js";

class MkuiApp extends HTMLElement {
  constructor() {
    super();
    this._app = null;
    this._built = false;
  }

  async connectedCallback() {
    if (this._built) return;
    this._buildShell();
    const url = this.getAttribute("config");
    if (url) {
      try {
        const res = await fetch(url);
        const config = await res.json();
        this.setConfig(config);
      } catch (e) {
        console.error("[mkui] failed to load config:", e);
      }
    }
  }

  _buildShell() {
    this._built = true;
    this._menubar   = document.createElement("mkui-menubar");
    this._workspace = document.createElement("mkui-workspace");
    this._statusbar = document.createElement("mkui-statusbar");
    this.appendChild(this._menubar);
    this.appendChild(this._workspace);
    this.appendChild(this._statusbar);
  }

  setConfig(config) {
    if (!this._built) this._buildShell();
    this._app = new App(config);
    this._app.mount(this);
    if (config.app?.title) document.title = config.app.title;
    if (config.app?.theme) this.setAttribute("theme", config.app.theme);
    // Built-in window arrangement actions.
    const ws = this._workspace;
    this._app.registerAction("window.tileH",    () => ws.arrangeHorizontal());
    this._app.registerAction("window.tileV",    () => ws.arrangeVertical());
    this._app.registerAction("window.grid",     () => ws.arrangeGrid());
    this._app.registerAction("window.cascade",  () => ws.arrangeCascade());

    this._menubar.setApp(this._app);
    this._workspace.setApp(this._app);
    this._statusbar.setApp(this._app);
  }

  get app() { return this._app; }
  get workspace() { return this._workspace; }
}

if (!customElements.get("mkui-app")) customElements.define("mkui-app", MkuiApp);
export { MkuiApp };
