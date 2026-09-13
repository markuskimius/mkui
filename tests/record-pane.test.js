// Run with: node --test tests/record-pane.test.js
//
// The `mkio-record` pane: one record as a list of fields, pointed at that
// record by the link hub (or a table's selection), pinned and unpinned
// from its own toolbar.
import { test } from "node:test";
import assert from "node:assert/strict";

/* ── Minimal DOM (as history-pane.test.js has it) ─────────────────────── */

function mockEl(tag) {
  const el = {
    tagName: (tag ?? "").toUpperCase(),
    className: "", title: "", disabled: false, hidden: false, type: "",
    dataset: {}, _ch: [], _ev: {}, _parent: null, _text: null,
    style: {
      setProperty(k, v) { this[k] = v; },
      removeProperty(k) { delete this[k]; },
    },
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
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 400, height: 500 }),
    querySelector: () => null,
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
globalThis.setTimeout = (fn) => 0;
globalThis.clearTimeout = () => {};
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
let clipboard = [];
globalThis.ClipboardItem = class { constructor(parts) { this.parts = parts; } };
globalThis.Blob = class { constructor(parts) { this.text = parts.join(""); } };
globalThis.navigator = { clipboard: { write: async (items) => { clipboard.push(items[0]); } } };

// The mkio client: one query subscription per record, replayed by hand.
let replies = {};
let requests = [];
let subs = [];
globalThis.MkioClient = class {
  async connect() {}
  async request(service, data) {
    requests.push({ service, data });
    const r = replies[service];
    if (r === undefined) return { type: "error", message: `no stub for '${service}'` };
    return typeof r === "function" ? r(data) : r;
  }
  subscribe(service, protocol, opts) {
    subs.push({ service, protocol, ...opts, live: true });
  }
  unsubscribe(subid) {
    for (const s of subs) if (s.subid === subid) s.live = false;
  }
};

const { getPaneType, LinkHub, State } = await import("../mkui/static/src/core.js");
await import("../mkui/static/src/widgets/mkio-record.js");
const factory = getPaneType("mkio-record");

/* ── Harness ──────────────────────────────────────────────────────────── */

const ORDER = { id: "O1", symbol: "VOD", qty: 750, status: "filled", _mkio_row: "O1" };

function makeWorkspace(opts = {}) {
  const listeners = new Set();
  let rows = opts.rows ?? [];
  return {
    getPaneSpec: (id) => (id === "orders" ? opts.srcSpec ?? {} : null),
    paneHistory: (id) => (id === "orders" && opts.history ? { spec: opts.history } : null),
    onPaneSelection: (id, fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    paneRows: (id) => (id === "orders" ? rows : []),
    setPaneAutoTitle(id, text) { this.tab = text; return true; },
    tab: null,
    select(next) { rows = next; for (const fn of listeners) fn(); },
  };
}

async function makePane(opts = {}) {
  replies = { _mkio: { type: "reply", row: { table: "orders", columns: [
    { name: "id", pk: true }, { name: "symbol", pk: false },
  ] } }, ...(opts.replies ?? {}) };
  requests = [];
  subs = [];
  clipboard = [];
  const host = mockEl("div");
  const paneEl = mockEl("mkui-pane");
  paneEl.dataset.id = "detail";
  const ws = makeWorkspace(opts);
  host._closest = (sel) => (sel === "mkui-workspace" ? ws : sel === "mkui-pane" ? paneEl : null);
  const app = {
    config: { mkio: { url: "ws://localhost:8080/ws", ...(opts.offline !== undefined ? { offline: opts.offline } : {}) } },
    state: new State({}),
    links: opts.hub ?? new LinkHub(),
  };
  await factory({ type: "mkio-record", service: "orders", key: ["id"], ...(opts.spec ?? {}) }, app, host);
  await flush();
  return { host, paneEl, ws, app, hub: app.links };
}

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const sub = () => subs.filter((s) => s.live).at(-1) ?? null;
const deliver = (rows) => { sub()?.onSnapshot?.(rows); };

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
const fields = (host) => findAll(host, "mkui-record-field").map((f) => [
  find(f, "mkui-record-fname").textContent, find(f, "mkui-record-fvalue").textContent,
]);
const emptyText = (host) => find(host, "mkui-record-empty")?.textContent ?? null;
const chip = (host) => find(host, "mkui-chip-record");
const pin = (host) => find(host, "mkui-record-pin");
const click = (node, ev = {}) => { for (const fn of node._ev.mousedown ?? []) fn({ button: 0, ...ev }); };
const clickChip = (node) => { for (const fn of node._ev.click ?? []) fn({ stopPropagation() {} }); };

/* ── Listening ────────────────────────────────────────────────────────── */

test("a window listening for a name says so until something is broadcast", async () => {
  const { host } = await makePane({ spec: { record: { listen: { order_id: "id" } } } });
  assert.match(emptyText(host), /Waiting for order_id/);
  assert.equal(sub(), null, "and asks the server nothing");
  assert.equal(chip(host).textContent, "Listen: order_id");
});

test("a broadcast points the window at that record", async () => {
  const { host, hub, ws } = await makePane({ spec: { record: { listen: { order_id: "id" } } } });
  hub.publish("orders", { order_id: ["O1"] });
  await flush();
  assert.equal(sub().service, "orders");
  assert.equal(sub().filter, "id == 'O1'", "narrowed to the record, server-side");
  deliver([ORDER]);
  assert.deepEqual(fields(host), [
    ["id", "O1"], ["symbol", "VOD"], ["qty", "750"], ["status", "filled"],
  ], "_mkio_ columns stay out of a detail window");
  assert.equal(ws.tab, "O1", "and the record names the tab");
});

test("a numeric key is not quoted into the filter", async () => {
  const { hub } = await makePane({ spec: { record: { listen: { order_id: "id" } } } });
  hub.publish("orders", { order_id: [4711] });
  await flush();
  assert.equal(sub().filter, "id == 4711");
});

test("`type` keeps an id that looks like a number a string", async () => {
  const { hub } = await makePane({
    spec: { record: { listen: { order_id: { column: "id", type: "string" } } } },
  });
  hub.publish("orders", { order_id: [4711] });
  await flush();
  assert.equal(sub().filter, "id == '4711'");
});

test("the next broadcast re-aims the subscription", async () => {
  const { hub } = await makePane({ spec: { record: { listen: { order_id: "id" } } } });
  hub.publish("orders", { order_id: ["O1"] });
  await flush();
  const first = sub();
  hub.publish("orders", { order_id: ["O2"] });
  await flush();
  assert.equal(first.live, false, "the old record's subscription is dropped");
  assert.equal(sub().filter, "id == 'O2'");
});

test("a retraction empties the window, and `retain` keeps it", async () => {
  const { host, hub } = await makePane({ spec: { record: { listen: { order_id: "id" } } } });
  hub.publish("orders", { order_id: ["O1"] });
  await flush();
  deliver([ORDER]);
  hub.publish("orders", { order_id: null });
  await flush();
  assert.match(emptyText(host), /Waiting for order_id/);

  const kept = await makePane({ spec: { record: { listen: { order_id: "id" }, retain: true } } });
  kept.hub.publish("orders", { order_id: ["O1"] });
  await flush();
  deliver([ORDER]);
  kept.hub.publish("orders", { order_id: null });
  await flush();
  assert.equal(emptyText(kept.host), null);
  assert.deepEqual(fields(kept.host)[0], ["id", "O1"], "still on the last record");
});

/* ── The pin ──────────────────────────────────────────────────────────── */

test("the pin freezes the window; unpinning catches up", async () => {
  const { host, hub } = await makePane({ spec: { record: { listen: { order_id: "id" } } } });
  hub.publish("orders", { order_id: ["O1"] });
  await flush();
  deliver([ORDER]);

  click(pin(host));
  await flush();
  assert.ok(pin(host).classList.contains("active"));
  assert.ok(chip(host).classList.contains("mkui-chip-off"));

  hub.publish("orders", { order_id: ["O2"] });
  await flush();
  assert.equal(sub().filter, "id == 'O1'", "pinned: the new broadcast is ignored");

  click(pin(host));
  await flush();
  assert.equal(sub().filter, "id == 'O2'", "unpinned: back to the world");
});

test("the chip pauses the same switch the pin does", async () => {
  const { host, hub } = await makePane({ spec: { record: { listen: { order_id: "id" } } } });
  hub.publish("orders", { order_id: ["O1"] });
  await flush();
  clickChip(find(chip(host), "mkui-chip-main"));
  await flush();
  assert.ok(pin(host).classList.contains("active"));
});

/* ── The other sources ────────────────────────────────────────────────── */

test("follow: the window tracks a table's selection", async () => {
  const { host, ws } = await makePane({ spec: { source: "orders", record: undefined }, rows: [ORDER] });
  await flush();
  assert.equal(sub().filter, "id == 'O1'");
  ws.select([{ id: "O2" }]);
  await flush();
  assert.equal(sub().filter, "id == 'O2'");
  assert.equal(ws.tab, "O2");
});

test("key: a window configured for one record stays on it, pin disabled", async () => {
  const { host, hub } = await makePane({ spec: { record: { key: { id: "O9" } } } });
  assert.equal(sub().filter, "id == 'O9'");
  assert.equal(pin(host).disabled, true);
  hub.publish("orders", { order_id: ["O1"] });
  await flush();
  assert.equal(sub().filter, "id == 'O9'");
});

test("state: the window reads a row published into app state", async () => {
  const { host, app } = await makePane({ spec: { record: { state: "sel.order" } } });
  assert.match(emptyText(host), /Nothing has been published/);
  app.state.set("sel.order", { id: "O3" });
  await flush();
  assert.equal(sub().filter, "id == 'O3'");
});

/* ── Presentation ─────────────────────────────────────────────────────── */

test("fields, labels and display templates decide what is shown", async () => {
  const { host } = await makePane({
    spec: {
      record: { key: { id: "O1" } },
      fields: ["symbol", "qty"],
      labels: { qty: "Quantity" },
      display: { qty: "${value} lots" },
    },
  });
  deliver([ORDER]);
  assert.deepEqual(fields(host), [["symbol", "VOD"], ["Quantity", "750 lots"]]);
});

test("a source table lends its labels and display templates", async () => {
  const { host } = await makePane({
    spec: { source: "orders", record: { key: { id: "O1" } }, fields: ["qty"] },
    srcSpec: { labels: { qty: "Quantity" }, display: { qty: "${value}!" } },
  });
  deliver([ORDER]);
  assert.deepEqual(fields(host), [["Quantity", "750!"]]);
});

test("styles apply to the value, backgrounds through the custom property", async () => {
  const { host } = await makePane({
    spec: {
      record: { key: { id: "O1" } }, fields: ["qty"],
      styles: { qty: [{ when: "value > 500", color: "red", background: "pink" }] },
    },
  });
  deliver([ORDER]);
  const val = find(host, "mkui-record-fvalue");
  assert.equal(val.style.color, "red");
  assert.equal(val.style["--mkui-cell-bg"], "pink", "never an inline background");
  assert.ok(val.classList.contains("mkui-cell-styled"));
});

test("groups fold the list into sections, and fold away on a click", async () => {
  const { host } = await makePane({
    spec: {
      record: { key: { id: "O1" } },
      fields: ["id", "symbol", "qty"],
      groups: [{ label: "Execution", columns: ["qty"] }],
    },
  });
  deliver([ORDER]);
  const heads = findAll(host, "mkui-record-group-head");
  assert.deepEqual(heads.map((h) => h.textContent), ["Execution", "Other"]);
  assert.equal(fields(host).length, 3);
  click(heads[0]);
  assert.deepEqual(fields(host).map((f) => f[0]), ["id", "symbol"], "the folded section's fields are gone");
});

test("an empty field reads as a dash, and a missing record says so", async () => {
  const { host } = await makePane({ spec: { record: { key: { id: "O1" } }, fields: ["symbol"] } });
  deliver([{ id: "O1", symbol: "" }]);
  assert.deepEqual(fields(host), [["symbol", "—"]]);
  deliver([]);
  assert.match(emptyText(host), /not in the service/);
});

/* ── Live ─────────────────────────────────────────────────────────────── */

test("an edit elsewhere arrives without asking again", async () => {
  const { host } = await makePane({ spec: { record: { key: { id: "O1" } }, fields: ["qty"] } });
  deliver([ORDER]);
  assert.deepEqual(fields(host), [["qty", "750"]]);
  sub().onUpdate("replace", { ...ORDER, qty: 900 });
  assert.deepEqual(fields(host), [["qty", "900"]]);
  sub().onUpdate("delete", ORDER);
  assert.match(emptyText(host), /not in the service/);
});

/* ── Hooks ────────────────────────────────────────────────────────────── */

test("the pane exposes the record hook the workspace and actions speak to", async () => {
  const { paneEl } = await makePane({ spec: { record: { listen: { order_id: "id" } } } });
  assert.equal(typeof paneEl._record.set, "function");
  paneEl._record.set({ id: "O7" });
  await flush();
  assert.equal(sub().filter, "id == 'O7'");
  assert.equal(paneEl._record.get().from, "manual");
  assert.deepEqual(paneEl._record.config(), {
    retain: false, listening: true, listen: { order_id: "id" },
  });
});

test("the record hook re-points where the window listens", async () => {
  const { host, paneEl, hub } = await makePane({ spec: { record: { listen: { order_id: "id" } } } });
  paneEl._record.follow({ listen: { trade_id: "id" } });
  await flush();
  assert.equal(chip(host).textContent, "Listen: trade_id");
  hub.publish("trades", { trade_id: ["T1"] });
  await flush();
  assert.equal(sub().filter, "id == 'T1'");
});

test("what the window holds is readable, so another window can follow it", async () => {
  const { paneEl } = await makePane({ spec: { record: { key: { id: "O1" } } } });
  deliver([ORDER]);
  assert.deepEqual(paneEl._data.selected(), [ORDER]);
});

test("copy takes the fields as shown", async () => {
  const { host, paneEl } = await makePane({
    spec: { record: { key: { id: "O1" } }, fields: ["qty"], labels: { qty: "Quantity" }, display: { qty: "${value} lots" } },
  });
  deliver([ORDER]);
  assert.equal(paneEl._editActions.copy(), true);
  await flush();
  assert.match(clipboard[0].parts["text/plain"].text, /Quantity\t750 lots/);
});

test("closing the pane drops the subscription; opening it reads again", async () => {
  const { paneEl } = await makePane({ spec: { record: { key: { id: "O1" } } } });
  assert.ok(sub());
  paneEl.dispatchEvent({ type: "mkui-pane-close" });
  assert.equal(sub(), null);
  paneEl.dispatchEvent({ type: "mkui-pane-open" });
  await flush();
  assert.equal(sub().filter, "id == 'O1'");
});

/* ── Configuration errors ─────────────────────────────────────────────── */

test("no service says so rather than failing quietly", async () => {
  const { host } = await makePane({ spec: { service: null, record: { key: { id: "O1" } } } });
  assert.match(emptyText(host), /No `service`/);
});

test("without a configured key the server is asked which columns identify a record", async () => {
  const { host } = await makePane({ spec: { key: null, record: { key: { id: "O1" } } } });
  await flush();
  assert.deepEqual(requests.map((r) => r.service), ["_mkio"]);
  assert.equal(sub().filter, "id == 'O1'");
});

test("a field the table keeps no history of is marked, from the same schema reply", async () => {
  const { host } = await makePane({
    spec: { key: null, fields: ["id", "symbol", "note"], record: { key: { id: "O1" } } },
    replies: { _mkio: { type: "reply", row: { table: "orders", columns: [
      { name: "id", pk: true }, { name: "symbol", pk: false }, { name: "note", pk: false },
    ], unversioned: ["note"] } } },
  });
  await flush();
  sub().onSnapshot([{ ...ORDER, note: "call back" }]);
  const marked = findAll(host, "mkui-record-field").filter((f) => f.classList.contains("mkui-record-unversioned"));
  assert.deepEqual(marked.map((f) => find(f, "mkui-record-fname").title), ["note — not versioned: changes record no version, and undo/redo leave it as it is"]);
  assert.deepEqual(marked.map((f) => find(f, "mkui-record-fvalue").textContent), ["call back"]);
  // the others are not
  assert.equal(find(host, "mkui-record-fname").title, "id");
});

test("a configured key still reads the schema, so the marker does not depend on it", async () => {
  const { host } = await makePane({
    spec: { key: ["id"], fields: ["id", "note"], record: { key: { id: "O1" } } },
    replies: { _mkio: { type: "reply", row: { table: "orders", columns: [{ name: "id", pk: true }], unversioned: ["note"] } } },
  });
  await flush();
  assert.deepEqual(requests.map((r) => r.service), ["_mkio"]);
  assert.equal(sub().filter, "id == 'O1'");
  sub().onSnapshot([{ ...ORDER, note: "" }]);
  const marked = findAll(host, "mkui-record-field").filter((f) => f.classList.contains("mkui-record-unversioned"));
  assert.deepEqual(marked.map((f) => find(f, "mkui-record-fname").textContent), ["note"]);
});

test("a bad record block warns and leaves the window following nothing", async () => {
  const warned = [];
  const orig = console.warn;
  console.warn = (...a) => warned.push(a.join(" "));
  try {
    const { host } = await makePane({ spec: { record: { follow: 7 } } });
    assert.match(warned.join("\n"), /bad record/);
    assert.match(emptyText(host), /nothing to follow/);
  } finally {
    console.warn = orig;
  }
});

/* ── Stale stamp (mkio.offline.stale) ─────────────────────────────────── */

const stale = (host) => find(host, "mkui-record-stale");
const staleText = (host) => stale(host)?._ch.find((c) => c.nodeType === 3)?.textContent ?? null;

test("a disconnect stamps the strip with when the record was last heard of; the next snapshot clears it", async () => {
  const { host, app } = await makePane({ spec: { record: { key: { id: "O1" } } } });
  await flush();
  app.state.set("mkio.connected", true);
  sub().onSnapshot([ORDER]);
  assert.equal(stale(host), null, "nothing while connected");

  app.state.set("mkio.connected", false);
  assert.ok(stale(host), "the stamp shows on disconnect");
  assert.match(staleText(host), /^as of \d\d:\d\d:\d\d$/);
  app.state.set("mkio.connected", false);
  assert.equal(findAll(host, "mkui-record-stale").length, 1, "one stamp under repeated callbacks");

  app.state.set("mkio.connected", true);
  assert.ok(stale(host), "stays until the record is heard of again");
  sub().onUpdate("replace", { ...ORDER, symbol: "GOOG" });
  assert.equal(stale(host), null, "the next callback clears it");
});

test("no stamp for a window showing no record, or with mkio.offline.stale = false", async () => {
  const empty = await makePane({ spec: { record: { key: { id: "O1" } } } });
  await flush();
  empty.app.state.set("mkio.connected", true);
  empty.app.state.set("mkio.connected", false);
  assert.equal(stale(empty.host), null, "never heard: nothing to stamp");
  empty.app.state.set("mkio.connected", true);
  sub().onSnapshot([]);
  empty.app.state.set("mkio.connected", false);
  assert.equal(stale(empty.host), null, "no record: nothing stale");

  const built = await makePane({ spec: { record: { key: { id: "O1" } } }, offline: { stale: false } });
  await flush();
  built.app.state.set("mkio.connected", true);
  sub().onSnapshot([ORDER]);
  built.app.state.set("mkio.connected", false);
  assert.equal(stale(built.host), null);
});
