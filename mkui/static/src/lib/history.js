// Versioned tables — mkio's history conventions, and the pure logic over a
// record's recorded versions. DOM-free, like layout/tree.js, so the history
// pane, the undo/redo gating, and the table's column rules all read the
// same shapes from one place (tests/history.test.js).
//
// mkio 0.3.0 records every version of a row from a `versioned = true` table
// in a companion `<table>__history`, keyed (base pk…, `_mkio_version`).
// Each history row carries the version, the op that wrote it, the
// transaction ref, the user, the service it came through, and the source
// columns as they stood at that version.
//
// The base row's own `_mkio_version` is a *cursor* into that chain:
//
//     v1 ── v2 ── v3 ── v4        top = 4
//                 ▲               cursor = 3, so v4 is redo, still reachable
//
// Versions above the cursor are the redo branch — an edit made there
// discards them. An absent base row means the cursor sits at 0: the row was
// undone past version 1, and redo can rebuild it. See mkio's README,
// "Versioned Tables".
//
// mkui never reaches a history table directly: mkio does not advertise one
// and no service exists for it until the application writes one. Everything
// here therefore works on rows some *configured* service returned, whatever
// it chose to call the columns — hence the field resolution in parseChain.

/** Reserved suffix mkio gives a versioned table's history table. */
export const HISTORY_SUFFIX = "__history";

/** Name of the history table recording changes to `table`. */
export function historyTable(table, suffix = HISTORY_SUFFIX) {
  return `${table}${suffix}`;
}

/** Whether `name` is a history table by the naming convention. */
export function isHistoryTable(name, suffix = HISTORY_SUFFIX) {
  return typeof name === "string" && name.length > suffix.length && name.endsWith(suffix);
}

// The columns mkio writes on a history row, by their logical role. A
// service may rename them on the way out (a `reply` block mapping
// `version = "_mkio_version"`), which is what `history.fields` and
// parseChain's bare-name fallback are for.
export const MKIO_FIELDS = {
  version: "_mkio_version",
  op:      "_mkio_op",
  ref:     "_mkio_ref",
  user:    "_mkio_user",
  service: "_mkio_service",
};

// mkio's identity fields (`_mkio_row`, `_mkio_topic`) are plumbing and stay
// hidden always. These five are data — a version counter, an audit tape's
// op and user, a stream row's ref — so a table shows one when its config
// names it in `columns` or `visible`, and never otherwise.
export const SHOWABLE_COLUMNS = new Set(Object.values(MKIO_FIELDS));

// Header text for those columns, so a config that names one need not label
// it too. `labels` in the pane spec still wins.
export const MKIO_LABELS = {
  _mkio_version: "Version",
  _mkio_op:      "Op",
  _mkio_ref:     "Ref",
  _mkio_user:    "User",
  _mkio_service: "Service",
};

/**
 * The history-related half of an `_mkio` reply: which tables the server
 * records, and the suffix their history tables take.
 *
 * Returns null when the reply cannot say — an older server, or the limited
 * reply an unauthenticated client gets from a server with auth enabled, in
 * which case the caller must leave what it already knows alone rather than
 * conclude that nothing is versioned.
 */
export function historyCapabilities(info) {
  if (!info || typeof info !== "object" || !Array.isArray(info.versioned)) return null;
  const suffix = typeof info.history_suffix === "string" && info.history_suffix
    ? info.history_suffix : HISTORY_SUFFIX;
  return { versioned: info.versioned.filter((t) => typeof t === "string" && t), suffix };
}

/**
 * The primary key columns of an `_mkio` table-schema reply (`{ table }`),
 * in declaration order — how a client learns what identifies a record when
 * the config did not say.
 */
export function pkFromSchema(row) {
  return (row?.columns ?? []).filter((c) => c && c.pk).map((c) => c.name);
}

/* ── The `history` pane-spec block ─────────────────────────────────────── */

const SPEC_KEYS = new Set([
  "table", "key", "versions", "state", "feed", "asOf", "undo", "redo",
  "columns", "fields", "confirm",
]);

const strList = (v) => (typeof v === "string" ? (v ? [v] : []) : Array.isArray(v) ? v : null);

/**
 * Normalize a pane's `history` block — the one place a table is told where
 * its record history lives:
 *
 *   [panes.orders.history]
 *   table    = "orders"                        # base table (validated against the server)
 *   key      = ["id"]                          # primary key columns
 *   versions = "order_versions"                # reqrep: one record's chain
 *   state    = "order_state"                   # reqrep: { current, top }
 *   feed     = "order_history"                 # query/stream: the audit tape
 *   asOf     = "order_as_of"                   # reqrep: the table at a moment
 *   undo     = { service = "orders", op = "undo" }
 *   redo     = "orders"                        # op defaults to the direction
 *   columns  = ["qty", "price", "status"]      # what to diff; default: the pane's
 *   fields   = { version = "v" }               # if the service renamed a meta column
 *   confirm  = true                            # confirm before undo/redo
 *
 * Every key is optional and a bad one is dropped with a warning rather than
 * taking the block down with it: a table with a broken `undo` still shows
 * its history. Returns null when there is no block at all.
 */
export function parseHistorySpec(spec, opts = {}) {
  const warn = opts.warn ?? ((msg) => console.warn(`[mkui-history] ${msg}`));
  if (spec == null || spec === "" || spec === false) return null;
  if (typeof spec !== "object" || Array.isArray(spec)) {
    warn("bad history: expected a table of { versions, undo, … }");
    return null;
  }

  const out = {
    table: null, key: null, versions: null, state: null, feed: null,
    asOf: null, undo: null, redo: null, columns: null, fields: {}, confirm: true,
  };

  for (const k of Object.keys(spec)) if (!SPEC_KEYS.has(k)) warn(`bad history: unknown key '${k}'`);

  const service = (key) => {
    const v = spec[key];
    if (v == null || v === "") return null;
    if (typeof v !== "string") { warn(`bad history.${key}: expected a service name`); return null; }
    return v;
  };
  out.versions = service("versions");
  out.state = service("state");
  out.feed = service("feed");

  // `asOf = "order_as_of"`, or `{ service, param = "as_of" }` when the
  // service names its cutoff something else.
  if (spec.asOf != null && spec.asOf !== "" && spec.asOf !== false) {
    const v = spec.asOf;
    if (typeof v === "string") out.asOf = { service: v, param: "as_of" };
    else if (typeof v === "object" && !Array.isArray(v) && typeof v.service === "string" && v.service) {
      const param = v.param == null || v.param === "" ? "as_of" : v.param;
      if (typeof param !== "string") warn("bad history.asOf: param must be a name");
      else out.asOf = { service: v.service, param };
    } else warn("bad history.asOf: expected a service name or { service, param }");
  }

  if (spec.table != null && spec.table !== "") {
    if (typeof spec.table === "string") out.table = spec.table;
    else warn("bad history.table: expected a table name");
  }

  if (spec.key != null && spec.key !== "") {
    const cols = strList(spec.key);
    if (cols && cols.length && cols.every((c) => typeof c === "string" && c)) out.key = cols;
    else warn("bad history.key: expected a column name or a list of them");
  }

  if (spec.columns != null && spec.columns !== "") {
    const cols = strList(spec.columns);
    if (cols && cols.every((c) => typeof c === "string" && c)) out.columns = cols;
    else warn("bad history.columns: expected a column name or a list of them");
  }

  // `undo = "orders"` or `undo = { service = "orders", op = "undo", label
  // = "Undo" }` — the op defaults to the direction's own name, which is
  // what mkio's own examples call it, and the label to its capitalised
  // form (the button is drawn only when the direction is configured).
  for (const dir of ["undo", "redo"]) {
    const v = spec[dir];
    if (v == null || v === "" || v === false) continue;
    const cap = dir[0].toUpperCase() + dir.slice(1);
    if (typeof v === "string") { out[dir] = { service: v, op: dir, label: cap }; continue; }
    if (typeof v !== "object" || Array.isArray(v) || typeof v.service !== "string" || !v.service) {
      warn(`bad history.${dir}: expected a service name or { service, op }`);
      continue;
    }
    const op = v.op == null || v.op === "" ? dir : v.op;
    if (typeof op !== "string") { warn(`bad history.${dir}: op must be a name`); continue; }
    let label = v.label == null || v.label === "" ? cap : v.label;
    if (typeof label !== "string") { warn(`bad history.${dir}: label must be text`); label = cap; }
    out[dir] = { service: v.service, op, label };
  }

  // Only the overrides are kept: a field left unnamed is resolved against
  // the data (parseChain), which accepts either the `_mkio_` column or the
  // bare name a service's `reply` block is likely to have given it.
  if (spec.fields != null && spec.fields !== "") {
    if (typeof spec.fields !== "object" || Array.isArray(spec.fields)) {
      warn("bad history.fields: expected a table of role = column");
    } else {
      for (const [role, col] of Object.entries(spec.fields)) {
        if (!(role in MKIO_FIELDS)) { warn(`bad history.fields: unknown field '${role}'`); continue; }
        if (typeof col !== "string" || !col) { warn(`bad history.fields.${role}: expected a column name`); continue; }
        out.fields[role] = col;
      }
    }
  }

  if (spec.confirm != null && spec.confirm !== "") {
    if (typeof spec.confirm === "boolean") out.confirm = spec.confirm;
    else warn("bad history.confirm: expected true or false");
  }

  return out;
}

/* ── A record's chain of versions ──────────────────────────────────────── */

// Where to look for each meta field: the name the config gave, else mkio's
// own column, else the bare name a service's `reply` block tends to use
// (`version = "_mkio_version"` renames it to `version`).
function fieldCandidates(role, fields) {
  const named = fields?.[role];
  return named ? [named] : [MKIO_FIELDS[role], role];
}

function pick(row, names) {
  for (const n of names) if (n in row) return row[n];
  return undefined;
}

/**
 * Turn the rows a `versions` service returned into one record's chain.
 *
 * Rows may arrive in any order and under either naming (see
 * fieldCandidates); the result is ascending by version, with the source
 * columns split out from the meta ones:
 *
 *   { versions, byVersion, top, bottom, gaps, columns, dropped }
 *
 * `gaps` are the runs of missing versions between the lowest and highest
 * recorded — `mkio archive` moves old versions out to CSV, so a chain is
 * contiguous only until someone archives it, and undo cannot step across
 * the hole. A row without a usable version number counts in `dropped`.
 */
export function parseChain(rows, opts = {}) {
  const fields = opts.fields ?? {};
  const cand = {};
  for (const role of Object.keys(MKIO_FIELDS)) cand[role] = fieldCandidates(role, fields);
  const meta = new Set();
  for (const names of Object.values(cand)) for (const n of names) meta.add(n);

  const byVersion = new Map();
  const columns = [];
  let dropped = 0;

  for (const row of rows ?? []) {
    if (!row || typeof row !== "object") { dropped++; continue; }
    const raw = pick(row, cand.version);
    const version = typeof raw === "number" ? raw : parseInt(raw, 10);
    if (!Number.isFinite(version) || version < 1) { dropped++; continue; }
    const values = {};
    for (const [k, v] of Object.entries(row)) {
      if (meta.has(k)) continue;
      values[k] = v;
      if (!columns.includes(k)) columns.push(k);
    }
    byVersion.set(version, {
      version,
      op:      pick(row, cand.op) ?? null,
      ref:     pick(row, cand.ref) ?? null,
      user:    pick(row, cand.user) ?? null,
      service: pick(row, cand.service) ?? null,
      values,
      row,
    });
  }

  const versions = [...byVersion.values()].sort((a, b) => a.version - b.version);
  const bottom = versions.length ? versions[0].version : 0;
  const top = versions.length ? versions[versions.length - 1].version : 0;
  const gaps = [];
  for (let i = 1; i < versions.length; i++) {
    const prev = versions[i - 1].version, here = versions[i].version;
    if (here > prev + 1) gaps.push([prev + 1, here - 1]);
  }
  return { versions, byVersion, top, bottom, gaps, columns, dropped };
}

/**
 * Where the live row sits in its chain, and which way it can step.
 *
 * `current` is the base row's `_mkio_version` — null, undefined, or 0 when
 * the row is absent, which mkio reads as a cursor at 0 (undone past version
 * 1, and redo will rebuild it).
 *
 * Undo at version 1 deletes the row and needs nothing recorded below it;
 * above that it needs the previous version to still be there, which an
 * archive may have taken. Redo needs the next one. Either way the version
 * the row sits on must itself be recorded — an empty or unloaded chain
 * claims nothing.
 */
export function cursorOf(chain, current) {
  const at = typeof current === "number" ? current : parseInt(current, 10);
  const cur = Number.isFinite(at) && at > 0 ? at : 0;
  let ahead = 0, behind = 0;
  for (const v of chain.versions) {
    if (v.version > cur) ahead++;
    else if (v.version < cur) behind++;
  }
  return {
    current: cur,
    top: chain.top,
    at: chain.byVersion.get(cur) ?? null,
    canUndo: cur >= 1 && chain.byVersion.has(cur) && (cur === 1 || chain.byVersion.has(cur - 1)),
    canRedo: chain.byVersion.has(cur + 1),
    ahead,
    behind,
  };
}

/* ── Diffing two versions ──────────────────────────────────────────────── */

const isEmpty = (v) => v == null || v === "";

// SQLite hands the same number back as 1 or "1.0" depending on the column
// and the service that shaped it, and a diff that reported those as a
// change would cry wolf on every version. Numbers compare as numbers,
// everything else as text.
const numish = (v) =>
  typeof v === "number" ? Number.isFinite(v)
  : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v));

export function sameValue(a, b) {
  if (isEmpty(a) || isEmpty(b)) return isEmpty(a) && isEmpty(b);
  if (numish(a) && numish(b)) return Number(a) === Number(b);
  return String(a) === String(b);
}

const valuesOf = (entry) => (entry && typeof entry === "object" ? entry.values ?? entry : null);

/**
 * Field-by-field difference between two versions, `from` → `to`. Either
 * side may be null — the state before an insert, or after an undo removed
 * the row — which reads as every field being set or cleared.
 *
 * Returns one entry per column, unchanged ones included so the caller can
 * choose to show them:
 *
 *   { col, from, to, kind }   kind: "same" | "changed" | "set" | "cleared"
 *
 * `columns` fixes the order and the membership; without it, the columns of
 * `from` then whatever `to` adds.
 */
export function diffVersions(from, to, columns = null) {
  const a = valuesOf(from) ?? {};
  const b = valuesOf(to) ?? {};
  let cols = columns;
  if (!cols) {
    cols = Object.keys(a);
    for (const k of Object.keys(b)) if (!cols.includes(k)) cols.push(k);
  }
  return cols.map((col) => {
    const x = a[col], y = b[col];
    let kind;
    if (sameValue(x, y)) kind = "same";
    else if (isEmpty(x)) kind = "set";
    else if (isEmpty(y)) kind = "cleared";
    else kind = "changed";
    return { col, from: x, to: y, kind };
  });
}

/** The entries of a diff that actually moved. */
export function changedOnly(diff) {
  return diff.filter((d) => d.kind !== "same");
}

/**
 * Per-field provenance: for each column, the version that last gave it the
 * value it has now, and who wrote it.
 *
 *   { qty: { version, ref, user, op, from, to }, price: null, … }
 *
 * null for a column that has been empty throughout. Walks up to the cursor
 * by default (`upto`), so a row sitting below its top version is blamed as
 * it currently reads, not as its redo branch would leave it.
 */
export function blame(chain, opts = {}) {
  const upto = opts.upto ?? chain.top;
  const cols = opts.columns ?? chain.columns;
  const out = {};
  for (const col of cols) out[col] = null;
  let prev = null;
  for (const entry of chain.versions) {
    if (entry.version > upto) break;
    for (const col of cols) {
      const now = entry.values[col];
      const before = prev ? prev.values[col] : undefined;
      if (sameValue(before, now)) continue; // an unset column stays unblamed
      out[col] = {
        version: entry.version, ref: entry.ref, user: entry.user, op: entry.op,
        from: before, to: now,
      };
    }
    prev = entry;
  }
  return out;
}
