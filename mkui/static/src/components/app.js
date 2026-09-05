// <mkui-app> — top-level shell. Either fetches a JSON config from its
// `config` attribute, or accepts a config object via setConfig() in
// library mode. Builds menubar / workspace / statusbar children and hands
// each of them an App instance.
//
// The workspace is where all windows live — as floating frames, not a
// single docked tree. Docking happens inside each frame.

import { App } from "../core.js";
import { ensureMkio } from "../mkio-bridge.js";
import { LayoutManager } from "../layouts.js";
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
    this._config = config;
    this._app = new App(config);
    this._app.mount(this);
    if (config.app?.title) document.title = config.app.title;
    this.setTheme(config.app?.theme);
    // Built-in window arrangement actions.
    const ws = this._workspace;
    this._app.registerAction("window.tileH",    () => ws.arrangeHorizontal());
    this._app.registerAction("window.tileV",    () => ws.arrangeVertical());
    this._app.registerAction("window.grid",     () => ws.arrangeGrid());
    this._app.registerAction("window.cascade",  () => ws.arrangeCascade());
    this._app.registerAction("pane.show",       (app, id) => ws.showPane(id));
    // Edit actions route to the focused frame's active pane (same hook the
    // Ctrl/Cmd+C / Ctrl/Cmd+A shortcuts use).
    this._app.registerAction("edit.copy",       () => ws.editAction("copy"));
    this._app.registerAction("edit.selectAll",  () => ws.editAction("selectAll"));
    // `args = { pane = "<id>", filters = { col = <filter> }, merge = false }`;
    // `pane` omitted targets the focused pane.
    this._app.registerAction("table.filter",    (app, a = {}) => ws.setPaneFilters(a.pane ?? null, a.filters ?? {}, { merge: a.merge === true }));
    // `args = { pane = "<id>", sort = <spec> }` — a column name, "-col",
    // { col, dir }, or an array of those; no `sort` clears.
    this._app.registerAction("table.sort",      (app, a = {}) => ws.setPaneSort(a.pane ?? null, a.sort ?? null));
    // Visible columns: `args = { pane, visible }`; no `visible` shows all.
    this._app.registerAction("table.columns",   (app, a = {}) => ws.setPaneColumns(a.pane ?? null, a.visible ?? null));

    const hasAuth = !!config.auth;
    const st = this._app.state;
    const apply = (map) => {
      for (const [path, value] of Object.entries(map))
        st.set(path, value);
    };

    if (hasAuth) {
      st.set("auth.authenticated", false);
      st.set("auth.user", "");
      st.set("auth.role", "");
      this._app.registerAction("auth.logout", () => location.reload());
    }

    if (config.mkio?.url) {
      let verifyGen = 0;

      this._verify = async (client) => {
        const gen = ++verifyGen;
        st.set("mkio.verified", false);
        st.set("mkio.server", {});

        const expect = config.mkio.expect;
        const reqData = {};
        if (expect?.version)  reqData.version  = expect.version;
        if (expect?.protocol) reqData.protocol = expect.protocol;
        if (expect?.mkio)     reqData.mkio     = expect.mkio;
        if (expect?.expr)     reqData.expr     = String(expect.expr);

        let reply;
        try {
          const ms = config.mkio.timeout ?? 5000;
          reply = await Promise.race([
            client.request("_mkio", Object.keys(reqData).length ? reqData : undefined),
            new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms)),
          ]);
        } catch (e) {
          if (gen !== verifyGen) return;
          st.set("mkio.verified", false);
          apply(config.mkio.incompatible ?? { "status.message": "Incompatible server" });
          return;
        }

        if (gen !== verifyGen) return;
        const info = reply.row;

        st.set("mkio.server.name",     info.name     ?? null);
        st.set("mkio.server.version",  info.version  ?? null);
        st.set("mkio.server.protocol", info.protocol ?? null);
        st.set("mkio.server.mkio",     info.mkio     ?? null);

        let verified = true;
        if (expect) {
          if (expect.name && info.name !== expect.name) verified = false;
          if (info.compatible === false) verified = false;
        }

        st.set("mkio.verified", verified);
        if (!verified) {
          apply(config.mkio.incompatible ?? { "status.message": "Incompatible server" });
        }
      };

      ensureMkio(config.mkio.url, {
        onConnect: (client) => {
          st.set("mkio.connected", true);
          if (hasAuth) {
            if (st.get("auth.authenticated")) {
              apply(config.auth.connected ?? config.mkio.connected ?? { "status.message": "Connected" });
            } else {
              apply(config.mkio.connected ?? { "status.message": "Connected" });
            }
          } else {
            apply(config.mkio.connected ?? { "status.message": "Connected" });
          }
          if (!hasAuth) this._verify(client);
        },
        onDisconnect: () => {
          st.set("mkio.connected", false);
          st.set("mkio.verified", false);
          if (hasAuth) {
            apply(config.auth.disconnected ?? config.mkio.disconnected ?? { "status.message": "Disconnected" });
          } else {
            apply(config.mkio.disconnected ?? { "status.message": "Disconnected" });
          }
        },
      });
    }

    // Saved layouts: the Layout menu's actions and the startup restore.
    // Registered after ensureMkio above so the bridge's cached client is
    // the one with the lifecycle callbacks.
    this._layouts = config.layouts ? new LayoutManager(config, this._app, ws) : null;

    this._menubar.setApp(this._app);
    this._statusbar.setApp(this._app);

    if (hasAuth || this._layouts) {
      // Frames wait: for the login, and for the saved layout the owner
      // (known only after login) may have.
      const savedFrames = config.frames;
      config.frames = [];
      this._workspace.setApp(this._app);
      config.frames = savedFrames;
      if (hasAuth) this._authenticate(config);
      else this._loadFrames(config);
    } else {
      this._workspace.setApp(this._app);
    }
  }

  async _authenticate(config) {
    const method = config.auth.method ?? "mkio";

    let client = null;
    if (method === "mkio" && config.mkio?.url) {
      client = await ensureMkio(config.mkio.url);
    }

    const { showLogin } = await import("../auth.js");
    await showLogin(config, this._app, client);

    const st = this._app.state;
    const apply = (map) => {
      for (const [path, value] of Object.entries(map))
        st.set(path, value);
    };
    apply(config.auth.connected ?? config.mkio?.connected ?? { "status.message": "Connected" });

    await this._loadFrames(config);
  }

  // The startup frames: the owner's latest saved layout when there is one,
  // else the config's.
  async _loadFrames(config) {
    if (this._layouts && await this._layouts.restoreLatest()) return;
    for (const f of config.frames ?? []) {
      this._workspace.addFrame(f);
    }
  }

  setTheme(name) {
    if (this._themeVars) {
      for (const k of this._themeVars) this.style.removeProperty(k);
      this._themeVars = null;
    }
    if (name) this.setAttribute("theme", name);
    else this.removeAttribute("theme");
    const vars = this._config?.app?.themes?.[name];
    if (!vars) return;
    const applied = [];
    for (const [k, v] of Object.entries(vars)) {
      const key = k.startsWith("--") ? k : `--${k}`;
      this.style.setProperty(key, v);
      applied.push(key);
    }
    this._themeVars = applied;
  }

  get app() { return this._app; }
  get workspace() { return this._workspace; }
}

if (!customElements.get("mkui-app")) customElements.define("mkui-app", MkuiApp);
export { MkuiApp };
