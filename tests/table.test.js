// Run with: node --test tests/table.test.js
//
// mkio-table is a browser component so we provide lightweight DOM stubs
// before importing the module.  No jsdom dependency needed.
import { test } from "node:test";
import assert from "node:assert/strict";

/* ── Minimal browser globals ──────────────────────────────────────────── */

function mockEl(tag) {
  const el = {
    tagName: tag?.toUpperCase() ?? "",
    className: "", textContent: "", disabled: false,
    type: "", placeholder: "",
    style: new Proxy({}, { set(t, p, v) { t[p] = v; return true; }, get(t, p) { return t[p] ?? ""; } }),
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
    append(...ns) { for (const n of ns) el._ch.push(n); },
    appendChild(n) { el._ch.push(n); return n; },
    insertBefore(n, ref) {
      const items = n.tagName === "FRAGMENT" ? n._ch.splice(0) : [n];
      const i = el._ch.indexOf(ref);
      if (i >= 0) el._ch.splice(i, 0, ...items); else el._ch.push(...items);
      return n;
    },
    remove() {},
    replaceWith() {},
    addEventListener(e, fn) { (el._ev[e] ??= []).push(fn); },
    removeEventListener() {},
    querySelector(sel) {
      const m = sel.match(/\[data-col="([^"]+)"\]/);
      if (m) return el._ch.find(c => c.dataset?.col === m[1]) ?? null;
      if (sel.startsWith(".")) {
        const cls = sel.slice(1);
        return el._ch.find(c => c.className?.includes(cls)) ?? null;
      }
      return null;
    },
    querySelectorAll() { return []; },
    closest() { return null; },
    contains() { return false; },
    getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 }; },
    dispatchEvent() {},
    focus() {},
    get children() { return el._ch; },
    get offsetWidth() { return 100; },
  };

  let _ih = "";
  Object.defineProperty(el, "innerHTML", {
    get() { return _ih; },
    set(v) { _ih = v; if (v === "") el._ch.length = 0; },
  });

  let _st = 0;
  Object.defineProperty(el, "scrollTop", {
    get() { return _st; },
    set(v) { _st = v; },
  });

  return el;
}

globalThis.document = {
  createElement: (tag) => mockEl(tag),
  createTextNode: (text) => ({ textContent: text, nodeType: 3 }),
  createDocumentFragment() {
    const frag = mockEl("fragment");
    frag.firstChild = null;
    Object.defineProperty(frag, "firstChild", { get() { return frag._ch[0] ?? null; } });
    return frag;
  },
  addEventListener() {},
  removeEventListener() {},
  head: mockEl("head"),
};
globalThis.window = globalThis;
globalThis.CSS = { escape: (s) => s };

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

const { getPaneType } = await import("../mkui/static/src/core.js");
await import("../mkui/static/src/widgets/mkio-table.js");

const factory = getPaneType("mkio-table");

/* ── Helpers ──────────────────────────────────────────────────────────── */

async function createTable(specOverrides = {}) {
  rafQueue.length = 0;
  pendingTimers.clear();
  const host = mockEl("div");
  const paneEl = mockEl("mkui-pane");
  host.closest = (sel) => sel === "mkui-pane" ? paneEl : null;
  host._paneEl = paneEl;
  const app = { config: { mkio: { url: "ws://localhost:8080/ws" } } };
  const spec = { service: "test-svc", ...specOverrides };
  const prevLen = ioCallbacks.length;
  await factory(spec, app, host);
  const io = ioCallbacks.length > prevLen ? ioCallbacks[ioCallbacks.length - 1] : null;
  return { host, spec, io };
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

function makeStreamRows(n, startId = 0) {
  return Array.from({ length: n }, (_, i) => ({
    _mkio_ref: `ref-${startId + i}`,
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

function getTbody(host) {
  return getTable(host)?._ch.find(c => c.tagName === "TBODY") ?? null;
}

function getThead(host) {
  return getTable(host)?._ch.find(c => c.tagName === "THEAD") ?? null;
}

function getHeaderTexts(host) {
  const thead = getThead(host);
  if (!thead || !thead._ch.length) return [];
  const tr = thead._ch[0];
  return tr._ch.map(th => {
    const textNodes = th._ch.filter(n => n.nodeType === 3);
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
  assert.equal(toolbar._ch.length, 4);
  assert.ok(toolbar._ch[0].textContent.includes("Prev"));
  assert.ok(toolbar._ch[2].textContent.includes("Next"));
  assert.ok(toolbar._ch[3].textContent.includes("Live"));
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

test("page 1 loads from beginning on first visibility", async () => {
  const { io } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  const sub = lastSubscribe();
  assert.equal(sub.opts.ref, null);
  assert.equal(sub.opts.maxcount, 50);
  assert.equal(sub.opts.updates, false);
});

test("page navigation: next uses lastRef, prev uses firstRef with before", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);

  const toolbar = findByClass(host, "mkui-table-paging");
  const [prevBtn, pageInfoEl, nextBtn] = toolbar._ch;

  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "cursor-A" });
  assert.equal(pageInfoEl.textContent, "Page 1");
  assert.equal(prevBtn.disabled, true);
  assert.equal(nextBtn.disabled, false);

  nextBtn._ev.click[0]();
  assert.equal(lastSubscribe().opts.ref, "ref-49", "next uses lastRef from row data");
  assert.equal(lastSubscribe().opts.before, undefined);

  lastSubscribe().opts.onPage(makeStreamRows(50, 50), { hasmore: true, ref: "cursor-B" });
  assert.equal(pageInfoEl.textContent, "Page 2");
  assert.equal(prevBtn.disabled, false);

  nextBtn._ev.click[0]();
  assert.equal(lastSubscribe().opts.ref, "ref-99", "next uses lastRef from row data");

  lastSubscribe().opts.onPage(makeStreamRows(20, 100), { hasmore: false, ref: "cursor-C" });
  assert.equal(pageInfoEl.textContent, "Page 3");
  assert.equal(nextBtn.disabled, true);

  prevBtn._ev.click[0]();
  assert.equal(lastSubscribe().opts.ref, "ref-100", "prev uses firstRef");
  assert.equal(lastSubscribe().opts.before, true);
  lastSubscribe().opts.onPage(makeStreamRows(50, 50), { hasmore: true, ref: "cursor-B2" });
  assert.equal(pageInfoEl.textContent, "Page 2");

  prevBtn._ev.click[0]();
  assert.equal(lastSubscribe().opts.ref, "ref-50", "prev uses firstRef");
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

test("prev on page 1 is a no-op", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r" });

  const callsBefore = fakeClient.calls.length;
  const prevBtn = findByClass(host, "mkui-table-paging")._ch[0];
  prevBtn._ev.click[0]();
  assert.equal(fakeClient.calls.length, callsBefore);
});

test("fetchPage forward with non-null ref enables prev", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r1" });

  const toolbar = findByClass(host, "mkui-table-paging");
  const prevBtn = toolbar._ch[0];
  assert.equal(prevBtn.disabled, true, "prev disabled on page 1");

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
  assert.equal(lastSubscribe().opts.ref, "ref-60", "prev uses firstRef of page 2");
  assert.equal(lastSubscribe().opts.before, true);
});

test("empty backward page fetch renders no rows", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r1" });

  const toolbar = findByClass(host, "mkui-table-paging");
  toolbar._ch[2]._ev.click[0]();
  lastSubscribe().opts.onPage(makeStreamRows(50, 50), { hasmore: false, ref: "r2" });

  toolbar._ch[0]._ev.click[0]();
  lastSubscribe().opts.onPage([], { hasmore: false, ref: null });
  assert.equal(getTbody(host)._ch.length, 0);
  assert.equal(toolbar._ch[0].disabled, true, "prev disabled after empty backward fetch");
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
  assert.equal(prevBtn.disabled, true);
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
  assert.equal(pageSub.opts.ref, "ref-50", "prev uses firstRef of page 2");
  assert.equal(pageSub.opts.before, true);
  assert.notEqual(pageSub.opts.subid, liveSub.opts.subid, "uses separate subid");

  pageSub.opts.onPage(makeStreamRows(50), { hasmore: false, ref: "r1" });
  assert.equal(getTbody(host)._ch.length, 105, "prev page added to existing rows");
  assert.equal(pageInfo.textContent, "Page 1 · Live");
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

test("Exit Live restores saved page without re-subscribing", async () => {
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

  const callsBefore = fakeClient.calls.length;
  liveBtn._ev.click[0]();
  assert.ok(!liveBtn.classList.contains("active"));

  assert.equal(fakeClient.calls.length, callsBefore + 2, "two unsubscribes (live + page), no new subscribe");
  assert.equal(fakeClient.calls[callsBefore].type, "unsubscribe");
  assert.equal(fakeClient.calls[callsBefore + 1].type, "unsubscribe");

  assert.equal(getTbody(host)._ch.length, 50, "page rows restored");
  assert.equal(pageInfo.textContent, "Page 1");
  assert.equal(prevBtn.disabled, true);
  assert.equal(nextBtn.disabled, false);
});

test("Exit Live replaces live rows with saved page rows", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r" });

  const toolbar = findByClass(host, "mkui-table-paging");
  const liveBtn = toolbar._ch[3];

  liveBtn._ev.click[0]();
  lastSubscribe().opts.onSnapshot(makeStreamRows(10, 500));
  assert.equal(getTbody(host)._ch.length, 60, "50 page + 10 live rows");

  liveBtn._ev.click[0]();
  assert.equal(getTbody(host)._ch.length, 50, "restored to saved page rows");
});

test("Go Live from page 1 disables prev", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r" });

  const toolbar = findByClass(host, "mkui-table-paging");
  const prevBtn = toolbar._ch[0];
  toolbar._ch[3]._ev.click[0]();
  assert.equal(prevBtn.disabled, true, "prev disabled when going live from page 1");
});

test("Prev on page 1 in live mode is a no-op", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
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
  assert.equal(pageSub.opts.ref, "ref-100", "first prev uses firstRef from page 3");
  pageSub.opts.onPage(makeStreamRows(50, 50), { hasmore: true, ref: "rp1" });
  assert.equal(pageInfo.textContent, "Page 2 · Live");
  assert.equal(getTbody(host)._ch.length, 105, "page 3 rows + live + prev page");

  prevBtn._ev.click[0]();
  pageSub = lastSubscribeBySubid("-page");
  assert.equal(pageSub.opts.ref, "ref-50", "second prev uses updated firstRef");
  pageSub.opts.onPage(makeStreamRows(50), { hasmore: false, ref: "rp2" });
  assert.equal(pageInfo.textContent, "Page 1 · Live");
  assert.equal(getTbody(host)._ch.length, 155, "all pages + live rows");
  assert.equal(prevBtn.disabled, true, "prev disabled after reaching beginning");
});

test("Exit live after loading prev pages restores original saved page", async () => {
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
  assert.equal(getTbody(host)._ch.length, 50, "restored to saved page 2 rows");
  assert.equal(pageInfo.textContent, "Page 2");
  assert.equal(nextBtn.disabled, true, "next disabled matches saved state");
  assert.equal(prevBtn.disabled, false, "prev enabled matches saved state");
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
  assert.equal(resub.opts.ref, "ref-50", "re-show uses pageLoadRef (ref passed to backward fetch)");
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
  assert.equal(sub.opts.ref, null, "ref reset after reopen");
  assert.equal(sub.opts.maxcount, 50, "back in paged mode");
  assert.equal(typeof sub.opts.onPage, "function", "uses onPage (not live)");

  sub.opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r-new" });
  assert.ok(!toolbar._ch[3].classList.contains("active"), "live mode deactivated after page loads");
});

test("mkui-pane-open resets paged stream to page 1", async () => {
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
  assert.equal(sub.opts.ref, null);
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
  lastSubscribe().opts.onPage(
    [{ _mkio_ref: "ref-A", name: "a" }],
    { hasmore: false, ref: "ref-A" },
  );

  const toolbar = findByClass(host, "mkui-table-paging");
  const liveBtn = toolbar._ch[3];
  liveBtn._ev.click[0]();

  const sub = lastSubscribe();
  assert.equal(sub.opts.ref, "ref-A", "goLive resumes from page lastRef");
});

test("stream: exitLive restores lastRef from saved page", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50), { hasmore: true, ref: "r" });

  const toolbar = findByClass(host, "mkui-table-paging");
  const liveBtn = toolbar._ch[3];
  liveBtn._ev.click[0]();
  lastSubscribe().opts.onSnapshot([
    { _mkio_ref: "ref-live", name: "live" },
  ]);

  const callsBefore = fakeClient.calls.length;
  liveBtn._ev.click[0]();
  assert.equal(fakeClient.calls[callsBefore].type, "unsubscribe", "exitLive unsubscribes live");
  assert.equal(fakeClient.calls[callsBefore + 1].type, "unsubscribe", "exitLive unsubscribes page");
  assert.equal(fakeClient.calls.length, callsBefore + 2, "no new subscribe after exitLive");
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
  assert.equal(liveSub.opts.ref, "ref-99", "live resumes from page 2 lastRef");
});

test("stream: exitLive restores firstRef from saved page", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage(makeStreamRows(50, 10), { hasmore: true, ref: "r1" });

  const toolbar = findByClass(host, "mkui-table-paging");
  toolbar._ch[2]._ev.click[0]();
  lastSubscribe().opts.onPage(makeStreamRows(50, 60), { hasmore: false, ref: "r2" });

  toolbar._ch[3]._ev.click[0]();
  lastSubscribe().opts.onSnapshot(makeStreamRows(5, 200));

  toolbar._ch[3]._ev.click[0]();
  assert.equal(getTbody(host)._ch.length, 50, "restored to page 2");

  toolbar._ch[0]._ev.click[0]();
  assert.equal(lastSubscribe().opts.ref, "ref-60", "prev uses restored firstRef from page 2");
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

/* ── Empty / edge cases ───────────────────────────────────────────────── */

test("empty page renders no rows and updates toolbar", async () => {
  const { io, host } = await createTable({ protocol: "stream", maxcount: 50 });
  triggerVisible(io);
  lastSubscribe().opts.onPage([], { hasmore: false, ref: null });
  assert.equal(getTbody(host)._ch.length, 0);
  const toolbar = findByClass(host, "mkui-table-paging");
  assert.equal(toolbar._ch[1].textContent, "Page 1");
  assert.equal(toolbar._ch[2].disabled, true);
});

test("empty snapshot renders nothing", async () => {
  const { io, host } = await createTable({ protocol: "query" });
  triggerVisible(io);
  lastSubscribe().opts.onSnapshot([]);
  assert.equal(getTbody(host)._ch.length, 0);
});
