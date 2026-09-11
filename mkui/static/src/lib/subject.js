// The record a window is about — its *subject* — and where that comes
// from.
//
// A table shows many records; a detail window shows one, and the
// interesting question is which. Four answers, one per `record` mode:
//
//   record.follow = "orders"              another pane's selection
//   record.listen = { order_id = "id" }   a name on the link hub
//   record.state  = "sel.order"           a row published into app state
//   record.key    = { id = 4711 }         pinned, forever
//
// `listen` is the one that makes a detail window a first-class citizen of
// table linking (lib/links.js): the orders table broadcasts its `id` as
// `order_id`, a table listening for that name filters a column by it, and
// a detail window listening for the same name *becomes about that record*.
// The hub retains the last value per name, so a window opened after the
// selection was made catches up at once.
//
// Two switches sit over all of it. `listening = false` — the pin — freezes
// the window on the record it holds: deliveries keep arriving and are
// ignored, which is what "pin this while I go and click elsewhere" means.
// `retain` decides what an empty delivery does while live: by default the
// window empties with the selection, and `retain = true` keeps the last
// record on show.
//
// Everything here is DOM-free bar `attachRecord` at the bottom, so the
// mode logic is testable on its own (tests/subject.test.js).

// A hub value is always a string (LinkHub stringifies), but the column it
// keys is often a number, and a quoted number matches nothing server-side.
// A value is taken as a number only when it round-trips exactly, so an id
// like "007" or "1e5" stays the string it was written as.
export function coerce(value, type) {
  if (value == null) return null;
  const s = String(value);
  if (type === "string") return s;
  if (type === "number") {
    const n = Number(s);
    return Number.isFinite(n) ? n : s;
  }
  if (type === "boolean") return s === "true" ? true : s === "false" ? false : s;
  const n = Number(s);
  return Number.isFinite(n) && String(n) === s ? n : s;
}

const isMap = (v) => v && typeof v === "object" && !Array.isArray(v);
const TYPES = ["string", "number", "boolean", "auto"];
export const MODES = ["follow", "listen", "state", "key"];

// Parse a pane's `record` block. Throws on a bad one; the caller warns
// `bad record` and changes nothing, as `bad link` and `bad sort` do.
export function parseRecordSpec(spec) {
  const out = {
    mode: null, follow: null, listen: {}, state: null, key: null,
    retain: false, listening: true, title: null,
  };
  if (spec == null || spec === "") return out;
  // `record = "orders"` — the short way to say `record.follow = "orders"`.
  if (typeof spec === "string") {
    out.mode = "follow";
    out.follow = spec;
    return out;
  }
  if (!isMap(spec)) throw new Error("expected a pane id or { follow | listen | state | key, retain, listening, title }");

  const given = MODES.filter((m) => spec[m] != null && spec[m] !== "");
  if (given.length > 1) throw new Error(`${given.join(" and ")} cannot both say which record: pick one`);

  if (spec.follow != null && spec.follow !== "") {
    if (typeof spec.follow !== "string") throw new Error("follow: expected a pane id");
    out.mode = "follow";
    out.follow = spec.follow;
  } else if (spec.listen != null && spec.listen !== "") {
    if (!isMap(spec.listen)) throw new Error("listen must map names to key columns");
    for (const [name, v] of Object.entries(spec.listen)) {
      if (v == null || v === "") continue; // a null entry removes under merge, is nothing otherwise
      let column, type = "auto";
      if (typeof v === "string") column = v;
      else if (isMap(v) && typeof v.column === "string" && v.column) {
        column = v.column;
        if (v.type != null && v.type !== "") type = v.type;
      } else throw new Error(`listen.${name}: expected a column name or { column, type }`);
      if (!TYPES.includes(type)) throw new Error(`listen.${name}: bad type '${type}': use ${TYPES.join(", ")}`);
      out.listen[name] = { column, type };
    }
    if (Object.keys(out.listen).length) out.mode = "listen";
  } else if (spec.state != null && spec.state !== "") {
    if (typeof spec.state !== "string") throw new Error("state: expected a state path");
    out.mode = "state";
    out.state = spec.state;
  } else if (spec.key != null && spec.key !== "") {
    if (!isMap(spec.key)) throw new Error("key must map key columns to values");
    out.mode = "key";
    out.key = { ...spec.key };
  }

  for (const flag of ["retain", "listening"]) {
    if (spec[flag] == null || spec[flag] === "") continue;
    if (typeof spec[flag] !== "boolean") throw new Error(`${flag} must be true or false`);
    out[flag] = spec[flag];
  }
  if (spec.title != null && spec.title !== "") {
    if (typeof spec.title !== "string") throw new Error("title: expected a template");
    out.title = spec.title;
  }
  return out;
}

// The parsed form back as config — what a saved layout carries, and what
// `getPaneRecord` answers. The mode's own key only; the current record is
// never config (it comes back from the live broadcast).
export function recordSpecToConfig(s) {
  const out = { retain: s.retain, listening: s.listening };
  if (s.title) out.title = s.title;
  if (s.mode === "follow") out.follow = s.follow;
  else if (s.mode === "listen") {
    const listen = {};
    for (const [n, e] of Object.entries(s.listen))
      listen[n] = e.type === "auto" ? e.column : { column: e.column, type: e.type };
    out.listen = listen;
  } else if (s.mode === "state") out.state = s.state;
  else if (s.mode === "key") out.key = { ...s.key };
  return out;
}

// Merge `spec` over the parsed `base`, the way `setLink({...}, { merge })`
// does: only the keys given change, a null `listen` entry drops that name,
// and naming a different mode switches to it.
export function mergeRecordSpec(base, spec) {
  if (spec == null || spec === "" || typeof spec === "string") return parseRecordSpec(spec);
  if (!isMap(spec)) throw new Error("expected { follow | listen | state | key, retain, listening, title }");
  const next = recordSpecToConfig(base);
  const names = MODES.filter((m) => m in spec);
  // A mode key that is present but empty clears that mode; a different
  // mode replaces the current one outright.
  if (names.length) for (const m of MODES) delete next[m];
  if (isMap(spec.listen) && base.mode === "listen" && names.length === 1 && names[0] === "listen") {
    const listen = recordSpecToConfig(base).listen ?? {};
    for (const [n, v] of Object.entries(spec.listen)) {
      if (v == null || v === "") delete listen[n];
      else listen[n] = v;
    }
    if (Object.keys(listen).length) next.listen = listen;
  } else {
    for (const m of names) if (spec[m] != null && spec[m] !== "") next[m] = spec[m];
  }
  for (const flag of ["retain", "listening"]) if (typeof spec[flag] === "boolean") next[flag] = spec[flag];
  if ("title" in spec) {
    if (spec.title == null || spec.title === "") delete next.title;
    else next.title = spec.title;
  }
  return parseRecordSpec(next);
}

// Two subjects are the same when they are about the same record, read the
// same way. Rows compare by identity — a live update replaces the object,
// and that is a change worth re-reading.
export function sameSubject(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.from !== b.from || a.of !== b.of) return false;
  // A key is the record's identity, whatever object carries it, so two
  // deliveries of `4711` are the same subject. Without one — a row
  // followed from another pane — identity is the row object itself: a
  // live update replaces it, and that is worth re-reading.
  if (a.key && b.key) {
    const ak = Object.keys(a.key), bk = Object.keys(b.key);
    if (ak.length !== bk.length) return false;
    for (const k of ak) if (String(a.key[k]) !== String(b.key[k])) return false;
    return true;
  }
  return a.row === b.row;
}

// Follows one of the four sources and reports the record on show.
//
// The consumer supplies what it has: `hub` (an App's LinkHub) for listen,
// `state` (a State) for state, and `panes` — `{ on(id, fn), rows(id) }` —
// for follow. Nothing is read until `start()`, and `stop()` releases
// every subscription; a pane closing and reopening does both.
export class RecordFollower {
  constructor({ spec, hub = null, state = null, panes = null, warn = null } = {}) {
    this.spec = spec ?? parseRecordSpec(null);
    this._hub = hub;
    this._state = state;
    this._panes = panes;
    this._warn = warn ?? ((m) => console.warn(`[mkui] record: ${m}`));
    this._subs = [];
    this._listeners = new Set();
    this._record = null;
    this._started = false;
  }

  get record() { return this._record; }
  get mode() { return this.spec.mode; }
  get listening() { return this.spec.listening; }

  // The names this window is waiting on, so an empty one can say what for.
  names() { return Object.keys(this.spec.listen); }

  on(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  // Listeners are told *why*, because the answers differ: a new record
  // means re-read everything, a refresh means re-read the same record,
  // and a spec change means only the controls moved.
  _emit(why) { for (const fn of [...this._listeners]) fn(this._record, why); }

  // Put a record on show, or null. `force` re-emits even when it is the
  // same one (a manual refresh).
  _put(rec, force = false) {
    const same = sameSubject(rec, this._record);
    if (!force && same) return false;
    this._record = rec;
    this._emit(same ? "refresh" : "change");
    return true;
  }

  // A delivery arrived, or a source went empty. While frozen, or when an
  // empty delivery meets `retain`, the current record stays.
  _deliver(rec) {
    if (!this.spec.listening) return false;
    if (rec == null && this.spec.retain && this._record) return false;
    return this._put(rec);
  }

  // What a source read hands over. A forced read (`refresh`) re-emits
  // whatever the window should be showing — which is not always what the
  // source says: a pinned window holds its record, and so does one with
  // `retain` whose source has gone quiet.
  _offer(rec, force) {
    if (!force) return this._deliver(rec);
    const hold = this._record && (!this.spec.listening || (rec == null && this.spec.retain));
    return this._put(hold ? this._record : rec, true);
  }

  start() {
    if (this._started) return this;
    this._started = true;
    const s = this.spec;
    if (s.mode === "listen" && this._hub) {
      for (const name of Object.keys(s.listen))
        this._subs.push(this._hub.subscribe(name, () => this._readHub()));
      this._readHub();
    } else if (s.mode === "follow" && this._panes) {
      const off = this._panes.on?.(s.follow, () => this._readPane());
      if (off) this._subs.push(off);
      this._readPane();
    } else if (s.mode === "state" && this._state) {
      // State.subscribe fires at once, which is the catch-up.
      this._subs.push(this._state.subscribe(s.state, (v) => this._readState(v)));
    } else if (s.mode === "key") {
      this._put({ key: { ...s.key }, row: { ...s.key }, of: 1, from: "key" });
    }
    return this;
  }

  stop() {
    for (const off of this._subs) { try { off(); } catch { /* already gone */ } }
    this._subs = [];
    this._started = false;
    return this;
  }

  // Re-read the source and re-emit even if nothing moved.
  refresh() {
    const s = this.spec;
    if (s.mode === "listen") this._readHub(true);
    else if (s.mode === "follow") this._readPane(true);
    else if (s.mode === "state") this._readState(this._state?.get(s.state), true);
    else this._put(this._record, true);
  }

  // Replace the configuration wholesale (`merge` overlays it) and start
  // following whatever it now names. The record on show survives a change
  // that does not contradict it — a pause, a retain flag — and a new
  // source speaks for itself at once.
  setSpec(spec, { merge = false } = {}) {
    let next;
    try {
      next = merge ? mergeRecordSpec(this.spec, spec) : parseRecordSpec(spec);
    } catch (e) {
      this._warn(`bad record: ${e.message}`);
      return false;
    }
    const running = this._started;
    if (running) this.stop();
    const wasFrozen = !this.spec.listening;
    this.spec = next;
    if (running) this.start();
    // Coming off the pin re-reads the source: the window was showing what
    // it was frozen on, and the world has moved.
    if (running && wasFrozen && next.listening) this.refresh();
    this._emit("spec");
    return true;
  }

  // Point the window at a record by key, whatever the mode — the
  // `record.show` action, and what a manual pick does. It stands until the
  // next delivery, exactly as a filter the user edits does.
  set(key) {
    if (key == null) return this._put(null);
    const k = isMap(key) ? { ...key } : null;
    if (!k) { this._warn("record.show: expected a key map"); return false; }
    return this._put({ key: k, row: { ...k }, of: 1, from: "manual" }, true);
  }

  /* ── The sources ──────────────────────────────────────────────────── */

  // Every listened name must have a value: a composite key is not a key
  // until all of it has arrived.
  _readHub(force = false) {
    const s = this.spec;
    const key = {};
    let of = 1, any = false;
    for (const [name, e] of Object.entries(s.listen)) {
      const cur = this._hub?.current(name);
      const values = cur?.values ?? null;
      if (!values || !values.length) { this._offer(null, force); return; }
      key[e.column] = coerce(values[0], e.type);
      of = Math.max(of, values.length);
      any = true;
    }
    if (!any) { this._offer(null, force); return; }
    this._offer({ key, row: { ...key }, of, from: "listen" }, force);
  }

  _readPane(force = false) {
    const rows = this._panes?.rows?.(this.spec.follow) ?? [];
    const row = rows[0] ?? null;
    this._offer(row ? { key: null, row, of: rows.length, from: "follow" } : null, force);
  }

  _readState(v, force = false) {
    const row = isMap(v) ? v : null;
    this._offer(row ? { key: null, row, of: 1, from: "state" } : null, force);
  }
}

// What the chip says: `{ text, title, on, mode }`.
export function describeRecord(spec, record = null) {
  const on = spec.listening;
  // One window, one record: when the source names several, the chip says
  // which of them is on show.
  const of = record?.of > 1 ? `\n${record.of} records ${record.from === "listen" ? "broadcast" : "selected"} — showing the first` : "";
  if (spec.mode === "listen") {
    const names = Object.keys(spec.listen);
    const list = names.length > 3 ? `${names.length} names` : names.join(", ");
    const detail = names.map((n) => `${spec.listen[n].column} ← ${n}`).join("\n");
    return {
      mode: "listen", on, text: `Listen: ${list}`,
      title: `Listening ${on ? "on" : "off — pinned to this record"}\n${detail}${of}`,
    };
  }
  if (spec.mode === "follow") {
    return {
      mode: "follow", on, text: `Follows: ${spec.follow}`,
      title: (on ? `Following the selection in '${spec.follow}'` : "Pinned to this record") + of,
    };
  }
  if (spec.mode === "state") {
    return { mode: "state", on, text: `State: ${spec.state}`,
             title: (on ? `Reading the record from state.${spec.state}` : "Pinned to this record") + of };
  }
  if (spec.mode === "key") {
    const text = Object.values(spec.key).join(" · ");
    return { mode: "key", on: true, text: `Pinned: ${text}`, title: "This window is configured for one record" };
  }
  return null;
}

// A value as an mkio filter expression writes it. Numbers and booleans go
// bare, anything else as a quoted string — the only thing this ever
// builds is the key of the record a window is showing.
export function exprLiteral(v) {
  if (v == null) return "NULL";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return `'${String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

// One record's slice of a service, server-side: `id == 4711`, and every
// column of a composite key ANDed together.
export function recordFilter(key) {
  return Object.entries(key ?? {}).map(([c, v]) => `${c} == ${exprLiteral(v)}`).join(" && ");
}

/* ── The DOM edge ───────────────────────────────────────────────────── */

// Build a follower for a pane and install the `_record` hook on its
// element — the whole of what a custom detail pane has to do:
//
//   const follower = attachRecord(paneEl, spec.record, app, (rec) => render(rec));
//   follower.start();
//
// It is returned *unstarted*, and deliberately: the first read can land
// synchronously (a broadcast the hub already retains), and a callback
// that reaches back for `follower` would find the caller's variable
// unassigned. Start it once everything it may touch exists.
//
// The hook is what `workspace.setPaneRecord`, the `record.show` /
// `record.follow` actions, the control channel and saved layouts all
// speak to, so a pane type written by an application gets every one of
// them from this call.
export function attachRecord(paneEl, spec, app, onRecord, opts = {}) {
  const warn = opts.warn ?? ((m) => console.warn(`[mkui] record: ${m}`));
  // `opts.ws` lets a pane hand over the workspace it already resolved
  // (and lets a test hand over a stand-in); the default is the one this
  // pane sits in.
  let parsed;
  try {
    parsed = parseRecordSpec(spec);
  } catch (e) {
    warn(`bad record: ${e.message}`);
    parsed = parseRecordSpec(null);
  }
  const ws = opts.ws ?? (() => paneEl?.closest?.("mkui-workspace") ?? null);
  const follower = new RecordFollower({
    spec: parsed,
    hub: app?.links ?? null,
    state: app?.state ?? null,
    panes: {
      on: (id, fn) => ws()?.onPaneSelection?.(id, fn) ?? null,
      rows: (id) => ws()?.paneRows?.(id) ?? [],
    },
    warn,
  });
  if (onRecord) follower.on(onRecord);
  if (paneEl) {
    paneEl._record = {
      get: () => follower.record,
      set: (key) => follower.set(key),
      on: (fn) => follower.on(fn),
      follow: (s, o) => follower.setSpec(s, o),
      config: () => recordSpecToConfig(follower.spec),
      refresh: () => follower.refresh(),
      follower,
    };
  }
  return follower;
}
