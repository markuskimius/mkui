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
    closest() { return null; },
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

const { getPaneType, registerExprFunction } = await import("../mkui/static/src/core.js");
await import("../mkui/static/src/widgets/mkio-history.js");
const factory = getPaneType("mkio-history");

/* ── Fixtures ─────────────────────────────────────────────────────────── */

const hrow = (version, op, user, values) => ({
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
  table: "orders", key: ["id"], versions: "order_versions",
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
      ? { spec: opts.history ?? HISTORY, rows: () => rows } : null),
    onPaneSelection: (id, fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    // Test controls: change the table's selection and notify followers.
    select(next) { rows = next; for (const fn of listeners) fn(); },
    listeners,
  };
}

async function makePane(opts = {}) {
  replies = {
    order_versions: { type: "reply", rows: opts.chain ?? ORDER_CHAIN },
    ...(opts.replies ?? {}),
  };
  requests = [];
  clipboard = [];
  const host = mockEl("div");
  const paneEl = mockEl("mkui-pane");
  const ws = makeWorkspace(opts);
  host.closest = (sel) => (sel === "mkui-workspace" ? ws : sel === "mkui-pane" ? paneEl : null);
  const state = makeState();
  const app = { config: { mkio: { url: "ws://localhost:8080/ws" } }, state };
  await factory({ type: "mkio-history", source: "orders", ...(opts.spec ?? {}) }, app, host);
  // The pane awaits its client, then its first load: let both settle.
  await flush();
  return { host, paneEl, ws, app, state };
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
const versions = (host) => findAll(host, "mkui-history-ver");
const versionNums = (host) => versions(host).map((v) => find(v, "mkui-history-vnum").textContent);
const classesOf = (v) => [...v.classList._s];
const fields = (host) => findAll(host, "mkui-history-field").map((f) => [
  find(f, "mkui-history-fname").textContent,
  find(f, "mkui-history-from").textContent,
  find(f, "mkui-history-to").textContent,
]);
const headText = (host) => find(host, "mkui-history-title").textContent;
const subText = (host) => find(host, "mkui-history-sub").textContent;
const pairText = (host) => find(host, "mkui-history-pair")?.textContent ?? null;
const emptyText = (host) => find(host, "mkui-history-empty")?.textContent ?? null;
const click = (node, ev = {}) => {
  for (const fn of node._ev.mousedown ?? []) fn({ button: 0, ...ev });
};

const liveRow = (version = 3) => ({ id: "O1", qty: 750, status: "filled", _mkio_version: version });

/* ── Nothing to show ──────────────────────────────────────────────────── */

test("with no selection the pane asks for one", async () => {
  const { host } = await makePane({ rows: [] });
  assert.match(emptyText(host), /Select a row/);
  assert.equal(versions(host).length, 0);
  assert.deepEqual(requests, [], "nothing is asked of the server until there is a record");
});

test("a table without a `versions` service says so instead of failing quietly", async () => {
  const { host } = await makePane({ rows: [liveRow()], history: { ...HISTORY, versions: null } });
  assert.match(emptyText(host), /No `versions` service/);
});

test("a table with no `history` block at all says that", async () => {
  const { host } = await makePane({ rows: [liveRow()], history: null });
  assert.match(emptyText(host), /no `history` block/);
});

/* ── The version list ─────────────────────────────────────────────────── */

test("the chain renders newest first, with op, user and local time", async () => {
  const { host } = await makePane({ rows: [liveRow()] });
  assert.deepEqual(requests, [{ service: "order_versions", data: { id: "O1" } }]);
  assert.deepEqual(versionNums(host), ["v3", "v2", "v1"]);
  const v1 = versions(host)[2];
  assert.equal(find(v1, "mkui-history-op").textContent, "insert");
  assert.equal(find(v1, "mkui-history-user").textContent, "alice");
  assert.match(find(v1, "mkui-history-when").textContent, /\d\d:\d\d:\d\d/);
  assert.equal(headText(host), "orders O1");
});

test("the row's own version is marked, and the versions above it read as redo", async () => {
  const { host } = await makePane({ rows: [liveRow(2)] });   // undone once
  const [v3, v2, v1] = versions(host);
  assert.ok(classesOf(v2).includes("current"));
  assert.ok(classesOf(v3).includes("ahead"), "v3 is the redo branch");
  assert.ok(!classesOf(v1).includes("ahead"));
  assert.match(subText(host), /v2 of 3/);
  assert.match(subText(host), /1 version ahead/);
});

test("a record undone out of existence reads as removed", async () => {
  // No live row of its own: the `state` service answers for the cursor.
  const { host } = await makePane({
    rows: [{ id: "O1" }],
    replies: { order_state: { type: "reply", rows: [{ current: null, top: 3 }] } },
  });
  assert.match(subText(host), /removed/);
  assert.ok(versions(host).every((v) => classesOf(v).includes("ahead")), "every version is redo now");
});

test("archived versions leave a gap in the list", async () => {
  const { host } = await makePane({
    rows: [liveRow(6)],
    chain: [hrow(1, "insert", "a", { qty: 1 }), hrow(5, "update", "a", { qty: 5 }), hrow(6, "update", "a", { qty: 6 })],
  });
  const gap = find(host, "mkui-history-gap");
  assert.equal(gap.textContent, "3 versions archived");
  assert.match(subText(host), /archived versions missing/);
});

/* ── The diff ─────────────────────────────────────────────────────────── */

test("the diff opens on the row's version against its predecessor, changes only", async () => {
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
  const { host } = await makePane({ rows: [liveRow()] });
  click(versions(host)[2]);                       // v1
  assert.equal(pairText(host), "v1 (first recorded)");
  assert.deepEqual(fields(host), [
    ["id", "—", "O1"],
    ["qty", "—", "500"],
    ["status", "—", "pending"],
  ]);
});

test("clicking a version moves the diff with it", async () => {
  const { host } = await makePane({ rows: [liveRow()] });
  click(versions(host)[1]);                       // v2
  assert.equal(pairText(host), "v1 → v2");
  assert.deepEqual(fields(host), [["qty", "500", "750"]]);
  assert.ok(classesOf(versions(host)[1]).includes("sel"));
});

test("ctrl/cmd-click pins the other side, so any two versions compare", async () => {
  const { host } = await makePane({ rows: [liveRow()] });
  click(versions(host)[2], { ctrlKey: true });    // pin v1
  assert.equal(pairText(host), "v1 → v3", "the pin reads low → high whichever was clicked first");
  assert.deepEqual(fields(host), [["qty", "500", "750"], ["status", "pending", "filled"]]);
  assert.ok(classesOf(versions(host)[2]).includes("base"));
  click(versions(host)[2], { metaKey: true });    // and again releases it
  assert.equal(pairText(host), "v2 → v3");
});

test("a right-click on a version does nothing", async () => {
  const { host } = await makePane({ rows: [liveRow()] });
  click(versions(host)[2], { button: 2 });
  assert.equal(pairText(host), "v2 → v3");
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

test("the pane follows the table's selection", async () => {
  const { host, ws } = await makePane({ rows: [liveRow()] });
  assert.equal(headText(host), "orders O1");
  replies.order_versions = { type: "reply", rows: [hrow(1, "insert", "carol", { id: "O2", qty: 9 })].map((r) => ({ ...r, id: "O2" })) };
  ws.select([{ id: "O2", qty: 9, _mkio_version: 1 }]);
  await flush();
  assert.equal(headText(host), "orders O2");
  assert.deepEqual(versionNums(host), ["v1"]);
  assert.equal(requests.at(-1).data.id, "O2");
});

test("re-selecting the same row asks the server nothing", async () => {
  const row = liveRow();
  const { ws } = await makePane({ rows: [row] });
  assert.equal(requests.length, 1);
  ws.select([row]);
  await flush();
  assert.equal(requests.length, 1);
});

test("clearing the selection empties the pane", async () => {
  const { host, ws } = await makePane({ rows: [liveRow()] });
  ws.select([]);
  await flush();
  assert.match(emptyText(host), /Select a row/);
});

test("with several rows selected the first is shown, and the pane says so", async () => {
  const { host } = await makePane({ rows: [liveRow(), { id: "O2", _mkio_version: 1 }] });
  assert.equal(headText(host), "orders O1");
  assert.match(subText(host), /first of 2 selected/);
});

/* ── Keys and errors ──────────────────────────────────────────────────── */

test("without a configured key the pane asks the server which columns identify a record", async () => {
  const { host } = await makePane({
    rows: [liveRow()],
    history: { ...HISTORY, key: null },
    replies: {
      _mkio: { type: "reply", row: { table: "orders", columns: [
        { name: "id", pk: true }, { name: "qty", pk: false },
      ] } },
    },
  });
  assert.deepEqual(requests.map((r) => r.service), ["_mkio", "order_versions"]);
  assert.deepEqual(requests[0].data, { table: "orders" });
  assert.deepEqual(requests[1].data, { id: "O1" });
  assert.deepEqual(versionNums(host), ["v3", "v2", "v1"]);
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

test("a service error is shown with the service that refused", async () => {
  const { host } = await makePane({
    rows: [liveRow()],
    replies: { order_versions: { type: "error", message: "not permitted" } },
  });
  assert.match(emptyText(host), /'order_versions' refused: not permitted/);
});

test("a record with no recorded versions says so", async () => {
  const { host } = await makePane({ rows: [liveRow()], chain: [] });
  assert.match(emptyText(host), /No versions are recorded/);
});

/* ── Copy ─────────────────────────────────────────────────────────────── */

test("copy takes the diff as shown, as TSV and HTML", async () => {
  const { host, paneEl, state } = await makePane({ rows: [liveRow()] });
  assert.equal(paneEl._editActions.copy(), true);
  await flush();
  assert.equal(clipboard.length, 1);
  const tsv = clipboard[0].parts["text/plain"].text;
  assert.equal(tsv, "\tv2\tv3\r\nstatus\tpending\tfilled");
  assert.match(clipboard[0].parts["text/html"].text, /<table/);
  assert.equal(state.get("status.message"), "Copied 1 field");
});

test("copy follows the unchanged toggle", async () => {
  const { host, paneEl } = await makePane({ rows: [liveRow()] });
  click(find(host, "mkui-history-toggle"));
  paneEl._editActions.copy();
  await flush();
  assert.match(clipboard[0].parts["text/plain"].text, /qty\t750\t750/);
});

/* ── The pane's own hook ──────────────────────────────────────────────── */

test("the record hook re-reads on demand", async () => {
  const { paneEl, ws } = await makePane({ rows: [liveRow()] });
  assert.equal(paneEl._record.get().row.id, "O1");
  ws.select([{ id: "O2", _mkio_version: 1 }]);
  await flush();
  const n = requests.length;
  paneEl._record.refresh();
  await flush();
  assert.equal(requests.length, n + 1, "a forced refresh re-reads the same record");
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
  const { host } = await makePane({ rows: [liveRow()] });
  click(versions(host)[1]);                       // v2
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

test("blame: clicking a field goes to the version that set it", async () => {
  const { host } = await makePane({ rows: [liveRow()] });
  showBlame(host);
  const qty = findAll(host, "mkui-history-blame").find((l) => find(l, "mkui-history-fname").textContent === "qty");
  click(qty);
  assert.ok(versions(host)[1].classList.contains("sel"), "v2 is where qty last moved");
  assert.equal(find(host, "mkui-history-pair").textContent, "as at v2", "and blame stays on show");
});

test("blame: the view follows the record and the labels", async () => {
  const { host, ws } = await makePane({
    rows: [liveRow()], srcSpec: { labels: { status: "State" }, display: { status: "${UPPER(value)}" } },
  });
  showBlame(host);
  assert.deepEqual(blameLines(host).at(-1).slice(0, 2), ["State", "FILLED"]);
  replies.order_versions = { type: "reply", rows: [hrow(1, "insert", "carol", { id: "O2", qty: 9, status: "new" })] };
  ws.select([{ id: "O2", qty: 9, status: "new", _mkio_version: 1 }]);
  await flush();
  assert.equal(find(host, "mkui-history-pair").textContent, "as at v1", "the view is a preference, not per record");
  assert.deepEqual(blameLines(host).map((l) => l[0]), ["id", "qty", "State"]);
});

test("blame: copy takes the provenance grid", async () => {
  const { host, paneEl } = await makePane({ rows: [liveRow()] });
  showBlame(host);
  paneEl._editActions.copy();
  await flush();
  const tsv = clipboard[0].parts["text/plain"].text.split("\r\n");
  assert.equal(tsv[0], "\tv3\tVersion\tUser\tWhen");
  assert.match(tsv[2], /^qty\t750\tv2\talice\t/);
});
