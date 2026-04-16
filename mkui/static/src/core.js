// Reactive state store, window-type registry, and the central App object
// that everything else hangs off of.
//
// The state store is intentionally tiny: it's a Proxy over a plain object,
// supports dot-path get/set, and notifies subscribers per path.

const widgetTypes = new Map();
const paneTypes = new Map();

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
  }
}

// The App is the public JS API. In standalone mode <mkui-app> creates one
// from a config URL. In library mode users construct one directly.
export class App {
  constructor(config = {}) {
    this.config = config;
    this.state = new State(config.state ?? {});
    this.actions = new Map();
    this._listeners = new Set();
    this._element = null;
  }

  registerAction(name, fn) {
    this.actions.set(name, fn);
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
