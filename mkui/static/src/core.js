// Reactive state store, window-type registry, and the central App object
// that everything else hangs off of.
//
// The state store is intentionally tiny: it's a Proxy over a plain object,
// supports dot-path get/set, and notifies subscribers per path.

export const VERSION = "1.35.0";
export function version() { return VERSION; }

import { registerExprFunction, registerExprLibrary, registerExprType, expr } from "./lib/expressions.js";
import { LinkHub } from "./lib/links.js";
import { alertSpec, confirmSpec, needsClient, FIELD_TYPES } from "./lib/dialogs.js";

const widgetTypes = new Map();
const fieldTypes = new Map();
const paneTypes = new Map();
const paneTypeKeys = new Map();

// The expression language (mkio's, vendored in lib/expr.js) is the
// extension surface for derived values, styling rules, enable/showWhen
// conditions, and ${...} templates. Applications add functions with
// registerExprFunction(name, fn, meta) and call them from config.
export { registerExprFunction, registerExprLibrary, registerExprType, expr, LinkHub };

export function registerWidget(name, factory) {
  widgetTypes.set(name, factory);
}
// A pane type is a factory that renders custom content into a pane's
// content host. Reference from config with `type = "<name>"`. `keys` lists
// the config keys the type reads (besides `title` and `type`): the
// workspace reports a pane carrying any other key on the console, which
// is what catches a misspelt or misplaced key that would otherwise be
// ignored in silence. A type that declares none is not checked.
export function registerPaneType(name, factory, keys = null) {
  paneTypes.set(name, factory);
  paneTypeKeys.set(name, keys ? new Set(keys) : null);
}
// A field type is a dialog field an application supplies: an editor, a tag
// box, a picker mkui does not have. Reference it from a dialog spec with
// `type = "<name>"`. The factory is called once per field per dialog as
// `factory(field, ctx)`, with `ctx = { changed, resized, placeholder }`,
// and returns the field's handle:
//
//   el            the element the dialog shows under the label (required)
//   get()         the value, a string: what the form reads and submits
//   set(value)    put a value in: a default, a compute, a reset
//   focus()       take the focus (first field, a reset); else the first
//                 focusable thing inside `el` does
//   setDisabled(b) / setReadOnly(b)   the field's `disabled` / `readonly`
//   destroy()     the dialog is gone: let go of what the field holds
//   keepsEnter    true: Enter inside the field is its own (a newline, a
//                 tag), not the dialog's submit; ctrl/cmd+Enter still is
//
// The field calls `ctx.changed()` when the user edits it — the dialog then
// reads `get()`, marks the field typed-into (a `compute` stops overwriting
// it) and re-runs the form — and `ctx.resized()` when its height changes,
// so the dialog can grow to fit. Everything else — `label`, `required`
// (an empty string is missing), `showWhen`, `value`, `compute`, `remember`,
// the submit — is the dialog's, as for any field. Built-in type names are
// refused; registering a name again replaces the factory, with a warning.
export function registerFieldType(name, factory) {
  if (FIELD_TYPES.includes(name)) {
    console.warn(`[mkui] registerFieldType: "${name}" is a built-in field type; not registered`);
    return;
  }
  if (typeof factory !== "function") {
    console.warn(`[mkui] registerFieldType: "${name}" needs a factory function; not registered`);
    return;
  }
  if (fieldTypes.has(name)) console.warn(`[mkui] registerFieldType: "${name}" registered again; the new factory replaces the old`);
  fieldTypes.set(name, factory);
}
export function getFieldType(name) { return fieldTypes.get(name); }
export function getWidget(name) { return widgetTypes.get(name); }
export function getPaneType(name) { return paneTypes.get(name); }
// The keys a pane type declared, as a Set, or null for one that declared none.
export function getPaneTypeKeys(name) { return paneTypeKeys.get(name) ?? null; }

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
