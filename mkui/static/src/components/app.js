// <mkui-app> — top-level shell. Either fetches a JSON config from its
// `config` attribute, or accepts a config object via setConfig() in
// library mode. Builds menubar / workspace / statusbar children and hands
// each of them an App instance.
//
// The workspace is where all windows live — as floating frames, not a
// single docked tree. Docking happens inside each frame.

import { App, VERSION } from "../core.js";
import { alertSpec, confirmSpec, aboutSpec, resetSuppressed, resetMessage, readSuppressed, SUPPRESS_PREFIX } from "../lib/dialogs.js";
import { makeCopyStatus } from "../lib/copy.js";
import { ensureMkio } from "../mkio-bridge.js";
import { LayoutManager } from "../layouts.js";
import { historyCapabilities } from "../lib/history.js";
import { judgeServer, incompatibleMap } from "../lib/verify.js";
import { phaseOf, offlineOptions, Outage, offlineTitle, restoreIconHref, OFFLINE_FAVICON } from "../lib/connection.js";
import { icon } from "../lib/icons.js";
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
    // The outage banner: between the menubar and the workspace, absent
    // from the DOM until an outage earns it (`_watchConnection`).
    this._banner    = document.createElement("div");
    this._banner.className = "mkui-banner";
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
    this._app.registerAction("frame.show",      (app, id) => ws.showFrame(id));
    // Edit actions route to the focused frame's active pane (same hook the
    // Ctrl/Cmd+C / Ctrl/Cmd+A shortcuts use).
    this._app.registerAction("edit.copy",       () => ws.editAction("copy"));
    this._app.registerAction("edit.selectAll",  () => ws.editAction("selectAll"));
    this._app.registerAction("edit.find",       () => ws.editAction("find"));
    // Record undo/redo, on the same route — a table with `history.undo` /
    // `history.redo` configured steps its selected records. No shortcut is
    // bound: this writes to state everyone shares.
    this._app.registerAction("edit.undo",       () => ws.editAction("undo"));
    this._app.registerAction("edit.redo",       () => ws.editAction("redo"));
    // `args = { pane = "<id>", filters = { col = <filter> }, merge = false }`;
    // `pane` omitted targets the focused pane.
    this._app.registerAction("table.filter",    (app, a = {}) => ws.setPaneFilters(a.pane ?? null, a.filters ?? {}, { merge: a.merge === true }));
    // `args = { pane = "<id>", sort = <spec> }` — a column name, "-col",
    // { col, dir }, or an array of those; no `sort` clears.
    this._app.registerAction("table.sort",      (app, a = {}) => ws.setPaneSort(a.pane ?? null, a.sort ?? null));
    // Visible columns: `args = { pane, visible }`; no `visible` shows all.
    this._app.registerAction("table.columns",   (app, a = {}) => ws.setPaneColumns(a.pane ?? null, a.visible ?? null));
    // Table links: `args = { pane, link, merge }`, or the link keys flat —
    // `{ pane, broadcast, listen, broadcasting, listening, merge }`; no
    // link at all clears the pane's links.
    this._app.registerAction("table.link",      (app, a = {}) => {
      const { pane = null, merge, link, ...flat } = a;
      return ws.setPaneLink(pane, link ?? (Object.keys(flat).length ? flat : null), { merge: merge === true });
    });
    // Tree tables: `args = { pane, depth }` — a depth or "all"; no `depth`
    // collapses everything.
    this._app.registerAction("table.expand",    (app, a = {}) => ws.expandPane(a.pane ?? null, a.depth ?? 0));
    // Select rows by identity: `args = { pane, keys, focus }` — `keys` the
    // row ids (`_mkio_row` for a query table: the primary key value), an
    // empty list clears; `focus = false` selects without moving the cursor.
    // Returns the table's `{ ok, selected, missing, hidden }`, or false.
    this._app.registerAction("table.select",    (app, a = {}) => ws.selectPane(a.pane ?? null, a.keys ?? [], { focus: a.focus !== false }));
    // Record history: `args = { pane, keys }` — opens (or re-points) the
    // history pane for the selected record of a table with a `history`
    // block; `keys` selects those rows first, so a link can name a record.
    this._app.registerAction("table.history",   (app, a = {}) => ws.showPaneHistory(a.pane ?? null, a.keys ?? null));
    // Detail windows. `record.show` puts one record on show: `args =
    // { pane, key = { col: value } }`, or no `key` to empty it.
    this._app.registerAction("record.show",     (app, a = {}) => ws.setPaneRecord(a.pane ?? null, a.key ?? null));
    // `record.follow` says where a window gets its records: `args =
    // { pane, listen | follow | state | key, retain, listening, merge }`,
    // the same shape as the pane's `record` block. No source at all
    // leaves the window following nothing.
    this._app.registerAction("record.follow",   (app, a = {}) => {
      const { pane = null, merge, record, ...flat } = a;
      return ws.setPaneRecordSource(pane, record ?? (Object.keys(flat).length ? flat : null), { merge: merge === true });
    });
    // Send a table's selected record to a detail window: `args =
    // { pane, from }` — `from` the table, else the focused pane.
    this._app.registerAction("table.record",    (app, a = {}) => ws.showPaneRecord(a.pane ?? null, { from: a.from ?? null }));

    // Dialogs from config: `dialog.open` takes `{ dialog = "<name>" }` (one
    // under the top-level `dialogs`) or an inline spec, `context` adding to
    // what its expressions see; the message boxes take a message or
    // `{ message, title, kind, … }`. Each returns the dialog's promise.
    this._app.registerAction("dialog.open",     (app, a = {}) =>
      app.dialog(typeof a === "string" ? a : a?.dialog, (typeof a === "object" && a?.context) || {}));
    this._app.registerAction("dialog.alert",    (app, a) => app.dialog(alertSpec(a)));
    this._app.registerAction("dialog.confirm",  (app, a) => app.dialog(confirmSpec(a)));
    this._app.registerAction("dialog.about",    (app) => app.dialog(aboutSpec(app.config, { version: VERSION })));
    // Forget "Don't ask again" answers: one `suppress` key, or all of them.
    // Nothing on screen changes until a box next asks, so the statusbar
    // says what happened (`status.message`, briefly) — including that
    // there was nothing to forget.
    // The answers themselves are mirrored at `dialog.suppressed`
    // (`{ key: buttonId }`) — here, when a dialog stores one, and when
    // another tab does — for a menu item's `disabled` to read.
    const resetStatus = makeCopyStatus(this._app.state, 4000);
    const store = typeof localStorage !== "undefined" ? localStorage : null;
    const mirrorSuppressed = () => this._app.state.set("dialog.suppressed", readSuppressed(store));
    mirrorSuppressed();
    if (typeof window !== "undefined" && !this._storageHandler) {
      this._storageHandler = (ev) => { if (ev.key == null || ev.key.startsWith(SUPPRESS_PREFIX)) this._mirrorSuppressed?.(); };
      window.addEventListener("storage", this._storageHandler);
    }
    this._mirrorSuppressed = mirrorSuppressed;
    this._app.registerAction("dialog.resetSuppressed", (app, key = null) => {
      const n = resetSuppressed(store, typeof key === "string" ? key : null);
      mirrorSuppressed();
      resetStatus(resetMessage(n));
      return n;
    });

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

      // What the server can do, from the same `_mkio` reply that verifies
      // it: the services it offers, the tables whose changes it records,
      // and the suffix their history tables take. Written only when the
      // reply actually says — an older server omits them, and so does the
      // limited reply an unauthenticated client gets from a server with
      // auth on, neither of which means "nothing is versioned".
      const capture = (info) => {
        if (info.services && typeof info.services === "object") st.set("mkio.server.services", info.services);
        const caps = historyCapabilities(info);
        if (caps) {
          st.set("mkio.server.versioned", caps.versioned);
          st.set("mkio.server.historySuffix", caps.suffix);
        }
      };

      // With auth enabled `_verify` never runs — logging in proves the
      // server is the application — but the capabilities still have to be
      // read, and only an authenticated request carries them. Runs after
      // login and again on each reconnect, once mkio's client has
      // re-authenticated. The one judgement it still makes is mkui's own
      // mkio floor (`judgeServer` with no `expect`): a server of another
      // major is incompatible however the login went.
      this._probe = async (client) => {
        let info;
        try {
          const ms = config.mkio.timeout ?? 5000;
          const reply = await Promise.race([
            client.request("_mkio"),
            new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms)),
          ]);
          info = reply.row ?? {};
        } catch (e) {
          console.warn(`[mkui] could not read server capabilities: ${e.message}`);
          return;
        }
        st.set("mkio.server.mkio", info.mkio ?? null);
        capture(info);
        const { verified, reason } = judgeServer(info, null);
        st.set("mkio.verified", verified);
        st.set("mkio.reason", reason);
        if (!verified) apply(incompatibleMap(config.mkio.incompatible, reason));
      };

      this._verify = async (client) => {
        const gen = ++verifyGen;
        st.set("mkio.verified", false);
        st.set("mkio.reason", null);
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
          reply = null;
        }

        if (gen !== verifyGen) return;
        const info = reply?.row ?? null;

        if (info) {
          st.set("mkio.server.name",     info.name     ?? null);
          st.set("mkio.server.version",  info.version  ?? null);
          st.set("mkio.server.protocol", info.protocol ?? null);
          st.set("mkio.server.mkio",     info.mkio     ?? null);
          if (info.compatibility && typeof info.compatibility === "object")
            st.set("mkio.server.compatibility", info.compatibility);
          capture(info);
        }

        // Three ways to fail, told apart for the statusbar: no answer, a
        // server of another name, a server of the right name but a
        // version the config rejects (`lib/verify.js`).
        const { verified, reason } = judgeServer(info, expect);
        st.set("mkio.verified", verified);
        st.set("mkio.reason", reason);
        if (!verified) apply(incompatibleMap(config.mkio.incompatible, reason));
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
          // Under auth the first read waits for the login (_authenticate);
          // a reconnect after that re-reads, the client having
          // re-authenticated itself.
          if (!hasAuth) this._verify(client);
          else if (st.get("auth.authenticated")) this._probe(client);
        },
        onDisconnect: () => {
          st.set("mkio.connected", false);
          st.set("mkio.verified", false);
          st.set("mkio.reason", null);
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

    if (config.mkio?.url) this._watchConnection(config);

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
    if (config.mkio?.url && config.mkio.control) {
      if (hasAuth) this._controlAfterLogin = true; // an `auth` service: subscribe once logged in
      else this._subscribeControl(config);
    }
  }

  // How the shell shows the connection (lib/connection.js). The phase —
  // connecting, connected, disconnected, incompatible — rides the root
  // `mkio` attribute, which the stylesheet keys the statusbar colours,
  // the dot and the stale tint on; the transitions do the rest: the
  // outage clock behind `mkio.downSince` / `mkio.downFor`, the tab title
  // and favicon, the banner. Driven by the `mkio.connected` and
  // `mkio.reason` state paths, so it sees every lifecycle event — the
  // maps a config applies on those events stay its own business. Each
  // piece is a `config.mkio.offline` option.
  _watchConnection(config) {
    const st = this._app.state;
    const opts = offlineOptions(config.mkio.offline);
    const outage = new Outage();
    let phase = null;
    let ever = false;
    let tick = null;
    let bannerTimer = null;
    let savedTitle = null;
    let savedIcon = null;   // { el, href } — the page's icon link; href null when it had none
    this._offline = opts;

    const clearTimers = () => {
      if (tick) { clearInterval(tick); tick = null; }
      if (bannerTimer) { clearTimeout(bannerTimer); bannerTimer = null; }
    };

    const showBanner = () => {
      if (!opts.banner || this._banner.isConnected) return;
      this._banner.textContent = "";
      const dot = icon("dot");
      dot.classList.add("mkui-conn-dot");
      const msg = document.createElement("span");
      msg.className = "mkui-banner-msg";
      const unsubMsg = st.subscribe("status.message", (v) => { msg.textContent = v ?? ""; });
      const down = document.createElement("span");
      down.className = "mkui-banner-down";
      const unsubDown = st.subscribe("mkio.downFor", (v) => {
        down.textContent = v == null ? "" : `down ${v}`;
        down.hidden = v == null;
      });
      this._banner._unsub = () => { unsubMsg(); unsubDown(); };
      this._banner.append(dot, msg, down);
      this.insertBefore(this._banner, this._workspace);
      this.setAttribute("banner", "");
    };
    const hideBanner = () => {
      if (!this._banner.isConnected) return;
      this._banner._unsub?.();
      this._banner.remove();
      this.removeAttribute("banner");
    };

    const markPage = () => {
      if (opts.title) {
        savedTitle = document.title;
        document.title = offlineTitle(savedTitle);
      }
      if (opts.favicon) {
        const el = document.querySelector('link[rel~="icon"]');
        if (el) {
          savedIcon = { el, href: el.getAttribute("href") };
        } else {
          const made = document.createElement("link");
          made.rel = "icon";
          document.head.appendChild(made);
          savedIcon = { el: made, href: null };
        }
        savedIcon.el.setAttribute("href", OFFLINE_FAVICON);
      }
    };
    const unmarkPage = () => {
      if (savedTitle != null) { document.title = savedTitle; savedTitle = null; }
      if (savedIcon) {
        // The link stays either way: the tab only repaints on an href change.
        savedIcon.el.setAttribute("href", restoreIconHref(savedIcon.href, document.baseURI));
        savedIcon = null;
      }
    };

    const startOutage = () => {
      if (!outage.down()) return;
      st.set("mkio.downSince", outage.since);
      st.set("mkio.downFor", outage.downFor());
      tick = setInterval(() => st.set("mkio.downFor", outage.downFor()), 1000);
      markPage();
      if (opts.stale) this.setAttribute("stale", "");
      if (opts.banner) {
        if (opts.delay > 0) bannerTimer = setTimeout(() => { bannerTimer = null; showBanner(); }, opts.delay * 1000);
        else showBanner();
      }
    };
    const endOutage = () => {
      if (!outage.up()) return;
      clearTimers();
      st.set("mkio.downSince", null);
      st.set("mkio.downFor", null);
      unmarkPage();
      this.removeAttribute("stale");
      hideBanner();
    };

    const sync = () => {
      const next = phaseOf({ connected: st.get("mkio.connected"), reason: st.get("mkio.reason"), ever });
      if (next === phase) return;
      phase = next;
      this.setAttribute("mkio", phase);
      if (phase === "disconnected") startOutage();
      else endOutage();
      // An incompatible server is a state, not an outage: no clock, but
      // the banner at once — nothing here is going to reconnect its way
      // out of it.
      if (phase === "incompatible") showBanner();
      else if (phase !== "disconnected") hideBanner();
    };

    st.subscribe("mkio.connected", (v) => { if (v) ever = true; sync(); });
    st.subscribe("mkio.reason", sync);
  }

  // The control channel: `config.mkio.control = "<service>"` (or `{
  // service }`) names an mkui ControlService (mkui/control.py) on the
  // server, whose pushes are actions — `{ action, args }` rows on a
  // subpub subscription — fired here as if a menu item had. Python drives
  // table links, filters, pane visibility and every other registered
  // action through it. Subscribed once, by subid and without a topic (the
  // client routes a topic-keyed subscription by the row's `_mkio_topic`,
  // which an action row has no reason to carry); mkio's client re-sends
  // subscriptions itself on reconnect.
  async _subscribeControl(config) {
    if (this._controlSubscribed) return;
    this._controlSubscribed = true;
    const ctl = config.mkio.control;
    const service = typeof ctl === "string" ? ctl : ctl?.service;
    if (!service) return;
    const client = await ensureMkio(config.mkio.url);
    client.subscribe(service, "subpub", {
      subid: "mkui-control",
      onSnapshot: () => {},
      onUpdate: (op, row) => {
        if (op !== "action" || !row || typeof row.action !== "string") return;
        try { this._app.fireAction(row.action, row.args); }
        catch (e) { console.warn(`[mkui] control action ${row.action} failed: ${e.message}`); }
      },
      onNack: (message) => console.warn(`[mkui] control channel '${service}' refused: ${message}`),
    });
  }

  async _authenticate(config) {
    const method = config.auth.method ?? "mkio";

    let client = null;
    if (method === "mkio" && config.mkio?.url) {
      client = await ensureMkio(config.mkio.url);
    }

    const { showLogin } = await import("../auth.js");
    await showLogin(config, this._app, client);
    if (this._controlAfterLogin) this._subscribeControl(config);

    const st = this._app.state;
    const apply = (map) => {
      for (const [path, value] of Object.entries(map))
        st.set(path, value);
    };
    apply(config.auth.connected ?? config.mkio?.connected ?? { "status.message": "Connected" });

    // Not awaited: the capabilities feed panes that react to state, and
    // frames should not wait on a round trip to open.
    if (this._probe && config.mkio?.url) this._probe(client ?? await ensureMkio(config.mkio.url));

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
