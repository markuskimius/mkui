// Table linking — the hub every broadcasting table publishes into and every
// listening table follows. DOM-free, so the mechanics are testable on
// their own (tests/links.test.js).
//
// A broadcast is a map of names to value lists: a table configured with
// `link.broadcast = { order_id = "id" }` publishes `{ order_id: [...] }` —
// the distinct `id` values of the rows its selection implies — and `null`
// under a name once nothing is selected. A listener subscribes to a name
// and turns each delivery into an include filter on its own column.
//
// The hub retains the last value per name, so a listener that opens after
// the selection was made (a pane restored from a layout, a table whose
// data arrives late) can ask `current(name)` and catch up. Every value is
// mirrored into app state at `link.<name>`, where a statusbar widget or an
// `enable.when` can read it.
//
// Delivery is queued: a publish made while another is being delivered (a
// listener that also broadcasts, reacting to a filter change) waits its
// turn, so no callback runs inside another and the order of events stays
// the order of publishes. A chain that never settles — two tables feeding
// each other — is cut at MAX_CHAIN deliveries per flush, with a warning.

export const MAX_CHAIN = 64;

// Two value lists are the same broadcast when they hold the same strings
// in the same order (null matches only null).
export function sameValues(a, b) {
  if (a == null || b == null) return a == null && b == null;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export class LinkHub {
  // `state`: a State (or a function returning one) to mirror values into;
  // optional.
  constructor(state = null) {
    this._state = state;
    this._retained = new Map(); // name -> { values, source }
    this._subs = new Map();     // name -> Set<fn(values, source, name)>
    this._queue = [];
    this._flushing = false;
    this._warned = false;
  }

  get state() {
    return typeof this._state === "function" ? this._state() : this._state;
  }

  // Publish `map` (name -> array of values, or null) on behalf of `source`.
  // A name whose retained value is the same list from the same source is
  // skipped, so tables can re-announce freely. Returns the names delivered.
  publish(source, map) {
    if (!map || typeof map !== "object") return [];
    const changed = [];
    for (const [name, raw] of Object.entries(map)) {
      const values = raw == null ? null : Array.isArray(raw) ? raw.map(String) : [String(raw)];
      const cur = this._retained.get(name);
      if (values == null && !cur) continue; // nothing to retract
      if (cur && cur.source === source && sameValues(cur.values, values)) continue;
      // Another source's null doesn't clear a live broadcast: only the
      // source that set a value may retract it.
      if (values == null && cur && cur.source !== source && cur.values != null) continue;
      if (values == null) this._retained.delete(name);
      else this._retained.set(name, { values, source });
      changed.push(name);
      this._queue.push({ name, values, source });
    }
    if (changed.length) this._flush();
    return changed;
  }

  // Retract everything `source` currently holds (a pane closing).
  retract(source) {
    const map = {};
    for (const [name, r] of this._retained) if (r.source === source) map[name] = null;
    return this.publish(source, map);
  }

  _flush() {
    if (this._flushing) return;
    this._flushing = true;
    let n = 0;
    try {
      while (this._queue.length) {
        if (++n > MAX_CHAIN) {
          if (!this._warned) {
            this._warned = true;
            console.warn(`[mkui] table links: broadcast chain cut after ${MAX_CHAIN} deliveries — two tables may be feeding each other`);
          }
          this._queue.length = 0;
          break;
        }
        const { name, values, source } = this._queue.shift();
        const st = this.state;
        if (st) st.set(`link.${name}`, values == null ? null : [...values]);
        const subs = this._subs.get(name);
        if (!subs) continue;
        for (const fn of [...subs]) {
          try { fn(values, source, name); }
          catch (e) { console.warn(`[mkui] table links: listener for '${name}' failed: ${e.message}`); }
        }
      }
    } finally {
      this._flushing = false;
    }
  }

  // Follow `name`; returns an unsubscribe function. Nothing fires at once —
  // ask `current` to catch up.
  subscribe(name, fn) {
    if (!this._subs.has(name)) this._subs.set(name, new Set());
    this._subs.get(name).add(fn);
    return () => {
      const s = this._subs.get(name);
      if (!s) return;
      s.delete(fn);
      if (!s.size) this._subs.delete(name);
    };
  }

  // The retained `{ values, source }` for a name, or null.
  current(name) {
    const r = this._retained.get(name);
    return r ? { values: [...r.values], source: r.source } : null;
  }

  // Names with a live broadcast, in first-published order.
  names() {
    return [...this._retained.keys()];
  }
}
