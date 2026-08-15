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

const { getPaneType, registerFormatter } = await import("../mkui/static/src/core.js");
await import("../mkui/static/src/widgets/mkio-table.js");

const factory = getPaneType("mkio-table");

/* ── Helpers ──────────────────────────────────────────────────────────── */

function makeState(init) {
  const store = new Map(init);
  const subs = new Map();
  const nWrites = new Map();
  return {
    get: (k) => store.get(k),
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
  host._clientWidth = 150;
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
  host._clientHeight = 200; // 10 rows @ 20px, +10 overscan
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot(makeRows(100));
  assert.equal(getTbody(host)._ch.length, 20, "10 visible + 10 overscan");
  const [top, bottom] = spacerHeights(host);
  assert.equal(top, "0px");
  assert.equal(bottom, 80 * 20 + "px", "spacer stands in for the other 80 rows");
});

test("scrolling re-slices the rendered window", async () => {
  const { host, io } = await createTable({ protocol: "query" });
  host._clientHeight = 200;
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot(makeRows(100));

  host.scrollTop = 1000; // rows 50-60 in view
  for (const fn of host._ev.scroll ?? []) fn();

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
  host._clientHeight = 200;
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot(makeRows(100000));
  flushRaf();
  assert.equal(getTbody(host)._ch.length, 20, "only the visible slice exists in the DOM");
  const [, bottom] = spacerHeights(host);
  assert.equal(bottom, (100000 - 20) * 20 + "px");
});

test("virtualized rows preserve live update semantics", async () => {
  const { host, io } = await createTable({ protocol: "query" });
  host._clientHeight = 200;
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
  keyDown(host, "ArrowDown");                     // place cursor on carol
  keyDown(host, "ArrowDown", { shiftKey: true }); // rect carol..alice
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
  keyDown(host, "ArrowDown");
  assert.ok(trs[0]._ch[1].classList.contains("mkui-cell-focus"), "cursor placed at first cell");
  keyDown(host, "ArrowDown");
  keyDown(host, "ArrowRight");
  assert.ok(trs[1]._ch[2].classList.contains("mkui-cell-focus"));
  assert.ok(!trs[0]._ch[1].classList.contains("mkui-cell-focus"));
});

test("shift+arrow extends a cell rect from the anchor", async () => {
  const { host } = await createSelTable();
  const trs = dataRows(host);
  pointerDown(trs[0], 1);
  keyDown(host, "ArrowDown", { shiftKey: true });
  keyDown(host, "ArrowRight", { shiftKey: true });
  for (let r = 0; r <= 1; r++)
    for (let c = 1; c <= 2; c++)
      assert.ok(trs[r]._ch[c].classList.contains("mkui-cell-sel"));
});

test("space selects the focused row; ctrl+space toggles more rows in", async () => {
  const { host } = await createSelTable();
  const trs = dataRows(host);
  pointerDown(trs[1], 1);
  keyDown(host, " ");
  assert.ok(trs[1].classList.contains("mkui-selected"));
  keyDown(host, "ArrowDown");
  // plain arrow cleared the row selection (back to cell mode)
  assert.ok(!trs[1].classList.contains("mkui-selected"));
  keyDown(host, " ");
  keyDown(host, "ArrowUp");
  assert.ok(!trs[2].classList.contains("mkui-selected"));
});

test("shift+arrow in row mode grows the row range", async () => {
  const { host } = await createSelTable();
  const trs = dataRows(host);
  pointerDown(trs[0], 0);
  keyDown(host, "ArrowDown", { shiftKey: true });
  keyDown(host, "ArrowDown", { shiftKey: true });
  assert.ok(trs[0].classList.contains("mkui-selected"));
  assert.ok(trs[1].classList.contains("mkui-selected"));
  assert.ok(trs[2].classList.contains("mkui-selected"));
  keyDown(host, "ArrowUp", { shiftKey: true });
  assert.ok(!trs[2].classList.contains("mkui-selected"), "range shrinks back");
});

test("Home/End jump columns; ctrl+End jumps to the last cell", async () => {
  const { host } = await createSelTable();
  const trs = dataRows(host);
  pointerDown(trs[1], 2);
  keyDown(host, "Home");
  assert.ok(trs[1]._ch[1].classList.contains("mkui-cell-focus"));
  keyDown(host, "End", { ctrlKey: true });
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
  keyDown(host, " ", { shiftKey: true });
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

/* ── Column formatters ────────────────────────────────────────────────── */

registerFormatter("shout", (v) => String(v ?? "").toUpperCase());
registerFormatter("double", (v) => Number(v) * 2);
// Virtual column: no row carries "combo"; it exists only in config.
registerFormatter("combo", (_v, row) => `${row.name}:${row.value}`);

function cellsOf(tr) {
  return tr._ch.filter(td => td.dataset?.col != null).map(td => td.textContent);
}

async function createFmtTable(specOverrides = {}) {
  const t = await createTable(specOverrides);
  triggerVisible(t.io);
  lastSubscribe().opts.onSnapshot(makeRows(3));
  return t;
}

test("formatter transforms a column's displayed text", async () => {
  const { host } = await createFmtTable({
    columns: ["name", "value"], formatters: { name: "shout" },
  });
  assert.deepEqual(cellsOf(dataRows(host)[0]), ["ROW-0", "0"]);
});

test("columns without a formatter are untouched", async () => {
  const { host } = await createFmtTable({
    columns: ["name", "value"], formatters: { name: "shout" },
  });
  assert.deepEqual(cellsOf(dataRows(host)[1]), ["ROW-1", "1"]);
});

test("formatter can create a virtual column absent from the row data", async () => {
  const { host } = await createFmtTable({
    columns: ["name", "combo"], formatters: { combo: "combo" },
  });
  assert.deepEqual(cellsOf(dataRows(host)[2]), ["row-2", "row-2:2"]);
});

test("unknown formatter falls back to the raw value", async () => {
  const { host } = await createFmtTable({
    columns: ["name"], formatters: { name: "does-not-exist" },
  });
  assert.deepEqual(cellsOf(dataRows(host)[0]), ["row-0"]);
});

test("formatted values drive sorting, not the raw ones", async () => {
  // Raw ascending is 0,1,2; doubling keeps that order, so sort descending
  // and assert the formatted text to prove the comparator saw the doubles.
  const { host } = await createFmtTable({
    columns: ["value"], formatters: { value: "double" },
  });
  const th = getThead(host)._ch[0]._ch.find(t => t.dataset.col === "value");
  clickHeader(th);                           // asc
  assert.deepEqual(dataRows(host).map(tr => cellsOf(tr)[0]), ["0", "2", "4"]);
  clickHeader(th);                           // desc
  assert.deepEqual(dataRows(host).map(tr => cellsOf(tr)[0]), ["4", "2", "0"]);
});

test("filter dropdown lists formatted values", async () => {
  const { host } = await createFmtTable({
    columns: ["name"], formatters: { name: "shout" },
  });
  const th = getThead(host)._ch[0]._ch.find(t => t.dataset.col === "name");
  clickFilterBtn(th);
  const dd = host._ch.find(c => String(c.className).includes("mkui-filter-dropdown"));
  const vals = dd._ch.find(c => c.className === "mkui-filter-list")._ch
    .map(item => item._ch.find(n => n.tagName === "INPUT").dataset.val);
  assert.deepEqual(vals.sort(), ["ROW-0", "ROW-1", "ROW-2"]);
});

test("filtering matches on the formatted value", async () => {
  const { host } = await createFmtTable({
    columns: ["name"], formatters: { name: "shout" },
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

test("copy exports formatted values", async () => {
  const { host } = await createTable({
    rowColumn: true, columns: ["name"], formatters: { name: "shout" },
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

test("live update re-runs the formatter", async () => {
  const { host } = await createFmtTable({
    columns: ["name"], formatters: { name: "shout" },
  });
  lastSubscribe().opts.onUpdate("update", { _mkio_row: "1", name: "renamed", value: 1 });
  assert.deepEqual(dataRows(host).map(tr => cellsOf(tr)[0]),
                   ["ROW-0", "RENAMED", "ROW-2"]);
});

test("a formatter is called with the raw value, its row, and the column", async () => {
  const seen = [];
  registerFormatter("probe", (v, row, col) => { seen.push([v, row.name, col]); return v; });
  await createFmtTable({ columns: ["value"], formatters: { value: "probe" } });
  assert.deepEqual(seen[0], [0, "row-0", "value"]);
});

test("formatted numbers drive decimal alignment, not the raw ones", async () => {
  // Raw 1 / 2.5 / 3.25 would pad 3ch / 1ch / none; doubled to 2 / 5 / 6.5 the
  // column's widest fraction is one digit, so the integers pad 2ch instead.
  const { host, io } = await createTable({
    columns: ["value"], formatters: { value: "double" },
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

test("a formatter that yields text turns off numeric alignment", async () => {
  registerFormatter("millis", (v) => `${v} ms`);
  const { host } = await createFmtTable({
    columns: ["value"], formatters: { value: "millis" },
  });
  const tds = colCells(host, "value");
  assert.deepEqual(tds.map(td => td.textContent), ["0 ms", "1 ms", "2 ms"]);
  assert.ok(tds.every(td => !td.classList.contains("mkui-num")), "text column, no alignment");
});

test("cell-mode copy exports the formatted value", async () => {
  const { host } = await createSelTable({
    columns: ["name", "value"], formatters: { name: "shout" },
  });
  pointerDown(dataRows(host)[1], 1);          // focused cell = name of row-1
  let written = null;
  globalThis.navigator = { clipboard: { writeText: (s) => { written = s; } } };
  try { host._paneEl._editActions.copy(); }
  finally { delete globalThis.navigator; }
  assert.equal(written, "ROW-1");
});

test("row-unit button payloads carry the raw field, not the formatted one", async () => {
  const { host } = await createSelTable({
    columns: ["name", "value"], formatters: { name: "shout" },
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
    columns: ["name", "value"], formatters: { name: "shout" },
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
  keyDown(host, "ArrowDown");                // first press only places the cursor
  assert.equal(state.get("current").name, "row-0");
  keyDown(host, "ArrowDown");
  assert.equal(state.get("current").name, "row-1");
});

test("select writes only when the tracked row changes", async () => {
  const { host, state } = await createSelTable({ select: { state: "current" } });
  pointerDown(dataRows(host)[1], 0);
  const before = state.writes("current");
  pointerDown(dataRows(host)[1], 0);         // same row again
  assert.equal(state.writes("current"), before, "re-selecting the same row is a no-op");
});
