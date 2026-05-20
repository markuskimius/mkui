// <mkui-app> — top-level shell. Either fetches a JSON config from its
// `config` attribute, or accepts a config object via setConfig() in
// library mode. Builds menubar / workspace / statusbar children and hands
// each of them an App instance.
//
// The workspace is where all windows live — as floating frames, not a
// single docked tree. Docking happens inside each frame.

import { App } from "../core.js";
import { ensureMkio } from "../mkio-bridge.js";
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

    if (config.mkio?.url) {
      const st = this._app.state;
      const apply = (map) => {
        for (const [path, value] of Object.entries(map))
          st.set(path, value);
      };

      let verifyGen = 0;

      const verify = async (client) => {
        const gen = ++verifyGen;
        st.set("mkio.verified", false);
        st.set("mkio.server", {});

        const expect = config.mkio.expect;
        const reqData = {};
        if (expect?.version)  reqData.version  = expect.version;
        if (expect?.protocol) reqData.protocol = expect.protocol;
        if (expect?.mkio)     reqData.mkio     = expect.mkio;

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
          apply(config.mkio.connected ?? { "status.message": "Connected" });
          verify(client);
        },
        onDisconnect: () => {
          st.set("mkio.connected", false);
          st.set("mkio.verified", false);
          apply(config.mkio.disconnected ?? { "status.message": "Disconnected" });
        },
      });
    }

    this._menubar.setApp(this._app);
    this._workspace.setApp(this._app);
    this._statusbar.setApp(this._app);
  }

  // Apply a named theme. Built-in names ("dark", "light") are styled by
  // mkui.css via the [theme] attribute. Custom themes come from
  // config.app.themes[name] — a flat object of CSS custom property
  // overrides (e.g. { "--mkui-bg": "#101820", "--mkui-accent": "#ff6b35" }),
  // applied as inline styles so they cascade into every descendant.
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
