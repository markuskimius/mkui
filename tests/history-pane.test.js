// Run with: node --test tests/history-pane.test.js
//
// The `mkio-history` pane: a record's recorded versions and the diff
// between two of them. Browser globals are stubbed the way table.test.js
// does it, but this pane needs far less of the DOM — no measuring, no
// observers, no rAF.
import { test } from "node:test";
import assert from "node:assert/strict";

/* ── Minimal DOM ──────────────────────────────────────────────────────── */

function mockEl(tag) {
  const el = {
    tagName: (tag ?? "").toUpperCase(),
    className: "", title: "", disabled: false, hidden: false,
    dataset: {}, _ch: [], _ev: {}, _parent: null, _text: null,
    style: { setProperty() {}, removeProperty() {} },
    classList: {
      _s: new Set(),
      add(...cs) { for (const c of cs) this._s.add(c); },
      remove(...cs) { for (const c of cs) this._s.delete(c); },
      toggle(c, f) { f === undefined ? (this._s.has(c) ? this._s.delete(c) : this._s.add(c)) : f ? this._s.add(c) : this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
    append(...ns) { for (const n of ns) el.appendChild(n); },
    appendChild(n) {
      if (n && typeof n === "object") { if (n._parent) n._parent._ch = n._parent._ch.filter((c) => c !== n); n._parent = el; }
      el._text = null;
      el._ch.push(n);
      return n;
    },
    remove() { if (el._parent) el._parent._ch = el._parent._ch.filter((c) => c !== el); el._parent = null; },
    setAttribute(name, v) { if (name === "class") el.className = String(v); },
    addEventListener(e, fn) { (el._ev[e] ??= []).push(fn); },
    removeEventListener() {},
    dispatchEvent(ev) { for (const fn of el._ev[ev.type] ?? []) fn(ev); return true; },
    getBoundingClientRect: () => el._rect ?? { top: 0, left: 0, width: 400, height: 500 },
    offsetWidth: 0,
    querySelector(sel) {
      const cls = sel.startsWith(".") ? sel.slice(1) : null;
      if (!cls) return null;
      const hit = (n) => {
        if (String(n.className).split(" ").includes(cls)) return n;
        for (const c of n._ch ?? []) { const h = c._ch ? hit(c) : null; if (h) return h; }
        return null;
      };
      return hit(el);
    },
    get children() { return el._ch; },
    closest(sel) {
      for (let n = el; n; n = n._parent) {
        const hit = n._closest?.(sel);
        if (hit) return hit;
        if (String(n.tagName).toLowerCase() === sel.toLowerCase()) return n;
      }
      return null;
    },
  };
  // textContent as the browser has it: assigning replaces the children,
  // reading walks them — so `node.textContent = ""` really does clear.
  Object.defineProperty(el, "textContent", {
    get() { return el._text ?? el._ch.map((c) => c.textContent ?? "").join(""); },
    set(v) { el._ch = []; el._text = String(v); },
  });
  return el;
}

globalThis.document = {
  createElement: (tag) => mockEl(tag),
  createElementNS: (_ns, tag) => mockEl(tag),
  createTextNode: (text) => ({ textContent: text, nodeType: 3 }),
  head: mockEl("head"),
  addEventListener() {},
  removeEventListener() {},
};
globalThis.window = globalThis;
let pendingTimers = new Map();
let timerSeq = 0;
globalThis.setTimeout = (fn, ms) => { const id = ++timerSeq; pendingTimers.set(id, fn); return id; };
globalThis.clearTimeout = (id) => { pendingTimers.delete(id); };
const advanceTimers = () => { const fns = [...pendingTimers.values()]; pendingTimers.clear(); for (const fn of fns) fn(); };

const winEv = {};
globalThis.addEventListener = (e, fn) => { (winEv[e] ??= []).push(fn); };
globalThis.removeEventListener = (e, fn) => {
  const a = winEv[e]; const i = a?.indexOf(fn) ?? -1;
  if (i >= 0) a.splice(i, 1);
};
const fireWindow = (type, ev) => { for (const fn of [...(winEv[type] ?? [])]) fn(ev); };

let clipboard = [];
globalThis.ClipboardItem = class { constructor(parts) { this.parts = parts; } };
globalThis.Blob = class { constructor(parts) { this.text = parts.join(""); } };
globalThis.navigator = {
  clipboard: { write: async (items) => { clipboard.push(items[0]); }, },
};

// The mkio client: replies come from a per-test map of service → handler.
let replies = {};
let requests = [];
globalThis.MkioClient = class {
  async connect() {}
  async request(service, data) {
    requests.push({ service, data });
    const r = replies[service];
    if (r === undefined) return { type: "error", message: `no stub for '${service}'` };
    return typeof r === "function" ? r(data) : r;
  }
  subscribe() {}
  unsubscribe() {}
};

const { getPaneType, registerPaneType, registerExprFunction } = await import("../mkui/static/src/core.js");
await import("../mkui/static/src/widgets/mkio-history.js");
const factory = getPaneType("mkio-history");

// The pane shows the versions in an `mkio-table`. That table is exercised
// by its own suite and in the browser; here it stands in as the hooks the
// pane actually talks to — the spec it was handed, the rows it holds, the
// selection, and the two subscriptions — so these tests are about the
// pane's own logic rather than a second copy of the table's.
let stub = null;
function installTableStub() {
  registerPaneType("mkio-table", async (tspec, app, host) => {
    const paneEl = host.closest?.("mkui-pane") ?? host._paneEl ?? null;
    const dataFns = new Set(), selFns = new Set();
    stub = {
      spec: tspec, host, rows: stub?.pending ?? [], selected: [],
      // Test controls.
      deliver(rows) { stub.rows = rows; for (const fn of dataFns) fn(); },
      select(rows) { stub.selected = rows; for (const fn of selFns) fn(); },
      sources: stub?.sources ?? [],
    };
    stub.sources.push(tspec.filter);
    if (paneEl) {
      const extras = { className: "mkui-table-extras", _ch: [], _parent: host,
        append(...ns) { for (const n of ns) { n._parent = extras; extras._ch.push(n); } } };
      host._ch.push(extras);
      paneEl._toolbar = { extras: () => extras, sync: () => { stub.synced = (stub.synced ?? 0) + 1; } };
      paneEl._data = {
        rows: () => stub.rows,
        view: () => stub.rows,
        selected: () => stub.selected,
        on: (fn) => { dataFns.add(fn); return () => dataFns.delete(fn); },
      };
      paneEl._select = {
        set: (keys) => { stub.setKeys = keys; return { ok: true, selected: keys }; },
        get: () => ({ keys: [], focus: null }),
        on: (fn) => { selFns.add(fn); return () => selFns.delete(fn); },
      };
      paneEl._source = {
        set: (patch) => {
          stub.sources.push(patch.filter);
          stub.rows = [];
          stub.selected = [];
          for (const fn of dataFns) fn();
        },
        get: () => ({ filter: stub.sources.at(-1) }),
      };
    }
  });
}
installTableStub();

/* ── Fixtures ─────────────────────────────────────────────────────────── */

const hrow = (version, op, user, values) => ({
  _mkio_row: `${values?.id ?? "O1"}-${version}`,
  _mkio_version: version, _mkio_op: op, _mkio_user: user,
  _mkio_ref: `2026090${version} 14:0${version}:05.000000000000`,
  _mkio_service: "orders", id: "O1", ...values,
});

// v1 insert → v2 raises qty → v3 fills it.
const ORDER_CHAIN = [
  hrow(1, "insert", "alice", { qty: 500, status: "pending" }),
  hrow(2, "update", "alice", { qty: 750, status: "pending" }),
  hrow(3, "update", "bob", { qty: 750, status: "filled" }),
];

const HISTORY = {
  table: "orders", key: ["id"], versions: "order_versions", feed: "order_history",
  state: "order_state", undo: "orders", redo: "orders",
};

function makeState(init = {}) {
  const store = new Map(Object.entries(init));
  return {
    get: (k) => (k === undefined ? Object.fromEntries(store) : store.get(k)),
    set: (k, v) => store.set(k, v),
    subscribe: (k, fn) => { fn(store.get(k)); return () => {}; },
  };
}

// A workspace with one table pane: its `history` hook, its spec, and the
// selection subscription the history pane follows.
function makeWorkspace(opts = {}) {
  const listeners = new Set();
  let rows = opts.rows ?? [];
  return {
    getPaneSpec: (id) => (id === "orders" ? opts.srcSpec ?? {} : null),
    paneHistory: (id) => (id === "orders" && opts.history !== null
      ? { spec: opts.history ?? HISTORY, rows: () => rows,
          columns: () => opts.srcColumns ?? ["id", "qty", "status"] } : null),
    onPaneSelection: (id, fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    // What a `record.follow` pane reads: the rows the table's selection
    // implies.
    paneRows: (id) => (id === "orders" ? rows : []),
    // The tab is where the record's name lives now.
    setPaneAutoTitle(id, text) { this.tab = text; return true; },
    tab: null,
    // Test controls: change the table's selection and notify followers.
    select(next) { rows = next; for (const fn of listeners) fn(); },
    listeners,
  };
}

async function makePane(opts = {}) {
  replies = { ...(opts.replies ?? {}) };
  requests = [];
  clipboard = [];
  stub = null;
  const host = mockEl("div");
  const paneEl = mockEl("mkui-pane");
  paneEl.dataset.id = "history";   // as the workspace stamps it
  const ws = makeWorkspace(opts);
  host._closest = (sel) => (sel === "mkui-workspace" ? ws : sel === "mkui-pane" ? paneEl : null);
  const state = makeState();
  const app = { config: { mkio: { url: "ws://localhost:8080/ws" } }, state };
  await factory({ type: "mkio-history", source: "orders", ...(opts.spec ?? {}) }, app, host);
  await flush();
  // The versions land on the table's subscription, as they would live.
  if (stub && opts.chain !== null) { stub.deliver(opts.chain ?? ORDER_CHAIN); await flush(); }
  return { host, paneEl, ws, app, state, table: () => stub };
}

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

/* ── Reading the DOM ──────────────────────────────────────────────────── */

const find = (node, cls) => {
  if (String(node.className).split(" ").includes(cls)) return node;
  for (const c of node._ch) { const hit = c._ch ? find(c, cls) : null; if (hit) return hit; }
  return null;
};
const findAll = (node, cls, out = []) => {
  if (String(node.className).split(" ").includes(cls)) out.push(node);
  for (const c of node._ch) if (c._ch) findAll(c, cls, out);
  return out;
};
const classesOf = (v) => [...v.classList._s];
const fields = (host) => findAll(host, "mkui-history-field").map((f) => [
  find(f, "mkui-history-fname").textContent,
  find(f, "mkui-history-from").textContent,
  find(f, "mkui-history-to").textContent,
]);
const atText = (host) => find(host, "mkui-history-at")?.textContent ?? null;
const chipText = (host) => find(host, "mkui-chip-record")?.textContent ?? null;
const chipOff = (host) => !!find(host, "mkui-chip-record")?.classList.contains("mkui-chip-off");
const pinBtn = (host) => find(host, "mkui-record-pin");
const pairText = (host) => find(host, "mkui-history-pair")?.textContent ?? null;
const emptyText = (host) => find(host, "mkui-history-empty")?.textContent ?? null;
const click = (node, ev = {}) => {
  for (const fn of node._ev.mousedown ?? []) fn({ button: 0, ...ev });
};

const liveRow = (version = 3) => ({ id: "O1", qty: 750, status: "filled", _mkio_version: version });

/* ── Nothing to show ──────────────────────────────────────────────────── */

test("with no selection the pane asks for one", async () => {
  const { host, table } = await makePane({ rows: [] });
  assert.match(emptyText(host), /Select a row/);
  assert.equal(table(), null, "no record, no table and nothing asked of the server");
  assert.deepEqual(requests, []);
});

test("a table without a `feed` service says so instead of failing quietly", async () => {
  const { host, table } = await makePane({ rows: [liveRow()], history: { ...HISTORY, feed: null } });
  assert.match(emptyText(host), /No `feed` service/);
  assert.equal(table(), null, "and no table is built for it");
});

test("a table with no `history` block at all says that", async () => {
  const { host } = await makePane({ rows: [liveRow()], history: null });
  assert.match(emptyText(host), /no `history` block/);
});

/* ── The version list ─────────────────────────────────────────────────── */

test("the versions are a table over the feed, narrowed to the record", async () => {
  const { host, table, ws } = await makePane({ rows: [liveRow()] });
  const t = table();
  assert.equal(t.spec.service, "order_history");
  assert.equal(t.spec.protocol, "query");
  assert.equal(t.spec.filter, "id == 'O1'", "server-side, so the table holds one record's versions");
  assert.equal(t.spec.sort, "_mkio_version", "oldest first: the chain in the order it happened");
  assert.deepEqual(t.spec.columns, ["_mkio_version", "_mkio_op", "_mkio_user", "_mkio_ref", "id", "qty", "status"],
    "mkio's own columns first, then the record's as the source table has them");
  assert.equal(ws.tab, "O1", "the record names the tab, not a head");
  assert.ok(!requests.some((r) => r.service === "order_versions"), "the chain is the table's rows, not a second read");
});

test("the key goes into the filter as a literal, whatever its type", async () => {
  const { table } = await makePane({ rows: [{ id: 17, _mkio_version: 1 }], chain: [] });
  assert.equal(table().spec.filter, "id == 17");
  const quoted = await makePane({ rows: [{ id: "it's", _mkio_version: 1 }], chain: [] });
  assert.equal(quoted.table().spec.filter, "id == 'it\\'s'");
});

test("a composite key filters on every column", async () => {
  const { table } = await makePane({
    rows: [{ book: "A", id: 2, _mkio_version: 1 }], chain: [],
    history: { ...HISTORY, key: ["book", "id"] },
  });
  assert.equal(table().spec.filter, "book == 'A' && id == 2");
});

test("the panel says where in its chain the record stands", async () => {
  const { host } = await makePane({ rows: [liveRow(2)] });   // undone once
  assert.match(atText(host), /v2 of 3/);
});

test("a record undone out of existence reads as removed", async () => {
  // No live row of its own: the `state` service answers for the cursor.
  const { host } = await makePane({
    rows: [{ id: "O1" }],
    replies: { order_state: { type: "reply", rows: [{ current: null, top: 3 }] } },
  });
  assert.match(atText(host), /removed/);
});

/* ── The diff ─────────────────────────────────────────────────────────── */

test("the diff opens on the newest version against its predecessor, changes only", async () => {
  const { host } = await makePane({ rows: [liveRow()] });
  assert.equal(pairText(host), "v2 → v3");
  assert.deepEqual(fields(host), [["status", "pending", "filled"]]);
  assert.equal(find(host, "mkui-history-count").textContent, "1 change");
});

test("unchanged fields are there on request", async () => {
  const { host } = await makePane({ rows: [liveRow()] });
  click(find(host, "mkui-history-toggle"));
  assert.deepEqual(fields(host), [
    ["id", "O1", "O1"],
    ["qty", "750", "750"],
    ["status", "pending", "filled"],
  ]);
  assert.equal(find(host, "mkui-history-toggle").textContent, "Hide unchanged");
});

test("the first recorded version diffs against nothing", async () => {
  const { host, table } = await makePane({ rows: [liveRow()] });
  table().select([ORDER_CHAIN[0]]);               // v1
  assert.equal(pairText(host), "v1 (first recorded)");
  assert.deepEqual(fields(host), [
    ["id", "—", "O1"],
    ["qty", "—", "500"],
    ["status", "—", "pending"],
  ]);
});

test("selecting a version in the table moves the diff with it", async () => {
  const { host, table } = await makePane({ rows: [liveRow()] });
  table().select([ORDER_CHAIN[1]]);               // v2
  assert.equal(pairText(host), "v1 → v2");
  assert.deepEqual(fields(host), [["qty", "500", "750"]]);
});

test("selecting a range diffs its ends", async () => {
  const { host, table } = await makePane({ rows: [liveRow()] });
  table().select([ORDER_CHAIN[2], ORDER_CHAIN[0]]);   // v3 and v1, in any order
  assert.equal(pairText(host), "v1 → v3");
  assert.deepEqual(fields(host), [["qty", "500", "750"], ["status", "pending", "filled"]]);
  table().select([]);
  assert.equal(pairText(host), "v2 → v3", "and nothing selected is the newest change");
});

/* ── Presentation from the table ──────────────────────────────────────── */

test("labels and display templates come from the table the pane follows", async () => {
  const { host } = await makePane({
    rows: [liveRow()],
    srcSpec: { labels: { status: "State" }, display: { status: "${UPPER(value)}" } },
  });
  assert.deepEqual(fields(host), [["State", "PENDING", "FILLED"]]);
});

test("a display template that fails at run time shows #ERR, and warns once", async () => {
  registerExprFunction("HBOOM", () => { throw new Error("boom"); }, { params: [] });
  const warned = [];
  const orig = console.warn;
  console.warn = (...a) => warned.push(a.join(" "));
  try {
    const { host } = await makePane({
      rows: [liveRow()],
      srcSpec: { display: { status: "${HBOOM()}" } },
    });
    assert.deepEqual(fields(host), [["status", "#ERR", "#ERR"]]);
    assert.equal(warned.filter((w) => w.includes("display.status")).length, 1, "warned once, not per value");
  } finally {
    console.warn = orig;
  }
});

test("a display template that will not compile leaves the value plain", async () => {
  const warned = [];
  const orig = console.warn;
  console.warn = (...a) => warned.push(a.join(" "));
  try {
    const { host } = await makePane({
      rows: [liveRow()],
      srcSpec: { display: { status: "${UPPER(" } },
    });
    assert.deepEqual(fields(host), [["status", "pending", "filled"]]);
    assert.equal(warned.filter((w) => w.includes("bad display template for status")).length, 1);
  } finally {
    console.warn = orig;
  }
});

/* ── Following the table ──────────────────────────────────────────────── */

test("the pane follows the table's selection, re-aiming the same table", async () => {
  const { host, ws, table } = await makePane({ rows: [liveRow()] });
  assert.equal(ws.tab, "O1");
  const before = table();
  ws.select([{ id: "O2", qty: 9, _mkio_version: 1 }]);
  await flush();
  assert.equal(ws.tab, "O2");
  assert.equal(table(), before, "the table is re-aimed, not rebuilt: its columns and filters stay");
  assert.deepEqual(table().sources, ["id == 'O1'", "id == 'O2'"]);
  assert.match(emptyText(host), /No versions are recorded/, "and it holds nothing until the rows land");
  table().deliver([hrow(1, "insert", "carol", { id: "O2", qty: 9 })]);
  await flush();
  assert.equal(pairText(host), "v1 (first recorded)");
});

test("re-selecting the same row re-aims nothing", async () => {
  const row = liveRow();
  const { ws, table } = await makePane({ rows: [row] });
  assert.equal(table().sources.length, 1);
  ws.select([row]);
  await flush();
  assert.equal(table().sources.length, 1);
});

test("clearing the selection empties the pane", async () => {
  const { host, ws } = await makePane({ rows: [liveRow()] });
  ws.select([]);
  await flush();
  assert.match(emptyText(host), /Select a row/);
});

test("with several rows selected the first is shown, and the chip says so", async () => {
  const { host, ws } = await makePane({ rows: [liveRow(), { id: "O2", _mkio_version: 1 }] });
  assert.equal(ws.tab, "O1");
  assert.match(find(host, "mkui-chip-record").title, /2 records/);
});

/* ── Keys and errors ──────────────────────────────────────────────────── */

test("without a configured key the pane asks the server which columns identify a record", async () => {
  const { table } = await makePane({
    rows: [liveRow()],
    history: { ...HISTORY, key: null },
    replies: {
      _mkio: { type: "reply", row: { table: "orders", columns: [
        { name: "id", pk: true }, { name: "qty", pk: false },
      ] } },
    },
  });
  assert.deepEqual(requests.map((r) => r.service), ["_mkio"]);
  assert.deepEqual(requests[0].data, { table: "orders" });
  assert.equal(table().spec.filter, "id == 'O1'");
});

test("a column the table keeps no history of gets no column in the versions table", async () => {
  // The schema reply the key is asked from also names the `unversioned`
  // columns (mkio 0.6): the history rows never carry them, so a column
  // for one would sit empty.
  const { table } = await makePane({
    rows: [liveRow()],
    history: { ...HISTORY, key: null },
    srcColumns: ["id", "qty", "status", "note"],
    replies: {
      _mkio: { type: "reply", row: { table: "orders", columns: [
        { name: "id", pk: true }, { name: "qty", pk: false }, { name: "note", pk: false },
      ], unversioned: ["note"] } },
    },
  });
  assert.deepEqual(table().spec.columns, ["_mkio_version", "_mkio_op", "_mkio_user", "_mkio_ref", "id", "qty", "status"]);
});

test("a configured key still reads the schema once, for the unversioned columns", async () => {
  const { table } = await makePane({
    rows: [liveRow()], srcColumns: ["id", "qty", "status", "note"],
    replies: { _mkio: { type: "reply", row: { table: "orders", columns: [{ name: "id", pk: true }], unversioned: ["note"] } } },
  });
  assert.deepEqual(requests.map((r) => r.service), ["_mkio"]);
  assert.equal(table().spec.filter, "id == 'O1'", "the configured key, not the schema's");
  assert.ok(!table().spec.columns.includes("note"));
});

test("with a configured key a schema the server refuses costs nothing: every source column shows", async () => {
  const { table, host } = await makePane({
    rows: [liveRow()], srcColumns: ["id", "qty", "status", "note"],
    replies: { _mkio: { type: "error", message: "authentication required" } },
  });
  assert.ok(table().spec.columns.includes("note"));
  assert.equal(emptyText(host), null, "not an error the pane reports");
});

test("a key that cannot be resolved is reported, not guessed", async () => {
  const { host } = await makePane({
    rows: [liveRow()],
    history: { ...HISTORY, key: null },
    replies: { _mkio: { type: "error", message: "authentication required" } },
  });
  assert.match(emptyText(host), /authentication required/);
});

test("a row carrying no key value is reported", async () => {
  const { host } = await makePane({ rows: [{ qty: 1, _mkio_version: 1 }] });
  assert.match(emptyText(host), /carries no id/);
});

test("a `state` service that refuses is a warning, not a dead pane", async () => {
  const warned = [];
  const orig = console.warn;
  console.warn = (...a) => warned.push(a.join(" "));
  try {
    const { host } = await makePane({
      rows: [{ id: "O1" }],                      // no version on the row
      replies: { order_state: { type: "error", message: "not permitted" } },
    });
    assert.equal(pairText(host), "v2 → v3", "the chain still reads");
    assert.match(atText(host), /3 versions/, "the cursor is simply unknown");
  } finally {
    console.warn = orig;
  }
});

test("a record with no recorded versions says so", async () => {
  const { host } = await makePane({ rows: [liveRow()], chain: [] });
  assert.match(emptyText(host), /No versions are recorded/);
});

/* ── Copy ─────────────────────────────────────────────────────────────── */

const copyBtn = (host) => find(host, "mkui-history-copy");

test("copy takes the diff as shown, as TSV and HTML", async () => {
  const { host, state } = await makePane({ rows: [liveRow()] });
  click(copyBtn(host));
  await flush();
  assert.equal(clipboard.length, 1);
  const tsv = clipboard[0].parts["text/plain"].text;
  assert.equal(tsv, "\tv2\tv3\r\nstatus\tpending\tfilled");
  assert.match(clipboard[0].parts["text/html"].text, /<table/);
  assert.equal(state.get("status.message"), "Copied 1 field");
});

test("copy follows the unchanged toggle", async () => {
  const { host } = await makePane({ rows: [liveRow()] });
  click(find(host, "mkui-history-toggle"));
  click(copyBtn(host));
  await flush();
  assert.match(clipboard[0].parts["text/plain"].text, /qty\t750\t750/);
});

/* ── The pane's own hook ──────────────────────────────────────────────── */

test("the record hook re-reads on demand", async () => {
  const { paneEl, table } = await makePane({ rows: [liveRow()] });
  assert.equal(paneEl._record.get().row.id, "O1");
  const n = table().sources.length;
  paneEl._record.refresh();
  await flush();
  assert.equal(table().sources.length, n + 1, "a forced refresh re-aims at the same record");
});

/* ── Blame ────────────────────────────────────────────────────────────── */
// The same chain read the other way: which version last gave each field
// the value it has, and who wrote it.

const views = (host) => findAll(host, "mkui-history-view");
const blameLines = (host) => findAll(host, "mkui-history-blame").map((l) => [
  find(l, "mkui-history-fname").textContent,
  find(l, "mkui-history-bvalue").textContent,
  find(l, "mkui-history-bwho").textContent,
]);
const showBlame = (host) => click(views(host)[1]);

test("blame: the switch is there, and Diff is what opens", async () => {
  const { host } = await makePane({ rows: [liveRow()] });
  assert.deepEqual(views(host).map((v) => v.textContent), ["Diff", "Blame"]);
  assert.ok(views(host)[0].classList.contains("active"));
  assert.equal(blameLines(host).length, 0);
});

test("blame: each field carries the version that last set it", async () => {
  const { host } = await makePane({ rows: [liveRow()] });
  showBlame(host);
  const lines = blameLines(host);
  assert.deepEqual(lines.map((l) => l.slice(0, 2)), [
    ["id", "O1"], ["qty", "750"], ["status", "filled"],
  ]);
  assert.match(lines[0][2], /^v1 · alice/, "id was set when the record was inserted");
  assert.match(lines[1][2], /^v2 · alice/, "qty last moved at v2");
  assert.match(lines[2][2], /^v3 · bob/);
  assert.ok(views(host)[1].classList.contains("active"));
});

test("blame: it reads as at the version on show, not the top of the chain", async () => {
  const { host, table } = await makePane({ rows: [liveRow()] });
  table().select([ORDER_CHAIN[1]]);               // v2
  showBlame(host);
  const lines = blameLines(host);
  assert.deepEqual(lines.map((l) => l.slice(0, 2)), [
    ["id", "O1"], ["qty", "750"], ["status", "pending"],
  ]);
  assert.match(lines[2][2], /^v1 /, "at v2 the status is still the one the insert gave it");
});

test("blame: a field never set says so and does not navigate", async () => {
  const { host } = await makePane({
    rows: [liveRow()],
    chain: [hrow(1, "insert", "alice", { id: "O1", qty: 1, note: "" })],
  });
  showBlame(host);
  const note = blameLines(host).find((l) => l[0] === "note");
  assert.deepEqual(note, ["note", "—", "never set"]);
  const line = findAll(host, "mkui-history-blame").find((l) => find(l, "mkui-history-fname").textContent === "note");
  assert.ok(line.classList.contains("mkui-history-unset"));
  assert.equal(line._ev.mousedown, undefined, "nothing to go to");
});

test("blame: clicking a field selects the version that set it, in the table", async () => {
  const { host, table } = await makePane({ rows: [liveRow()] });
  showBlame(host);
  const qty = findAll(host, "mkui-history-blame").find((l) => find(l, "mkui-history-fname").textContent === "qty");
  click(qty);
  assert.deepEqual(table().setKeys, [ORDER_CHAIN[1]._mkio_row], "v2 is where qty last moved");
});

test("blame: the view follows the record and the labels", async () => {
  const { host, ws, table } = await makePane({
    rows: [liveRow()], srcSpec: { labels: { status: "State" }, display: { status: "${UPPER(value)}" } },
  });
  showBlame(host);
  assert.deepEqual(blameLines(host).at(-1).slice(0, 2), ["State", "FILLED"]);
  ws.select([{ id: "O2", qty: 9, status: "new", _mkio_version: 1 }]);
  await flush();
  table().deliver([hrow(1, "insert", "carol", { id: "O2", qty: 9, status: "new" })]);
  await flush();
  assert.equal(find(host, "mkui-history-pair").textContent, "as at v1", "the view is a preference, not per record");
  assert.deepEqual(blameLines(host).map((l) => l[0]), ["id", "qty", "State"]);
});

test("blame: copy takes the provenance grid", async () => {
  const { host } = await makePane({ rows: [liveRow()] });
  showBlame(host);
  click(copyBtn(host));
  await flush();
  const tsv = clipboard[0].parts["text/plain"].text.split("\r\n");
  assert.equal(tsv[0], "\tv3\tVersion\tUser\tWhen");
  assert.match(tsv[2], /^qty\t750\tv2\talice\t/);
});

/* ── The version the record is on ─────────────────────────────────────── */

test("the pane opens on the version the record is on, not the top of a redo branch", async () => {
  const { host, table } = await makePane({ rows: [liveRow(2)] });   // undone once
  assert.equal(pairText(host), "v1 → v2", "v3 is redo, not the record's present");
  assert.deepEqual(table().setKeys, [ORDER_CHAIN[1]._mkio_row], "and that row is selected, so the table marks it");
});

test("the default selection happens once, and never over the user's", async () => {
  const { host, table } = await makePane({ rows: [liveRow()] });
  assert.deepEqual(table().setKeys, [ORDER_CHAIN[2]._mkio_row]);
  table().setKeys = null;
  table().select([ORDER_CHAIN[0]]);                  // the user picks v1
  table().deliver(ORDER_CHAIN);                      // and a version lands live
  await flush();
  assert.equal(table().setKeys, null, "the selection is left alone");
  assert.equal(pairText(host), "v1 (first recorded)");
});

test("a record with no cursor opens on the newest recorded", async () => {
  const { host } = await makePane({ rows: [{ id: "O1" }] });   // no version on the row
  assert.equal(pairText(host), "v2 → v3");
});

/* ── The splitter ─────────────────────────────────────────────────────── */

const splitterOf = (host) => find(host, "mkui-history-split");
const tableShare = (host) => find(host, "mkui-history-table").style.flexBasis;

test("the divider drags the table's share of the pane", async () => {
  const { host } = await makePane({ rows: [liveRow()] });
  const sp = splitterOf(host);
  assert.ok(sp, "there is a bar between the table and the panel");
  assert.equal(tableShare(host), "65.00%");

  // The pane is 500 tall from y=0 (the mock's rect): drag to y=200.
  sp._ev.mousedown[0]({ button: 0, clientY: 300, preventDefault() {} });
  assert.ok(sp.classList.contains("dragging"));
  fireWindow("mousemove", { clientY: 200 });
  assert.equal(tableShare(host), "40.00%");
  fireWindow("mouseup", {});
  assert.ok(!sp.classList.contains("dragging"));
  fireWindow("mousemove", { clientY: 400 });
  assert.equal(tableShare(host), "40.00%", "and lets go");
});

test("the divider will not collapse either side", async () => {
  const { host } = await makePane({ rows: [liveRow()] });
  const sp = splitterOf(host);
  sp._ev.mousedown[0]({ button: 0, clientY: 300, preventDefault() {} });
  fireWindow("mousemove", { clientY: -100 });
  assert.equal(tableShare(host), "15.00%");
  fireWindow("mousemove", { clientY: 5000 });
  assert.equal(tableShare(host), "90.00%");
  fireWindow("mouseup", {});
});

test("a right-click on the divider starts nothing", async () => {
  const { host } = await makePane({ rows: [liveRow()] });
  const sp = splitterOf(host);
  sp._ev.mousedown[0]({ button: 2, clientY: 300, preventDefault() {} });
  assert.ok(!sp.classList.contains("dragging"));
  fireWindow("mousemove", { clientY: 100 });
  assert.equal(tableShare(host), "65.00%");
});

/* ── Where the controls live ──────────────────────────────────────────── */

test("the view controls sit in the versions table's toolbar; copy sits with what it copies", async () => {
  const { host, paneEl, table } = await makePane({ rows: [liveRow()] });
  const extras = paneEl._toolbar.extras();
  assert.deepEqual(extras._ch.map((n) => n.className), [
    "mkui-record-subject",                             // the pin and the subject chip lead
    "mkui-history-views",                              // one-of-two: a segmented control
    "mkui-btn mkui-toolbar-btn mkui-history-toggle",   // on/off: the toolbar's button, pressed when on
  ]);
  assert.ok(table().synced >= 1, "the toolbar is told, since an empty one is not in the DOM");
  // Copy acts on the panel, so it lives in the panel's own header.
  const head = find(host, "mkui-history-diffhead");
  assert.deepEqual(head._ch.map((n) => n.className),
    ["mkui-history-pair", "mkui-history-count", "mkui-history-at", "mkui-history-copy"]);
});

test("the controls are placed once, however many times the panel renders", async () => {
  const { paneEl, table } = await makePane({ rows: [liveRow()] });
  const n = paneEl._toolbar.extras()._ch.length;
  table().select([ORDER_CHAIN[0]]);
  table().deliver(ORDER_CHAIN);
  await flush();
  assert.equal(paneEl._toolbar.extras()._ch.length, n);
});

test("the unchanged toggle is for the diff, and only when there is something unchanged", async () => {
  const { host } = await makePane({ rows: [liveRow()] });
  const toggle = find(host, "mkui-history-toggle");
  assert.equal(toggle.disabled, false, "v2 → v3 leaves five fields alone");
  showBlame(host);
  assert.ok(toggle.disabled, "blame shows every field already");
  click(views(host)[0]);                             // back to Diff
  assert.equal(toggle.disabled, false);
});

test("copy is off until there are versions to copy", async () => {
  const { host } = await makePane({ rows: [], chain: null });
  assert.ok(find(host, "mkui-history-copy") == null, "no versions, no panel header to hang it from");
  const on = await makePane({ rows: [liveRow()] });
  assert.equal(find(on.host, "mkui-history-copy").disabled, false);
});

/* ── Copy feedback ────────────────────────────────────────────────────── */

const btnText = (b) => b._ch.map((n) => n.textContent ?? "").join("");

test("copy says so where the click was, and pulses what it took", async () => {
  const { host, state } = await makePane({ rows: [liveRow()] });
  click(find(host, "mkui-history-toggle"));      // show unchanged: three lines
  const lines = findAll(host, "mkui-history-field");
  assert.equal(lines.length, 3);
  click(copyBtn(host));
  // The pulse is on at once: it marks what went, not what landed.
  assert.ok(lines.every((l) => l.classList.contains("mkui-flash-copy")));
  await flush();
  assert.equal(btnText(copyBtn(host)), "Copied");
  assert.ok(copyBtn(host).classList.contains("mkui-history-copied"));
  assert.equal(state.get("status.message"), "Copied 3 fields");
});

test("copy that does not land says that instead", async () => {
  const orig = navigator.clipboard.write;
  navigator.clipboard.write = async () => { throw new Error("denied"); };
  navigator.clipboard.writeText = async () => { throw new Error("denied"); };
  try {
    const { host, state } = await makePane({ rows: [liveRow()] });
    click(copyBtn(host));
    await flush();
    assert.equal(btnText(copyBtn(host)), "Failed");
    assert.ok(!copyBtn(host).classList.contains("mkui-history-copied"));
    assert.equal(state.get("status.message"), "Copy failed");
  } finally {
    navigator.clipboard.write = orig;
    delete navigator.clipboard.writeText;
  }
});

test("the button goes back to Copy, and the statusbar to what it said", async () => {
  const { host, state } = await makePane({ rows: [liveRow()] });
  state.set("status.message", "Connected");
  click(copyBtn(host));
  await flush();
  assert.equal(state.get("status.message"), "Copied 1 field");
  advanceTimers();
  assert.equal(btnText(copyBtn(host)), "Copy");
  assert.equal(state.get("status.message"), "Connected", "and puts back what was there");
});
