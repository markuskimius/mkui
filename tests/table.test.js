// Run with: node --test tests/table.test.js
//
// mkio-table is a browser component so we provide lightweight DOM stubs
// before importing the module.  No jsdom dependency needed.
import { test } from "node:test";
import assert from "node:assert/strict";

/* ── Minimal browser globals ──────────────────────────────────────────── */

function detach(n) {
  if (!n || typeof n !== "object") return;
  const p = n._parent;
  if (p) {
    const i = p._ch.indexOf(n);
    if (i >= 0) p._ch.splice(i, 1);
  }
  n._parent = null;
}

function adopt(n, parent) {
  if (n && typeof n === "object") n._parent = parent;
}

function mockEl(tag) {
  const el = {
    tagName: tag?.toUpperCase() ?? "",
    className: "", textContent: "", disabled: false,
    type: "", placeholder: "",
    style: new Proxy({}, {
      set(t, p, v) { t[p] = v; return true; },
      get(t, p) {
        if (p === "setProperty") return (k, v) => { t[k] = v; };
        if (p === "removeProperty") return (k) => { delete t[k]; };
        return t[p] ?? "";
      },
    }),
    dataset: {},
    _ch: [],
    _ev: {},
    classList: {
      _s: new Set(),
      add(...cs) { for (const c of cs) this._s.add(c); },
      remove(...cs) { for (const c of cs) this._s.delete(c); },
      toggle(c, f) { f !== undefined ? (f ? this._s.add(c) : this._s.delete(c)) : (this._s.has(c) ? this._s.delete(c) : this._s.add(c)); },
      contains(c) { return this._s.has(c); },
    },
    append(...ns) { for (const n of ns) el.appendChild(n); },
    appendChild(n) { detach(n); adopt(n, el); el._ch.push(n); return n; },
    insertBefore(n, ref) {
      const items = n.tagName === "FRAGMENT" ? n._ch.splice(0) : [n];
      for (const it of items) detach(it);
      const i = el._ch.indexOf(ref);
      if (i >= 0) el._ch.splice(i, 0, ...items); else el._ch.push(...items);
      for (const it of items) adopt(it, el);
      return n;
    },
    remove() { detach(el); },
    removeChild(n) { detach(n); return n; },
    replaceWith(n) {
      const p = el._parent;
      if (!p) return;
      const i = p._ch.indexOf(el);
      detach(n);
      p._ch[i] = n;
      adopt(n, p);
      el._parent = null;
    },
    get nextSibling() {
      const p = el._parent;
      if (!p) return null;
      const i = p._ch.indexOf(el);
      return i >= 0 ? p._ch[i + 1] ?? null : null;
    },
    setAttribute(name, v) { if (name === "class") el.className = String(v); },
    addEventListener(e, fn) { (el._ev[e] ??= []).push(fn); },
    removeEventListener() {},
    querySelector(sel) {
      const m = sel.match(/\[data-col="([^"]+)"\]/);
      const match = m ? (c) => c.dataset?.col === m[1]
        : sel.startsWith(".") ? (c) => c.className?.includes(sel.slice(1))
        : (c) => c.tagName === sel.toUpperCase();
      const walk = (n) => {
        for (const c of n._ch ?? []) {
          if (match(c)) return c;
          const r = walk(c);
          if (r) return r;
        }
        return null;
      };
      return walk(el);
    },
    querySelectorAll(sel) {
      const match = sel.startsWith(".")
        ? (c) => c.className?.includes(sel.slice(1))
        : (c) => c.tagName === sel.toUpperCase();
      const out = [];
      const walk = (n) => {
        for (const c of n._ch ?? []) {
          if (match(c)) out.push(c);
          walk(c);
        }
      };
      walk(el);
      return out;
    },
    closest() { return null; },
    contains() { return false; },
    getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 }; },
    dispatchEvent() {},
    focus() {},
    get children() { return el._ch; },
    get offsetWidth() { return 100; },
    get clientWidth() { return el._clientWidth ?? 400; },
    get clientHeight() { return el._clientHeight ?? 10000; },
  };

  let _ih = "";
  Object.defineProperty(el, "innerHTML", {
    get() { return _ih; },
    set(v) {
      _ih = v;
      if (v === "") {
        for (const c of el._ch) if (c && typeof c === "object") c._parent = null;
        el._ch.length = 0;
      }
    },
  });

  let _st = 0;
  Object.defineProperty(el, "scrollTop", {
    get() { return _st; },
    set(v) { _st = v; },
  });

  return el;
}

globalThis.document = {
  createElement: (tag) => {
    const el = mockEl(tag);
    // Canvas text measurement (column width auto-grow): 6px per character,
    // matching the mocked chW below.
    if (tag === "canvas")
      el.getContext = () => ({ font: "", measureText: (s) => ({ width: s.length * 6 }) });
    return el;
  },
  createElementNS: (_ns, tag) => mockEl(tag),
  createTextNode: (text) => ({ textContent: text, nodeType: 3 }),
  createDocumentFragment() {
    const frag = mockEl("fragment");
    frag.firstChild = null;
    Object.defineProperty(frag, "firstChild", { get() { return frag._ch[0] ?? null; } });
    return frag;
  },
  _ev: {},
  addEventListener(e, fn) { (this._ev[e] ??= []).push(fn); },
  removeEventListener(e, fn) {
    const a = this._ev[e];
    if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
  },
  head: mockEl("head"),
};
globalThis.window = globalThis;
globalThis.CSS = { escape: (s) => s };
// Table font for width measurement — chW ("0") is 6px via the canvas mock.
globalThis.getComputedStyle = () => ({ fontWeight: "400", fontSize: "12px", fontFamily: "monospace" });

let rafQueue = [];
globalThis.requestAnimationFrame = (fn) => { rafQueue.push(fn); return rafQueue.length; };
function flushRaf() { while (rafQueue.length) rafQueue.shift()(); }

let timerIdSeq = 0;
let pendingTimers = new Map();
globalThis.setTimeout = (fn, ms) => { const id = ++timerIdSeq; pendingTimers.set(id, { fn, ms }); return id; };
globalThis.clearTimeout = (id) => { pendingTimers.delete(id); };
function advanceTimers() { for (const { fn } of pendingTimers.values()) fn(); pendingTimers.clear(); }

let ioCallbacks = [];
globalThis.IntersectionObserver = class {
  constructor(cb) { this._cb = cb; ioCallbacks.push(cb); }
  observe() {}
  disconnect() {}
};

globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
};

let fakeClient;
globalThis.MkioClient = class {
  constructor() {
    this.calls = [];
    fakeClient = this;
  }
  async connect() {}
  subscribe(service, protocol, opts) {
    this.calls.push({ type: "subscribe", service, protocol, opts });
  }
  unsubscribe(subid) {
    this.calls.push({ type: "unsubscribe", subid });
  }
};

/* ── Import modules (after globals) ───────────────────────────────────── */

const { getPaneType, registerExprFunction } = await import("../mkui/static/src/core.js");
await import("../mkui/static/src/widgets/mkio-table.js");

const factory = getPaneType("mkio-table");

/* ── Helpers ──────────────────────────────────────────────────────────── */

function makeState(init) {
  const store = new Map(init);
  const subs = new Map();
  const nWrites = new Map();
  return {
    get: (k) => k === undefined ? Object.fromEntries(store) : store.get(k),
    writes: (k) => nWrites.get(k) ?? 0,
    subscribe: (k, cb) => {
      if (!subs.has(k)) subs.set(k, []);
      subs.get(k).push(cb);
      cb(store.get(k));
    },
    set: (k, v) => {
      store.set(k, v);
      nWrites.set(k, (nWrites.get(k) ?? 0) + 1);
      for (const cb of subs.get(k) || []) cb(v);
    },
  };
}

async function createTable(specOverrides = {}) {
  rafQueue.length = 0;
  pendingTimers.clear();
  const host = mockEl("div");
  const paneEl = mockEl("mkui-pane");
  host.closest = (sel) => sel === "mkui-pane" ? paneEl : null;
  host._paneEl = paneEl;
  const state = makeState([["mkio.connected", true]]);
  const app = {
    config: { mkio: { url: "ws://localhost:8080/ws" } },
    state,
  };
  // rowColumn defaults off here so the long-standing assertions can keep
  // indexing header/row children directly; row-column behavior has its own
  // tests that opt back in.
  const spec = { service: "test-svc", rowColumn: false, ...specOverrides };
  const prevLen = ioCallbacks.length;
  await factory(spec, app, host);
  const io = ioCallbacks.length > prevLen ? ioCallbacks[ioCallbacks.length - 1] : null;
  return { host, spec, io, state };
}

function lastSubscribe() {
  return fakeClient.calls.filter(c => c.type === "subscribe").at(-1);
}
function lastSubscribeBySubid(suffix) {
  return fakeClient.calls.filter(c => c.type === "subscribe" && c.opts.subid?.endsWith(suffix)).at(-1);
}

function triggerVisible(io) { io([{ intersectionRatio: 1 }]); }
function triggerHidden(io) { io([{ intersectionRatio: 0 }]); }

function makeRows(n, startId = 0) {
  return Array.from({ length: n }, (_, i) => ({
    _mkio_row: String(startId + i),
    name: `row-${startId + i}`,
    value: startId + i,
  }));
}

function streamRef(id) {
  const h = String(Math.floor(id / 3600) % 24).padStart(2, "0");
  const m = String(Math.floor(id / 60) % 60).padStart(2, "0");
  const s = String(id % 60).padStart(2, "0");
  return `20260527 ${h}:${m}:${s}.000000000000`;
}

function testMidnightRef() {
  const d = new Date();
  const m = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const p = (n) => String(n).padStart(2, "0");
  return `${m.getUTCFullYear()}${p(m.getUTCMonth() + 1)}${p(m.getUTCDate())} ${p(m.getUTCHours())}:${p(m.getUTCMinutes())}:${p(m.getUTCSeconds())}.000000000000`;
}

function makeStreamRows(n, startId = 0) {
  return Array.from({ length: n }, (_, i) => ({
    _mkio_ref: streamRef(startId + i),
    name: `row-${startId + i}`,
    value: startId + i,
  }));
}

function findByClass(el, cls) {
  return el._ch.find(c => c.className === cls) ?? null;
}

// The table always scrolls inside its own area (the toolbar sits above it
// in the pane's flex column), so viewport mocks target that element.
const sh = (host) => findByClass(host, "mkui-table-scroll");

function getTable(host) {
  const table = findByClass(host, "mkui-table")
    ?? host._ch.find(h => findByClass(h, "mkui-table"))?._ch.find(c => c.className === "mkui-table");
  if (!table) {
    for (const child of host._ch) {
      const t = findByClass(child, "mkui-table");
      if (t) return t;
    }
    return null;
  }
  return table;
}

function getRawTbody(host) {
  return getTable(host)?._ch.find(c => c.tagName === "TBODY") ?? null;
}

// Facade that hides the virtual-scroll spacer rows so tests can keep
// asserting on data-row counts and order.
function getTbody(host) {
  const tb = getRawTbody(host);
  if (!tb) return null;
  return {
    get _ch() { return tb._ch.filter(c => !String(c.className).includes("mkui-vspacer")); },
  };
}

function spacerHeights(host) {
  const sp = getRawTbody(host)._ch.filter(c => String(c.className).includes("mkui-vspacer"));
  return sp.map(s => s._ch[0].style.height);
}

function getThead(host) {
  return getTable(host)?._ch.find(c => c.tagName === "THEAD") ?? null;
}

function getHeaderTexts(host) {
  const thead = getThead(host);
  if (!thead || !thead._ch.length) return [];
  const tr = thead._ch[0];
  return tr._ch.filter(th => !String(th.className).includes("mkui-th-filler")).map(th => {
    const inner = th._ch.find(n => n.className === "mkui-th-inner") ?? th;
    const lbl = inner._ch.find(n => n.className === "mkui-th-label");
    if (lbl) return lbl.textContent;
    const textNodes = inner._ch.filter(n => n.nodeType === 3);
    return textNodes.map(n => n.textContent).join("");
  });
}

/* ── Column headers & labels ──────────────────────────────────────────── */

test("pre-configured columns render header immediately before data", async () => {
  const { host } = await createTable({ columns: ["a", "b", "c"] });
  const texts = getHeaderTexts(host);
  assert.deepEqual(texts, ["a", "b", "c"]);
});

test("omitted columns: no header until first data row", async () => {
  const { host, io } = await createTable({});
  assert.deepEqual(getHeaderTexts(host), []);
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot([{ _mkio_row: "1", x: 10, y: 20 }]);
  assert.deepEqual(getHeaderTexts(host), ["x", "y"]);
});

test("labels maps column keys to display text in headers", async () => {
  const { host } = await createTable({
    columns: ["id", "name", "qty"],
    labels: { id: "ID", name: "Name", qty: "Quantity" },
  });
  assert.deepEqual(getHeaderTexts(host), ["ID", "Name", "Quantity"]);
});

test("labels: unlabelled columns fall back to column key", async () => {
  const { host } = await createTable({
    columns: ["id", "name", "raw"],
    labels: { id: "ID" },
  });
  assert.deepEqual(getHeaderTexts(host), ["ID", "name", "raw"]);
});

test("labels with auto-detected columns", async () => {
  const { host, io } = await createTable({
    labels: { x: "Ecks", y: "Why" },
  });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot([{ _mkio_row: "1", x: 10, y: 20 }]);
  assert.deepEqual(getHeaderTexts(host), ["Ecks", "Why"]);
});

test("labels without matching columns are ignored", async () => {
  const { host } = await createTable({
    columns: ["a", "b"],
    labels: { a: "Alpha", z: "Zulu" },
  });
  assert.deepEqual(getHeaderTexts(host), ["Alpha", "b"]);
});

test("empty labels object behaves like no labels", async () => {
  const { host } = await createTable({
    columns: ["x", "y"],
    labels: {},
  });
  assert.deepEqual(getHeaderTexts(host), ["x", "y"]);
});

test("pre-configured columns header survives re-render after data arrives", async () => {
  const { host, io } = await createTable({
    columns: ["a", "b"],
    labels: { a: "Alpha", b: "Beta" },
  });
  assert.deepEqual(getHeaderTexts(host), ["Alpha", "Beta"]);
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot([
    { _mkio_row: "1", a: 1, b: 2 },
    { _mkio_row: "2", a: 3, b: 4 },
  ]);
  assert.deepEqual(getHeaderTexts(host), ["Alpha", "Beta"]);
  assert.equal(getTbody(host)._ch.length, 2);
});

test("_mkio_ columns are hidden from header", async () => {
  const { host } = await createTable({
    columns: ["_mkio_row", "name", "value"],
  });
  assert.deepEqual(getHeaderTexts(host), ["name", "value"]);
});

/* ── Config & maxcount defaults ───────────────────────────────────────── */

test("maxcount defaults to 200 when not specified", async () => {
  const { io } = await createTable({ protocol: "query" });
  triggerVisible(io);
  assert.equal(lastSubscribe().opts.maxcount, 200);
});

test("maxcount can be overridden in spec", async () => {
  const { io } = await createTable({ protocol: "query", maxcount: 500 });
  triggerVisible(io);
  assert.equal(lastSubscribe().opts.maxcount, 500);
});

test("maxcount null disables query paging", async () => {
  const { io } = await createTable({ protocol: "query", maxcount: null });
  triggerVisible(io);
  assert.equal(lastSubscribe().opts.maxcount, undefined);
});

test("query never enters paged mode", async () => {
  const { io } = await createTable({ protocol: "query", maxcount: 200 });
  triggerVisible(io);
  const sub = lastSubscribe();
  assert.equal(sub.opts.onPage, undefined);
  assert.notEqual(sub.opts.onSnapshot, undefined);
});

test("stream with maxcount enters paged mode", async () => {
  const { io } = await createTable({ protocol: "stream", maxcount: 100 });
  triggerVisible(io);
  const sub = lastSubscribe();
  assert.equal(sub.opts.maxcount, 100);
  assert.equal(typeof sub.opts.onPage, "function");
  assert.equal(sub.opts.updates, false);
});

test("stream with null maxcount subscribes normally", async () => {
  const { io } = await createTable({ protocol: "stream", maxcount: null });
  triggerVisible(io);
  const sub = lastSubscribe();
  assert.equal(sub.opts.onPage, undefined);
  assert.notEqual(sub.opts.onSnapshot, undefined);
});

/* ── Chunked rendering ────────────────────────────────────────────────── */

test("small snapshot renders synchronously without rAF", async () => {
  const { io, host } = await createTable({ protocol: "query" });
  triggerVisible(io);
  const prevRaf = rafQueue.length;
  lastSubscribe().opts.onSnapshot(makeRows(50));
  assert.equal(rafQueue.length, prevRaf);
  assert.equal(getTbody(host)._ch.length, 50);
});

test("large snapshot renders in rAF-batched chunks", async () => {
  const { io, host } = await createTable({ protocol: "query" });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot(makeRows(250));
  const tbody = getTbody(host);
  assert.equal(tbody._ch.length, 100);
  flushRaf();
  assert.equal(tbody._ch.length, 250);
});

test("progress indicator shown during chunked rendering", async () => {
  const { io, host } = await createTable({ protocol: "query" });
  triggerVisible(io);
  const progress = findByClass(host, "mkui-table-progress");
  assert.ok(progress);
  lastSubscribe().opts.onSnapshot(makeRows(250));
  assert.notEqual(progress.style.display, "none");
  assert.ok(progress.textContent.includes("100"));
  assert.ok(progress.textContent.includes("250"));
  flushRaf();
  assert.equal(progress.style.display, "none");
});

test("new snapshot cancels in-progress chunking via generation counter", async () => {
  const { io, host } = await createTable({ protocol: "query" });
  triggerVisible(io);
  const onSnapshot = lastSubscribe().opts.onSnapshot;

  onSnapshot(makeRows(300));
  const tbody = getTbody(host);
  assert.equal(tbody._ch.length, 100);

  triggerHidden(io);
  advanceTimers();
  triggerVisible(io);
  const onSnapshot2 = lastSubscribe().opts.onSnapshot;
  onSnapshot2(makeRows(50, 1000));

  flushRaf();
  assert.equal(tbody._ch.length, 50);
});

/* ── Stream paging toolbar ────────────────────────────────────────────── */

test("paged stream creates toolbar with prev/next/live", async () => {
  const { host } = await createTable({ protocol: "stream", maxcount: 50 });
  const toolbar = findByClass(host, "mkui-table-paging");
  assert.ok(toolbar);
  assert.equal(toolbar._ch.length, 5);
  assert.ok(toolbar._ch[0]._ch.includes("Earlier"));
  assert.ok(toolbar._ch[0]._ch[0].className.includes("mkui-icon-chevron-left"));
  assert.ok(toolbar._ch[2]._ch.includes("Later"));
  assert.ok(toolbar._ch[2]._ch[1].className.includes("mkui-icon-chevron-right"));
  assert.ok(toolbar._ch[3]._ch.includes("Live"));
  assert.ok(toolbar._ch[3]._ch[0].className.includes("mkui-icon-dot"));
  assert.ok(toolbar._ch[4]._ch[0].className.includes("mkui-icon-refresh"));
});

test("non-paged stream has no toolbar", async () => {
  const { host } = await createTable({ protocol: "stream", maxcount: null });
  assert.equal(findByClass(host, "mkui-table-paging"), null);
});

test("query has no toolbar", async () => {
  const { host } = await createTable({ protocol: "query" });
  assert.equal(findByClass(host, "mkui-table-paging"), null);
});

/* ── Stream page navigation ───────────────────────────────────────────── */

test("initial page loads from midnight today on first visibility", async () => {
  const { io } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  const sub = lastSubscribe();
  assert.equal(sub.opts.ref, testMidnightRef());
  assert.equal(sub.opts.maxcount, 50);
  assert.equal(sub.opts.updates, false);
});

test("start config empty string loads from beginning", async () => {
  const { io } = await createTable({ protocol: "stream", maxcount: 50, start: "" });
  triggerVisible(io);
  const sub = lastSubscribe();
  assert.equal(sub.opts.ref, null);
});

test("page navigation: next uses lastRef, prev uses firstRef with before", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);

  const toolbar = findByClass(host, "mkui-table-paging");
  const [prevBtn, pageInfoEl, nextBtn] = toolbar._ch;

  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "cursor-A" });
  assert.ok(pageInfoEl.textContent.includes("–"), "shows time range");
  assert.equal(prevBtn.disabled, false, "earlier enabled (started from midnight ref)");
  assert.equal(nextBtn.disabled, false);
  const page1Text = pageInfoEl.textContent;

  nextBtn._ev.click[0]();
  assert.equal(lastSubscribe().opts.ref, streamRef(49), "next uses lastRef from row data");
  assert.equal(lastSubscribe().opts.before, undefined);

  lastSubscribe().opts.onPage(makeStreamRows(50, 50), { hasmore: true, ref: "cursor-B" });
  assert.ok(pageInfoEl.textContent.includes("–"), "shows time range");
  assert.notEqual(pageInfoEl.textContent, page1Text, "time range changed");
  assert.equal(prevBtn.disabled, false);

  nextBtn._ev.click[0]();
  assert.equal(lastSubscribe().opts.ref, streamRef(99), "next uses lastRef from row data");

  lastSubscribe().opts.onPage(makeStreamRows(20, 100), { hasmore: false, ref: "cursor-C" });
  assert.ok(pageInfoEl.textContent.includes("–"), "shows time range");
  assert.equal(nextBtn.disabled, true);

  prevBtn._ev.click[0]();
  assert.equal(lastSubscribe().opts.ref, streamRef(100), "prev uses firstRef");
  assert.equal(lastSubscribe().opts.before, true);
  lastSubscribe().opts.onPage(makeStreamRows(50, 50), { hasmore: true, ref: "cursor-B2" });
  assert.ok(pageInfoEl.textContent.includes("–"), "shows time range");

  prevBtn._ev.click[0]();
  assert.equal(lastSubscribe().opts.ref, streamRef(50), "prev uses firstRef");
  assert.equal(lastSubscribe().opts.before, true);
});

test("page data is rendered as table rows", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(25), { hasmore: false, ref: "end" });
  const tbody = getTbody(host);
  assert.equal(tbody._ch.length, 25);
});

test("navigating pages clears previous rows", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);

  lastSubscribe().opts.onPage(makeStreamRows(30), { hasmore: true, ref: "r1" });
  const tbody = getTbody(host);
  assert.equal(tbody._ch.length, 30);

  const toolbar = findByClass(host, "mkui-table-paging");
  toolbar._ch[2]._ev.click[0]();
  lastSubscribe().opts.onPage(makeStreamRows(10, 30), { hasmore: false, ref: "r2" });
  assert.equal(tbody._ch.length, 10);
});

test("earlier disabled when start is beginning (null ref)", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50, start: "" });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r" });

  const callsBefore = fakeClient.calls.length;
  const prevBtn = findByClass(host, "mkui-table-paging")._ch[0];
  assert.equal(prevBtn.disabled, true, "earlier disabled on null-ref start");
  prevBtn._ev.click[0]();
  assert.equal(fakeClient.calls.length, callsBefore);
});

test("fetchPage forward with non-null ref enables prev", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50, start: "" });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r1" });

  const toolbar = findByClass(host, "mkui-table-paging");
  const prevBtn = toolbar._ch[0];
  assert.equal(prevBtn.disabled, true, "prev disabled on null-ref start");

  toolbar._ch[2]._ev.click[0]();
  lastSubscribe().opts.onPage(makeStreamRows(50, 50), { hasmore: true, ref: "r2" });
  assert.equal(prevBtn.disabled, false, "prev enabled on page 2");
});

test("fetchPage backward sets pageHasPrev from hasmore and enables next", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r1" });

  const toolbar = findByClass(host, "mkui-table-paging");
  const prevBtn = toolbar._ch[0];
  const nextBtn = toolbar._ch[2];

  toolbar._ch[2]._ev.click[0]();
  lastSubscribe().opts.onPage(makeStreamRows(50, 50), { hasmore: true, ref: "r2" });

  toolbar._ch[2]._ev.click[0]();
  lastSubscribe().opts.onPage(makeStreamRows(20, 100), { hasmore: false, ref: "r3" });
  assert.equal(nextBtn.disabled, true);

  prevBtn._ev.click[0]();
  const sub = lastSubscribe();
  assert.equal(sub.opts.before, true);
  sub.opts.onPage(makeStreamRows(50, 50), { hasmore: true, ref: "r2b" });
  assert.equal(prevBtn.disabled, false, "prev enabled from hasmore=true");
  assert.equal(nextBtn.disabled, false, "next enabled after backward fetch");
});

test("firstRef tracks first row of fetched page", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50, 10), { hasmore: true, ref: "r1" });

  const toolbar = findByClass(host, "mkui-table-paging");
  toolbar._ch[2]._ev.click[0]();
  lastSubscribe().opts.onPage(makeStreamRows(50, 60), { hasmore: false, ref: "r2" });

  toolbar._ch[0]._ev.click[0]();
  assert.equal(lastSubscribe().opts.ref, streamRef(60), "prev uses firstRef of page 2");
  assert.equal(lastSubscribe().opts.before, true);
});

test("empty backward page fetch re-fetches previous page with Earlier disabled", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r1" });

  const toolbar = findByClass(host, "mkui-table-paging");
  toolbar._ch[2]._ev.click[0]();
  lastSubscribe().opts.onPage(makeStreamRows(50, 50), { hasmore: false, ref: "r2" });

  toolbar._ch[0]._ev.click[0]();
  lastSubscribe().opts.onPage([], { hasmore: false, ref: null });

  const refetch = lastSubscribe();
  assert.equal(refetch.opts.ref, streamRef(49), "re-fetches using the saved forward ref");
  assert.equal(refetch.opts.before, undefined, "forward fetch (not backward)");

  refetch.opts.onPage(makeStreamRows(50, 50), { hasmore: false, ref: "r2b" });
  assert.equal(getTbody(host)._ch.length, 50, "original page restored");
  assert.equal(toolbar._ch[0].disabled, true, "Earlier disabled (no earlier data)");
});

test("next on last page is a no-op", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(10), { hasmore: false, ref: "r" });

  const callsBefore = fakeClient.calls.length;
  const nextBtn = findByClass(host, "mkui-table-paging")._ch[2];
  nextBtn._ev.click[0]();
  assert.equal(fakeClient.calls.length, callsBefore);
});

/* ── Go Live ──────────────────────────────────────────────────────────── */

test("Go Live keeps toolbar visible, disables paging, subscribes live", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r" });

  const toolbar = findByClass(host, "mkui-table-paging");
  const prevBtn = toolbar._ch[0];
  const pageInfo = toolbar._ch[1];
  const nextBtn = toolbar._ch[2];
  const liveBtn = toolbar._ch[3];
  liveBtn._ev.click[0]();

  assert.notEqual(toolbar.style.display, "none");
  assert.equal(prevBtn.disabled, false, "earlier enabled (started from midnight ref)");
  assert.equal(nextBtn.disabled, true);
  assert.equal(pageInfo.textContent, "Live");
  assert.ok(liveBtn.classList.contains("active"));
  const sub = lastSubscribe();
  assert.equal(sub.opts.onPage, undefined);
  assert.equal(sub.opts.maxcount, undefined);
  assert.notEqual(sub.opts.onSnapshot, undefined);
});

test("Go Live from page > 1 enables prev", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r1" });

  const toolbar = findByClass(host, "mkui-table-paging");
  const prevBtn = toolbar._ch[0];
  const pageInfo = toolbar._ch[1];
  const nextBtn = toolbar._ch[2];
  const liveBtn = toolbar._ch[3];
  nextBtn._ev.click[0]();
  lastSubscribe().opts.onPage(makeStreamRows(50, 50), { hasmore: true, ref: "r2" });

  liveBtn._ev.click[0]();
  assert.equal(prevBtn.disabled, false, "prev enabled when page has previous");
  assert.equal(nextBtn.disabled, true, "next always disabled in live mode");
  assert.equal(pageInfo.textContent, "Live");
  assert.ok(liveBtn.classList.contains("active"));
});

test("Prev in live mode adds previous page rows to table", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r1" });

  const toolbar = findByClass(host, "mkui-table-paging");
  const prevBtn = toolbar._ch[0];
  const pageInfo = toolbar._ch[1];
  const nextBtn = toolbar._ch[2];
  const liveBtn = toolbar._ch[3];
  nextBtn._ev.click[0]();
  lastSubscribe().opts.onPage(makeStreamRows(50, 50), { hasmore: false, ref: "r2" });
  assert.equal(getTbody(host)._ch.length, 50);

  liveBtn._ev.click[0]();
  const liveSub = lastSubscribe();
  liveSub.opts.onSnapshot(makeStreamRows(5, 100));
  assert.equal(getTbody(host)._ch.length, 55, "page rows + live data");

  prevBtn._ev.click[0]();
  assert.ok(liveBtn.classList.contains("active"), "still in live mode");
  const pageSub = lastSubscribeBySubid("-page");
  assert.equal(pageSub.opts.ref, streamRef(50), "prev uses firstRef of page 2");
  assert.equal(pageSub.opts.before, true);
  assert.notEqual(pageSub.opts.subid, liveSub.opts.subid, "uses separate subid");

  pageSub.opts.onPage(makeStreamRows(50), { hasmore: false, ref: "r1" });
  assert.equal(getTbody(host)._ch.length, 105, "prev page added to existing rows");
  assert.ok(pageInfo.textContent.endsWith("– Live"), "shows time – Live");
  assert.equal(prevBtn.disabled, true, "prev disabled when no more previous");
  assert.equal(nextBtn.disabled, true, "next still disabled in live mode");
});

test("Live updates continue while fetching previous page", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r1" });
  const toolbar = findByClass(host, "mkui-table-paging");
  const nextBtn = toolbar._ch[2];
  nextBtn._ev.click[0]();
  lastSubscribe().opts.onPage(makeStreamRows(50, 50), { hasmore: false, ref: "r2" });

  const liveBtn = toolbar._ch[3];
  const prevBtn = toolbar._ch[0];
  liveBtn._ev.click[0]();
  const liveSub = lastSubscribe();

  prevBtn._ev.click[0]();
  liveSub.opts.onUpdate("insert", { _mkio_ref: "ref-live-1", name: "live", value: 1 });
  assert.equal(getTbody(host)._ch.length, 51, "live insert while prev pending");

  lastSubscribeBySubid("-page").opts.onPage(makeStreamRows(50), { hasmore: false });
  assert.equal(getTbody(host)._ch.length, 101, "prev page added after live insert");
});

test("Prev in live mode disabled while fetch is pending", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r1" });
  const toolbar = findByClass(host, "mkui-table-paging");
  toolbar._ch[2]._ev.click[0]();
  lastSubscribe().opts.onPage(makeStreamRows(50, 50), { hasmore: false, ref: "r2" });

  const liveBtn = toolbar._ch[3];
  const prevBtn = toolbar._ch[0];
  liveBtn._ev.click[0]();

  prevBtn._ev.click[0]();
  assert.equal(prevBtn.disabled, true, "disabled while fetching");

  lastSubscribeBySubid("-page").opts.onPage(makeStreamRows(50), { hasmore: true });
  assert.equal(prevBtn.disabled, false, "re-enabled after fetch completes");
});

test("Go Live keeps page rows and appends resumed snapshot", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r" });

  const toolbar = findByClass(host, "mkui-table-paging");
  const liveBtn = toolbar._ch[3];
  liveBtn._ev.click[0]();

  lastSubscribe().opts.onSnapshot(makeStreamRows(30, 50));
  assert.equal(getTbody(host)._ch.length, 80, "50 page rows + 30 new rows");
});

test("Go Live renders large snapshot in chunks", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r" });

  const toolbar = findByClass(host, "mkui-table-paging");
  const liveBtn = toolbar._ch[3];
  liveBtn._ev.click[0]();

  lastSubscribe().opts.onSnapshot(makeStreamRows(250));
  const tbody = getTbody(host);
  assert.equal(tbody._ch.length, 100);
  flushRaf();
  assert.equal(tbody._ch.length, 250);
});

test("Go Live live updates append rows after snapshot", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r" });

  const toolbar = findByClass(host, "mkui-table-paging");
  const liveBtn = toolbar._ch[3];
  liveBtn._ev.click[0]();

  const sub = lastSubscribe();
  sub.opts.onSnapshot(makeStreamRows(5, 50));
  assert.equal(getTbody(host)._ch.length, 55, "50 page rows + 5 resumed");

  sub.opts.onUpdate("insert", { _mkio_ref: "ref-new-1", name: "live-1", value: 100 });
  assert.equal(getTbody(host)._ch.length, 56);

  sub.opts.onUpdate("insert", { _mkio_ref: "ref-new-2", name: "live-2", value: 101 });
  assert.equal(getTbody(host)._ch.length, 57);
});

test("Exit Live re-fetches saved page from server", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r" });

  const toolbar = findByClass(host, "mkui-table-paging");
  const prevBtn = toolbar._ch[0];
  const pageInfo = toolbar._ch[1];
  const nextBtn = toolbar._ch[2];
  const liveBtn = toolbar._ch[3];

  liveBtn._ev.click[0]();
  assert.ok(liveBtn.classList.contains("active"));

  liveBtn._ev.click[0]();
  assert.ok(!liveBtn.classList.contains("active"));

  const pageSub = lastSubscribe();
  assert.equal(pageSub.type, "subscribe", "exitLive fetches page from server");
  pageSub.opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r" });

  assert.equal(getTbody(host)._ch.length, 50, "page rows from server");
  assert.ok(pageInfo.textContent.includes("–"), "shows time range after exitLive");
  assert.equal(prevBtn.disabled, false, "earlier enabled (midnight ref)");
  assert.equal(nextBtn.disabled, false);
});

test("Exit Live clears live rows and re-fetches page", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r" });

  const toolbar = findByClass(host, "mkui-table-paging");
  const liveBtn = toolbar._ch[3];

  liveBtn._ev.click[0]();
  lastSubscribe().opts.onSnapshot(makeStreamRows(10, 500));
  assert.equal(getTbody(host)._ch.length, 60, "50 page + 10 live rows");

  liveBtn._ev.click[0]();
  assert.equal(getTbody(host)._ch.length, 0, "rows cleared before re-fetch");
  lastSubscribe().opts.onPage(makeStreamRows(51), { hasmore: true, ref: "r" });
  assert.equal(getTbody(host)._ch.length, 51, "fresh page from server");
});

test("Go Live from initial page enables earlier (midnight ref)", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r" });

  const toolbar = findByClass(host, "mkui-table-paging");
  const prevBtn = toolbar._ch[0];
  toolbar._ch[3]._ev.click[0]();
  assert.equal(prevBtn.disabled, false, "earlier enabled (started from midnight ref)");
});

test("Go Live from initial page disables prev with null start", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50, start: "" });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r" });

  const toolbar = findByClass(host, "mkui-table-paging");
  const prevBtn = toolbar._ch[0];
  toolbar._ch[3]._ev.click[0]();
  assert.equal(prevBtn.disabled, true, "prev disabled with null-ref start");
});

test("Earlier in live mode from null-ref start is a no-op", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50, start: "" });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r" });

  const toolbar = findByClass(host, "mkui-table-paging");
  toolbar._ch[3]._ev.click[0]();
  const callsBefore = fakeClient.calls.length;
  toolbar._ch[0]._ev.click[0]();
  assert.equal(fakeClient.calls.length, callsBefore, "no subscription from disabled prev");
});

test("Multiple consecutive prev clicks in live mode load successive pages", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r1" });

  const toolbar = findByClass(host, "mkui-table-paging");
  const prevBtn = toolbar._ch[0];
  const pageInfo = toolbar._ch[1];
  const nextBtn = toolbar._ch[2];
  const liveBtn = toolbar._ch[3];

  nextBtn._ev.click[0]();
  lastSubscribe().opts.onPage(makeStreamRows(50, 50), { hasmore: true, ref: "r2" });
  nextBtn._ev.click[0]();
  lastSubscribe().opts.onPage(makeStreamRows(50, 100), { hasmore: false, ref: "r3" });

  liveBtn._ev.click[0]();
  const liveSub = lastSubscribe();
  liveSub.opts.onSnapshot(makeStreamRows(5, 150));

  prevBtn._ev.click[0]();
  let pageSub = lastSubscribeBySubid("-page");
  assert.equal(pageSub.opts.ref, streamRef(100), "first prev uses firstRef from page 3");
  pageSub.opts.onPage(makeStreamRows(50, 50), { hasmore: true, ref: "rp1" });
  assert.ok(pageInfo.textContent.endsWith("– Live"), "shows time – Live after first prev");
  assert.equal(getTbody(host)._ch.length, 105, "page 3 rows + live + prev page");

  prevBtn._ev.click[0]();
  pageSub = lastSubscribeBySubid("-page");
  assert.equal(pageSub.opts.ref, streamRef(50), "second prev uses updated firstRef");
  pageSub.opts.onPage(makeStreamRows(50), { hasmore: false, ref: "rp2" });
  assert.ok(pageInfo.textContent.endsWith("– Live"), "shows time – Live after second prev");
  assert.equal(getTbody(host)._ch.length, 155, "all pages + live rows");
  assert.equal(prevBtn.disabled, true, "prev disabled after reaching beginning");
});

test("Exit live after loading prev pages re-fetches original saved page", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r1" });

  const toolbar = findByClass(host, "mkui-table-paging");
  const prevBtn = toolbar._ch[0];
  const pageInfo = toolbar._ch[1];
  const nextBtn = toolbar._ch[2];
  const liveBtn = toolbar._ch[3];

  nextBtn._ev.click[0]();
  lastSubscribe().opts.onPage(makeStreamRows(50, 50), { hasmore: false, ref: "r2" });

  liveBtn._ev.click[0]();
  lastSubscribe().opts.onSnapshot(makeStreamRows(10, 100));

  prevBtn._ev.click[0]();
  lastSubscribeBySubid("-page").opts.onPage(makeStreamRows(50), { hasmore: false });
  assert.equal(getTbody(host)._ch.length, 110, "prev page + live + page 2 rows");

  liveBtn._ev.click[0]();
  const pageSub = lastSubscribe();
  assert.equal(pageSub.type, "subscribe", "exitLive re-fetches page");
  pageSub.opts.onPage(makeStreamRows(50, 50), { hasmore: false, ref: "r2" });

  assert.equal(getTbody(host)._ch.length, 50, "fresh page from server");
  assert.ok(pageInfo.textContent.includes("–"), "shows time range");
  assert.equal(nextBtn.disabled, true);
  assert.equal(prevBtn.disabled, false);
});

test("live mode shows Disconnected when mkio.connected becomes false", async () => {
  const { io, host, state } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r" });

  const toolbar = findByClass(host, "mkui-table-paging");
  const pageInfo = toolbar._ch[1];
  const liveBtn = toolbar._ch[3];

  liveBtn._ev.click[0]();
  assert.ok(liveBtn.classList.contains("active"), "starts active");
  assert.ok(!liveBtn.classList.contains("disconnected"));
  assert.equal(pageInfo.textContent, "Live");

  state.set("mkio.connected", false);
  assert.ok(!liveBtn.classList.contains("active"), "active removed on disconnect");
  assert.ok(liveBtn.classList.contains("disconnected"), "disconnected added");
  assert.equal(pageInfo.textContent, "Disconnected");
});

test("live mode restores Live indicator when mkio.connected becomes true again", async () => {
  const { io, host, state } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r" });

  const toolbar = findByClass(host, "mkui-table-paging");
  const pageInfo = toolbar._ch[1];
  const liveBtn = toolbar._ch[3];

  liveBtn._ev.click[0]();
  state.set("mkio.connected", false);
  assert.equal(pageInfo.textContent, "Disconnected");

  state.set("mkio.connected", true);
  assert.ok(liveBtn.classList.contains("active"), "active restored on reconnect");
  assert.ok(!liveBtn.classList.contains("disconnected"), "disconnected removed");
  assert.equal(pageInfo.textContent, "Live");
});

test("disconnect in live mode from page > 1 shows Disconnected", async () => {
  const { io, host, state } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r1" });

  const toolbar = findByClass(host, "mkui-table-paging");
  const pageInfo = toolbar._ch[1];
  const nextBtn = toolbar._ch[2];
  const liveBtn = toolbar._ch[3];

  nextBtn._ev.click[0]();
  lastSubscribe().opts.onPage(makeStreamRows(50, 50), { hasmore: true, ref: "r2" });

  liveBtn._ev.click[0]();
  assert.equal(pageInfo.textContent, "Live");

  state.set("mkio.connected", false);
  assert.equal(pageInfo.textContent, "Disconnected");
});

test("disconnect in paged (non-live) mode does not add disconnected class", async () => {
  const { io, host, state } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r" });

  const toolbar = findByClass(host, "mkui-table-paging");
  const liveBtn = toolbar._ch[3];
  const pageInfo = toolbar._ch[1];

  state.set("mkio.connected", false);
  assert.ok(!liveBtn.classList.contains("active"));
  assert.ok(!liveBtn.classList.contains("disconnected"), "no disconnected in paged mode");
  assert.ok(pageInfo.textContent.includes("–"), "shows time range in paged mode");
});

test("exiting live mode while disconnected clears disconnected class", async () => {
  const { io, host, state } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r" });

  const toolbar = findByClass(host, "mkui-table-paging");
  const liveBtn = toolbar._ch[3];

  liveBtn._ev.click[0]();
  state.set("mkio.connected", false);
  assert.ok(liveBtn.classList.contains("disconnected"));

  liveBtn._ev.click[0]();
  assert.ok(!liveBtn.classList.contains("disconnected"), "cleared after exitLive");
  assert.ok(!liveBtn.classList.contains("active"));
});

test("after Go Live, hide/show cycles use normal sub/unsub", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r" });

  findByClass(host, "mkui-table-paging")._ch[3]._ev.click[0]();
  const subAfterLive = fakeClient.calls.length;

  triggerHidden(io);
  advanceTimers();
  const unsub = fakeClient.calls[subAfterLive];
  assert.equal(unsub.type, "unsubscribe");

  triggerVisible(io);
  assert.equal(lastSubscribe().type ?? lastSubscribe().opts ? "subscribe" : "", "subscribe");
});

/* ── Live by default (live: true) ─────────────────────────────────────── */

test("live: true fetches the start page before going live", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50, live: true });
  triggerVisible(io);

  const pageSub = lastSubscribe();
  assert.equal(typeof pageSub.opts.onPage, "function", "start page fetched first");
  assert.equal(pageSub.opts.ref, testMidnightRef(), "start=today still honored");
  assert.equal(pageSub.opts.maxcount, 50);
  assert.ok(!findByClass(host, "mkui-table-paging")._ch[3].classList.contains("active"),
    "not live until the start page arrives");
});

test("live: true switches to the live stream once the start page arrives", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50, live: true });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r1" });

  const toolbar = findByClass(host, "mkui-table-paging");
  const [prevBtn, pageInfo, nextBtn, liveBtn] = toolbar._ch;
  assert.ok(liveBtn.classList.contains("active"));
  assert.equal(pageInfo.textContent, "Live");
  assert.equal(nextBtn.disabled, true, "next always disabled in live mode");
  assert.equal(prevBtn.disabled, false, "earlier enabled from the midnight start ref");

  const sub = lastSubscribe();
  assert.equal(sub.opts.onPage, undefined, "live subscription, not a page fetch");
  assert.equal(sub.opts.maxcount, undefined);
  assert.equal(sub.opts.ref, streamRef(49), "resumes from the last row of the start page");
});

test("live: true tears down the page subscription before going live", async () => {
  const { io } = await createTable({ protocol: "stream", maxcount: 50, live: true });
  triggerVisible(io);

  const before = fakeClient.calls.length;
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r1" });
  assert.deepEqual(fakeClient.calls.slice(before).map(c => c.type), ["unsubscribe", "subscribe"],
    "no overlapping subscriptions across the handoff");
});

test("live: true keeps the start page rows and appends live rows", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50, live: true });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r1" });
  assert.equal(getTbody(host)._ch.length, 50, "start page rows survive the handoff");

  const sub = lastSubscribe();
  sub.opts.onSnapshot(makeStreamRows(5, 50));
  assert.equal(getTbody(host)._ch.length, 55, "50 page rows + 5 resumed");

  sub.opts.onUpdate("insert", { _mkio_ref: "ref-new-1", name: "live-1", value: 100 });
  assert.equal(getTbody(host)._ch.length, 56, "live row appended");
});

test("live: true anchors to the start ref when the start page is empty", async () => {
  const { io } = await createTable({ protocol: "stream", maxcount: 50, live: true });
  triggerVisible(io);
  lastSubscribe().opts.onPage([], { hasmore: false, ref: null });

  const sub = lastSubscribe();
  assert.equal(sub.opts.onPage, undefined, "goes live despite the empty start page");
  assert.equal(sub.opts.ref, testMidnightRef(),
    "anchored to midnight rather than replaying the whole buffer");
});

test("live: true with start='' and an empty page streams from the beginning", async () => {
  const { io } = await createTable({ protocol: "stream", maxcount: 50, live: true, start: "" });
  triggerVisible(io);
  lastSubscribe().opts.onPage([], { hasmore: false, ref: null });

  const sub = lastSubscribe();
  assert.equal(sub.opts.onPage, undefined, "goes live");
  assert.equal(sub.opts.ref, undefined, "no start anchor configured, so no ref");
});

test("exiting live from live: true returns to the start page", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50, live: true });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r1" });

  const toolbar = findByClass(host, "mkui-table-paging");
  toolbar._ch[3]._ev.click[0]();

  const sub = lastSubscribe();
  assert.equal(typeof sub.opts.onPage, "function", "back to a page fetch");
  assert.equal(sub.opts.ref, testMidnightRef(), "returns to the start page");
  assert.ok(!toolbar._ch[3].classList.contains("active"));
});

test("live: true does not re-arm after the user exits live", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50, live: true });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r1" });

  const toolbar = findByClass(host, "mkui-table-paging");
  toolbar._ch[3]._ev.click[0]();
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r2" });
  assert.ok(!toolbar._ch[3].classList.contains("active"), "stays paged after exiting");

  toolbar._ch[2]._ev.click[0]();
  lastSubscribe().opts.onPage(makeStreamRows(50, 50), { hasmore: false, ref: "r3" });
  assert.ok(!toolbar._ch[3].classList.contains("active"), "still paged after navigating");
});

test("mkui-pane-open re-arms live: true", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50, live: true });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r1" });

  const toolbar = findByClass(host, "mkui-table-paging");
  toolbar._ch[3]._ev.click[0]();
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r2" });

  const paneEl = host._paneEl;
  for (const fn of paneEl._ev["mkui-pane-close"] ?? []) fn();
  for (const fn of paneEl._ev["mkui-pane-open"] ?? []) fn();
  triggerVisible(io);

  const pageSub = lastSubscribe();
  assert.equal(typeof pageSub.opts.onPage, "function", "reopen fetches the start page first");
  assert.equal(pageSub.opts.ref, testMidnightRef());

  pageSub.opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r3" });
  assert.ok(toolbar._ch[3].classList.contains("active"), "live again after reopen");
});

test("Earlier after auto-live uses the separate paging subscription", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50, live: true });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50, 50), { hasmore: true, ref: "r1" });

  const before = fakeClient.calls.length;
  findByClass(host, "mkui-table-paging")._ch[0]._ev.click[0]();

  const [pageSub, ...rest] = fakeClient.calls.slice(before).filter(c => c.type === "subscribe");
  assert.equal(rest.length, 0, "one fetch; the live subscription is left alone");
  assert.ok(pageSub.opts.subid.endsWith("-page"), "earlier pages load on the paging subid");
  assert.equal(pageSub.opts.before, true);
  assert.equal(pageSub.opts.ref, streamRef(50), "fetches backward from the first live row");
});

test("live omitted keeps the table paged", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r1" });

  const toolbar = findByClass(host, "mkui-table-paging");
  assert.ok(!toolbar._ch[3].classList.contains("active"));
  assert.equal(typeof lastSubscribe().opts.onPage, "function", "still the page fetch");
});

test("live: false keeps the table paged", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50, live: false });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r1" });

  assert.ok(!findByClass(host, "mkui-table-paging")._ch[3].classList.contains("active"));
});

test("live: true on a non-paged stream subscribes live directly", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: null, live: true });
  triggerVisible(io);

  assert.equal(findByClass(host, "mkui-table-paging"), null, "no toolbar without paging");
  const sub = lastSubscribe();
  assert.equal(sub.opts.onPage, undefined, "plain live subscription");
  assert.equal(sub.opts.ref, undefined);
});

test("live: true is ignored for query protocol", async () => {
  const { io, host } = await createTable({ protocol: "query", live: true });
  triggerVisible(io);

  assert.equal(findByClass(host, "mkui-table-paging"), null);
  assert.equal(lastSubscribe().opts.ref, undefined);
});

/* ── Visibility behaviour ─────────────────────────────────────────────── */

test("paged stream: hide+show does not reload if page already loaded", async () => {
  const { io } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r" });

  const callsBefore = fakeClient.calls.length;
  triggerHidden(io);
  triggerVisible(io);
  assert.equal(fakeClient.calls.length, callsBefore);
});

test("query: hide triggers unsubscribe after timeout, show re-subscribes", async () => {
  const { io } = await createTable({ protocol: "query" });
  triggerVisible(io);
  const callsAfterSub = fakeClient.calls.length;

  triggerHidden(io);
  assert.equal(fakeClient.calls.length, callsAfterSub);
  advanceTimers();
  assert.equal(fakeClient.calls[callsAfterSub].type, "unsubscribe");

  triggerVisible(io);
  assert.equal(fakeClient.calls.at(-1).type, "subscribe");
});

test("query: brief hide+show does not trigger unsubscribe", async () => {
  const { io } = await createTable({ protocol: "query" });
  triggerVisible(io);
  const callsAfterSub = fakeClient.calls.length;

  triggerHidden(io);
  triggerVisible(io);
  assert.equal(fakeClient.calls.length, callsAfterSub);
});

test("pane hidden from the start does not subscribe until visible", async () => {
  const { io } = await createTable({ protocol: "query" });
  const callsAtStart = fakeClient.calls.length;
  triggerHidden(io);
  assert.equal(fakeClient.calls.length, callsAtStart);

  triggerVisible(io);
  assert.equal(fakeClient.calls[callsAtStart].type, "subscribe");
});

test("close event triggers immediate unsubscribe without waiting for timeout", async () => {
  const { io, host } = await createTable({ protocol: "query" });
  triggerVisible(io);
  const callsAfterSub = fakeClient.calls.length;

  triggerHidden(io);
  assert.equal(fakeClient.calls.length, callsAfterSub);

  const paneEl = host._paneEl;
  for (const fn of paneEl._ev["mkui-pane-close"] ?? []) fn();
  assert.equal(fakeClient.calls[callsAfterSub]?.type, "unsubscribe");
});

test("close cancels pending hide timer so unsub is not called twice", async () => {
  const { io, host } = await createTable({ protocol: "query" });
  triggerVisible(io);
  triggerHidden(io);

  const paneEl = host._paneEl;
  for (const fn of paneEl._ev["mkui-pane-close"] ?? []) fn();
  const callsAfterClose = fakeClient.calls.length;

  advanceTimers();
  assert.equal(fakeClient.calls.length, callsAfterClose);
});

test("paged stream: timeout unsubs and re-show reloads current page", async () => {
  const { io } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r1" });

  const callsBeforeHide = fakeClient.calls.length;
  triggerHidden(io);
  advanceTimers();
  assert.equal(fakeClient.calls[callsBeforeHide].type, "unsubscribe");

  triggerVisible(io);
  const resub = fakeClient.calls.at(-1);
  assert.equal(resub.type, "subscribe");
  assert.equal(resub.protocol, "stream");
});

test("paged stream: timeout during live mode unsubs and re-show resumes live", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r" });

  const toolbar = findByClass(host, "mkui-table-paging");
  const liveBtn = toolbar._ch[3];
  liveBtn._ev.click[0]();
  lastSubscribe().opts.onSnapshot(makeStreamRows(5, 50));

  triggerHidden(io);
  advanceTimers();
  const unsubCall = fakeClient.calls.filter(c => c.type === "unsubscribe");
  assert.ok(unsubCall.length > 0, "unsubscribed on timeout");

  triggerVisible(io);
  const resub = lastSubscribe();
  assert.equal(resub.opts.onPage, undefined, "re-subscribes as live (no onPage)");
  assert.ok(liveBtn.classList.contains("active"), "still in live mode after re-show");
});

test("paged stream: pageLoadRef/pageLoadBefore restore same page on re-show", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r1" });

  const toolbar = findByClass(host, "mkui-table-paging");
  toolbar._ch[2]._ev.click[0]();
  lastSubscribe().opts.onPage(makeStreamRows(50, 50), { hasmore: true, ref: "r2" });

  toolbar._ch[0]._ev.click[0]();
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r1b" });

  triggerHidden(io);
  advanceTimers();
  triggerVisible(io);

  const resub = lastSubscribe();
  assert.equal(resub.opts.ref, streamRef(50), "re-show uses pageLoadRef (ref passed to backward fetch)");
  assert.equal(resub.opts.before, true, "re-show preserves backward direction");
});

test("close event unsubs paged stream immediately", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r" });
  const callsBefore = fakeClient.calls.length;

  const paneEl = host._paneEl;
  for (const fn of paneEl._ev["mkui-pane-close"] ?? []) fn();
  assert.equal(fakeClient.calls[callsBefore].type, "unsubscribe");
});

test("close event during live mode unsubscribes both subids", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r" });

  const toolbar = findByClass(host, "mkui-table-paging");
  toolbar._ch[3]._ev.click[0]();

  const callsBefore = fakeClient.calls.length;
  const paneEl = host._paneEl;
  for (const fn of paneEl._ev["mkui-pane-close"] ?? []) fn();

  const unsubs = fakeClient.calls.slice(callsBefore).filter(c => c.type === "unsubscribe");
  assert.equal(unsubs.length, 2, "unsubscribes both main and page subids");
});

test("close event during pageFetchPending cleans up", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r1" });

  const toolbar = findByClass(host, "mkui-table-paging");
  toolbar._ch[2]._ev.click[0]();
  lastSubscribe().opts.onPage(makeStreamRows(50, 50), { hasmore: false, ref: "r2" });

  toolbar._ch[3]._ev.click[0]();
  toolbar._ch[0]._ev.click[0]();

  const paneEl = host._paneEl;
  for (const fn of paneEl._ev["mkui-pane-close"] ?? []) fn();

  const unsubs = fakeClient.calls.filter(c => c.type === "unsubscribe");
  assert.ok(unsubs.length >= 2, "unsubscribes despite pending fetch");
});

test("closed flag prevents re-subscription after close", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r" });

  const paneEl = host._paneEl;
  for (const fn of paneEl._ev["mkui-pane-close"] ?? []) fn();
  const callsAfterClose = fakeClient.calls.length;

  triggerVisible(io);
  assert.equal(fakeClient.calls.length, callsAfterClose,
    "no new subscribe after close");
});

/* ── Reopen after close ──────────────────────────────────────────────── */

test("mkui-pane-open resets closed state and allows re-subscription", async () => {
  const { io, host } = await createTable({ protocol: "query" });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot(makeRows(5));

  const paneEl = host._paneEl;
  for (const fn of paneEl._ev["mkui-pane-close"] ?? []) fn();
  const callsAfterClose = fakeClient.calls.length;

  triggerVisible(io);
  assert.equal(fakeClient.calls.length, callsAfterClose, "still blocked after close");

  for (const fn of paneEl._ev["mkui-pane-open"] ?? []) fn();
  triggerVisible(io);
  assert.equal(fakeClient.calls.at(-1).type, "subscribe");
});

test("mkui-pane-open clears stale rows", async () => {
  const { io, host } = await createTable({ protocol: "query" });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot(makeRows(10));
  flushRaf();
  assert.equal(getTbody(host)._ch.length, 10);

  const paneEl = host._paneEl;
  for (const fn of paneEl._ev["mkui-pane-close"] ?? []) fn();
  for (const fn of paneEl._ev["mkui-pane-open"] ?? []) fn();
  assert.equal(getTbody(host)._ch.length, 0);
});

test("mkui-pane-open resets pageFetchPending and live mode state", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r1" });

  const toolbar = findByClass(host, "mkui-table-paging");
  toolbar._ch[2]._ev.click[0]();
  lastSubscribe().opts.onPage(makeStreamRows(50, 50), { hasmore: false, ref: "r2" });

  toolbar._ch[3]._ev.click[0]();
  toolbar._ch[0]._ev.click[0]();

  const paneEl = host._paneEl;
  for (const fn of paneEl._ev["mkui-pane-close"] ?? []) fn();
  for (const fn of paneEl._ev["mkui-pane-open"] ?? []) fn();
  triggerVisible(io);

  const sub = lastSubscribe();
  assert.equal(sub.opts.ref, testMidnightRef(), "ref starts from midnight after reopen");
  assert.equal(sub.opts.maxcount, 50, "back in paged mode");
  assert.equal(typeof sub.opts.onPage, "function", "uses onPage (not live)");

  sub.opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r-new" });
  assert.ok(!toolbar._ch[3].classList.contains("active"), "live mode deactivated after page loads");
});

test("mkui-pane-open resets paged stream to midnight", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r1" });

  const toolbar = findByClass(host, "mkui-table-paging");
  toolbar._ch[2]._ev.click[0]();
  lastSubscribe().opts.onPage(makeStreamRows(50, 50), { hasmore: false, ref: "r2" });

  const paneEl = host._paneEl;
  for (const fn of paneEl._ev["mkui-pane-close"] ?? []) fn();
  for (const fn of paneEl._ev["mkui-pane-open"] ?? []) fn();
  triggerVisible(io);

  const sub = lastSubscribe();
  assert.equal(sub.opts.ref, testMidnightRef());
  assert.equal(sub.opts.maxcount, 50);
});

/* ── Stream ref-based resume ─────────────────────────────────────────── */

test("stream: re-subscribe after timeout passes lastRef from snapshot", async () => {
  const { io } = await createTable({ protocol: "stream", maxcount: null });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot([
    { _mkio_ref: "ref-A", name: "a" },
    { _mkio_ref: "ref-B", name: "b" },
  ]);

  triggerHidden(io);
  advanceTimers();
  triggerVisible(io);
  const resub = lastSubscribe();
  assert.equal(resub.opts.ref, "ref-B");
});

test("stream: re-subscribe after timeout preserves existing rows", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: null });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot([
    { _mkio_ref: "ref-A", name: "a" },
    { _mkio_ref: "ref-B", name: "b" },
  ]);
  assert.equal(getTbody(host)._ch.length, 2);

  triggerHidden(io);
  advanceTimers();
  triggerVisible(io);
  assert.equal(getTbody(host)._ch.length, 2, "existing rows preserved");
});

test("stream: lastRef updated by onUpdate", async () => {
  const { io } = await createTable({ protocol: "stream", maxcount: null });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot([
    { _mkio_ref: "ref-A", name: "a" },
  ]);
  lastSubscribe().opts.onUpdate("insert", { _mkio_ref: "ref-C", name: "c" });

  triggerHidden(io);
  advanceTimers();
  triggerVisible(io);
  assert.equal(lastSubscribe().opts.ref, "ref-C");
});

test("stream: lastRef updated by onDelta", async () => {
  const { io } = await createTable({ protocol: "stream", maxcount: null });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot([
    { _mkio_ref: "ref-A", name: "a" },
  ]);
  lastSubscribe().opts.onDelta([
    { op: "insert", row: { _mkio_ref: "ref-D", name: "d" } },
    { op: "insert", row: { _mkio_ref: "ref-E", name: "e" } },
  ]);

  triggerHidden(io);
  advanceTimers();
  triggerVisible(io);
  assert.equal(lastSubscribe().opts.ref, "ref-E");
});

test("stream: first subscribe has no ref", async () => {
  const { io } = await createTable({ protocol: "stream", maxcount: null });
  triggerVisible(io);
  const sub = lastSubscribe();
  assert.equal(sub.opts.ref, undefined);
});

test("stream: pane-open resets lastRef for fresh start", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: null });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot([
    { _mkio_ref: "ref-A", name: "a" },
  ]);

  const paneEl = host._paneEl;
  for (const fn of paneEl._ev["mkui-pane-close"] ?? []) fn();
  for (const fn of paneEl._ev["mkui-pane-open"] ?? []) fn();
  triggerVisible(io);
  const sub = lastSubscribe();
  assert.equal(sub.opts.ref, undefined, "ref not passed after pane reopen");
});

test("stream: goLive resumes from lastRef", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  const testRef = streamRef(42);
  lastSubscribe().opts.onPage(
    [{ _mkio_ref: testRef, name: "a" }],
    { hasmore: false, ref: testRef },
  );

  const toolbar = findByClass(host, "mkui-table-paging");
  const liveBtn = toolbar._ch[3];
  liveBtn._ev.click[0]();

  const sub = lastSubscribe();
  assert.equal(sub.opts.ref, testRef, "goLive resumes from page lastRef");
});

test("stream: exitLive re-fetches page and gets fresh refs", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r" });

  const toolbar = findByClass(host, "mkui-table-paging");
  const liveBtn = toolbar._ch[3];
  liveBtn._ev.click[0]();
  lastSubscribe().opts.onSnapshot([
    { _mkio_ref: "ref-live", name: "live" },
  ]);

  liveBtn._ev.click[0]();
  const pageSub = lastSubscribe();
  assert.equal(pageSub.type, "subscribe", "exitLive fetches page");
  pageSub.opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r" });
  assert.equal(getTbody(host)._ch.length, 50, "page rows from server");
});

test("stream: goLive from page 2 resumes from page 2 lastRef", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r1" });

  const toolbar = findByClass(host, "mkui-table-paging");
  toolbar._ch[2]._ev.click[0]();
  lastSubscribe().opts.onPage(makeStreamRows(50, 50), { hasmore: false, ref: "r2" });

  toolbar._ch[3]._ev.click[0]();
  const liveSub = lastSubscribe();
  assert.equal(liveSub.opts.ref, streamRef(99), "live resumes from page 2 lastRef");
});

test("stream: exitLive re-fetches page, prev uses fresh firstRef", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50, 10), { hasmore: true, ref: "r1" });

  const toolbar = findByClass(host, "mkui-table-paging");
  toolbar._ch[2]._ev.click[0]();
  lastSubscribe().opts.onPage(makeStreamRows(50, 60), { hasmore: false, ref: "r2" });

  toolbar._ch[3]._ev.click[0]();
  lastSubscribe().opts.onSnapshot(makeStreamRows(5, 200));

  toolbar._ch[3]._ev.click[0]();
  lastSubscribe().opts.onPage(makeStreamRows(50, 60), { hasmore: false, ref: "r2" });
  assert.equal(getTbody(host)._ch.length, 50, "re-fetched page 2");

  toolbar._ch[0]._ev.click[0]();
  assert.equal(lastSubscribe().opts.ref, streamRef(60), "prev uses firstRef from re-fetched page");
  assert.equal(lastSubscribe().opts.before, true);
});

test("stream: resume adds new rows from server to existing table", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: null });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot([
    { _mkio_ref: "ref-A", name: "a" },
    { _mkio_ref: "ref-B", name: "b" },
  ]);
  assert.equal(getTbody(host)._ch.length, 2);

  triggerHidden(io);
  advanceTimers();
  triggerVisible(io);

  lastSubscribe().opts.onSnapshot([
    { _mkio_ref: "ref-C", name: "c" },
  ]);
  assert.equal(getTbody(host)._ch.length, 3, "new row appended to existing");
});

test("stream: lastRef advances after resume snapshot", async () => {
  const { io } = await createTable({ protocol: "stream", maxcount: null });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot([
    { _mkio_ref: "ref-A", name: "a" },
  ]);

  triggerHidden(io);
  advanceTimers();
  triggerVisible(io);
  assert.equal(lastSubscribe().opts.ref, "ref-A");

  lastSubscribe().opts.onSnapshot([
    { _mkio_ref: "ref-B", name: "b" },
  ]);

  triggerHidden(io);
  advanceTimers();
  triggerVisible(io);
  assert.equal(lastSubscribe().opts.ref, "ref-B", "lastRef advanced to latest");
});

test("stream: empty snapshot does not change lastRef", async () => {
  const { io } = await createTable({ protocol: "stream", maxcount: null });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot([
    { _mkio_ref: "ref-A", name: "a" },
  ]);

  triggerHidden(io);
  advanceTimers();
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot([]);

  triggerHidden(io);
  advanceTimers();
  triggerVisible(io);
  assert.equal(lastSubscribe().opts.ref, "ref-A", "lastRef unchanged after empty snapshot");
});

test("stream: brief hide+show does not re-subscribe (preserves connection)", async () => {
  const { io } = await createTable({ protocol: "stream", maxcount: null });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot([
    { _mkio_ref: "ref-A", name: "a" },
  ]);
  const callsAfterSub = fakeClient.calls.length;

  triggerHidden(io);
  triggerVisible(io);
  assert.equal(fakeClient.calls.length, callsAfterSub, "no unsub or resub");
});

test("query: re-subscribe after timeout does not pass ref", async () => {
  const { io } = await createTable({ protocol: "query" });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot([
    { _mkio_ref: "ref-A", name: "a" },
  ]);

  triggerHidden(io);
  advanceTimers();
  triggerVisible(io);
  const sub = lastSubscribe();
  assert.equal(sub.opts.ref, undefined, "query never passes ref");
});

test("query: re-subscribe after timeout clears rows", async () => {
  const { io, host } = await createTable({ protocol: "query" });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot(makeRows(5));
  assert.equal(getTbody(host)._ch.length, 5);

  triggerHidden(io);
  advanceTimers();
  triggerVisible(io);
  assert.equal(getTbody(host)._ch.length, 0, "query clears rows on re-subscribe");
});

/* ── Snapshot clearing on reconnect ───────────────────────────────────── */

test("query: reconnect snapshot removes rows deleted on server", async () => {
  const { io, host } = await createTable({ protocol: "query" });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot([
    { _mkio_row: "1", name: "a" },
    { _mkio_row: "2", name: "b" },
    { _mkio_row: "3", name: "c" },
  ]);
  assert.equal(getTbody(host)._ch.length, 3);

  lastSubscribe().opts.onSnapshot([
    { _mkio_row: "1", name: "a" },
    { _mkio_row: "3", name: "c" },
  ]);
  assert.equal(getTbody(host)._ch.length, 2, "deleted row removed on reconnect snapshot");
});

test("query: second onSnapshot fully replaces first", async () => {
  const { io, host } = await createTable({ protocol: "query" });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot(makeRows(5));
  assert.equal(getTbody(host)._ch.length, 5);

  lastSubscribe().opts.onSnapshot(makeRows(3, 100));
  assert.equal(getTbody(host)._ch.length, 3, "old rows cleared, only new rows remain");
});

test("query: large reconnect snapshot clears before chunked render", async () => {
  const { io, host } = await createTable({ protocol: "query" });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot(makeRows(50));
  assert.equal(getTbody(host)._ch.length, 50);

  lastSubscribe().opts.onSnapshot(makeRows(250, 1000));
  const tbody = getTbody(host);
  assert.equal(tbody._ch.length, 100, "old rows cleared before first chunk renders");
  flushRaf();
  assert.equal(tbody._ch.length, 250, "all new rows rendered after flush");
});

test("subpub: snapshot clears stale rows on reconnect", async () => {
  const { io, host } = await createTable({ protocol: "subpub", topic: "t1" });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot([
    { _mkio_topic: "t1", name: "a", value: 1 },
    { _mkio_topic: "t2", name: "b", value: 2 },
  ]);
  assert.equal(getTbody(host)._ch.length, 2);

  lastSubscribe().opts.onSnapshot([
    { _mkio_topic: "t1", name: "a-updated", value: 10 },
  ]);
  assert.equal(getTbody(host)._ch.length, 1, "stale topic row removed on reconnect");
});

/* ── Empty / edge cases ───────────────────────────────────────────────── */

test("empty page renders no rows and updates toolbar", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage([], { hasmore: false, ref: null });
  assert.equal(getTbody(host)._ch.length, 0);
  const toolbar = findByClass(host, "mkui-table-paging");
  assert.equal(toolbar._ch[1].textContent, "No data");
  assert.equal(toolbar._ch[2].disabled, true);
});

test("Earlier on first page with no earlier data keeps page and disables Earlier", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r1" });
  assert.equal(getTbody(host)._ch.length, 50);

  const toolbar = findByClass(host, "mkui-table-paging");
  const prevBtn = toolbar._ch[0];
  assert.equal(prevBtn.disabled, false, "Earlier enabled on midnight start");

  prevBtn._ev.click[0]();
  lastSubscribe().opts.onPage([], { hasmore: false, ref: null });

  const refetch = lastSubscribe();
  refetch.opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r1b" });
  assert.equal(getTbody(host)._ch.length, 50, "page data restored");
  assert.equal(prevBtn.disabled, true, "Earlier disabled after empty backward");
});

test("empty page from midnight allows Earlier navigation", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage([], { hasmore: false, ref: null });

  const toolbar = findByClass(host, "mkui-table-paging");
  const prevBtn = toolbar._ch[0];
  assert.equal(prevBtn.disabled, false, "Earlier enabled because startRef was non-null");

  prevBtn._ev.click[0]();
  const sub = lastSubscribe();
  assert.equal(sub.opts.ref, testMidnightRef(), "prev uses startRef stored as firstRef");
  assert.equal(sub.opts.before, true, "fetches rows before midnight");
});

test("empty snapshot renders nothing", async () => {
  const { io, host } = await createTable({ protocol: "query" });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot([]);
  assert.equal(getTbody(host)._ch.length, 0);
});

test("single-row page shows single time, not a range", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(
    [{ _mkio_ref: streamRef(3661), name: "only-row", value: 1 }],
    { hasmore: false, ref: "r" },
  );
  const toolbar = findByClass(host, "mkui-table-paging");
  const text = toolbar._ch[1].textContent;
  assert.ok(!text.includes("–"), "single row shows single time, not a range");
  assert.ok(text.includes(":"), "shows a time value");
});

test("disconnect in live mode with hasEarlierPages shows time – Disconnected", async () => {
  const { io, host, state } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r1" });

  const toolbar = findByClass(host, "mkui-table-paging");
  const prevBtn = toolbar._ch[0];
  const pageInfo = toolbar._ch[1];
  const nextBtn = toolbar._ch[2];
  const liveBtn = toolbar._ch[3];

  nextBtn._ev.click[0]();
  lastSubscribe().opts.onPage(makeStreamRows(50, 50), { hasmore: false, ref: "r2" });

  liveBtn._ev.click[0]();
  const liveSub = lastSubscribe();

  prevBtn._ev.click[0]();
  const pageSub = lastSubscribeBySubid("-page");
  pageSub.opts.onPage(makeStreamRows(50), { hasmore: false, ref: "rp" });
  assert.ok(pageInfo.textContent.endsWith("– Live"), "shows time – Live after prev");

  state.set("mkio.connected", false);
  assert.ok(pageInfo.textContent.endsWith("– Disconnected"), "shows time – Disconnected");
  assert.ok(!pageInfo.textContent.startsWith("Disconnected"), "has time prefix");

  state.set("mkio.connected", true);
  assert.ok(pageInfo.textContent.endsWith("– Live"), "restored to time – Live on reconnect");
});

test("noPrev flag does not leak across multiple fetch cycles", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r1" });

  const toolbar = findByClass(host, "mkui-table-paging");
  const prevBtn = toolbar._ch[0];
  const nextBtn = toolbar._ch[2];

  prevBtn._ev.click[0]();
  lastSubscribe().opts.onPage([], { hasmore: false, ref: null });
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r1b" });
  assert.equal(prevBtn.disabled, true, "Earlier disabled after empty backward");

  nextBtn._ev.click[0]();
  lastSubscribe().opts.onPage(makeStreamRows(50, 50), { hasmore: true, ref: "r2" });
  assert.equal(prevBtn.disabled, false, "Earlier re-enabled on forward navigation (noPrev cleared)");

  prevBtn._ev.click[0]();
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r1c" });
  assert.equal(prevBtn.disabled, false, "Earlier stays enabled on successful backward fetch");
});

test("multi-row same-day page shows HH:mm – HH:mm range", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r1" });
  const toolbar = findByClass(host, "mkui-table-paging");
  const text = toolbar._ch[1].textContent;
  assert.ok(text.includes("–"), "shows a time range with dash separator");
  const parts = text.split("–").map(s => s.trim());
  assert.equal(parts.length, 2, "two parts around the dash");
  assert.ok(parts[0].includes(":"), "first part has time");
  assert.ok(parts[1].includes(":"), "second part has time");
});

/* ── Adaptive time precision ─────────────────────────────────────────── */

function streamRefSub(h, m, s, sub) {
  const hh = String(h).padStart(2, "0");
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return `20260527 ${hh}:${mm}:${ss}.${sub}`;
}

test("different minutes shows HH:mm precision only", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage([
    { _mkio_ref: streamRefSub(9, 15, 0, "000000000000"), name: "a", value: 1 },
    { _mkio_ref: streamRefSub(9, 30, 0, "000000000000"), name: "b", value: 2 },
  ], { hasmore: true, ref: "r" });
  const text = findByClass(host, "mkui-table-paging")._ch[1].textContent;
  const parts = text.split("–").map(s => s.trim());
  assert.ok(!parts[0].includes("."), "no sub-seconds");
  assert.equal(parts[0].split(":").length, 2, "HH:mm only");
  assert.equal(parts[1].split(":").length, 2, "HH:mm only");
});

test("same minute different seconds shows HH:mm:ss", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage([
    { _mkio_ref: streamRefSub(9, 15, 3, "000000000000"), name: "a", value: 1 },
    { _mkio_ref: streamRefSub(9, 15, 47, "000000000000"), name: "b", value: 2 },
  ], { hasmore: true, ref: "r" });
  const text = findByClass(host, "mkui-table-paging")._ch[1].textContent;
  const parts = text.split("–").map(s => s.trim());
  assert.ok(!parts[0].includes("."), "no sub-seconds");
  assert.equal(parts[0].split(":").length, 3, "HH:mm:ss");
  assert.equal(parts[1].split(":").length, 3, "HH:mm:ss");
});

test("same second different milliseconds shows HH:mm:ss.NNN", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage([
    { _mkio_ref: streamRefSub(9, 15, 3, "123000000000"), name: "a", value: 1 },
    { _mkio_ref: streamRefSub(9, 15, 3, "456000000000"), name: "b", value: 2 },
  ], { hasmore: true, ref: "r" });
  const text = findByClass(host, "mkui-table-paging")._ch[1].textContent;
  const parts = text.split("–").map(s => s.trim());
  assert.ok(parts[0].includes("."), "has sub-seconds");
  const sub0 = parts[0].split(".")[1];
  const sub1 = parts[1].split(".")[1];
  assert.equal(sub0.length, 3, "3 sub-second digits (ms)");
  assert.equal(sub1.length, 3, "3 sub-second digits (ms)");
  assert.equal(sub0, "123");
  assert.equal(sub1, "456");
});

test("same millisecond different microseconds shows HH:mm:ss.NNNNNN", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage([
    { _mkio_ref: streamRefSub(9, 15, 3, "123456000000"), name: "a", value: 1 },
    { _mkio_ref: streamRefSub(9, 15, 3, "123789000000"), name: "b", value: 2 },
  ], { hasmore: true, ref: "r" });
  const text = findByClass(host, "mkui-table-paging")._ch[1].textContent;
  const parts = text.split("–").map(s => s.trim());
  const sub0 = parts[0].split(".")[1];
  const sub1 = parts[1].split(".")[1];
  assert.equal(sub0.length, 6, "6 sub-second digits (us)");
  assert.equal(sub1.length, 6, "6 sub-second digits (us)");
  assert.equal(sub0, "123456");
  assert.equal(sub1, "123789");
});

test("same microsecond different nanoseconds shows HH:mm:ss.NNNNNNNNN", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage([
    { _mkio_ref: streamRefSub(9, 15, 3, "123456001000"), name: "a", value: 1 },
    { _mkio_ref: streamRefSub(9, 15, 3, "123456009000"), name: "b", value: 2 },
  ], { hasmore: true, ref: "r" });
  const text = findByClass(host, "mkui-table-paging")._ch[1].textContent;
  const parts = text.split("–").map(s => s.trim());
  const sub0 = parts[0].split(".")[1];
  const sub1 = parts[1].split(".")[1];
  assert.equal(sub0.length, 9, "9 sub-second digits (ns)");
  assert.equal(sub1.length, 9, "9 sub-second digits (ns)");
  assert.equal(sub0, "123456001");
  assert.equal(sub1, "123456009");
});

test("identical refs shows single time (no range)", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  const ref = streamRefSub(9, 15, 3, "123456789000");
  lastSubscribe().opts.onPage([
    { _mkio_ref: ref, name: "a", value: 1 },
    { _mkio_ref: ref, name: "b", value: 2 },
  ], { hasmore: true, ref: "r" });
  const text = findByClass(host, "mkui-table-paging")._ch[1].textContent;
  assert.ok(!text.includes("–"), "identical refs produce single time, not range");
});

test("nearly identical refs at nanosecond level shows max precision", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage([
    { _mkio_ref: streamRefSub(9, 15, 3, "123456789000"), name: "a", value: 1 },
    { _mkio_ref: streamRefSub(9, 15, 3, "123456790000"), name: "b", value: 2 },
  ], { hasmore: true, ref: "r" });
  const text = findByClass(host, "mkui-table-paging")._ch[1].textContent;
  const parts = text.split("–").map(s => s.trim());
  const sub0 = parts[0].split(".")[1];
  const sub1 = parts[1].split(".")[1];
  assert.equal(sub0.length, 9, "9 sub-second digits (ns) for close refs");
  assert.equal(sub0, "123456789");
  assert.equal(sub1, "123456790");
});

/* ── Boundary indicators ─────────────────────────────────────────────── */

test("last page shows (end) indicator", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: false, ref: "r" });
  const text = findByClass(host, "mkui-table-paging")._ch[1].textContent;
  assert.ok(text.endsWith("(end)"), `expected (end) suffix, got: ${text}`);
});

test("first page shows (start) indicator when Earlier disabled", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r" });
  const toolbar = findByClass(host, "mkui-table-paging");
  const prevBtn = toolbar._ch[0];
  prevBtn._ev.click[0]();
  lastSubscribe().opts.onPage([], { hasmore: false, ref: null });
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r1b" });
  const text = toolbar._ch[1].textContent;
  assert.ok(text.endsWith("(start)"), `expected (start) suffix, got: ${text}`);
  assert.ok(!text.includes("(end)"), "should not include (end)");
});

test("single page dataset shows (all) indicator", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50, start: "" });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(10), { hasmore: false, ref: "r" });
  const toolbar = findByClass(host, "mkui-table-paging");
  assert.equal(toolbar._ch[0].disabled, true, "Earlier disabled");
  assert.equal(toolbar._ch[2].disabled, true, "Later disabled");
  const text = toolbar._ch[1].textContent;
  assert.ok(text.endsWith("(all)"), `expected (all) suffix, got: ${text}`);
});

test("middle page shows no boundary indicator", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r" });
  const toolbar = findByClass(host, "mkui-table-paging");
  const nextBtn = toolbar._ch[2];
  nextBtn._ev.click[0]();
  lastSubscribe().opts.onPage(makeStreamRows(50, 50), { hasmore: true, ref: "r2" });
  const text = toolbar._ch[1].textContent;
  assert.ok(!text.includes("(start)"), "no start indicator");
  assert.ok(!text.includes("(end)"), "no end indicator");
  assert.ok(!text.includes("(all)"), "no all indicator");
});

test("boundary indicators not shown in live mode", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: false, ref: "r" });
  const toolbar = findByClass(host, "mkui-table-paging");
  const liveBtn = toolbar._ch[3];
  liveBtn._ev.click[0]();
  const text = toolbar._ch[1].textContent;
  assert.ok(!text.includes("(end)"), "no boundary indicator in live mode");
  assert.ok(!text.includes("(start)"), "no boundary indicator in live mode");
});

/* ── Refresh button ──────────────────────────────────────────────────── */

test("refresh button re-fetches current page", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r" });
  const toolbar = findByClass(host, "mkui-table-paging");
  const refreshBtn = toolbar._ch[4];
  assert.ok(refreshBtn._ch[0].className.includes("mkui-icon-refresh"));
  assert.equal(refreshBtn.disabled, false, "enabled in paged mode");
  const subsBefore = fakeClient.calls.filter(c => c.type === "subscribe").length;
  refreshBtn._ev.click[0]();
  const subsAfter = fakeClient.calls.filter(c => c.type === "subscribe").length;
  assert.ok(subsAfter > subsBefore, "refresh triggered a new subscribe");
});

test("refresh button disabled in live mode", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r" });
  const toolbar = findByClass(host, "mkui-table-paging");
  const refreshBtn = toolbar._ch[4];
  const liveBtn = toolbar._ch[3];
  assert.equal(refreshBtn.disabled, false, "enabled before live");
  liveBtn._ev.click[0]();
  assert.equal(refreshBtn.disabled, true, "disabled in live mode");
});

test("refresh button re-enabled after exiting live mode", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r" });
  const toolbar = findByClass(host, "mkui-table-paging");
  const refreshBtn = toolbar._ch[4];
  const liveBtn = toolbar._ch[3];
  liveBtn._ev.click[0]();
  assert.equal(refreshBtn.disabled, true, "disabled in live mode");
  liveBtn._ev.click[0]();
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r2" });
  assert.equal(refreshBtn.disabled, false, "re-enabled after exit live");
});

/* ── Live tail following ─────────────────────────────────────────────── */
// A live stream reads like a terminal: while the viewport is parked at the
// tail (within 8px of the bottom), new rows scroll into view; a viewport
// scrolled up to inspect history is never yanked. The scroll geometry is
// mocked directly on the scroll host.

function parkAtTail(el, { scrollHeight = 500, clientHeight = 100 } = {}) {
  el.scrollHeight = scrollHeight;
  el._clientHeight = clientHeight;
  el.scrollTop = scrollHeight - clientHeight;
}

test("live stream at the tail follows an inserted row", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: null });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot(makeStreamRows(20));
  flushRaf();
  parkAtTail(sh(host));
  lastSubscribe().opts.onUpdate("insert", makeStreamRows(1, 20)[0]);
  sh(host).scrollHeight = 520; // the new row grew the scroll extent
  flushRaf();
  assert.equal(sh(host).scrollTop, 520, "viewport jumped to the new tail");
});

test("live stream scrolled up is not yanked by an insert", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: null });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot(makeStreamRows(20));
  flushRaf();
  parkAtTail(sh(host));
  sh(host).scrollTop = 100; // user scrolled up to inspect history
  lastSubscribe().opts.onUpdate("insert", makeStreamRows(1, 20)[0]);
  sh(host).scrollHeight = 520;
  flushRaf();
  assert.equal(sh(host).scrollTop, 100, "viewport left where the user put it");
});

test("within the 8px slack of the bottom still counts as the tail", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: null });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot(makeStreamRows(20));
  flushRaf();
  sh(host).scrollHeight = 500;
  sh(host)._clientHeight = 100;
  sh(host).scrollTop = 392; // 392 + 100 == 500 - 8, the slack boundary
  lastSubscribe().opts.onUpdate("insert", makeStreamRows(1, 20)[0]);
  flushRaf();
  assert.equal(sh(host).scrollTop, 500, "8px from the bottom still follows");
});

test("live stream at the tail follows a delta batch", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: null });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot(makeStreamRows(20));
  flushRaf();
  parkAtTail(sh(host));
  lastSubscribe().opts.onDelta(makeStreamRows(5, 20).map((row) => ({ op: "insert", row })));
  sh(host).scrollHeight = 600;
  flushRaf();
  assert.equal(sh(host).scrollTop, 600, "delta batch scrolled the tail into view");
});

test("resumed snapshot keeps a tail-parked viewport at the tail", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: null });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot(makeStreamRows(20));
  flushRaf();
  parkAtTail(sh(host));
  lastSubscribe().opts.onSnapshot(makeStreamRows(10, 20));
  sh(host).scrollHeight = 700;
  flushRaf();
  assert.equal(sh(host).scrollTop, 700, "snapshot rows scrolled into view");
});

test("query updates never tail-follow", async () => {
  const { io, host } = await createTable({ protocol: "query" });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot(makeRows(20));
  flushRaf();
  parkAtTail(sh(host));
  const before = sh(host).scrollTop;
  lastSubscribe().opts.onUpdate("insert", makeRows(1, 100)[0]);
  sh(host).scrollHeight = 520;
  flushRaf();
  assert.equal(sh(host).scrollTop, before, "query viewport never moves on updates");
});

test("Go Live jumps to the tail even from the top of the page", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r" });
  const scrollArea = findByClass(host, "mkui-table-scroll");
  scrollArea.scrollHeight = 900;
  scrollArea._clientHeight = 300;
  scrollArea.scrollTop = 0;
  const toolbar = findByClass(host, "mkui-table-paging");
  toolbar._ch[3]._ev.click[0](); // Go Live
  flushRaf();
  assert.equal(scrollArea.scrollTop, 900, "entering live forces one jump to the tail");
});

test("rows arriving after Go Live keep following the tail", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r" });
  const scrollArea = findByClass(host, "mkui-table-scroll");
  scrollArea.scrollHeight = 900;
  scrollArea._clientHeight = 300;
  const toolbar = findByClass(host, "mkui-table-paging");
  toolbar._ch[3]._ev.click[0](); // Go Live
  flushRaf(); // now parked at the tail (scrollTop 900)
  lastSubscribe().opts.onSnapshot(makeStreamRows(10, 50)); // resumed snapshot
  scrollArea.scrollHeight = 1100;
  flushRaf();
  assert.equal(scrollArea.scrollTop, 1100, "resumed snapshot followed");
  lastSubscribe().opts.onUpdate("insert", makeStreamRows(1, 60)[0]);
  scrollArea.scrollHeight = 1120;
  flushRaf();
  assert.equal(scrollArea.scrollTop, 1120, "live update followed");
});

/* ── Column widths & resize ──────────────────────────────────────────── */

function getColgroup(host) {
  return getTable(host)?._ch.find(c => c.tagName === "COLGROUP") ?? null;
}

function getThs(host) {
  return (getThead(host)?._ch[0]?._ch ?? []).filter(th => th.dataset?.col);
}

// Grips straddle dividers: column N's grip is on the left edge of cell
// N+1 (the filler carries the last column's grip). getGrips(host)[i]
// resizes column i.
function getGrips(host) {
  const tr = getThead(host)?._ch[0];
  if (!tr) return [];
  return tr._ch.flatMap(th =>
    th._ch.filter(c => String(c.className).includes("mkui-col-resizer")));
}

test("each column divider carries a resize grip on its following cell", async () => {
  const { host } = await createTable({ columns: ["a", "b"] });
  const ths = getThead(host)._ch[0]._ch;
  assert.ok(!ths[0]._ch.some(c => c.className === "mkui-col-resizer"),
    "first cell has no grip — there is no divider on its left");
  assert.ok(ths[1]._ch.some(c => c.className === "mkui-col-resizer"),
    "second cell carries the grip for column a");
  assert.ok(ths[2]._ch.some(c => c.className === "mkui-col-resizer"),
    "filler carries the grip for the last column");
  assert.equal(getGrips(host).length, 2, "one grip per data column");
});

test("initial snapshot locks column widths into the colgroup", async () => {
  const { host, io } = await createTable({ protocol: "query" });
  triggerVisible(io);
  const table = getTable(host);
  assert.ok(!table.classList.contains("mkui-table-fixed"), "auto layout before data");

  lastSubscribe().opts.onSnapshot(makeRows(5));
  assert.ok(table.classList.contains("mkui-table-fixed"), "fixed layout after snapshot");
  const cols = getColgroup(host)._ch;
  assert.equal(cols.length, 3, "one col per visible column plus the filler");
  assert.equal(cols[0].style.width, "100px", "width from measured header");
  assert.equal(cols[1].style.width, "100px");
  assert.equal(cols[2].style.width, "", "filler col is auto-width");
  assert.equal(table.style.width, "", "no inline width — width:100% lets the filler absorb pane growth");
});

test("default column width is capped at 50% of the pane width", async () => {
  const { host, io } = await createTable({ protocol: "query" });
  sh(host)._clientWidth = 150;
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot(makeRows(5));
  const cols = getColgroup(host)._ch;
  assert.equal(cols[0].style.width, "75px", "measured 100px clamped to half of 150px pane");
  assert.equal(cols[1].style.width, "75px");
});

test("dragging a resize grip changes that column's width", async () => {
  const { host, io } = await createTable({ protocol: "query" });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot(makeRows(5));

  const resizer = getGrips(host)[0]; // grip for column 0, on the second cell
  resizer._ev.pointerdown[0]({
    button: 0, pointerId: 7, clientX: 100,
    stopPropagation() {}, preventDefault() {},
  });
  document._ev.pointermove.at(-1)({ pointerId: 7, clientX: 140 });
  const cols = getColgroup(host)._ch;
  assert.equal(cols[0].style.width, "140px", "dragged column widened by 40px");
  assert.equal(cols[1].style.width, "100px", "other column unchanged");
  document._ev.pointerup.at(-1)({ pointerId: 7 });
});

test("resize enforces a minimum column width", async () => {
  const { host, io } = await createTable({ protocol: "query" });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot(makeRows(5));

  const resizer = getGrips(host)[0];
  resizer._ev.pointerdown[0]({
    button: 0, pointerId: 8, clientX: 100,
    stopPropagation() {}, preventDefault() {},
  });
  document._ev.pointermove.at(-1)({ pointerId: 8, clientX: -500 });
  assert.equal(getColgroup(host)._ch[0].style.width, "40px", "clamped to minimum");
  document._ev.pointerup.at(-1)({ pointerId: 8 });
});

test("column widths persist across re-subscribe", async () => {
  const { host, io } = await createTable({ protocol: "query" });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot(makeRows(5));

  const resizer = getGrips(host)[0];
  resizer._ev.pointerdown[0]({
    button: 0, pointerId: 9, clientX: 100,
    stopPropagation() {}, preventDefault() {},
  });
  document._ev.pointermove.at(-1)({ pointerId: 9, clientX: 160 });
  document._ev.pointerup.at(-1)({ pointerId: 9 });
  assert.equal(getColgroup(host)._ch[0].style.width, "160px");

  triggerHidden(io);
  advanceTimers();
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot(makeRows(5));
  assert.equal(getColgroup(host)._ch[0].style.width, "160px", "width kept after resubscribe");
});

test("pane reopen resets column widths for re-measurement", async () => {
  const { host, io } = await createTable({ protocol: "query" });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot(makeRows(5));
  assert.ok(getTable(host).classList.contains("mkui-table-fixed"));

  const paneEl = host._paneEl;
  for (const fn of paneEl._ev["mkui-pane-close"] ?? []) fn();
  for (const fn of paneEl._ev["mkui-pane-open"] ?? []) fn();
  assert.ok(!getTable(host).classList.contains("mkui-table-fixed"), "back to auto layout");
  assert.equal(getColgroup(host)._ch.length, 0, "colgroup cleared");

  triggerVisible(io);
  lastSubscribe().opts.onSnapshot(makeRows(5));
  assert.ok(getTable(host).classList.contains("mkui-table-fixed"), "re-measured on new data");
  assert.equal(getColgroup(host)._ch.length, 3);
});

test("pre-configured columns lock at header width before any data", async () => {
  const { host } = await createTable({ protocol: "query", columns: ["name", "value"] });
  const table = getTable(host);
  assert.ok(table.classList.contains("mkui-table-fixed"), "fixed layout from the header alone");
  const cols = getColgroup(host)._ch;
  assert.equal(cols[0].style.width, "100px", "header-measured width, no data yet");
  assert.equal(cols[1].style.width, "100px");
});

test("columns grow to fit wider records as they arrive", async () => {
  const { host, io } = await createTable({ protocol: "query" });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot(makeRows(3));
  assert.equal(getColgroup(host)._ch[0].style.width, "100px", "header width fits short values");
  lastSubscribe().opts.onUpdate("insert", { _mkio_row: "x", name: "x".repeat(30), value: 5 });
  assert.equal(getColgroup(host)._ch[0].style.width, (30 * 6 + 17) + "px",
    "grew to fit the widest value");
  lastSubscribe().opts.onUpdate("insert", { _mkio_row: "y", name: "short", value: 6 });
  assert.equal(getColgroup(host)._ch[0].style.width, (30 * 6 + 17) + "px",
    "narrower values never shrink a column");
});

test("auto-grow is capped at half the pane width", async () => {
  const { host, io } = await createTable({ protocol: "query" });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot(makeRows(3));
  lastSubscribe().opts.onUpdate("insert", { _mkio_row: "x", name: "y".repeat(100), value: 5 });
  assert.equal(getColgroup(host)._ch[0].style.width, "200px", "clamped to half of 400px pane");
});

test("numeric columns grow to max-integer plus max-fraction width", async () => {
  const { host, io } = await createTable({ protocol: "query" });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot([
    { _mkio_row: "1", name: "a", value: "123456789012345678" }, // 18-char integer part
    { _mkio_row: "2", name: "b", value: "1.2345" },             // 5-char ".fraction"
  ]);
  // Decimal alignment needs max integer part + max fraction: 18ch + 5ch.
  assert.equal(getColgroup(host)._ch[1].style.width, (23 * 6 + 17) + "px");
});

test("a manually resized column stops auto-growing", async () => {
  const { host, io } = await createTable({ protocol: "query" });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot(makeRows(3));
  const resizer = getGrips(host)[0];
  resizer._ev.pointerdown[0]({
    button: 0, pointerId: 11, clientX: 100,
    stopPropagation() {}, preventDefault() {},
  });
  document._ev.pointermove.at(-1)({ pointerId: 11, clientX: 120 });
  document._ev.pointerup.at(-1)({ pointerId: 11 });
  assert.equal(getColgroup(host)._ch[0].style.width, "120px");
  lastSubscribe().opts.onUpdate("insert", { _mkio_row: "x", name: "z".repeat(30), value: 5 });
  assert.equal(getColgroup(host)._ch[0].style.width, "120px", "manual width wins over auto-grow");
});

test("columns grow between chunks of a large snapshot", async () => {
  const { host, io } = await createTable({ protocol: "query" });
  triggerVisible(io);
  // 150 rows ingest in 100-row chunks; the wide value sits in the 2nd chunk.
  const snap = makeRows(150);
  snap[120].name = "w".repeat(30);
  lastSubscribe().opts.onSnapshot(snap);
  assert.equal(getColgroup(host)._ch[0].style.width, "100px",
    "first chunk fits within the header width");
  flushRaf();
  assert.equal(getColgroup(host)._ch[0].style.width, (30 * 6 + 17) + "px",
    "second chunk grew the column mid-snapshot");
});

test("a numeric column that flips to text grows to its widest string", async () => {
  const { host, io } = await createTable({ protocol: "query" });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot(makeRows(3)); // value column is numeric
  assert.equal(getColgroup(host)._ch[1].style.width, "100px");
  lastSubscribe().opts.onUpdate("insert",
    { _mkio_row: "x", name: "a", value: "not a number but a long string" }); // 30 chars
  assert.equal(getColgroup(host)._ch[1].style.width, (30 * 6 + 17) + "px",
    "text width drives the column after the numeric flip");
});

// Paging: the first page (or live data) sizes the columns; later page
// loads leave them alone, so navigating doesn't make the layout jump.
function wideStreamRows(n, startId) {
  const rows = makeStreamRows(n, startId);
  rows[0].name = "w".repeat(30);
  return rows;
}

test("the first page of a paged stream sizes the columns", async () => {
  const { host, io } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(wideStreamRows(50, 0), { hasmore: true, ref: "r1" });
  assert.equal(getColgroup(host)._ch[0].style.width, (30 * 6 + 17) + "px",
    "first page grows the column to its widest value");
});

test("navigating to another page does not resize columns", async () => {
  const { host, io } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r1" });
  assert.equal(getColgroup(host)._ch[0].style.width, "100px", "first page fits the header width");

  const toolbar = findByClass(host, "mkui-table-paging");
  const [prevBtn, , nextBtn, , refreshBtn] = toolbar._ch;
  nextBtn._ev.click[0]();
  lastSubscribe().opts.onPage(wideStreamRows(50, 50), { hasmore: true, ref: "r2" });
  flushRaf();
  assert.equal(getColgroup(host)._ch[0].style.width, "100px", "next page leaves the width alone");

  prevBtn._ev.click[0]();
  lastSubscribe().opts.onPage(wideStreamRows(50, 0), { hasmore: true, ref: "r1b" });
  flushRaf();
  assert.equal(getColgroup(host)._ch[0].style.width, "100px", "prev page leaves the width alone");

  refreshBtn._ev.click[0]();
  lastSubscribe().opts.onPage(wideStreamRows(50, 0), { hasmore: true, ref: "r1c" });
  flushRaf();
  assert.equal(getColgroup(host)._ch[0].style.width, "100px", "refresh leaves the width alone");
});

test("Earlier in live mode and exit-live refetch do not resize columns", async () => {
  const { host, io } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50, 50), { hasmore: true, ref: "r2" });
  assert.equal(getColgroup(host)._ch[0].style.width, "100px");

  const toolbar = findByClass(host, "mkui-table-paging");
  const [prevBtn, , , liveBtn] = toolbar._ch;
  liveBtn._ev.click[0]();
  lastSubscribe().opts.onSnapshot(makeStreamRows(5, 100));
  flushRaf();

  prevBtn._ev.click[0]();
  lastSubscribeBySubid("-page").opts.onPage(wideStreamRows(50, 0), { hasmore: false, ref: "r1" });
  flushRaf();
  assert.equal(getColgroup(host)._ch[0].style.width, "100px", "earlier page leaves the width alone");

  liveBtn._ev.click[0]();
  lastSubscribe().opts.onPage(wideStreamRows(50, 50), { hasmore: true, ref: "r2b" });
  flushRaf();
  assert.equal(getColgroup(host)._ch[0].style.width, "100px", "exit-live refetch leaves the width alone");
});

test("live rows still grow columns after paging", async () => {
  const { host, io } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r1" });
  const toolbar = findByClass(host, "mkui-table-paging");
  const [, , nextBtn, liveBtn] = toolbar._ch;
  nextBtn._ev.click[0]();
  lastSubscribe().opts.onPage(makeStreamRows(50, 50), { hasmore: false, ref: "r2" });
  liveBtn._ev.click[0]();
  lastSubscribe().opts.onUpdate("insert",
    { _mkio_ref: streamRef(100), name: "w".repeat(30), value: 100 });
  flushRaf();
  assert.equal(getColgroup(host)._ch[0].style.width, (30 * 6 + 17) + "px",
    "a live row widens the column as before");
});

test("pane reopen re-arms first-page sizing", async () => {
  const { host, io } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r1" });
  const paneEl = host._paneEl;
  for (const fn of paneEl._ev["mkui-pane-close"] ?? []) fn();
  for (const fn of paneEl._ev["mkui-pane-open"] ?? []) fn();
  triggerVisible(io);
  lastSubscribe().opts.onPage(wideStreamRows(50, 0), { hasmore: true, ref: "r1b" });
  assert.equal(getColgroup(host)._ch[0].style.width, (30 * 6 + 17) + "px",
    "the reopened pane's first page sizes the columns again");
});

// Double-click auto-size arithmetic (canvas mock measures 6px/char):
// content fit = chars*6 + 17 cell chrome; header fit = chars*6 + 33 chrome.
function dblclickGrip(host, i) {
  getGrips(host)[i]._ev.dblclick[0]({ stopPropagation() {}, preventDefault() {} });
}

test("double-clicking a divider grip auto-sizes the column to its content", async () => {
  const { host, io } = await createTable({ protocol: "query" });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot(makeRows(3));
  lastSubscribe().opts.onUpdate("insert", { _mkio_row: "x", name: "x".repeat(40), value: 5 });
  assert.equal(getColgroup(host)._ch[0].style.width, "200px", "auto-grow capped at half pane");
  dblclickGrip(host, 0);
  assert.equal(getColgroup(host)._ch[0].style.width, (40 * 6 + 17) + "px",
    "fit to the widest value, past the half-pane cap");
});

test("auto-size shrinks a column and falls back to the header width", async () => {
  const { host, io } = await createTable({ protocol: "query" });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot(makeRows(3)); // header-measured 100px
  dblclickGrip(host, 0);
  // "row-N" values (5 chars → 47px) are narrower than the "name" header fit.
  assert.equal(getColgroup(host)._ch[0].style.width, (4 * 6 + 33) + "px",
    "shrunk to the header label + icon");
});

test("auto-size is capped at 80% of the viewport width", async () => {
  const { host, io } = await createTable({ protocol: "query" });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot(makeRows(3));
  lastSubscribe().opts.onUpdate("insert", { _mkio_row: "x", name: "y".repeat(200), value: 5 });
  globalThis.innerWidth = 500;
  try {
    dblclickGrip(host, 0);
    assert.equal(getColgroup(host)._ch[0].style.width, "400px", "80% of the 500px viewport");
  } finally {
    delete globalThis.innerWidth;
  }
});

test("auto-size re-enables auto-grow after a manual resize", async () => {
  const { host, io } = await createTable({ protocol: "query" });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot(makeRows(3));
  const resizer = getGrips(host)[0];
  resizer._ev.pointerdown[0]({
    button: 0, pointerId: 13, clientX: 100,
    stopPropagation() {}, preventDefault() {},
  });
  document._ev.pointermove.at(-1)({ pointerId: 13, clientX: 300 });
  document._ev.pointerup.at(-1)({ pointerId: 13 });
  dblclickGrip(host, 0);
  lastSubscribe().opts.onUpdate("insert", { _mkio_row: "x", name: "z".repeat(30), value: 5 });
  assert.equal(getColgroup(host)._ch[0].style.width, (30 * 6 + 17) + "px",
    "manual-resize opt-out cleared by auto-size");
});

test("with all rows selected, one double-click auto-sizes every column", async () => {
  const { host, io } = await createTable({ protocol: "query" });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot(makeRows(3));
  assert.equal(getColgroup(host)._ch[0].style.width, "100px");
  assert.equal(getColgroup(host)._ch[1].style.width, "100px");
  host._paneEl._editActions.selectAll(); // Ctrl+A path (selectAllRows)
  dblclickGrip(host, 0);
  assert.equal(getColgroup(host)._ch[0].style.width, (4 * 6 + 33) + "px",
    "clicked column fitted");
  assert.equal(getColgroup(host)._ch[1].style.width, (5 * 6 + 33) + "px",
    "other selected column fitted too");
});

test("cell-mode selection scopes auto-size to the selected columns", async () => {
  const { host, io } = await createTable({ protocol: "query" });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot(makeRows(3));
  const trs = getTbody(host)._ch;
  pointerDown(trs[0], 0);                      // focus "name" cell
  pointerDown(trs[1], 0, { shiftKey: true });  // rect spanning column 0 only
  dblclickGrip(host, 0);
  assert.equal(getColgroup(host)._ch[0].style.width, (4 * 6 + 33) + "px",
    "selected column fitted");
  assert.equal(getColgroup(host)._ch[1].style.width, "100px",
    "unselected column untouched");
  dblclickGrip(host, 1); // divider of a column outside the selection
  assert.equal(getColgroup(host)._ch[1].style.width, (5 * 6 + 33) + "px",
    "fits only itself when outside the selection");
  assert.equal(getColgroup(host)._ch[0].style.width, (4 * 6 + 33) + "px");
});

test("pane reopen re-enables auto-grow after a manual resize", async () => {
  const { host, io } = await createTable({ protocol: "query" });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot(makeRows(3));
  const resizer = getGrips(host)[0];
  resizer._ev.pointerdown[0]({
    button: 0, pointerId: 12, clientX: 100,
    stopPropagation() {}, preventDefault() {},
  });
  document._ev.pointermove.at(-1)({ pointerId: 12, clientX: 120 });
  document._ev.pointerup.at(-1)({ pointerId: 12 });

  const paneEl = host._paneEl;
  for (const fn of paneEl._ev["mkui-pane-close"] ?? []) fn();
  for (const fn of paneEl._ev["mkui-pane-open"] ?? []) fn();
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot(makeRows(3));
  lastSubscribe().opts.onUpdate("insert", { _mkio_row: "x", name: "q".repeat(30), value: 5 });
  assert.equal(getColgroup(host)._ch[0].style.width, (30 * 6 + 17) + "px",
    "manual-resize opt-out cleared by reopen");
});

/* ── Numeric decimal alignment ───────────────────────────────────────── */

function colCells(host, col) {
  return getTbody(host)._ch.map(tr => tr._ch.find(td => td.dataset?.col === col));
}

test("numeric columns right-align and pad to the decimal point", async () => {
  const { host, io } = await createTable({ protocol: "query" });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot([
    { _mkio_row: "1", name: "a", value: "1" },
    { _mkio_row: "2", name: "b", value: "2.5" },
    { _mkio_row: "3", name: "c", value: "3.25" },
  ]);
  const tds = colCells(host, "value");
  assert.ok(tds.every(td => td.classList.contains("mkui-num")), "numeric cells aligned");
  assert.equal(tds[0].style["--mkui-num-pad"], "3ch", "integer padded past '.25'");
  assert.equal(tds[1].style["--mkui-num-pad"], "1ch", "one fraction digit short");
  assert.equal(tds[2].style["--mkui-num-pad"], "", "widest fraction needs no pad");
  const names = colCells(host, "name");
  assert.ok(names.every(td => !td.classList.contains("mkui-num")), "text column untouched");
});

test("late-arriving decimals restyle already-rendered integer cells", async () => {
  const { host, io } = await createTable({ protocol: "query" });
  triggerVisible(io);
  const sub = lastSubscribe();
  sub.opts.onSnapshot([{ _mkio_row: "1", value: "10" }]);
  assert.equal(colCells(host, "value")[0].style["--mkui-num-pad"], "", "no pad while all integers");

  sub.opts.onUpdate("insert", { _mkio_row: "2", value: "3.5" });
  const tds = colCells(host, "value");
  assert.equal(tds.find(td => td.textContent === "10").style["--mkui-num-pad"], "2ch",
    "existing integer re-padded past '.5'");
  assert.equal(tds.find(td => td.textContent === "3.5").style["--mkui-num-pad"], "");
});

test("a non-numeric value disables alignment for the whole column", async () => {
  const { host, io } = await createTable({ protocol: "query" });
  triggerVisible(io);
  const sub = lastSubscribe();
  sub.opts.onSnapshot([{ _mkio_row: "1", value: "1.5" }]);
  assert.ok(colCells(host, "value")[0].classList.contains("mkui-num"));

  sub.opts.onUpdate("insert", { _mkio_row: "2", value: "n/a" });
  assert.ok(colCells(host, "value").every(td => !td.classList.contains("mkui-num")),
    "column flips to text alignment");
});

test("cell updates keep decimal padding in sync", async () => {
  const { host, io } = await createTable({ protocol: "query" });
  triggerVisible(io);
  const sub = lastSubscribe();
  sub.opts.onSnapshot([
    { _mkio_row: "1", value: "1.25" },
    { _mkio_row: "2", value: "7" },
  ]);
  sub.opts.onUpdate("update", { _mkio_row: "2", value: "8.5" });
  const td = colCells(host, "value").find(t => t.textContent === "8.5");
  assert.equal(td.style["--mkui-num-pad"], "1ch", "updated value padded to the column's fraction");
});

test("filter dropdown decimal-aligns numeric values", async () => {
  const { host, io } = await createTable({ protocol: "query" });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot([
    { _mkio_row: "1", name: "a", value: "1" },
    { _mkio_row: "2", name: "b", value: "271.66" },
    { _mkio_row: "3", name: "c", value: "3.5" },
  ]);

  const valueTh = getThs(host).find(th => th.dataset.col === "value");
  valueTh.querySelector(".mkui-filter-btn")._ev.click[0]({ stopPropagation() {} });
  const dd = host._ch.find(c => String(c.className).includes("mkui-filter-dropdown"));
  assert.ok(dd, "dropdown opened");
  const list = dd._ch.find(c => c.className === "mkui-filter-list");
  const spans = list._ch.map(item => item._ch.find(n => n.tagName === "SPAN"));

  // numerically sorted: 1, 3.5, 271.66 — widest integer part is "271"
  assert.ok(spans.every(s => s.classList.contains("mkui-filter-num")));
  assert.equal(spans[0].textContent, "1");
  assert.equal(spans[0].style["--mkui-num-pad"], "2ch", "1 padded under 271");
  assert.equal(spans[1].textContent, "3.5");
  assert.equal(spans[1].style["--mkui-num-pad"], "2ch");
  assert.equal(spans[2].textContent, "271.66");
  assert.equal(spans[2].style["--mkui-num-pad"], "", "widest integer part needs no pad");

  // text column values stay plain
  const nameTh = getThs(host).find(th => th.dataset.col === "name");
  nameTh.querySelector(".mkui-filter-btn")._ev.click[0]({ stopPropagation() {} });
  const dd2 = host._ch.filter(c => String(c.className).includes("mkui-filter-dropdown")).at(-1);
  const spans2 = dd2._ch.find(c => c.className === "mkui-filter-list")
    ._ch.map(item => item._ch.find(n => n.tagName === "SPAN"));
  assert.ok(spans2.every(s => !s.classList.contains("mkui-filter-num")));
});

/* ── Full-width header (filler cell) ─────────────────────────────────── */

test("header row ends with a filler cell that absorbs extra width", async () => {
  const { host } = await createTable({ columns: ["a", "b"] });
  const ths = getThead(host)._ch[0]._ch;
  assert.equal(ths.length, 3, "two data columns + filler");
  assert.ok(String(ths.at(-1).className).includes("mkui-th-filler"));
});

/* ── Virtualized rendering ───────────────────────────────────────────── */

test("only the visible slice of rows is rendered", async () => {
  const { host, io } = await createTable({ protocol: "query" });
  sh(host)._clientHeight = 200; // 10 rows @ 20px, +10 overscan
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot(makeRows(100));
  assert.equal(getTbody(host)._ch.length, 20, "10 visible + 10 overscan");
  const [top, bottom] = spacerHeights(host);
  assert.equal(top, "0px");
  assert.equal(bottom, 80 * 20 + "px", "spacer stands in for the other 80 rows");
});

test("scrolling re-slices the rendered window", async () => {
  const { host, io } = await createTable({ protocol: "query" });
  sh(host)._clientHeight = 200;
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot(makeRows(100));

  sh(host).scrollTop = 1000; // rows 50-60 in view
  for (const fn of sh(host)._ev.scroll ?? []) fn();

  const rendered = getTbody(host)._ch;
  assert.equal(rendered[0].dataset.ref, "40", "starts at first overscan row");
  assert.equal(rendered.length, 30, "overscan + visible + overscan");
  const [top, bottom] = spacerHeights(host);
  assert.equal(top, 40 * 20 + "px");
  assert.equal(bottom, 30 * 20 + "px");
});

test("spacer colspan tracks the column count", async () => {
  const { host, io } = await createTable({ protocol: "query" });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot(makeRows(5)); // 2 visible columns
  const spacers = getRawTbody(host)._ch.filter(c => String(c.className).includes("mkui-vspacer"));
  assert.equal(spacers.length, 2);
  for (const sp of spacers) {
    // An oversized colspan adds that many phantom columns to the fixed
    // layout, which would swallow the filler column's width ~0px each.
    assert.equal(sp._ch[0].colSpan, 3, "data columns + filler");
  }
});

test("100k-row snapshot keeps the DOM small", async () => {
  const { host, io } = await createTable({ protocol: "query" });
  sh(host)._clientHeight = 200;
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot(makeRows(100000));
  flushRaf();
  assert.equal(getTbody(host)._ch.length, 20, "only the visible slice exists in the DOM");
  const [, bottom] = spacerHeights(host);
  assert.equal(bottom, (100000 - 20) * 20 + "px");
});

test("virtualized rows preserve live update semantics", async () => {
  const { host, io } = await createTable({ protocol: "query" });
  sh(host)._clientHeight = 200;
  triggerVisible(io);
  const sub = lastSubscribe();
  sub.opts.onSnapshot(makeRows(100));

  sub.opts.onUpdate("insert", { _mkio_row: "x1", name: "new", value: 1 });
  assert.equal(spacerHeights(host)[1], (101 - 20) * 20 + "px", "insert grows the virtual height");

  sub.opts.onUpdate("delete", { _mkio_row: "x1" });
  assert.equal(spacerHeights(host)[1], (100 - 20) * 20 + "px", "delete shrinks the virtual height");

  sub.opts.onUpdate("update", { _mkio_row: "5", name: "row-5b", value: 5 });
  const tr = getTbody(host)._ch.find(t => t.dataset.ref === "5");
  const td = tr._ch.find(c => c.dataset.col === "name");
  assert.equal(td.textContent, "row-5b", "visible row updated in place");
});

test("paged stream locks widths from the first page", async () => {
  const { host, io } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r" });
  const table = getTable(host);
  assert.ok(table.classList.contains("mkui-table-fixed"));
  assert.equal(getColgroup(host)._ch.length, 3);
});

test("refresh re-fetches with saved pageLoadRef and pageLoadBefore", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r" });
  const toolbar = findByClass(host, "mkui-table-paging");
  const nextBtn = toolbar._ch[2];
  nextBtn._ev.click[0]();
  const nextSub = lastSubscribe();
  nextSub.opts.onPage(makeStreamRows(50, 50), { hasmore: false, ref: "r2" });
  const refreshBtn = toolbar._ch[4];
  refreshBtn._ev.click[0]();
  const refreshSub = lastSubscribe();
  assert.equal(refreshSub.opts.ref, nextSub.opts.ref, "refresh uses same ref as the page it's refreshing");
});

/* ── Merged sort/filter header icon ───────────────────────────────────── */
// One icon slot per header: the filter button shows the hamburger until
// the column is sorted, then turns into the sort caret (with an in-caret
// priority digit under multi-sort). It opens the filter dropdown either way.

function clickHeader(th, { shift = false, ctrl = false, meta = false, alt = false } = {}) {
  th._ev.click[0]({ shiftKey: shift, ctrlKey: ctrl, metaKey: meta, altKey: alt,
                    target: { closest: () => null } });
}

function clickFilterBtn(th) {
  th.querySelector(".mkui-filter-btn")._ev.click[0]({ stopPropagation() {} });
}

// Describes what the header cell's single icon slot currently shows.
function headerIcon(th) {
  const btn = th.querySelector(".mkui-filter-btn");
  const ind = btn._ch.find(c => String(c.className).includes("mkui-sort-indicator"));
  if (ind) {
    const svg = ind._ch.find(c => String(c.className).includes("mkui-icon"));
    return {
      kind: String(svg.className).includes("mkui-icon-caret-up") ? "caret-up" : "caret-down",
      dir: String(ind.className).includes("mkui-sort-asc") ? "asc" : "desc",
      digit: ind._ch.find(c => String(c.className).includes("mkui-sort-num"))?.textContent ?? null,
      extra: btn._ch.length - 1,
    };
  }
  const svg = btn._ch.find(c => String(c.className).includes("mkui-icon"));
  return {
    kind: String(svg?.className).includes("mkui-icon-filter") ? "hamburger" : "none",
    extra: btn._ch.length - 1,
  };
}

test("header icon starts as the hamburger with no separate sort indicator", async () => {
  const { host } = await createTable({ columns: ["a", "b"] });
  for (const th of getThs(host)) {
    assert.deepEqual(headerIcon(th), { kind: "hamburger", extra: 0 });
    assert.equal(th.querySelector(".mkui-sort-indicator"), null,
      "no indicator outside the filter button");
    const inner = th._ch.find(n => n.className === "mkui-th-inner");
    assert.equal(inner._ch.length, 2, "label + filter button only");
  }
});

test("clicking a header swaps the hamburger for a caret, cycling asc → desc → off", async () => {
  const { host, io } = await createTable({ protocol: "query" });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot([
    { _mkio_row: "1", name: "b" },
    { _mkio_row: "2", name: "a" },
  ]);
  const th = getThs(host)[0];

  clickHeader(th);
  assert.deepEqual(headerIcon(th), { kind: "caret-up", dir: "asc", digit: null, extra: 0 },
    "asc caret replaces the hamburger");

  clickHeader(th);
  assert.deepEqual(headerIcon(th), { kind: "caret-down", dir: "desc", digit: null, extra: 0 });

  clickHeader(th);
  assert.deepEqual(headerIcon(th), { kind: "hamburger", extra: 0 },
    "third click clears the sort and restores the hamburger");
});

test("sorting reorders rendered rows: string asc/desc, third click restores insertion order", async () => {
  const { host, io } = await createTable({ protocol: "query" });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot([
    { _mkio_row: "1", name: "carol" },
    { _mkio_row: "2", name: "alice" },
    { _mkio_row: "3", name: "bob" },
  ]);
  const th = getThs(host)[0];
  const names = () => colCells(host, "name").map(td => td.textContent);

  clickHeader(th);
  assert.deepEqual(names(), ["alice", "bob", "carol"]);
  clickHeader(th);
  assert.deepEqual(names(), ["carol", "bob", "alice"]);
  clickHeader(th);
  assert.deepEqual(names(), ["carol", "alice", "bob"], "insertion order restored");
});

test("numeric columns sort numerically, not lexically", async () => {
  const { host, io } = await createTable({ protocol: "query" });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot([
    { _mkio_row: "1", value: "10" },
    { _mkio_row: "2", value: "2" },
    { _mkio_row: "3", value: "1.5" },
  ]);
  const th = getThs(host)[0];
  clickHeader(th);
  assert.deepEqual(colCells(host, "value").map(td => td.textContent),
    ["1.5", "2", "10"], "10 sorts after 2 numerically");
});

test("shift+click adds a secondary sort with priority digits inside both carets", async () => {
  const { host, io } = await createTable({ protocol: "query" });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot([
    { _mkio_row: "1", a: "x", b: "y" },
  ]);
  const [thA, thB] = getThs(host);

  clickHeader(thA);
  clickHeader(thB, { shift: true });
  assert.deepEqual(headerIcon(thA), { kind: "caret-up", dir: "asc", digit: "1", extra: 0 });
  assert.deepEqual(headerIcon(thB), { kind: "caret-up", dir: "asc", digit: "2", extra: 0 });

  // Shift+click cycles the secondary key independently: asc → desc → removed.
  clickHeader(thB, { shift: true });
  assert.deepEqual(headerIcon(thB), { kind: "caret-down", dir: "desc", digit: "2", extra: 0 });
  clickHeader(thB, { shift: true });
  assert.deepEqual(headerIcon(thB), { kind: "hamburger", extra: 0 });
  assert.deepEqual(headerIcon(thA), { kind: "caret-up", dir: "asc", digit: null, extra: 0 },
    "sole remaining key drops its priority digit");
});

test("plain click on a secondary column makes it the only sort key", async () => {
  const { host, io } = await createTable({ protocol: "query" });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot([{ _mkio_row: "1", a: "x", b: "y" }]);
  const [thA, thB] = getThs(host);

  clickHeader(thA);
  clickHeader(thB, { shift: true });
  clickHeader(thB);
  assert.deepEqual(headerIcon(thA), { kind: "hamburger", extra: 0 });
  assert.deepEqual(headerIcon(thB), { kind: "caret-up", dir: "asc", digit: null, extra: 0 });
});

test("ctrl/cmd/alt-modified header clicks leave the sort untouched", async () => {
  const { host, io } = await createTable({ protocol: "query" });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot([
    { _mkio_row: "1", a: "x", b: "y" },
  ]);
  const [thA, thB] = getThs(host);
  clickHeader(thA);
  clickHeader(thB, { shift: true }); // carefully built two-key sort

  clickHeader(thA, { ctrl: true });
  clickHeader(thB, { meta: true });
  clickHeader(thA, { alt: true });
  assert.deepEqual(headerIcon(thA), { kind: "caret-up", dir: "asc", digit: "1", extra: 0 },
    "modified clicks neither cycle nor clear the primary key");
  assert.deepEqual(headerIcon(thB), { kind: "caret-up", dir: "asc", digit: "2", extra: 0 },
    "secondary key survives modified clicks");

  // Unsorted column: a modified click must not start a sort either.
  clickHeader(thA);                   // plain click: sole key, asc
  clickHeader(thA); clickHeader(thA); // desc → cleared
  clickHeader(thA, { ctrl: true });
  assert.deepEqual(headerIcon(thA), { kind: "hamburger", extra: 0 },
    "ctrl+click on an unsorted column does not sort it");
});

test("filter button still opens the dropdown while showing a caret", async () => {
  const { host, io } = await createTable({ protocol: "query" });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot([
    { _mkio_row: "1", name: "a" },
    { _mkio_row: "2", name: "b" },
  ]);
  const th = getThs(host)[0];
  clickHeader(th);
  assert.equal(headerIcon(th).kind, "caret-up");

  clickFilterBtn(th);
  const dd = host._ch.find(c => String(c.className).includes("mkui-filter-dropdown"));
  assert.ok(dd, "dropdown opened from the caret-shaped button");
});

test("active filter keeps the button accented through icon swaps", async () => {
  const { host, io } = await createTable({ protocol: "query" });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot([
    { _mkio_row: "1", name: "a" },
    { _mkio_row: "2", name: "b" },
  ]);
  const th = getThs(host)[0];
  const btn = th.querySelector(".mkui-filter-btn");

  clickFilterBtn(th);
  const dd = host._ch.find(c => String(c.className).includes("mkui-filter-dropdown"));
  const item = dd._ch.find(c => c.className === "mkui-filter-list")._ch[0];
  const cb = item._ch.find(n => n.tagName === "INPUT");
  cb.checked = false;
  cb._ev.change[0]();
  assert.ok(btn.classList.contains("active"), "filter active with hamburger showing");
  assert.equal(headerIcon(th).kind, "hamburger");

  clickHeader(th);
  assert.ok(btn.classList.contains("active"), "still active with caret showing");
  assert.equal(headerIcon(th).kind, "caret-up");

  clickHeader(th);
  clickHeader(th);
  assert.ok(btn.classList.contains("active"), "still active after sort cleared");
  assert.equal(headerIcon(th).kind, "hamburger");
});

/* ── Selection: row column, cells, keyboard, copy, buttons ───────────── */

// Fire a pointerdown on a row's cell. tdIdx indexes tr._ch directly (with
// rowColumn the rownum cell is index 0, data cells follow).
function pointerDown(tr, tdIdx, overrides = {}) {
  const e = {
    target: tr._ch[tdIdx], button: 0, pointerType: "mouse", pointerId: 1,
    ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
    preventDefault() {},
    ...overrides,
  };
  tr._ev.pointerdown[0](e);
  return e;
}

function keyDown(scrollHost, key, overrides = {}) {
  const e = {
    key, target: { tagName: "DIV" },
    ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    ...overrides,
  };
  scrollHost._ev.keydown[0](e);
  return e;
}

async function createSelTable(specOverrides = {}) {
  const t = await createTable({ rowColumn: true, ...specOverrides });
  triggerVisible(t.io);
  lastSubscribe().opts.onSnapshot(makeRows(4));
  return t;
}

function dataRows(host) { return getTbody(host)._ch; }

test("row column is on by default", async () => {
  rafQueue.length = 0;
  const host = mockEl("div");
  const paneEl = mockEl("mkui-pane");
  host.closest = (sel) => sel === "mkui-pane" ? paneEl : null;
  const state = makeState([["mkio.connected", true]]);
  const app = { config: { mkio: { url: "ws://localhost:8080/ws" } }, state };
  const prevLen = ioCallbacks.length;
  await factory({ service: "test-svc" }, app, host);
  triggerVisible(ioCallbacks[prevLen]);
  lastSubscribe().opts.onSnapshot(makeRows(2));
  const tr = dataRows(host)[0];
  assert.equal(String(tr._ch[0].className), "mkui-td-rownum");
});

test("rowColumn false renders no row-number cells", async () => {
  const { host } = await createSelTable({ rowColumn: false });
  const tr = dataRows(host)[0];
  assert.equal(tr._ch[0].dataset.col, "name");
});

test("row numbers follow view order, 1-based", async () => {
  const { host } = await createSelTable();
  const nums = dataRows(host).map(tr => tr._ch[0].textContent);
  assert.deepEqual(nums, ["1", "2", "3", "4"]);
});

test("spacer colspan includes the row-number column", async () => {
  const { host } = await createSelTable();
  const spacer = getRawTbody(host)._ch.find(c => String(c.className).includes("mkui-vspacer"));
  // name + value + filler + rownum
  assert.equal(spacer._ch[0].colSpan, 4);
});

test("header starts with a select-all corner cell", async () => {
  const { host } = await createSelTable();
  const tr = getThead(host)._ch[0];
  assert.equal(String(tr._ch[0].className), "mkui-th-rownum");
  tr._ch[0]._ev.click[0]({});
  for (const row of dataRows(host))
    assert.ok(row.classList.contains("mkui-selected"));
});

test("modified clicks on the select-all corner are inert", async () => {
  const { host } = await createSelTable();
  const corner = getThead(host)._ch[0]._ch[0];
  for (const mod of ["ctrlKey", "metaKey", "altKey", "shiftKey"]) {
    corner._ev.click[0]({ [mod]: true });
    for (const row of dataRows(host))
      assert.ok(!row.classList.contains("mkui-selected"),
        `${mod}+click must not select all`);
  }
  corner._ev.click[0]({}); // plain click still selects all
  for (const row of dataRows(host))
    assert.ok(row.classList.contains("mkui-selected"));
});

test("rownum click selects the row; ctrl toggles; shift ranges", async () => {
  const { host } = await createSelTable();
  const trs = dataRows(host);
  pointerDown(trs[0], 0);
  assert.ok(trs[0].classList.contains("mkui-selected"));

  pointerDown(trs[2], 0, { ctrlKey: true });
  assert.ok(trs[0].classList.contains("mkui-selected"));
  assert.ok(trs[2].classList.contains("mkui-selected"));
  assert.ok(!trs[1].classList.contains("mkui-selected"));

  pointerDown(trs[2], 0, { ctrlKey: true }); // toggle back off
  assert.ok(!trs[2].classList.contains("mkui-selected"));

  pointerDown(trs[3], 0, { shiftKey: true }); // anchor is row 2 (last ctrl)
  assert.ok(trs[2].classList.contains("mkui-selected"));
  assert.ok(trs[3].classList.contains("mkui-selected"));
});

test("cell click focuses the cell and highlights its row", async () => {
  const { host } = await createSelTable();
  const trs = dataRows(host);
  pointerDown(trs[1], 1); // "name" cell of row 1
  assert.ok(trs[1]._ch[1].classList.contains("mkui-cell-focus"));
  assert.ok(trs[1].classList.contains("mkui-row-hl"));
  assert.ok(!trs[1].classList.contains("mkui-selected"));
  // plain click = implicit selection, no explicit cell-sel rect
  assert.ok(!trs[1]._ch[1].classList.contains("mkui-cell-sel"));
});

test("ctrl+cell-click keeps the focused cell selected and adds the new one", async () => {
  const { host } = await createSelTable();
  const trs = dataRows(host);
  pointerDown(trs[0], 1);
  pointerDown(trs[1], 2, { ctrlKey: true });
  assert.ok(trs[0]._ch[1].classList.contains("mkui-cell-sel"));
  assert.ok(trs[1]._ch[2].classList.contains("mkui-cell-sel"));
  assert.ok(trs[1]._ch[2].classList.contains("mkui-cell-focus"));
  // both rows carry the highlight, neither is row-selected
  assert.ok(trs[0].classList.contains("mkui-row-hl"));
  assert.ok(trs[1].classList.contains("mkui-row-hl"));
  assert.ok(!trs[0].classList.contains("mkui-selected"));
});

test("shift+cell-click selects the rectangle between anchor and target", async () => {
  const { host } = await createSelTable();
  const trs = dataRows(host);
  pointerDown(trs[0], 1);
  pointerDown(trs[2], 2, { shiftKey: true });
  for (let r = 0; r <= 2; r++)
    for (let c = 1; c <= 2; c++)
      assert.ok(trs[r]._ch[c].classList.contains("mkui-cell-sel"),
        `cell ${r},${c} in rect`);
  assert.ok(!trs[3]._ch[1].classList.contains("mkui-cell-sel"));
});

test("ctrl+click on a selected cell toggles it off", async () => {
  const { host } = await createSelTable();
  const trs = dataRows(host);
  pointerDown(trs[0], 1);
  pointerDown(trs[2], 2, { shiftKey: true });
  pointerDown(trs[1], 1, { ctrlKey: true }); // inside the rect → off
  assert.ok(!trs[1]._ch[1].classList.contains("mkui-cell-sel"));
  assert.ok(trs[1]._ch[2].classList.contains("mkui-cell-sel"), "rest of rect intact");
});

test("selecting cells clears row selection and vice versa", async () => {
  const { host } = await createSelTable();
  const trs = dataRows(host);
  pointerDown(trs[0], 0); // row select
  pointerDown(trs[1], 1); // cell select
  assert.ok(!trs[0].classList.contains("mkui-selected"));
  pointerDown(trs[2], 0); // row select again
  assert.ok(trs[2].classList.contains("mkui-selected"));
  assert.ok(!trs[1]._ch[1].classList.contains("mkui-cell-sel"));
});

/* Cell rects track records, not positions: the row keys spanned when the
   rect was made stay selected across sorts, filters, and live inserts —
   rows that later move between the rect's endpoints don't join it. */

test("sorting keeps cell selection on the originally selected records", async () => {
  const { host, io } = await createTable({ protocol: "query" });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot([
    { _mkio_row: "1", name: "carol" },
    { _mkio_row: "2", name: "alice" },
    { _mkio_row: "3", name: "bob" },
  ]);
  let trs = dataRows(host);
  pointerDown(trs[0], 0);                     // carol
  pointerDown(trs[1], 0, { shiftKey: true }); // rect carol..alice
  clickHeader(getThs(host)[0]);               // asc: alice, bob, carol
  trs = dataRows(host);
  assert.deepEqual(trs.map(tr => tr._ch[0].textContent), ["alice", "bob", "carol"]);
  assert.ok(trs[0]._ch[0].classList.contains("mkui-cell-sel"), "alice stays selected");
  assert.ok(!trs[1]._ch[0].classList.contains("mkui-cell-sel"),
    "bob sorted between the endpoints doesn't join the selection");
  assert.ok(trs[2]._ch[0].classList.contains("mkui-cell-sel"), "carol stays selected");
});

test("copy after sorting copies the originally selected cells", async () => {
  const { host, io } = await createTable({ protocol: "query" });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot([
    { _mkio_row: "1", name: "carol" },
    { _mkio_row: "2", name: "alice" },
    { _mkio_row: "3", name: "bob" },
  ]);
  const trs = dataRows(host);
  pointerDown(trs[0], 0);
  pointerDown(trs[1], 0, { shiftKey: true }); // carol + alice
  clickHeader(getThs(host)[0]);               // asc: alice, bob, carol
  let written = null;
  globalThis.navigator = { clipboard: { writeText: (s) => { written = s; } } };
  try { host._paneEl._editActions.copy(); }
  finally { delete globalThis.navigator; }
  assert.equal(written, "alice\r\ncarol", "bob is not part of the copied grid");
});

test("live insert between a sorted rect's rows doesn't join the selection", async () => {
  const { host, io } = await createTable({ protocol: "query" });
  triggerVisible(io);
  const sub = lastSubscribe();
  sub.opts.onSnapshot([
    { _mkio_row: "1", name: "alice" },
    { _mkio_row: "2", name: "carol" },
  ]);
  clickHeader(getThs(host)[0]); // sort asc first
  let trs = dataRows(host);
  pointerDown(trs[0], 0);
  pointerDown(trs[1], 0, { shiftKey: true }); // alice + carol
  sub.opts.onUpdate("insert", { _mkio_row: "3", name: "bob" });
  trs = dataRows(host);
  assert.deepEqual(trs.map(tr => tr._ch[0].textContent), ["alice", "bob", "carol"]);
  assert.ok(trs[0]._ch[0].classList.contains("mkui-cell-sel"));
  assert.ok(!trs[1]._ch[0].classList.contains("mkui-cell-sel"),
    "inserted row inside the rect's span stays unselected");
  assert.ok(trs[2]._ch[0].classList.contains("mkui-cell-sel"));
});

test("shift+arrow-extended rect also tracks its records across a sort", async () => {
  const { host, io } = await createTable({ protocol: "query" });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot([
    { _mkio_row: "1", name: "carol" },
    { _mkio_row: "2", name: "alice" },
    { _mkio_row: "3", name: "bob" },
  ]);
  keyDown(sh(host), "ArrowDown");                     // place cursor on carol
  keyDown(sh(host), "ArrowDown", { shiftKey: true }); // rect carol..alice
  clickHeader(getThs(host)[0]);                   // asc: alice, bob, carol
  const trs = dataRows(host);
  assert.ok(trs[0]._ch[0].classList.contains("mkui-cell-sel"), "alice stays selected");
  assert.ok(!trs[1]._ch[0].classList.contains("mkui-cell-sel"),
    "bob sorted between the endpoints doesn't join the selection");
  assert.ok(trs[2]._ch[0].classList.contains("mkui-cell-sel"), "carol stays selected");
});

test("ctrl-toggled-off cell stays off after sorting", async () => {
  const { host, io } = await createTable({ protocol: "query" });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot([
    { _mkio_row: "1", name: "carol" },
    { _mkio_row: "2", name: "alice" },
    { _mkio_row: "3", name: "bob" },
  ]);
  let trs = dataRows(host);
  pointerDown(trs[0], 0);
  pointerDown(trs[2], 0, { shiftKey: true });   // carol, alice, bob
  pointerDown(trs[1], 0, { ctrlKey: true });    // toggle alice off
  clickHeader(getThs(host)[0]);                 // asc: alice, bob, carol
  trs = dataRows(host);
  assert.ok(!trs[0]._ch[0].classList.contains("mkui-cell-sel"), "alice still toggled off");
  assert.ok(trs[1]._ch[0].classList.contains("mkui-cell-sel"), "bob stays selected");
  assert.ok(trs[2]._ch[0].classList.contains("mkui-cell-sel"), "carol stays selected");
});

test("filtered-out rect members reappear selected when the filter is relaxed", async () => {
  const { host } = await createSelTable();
  const trs = dataRows(host);
  pointerDown(trs[0], 1);
  pointerDown(trs[2], 1, { shiftKey: true }); // name cells of rows 0-2
  const th = getThead(host)._ch[0]._ch.find(t => t.dataset.col === "name");
  clickFilterBtn(th);
  const dd = host._ch.find(c => String(c.className).includes("mkui-filter-dropdown"));
  const cbs = dd._ch.find(c => c.className === "mkui-filter-list")._ch
    .map(item => item._ch.find(n => n.tagName === "INPUT"));
  for (const cb of cbs) cb.checked = cb.dataset.val !== "row-1";
  cbs[0]._ev.change[0]();
  let vis = dataRows(host);
  assert.equal(vis.length, 3, "row-1 filtered out");
  assert.ok(vis[0]._ch[1].classList.contains("mkui-cell-sel"));
  assert.ok(vis[1]._ch[1].classList.contains("mkui-cell-sel"));
  assert.ok(!vis[2]._ch[1].classList.contains("mkui-cell-sel"), "row-3 was never in the rect");
  for (const cb of cbs) cb.checked = true;
  cbs[0]._ev.change[0]();
  vis = dataRows(host);
  assert.equal(vis.length, 4);
  assert.ok(vis[1]._ch[1].classList.contains("mkui-cell-sel"),
    "row-1 rejoins the selection when the filter is relaxed");
});

test("arrow keys move the focused cell; first press just places it", async () => {
  const { host } = await createSelTable();
  const trs = dataRows(host);
  keyDown(sh(host), "ArrowDown");
  assert.ok(trs[0]._ch[1].classList.contains("mkui-cell-focus"), "cursor placed at first cell");
  keyDown(sh(host), "ArrowDown");
  keyDown(sh(host), "ArrowRight");
  assert.ok(trs[1]._ch[2].classList.contains("mkui-cell-focus"));
  assert.ok(!trs[0]._ch[1].classList.contains("mkui-cell-focus"));
});

test("shift+arrow extends a cell rect from the anchor", async () => {
  const { host } = await createSelTable();
  const trs = dataRows(host);
  pointerDown(trs[0], 1);
  keyDown(sh(host), "ArrowDown", { shiftKey: true });
  keyDown(sh(host), "ArrowRight", { shiftKey: true });
  for (let r = 0; r <= 1; r++)
    for (let c = 1; c <= 2; c++)
      assert.ok(trs[r]._ch[c].classList.contains("mkui-cell-sel"));
});

test("space selects the focused row; ctrl+space toggles more rows in", async () => {
  const { host } = await createSelTable();
  const trs = dataRows(host);
  pointerDown(trs[1], 1);
  keyDown(sh(host), " ");
  assert.ok(trs[1].classList.contains("mkui-selected"));
  keyDown(sh(host), "ArrowDown");
  // plain arrow cleared the row selection (back to cell mode)
  assert.ok(!trs[1].classList.contains("mkui-selected"));
  keyDown(sh(host), " ");
  keyDown(sh(host), "ArrowUp");
  assert.ok(!trs[2].classList.contains("mkui-selected"));
});

test("shift+arrow in row mode grows the row range", async () => {
  const { host } = await createSelTable();
  const trs = dataRows(host);
  pointerDown(trs[0], 0);
  keyDown(sh(host), "ArrowDown", { shiftKey: true });
  keyDown(sh(host), "ArrowDown", { shiftKey: true });
  assert.ok(trs[0].classList.contains("mkui-selected"));
  assert.ok(trs[1].classList.contains("mkui-selected"));
  assert.ok(trs[2].classList.contains("mkui-selected"));
  keyDown(sh(host), "ArrowUp", { shiftKey: true });
  assert.ok(!trs[2].classList.contains("mkui-selected"), "range shrinks back");
});

test("Home/End jump columns; ctrl+End jumps to the last cell", async () => {
  const { host } = await createSelTable();
  const trs = dataRows(host);
  pointerDown(trs[1], 2);
  keyDown(sh(host), "Home");
  assert.ok(trs[1]._ch[1].classList.contains("mkui-cell-focus"));
  keyDown(sh(host), "End", { ctrlKey: true });
  assert.ok(trs[3]._ch[2].classList.contains("mkui-cell-focus"));
});

test("edit hook: Escape clears selection but keeps the cursor", async () => {
  const { host } = await createSelTable();
  const paneEl = host._paneEl;
  const trs = dataRows(host);
  pointerDown(trs[0], 0);
  assert.equal(paneEl._editActions.clearSelection(), true);
  assert.ok(!trs[0].classList.contains("mkui-selected"));
  assert.ok(trs[0]._ch[1].classList.contains("mkui-cell-focus"), "cursor survives Esc");
  assert.equal(paneEl._editActions.clearSelection(), false, "nothing left to clear");
});

test("edit hook: selectAll selects every view row", async () => {
  const { host } = await createSelTable();
  host._paneEl._editActions.selectAll();
  for (const tr of dataRows(host))
    assert.ok(tr.classList.contains("mkui-selected"));
});

test("copy of selected rows includes the header labels row", async () => {
  const { host } = await createSelTable({ labels: { name: "Name" } });
  const trs = dataRows(host);
  pointerDown(trs[0], 0);
  pointerDown(trs[2], 0, { ctrlKey: true });
  let written = null;
  globalThis.navigator = { clipboard: { writeText: (s) => { written = s; } } };
  try {
    assert.equal(host._paneEl._editActions.copy(), true);
  } finally {
    delete globalThis.navigator;
  }
  assert.equal(written,
    "Name\tvalue\r\nrow-0\t0\r\nrow-2\t2");
});

test("copy of cells has no header and blanks outside the rects", async () => {
  const { host } = await createSelTable();
  const trs = dataRows(host);
  pointerDown(trs[0], 1);                    // (0, name)
  pointerDown(trs[1], 2, { ctrlKey: true }); // (1, value)
  let written = null;
  globalThis.navigator = { clipboard: { writeText: (s) => { written = s; } } };
  try { host._paneEl._editActions.copy(); }
  finally { delete globalThis.navigator; }
  assert.equal(written, "row-0\t\r\n\t1");
});

test("copy with only a focused cell copies that one value", async () => {
  const { host } = await createSelTable();
  pointerDown(dataRows(host)[2], 1);
  let written = null;
  globalThis.navigator = { clipboard: { writeText: (s) => { written = s; } } };
  try { host._paneEl._editActions.copy(); }
  finally { delete globalThis.navigator; }
  assert.equal(written, "row-2");
});

test("copy with no data reports unhandled", async () => {
  const { host } = await createTable({ rowColumn: true, columns: ["name"] });
  assert.equal(host._paneEl._editActions.copy(), false);
});

test("copy writes both TSV and HTML flavors when ClipboardItem exists", async () => {
  const { host } = await createSelTable();
  pointerDown(dataRows(host)[0], 0);
  let items = null;
  globalThis.ClipboardItem = class { constructor(o) { this.o = o; } };
  globalThis.navigator = { clipboard: {
    write: (arr) => { items = arr; },
    writeText: () => { throw new Error("should use write()"); },
  } };
  try { host._paneEl._editActions.copy(); }
  finally { delete globalThis.navigator; delete globalThis.ClipboardItem; }
  await Promise.resolve();
  assert.ok(items, "clipboard.write called");
  const flavors = Object.keys(items[0].o);
  assert.deepEqual(flavors.sort(), ["text/html", "text/plain"]);
  assert.equal(await items[0].o["text/html"].text(),
    "<table><tr><th>name</th><th>value</th></tr><tr><td>row-0</td><td>0</td></tr></table>");
});

test("row-unit buttons act on the rows implied by a cell selection", async () => {
  const { host } = await createSelTable({
    buttons: [{ label: "Act", enable: { minSelected: 1 },
                action: { type: "transaction", service: "svc", data: { n: "${row.name}" } } }],
  });
  const toolbar = host._ch.find(c => String(c.className).includes("mkui-table-toolbar"));
  const btn = toolbar._ch[0];
  assert.equal(btn.disabled, true, "disabled before any interaction");
  const trs = dataRows(host);
  pointerDown(trs[1], 1); // focused cell implies its row
  assert.equal(btn.disabled, false);
  const sent = [];
  fakeClient.send = (service, data, opts) => sent.push({ service, data, opts });
  try {
    btn._ev.click[0]();
    assert.deepEqual(sent, [{ service: "svc", data: { n: "row-1" }, opts: { op: undefined } }]);
  } finally {
    delete fakeClient.send;
  }
});

test("cell-unit buttons count cells and default to exactly one", async () => {
  const { host } = await createSelTable({
    buttons: [{ label: "C", unit: "cell", action: { type: "action", name: "x" } }],
  });
  const toolbar = host._ch.find(c => String(c.className).includes("mkui-table-toolbar"));
  const btn = toolbar._ch[0];
  const trs = dataRows(host);
  assert.equal(btn.disabled, true);
  pointerDown(trs[0], 1);
  assert.equal(btn.disabled, false, "one focused cell enables");
  pointerDown(trs[1], 2, { ctrlKey: true });
  assert.equal(btn.disabled, true, "two cells exceed the singular default");
});

test("rows-unit is the default and counts row selection", async () => {
  const { host } = await createSelTable({
    buttons: [{ label: "R", enable: { minSelected: 2 }, action: { type: "action", name: "x" } }],
  });
  const toolbar = host._ch.find(c => String(c.className).includes("mkui-table-toolbar"));
  const btn = toolbar._ch[0];
  const trs = dataRows(host);
  pointerDown(trs[0], 0);
  assert.equal(btn.disabled, true, "one row < minSelected 2");
  pointerDown(trs[1], 0, { ctrlKey: true });
  assert.equal(btn.disabled, false);
});

test("selection survives re-render; deleted rows drop out of it", async () => {
  const { host } = await createSelTable();
  let trs = dataRows(host);
  pointerDown(trs[0], 0);
  pointerDown(trs[1], 0, { ctrlKey: true });
  lastSubscribe().opts.onUpdate("delete", { _mkio_row: "1" });
  // row "0" still selected, row "1" gone (its tr lingers only to fade out)
  trs = dataRows(host).filter(tr => !tr.classList.contains("mkui-flash-out"));
  const selected = trs.filter(tr => tr.classList.contains("mkui-selected"));
  assert.equal(selected.length, 1);
  assert.equal(selected[0]._ch[1].textContent, "row-0");
});

test("new snapshot fully resets selection and focus", async () => {
  const { host } = await createSelTable();
  const trs = dataRows(host);
  pointerDown(trs[1], 1);
  lastSubscribe().opts.onSnapshot(makeRows(2, 10));
  for (const tr of dataRows(host)) {
    assert.ok(!tr.classList.contains("mkui-selected"));
    assert.ok(!tr.classList.contains("mkui-row-hl"));
    for (const td of tr._ch)
      assert.ok(!td.classList.contains("mkui-cell-focus"));
  }
});

test("copy pulses the copied rows and shows a transient status message", async () => {
  const { host, state } = await createSelTable();
  const trs = dataRows(host);
  pointerDown(trs[0], 0);
  pointerDown(trs[1], 0, { ctrlKey: true });
  globalThis.navigator = { clipboard: { writeText: () => {} } };
  try { host._paneEl._editActions.copy(); }
  finally { delete globalThis.navigator; }
  assert.ok(trs[0].classList.contains("mkui-flash-copy"));
  assert.ok(trs[1].classList.contains("mkui-flash-copy"));
  assert.ok(!trs[2].classList.contains("mkui-flash-copy"));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(state.get("status.message"), "Copied 2 rows");
  advanceTimers();
  assert.equal(state.get("status.message"), "", "message reverts after the timeout");
});

test("cell copy pulses the cells and counts them in the message", async () => {
  const { host, state } = await createSelTable();
  const trs = dataRows(host);
  pointerDown(trs[0], 1);
  pointerDown(trs[1], 2, { shiftKey: true }); // 2x2 rect
  globalThis.navigator = { clipboard: { writeText: () => {} } };
  try { host._paneEl._editActions.copy(); }
  finally { delete globalThis.navigator; }
  for (let r = 0; r <= 1; r++)
    for (let c = 1; c <= 2; c++)
      assert.ok(trs[r]._ch[c].classList.contains("mkui-flash-copy"), `cell ${r},${c}`);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(state.get("status.message"), "Copied 4 cells");
});

test("focused-cell copy reports 1 cell; failures report Copy failed", async () => {
  const { host, state } = await createSelTable();
  pointerDown(dataRows(host)[0], 1);
  globalThis.navigator = { clipboard: { writeText: () => {} } };
  try { host._paneEl._editActions.copy(); }
  finally { delete globalThis.navigator; }
  await Promise.resolve(); await Promise.resolve();
  assert.equal(state.get("status.message"), "Copied 1 cell");
  advanceTimers();
  globalThis.navigator = { clipboard: { writeText: () => { throw new Error("denied"); } } };
  try { host._paneEl._editActions.copy(); }
  finally { delete globalThis.navigator; }
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(state.get("status.message"), "Copy failed");
});

test("a status update landing mid-timeout is not clobbered by the revert", async () => {
  const { host, state } = await createSelTable();
  pointerDown(dataRows(host)[0], 0);
  globalThis.navigator = { clipboard: { writeText: () => {} } };
  try { host._paneEl._editActions.copy(); }
  finally { delete globalThis.navigator; }
  await Promise.resolve(); await Promise.resolve();
  state.set("status.message", "Disconnected"); // e.g. the mkio.disconnected map
  advanceTimers();
  assert.equal(state.get("status.message"), "Disconnected");
});

test("shift+space is an alias for row select (Excel muscle memory)", async () => {
  const { host } = await createSelTable();
  const trs = dataRows(host);
  pointerDown(trs[2], 1);
  keyDown(sh(host), " ", { shiftKey: true });
  assert.ok(trs[2].classList.contains("mkui-selected"));
});

test("filtering out a selected row prunes it from the selection", async () => {
  const { host } = await createSelTable();
  const trs = dataRows(host);
  pointerDown(trs[0], 0);
  pointerDown(trs[1], 0, { ctrlKey: true });
  // filter the "name" column to only row-1 via the dropdown
  const th = getThead(host)._ch[0]._ch.find(t => t.dataset.col === "name");
  clickFilterBtn(th);
  const dd = host._ch.find(c => String(c.className).includes("mkui-filter-dropdown"));
  const cbs = dd._ch.find(c => c.className === "mkui-filter-list")._ch
    .map(item => item._ch.find(n => n.tagName === "INPUT"));
  for (const cb of cbs) cb.checked = cb.dataset.val === "row-1";
  cbs[0]._ev.change[0]();
  // only row-1 is visible; row-0 must have dropped out of the selection,
  // so copy sees exactly the surviving selected row
  let written = null;
  globalThis.navigator = { clipboard: { writeText: (s) => { written = s; } } };
  try { host._paneEl._editActions.copy(); }
  finally { delete globalThis.navigator; }
  assert.equal(written, "name\tvalue\r\nrow-1\t1");
});

/* ── Derived columns (values) ─────────────────────────────────────────── */

// `values = { col = "<expr>" }` derives a column with an expression over the
// row: `value` is the raw row[col], row fields are in scope by name.
const SHOUT = { name: "UPPER(value)" };
const DOUBLE = { value: "NUM_OF(value) * 2" };
// Virtual column: no row carries "combo"; it exists only in config.
// `value` in cell scope is the cell's own raw value (NULL here), so the
// row's "value" column is reached as row.value.
const COMBO = { combo: "name + ':' + STR(row.value)" };
const MILLIS = { value: "STR(value) + ' ms'" };

function cellsOf(tr) {
  return tr._ch.filter(td => td.dataset?.col != null).map(td => td.textContent);
}

async function createFmtTable(specOverrides = {}) {
  const t = await createTable(specOverrides);
  triggerVisible(t.io);
  lastSubscribe().opts.onSnapshot(makeRows(3));
  return t;
}

test("a values expression transforms a column's displayed text", async () => {
  const { host } = await createFmtTable({
    columns: ["name", "value"], values: SHOUT,
  });
  assert.deepEqual(cellsOf(dataRows(host)[0]), ["ROW-0", "0"]);
});

test("columns without a values expression are untouched", async () => {
  const { host } = await createFmtTable({
    columns: ["name", "value"], values: SHOUT,
  });
  assert.deepEqual(cellsOf(dataRows(host)[1]), ["ROW-1", "1"]);
});

test("a values expression can create a virtual column absent from the row data", async () => {
  const { host } = await createFmtTable({
    columns: ["name", "combo"], values: COMBO,
  });
  assert.deepEqual(cellsOf(dataRows(host)[2]), ["row-2", "row-2:2"]);
});

test("an invalid values expression warns at init and falls back to the raw value", async () => {
  const warned = [];
  const origWarn = console.warn;
  console.warn = (...a) => warned.push(a.join(" "));
  try {
    const { host } = await createFmtTable({
      columns: ["name"], values: { name: "UPPER(" },
    });
    assert.deepEqual(cellsOf(dataRows(host)[0]), ["row-0"]);
    assert.equal(warned.filter(w => w.includes("bad values expression for name")).length, 1);
  } finally {
    console.warn = origWarn;
  }
});

test("a values expression that errors at runtime warns once and yields empty", async () => {
  const warned = [];
  const origWarn = console.warn;
  console.warn = (...a) => warned.push(a.join(" "));
  try {
    const { host } = await createFmtTable({
      columns: ["name"], values: { name: "value / 0" },
    });
    assert.deepEqual(dataRows(host).map(tr => cellsOf(tr)[0]), ["", "", ""]);
    assert.equal(warned.filter(w => w.includes("values.name")).length, 1, "one warning, not one per cell");
  } finally {
    console.warn = origWarn;
  }
});

test("derived values drive sorting, not the raw ones", async () => {
  // Raw ascending is 0,1,2; doubling keeps that order, so sort descending
  // and assert the formatted text to prove the comparator saw the doubles.
  const { host } = await createFmtTable({
    columns: ["value"], values: DOUBLE,
  });
  const th = getThead(host)._ch[0]._ch.find(t => t.dataset.col === "value");
  clickHeader(th);                           // asc
  assert.deepEqual(dataRows(host).map(tr => cellsOf(tr)[0]), ["0", "2", "4"]);
  clickHeader(th);                           // desc
  assert.deepEqual(dataRows(host).map(tr => cellsOf(tr)[0]), ["4", "2", "0"]);
});

test("filter dropdown lists derived values", async () => {
  const { host } = await createFmtTable({
    columns: ["name"], values: SHOUT,
  });
  const th = getThead(host)._ch[0]._ch.find(t => t.dataset.col === "name");
  clickFilterBtn(th);
  const dd = host._ch.find(c => String(c.className).includes("mkui-filter-dropdown"));
  const vals = dd._ch.find(c => c.className === "mkui-filter-list")._ch
    .map(item => item._ch.find(n => n.tagName === "INPUT").dataset.val);
  assert.deepEqual(vals.sort(), ["ROW-0", "ROW-1", "ROW-2"]);
});

test("filtering matches on the derived value", async () => {
  const { host } = await createFmtTable({
    columns: ["name"], values: SHOUT,
  });
  const th = getThead(host)._ch[0]._ch.find(t => t.dataset.col === "name");
  clickFilterBtn(th);
  const dd = host._ch.find(c => String(c.className).includes("mkui-filter-dropdown"));
  const cbs = dd._ch.find(c => c.className === "mkui-filter-list")._ch
    .map(item => item._ch.find(n => n.tagName === "INPUT"));
  for (const cb of cbs) cb.checked = cb.dataset.val === "ROW-1";
  cbs[0]._ev.change[0]();
  assert.deepEqual(dataRows(host).map(tr => cellsOf(tr)[0]), ["ROW-1"]);
});

test("copy exports derived values", async () => {
  const { host } = await createTable({
    rowColumn: true, columns: ["name"], values: SHOUT,
  });
  triggerVisible(host._paneEl && ioCallbacks[ioCallbacks.length - 1]);
  lastSubscribe().opts.onSnapshot(makeRows(2));
  host._paneEl._editActions.selectAll();
  let written = null;
  globalThis.navigator = { clipboard: { writeText: (s) => { written = s; } } };
  try { host._paneEl._editActions.copy(); }
  finally { delete globalThis.navigator; }
  assert.equal(written, "name\r\nROW-0\r\nROW-1");
});

test("live update re-evaluates the values expression", async () => {
  const { host } = await createFmtTable({
    columns: ["name"], values: SHOUT,
  });
  lastSubscribe().opts.onUpdate("update", { _mkio_row: "1", name: "renamed", value: 1 });
  assert.deepEqual(dataRows(host).map(tr => cellsOf(tr)[0]),
                   ["ROW-0", "RENAMED", "ROW-2"]);
});

test("cell scope exposes value, row, col, row fields, and app-registered functions", async () => {
  const seen = [];
  registerExprFunction("PROBE", (v, row, col, name) => { seen.push([v, row.name, col, name]); return v; });
  await createFmtTable({ columns: ["value"], values: { value: "PROBE(value, row, col, name)" } });
  assert.deepEqual(seen[0], [0, "row-0", "value", "row-0"]);
});

test("cell scope reads app state", async () => {
  const { host, state } = await createFmtTable({
    columns: ["value"], values: { value: "value * (state.mult ?? 1)" },
  });
  assert.deepEqual(colCells(host, "value").map(td => td.textContent), ["0", "1", "2"]);
  state.set("mult", 10);
  lastSubscribe().opts.onUpdate("update", { _mkio_row: "1", name: "row-1", value: 2 });
  assert.equal(colCells(host, "value")[1].textContent, "20", "re-evaluated on update against current state");
});

test("derived numbers drive decimal alignment, not the raw ones", async () => {
  // Raw 1 / 2.5 / 3.25 would pad 3ch / 1ch / none; doubled to 2 / 5 / 6.5 the
  // column's widest fraction is one digit, so the integers pad 2ch instead.
  const { host, io } = await createTable({
    columns: ["value"], values: DOUBLE,
  });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot([
    { _mkio_row: "1", value: "1" },
    { _mkio_row: "2", value: "2.5" },
    { _mkio_row: "3", value: "3.25" },
  ]);
  const tds = colCells(host, "value");
  assert.deepEqual(tds.map(td => td.textContent), ["2", "5", "6.5"]);
  assert.ok(tds.every(td => td.classList.contains("mkui-num")), "still a numeric column");
  assert.deepEqual(tds.map(td => td.style["--mkui-num-pad"]), ["2ch", "2ch", ""]);
});

test("a values expression that yields text turns off numeric alignment", async () => {
  const { host } = await createFmtTable({
    columns: ["value"], values: MILLIS,
  });
  const tds = colCells(host, "value");
  assert.deepEqual(tds.map(td => td.textContent), ["0 ms", "1 ms", "2 ms"]);
  assert.ok(tds.every(td => !td.classList.contains("mkui-num")), "text column, no alignment");
});

test("cell-mode copy exports the derived value", async () => {
  const { host } = await createSelTable({
    columns: ["name", "value"], values: SHOUT,
  });
  pointerDown(dataRows(host)[1], 1);          // focused cell = name of row-1
  let written = null;
  globalThis.navigator = { clipboard: { writeText: (s) => { written = s; } } };
  try { host._paneEl._editActions.copy(); }
  finally { delete globalThis.navigator; }
  assert.equal(written, "ROW-1");
});

test("row-unit button payloads carry the raw field, not the derived one", async () => {
  const { host } = await createSelTable({
    columns: ["name", "value"], values: SHOUT,
    buttons: [{ label: "Act", enable: { minSelected: 1 },
                action: { type: "transaction", service: "svc", data: { n: "${row.name}" } } }],
  });
  pointerDown(dataRows(host)[1], 0);
  const toolbar = host._ch.find(c => String(c.className).includes("mkui-table-toolbar"));
  const sent = [];
  fakeClient.send = (service, data, opts) => sent.push({ service, data, opts });
  try {
    toolbar._ch[0]._ev.click[0]();
    assert.deepEqual(sent, [{ service: "svc", data: { n: "row-1" }, opts: { op: undefined } }]);
  } finally {
    delete fakeClient.send;
  }
});

test("cell-unit button payloads carry the raw cell value", async () => {
  const { host } = await createSelTable({
    columns: ["name", "value"], values: SHOUT,
    buttons: [{ label: "C", unit: "cell",
                action: { type: "transaction", service: "svc",
                          data: { v: "${cell.value}" } } }],
  });
  pointerDown(dataRows(host)[1], 1);          // focused cell = name of row-1
  const toolbar = host._ch.find(c => String(c.className).includes("mkui-table-toolbar"));
  const sent = [];
  fakeClient.send = (service, data, opts) => sent.push({ service, data, opts });
  try {
    toolbar._ch[0]._ev.click[0]();
    assert.deepEqual(sent, [{ service: "svc", data: { v: "row-1" }, opts: { op: undefined } }]);
  } finally {
    delete fakeClient.send;
  }
});

/* ── Conditional styling (styles / rowStyle) ─────────────────────────── */

test("declarative cell rules style only the matching cells", async () => {
  const { host } = await createFmtTable({
    styles: { value: [{ when: "value > 1", color: "red", bold: true, underline: true, strike: true }] },
  });
  const tds = colCells(host, "value");
  assert.equal(tds[2].style.color, "red");
  assert.equal(tds[2].style.fontWeight, "bold");
  assert.equal(tds[2].style.textDecoration, "underline line-through");
  assert.equal(tds[0].style.color, "", "non-matching cell untouched");
  assert.equal(tds[1].style.color, "", "> is strict");
});

test("cell rules are first-match-wins with a condition-free fallback", async () => {
  const { host } = await createFmtTable({
    styles: { value: [{ when: "value == 1", color: "blue" }, { color: "gray" }] },
  });
  const tds = colCells(host, "value");
  assert.deepEqual(tds.map(td => td.style.color), ["gray", "blue", "gray"]);
});

test("styled backgrounds ride the marker class + custom property", async () => {
  const { host } = await createFmtTable({
    styles: { name: [{ when: "CONTAINS(value, 'row-1')", background: "#400" }] },
  });
  const tds = colCells(host, "name");
  assert.ok(tds[1].classList.contains("mkui-cell-styled"));
  assert.equal(tds[1].style["--mkui-cell-bg"], "#400");
  assert.equal(tds[1].style.background, "", "no inline background — CSS keeps precedence");
  assert.ok(!tds[0].classList.contains("mkui-cell-styled"));
});

test("row rules condition on multiple columns via when", async () => {
  const { host } = await createFmtTable({
    rowStyle: [{ when: "CONTAINS(['row-0', 'row-2'], name) && value <= 0",
                 background: "green", class: "alert" }],
  });
  const trs = getTbody(host)._ch;
  assert.ok(trs[0].classList.contains("mkui-row-styled"), "row-0 matches both conditions");
  assert.equal(trs[0].style["--mkui-row-bg"], "green");
  assert.ok(trs[0].classList.contains("alert"), "custom class applied");
  assert.ok(!trs[2].classList.contains("mkui-row-styled"), "row-2 fails the value condition");
  assert.ok(!trs[1].classList.contains("mkui-row-styled"), "row-1 fails the name condition");
});

test("a styler may be one expression yielding a style map or NULL", async () => {
  const { host } = await createFmtTable({
    styles: { value: "IF(value > 1, {italic: TRUE}, NULL)" },
    rowStyle: "IF(value > 1, {css: {opacity: '0.5'}}, NULL)",
  });
  const tds = colCells(host, "value");
  assert.equal(tds[2].style.fontStyle, "italic");
  assert.equal(tds[0].style.fontStyle, "");
  const trs = getTbody(host)._ch;
  assert.equal(trs[2].style.opacity, "0.5", "css escape hatch applies inline");
  assert.equal(trs[0].style.opacity, "");
});

test("a live replace restyles the row and its cells both ways", async () => {
  const { host } = await createFmtTable({
    styles: { value: [{ when: "value > 1", color: "red" }] },
    rowStyle: [{ when: "value > 1", class: "warn" }],
  });
  const trs = getTbody(host)._ch;
  assert.equal(colCells(host, "value")[0].style.color, "");
  lastSubscribe().opts.onUpdate("update", { _mkio_row: "0", name: "row-0", value: 5 });
  assert.equal(colCells(host, "value")[0].style.color, "red", "style gained on update");
  assert.ok(trs[0].classList.contains("warn"), "row class gained on update");
  lastSubscribe().opts.onUpdate("update", { _mkio_row: "2", name: "row-2", value: 0 });
  assert.equal(colCells(host, "value")[2].style.color, "", "style cleared on update");
  assert.ok(!trs[2].classList.contains("warn"), "row class cleared on update");
});

test("a styler calling an unknown function warns once and applies nothing", async () => {
  const warned = [];
  const origWarn = console.warn;
  console.warn = (...a) => warned.push(a.join(" "));
  try {
    const { host } = await createFmtTable({ styles: { value: "NO_SUCH_STYLER(value)" } });
    const tds = colCells(host, "value");
    assert.ok(tds.every(td => td.style.color === "" && !td.classList.contains("mkui-cell-styled")));
    assert.equal(warned.filter(w => w.includes("NO_SUCH_STYLER")).length, 1,
      "one warning, not one per cell");
  } finally {
    console.warn = origWarn;
  }
});

test("a rule whose condition errors never matches; later rules still apply", async () => {
  const warned = [];
  const origWarn = console.warn;
  console.warn = (...a) => warned.push(a.join(" "));
  try {
    const { host } = await createFmtTable({
      styles: { name: [{ when: "MATCHES(value, '(')", color: "red" }, { when: "value == 'row-1'", color: "blue" }] },
    });
    const tds = colCells(host, "name");
    assert.deepEqual(tds.map(td => td.style.color), ["", "blue", ""]);
    assert.equal(warned.filter(w => w.includes("styles.name[0]")).length, 1, "warned once, not per cell");
  } finally {
    console.warn = origWarn;
  }
});

test("style values may be templates over the cell scope", async () => {
  const { host } = await createFmtTable({
    styles: { value: [{ color: "${IF(value > 1, 'red', 'blue')}", css: { opacity: "${1 - value / 10}" } }] },
  });
  const tds = colCells(host, "value");
  assert.deepEqual(tds.map(td => td.style.color), ["blue", "blue", "red"]);
  assert.deepEqual(tds.map(td => td.style.opacity), ["1", "0.9", "0.8"]);
});

test("a button's enable.when sees the selected rows", async () => {
  const { host } = await createSelTable({
    columns: ["name", "value"],
    buttons: [{ label: "Act", enable: { when: "LEN(rows) > 0 && ALL(rows, r -> r.value > 0)" } }],
  });
  const btn = host._ch.find(c => String(c.className).includes("mkui-table-toolbar"))._ch[0];
  assert.equal(btn.disabled, true, "nothing selected");
  pointerDown(dataRows(host)[0], 0);
  assert.equal(btn.disabled, true, "row-0 has value 0");
  pointerDown(dataRows(host)[2], 0);
  assert.equal(btn.disabled, false, "row-2 has value 2");
});

test("cell rules test the derived value", async () => {
  const { host } = await createFmtTable({
    columns: ["name", "value"], values: MILLIS,
    styles: { value: [{ when: "value == '2 ms'", color: "red" }] },
  });
  const tds = colCells(host, "value");
  assert.deepEqual(tds.map(td => td.style.color), ["", "", "red"]);
});

/* ── Display templates (rich cells) ───────────────────────────────────── */

test("display templates control the shown text, not the value", async () => {
  const { host } = await createFmtTable({
    columns: ["name", "value"], display: { value: "${NUM(value, digits: 2)} pts" },
  });
  const tds = colCells(host, "value");
  assert.deepEqual(tds.map(td => td.textContent), ["0.00 pts", "1.00 pts", "2.00 pts"]);
  assert.ok(tds.every(td => td.classList.contains("mkui-num")), "still numeric — alignment judged on the value");
  const th = getThead(host)._ch[0]._ch.find(t => t.dataset.col === "value");
  clickHeader(th); clickHeader(th);   // desc
  assert.deepEqual(colCells(host, "value").map(td => td.textContent), ["2.00 pts", "1.00 pts", "0.00 pts"], "sorted numerically");
});

test("display sees the derived value and other columns", async () => {
  const { host } = await createFmtTable({
    columns: ["name", "value"], values: DOUBLE,
    display: { value: "${value}/${row.value} ${name}" },
  });
  assert.deepEqual(colCells(host, "value").map(td => td.textContent), ["0/0 row-0", "2/1 row-1", "4/2 row-2"]);
});

test("rich display renders styled spans and keeps the flattened text", async () => {
  const { host } = await createFmtTable({
    columns: ["name", "value"],
    display: { name: "${BOLD(value)} ${MUTED('#' + STR(row.value))}", value: "${BADGE(value, 'green')}" },
  });
  const td = colCells(host, "name")[1];
  const spans = td._ch.filter(n => n.tagName === "SPAN");
  assert.equal(spans.length, 3);
  assert.equal(spans[0].textContent, "row-1");
  assert.equal(spans[0].style.fontWeight, "bold");
  assert.equal(spans[1].textContent, " ");
  assert.ok(spans[2].classList.contains("mkui-muted"));
  assert.equal(spans[2].textContent, "#1");
  assert.equal(td._mkuiText, "row-1 #1");
  const badge = colCells(host, "value")[2]._ch[0];
  assert.ok(badge.classList.contains("mkui-rich-badge"));
  assert.equal(badge.style["--mkui-badge-color"], "#4caf50");
});

test("ICON and BAR segments render their own elements", async () => {
  const { host } = await createFmtTable({
    columns: ["name", "value"],
    display: { name: "${ICON('check')}${value}", value: "${BAR(value / 2, '#4caf50')}" },
  });
  const nameTd = colCells(host, "name")[0];
  assert.equal(nameTd._ch[0].className, "mkui-rich-icon");
  assert.equal(nameTd._ch[1].textContent, "row-0");
  const bar = colCells(host, "value")[1]._ch[0];
  assert.equal(bar.className, "mkui-rich-bar");
  assert.equal(bar.style["--mkui-bar-frac"], "50%");
  assert.equal(bar.style["--mkui-bar-color"], "#4caf50");
});

test("a display error renders #ERR with the message as tooltip, warned once", async () => {
  const warned = [];
  const origWarn = console.warn;
  console.warn = (...a) => warned.push(a.join(" "));
  try {
    const { host } = await createFmtTable({ columns: ["value"], display: { value: "${value / 0}" } });
    const tds = colCells(host, "value");
    assert.deepEqual(tds.map(td => td.textContent), ["#ERR", "#ERR", "#ERR"]);
    assert.ok(tds[0].classList.contains("mkui-cell-err"));
    assert.match(tds[0].title, /Division by zero/);
    assert.equal(warned.filter(w => w.includes("display.value")).length, 1);
  } finally {
    console.warn = origWarn;
  }
});

test("a live update re-renders display cells that read the changed column", async () => {
  const { host } = await createFmtTable({
    columns: ["name", "value"], display: { name: "${value} (${row.value})" },
  });
  assert.equal(colCells(host, "name")[1].textContent, "row-1 (1)");
  lastSubscribe().opts.onUpdate("update", { _mkio_row: "1", name: "row-1", value: 9 });
  assert.equal(colCells(host, "name")[1].textContent, "row-1 (9)", "name cell re-rendered though `name` didn't change");
  assert.ok(colCells(host, "name")[1].classList.contains("mkui-flash-update"));
});

test("copy carries display text in TSV and styled markup in HTML", async () => {
  const { host } = await createSelTable({
    columns: ["name", "value"], display: { name: "${BOLD(value)}", value: "${value} pts" },
  });
  host._paneEl._editActions.selectAll();
  let items = null, text = null;
  globalThis.navigator = { clipboard: {
    write: async (its) => { items = its; },
    writeText: async (s) => { text = s; },
  } };
  globalThis.ClipboardItem = class { constructor(parts) { this.parts = parts; } };
  globalThis.Blob = class { constructor(parts) { this.body = parts.join(""); } };
  try {
    host._paneEl._editActions.copy();
    for (let i = 0; i < 8; i++) await Promise.resolve();   // the harness mocks setTimeout; flush microtasks only
    assert.ok(items, "ClipboardItem path used");
    assert.equal(items[0].parts["text/plain"].body, "name\tvalue\r\nrow-0\t0 pts\r\nrow-1\t1 pts\r\nrow-2\t2 pts\r\nrow-3\t3 pts");
    assert.match(items[0].parts["text/html"].body, /<td><span style="font-weight:bold">row-0<\/span><\/td><td>0 pts<\/td>/);
    assert.equal(text, null);
  } finally {
    delete globalThis.navigator; delete globalThis.ClipboardItem; delete globalThis.Blob;
  }
});

test("width stats measure the display text", async () => {
  const { host, io } = await createTable({ columns: ["value"], display: { value: "${value}0000" } });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot([{ _mkio_row: "1", value: "1.5" }]);
  const td = colCells(host, "value")[0];
  assert.equal(td.textContent, "1.50000");
  assert.ok(td.classList.contains("mkui-num"));
});

/* ── select: publishing the current row to app state ─────────────────── */

test("no select spec leaves app state untouched", async () => {
  const { host, state } = await createSelTable();
  pointerDown(dataRows(host)[1], 0);
  assert.equal(state.get("current"), undefined);
});

test("select publishes the clicked row to the configured state path", async () => {
  const { host, state } = await createSelTable({ select: { state: "current" } });
  pointerDown(dataRows(host)[1], 0);
  assert.equal(state.get("current").name, "row-1");
});

test("Esc keeps the cursor, so the published row survives a selection clear", async () => {
  const { host, state } = await createSelTable({ select: { state: "current" } });
  pointerDown(dataRows(host)[1], 0);
  assert.equal(state.get("current").name, "row-1");
  host._paneEl._editActions.clearSelection();   // Esc: drops selection, keeps cursor
  assert.equal(state.get("current").name, "row-1");
});

test("select publishes null on a full reset that drops the cursor", async () => {
  const { host, state } = await createSelTable({ select: { state: "current" } });
  pointerDown(dataRows(host)[1], 0);
  assert.equal(state.get("current").name, "row-1");
  lastSubscribe().opts.onSnapshot(makeRows(4));  // query snapshot = full reset
  assert.equal(state.get("current"), null);
});

test("select publishes the first row in view order on select-all", async () => {
  const { host, state } = await createSelTable({ select: { state: "current" } });
  host._paneEl._editActions.selectAll();
  assert.equal(state.get("current").name, "row-0");
});

test("select republishes when a live update replaces the published row", async () => {
  const { host, state } = await createSelTable({ select: { state: "current" } });
  pointerDown(dataRows(host)[1], 0);
  lastSubscribe().opts.onUpdate("update", { _mkio_row: "1", name: "row-1", value: 99 });
  assert.equal(state.get("current").value, 99);
});

test("select ignores live updates to rows other than the published one", async () => {
  const { host, state } = await createSelTable({ select: { state: "current" } });
  pointerDown(dataRows(host)[1], 0);
  lastSubscribe().opts.onUpdate("update", { _mkio_row: "2", name: "row-2", value: 77 });
  assert.equal(state.get("current").name, "row-1");
});

test("deleting the published row publishes null", async () => {
  const { host, state } = await createSelTable({ select: { state: "current" } });
  pointerDown(dataRows(host)[1], 0);
  lastSubscribe().opts.onUpdate("delete", { _mkio_row: "1" });
  assert.equal(state.get("current"), null);
});

test("deleting the published row promotes the next selected row", async () => {
  const { host, state } = await createSelTable({ select: { state: "current" } });
  host._paneEl._editActions.selectAll();          // no cursor: first-in-view wins
  assert.equal(state.get("current").name, "row-0");
  lastSubscribe().opts.onUpdate("delete", { _mkio_row: "0" });
  assert.equal(state.get("current").name, "row-1");
});

test("filtering out the published row publishes null", async () => {
  const { host, state } = await createSelTable({
    select: { state: "current" }, columns: ["name", "value"],
  });
  host._paneEl._editActions.selectAll();
  assert.equal(state.get("current").name, "row-0");
  const th = getThead(host)._ch[0]._ch.find(t => t.dataset.col === "name");
  clickFilterBtn(th);
  const dd = host._ch.find(c => String(c.className).includes("mkui-filter-dropdown"));
  const cbs = dd._ch.find(c => c.className === "mkui-filter-list")._ch
    .map(item => item._ch.find(n => n.tagName === "INPUT"));
  for (const cb of cbs) cb.checked = cb.dataset.val === "row-3";
  cbs[0]._ev.change[0]();
  assert.equal(state.get("current").name, "row-3", "the surviving selected row wins");
});

test("closing the pane publishes null", async () => {
  const { host, state } = await createSelTable({ select: { state: "current" } });
  pointerDown(dataRows(host)[1], 0);
  assert.equal(state.get("current").name, "row-1");
  for (const fn of host._paneEl._ev["mkui-pane-close"] ?? []) fn();
  assert.equal(state.get("current"), null);
});

test("select follows the cursor as the arrow keys move it", async () => {
  const { host, state } = await createSelTable({ select: { state: "current" } });
  keyDown(sh(host), "ArrowDown");                // first press only places the cursor
  assert.equal(state.get("current").name, "row-0");
  keyDown(sh(host), "ArrowDown");
  assert.equal(state.get("current").name, "row-1");
});

test("select writes only when the tracked row changes", async () => {
  const { host, state } = await createSelTable({ select: { state: "current" } });
  pointerDown(dataRows(host)[1], 0);
  const before = state.writes("current");
  pointerDown(dataRows(host)[1], 0);         // same row again
  assert.equal(state.writes("current"), before, "re-selecting the same row is a no-op");
});

/* ── Range filters ───────────────────────────────────────────────────── */
// Numeric columns and columns whose every value is a time offer a Range
// mode next to the Values checkboxes. Bounds are typed into From/To
// inputs (applied after a short debounce, or at once on Enter); time
// columns also get relative presets. `types` overrides the inference.

// The mock querySelector matches on substring, so pick by exact class.
function byClass(el, cls) {
  const out = [];
  const walk = (n) => { for (const c of n._ch ?? []) { if (c.className === cls) out.push(c); walk(c); } };
  walk(el);
  return out;
}
function openDropdown(host, col) {
  const th = getThs(host).find(t => t.dataset.col === col);
  clickFilterBtn(th);
  const dd = host._ch.filter(c => String(c.className).includes("mkui-filter-dropdown")).at(-1);
  const modes = dd._ch.find(c => c.className === "mkui-filter-modes");
  const range = dd._ch.find(c => c.className === "mkui-filter-range");
  const bounds = range ? byClass(range, "mkui-filter-bound-input") : [];
  const presets = range ? byClass(range, "mkui-filter-preset") : [];
  const empty = range ? byClass(range, "mkui-filter-item mkui-filter-empty")[0]._ch.find(n => n.tagName === "INPUT") : null;
  const clear = range ? byClass(range, "mkui-filter-action")[0] : null;
  const list = dd._ch.find(c => c.className === "mkui-filter-list");
  return { th, dd, modes, range, lo: bounds[0], hi: bounds[1], presets, empty, clear, list,
    modeBtn: (m) => modes?._ch.find(b => b.dataset.mode === m) };
}
function typeBound(inp, v) { inp.value = v; inp._ev.input[0](); advanceTimers(); }
function enterBound(inp, v) { inp.value = v; inp._ev.keydown[0]({ key: "Enter" }); }
const shownNames = (host) => colCells(host, "name").map(td => td.textContent);

async function numericTable() {
  const { host, io } = await createTable({ protocol: "query" });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot([
    { _mkio_row: "1", name: "a", value: "5" },
    { _mkio_row: "2", name: "b", value: "10" },
    { _mkio_row: "3", name: "c", value: "15.5" },
    { _mkio_row: "4", name: "d", value: "" },
  ]);
  return host;
}

test("numeric columns offer a Range mode; text columns do not", async () => {
  const host = await numericTable();
  const num = openDropdown(host, "value");
  assert.ok(num.modes, "mode switch present");
  assert.ok(num.range, "range panel present");
  assert.equal(num.lo.type, "number");
  assert.equal(num.lo.placeholder, "5", "placeholders show the column's min/max");
  assert.equal(num.hi.placeholder, "15.5");
  assert.equal(num.presets.length, 0, "no time presets on a number column");
  assert.equal(num.range.hidden, true, "opens in Values mode");
  assert.ok(num.modeBtn("values").classList.contains("active"));
  const txt = openDropdown(host, "name");
  assert.equal(txt.modes, undefined);
  assert.equal(txt.range, undefined);
});

test("numeric range filters the view with inclusive open-ended bounds", async () => {
  const host = await numericTable();
  const d = openDropdown(host, "value");
  d.modeBtn("range")._ev.click[0]();
  assert.equal(d.range.hidden, false);
  assert.equal(d.list.hidden, true, "values list hidden in Range mode");
  typeBound(d.lo, "10");
  assert.deepEqual(shownNames(host), ["b", "c"], "≥ 10 keeps 10 and 15.5, drops the blank");
  const btn = d.th.querySelector(".mkui-filter-btn");
  assert.ok(btn.classList.contains("active"));
  assert.equal(btn.title, "≥ 10");
  enterBound(d.hi, "10");
  assert.deepEqual(shownNames(host), ["b"], "hi is inclusive for numbers");
  assert.equal(btn.title, "10 – 10");
  d.empty.checked = true;
  d.empty._ev.change[0]();
  assert.deepEqual(shownNames(host), ["b", "d"], "include empty admits the blank");
  assert.equal(btn.title, "10 – 10 (+ empty)");
  // Clear removes the filter entirely
  d.clear._ev.click[0]();
  assert.deepEqual(shownNames(host), ["a", "b", "c", "d"]);
  assert.ok(!btn.classList.contains("active"));
});

test("reopening restores the typed bounds; a Values choice replaces the range", async () => {
  const host = await numericTable();
  let d = openDropdown(host, "value");
  d.modeBtn("range")._ev.click[0]();
  typeBound(d.lo, "6");
  clickFilterBtn(d.th); // the button toggles: close, then reopen
  d = openDropdown(host, "value");
  assert.equal(d.range.hidden, false, "reopens in Range mode when a range is active");
  assert.equal(d.lo.value, "6");
  d.modeBtn("values")._ev.click[0]();
  const cbs = d.list._ch.map(item => item._ch.find(n => n.tagName === "INPUT"));
  assert.ok(cbs.every(cb => cb.checked), "values list starts unfiltered");
  cbs[0].checked = false;
  cbs[0]._ev.change[0]();
  assert.deepEqual(shownNames(host), ["a", "b", "c"], "values filter replaced the range (blank first in value order)");
});

test("live inserts and updates respect an active numeric range", async () => {
  const host = await numericTable();
  const d = openDropdown(host, "value");
  d.modeBtn("range")._ev.click[0]();
  typeBound(d.lo, "10");
  const sub = lastSubscribe();
  sub.opts.onUpdate("insert", { _mkio_row: "5", name: "e", value: "3" });
  sub.opts.onUpdate("insert", { _mkio_row: "6", name: "f", value: "30" });
  assert.deepEqual(shownNames(host), ["b", "c", "f"]);
  sub.opts.onUpdate("replace", { _mkio_row: "5", name: "e", value: "12" });
  assert.deepEqual(shownNames(host), ["b", "c", "f", "e"], "an update into range joins the view");
});

async function timeTable(extra = {}) {
  const { host, io } = await createTable({ protocol: "query", ...extra });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot([
    { _mkio_row: "1", name: "a", ts: "2026-08-29T09:00:00Z" },
    { _mkio_row: "2", name: "b", ts: "2026-08-29 09:30:15" },
    { _mkio_row: "3", name: "c", ts: "20260829 10:00:00.250000" },
    { _mkio_row: "4", name: "d", ts: "" },
  ]);
  return host;
}

test("time columns are detected and range-filter on parsed instants", async () => {
  const host = await timeTable();
  const d = openDropdown(host, "ts");
  assert.ok(d.modes, "a column of ISO/ref strings offers Range");
  assert.equal(d.lo.type, "datetime-local");
  assert.equal(d.lo.placeholder, "2026-08-29T09:00:00", "placeholders show the parsed min/max");
  assert.equal(d.hi.placeholder, "2026-08-29T10:00:00");
  assert.deepEqual(d.presets.map(p => p.textContent), ["Today", "Last hour", "Last 15 min"]);
  d.modeBtn("range")._ev.click[0]();
  typeBound(d.lo, "2026-08-29T09:30");
  assert.deepEqual(shownNames(host), ["b", "c"], "mixed ISO/ref formats compare as instants");
  enterBound(d.hi, "2026-08-29T09:30");
  assert.deepEqual(shownNames(host), ["b"], "a minute bound covers the whole minute");
  enterBound(d.hi, "2026-08-29T09:30:14");
  assert.deepEqual(shownNames(host), [], "…but a second bound is exact");
  assert.equal(d.th.querySelector(".mkui-filter-btn").title, "2026-08-29 09:30 – 2026-08-29 09:30:14");
});

test("time presets resolve against the clock and schedule a refresh", async () => {
  const realNow = Date.now;
  Date.now = () => Date.UTC(2026, 7, 29, 10, 20, 0);
  try {
    const host = await timeTable();
    const d = openDropdown(host, "ts");
    d.modeBtn("range")._ev.click[0]();
    d.presets[1]._ev.click[0](); // Last hour: 09:20 – 10:20
    assert.deepEqual(shownNames(host), ["b", "c"]);
    assert.ok(d.presets[1].classList.contains("active"));
    assert.equal(d.th.querySelector(".mkui-filter-btn").title, "Last hour");
    const tick = [...pendingTimers.entries()].find(([, t]) => t.ms === 30000);
    assert.ok(tick, "periodic re-apply scheduled");
    Date.now = () => Date.UTC(2026, 7, 29, 10, 45, 0);
    pendingTimers.delete(tick[0]);
    tick[1].fn(); // fires and reschedules itself
    assert.deepEqual(shownNames(host), ["c"], "rows age out as time passes");
    d.presets[0]._ev.click[0](); // Today (UTC day for a UTC column)
    assert.deepEqual(shownNames(host), ["a", "b", "c"]);
    typeBound(d.lo, "2026-08-29T10:00");
    assert.ok(!d.presets[0].classList.contains("active"), "typing a bound drops the preset");
    assert.deepEqual(shownNames(host), ["c"]);
    assert.ok(![...pendingTimers.values()].some(t => t.ms === 30000), "no preset, no timer");
  } finally {
    Date.now = realNow;
  }
});

test("clock-time columns filter by time of day", async () => {
  const { host, io } = await createTable({ protocol: "query" });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot([
    { _mkio_row: "1", name: "a", t: "08:59:59" },
    { _mkio_row: "2", name: "b", t: "09:00" },
    { _mkio_row: "3", name: "c", t: "16:00:00.5" },
  ]);
  const d = openDropdown(host, "t");
  assert.equal(d.lo.type, "time");
  d.modeBtn("range")._ev.click[0]();
  typeBound(d.lo, "09:00");
  enterBound(d.hi, "16:00");
  assert.deepEqual(shownNames(host), ["b", "c"]);
});

test("a column mixing dates with clock times, or with text, is not temporal", async () => {
  const { host, io } = await createTable({ protocol: "query" });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot([
    { _mkio_row: "1", name: "a", d: "2026-08-29", t: "2026-08-29" },
    { _mkio_row: "2", name: "b", d: "09:30", t: "tomorrow" },
  ]);
  assert.equal(openDropdown(host, "d").modes, undefined);
  assert.equal(openDropdown(host, "t").modes, undefined);
});

test("types declares how an unrecognised format parses", async () => {
  const { host, io } = await createTable({
    protocol: "query",
    types: { when: { type: "time", parse: "%d/%m/%Y %H:%M" }, epoch: { type: "time", unit: "ms" }, name: "text" },
  });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot([
    { _mkio_row: "1", name: "a", when: "29/08/2026 09:00", epoch: 1787994000000 },
    { _mkio_row: "2", name: "b", when: "29/08/2026 09:30", epoch: 1787995800000 },
    { _mkio_row: "3", name: "c", when: "bad", epoch: 1787997600000 },
  ]);
  const w = openDropdown(host, "when");
  assert.ok(w.modes, "locale dates are rangeable once declared");
  w.modeBtn("range")._ev.click[0]();
  typeBound(w.lo, "2026-08-29T09:30");
  assert.deepEqual(shownNames(host), ["b"], "unparseable values drop out of a range");
  w.empty.checked = true; w.empty._ev.change[0]();
  assert.deepEqual(shownNames(host), ["b", "c"], "…unless empty/unparseable is included");
  w.clear._ev.click[0]();

  const e = openDropdown(host, "epoch");
  assert.equal(e.lo.type, "datetime-local", "a numeric column typed as time gets time inputs");
  e.modeBtn("range")._ev.click[0]();
  enterBound(e.hi, "2026-08-29T09:00");
  assert.deepEqual(shownNames(host), ["a"]);
});

test("types.tz = local reads naive strings in the browser's zone", async () => {
  const { host, io } = await createTable({ protocol: "query", types: { ts: { type: "time", tz: "local" } } });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot([
    { _mkio_row: "1", name: "a", ts: "2026-08-29 09:00:00" },
    { _mkio_row: "2", name: "2", ts: "2026-08-29 09:30:00" },
  ]);
  const d = openDropdown(host, "ts");
  d.modeBtn("range")._ev.click[0]();
  typeBound(d.lo, "2026-08-29T09:30");
  assert.deepEqual(shownNames(host), ["2"], "picker and cells share the local frame");
});

test("range filters see the derived value and reset on pane reopen", async () => {
  const { host, io } = await createTable({ protocol: "query", values: { value: "NUM_OF(value) * 2" } });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot([
    { _mkio_row: "1", name: "a", value: "1" },
    { _mkio_row: "2", name: "b", value: "4" },
  ]);
  const d = openDropdown(host, "value");
  d.modeBtn("range")._ev.click[0]();
  typeBound(d.lo, "3");
  assert.deepEqual(shownNames(host), ["b"], "2 < 3 ≤ 8");
  for (const fn of host._paneEl._ev["mkui-pane-close"] ?? []) fn();
  for (const fn of host._paneEl._ev["mkui-pane-open"] ?? []) fn();
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot([
    { _mkio_row: "1", name: "a", value: "1" },
    { _mkio_row: "2", name: "b", value: "4" },
  ]);
  assert.deepEqual(shownNames(host), ["a", "b"], "reopen cleared the range");
});

/* ── Value filters: include vs exclude intent ────────────────────────── */

function valueFilterCtl(host, col) {
  const { dd, list } = openDropdown(host, col);
  const cbs = list._ch.map(item => item._ch.find(n => n.tagName === "INPUT"));
  const actions = dd._ch.find(c => c.className === "mkui-filter-actions")._ch;
  return {
    cbs,
    set: (val, on) => { const cb = cbs.find(c => c.dataset.val === val); cb.checked = on; cb._ev.change[0](); },
    selectAll: () => actions[0]._ev.click[0](),
    clear: () => actions[1]._ev.click[0](),
  };
}
const filterTitle = (host, col) =>
  getThs(host).find(t => t.dataset.col === col).querySelector(".mkui-filter-btn").title;

async function statusTable() {
  const { host, io } = await createTable({ protocol: "stream", columns: ["name", "status"], maxcount: null });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot([
    { _mkio_ref: streamRef(1), name: "a", status: "open" },
    { _mkio_ref: streamRef(2), name: "b", status: "closed" },
    { _mkio_ref: streamRef(3), name: "c", status: "held" },
  ]);
  return host;
}

test("unchecking values excludes them — unseen values in live rows stay visible", async () => {
  const host = await statusTable();
  const f = valueFilterCtl(host, "status");
  f.set("closed", false);
  assert.deepEqual(shownNames(host), ["a", "c"]);
  assert.equal(filterTitle(host, "status"), "All but 1 values");
  const opts = lastSubscribe().opts;
  opts.onUpdate("insert", { _mkio_ref: streamRef(4), name: "d", status: "new" });
  opts.onUpdate("insert", { _mkio_ref: streamRef(5), name: "e", status: "closed" });
  assert.deepEqual(shownNames(host), ["a", "c", "d"], "a never-seen value passes an exclusion");
  opts.onUpdate("update", { _mkio_ref: streamRef(5), name: "e", status: "reopened" });
  assert.deepEqual(shownNames(host), ["a", "c", "d", "e"], "an update out of the excluded set shows the row");
  opts.onUpdate("update", { _mkio_ref: streamRef(1), name: "a", status: "closed" });
  assert.deepEqual(shownNames(host), ["c", "d", "e"], "an update into the excluded set hides the row");
});

test("Clear then checking values includes only them — unseen values stay hidden", async () => {
  const host = await statusTable();
  const f = valueFilterCtl(host, "status");
  f.clear();
  assert.deepEqual(shownNames(host), []);
  f.set("open", true);
  f.set("held", true);
  assert.deepEqual(shownNames(host), ["a", "c"]);
  assert.equal(filterTitle(host, "status"), "2 values");
  const opts = lastSubscribe().opts;
  opts.onUpdate("insert", { _mkio_ref: streamRef(4), name: "d", status: "new" });
  assert.deepEqual(shownNames(host), ["a", "c"], "a never-seen value fails an inclusion");
  opts.onUpdate("update", { _mkio_ref: streamRef(4), name: "d", status: "open" });
  assert.deepEqual(shownNames(host), ["a", "c", "d"]);
  // Re-checking every listed value keeps the inclusion (new values still hidden).
  f.set("closed", true);
  opts.onUpdate("insert", { _mkio_ref: streamRef(6), name: "f", status: "other" });
  assert.deepEqual(shownNames(host), ["a", "b", "c", "d"]);
  // Select all flips back to an exclusion of nothing — no filter.
  f.selectAll();
  assert.deepEqual(shownNames(host), ["a", "b", "c", "d", "f"]);
  assert.equal(filterTitle(host, "status"), "");
});

test("value filter intent survives reopening the dropdown and stream paging", async () => {
  const { host, io } = await createTable({ protocol: "stream", columns: ["name", "status"], maxcount: 2 });
  triggerVisible(io);
  lastSubscribe().opts.onPage([
    { _mkio_ref: streamRef(1), name: "a", status: "open" },
    { _mkio_ref: streamRef(2), name: "b", status: "closed" },
  ], { hasmore: true, ref: "p1" });
  let f = valueFilterCtl(host, "status");
  f.set("closed", false);
  clickFilterBtn(getThs(host).find(t => t.dataset.col === "status")); // toggle closed
  f = valueFilterCtl(host, "status");
  assert.deepEqual(f.cbs.map(c => [c.dataset.val, c.checked]), [["closed", false], ["open", true]]);
  const [, , nextBtn] = byClass(host, "mkui-table-paging")[0]._ch;
  nextBtn._ev.click[0]();
  lastSubscribe().opts.onPage([
    { _mkio_ref: streamRef(3), name: "c", status: "new" },
    { _mkio_ref: streamRef(4), name: "d", status: "closed" },
  ], { hasmore: false, ref: "p2" });
  assert.deepEqual(shownNames(host), ["c"], "the next page is judged by the exclusion");
});

/* ── Configured and programmatic filters ─────────────────────────────── */
// `filters = { col = <filter> }` seeds the table before any data and is
// restored on pane reopen; the same shape drives `paneEl._filters.set/get`.

function withWarnings(fn) {
  const warned = [];
  const origWarn = console.warn;
  console.warn = (...a) => warned.push(a.join(" "));
  return Promise.resolve().then(fn).then(
    (r) => { console.warn = origWarn; return [r, warned]; },
    (e) => { console.warn = origWarn; throw e; },
  );
}

const orderRows = () => [
  { _mkio_row: "1", name: "a", status: "open", qty: "50", ts: "2026-08-29T09:00:00Z" },
  { _mkio_row: "2", name: "b", status: "closed", qty: "150", ts: "2026-08-29 09:30:15" },
  { _mkio_row: "3", name: "c", status: "new", qty: "250", ts: "2026-08-30 10:00:00" },
  { _mkio_row: "4", name: "d", status: "closed", qty: "", ts: "" },
];

async function filteredTable(filters, extra = {}) {
  const { host, io } = await createTable({ protocol: "query", columns: ["name", "status", "qty", "ts"], filters, ...extra });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot(orderRows());
  return host;
}

test("filters config: a value list includes, include/exclude record intent", async () => {
  let host = await filteredTable({ status: ["open", "new"] });
  assert.deepEqual(shownNames(host), ["a", "c"]);
  assert.equal(filterTitle(host, "status"), "2 values");
  host = await filteredTable({ status: { exclude: ["closed"] } });
  assert.deepEqual(shownNames(host), ["a", "c"]);
  assert.equal(filterTitle(host, "status"), "All but 1 values");
  lastSubscribe().opts.onUpdate("insert", { _mkio_row: "5", name: "e", status: "other" });
  assert.deepEqual(shownNames(host), ["a", "c", "e"], "an exclusion lets unseen values through");
  host = await filteredTable({ status: { include: ["open"] } });
  lastSubscribe().opts.onUpdate("insert", { _mkio_row: "5", name: "e", status: "other" });
  assert.deepEqual(shownNames(host), ["a"], "an inclusion keeps unseen values hidden");
});

test("filters config is active before data and shows in the header and dropdown", async () => {
  const { host, io } = await createTable({ protocol: "query", columns: ["name", "status"], filters: { status: ["open"] } });
  assert.equal(filterTitle(host, "status"), "1 values", "header rendered from `columns` shows the filter");
  assert.ok(getThs(host).find(t => t.dataset.col === "status").querySelector(".mkui-filter-btn").classList.contains("active"));
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot(orderRows());
  assert.deepEqual(shownNames(host), ["a"]);
  const f = valueFilterCtl(host, "status");
  assert.deepEqual(f.cbs.map(c => [c.dataset.val, c.checked]), [["closed", false], ["new", false], ["open", true]]);
  f.set("new", true);
  assert.deepEqual(shownNames(host), ["a", "c"], "the dropdown edits the configured filter in place");
});

test("filters config: number ranges from numeric bounds, empty opt-in", async () => {
  let host = await filteredTable({ qty: { from: 100, to: 250 } });
  assert.deepEqual(shownNames(host), ["b", "c"]);
  assert.equal(filterTitle(host, "qty"), "100 – 250");
  host = await filteredTable({ qty: { to: 100, empty: true } });
  assert.deepEqual(shownNames(host), ["a", "d"], "blank qty passes with empty = true");
  const d = openDropdown(host, "qty");
  assert.equal(d.range.hidden, false, "dropdown opens in Range mode");
  assert.equal(d.hi.value, "100");
  assert.equal(d.empty.checked, true);
  host = await filteredTable({ qty: { from: "100", type: "number" } });
  assert.deepEqual(shownNames(host), ["b", "c"], "type = number reads string bounds as numbers");
});

test("filters config: time ranges from strings, dates cover the day, presets tick", async () => {
  let host = await filteredTable({ ts: { from: "2026-08-29 09:30", to: "2026-08-29" } });
  assert.deepEqual(shownNames(host), ["b"], "a date `to` runs to the next midnight");
  assert.equal(filterTitle(host, "ts"), "2026-08-29 09:30 – 2026-08-29 23:59:59");
  let d = openDropdown(host, "ts");
  assert.equal(d.lo.value, "2026-08-29T09:30");
  assert.equal(d.hi.value, "2026-08-29T23:59:59", "a date bound restores as the last second of the day");
  host = await filteredTable({ ts: { from: "2026-08-30" } });
  assert.deepEqual(shownNames(host), ["c"]);
  const realNow = Date.now;
  Date.now = () => Date.UTC(2026, 7, 29, 10, 20, 0);
  try {
    host = await filteredTable({ ts: { preset: "1h" } });
    assert.deepEqual(shownNames(host), ["b"], "09:20 – 10:20");
    assert.equal(filterTitle(host, "ts"), "Last hour");
    assert.ok([...pendingTimers.values()].some(t => t.ms === 30000), "preset re-apply scheduled at init");
    d = openDropdown(host, "ts");
    assert.ok(d.presets[1].classList.contains("active"));
  } finally {
    Date.now = realNow;
  }
});

test("filters config honors `types` and epoch bounds", async () => {
  const { host, io } = await createTable({
    protocol: "query", columns: ["name", "t"],
    types: { t: { type: "time", unit: "ms" } },
    filters: { t: { from: 1700000000000 } },
  });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot([
    { _mkio_row: "1", name: "a", t: 1699999999000 },
    { _mkio_row: "2", name: "b", t: 1700000000000 },
  ]);
  assert.deepEqual(shownNames(host), ["b"], "a number bound on a unit column is an epoch, not a number range");
  const d = openDropdown(host, "t");
  assert.equal(d.lo.value, "2023-11-14T22:13:20");
});

test("filters config: bad entries warn and are skipped, others still apply", async () => {
  const [host, warned] = await withWarnings(() => filteredTable({
    status: ["open"],
    qty: { from: "abc", type: "number" },
    ts: { from: "2026-08-29T09:30Z" },
    name: { preset: "yesterday" },
    x: 42,
  }));
  assert.deepEqual(shownNames(host), ["a"], "the good filter applied");
  assert.equal(Object.keys(host._paneEl._filters.get()).join(), "status");
  assert.match(warned.find(w => w.includes("filters.qty")), /bad bound 'abc'/);
  assert.match(warned.find(w => w.includes("filters.ts")), /bad from '2026-08-29T09:30Z' for a datetime column/);
  assert.match(warned.find(w => w.includes("filters.name")), /unknown preset 'yesterday'/);
  assert.match(warned.find(w => w.includes("filters.x")), /expected a value list or an object/);
});

test("pane reopen restores the configured filters, not the interactive ones", async () => {
  const { host, io } = await createTable({ protocol: "query", columns: ["name", "status"], filters: { status: { exclude: ["closed"] } } });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot(orderRows());
  const f = valueFilterCtl(host, "status");
  f.set("open", false);
  assert.deepEqual(shownNames(host), ["c"]);
  for (const fn of host._paneEl._ev["mkui-pane-close"] ?? []) fn();
  for (const fn of host._paneEl._ev["mkui-pane-open"] ?? []) fn();
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot(orderRows());
  assert.deepEqual(shownNames(host), ["a", "c"], "back to the config default");
  assert.deepEqual(host._paneEl._filters.get(), { status: { exclude: ["closed"] } });
});

test("_filters.set replaces or merges, null clears a column, get round-trips", async () => {
  const host = await filteredTable({ status: ["open", "new"] });
  const api = host._paneEl._filters;
  api.set({ qty: { from: 100 } });
  assert.deepEqual(shownNames(host), ["b", "c"], "set replaces the whole map");
  assert.equal(filterTitle(host, "status"), "", "the status filter is gone");
  api.set({ status: { exclude: ["closed"] } }, { merge: true });
  assert.deepEqual(shownNames(host), ["c"], "merge keeps the qty range");
  api.set({ qty: null }, { merge: true });
  assert.deepEqual(shownNames(host), ["a", "c"], "null clears one column under merge");
  api.set({ ts: { from: "2026-08-29 09:30", to: "2026-08-30", empty: true }, qty: { to: 300 } }, { merge: true });
  assert.deepEqual(shownNames(host), ["c"], "a is before 09:30, b and d are closed");
  const got = api.get();
  assert.deepEqual(got, {
    status: { exclude: ["closed"] },
    ts: { type: "time", from: "2026-08-29T09:30", to: "2026-08-30T23:59:59", empty: true },
    qty: { type: "number", from: null, to: 300, empty: false },
  });
  // Round trip: feeding get() back yields the same view.
  api.set({});
  assert.deepEqual(shownNames(host), ["a", "b", "c", "d"]);
  api.set(got);
  assert.deepEqual(shownNames(host), ["c"], "round-tripped filters reproduce the view");
  // Interactive changes are visible through get().
  valueFilterCtl(host, "status").selectAll();
  assert.equal(api.get().status, undefined);
});

test("filters config judges stream pages and subpub snapshots by intent", async () => {
  const { host, io } = await createTable({ protocol: "stream", columns: ["name", "status"], maxcount: 2, filters: { status: ["open", "new"] } });
  triggerVisible(io);
  lastSubscribe().opts.onPage([
    { _mkio_ref: streamRef(1), name: "a", status: "open" },
    { _mkio_ref: streamRef(2), name: "b", status: "closed" },
  ], { hasmore: true, ref: "p1" });
  assert.deepEqual(shownNames(host), ["a"]);
  const [, , nextBtn] = byClass(host, "mkui-table-paging")[0]._ch;
  nextBtn._ev.click[0]();
  lastSubscribe().opts.onPage([
    { _mkio_ref: streamRef(3), name: "c", status: "new" },
    { _mkio_ref: streamRef(4), name: "d", status: "other" },
  ], { hasmore: false, ref: "p2" });
  assert.deepEqual(shownNames(host), ["c"], "the inclusion applies to the next page too");
  const sp = await createTable({ protocol: "subpub", topic: ["x", "y"], filters: { status: { exclude: ["closed"] } } });
  triggerVisible(sp.io);
  lastSubscribe().opts.onSnapshot([
    { _mkio_topic: "x", name: "x", status: "open" },
    { _mkio_topic: "y", name: "y", status: "closed" },
  ]);
  assert.deepEqual(shownNames(sp.host), ["x"]);
  lastSubscribe().opts.onSnapshot([
    { _mkio_topic: "x", name: "x", status: "closed" },
    { _mkio_topic: "y", name: "y", status: "open" },
  ]);
  assert.deepEqual(shownNames(sp.host), ["y"], "a replacing snapshot is re-filtered");
});

test("filters config uses a `types` parse format and includes empties on time ranges", async () => {
  const { host, io } = await createTable({
    protocol: "query", columns: ["name", "d"],
    types: { d: { type: "time", parse: "%d/%m/%Y %H:%M" } },
    filters: { d: { from: "2026-03-04", empty: true } },
  });
  assert.equal(filterTitle(host, "d"), "≥ 2026-03-04 00:00:00 (+ empty)", "described before any data arrives");
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot([
    { _mkio_row: "1", name: "a", d: "03/03/2026 23:59" },
    { _mkio_row: "2", name: "b", d: "04/03/2026 00:00" },
    { _mkio_row: "3", name: "c", d: "" },
    { _mkio_row: "4", name: "d", d: "garbage" },
  ]);
  assert.deepEqual(shownNames(host), ["b", "c", "d"], "parsed by the declared format; blank and unparseable pass with empty");
  const d = openDropdown(host, "d");
  assert.equal(d.lo.type, "datetime-local", "the parse format has clock fields, so the column is a date-time");
  assert.equal(d.lo.value, "2026-03-04T00:00:00", "a date bound restores as that day's midnight");
  assert.equal(d.empty.checked, true);
});

test("filters config: local-tz columns read bounds as local time; a clock bound makes a time-of-day range", async () => {
  const { host, io } = await createTable({
    protocol: "query", columns: ["name", "t", "clock"],
    types: { t: { type: "time", tz: "local" } },
    filters: { t: { from: "2026-08-29 09:30" } },
  });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot([
    { _mkio_row: "1", name: "a", t: "2026-08-29 09:00:00", clock: "08:00" },
    { _mkio_row: "2", name: "b", t: "2026-08-29 09:30:00", clock: "09:45" },
    { _mkio_row: "3", name: "c", t: "2026-08-29 10:00:00", clock: "10:15" },
  ]);
  assert.deepEqual(shownNames(host), ["b", "c"], "naive local values compare against a local bound");
  host._paneEl._filters.set({ clock: { from: "09:00", to: "10:00" } });
  assert.deepEqual(shownNames(host), ["b"], "a HH:MM bound on a clock column filters by time of day");
  assert.deepEqual(host._paneEl._filters.get(), { clock: { type: "time", from: "09:00", to: "10:00", empty: false } });
  assert.equal(filterTitle(host, "clock"), "09:00 – 10:00");
});

test("setFilters closes an open dropdown, rejects non-object maps, and keeps sort order", async () => {
  const host = await filteredTable({});
  clickHeader(getThs(host).find(t => t.dataset.col === "name"));
  clickHeader(getThs(host).find(t => t.dataset.col === "name")); // desc
  assert.deepEqual(shownNames(host), ["d", "c", "b", "a"]);
  openDropdown(host, "status");
  assert.equal(host._ch.filter(c => String(c.className).includes("mkui-filter-dropdown")).length, 1);
  const [, warned] = await withWarnings(() => host._paneEl._filters.set(["open"]));
  assert.equal(host._ch.filter(c => String(c.className).includes("mkui-filter-dropdown")).length, 0, "dropdown closed");
  assert.match(warned[0], /filters must map column names to filters/);
  assert.deepEqual(shownNames(host), ["d", "c", "b", "a"], "a rejected map leaves the view alone");
  host._paneEl._filters.set({ status: { exclude: ["closed"] } });
  assert.deepEqual(shownNames(host), ["c", "a"], "sort order survives a programmatic filter");
});

test("filters config: an exclusion of nothing and an empty list behave like the dropdown", async () => {
  let host = await filteredTable({ status: { exclude: [] } });
  assert.deepEqual(shownNames(host), ["a", "b", "c", "d"], "excluding nothing is no filter");
  assert.equal(filterTitle(host, "status"), "");
  host = await filteredTable({ status: [] });
  assert.deepEqual(shownNames(host), [], "including nothing hides everything");
  assert.equal(filterTitle(host, "status"), "0 values");
  host = await filteredTable({ qty: { include: [50, null] } });
  assert.deepEqual(shownNames(host), ["a", "d"], "non-string values are matched as cell text; null is the empty cell");
});

/* ── Sort & filter chips ─────────────────────────────────────────────── */
// The toolbar's right side lists the active sort keys and filters as chips
// so they can be seen and cleared without scrolling the header into view.
// The toolbar exists only while it has buttons or chips.

function chipStrip(host) {
  const toolbar = host._ch.find(c => String(c.className).includes("mkui-table-toolbar")) ?? null;
  const chips = toolbar?._ch.find(c => c.className === "mkui-table-chips") ?? null;
  const texts = (cls) => byClass(chips, cls).map(c => byClass(c, "mkui-chip-text")[0].textContent);
  const chipEl = (cls, col) => byClass(chips, cls).find(c => c.dataset.col === col);
  return {
    toolbar, chips,
    sort: chips ? texts("mkui-chip mkui-chip-sort") : [],
    filter: chips ? texts("mkui-chip mkui-chip-filter") : [],
    sortDirs: chips ? byClass(chips, "mkui-chip mkui-chip-sort").map(c =>
      String(c._ch[0]._ch[1]?.className).includes("caret-up") ? "asc" : "desc") : [],
    flip: (col) => chipEl("mkui-chip mkui-chip-sort", col)._ch[0]._ev.click[0](),
    dropSort: (col) => chipEl("mkui-chip mkui-chip-sort", col)._ch[1]._ev.click[0]({ stopPropagation() {} }),
    open: (col) => chipEl("mkui-chip mkui-chip-filter", col)._ch[0]._ev.click[0](),
    dropFilter: (col) => chipEl("mkui-chip mkui-chip-filter", col)._ch[1]._ev.click[0]({ stopPropagation() {} }),
    groupIcon: (cls) => byClass(chips, "mkui-chip-group " + cls)[0]?._ch[0]._ch[0] ?? null,
  };
}

test("chips: no toolbar until something is active; chips name the state and go away when cleared", async () => {
  const { host, io } = await createTable({ protocol: "query", columns: ["name", "status"], labels: { status: "Status" } });
  assert.equal(chipStrip(host).toolbar, null, "a plain table has no toolbar");
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot(orderRows());
  clickHeader(getThs(host)[0]);
  let s = chipStrip(host);
  assert.ok(s.toolbar && s.toolbar._parent === host, "sorting brings the toolbar in");
  assert.deepEqual(s.sort, ["name"]);
  assert.deepEqual(s.sortDirs, ["asc"]);
  assert.deepEqual(s.filter, []);
  assert.ok(s.groupIcon("mkui-chips-sort"), "sort group leads with its icon");
  assert.deepEqual(s.groupIcon("mkui-chips-sort")._ch.map(c => c.className),
    ["mkui-icon mkui-icon-sort", "mkui-chip-icon-x"], "the group icon wears an × badge: it clears");
  assert.equal(s.groupIcon("mkui-chips-filter"), null);
  host._paneEl._filters.set({ status: { exclude: ["closed"] } });
  s = chipStrip(host);
  assert.deepEqual(s.filter, ["Status: All but 1 values"], "the label and the header tooltip text");
  assert.equal(byClass(s.chips, "mkui-chip mkui-chip-filter")[0].title, "Status: All but 1 values");
  assert.equal(s.toolbar._ch[0], s.chips, "without buttons the chip cluster is the toolbar's only child");
  // Sort chips precede filter chips; each group's icon clears that group.
  assert.deepEqual(s.chips._ch.map(c => c.className), ["mkui-chip-group mkui-chips-sort", "mkui-chip-group mkui-chips-filter"]);
  s.groupIcon("mkui-chips-sort")._ev.click[0]();
  assert.deepEqual(shownNames(host), ["a", "c"], "sort gone, filter still on");
  chipStrip(host).groupIcon("mkui-chips-filter")._ev.click[0]();
  assert.deepEqual(shownNames(host), ["a", "b", "c", "d"], "insertion order, nothing filtered");
  assert.deepEqual(headerIcon(getThs(host)[0]), { kind: "hamburger", extra: 0 });
  assert.equal(chipStrip(host).toolbar, null, "toolbar gone again");
  assert.equal(host._ch[0].className, "mkui-table-scroll", "the scroll area is back at the top");
});

test("chips: sort chips flip on click, × drops a key, the group icon clears the sort", async () => {
  const { host, io } = await createTable({ protocol: "query", columns: ["name", "status", "qty"] });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot(orderRows());
  const [thName, thStatus] = getThs(host);
  clickHeader(thStatus);
  clickHeader(thName, { shift: true });
  let s = chipStrip(host);
  assert.deepEqual(s.sort, ["status", "name"], "priority order");
  s.flip("status");
  s = chipStrip(host);
  assert.deepEqual(s.sortDirs, ["desc", "asc"]);
  assert.deepEqual(headerIcon(thStatus), { kind: "caret-down", dir: "desc", digit: "1", extra: 0 });
  assert.deepEqual(shownNames(host), ["a", "c", "b", "d"], "open, new, closed(a-z within)");
  s.dropSort("status");
  s = chipStrip(host);
  assert.deepEqual(s.sort, ["name"]);
  assert.deepEqual(headerIcon(thName), { kind: "caret-up", dir: "asc", digit: null, extra: 0 }, "sole key loses its digit");
  assert.deepEqual(headerIcon(thStatus), { kind: "hamburger", extra: 0 });
  s.groupIcon("mkui-chips-sort")._ev.click[0]();
  assert.deepEqual(chipStrip(host).sort, []);
  assert.deepEqual(headerIcon(thName), { kind: "hamburger", extra: 0 });
  assert.equal(chipStrip(host).toolbar, null);
});

test("chips: a filter chip opens its dropdown, × clears one filter, the group icon clears all", async () => {
  const host = await filteredTable({ status: ["open", "new"], qty: { from: 100 } });
  let s = chipStrip(host);
  assert.deepEqual(s.filter, ["status: 2 values", "qty: ≥ 100"]);
  assert.deepEqual(shownNames(host), ["c"]);
  s.open("status");
  const dd = host._ch.filter(c => String(c.className).includes("mkui-filter-dropdown"));
  assert.equal(dd.length, 1, "the column's dropdown opened");
  assert.equal(byClass(dd[0], "mkui-filter-item").length, 3, "for the status column: closed, new, open");
  s.open("status");
  assert.equal(host._ch.filter(c => String(c.className).includes("mkui-filter-dropdown")).length, 0, "clicking again toggles it closed");
  s.open("qty");
  assert.equal(host._ch.filter(c => String(c.className).includes("mkui-filter-dropdown")).length, 1);
  s.dropFilter("qty");
  assert.equal(host._ch.filter(c => String(c.className).includes("mkui-filter-dropdown")).length, 0, "clearing the open column closes its dropdown");
  s = chipStrip(host);
  assert.deepEqual(s.filter, ["status: 2 values"]);
  assert.deepEqual(shownNames(host), ["a", "c"]);
  assert.equal(filterTitle(host, "qty"), "", "header button cleared too");
  host._paneEl._filters.set({ qty: { to: 100, empty: true } }, { merge: true });
  s.groupIcon("mkui-chips-filter")._ev.click[0]();
  assert.deepEqual(chipStrip(host).filter, []);
  assert.deepEqual(shownNames(host), ["a", "b", "c", "d"]);
  assert.deepEqual(host._paneEl._filters.get(), {});
});

test("chips: buttons keep the first toolbar slots and the toolbar stays when chips clear", async () => {
  const { host } = await createSelTable({
    columns: ["name", "value"],
    buttons: [{ label: "Act", action: { type: "action", name: "x" } }],
  });
  let s = chipStrip(host);
  assert.ok(s.toolbar, "buttons alone show the toolbar");
  assert.equal(s.toolbar._ch[0].className, "mkui-btn mkui-toolbar-btn");
  assert.equal(s.toolbar._ch.at(-1), s.chips, "chip cluster is the last child");
  assert.equal(s.chips._ch.length, 0, "empty until something is active");
  clickHeader(getThs(host)[1]);
  s = chipStrip(host);
  assert.equal(s.toolbar._ch[0].className, "mkui-btn mkui-toolbar-btn", "button still first");
  assert.deepEqual(s.sort, ["value"]);
  s.groupIcon("mkui-chips-sort")._ev.click[0]();
  s = chipStrip(host);
  assert.ok(s.toolbar && s.toolbar._parent === host, "toolbar remains for the buttons");
  assert.equal(s.chips._ch.length, 0);
});

test("chips: a filter chip on a column with no header yet does nothing", async () => {
  const { host } = await createTable({ protocol: "query", filters: { status: ["open"] } });
  const s = chipStrip(host);
  assert.deepEqual(s.filter, ["status: 1 values"], "configured filters show before data or header");
  s.open("status");
  assert.equal(host._ch.filter(c => String(c.className).includes("mkui-filter-dropdown")).length, 0);
});

/* ── Configured and programmatic sort ────────────────────────────────── */

test("sort config seeds the order before data and shows in header and chips", async () => {
  const { host, io } = await createTable({ protocol: "query", columns: ["name", "qty"], sort: "-qty" });
  assert.deepEqual(headerIcon(getThs(host)[1]), { kind: "caret-down", dir: "desc", digit: null, extra: 0 });
  assert.deepEqual(chipStrip(host).sort, ["qty"]);
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot(orderRows());
  assert.deepEqual(shownNames(host), ["c", "b", "a", "d"], "250, 150, 50, blank");
  lastSubscribe().opts.onUpdate("insert", { _mkio_row: "5", name: "e", qty: "200" });
  assert.deepEqual(shownNames(host), ["c", "e", "b", "a", "d"], "live inserts land at the sorted spot");
  assert.deepEqual(host._paneEl._sort.get(), [{ col: "qty", dir: "desc" }]);
});

test("sort config takes names, {col, dir}, and arrays in priority order", async () => {
  const host = await filteredTable({}, { sort: [{ col: "status" }, "-name"] });
  assert.deepEqual(shownNames(host), ["d", "b", "c", "a"], "closed (d, b desc by name), new, open");
  assert.deepEqual(host._paneEl._sort.get(), [{ col: "status", dir: "asc" }, { col: "name", dir: "desc" }]);
  assert.deepEqual(chipStrip(host).sort, ["status", "name"]);
  const [thName, thStatus] = getThs(host);
  assert.deepEqual(headerIcon(thStatus), { kind: "caret-up", dir: "asc", digit: "1", extra: 0 });
  assert.deepEqual(headerIcon(thName), { kind: "caret-down", dir: "desc", digit: "2", extra: 0 });
});

test("_sort.set replaces the order, null clears it, bad specs warn and leave it alone", async () => {
  const host = await filteredTable({});
  const api = host._paneEl._sort;
  api.set("name");
  assert.deepEqual(shownNames(host), ["a", "b", "c", "d"]);
  api.set({ col: "qty", dir: "desc" });
  assert.deepEqual(shownNames(host), ["c", "b", "a", "d"]);
  assert.deepEqual(api.get(), [{ col: "qty", dir: "desc" }]);
  let [, warned] = await withWarnings(() => api.set({ col: "qty", dir: "sideways" }));
  assert.match(warned[0], /bad sort: bad dir 'sideways'/);
  assert.deepEqual(api.get(), [{ col: "qty", dir: "desc" }], "rejected spec leaves the sort alone");
  [, warned] = await withWarnings(() => api.set(["name", "-name"]));
  assert.match(warned[0], /listed twice/);
  [, warned] = await withWarnings(() => api.set([42]));
  assert.match(warned[0], /expected a column name or \{ col, dir \}/);
  [, warned] = await withWarnings(() => api.set({ dir: "asc" }));
  assert.match(warned[0], /expected a column name/);
  api.set(null);
  assert.deepEqual(api.get(), []);
  assert.deepEqual(shownNames(host), ["a", "b", "c", "d"], "insertion order restored");
  assert.equal(chipStrip(host).toolbar, null);
  api.set([]);
  assert.deepEqual(api.get(), []);
});

test("pane reopen restores the configured sort, not the interactive one", async () => {
  const { host, io } = await createTable({ protocol: "query", columns: ["name", "qty"], sort: "-qty" });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot(orderRows());
  clickHeader(getThs(host)[0]); // sort by name instead
  assert.deepEqual(shownNames(host), ["a", "b", "c", "d"]);
  for (const fn of host._paneEl._ev["mkui-pane-close"] ?? []) fn();
  for (const fn of host._paneEl._ev["mkui-pane-open"] ?? []) fn();
  assert.deepEqual(chipStrip(host).sort, ["qty"], "chips reflect the reset before data");
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot(orderRows());
  assert.deepEqual(shownNames(host), ["c", "b", "a", "d"], "back to the config default");
  assert.deepEqual(host._paneEl._sort.get(), [{ col: "qty", dir: "desc" }]);
});

/* ── Configured and programmatic columns ─────────────────────────────── */
// `visible = [...]` picks which columns show, in that order; null (the
// default) shows every known column and follows new ones. The same shape
// drives `_columns.set/get`. The Columns button pinned to the header row
// (badge = hidden count) opens the column picker — the one place for bulk
// changes: per-column ticks, group sections with tri-state toggles,
// search-scoped Show/Hide matching, Reset to default, two-step Show all.

const headerCols = (host) => getThs(host).map(th => th.dataset.col);
const rowCols = (host) => getTbody(host)._ch[0]?._ch.map(td => td.dataset.col) ?? [];
function columnsBtn(host) {
  const anchor = sh(host)._ch.find(c => c.className === "mkui-columns-anchor");
  const btn = anchor._ch[0];
  const badge = btn._ch.find(c => c.className === "mkui-columns-badge");
  return {
    btn, badge: badge.hidden ? null : badge.textContent, title: btn.title, disabled: btn.disabled,
    active: btn.classList.contains("active"),
    click: () => btn._ev.click[0]({ stopPropagation() {} }),
  };
}
function pickerOf(host) {
  const dd = host._ch.filter(c => String(c.className).includes("mkui-columns-picker")).at(-1) ?? null;
  if (!dd) return null;
  const cbs = byClass(dd, "mkui-filter-item").map(l => l._ch[0]);
  const actions = byClass(dd, "mkui-filter-actions mkui-columns-actions")[0];
  const [showEl, hideEl, resetEl] = actions._ch;
  const groups = byClass(dd, "mkui-columns-group").map(g => {
    const head = g._ch[0], body = g._ch[1];
    return {
      el: g, head, body, cb: head._ch[1], label: head._ch[2].textContent,
      get count() { return head._ch[3].textContent; },
      get open() { return !body.hidden; },
      get shown() { return g.style.display !== "none"; },
      toggle: () => { head._ch[1].checked = !head._ch[1].checked; head._ch[1]._ev.change[0](); },
      fold: () => head._ev.click[0]({ target: head }),
    };
  });
  const act = (el) => el._ev.click[0]();
  const off = (el) => el.classList.contains("mkui-filter-action-off");
  return {
    dd, cbs, groups, actions,
    get title() { return byClass(dd, "mkui-columns-title")[0].textContent; },
    // The actions row: [Show all | Show N matching, Hide all | Hide N matching, Reset].
    texts: () => actions._ch.map(e => e.textContent),
    state: () => cbs.map(cb => [cb.dataset.col, cb.checked]),
    visibleItems: () => cbs.filter(cb => cb._parent.style.display !== "none").map(cb => cb.dataset.col),
    toggle: (col) => { const cb = cbs.find(c => c.dataset.col === col); cb.checked = !cb.checked; cb._ev.change[0](); },
    group: (label) => groups.find(g => g.label === label),
    reset: () => act(resetEl), resetOff: () => off(resetEl),
    showAll: () => act(showEl), showAllText: () => showEl.textContent, showAllOff: () => off(showEl),
    hideAll: () => act(hideEl), hideAllText: () => hideEl.textContent, hideAllOff: () => off(hideEl),
    showMatching: () => act(showEl), hideMatching: () => act(hideEl),
    search: (q) => { const s = byClass(dd, "mkui-filter-search")[0]; s.value = q; s._ev.input[0](); },
  };
}
function colOps(host, col) {
  const { dd } = openDropdown(host, col);
  const ops = dd._ch.find(c => c.className === "mkui-filter-actions mkui-filter-colops");
  return { hide: ops._ch[0], extra: ops._ch.length - 1, ops, dd };
}
const noDropdown = (host) => host._ch.filter(c => String(c.className).includes("mkui-filter-dropdown")).length === 0;

test("visible config shows only those columns, in that order, before and after data", async () => {
  const { host, io } = await createTable({ protocol: "query", columns: ["name", "status", "qty", "ts"], visible: ["qty", "name"] });
  assert.deepEqual(headerCols(host), ["qty", "name"], "header rendered from `columns` already honours it");
  assert.equal(columnsBtn(host).badge, "2", "badge counts hidden columns");
  assert.equal(columnsBtn(host).title, "Columns: 2 of 4 shown");
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot(orderRows());
  assert.deepEqual(rowCols(host), ["qty", "name"]);
  assert.deepEqual(host._paneEl._columns.get(), ["qty", "name"]);
  assert.equal(getColgroup(host)._ch.length, 3, "two data cols plus the filler");
  assert.equal(getRawTbody(host)._ch[0]._ch[0].colSpan, 3, "spacer spans the visible columns");
});

test("the Columns button is always there: disabled before columns, no badge while all show", async () => {
  const { host, io } = await createTable({ protocol: "query" });
  let b = columnsBtn(host);
  assert.equal(b.disabled, true, "nothing to pick from yet");
  assert.equal(b.badge, null);
  b.click();
  assert.equal(pickerOf(host), null, "no picker without columns");
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot(orderRows());
  b = columnsBtn(host);
  assert.equal(b.disabled, false);
  assert.equal(b.badge, null, "all columns show: no badge");
  assert.equal(b.active, false);
  assert.equal(b.title, "Columns: 4 of 4 shown");
  assert.equal(chipStrip(host).toolbar, null, "hidden columns never create a toolbar");
  b.click();
  assert.ok(pickerOf(host), "opens the picker");
  assert.equal(pickerOf(host).title, "Columns · 4 of 4 shown");
  b.click();
  assert.equal(pickerOf(host), null, "toggles it closed");
});

test("visible: a name ahead of the data is kept and appears once the data carries it", async () => {
  const [{ host, io }, warned] = await withWarnings(() =>
    createTable({ protocol: "query", visible: ["name", "later"] }));
  assert.deepEqual(warned, [], "without `columns` nothing can be checked, so nothing warns");
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot(orderRows());
  assert.deepEqual(headerCols(host), ["name"], "unknown name is skipped, not rendered empty");
  assert.deepEqual(host._paneEl._columns.get(), ["name", "later"], "…but stays in the list");
  assert.equal(columnsBtn(host).badge, "3");
  const [, w2] = await withWarnings(() =>
    createTable({ protocol: "query", columns: ["name", "qty"], visible: ["name", "nope"] }));
  assert.match(w2[0], /visible: 'nope' is not in columns/);
});

test("_columns.set replaces the set; null, \"\" and [] mean all; bad specs warn and leave it alone", async () => {
  const host = await filteredTable({});
  const api = host._paneEl._columns;
  assert.equal(api.get(), null, "default state is null, not a full list");
  api.set("status");
  assert.deepEqual(headerCols(host), ["status"]);
  assert.deepEqual(rowCols(host), ["status"]);
  assert.equal(columnsBtn(host).badge, "3");
  api.set(["ts", "name"]);
  assert.deepEqual(headerCols(host), ["ts", "name"]);
  assert.deepEqual(api.get(), ["ts", "name"]);
  let [, warned] = await withWarnings(() => api.set(["name", "name"]));
  assert.match(warned[0], /bad visible: column 'name' listed twice/);
  assert.deepEqual(api.get(), ["ts", "name"], "rejected spec leaves the set alone");
  [, warned] = await withWarnings(() => api.set([42]));
  assert.match(warned[0], /expected a column name/);
  [, warned] = await withWarnings(() => api.set({ col: "name" }));
  assert.match(warned[0], /expected a column name/);
  for (const all of [null, "", []]) {
    api.set(["qty"]);
    api.set(all);
    assert.equal(api.get(), null, `${JSON.stringify(all)} means all`);
    assert.deepEqual(headerCols(host), ["name", "status", "qty", "ts"]);
    assert.deepEqual(rowCols(host), ["name", "status", "qty", "ts"]);
  }
  assert.equal(columnsBtn(host).badge, null);
});

test("header dropdown hides the column (never the last); the picker ticks columns back into place", async () => {
  const host = await filteredTable({});
  const ops = colOps(host, "status");
  assert.equal(ops.extra, 0, "only Hide column");
  ops.hide._ev.click[0]();
  assert.deepEqual(headerCols(host), ["name", "qty", "ts"]);
  assert.ok(noDropdown(host), "hiding closes the dropdown");
  assert.deepEqual(host._paneEl._columns.get(), ["name", "qty", "ts"], "hiding materialises the list");
  colOps(host, "ts").hide._ev.click[0]();
  colOps(host, "qty").hide._ev.click[0]();
  assert.deepEqual(headerCols(host), ["name"]);
  const last = colOps(host, "name");
  assert.ok(last.hide.classList.contains("mkui-filter-action-off"), "the last column's Hide is inert");
  assert.equal(last.hide._ev.click, undefined);
  assert.equal(columnsBtn(host).badge, "3");

  columnsBtn(host).click();
  assert.ok(noDropdown(host) === false && pickerOf(host), "picker open");
  assert.equal(host._ch.filter(c => c.className === "mkui-filter-dropdown").length, 0, "…and the filter dropdown closed");
  const p = pickerOf(host);
  assert.equal(p.groups.length, 0, "flat list without groups");
  assert.deepEqual(p.state(), [["name", true], ["status", false], ["qty", false], ["ts", false]], "every column in config order");
  assert.equal(p.title, "Columns · 1 of 4 shown");
  p.toggle("qty");
  assert.deepEqual(headerCols(host), ["name", "qty"], "shown before ts, after name — where it came from");
  assert.equal(pickerOf(host).dd, p.dd, "picker survives the re-render");
  assert.deepEqual(p.state(), [["name", true], ["status", false], ["qty", true], ["ts", false]]);
  assert.equal(p.title, "Columns · 2 of 4 shown");
  p.toggle("name"); p.toggle("qty");
  assert.deepEqual(headerCols(host), ["qty"], "unticking the last visible column is refused");
  assert.deepEqual(p.state()[2], ["qty", true], "…and its box snaps back");
});

test("search narrows the list and offers Show / Hide N matching, scoped to the matches", async () => {
  const host = await filteredTable({}, { labels: { qty: "Quantity" }, visible: ["name"] });
  columnsBtn(host).click();
  const p = pickerOf(host);
  assert.deepEqual(p.texts(), ["Show all", "Hide all", "Reset"], "the filter dropdown's row, for columns");
  p.search("t");
  assert.deepEqual(p.visibleItems(), ["status", "qty", "ts"], "matches labels (Quantity) and names");
  assert.deepEqual(p.texts(), ["Show 3 matching", "Hide 0 matching", "Reset"], "a query scopes the first two");
  assert.equal(p.hideAllOff(), true);
  p.showMatching();
  assert.deepEqual(headerCols(host), ["name", "status", "qty", "ts"], "all three shown, in place");
  assert.deepEqual(p.texts(), ["Show 0 matching", "Hide 3 matching", "Reset"]);
  p.hideMatching();
  assert.deepEqual(headerCols(host), ["name"]);
  p.search("");
  assert.deepEqual(p.texts(), ["Show all", "Hide all", "Reset"]);
  assert.deepEqual(p.visibleItems(), ["name", "status", "qty", "ts"]);
  p.search("zzz");
  assert.deepEqual(p.visibleItems(), []);
  assert.deepEqual(p.texts(), ["Show 0 matching", "Hide 0 matching", "Reset"]);
  host._paneEl._columns.set(null);
  p.search("");
  p.search("a");
  p.hideMatching(); // name, status, Quantity match: hides all three
  assert.deepEqual(headerCols(host), ["ts"]);
  host._paneEl._columns.set(["qty"]);
  p.search("q");
  p.hideMatching();
  assert.deepEqual(headerCols(host), ["qty"], "hiding every visible column keeps the first");
});

test("Reset returns to the configured list; Hide all keeps one column; Show all takes a click and a confirm", async () => {
  const host = await filteredTable({}, { visible: ["name", "qty"] });
  columnsBtn(host).click();
  const p = pickerOf(host);
  assert.equal(p.resetOff(), true, "already at the default");
  assert.equal(p.showAllText(), "Show all");
  assert.equal(p.hideAllOff(), false);
  p.hideAll();
  assert.deepEqual(headerCols(host), ["name"], "Hide all keeps the first visible column");
  assert.equal(p.hideAllOff(), true, "…and is then inert");
  assert.equal(p.title, "Columns · 1 of 4 shown");
  p.reset();
  assert.deepEqual(headerCols(host), ["name", "qty"]);
  p.toggle("status");
  assert.deepEqual(headerCols(host), ["name", "status", "qty"]);
  assert.equal(p.resetOff(), false);
  p.reset();
  assert.deepEqual(headerCols(host), ["name", "qty"]);
  assert.deepEqual(host._paneEl._columns.get(), ["name", "qty"]);
  assert.equal(p.resetOff(), true);
  // Show all: first click arms, times out; click twice to apply.
  p.showAll();
  assert.equal(p.showAllText(), "Show all 4? Confirm");
  assert.deepEqual(headerCols(host), ["name", "qty"], "one click changes nothing");
  advanceTimers();
  assert.equal(p.showAllText(), "Show all", "unconfirmed, it disarms");
  p.showAll();
  p.search("q");
  assert.equal(p.showAllText(), "Show 0 matching", "typing a query disarms too");
  p.search("");
  assert.equal(p.showAllText(), "Show all");
  p.showAll(); p.showAll();
  assert.deepEqual(headerCols(host), ["name", "status", "qty", "ts"]);
  assert.equal(host._paneEl._columns.get(), null, "Show all returns to the default state");
  assert.equal(p.showAllOff(), true, "and is inert while everything shows");
  assert.equal(p.showAllText(), "Show all");
  assert.equal(columnsBtn(host).badge, null);
  p.reset();
  assert.deepEqual(headerCols(host), ["name", "qty"], "reset works from all too");
});

test("a filter chip on a hidden column shows it first", async () => {
  const host = await filteredTable({ status: ["open"] }, { visible: ["name", "qty"] });
  assert.deepEqual(shownNames(host), ["a"], "a filter on a hidden column still filters");
  assert.deepEqual(chipStrip(host).filter, ["status: 1 values"]);
  chipStrip(host).open("status");
  assert.deepEqual(headerCols(host), ["name", "status", "qty"], "status came back at its place");
  assert.equal(host._ch.filter(c => c.className === "mkui-filter-dropdown").length, 1, "…and its dropdown opened");
});

test("reorder then hide keeps the order; a restored column attaches to its config neighbour", async () => {
  const host = await filteredTable({});
  const api = host._paneEl._columns;
  api.set(["qty", "name", "status", "ts"]); // as a header drag would leave it
  colOps(host, "status").hide._ev.click[0]();
  assert.deepEqual(api.get(), ["qty", "name", "ts"]);
  columnsBtn(host).click();
  pickerOf(host).toggle("status");
  assert.deepEqual(api.get(), ["qty", "name", "status", "ts"], "after name, its nearest preceding config neighbour");
  colOps(host, "qty").hide._ev.click[0]();
  columnsBtn(host).click();
  pickerOf(host).toggle("qty");
  assert.deepEqual(api.get(), ["name", "status", "qty", "ts"], "no visible predecessor: before its nearest follower");
});

test("hidden columns keep sorting and filtering; only visible cells render and copy", async () => {
  const host = await filteredTable({}, { sort: "-qty", visible: ["name"] });
  assert.deepEqual(shownNames(host), ["c", "b", "a", "d"], "sort on a hidden column applies");
  assert.deepEqual(chipStrip(host).sort, ["qty"]);
  assert.deepEqual(rowCols(host), ["name"]);
  assert.equal(getColgroup(host)._ch.length, 2);
});

test("column widths survive hide/show; a first-shown column is measured", async () => {
  const { host, io } = await createTable({ protocol: "query", columns: ["name", "qty"], visible: ["name"] });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot(orderRows());
  flushRaf();
  const api = host._paneEl._columns;
  const nameW = getColgroup(host)._ch[0].style.width;
  api.set(["name", "qty"]);
  flushRaf();
  const cols = getColgroup(host)._ch;
  assert.equal(cols[0].style.width, nameW, "name keeps its width");
  assert.ok(parseInt(cols[1].style.width) >= 100, `qty measured from its header (${cols[1].style.width})`);
  api.set(["qty"]);
  api.set(["name", "qty"]);
  assert.equal(getColgroup(host)._ch[0].style.width, nameW, "hidden then shown: same width");
});

test("pane reopen restores the configured columns, not the interactive set", async () => {
  const { host, io } = await createTable({ protocol: "query", columns: ["name", "qty", "ts"], visible: ["name", "qty"] });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot(orderRows());
  host._paneEl._columns.set(null);
  assert.deepEqual(headerCols(host), ["name", "qty", "ts"]);
  columnsBtn(host).click();
  assert.ok(pickerOf(host));
  for (const fn of host._paneEl._ev["mkui-pane-close"] ?? []) fn();
  assert.equal(pickerOf(host), null, "closing the pane drops the picker");
  for (const fn of host._paneEl._ev["mkui-pane-open"] ?? []) fn();
  assert.deepEqual(headerCols(host), ["name", "qty"], "back to the config default before data");
  assert.equal(columnsBtn(host).badge, "1");
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot(orderRows());
  assert.deepEqual(rowCols(host), ["name", "qty"]);
});

/* ── Column groups ────────────────────────────────────────────────────── */
// `groups = [{ label, columns }, …]` categorises columns for the picker
// (and nothing else): sections with tri-state toggles, an implicit "Other"
// for the rest, and — without `columns` — a display order that follows
// the groups. The header dropdown stays per-column.

const GROUPS = [{ label: "Who", columns: ["name", "status"] }, { label: "Numbers", columns: ["qty", "later"] }];
const wideRows = () => orderRows().map((r, i) => ({ ...r, extra: `x${i}` }));
async function groupedTable(extra = {}) {
  const { host, io } = await createTable({ protocol: "query", groups: GROUPS, ...extra });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot(wideRows());
  return host;
}

test("groups: bad entries warn and are dropped, a column in two groups keeps the first", async () => {
  const [, warned] = await withWarnings(() => createTable({ protocol: "query", groups: [
    { label: "A", columns: ["name"] },
    { columns: ["qty"] },
    { label: "B", columns: ["name", "qty", 3] },
    { label: "A", columns: ["ts"] },
    { label: "C", columns: ["name", "ts"] },
  ] }));
  assert.deepEqual(warned, [
    "[mkio-table] bad groups[1]: expected { label, columns }",
    "[mkio-table] groups: 'name' is already in a group",
    "[mkio-table] bad groups[2]: expected column names",
    "[mkio-table] bad groups[3]: label 'A' used twice",
    "[mkio-table] groups: 'name' is already in a group",
  ]);
  const [, w2] = await withWarnings(() => createTable({ protocol: "query", groups: { A: ["name"] } }));
  assert.deepEqual(w2, ["[mkio-table] bad groups: expected an array of { label, columns }"]);
});

test("groups order inferred columns; the picker sections them with an implicit Other", async () => {
  const host = await groupedTable();
  assert.deepEqual(headerCols(host), ["name", "status", "qty", "ts", "extra"], "grouped first in group order, then the rest as the data had them");
  columnsBtn(host).click();
  const p = pickerOf(host);
  assert.deepEqual(p.groups.map(g => [g.label, g.count, g.open]), [["Who", "2 of 2", true], ["Numbers", "1 of 1", true], ["Other", "2 of 2", true]],
    "`later` is not in the data, so Numbers has one column; ungrouped columns form Other");
  assert.deepEqual(p.state().map(([c]) => c), ["name", "status", "qty", "ts", "extra"]);
  // Configured `columns` wins over group order.
  const host2 = await groupedTable({ columns: ["ts", "qty", "name", "status", "extra"] });
  assert.deepEqual(headerCols(host2), ["ts", "qty", "name", "status", "extra"]);
});

test("group toggles show or hide the whole group; sections collapse unless they hold a shown column", async () => {
  const host = await groupedTable({ visible: ["name", "ts"] });
  columnsBtn(host).click();
  let p = pickerOf(host);
  assert.deepEqual(p.groups.map(g => [g.label, g.count, g.cb.checked, g.cb.indeterminate, g.open]), [
    ["Who", "1 of 2", false, true, true],
    ["Numbers", "0 of 1", false, false, false],
    ["Other", "1 of 2", false, true, true],
  ]);
  p.group("Numbers").toggle();
  assert.deepEqual(headerCols(host), ["name", "qty", "ts"], "qty shown in place");
  assert.deepEqual(p.group("Numbers").cb.checked, true);
  assert.equal(p.group("Numbers").open, false, "showing through the toggle doesn't unfold the section");
  p.group("Who").toggle();
  assert.deepEqual(headerCols(host), ["name", "status", "qty", "ts"], "an indeterminate group ticks to all shown");
  p.group("Who").toggle();
  assert.deepEqual(headerCols(host), ["qty", "ts"], "…and unticks to all hidden");
  assert.equal(p.title, "Columns · 2 of 5 shown");
  p.group("Numbers").fold();
  assert.equal(pickerOf(host).group("Numbers").open, true, "click on the head unfolds");
  columnsBtn(host).click(); columnsBtn(host).click();
  p = pickerOf(host);
  assert.equal(p.group("Numbers").open, true, "fold state is remembered across opens");
  p.search("nu");
  assert.deepEqual(p.groups.map(g => [g.label, g.shown, g.open]), [["Who", false, true], ["Numbers", true, true], ["Other", false, true]],
    "a group label match keeps the whole group; others hide; matches unfold");
  assert.deepEqual(p.visibleItems(), ["qty"]);
  p.search("t");
  assert.deepEqual(p.visibleItems(), ["status", "qty", "ts", "extra"]);
  assert.deepEqual(p.texts(), ["Show 2 matching", "Hide 2 matching", "Reset"]);
  p.search("");
  assert.equal(p.group("Who").open, true, "the query's unfolding is gone; Who keeps its remembered (open) state");
  assert.equal(p.group("Numbers").open, true);
  // Hide every group: the last visible column stays.
  p.group("Numbers").toggle();
  assert.deepEqual(headerCols(host), ["ts"]);
  p.group("Other").toggle();
  assert.deepEqual(headerCols(host), ["ts", "extra"], "indeterminate Other ticks to all shown");
  p.group("Other").toggle();
  assert.deepEqual(headerCols(host), ["ts"], "…unticks to hidden, but the last column stays");
});

test("the header dropdown never controls other columns, grouped or not", async () => {
  const host = await groupedTable();
  assert.equal(colOps(host, "qty").extra, 0, "grouped column: still only Hide column");
  assert.equal(colOps(host, "extra").extra, 0);
  colOps(host, "qty").hide._ev.click[0]();
  assert.deepEqual(headerCols(host), ["name", "status", "ts", "extra"], "hides just that column");
});

/* ── Dropdown list sizing ─────────────────────────────────────────────── */
// Value and column lists open at content height, capped so the dropdown
// ends inside the viewport; a height the user dragged is kept per kind.

test("lists are uncapped without a viewport, capped to the viewport with one, and remember a dragged height", async () => {
  const host = await filteredTable({});
  // No viewport in the harness: no cap, no height.
  let dd = openDropdown(host, "status");
  assert.equal(dd.list.style.maxHeight, "");
  columnsBtn(host).click();
  let p = pickerOf(host);
  const plist = byClass(p.dd, "mkui-filter-list")[0];
  assert.equal(plist.style.maxHeight, "");
  // With a viewport the mock rects (bottom 20) overflow a 10px window: the
  // cap floors at the minimum height rather than collapsing.
  globalThis.innerHeight = 10;
  try {
    dd = openDropdown(host, "status");
    assert.equal(dd.list.style.maxHeight, "40px");
    // A tall viewport leaves the content height as the cap — the mocked
    // 20px, floored at the list's minimum. (Opening another column: the
    // same button would toggle the dropdown closed.)
    globalThis.innerHeight = 1000;
    dd = openDropdown(host, "qty");
    assert.equal(dd.list.style.maxHeight, "40px");
    // Drag (the browser writes an inline height), close, reopen: kept, clamped to the cap.
    dd.list.style.height = "150px";
    dd = openDropdown(host, "status");
    assert.equal(dd.list.style.height, "40px", "remembered 150 clamped to the cap");
    columnsBtn(host).click();
    p = pickerOf(host);
    assert.equal(byClass(p.dd, "mkui-filter-list")[0].style.height, "", "kinds are remembered separately");
    byClass(p.dd, "mkui-filter-list")[0].style.height = "12px";
    columnsBtn(host).click(); columnsBtn(host).click();
    assert.equal(byClass(pickerOf(host).dd, "mkui-filter-list")[0].style.height, "12px");
  } finally {
    delete globalThis.innerHeight;
  }
});

test("copy, cell rects, and the drag ghost see only visible columns", async () => {
  const { host } = await createSelTable({ visible: ["value"] });
  const trs = dataRows(host);
  pointerDown(trs[0], 0);
  pointerDown(trs[1], 0, { shiftKey: true });
  let written = null;
  globalThis.navigator = { clipboard: { writeText: (s) => { written = s; } } };
  try { assert.equal(host._paneEl._editActions.copy(), true); }
  finally { delete globalThis.navigator; }
  assert.equal(written, "value\r\n0\r\n1", "row copy spans the visible column only");
  host._paneEl._columns.set(null);
  globalThis.navigator = { clipboard: { writeText: (s) => { written = s; } } };
  try { host._paneEl._editActions.copy(); }
  finally { delete globalThis.navigator; }
  assert.equal(written, "name\tvalue\r\nrow-0\t0\r\nrow-1\t1", "the selection survives showing a column");
});
