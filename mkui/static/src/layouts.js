// Saved window layouts — the Layout menu's actions, the store behind them,
// and the startup restore. Enabled by a `layouts` config table:
//
//   [layouts]
//   store = "mkio"      # or "local"; default: mkio when [mkio].url is set
//   key = "orders"      # this app's layouts in a shared store; default app.title
//   keep = 10           # history per owner: the newest `keep` entries …
//   keepDays = 7        # … or everything from the last `keepDays` days,
//                       # whichever keeps more (0 disables that half)
//   autoload = true     # apply the owner's latest layout at startup
//   timeout = 5000      # ms per store call
//   service = "mkui_layouts"   # transaction service; `_list` / `_get` reqreps
//
// Saves are unnamed. A user has one layout — their newest save, restored at
// startup — and the saves before it form a history they can go back to.
// The owner rule: a logged-in user's layouts save under their login name;
// without a login they save under "" — the default history. Actions:
// `layout.save` (immediate; skipped when nothing changed), `layout.restore`
// (entry id), `layout.reset` (config frames and pane defaults), and
// `layout.refresh`, which the menubar fires when a `{ layouts = true }`
// submenu is about to open. The menubar reads the history from state
// `layouts.list` — `[{ id, saved, label }]`, newest first, already cut to
// the retention rule.

import { ensureMkio } from "./mkio-bridge.js";
import { LocalLayoutStore, MkioLayoutStore, entryLabel, retained, sameLayout } from "./lib/layouts.js";

const STATUS_MS = 2000;

// Show a status-bar message for a moment, then put back what was there.
export function flashStatus(app, msg) {
  const st = app.state;
  const prev = st.get("status.message");
  st.set("status.message", msg);
  setTimeout(() => {
    if (st.get("status.message") === msg) st.set("status.message", prev ?? "");
  }, STATUS_MS);
}

export class LayoutManager {
  constructor(config, app, ws, opts = {}) {
    this._config = config;
    this._cfg = config.layouts ?? {};
    this._app = app;
    this._ws = ws;
    this._store = opts.store ?? null;
    this._storage = opts.storage;
    this._now = opts.now ?? (() => new Date());
    this._busy = false;
    app.state.set("layouts.list", []);
    app.registerAction("layout.save",    () => this.save());
    app.registerAction("layout.restore", (_, id) => this.restore(id));
    app.registerAction("layout.reset",   () => this.reset());
    app.registerAction("layout.refresh", () => this.refresh());
  }

  owner() {
    const st = this._app.state;
    if (!st.get("auth.authenticated")) return "";
    const u = st.get("auth.user");
    return u == null ? "" : String(u);
  }

  _limit(key, dflt) {
    const v = Number(this._cfg[key] ?? dflt);
    return Number.isFinite(v) && v > 0 ? v : 0;
  }
  get keep() { return Math.floor(this._limit("keep", 10)); }
  get keepDays() { return this._limit("keepDays", 7); }

  get timeout() {
    const t = Number(this._cfg.timeout ?? 5000);
    return Number.isFinite(t) && t > 0 ? t : 5000;
  }

  get key() {
    return String(this._cfg.key ?? this._config.app?.title ?? "mkui");
  }

  // The history the retention rule keeps, newest first.
  _retained(entries) {
    return retained(entries, { keep: this.keep, keepDays: this.keepDays, now: this._now() });
  }

  // The store, built on first use: mkio when the app has a server (the
  // bridge caches the client, so this never opens a second socket), else
  // the browser's localStorage.
  async store() {
    if (this._store) return this._store;
    if (!this._storePromise) {
      this._storePromise = this._buildStore().catch((e) => {
        this._storePromise = null;   // try again next time
        throw e;
      });
    }
    return this._storePromise;
  }

  async _buildStore() {
    const kind = this._cfg.store ?? (this._config.mkio?.url ? "mkio" : "local");
    if (kind === "mkio") {
      if (!this._config.mkio?.url) throw new Error("layouts.store = \"mkio\" needs mkio.url");
      const client = await ensureMkio(this._config.mkio.url);
      const service = this._cfg.service ?? "mkui_layouts";
      this._store = new MkioLayoutStore(client, {
        app: this.key, service,
        list: this._cfg.list ?? `${service}_list`,
        get: this._cfg.get ?? `${service}_get`,
        timeout: this.timeout,
      });
    } else if (kind === "local") {
      const storage = this._storage ?? (typeof localStorage !== "undefined" ? localStorage : null);
      if (!storage) throw new Error("no localStorage for layouts");
      this._store = new LocalLayoutStore(storage, `mkui.layouts.${this.key}`);
    } else {
      throw new Error(`unknown layouts.store: ${kind}`);
    }
    return this._store;
  }

  _online() {
    if (!this._config.mkio?.url || (this._cfg.store ?? "mkio") !== "mkio") return true;
    return this._app.state.get("mkio.connected") !== false;
  }

  _publish(entries) {
    const now = this._now();
    const kept = this._retained(entries);
    this._app.state.set("layouts.list", kept.map(e => ({ ...e, label: entryLabel(e, now) })));
    return kept;
  }

  // Refresh the history in state. Failures keep the old list.
  async refresh() {
    try {
      const store = await this.store();
      this._publish(await store.list(this.owner()));
    } catch (e) {
      console.warn("[mkui] layouts: couldn't list saved layouts:", e.message);
    }
    return this._app.state.get("layouts.list");
  }

  // Startup: apply the owner's newest saved layout. Returns whether one was
  // applied — the caller loads the config frames otherwise. Bounded by
  // `timeout` so a slow or absent server never leaves the workspace empty.
  async restoreLatest() {
    if (this._cfg.autoload === false) return false;
    try {
      return await Promise.race([
        this._restoreLatest(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), this.timeout)),
      ]);
    } catch (e) {
      console.warn("[mkui] layouts: startup restore skipped:", e.message);
      return false;
    }
  }

  async _restoreLatest() {
    const store = await this.store();
    const entries = this._publish(await store.list(this.owner()));
    if (!entries.length) return false;
    const entry = await store.load(entries[0].id);
    if (!entry) return false;
    return this._apply(entry);
  }

  // Apply a loaded entry; false when nothing usable was in it.
  _apply(entry) {
    let clean;
    try {
      clean = this._ws.setLayout(entry.layout);
    } catch (e) {
      console.warn(`[mkui] layouts: bad layout ${entry.id}: ${e.message}`);
      flashStatus(this._app, "Couldn't restore layout: " + e.message);
      return false;
    }
    if (clean.dropped.length) {
      console.warn(`[mkui] layouts: layout ${entry.id} names panes the app no longer has: ${clean.dropped.join(", ")}`);
      if (!clean.frames.length && entry.layout?.frames?.length) {
        this._ws.resetLayout();
        flashStatus(this._app, "Layout's panes no longer exist");
        return false;
      }
    }
    return true;
  }

  async _guarded(what, fn) {
    if (this._busy) return false;
    if (!this._online()) { flashStatus(this._app, `Couldn't ${what}: not connected`); return false; }
    this._busy = true;
    try {
      return await fn();
    } catch (e) {
      console.warn(`[mkui] layouts: couldn't ${what}:`, e.message);
      flashStatus(this._app, `Couldn't ${what}: ${e.message}`);
      return false;
    } finally {
      this._busy = false;
    }
  }

  // Save the current layout as the owner's newest entry — unless it is the
  // same as the newest already, so repeated saves don't pad the history —
  // then prune what the retention rule no longer keeps.
  async save() {
    return this._guarded("save layout", async () => {
      const store = await this.store();
      const owner = this.owner();
      const layout = this._ws.getLayout();
      let entries = await store.list(owner);
      if (entries.length) {
        const newest = await store.load(entries[0].id);
        if (newest && sameLayout(newest.layout, layout)) {
          this._publish(entries);
          flashStatus(this._app, "Layout unchanged");
          return false;
        }
      }
      await store.save(owner, layout);
      entries = await store.list(owner);
      const kept = new Set(this._retained(entries).map(e => e.id));
      for (const e of entries) if (!kept.has(e.id)) await store.remove(e.id);
      this._publish(entries.filter(e => kept.has(e.id)));
      flashStatus(this._app, "Layout saved");
      return true;
    });
  }

  async restore(id) {
    return this._guarded("restore layout", async () => {
      const store = await this.store();
      const entry = await store.load(id);
      if (!entry) {
        flashStatus(this._app, "Layout no longer exists");
        await this.refresh();
        return false;
      }
      if (!this._apply(entry)) return false;
      flashStatus(this._app, `Layout restored: ${entryLabel(entry, this._now())}`);
      return true;
    });
  }

  reset() {
    this._ws.resetLayout();
    flashStatus(this._app, "Layout reset");
    return true;
  }
}
