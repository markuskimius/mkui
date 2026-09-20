// Reactive state store, window-type registry, and the central App object
// that everything else hangs off of.
//
// The state store is intentionally tiny: it's a Proxy over a plain object,
// supports dot-path get/set, and notifies subscribers per path.

export const VERSION = "1.10.0";
export function version() { return VERSION; }

import { registerExprFunction, registerExprLibrary, registerExprType, expr } from "./lib/expressions.js";
import { LinkHub } from "./lib/links.js";
import { alertSpec, confirmSpec, needsClient } from "./lib/dialogs.js";

const widgetTypes = new Map();
const paneTypes = new Map();

// The expression language (mkio's, vendored in lib/expr.js) is the
// extension surface for derived values, styling rules, enable/showWhen
// conditions, and ${...} templates. Applications add functions with
// registerExprFunction(name, fn, meta) and call them from config.
export { registerExprFunction, registerExprLibrary, registerExprType, expr, LinkHub };

export function registerWidget(name, factory) {
  widgetTypes.set(name, factory);
}
// A pane type is a factory that renders custom content into a pane's
// content host. Reference from config with `type = "<name>"`.
export function registerPaneType(name, factory) {
  paneTypes.set(name, factory);
}
export function getWidget(name) { return widgetTypes.get(name); }
export function getPaneType(name) { return paneTypes.get(name); }

export class State {
  constructor(initial = {}) {
    this._data = structuredClone(initial);
    this._subs = new Map(); // path -> Set<fn>
  }
  get(path) {
    if (!path) return this._data;
    const parts = path.split(".");
    let v = this._data;
    for (const p of parts) {
      if (v == null) return undefined;
      v = v[p];
    }
    return v;
  }
  set(path, value) {
    const parts = path.split(".");
    let v = this._data;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (v[p] == null || typeof v[p] !== "object") v[p] = {};
      v = v[p];
    }
    v[parts[parts.length - 1]] = value;
    this._notify(path);
  }
  subscribe(path, fn) {
    if (!this._subs.has(path)) this._subs.set(path, new Set());
    this._subs.get(path).add(fn);
    fn(this.get(path));
    return () => this._subs.get(path)?.delete(fn);
  }
  _notify(path) {
    // Notify exact path and all parent paths.
    const parts = path.split(".");
    for (let i = parts.length; i > 0; i--) {
      const p = parts.slice(0, i).join(".");
      const subs = this._subs.get(p);
      if (subs) for (const fn of subs) fn(this.get(p));
    }
    // …and everything under it: replacing `a.b` moves `a.b.c` too, and a
    // subscriber there (an expression reading `state.a.b.c`) must hear it.
    const under = path + ".";
    for (const [p, subs] of this._subs) {
      if (p.startsWith(under)) for (const fn of subs) fn(this.get(p));
    }
  }
}

// The App is the public JS API. In standalone mode <mkui-app> creates one
// from a config URL. In library mode users construct one directly.
export class App {
  constructor(config = {}) {
    this.config = config;
    this.state = new State(config.state ?? {});
    // Table links (lib/links.js): broadcasting tables publish here,
    // listening tables follow; values mirror into state at `link.<name>`.
    this.links = new LinkHub(() => this.state);
    this.actions = new Map();
    this._listeners = new Set();
    this._element = null;
  }

  registerAction(name, fn) {
    this.actions.set(name, fn);
  }

  registerAuthHandler(handler) {
    this.authHandler = handler;
  }

  fireAction(name, ...args) {
    const fn = this.actions.get(name);
    if (fn) return fn(this, ...args);
    // Built-in actions
    if (name === "app.quit") {
      window.close();
      return;
    }
    console.warn("[mkui] unknown action:", name);
  }

  // Dialogs. `dialog(spec, context)` opens one — a spec, or the name of
  // one under the config's `dialogs` — and resolves with its answer: the
  // submitted fields, `{ button, data }` when the spec has `buttons`, null
  // when dismissed. The spec's expressions see `state` and `app` (the
  // config's `app` block) under whatever the caller adds. `alert` resolves
  // once acknowledged, `confirm` with whether OK was the answer; both take
  // the message and `{ title, kind, ok, cancel, … }`.
  async dialog(spec, context = {}) {
    const found = typeof spec === "string" ? this.config?.dialogs?.[spec] : spec;
    if (!found || typeof found !== "object") {
      console.warn("[mkui] unknown dialog:", spec);
      return null;
    }
    const { openDialog } = await import("./widgets/mkui-dialog.js");
    let client = null;
    if (needsClient(found) && this.config?.mkio?.url) {
      client = await this._mkioClient();
      if (!client) {
        await this.alert("Not connected to the server.", { title: "Offline", kind: "warn" });
        return null;
      }
    }
    const ctx = { state: this.state.get(), app: this.config?.app ?? {}, ...context };
    return openDialog(found, ctx, this, { client });
  }
  async alert(message, opts = {}) {
    await this.dialog(alertSpec({ ...opts, message }));
  }
  async confirm(message, opts = {}) {
    const res = await this.dialog(confirmSpec({ ...opts, message, then: null }));
    return res?.button === "ok";
  }
  // The shared mkio client, or null when it cannot be had in time: a
  // dialog must not wait out an outage to say so.
  async _mkioClient() {
    const { ensureMkio } = await import("./mkio-bridge.js");
    const ms = this.config?.mkio?.timeout ?? 5000;
    try {
      return await Promise.race([
        ensureMkio(this.config.mkio.url),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms)),
      ]);
    } catch { return null; }
  }

  // Mount the app into a host element. If host is a <mkui-app>, it will
  // call this from connectedCallback.
  mount(host) {
    this._element = host;
    host._app = this;
    host.dispatchEvent(new CustomEvent("mkui:configloaded", { detail: this.config }));
    this._notifyChange();
  }

  setConfig(config) {
    this.config = config;
    if (config.state) this.state = new State(config.state);
    if (this._element) {
      this._element.dispatchEvent(new CustomEvent("mkui:configloaded", { detail: config }));
      this._notifyChange();
    }
  }

  onChange(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  _notifyChange() { for (const fn of this._listeners) fn(this); }
}
