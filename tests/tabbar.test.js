// Run with: node --test tests/tabbar.test.js
//
// Covers frame._renderTabBar's overflow scroll arrows: the strip has no
// scrollbar, so when the tabs (already squeezed to their minimum width)
// still overflow, ‹ › arrows flanking the strip are the only way to reach
// off-screen tabs. The bar gets .mkui-tabbar-overflow while overflowing,
// each arrow disables at its end of the strip, and a click scrolls by
// ~60% of the visible width.
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.HTMLElement = class {};
globalThis.customElements = { get: () => undefined, define: () => {} };

// Minimal DOM: children, class list, event listeners, scroll geometry.
function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    style: {},
    className: "",
    textContent: "",
    title: "",
    _ch: [],
    _listeners: {},
    scrollLeft: 0,
    scrollWidth: 0,
    clientWidth: 0,
    appendChild(c) { el._ch.push(c); return c; },
    addEventListener(name, fn) { (el._listeners[name] ??= []).push(fn); },
    querySelector() { return null; },
    classList: {
      contains: (c) => el.className.split(/\s+/).includes(c),
      add: (c) => { if (!el.classList.contains(c)) el.className = (el.className + " " + c).trim(); },
      toggle(c, force) {
        const has = el.classList.contains(c);
        const want = force ?? !has;
        const parts = el.className.split(/\s+/).filter(Boolean).filter((x) => x !== c);
        if (want) parts.push(c);
        el.className = parts.join(" ");
        return want;
      },
    },
  };
  return el;
}
globalThis.document = { createElement: makeEl };

const { MkuiFrame } = await import("../mkui/static/src/components/frame.js");

const fire = (el, name, ev = {}) =>
  (el._listeners[name] ?? []).forEach((fn) => fn({ stopPropagation() {}, ...ev }));

function makeBar({ titles = { a: "Alpha", b: "Beta" }, group } = {}) {
  const frame = new MkuiFrame();
  frame._noDock = false;
  frame._workspace = { getPaneSpec: (id) => (id in titles ? { title: titles[id] } : null) };
  const tabGroup = group ?? { type: "tabs", active: 0, children: Object.keys(titles) };
  const bar = frame._renderTabBar(tabGroup, { x: 0, y: 0, w: 200, h: 26 }, {});
  const [left, tabs, right] = bar._ch;
  return { frame, bar, left, tabs, right };
}

// Simulate layout: content of `scrollWidth` px inside `clientWidth` px,
// then let the strip's own scroll listener (updateArrows) react.
function layOut(tabs, { scrollWidth, clientWidth, scrollLeft = 0 }) {
  Object.assign(tabs, { scrollWidth, clientWidth, scrollLeft });
  fire(tabs, "scroll");
}

test("bar is built as ‹ [tabs] › with arrows outside the strip", () => {
  const { left, tabs, right } = makeBar();
  assert.equal(tabs.className, "mkui-tabs");
  assert.match(left.className, /mkui-tab-scroll-left/);
  assert.match(right.className, /mkui-tab-scroll-right/);
  assert.equal(left.textContent, "‹");
  assert.equal(right.textContent, "›");
});

test("tabs render spec titles and mark the active index", () => {
  const { tabs } = makeBar({
    titles: { a: "Alpha", b: "Beta" },
    group: { type: "tabs", active: 1, children: ["a", "b", "orphan"] },
  });
  assert.deepEqual(tabs._ch.map((t) => t._ch[0].textContent), ["Alpha", "Beta", "orphan"]);
  assert.deepEqual(tabs._ch.map((t) => t.classList.contains("active")), [false, true, false]);
});

test("no overflow → no overflow class on the bar", () => {
  const { bar, tabs } = makeBar();
  layOut(tabs, { scrollWidth: 200, clientWidth: 200 });
  assert.equal(bar.classList.contains("mkui-tabbar-overflow"), false);
});

test("overflow tags the bar and disables the arrow at each end", () => {
  const { bar, left, tabs, right } = makeBar();

  layOut(tabs, { scrollWidth: 500, clientWidth: 200, scrollLeft: 0 });
  assert.equal(bar.classList.contains("mkui-tabbar-overflow"), true);
  assert.equal(left.classList.contains("mkui-disabled"), true, "at start: ‹ disabled");
  assert.equal(right.classList.contains("mkui-disabled"), false);

  layOut(tabs, { scrollWidth: 500, clientWidth: 200, scrollLeft: 150 });
  assert.equal(left.classList.contains("mkui-disabled"), false, "mid-strip: both live");
  assert.equal(right.classList.contains("mkui-disabled"), false);

  layOut(tabs, { scrollWidth: 500, clientWidth: 200, scrollLeft: 300 });
  assert.equal(left.classList.contains("mkui-disabled"), false);
  assert.equal(right.classList.contains("mkui-disabled"), true, "at end: › disabled");
});

test("overflow state recovers when tabs fit again", () => {
  const { bar, tabs } = makeBar();
  layOut(tabs, { scrollWidth: 500, clientWidth: 200 });
  assert.equal(bar.classList.contains("mkui-tabbar-overflow"), true);
  layOut(tabs, { scrollWidth: 400, clientWidth: 400 });
  assert.equal(bar.classList.contains("mkui-tabbar-overflow"), false);
});

test("arrow clicks scroll by 60% of the visible strip, floored at 60px", () => {
  const { left, tabs, right } = makeBar();
  Object.assign(tabs, { scrollWidth: 500, clientWidth: 200, scrollLeft: 200 });

  fire(right, "click");
  assert.equal(tabs.scrollLeft, 320, "› scrolls forward by 0.6 × 200");
  fire(left, "click");
  fire(left, "click");
  assert.equal(tabs.scrollLeft, 80, "‹ scrolls back by the same step");

  tabs.clientWidth = 50; // tiny strip: the 60px floor kicks in
  fire(right, "click");
  assert.equal(tabs.scrollLeft, 140);
});

test("arrow clicks prefer smooth scrollBy when the DOM provides it", () => {
  const { right, tabs } = makeBar();
  Object.assign(tabs, { scrollWidth: 500, clientWidth: 200, scrollLeft: 0 });
  const calls = [];
  tabs.scrollBy = (opts) => calls.push(opts);
  fire(right, "click");
  assert.deepEqual(calls, [{ left: 120, behavior: "smooth" }]);
  assert.equal(tabs.scrollLeft, 0, "scrollLeft is left to the smooth scroll");
});

test("arrow clicks don't propagate to the bar (no frame-raise side effects)", () => {
  const { right, tabs } = makeBar();
  Object.assign(tabs, { scrollWidth: 500, clientWidth: 200 });
  let stopped = false;
  (right._listeners.click ?? []).forEach((fn) =>
    fn({ stopPropagation: () => { stopped = true; } }));
  assert.equal(stopped, true);
});
