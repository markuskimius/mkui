// Run with: node --test tests/chips.test.js
//
// The chip builders (lib/chips.js): the pill a toolbar wears to say what is
// shaping what it shows — a sort key, a filter, a link, the record a detail
// window is about. Lifted out of `mkio-table` so both panes render the same
// DOM; these tests pin that DOM, since `tests/styles.test.js` styles it by
// exactly these class names.
import { test } from "node:test";
import assert from "node:assert/strict";

function mockEl(tag) {
  const el = {
    tagName: (tag ?? "").toUpperCase(),
    className: "", title: "", type: "", dataset: {}, _ch: [], _ev: {}, _parent: null, _text: null,
    classList: {
      _s: new Set(),
      add(...cs) { for (const c of cs) this._s.add(c); },
      remove(...cs) { for (const c of cs) this._s.delete(c); },
      toggle(c, f) { f ? this._s.add(c) : this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
    append(...ns) { for (const n of ns) el.appendChild(n); },
    appendChild(n) {
      if (n && typeof n === "object") { if (n._parent) n._parent._ch = n._parent._ch.filter((c) => c !== n); n._parent = el; }
      el._text = null;
      el._ch.push(n);
      return n;
    },
    setAttribute(k, v) { if (k === "class") el.className = String(v); },
    addEventListener(e, fn) { (el._ev[e] ??= []).push(fn); },
  };
  Object.defineProperty(el, "textContent", {
    get() { return el._text ?? el._ch.map((c) => c.textContent ?? "").join(""); },
    set(v) { el._ch = []; el._text = String(v); },
  });
  return el;
}
globalThis.document = {
  createElement: (t) => mockEl(t),
  createElementNS: (_ns, t) => mockEl(t),
  createTextNode: (text) => ({ textContent: text, nodeType: 3 }),
};
let timers = [];
globalThis.setTimeout = (fn) => { timers.push(fn); return timers.length; };
globalThis.clearTimeout = (id) => { timers[id - 1] = null; };
const fireTimers = () => { const t = timers; timers = []; for (const fn of t) fn?.(); };

const { makeChip, makeGroup, armedClear, linkIcon, linkDirWord, REMOVE_ARM_MS } =
  await import("../mkui/static/src/lib/chips.js");

const find = (node, cls) => {
  if (String(node.className).split(" ").includes(cls)) return node;
  for (const c of node._ch ?? []) { const hit = c._ch ? find(c, cls) : null; if (hit) return hit; }
  return null;
};
const click = (node) => { for (const fn of node._ev.click ?? []) fn({ stopPropagation() {} }); };

test("a chip is a labelled body button plus its own remove button", () => {
  const log = [];
  const { chip, main } = makeChip("mkui-chip-sort", "qty", "Quantity", "Sorted ascending",
    () => log.push("body"), () => log.push("clear"));
  assert.equal(chip.className, "mkui-chip mkui-chip-sort");
  assert.equal(chip.dataset.col, "qty");
  assert.equal(chip.title, "Sorted ascending");
  assert.equal(find(chip, "mkui-chip-text").textContent, "Quantity");
  assert.equal(main.className, "mkui-chip-main");

  click(main);
  click(find(chip, "mkui-chip-x"));
  assert.deepEqual(log, ["body", "clear"], "the body acts, the × removes");
});

test("the remove button does not also fire the body's action", () => {
  const log = [];
  const { chip } = makeChip("c", "", "t", "", () => log.push("body"), () => log.push("clear"));
  // The × stops propagation; were it not to, a click would do both.
  const x = find(chip, "mkui-chip-x");
  let stopped = false;
  for (const fn of x._ev.click) fn({ stopPropagation() { stopped = true; } });
  assert.ok(stopped);
  assert.deepEqual(log, ["clear"]);
});

test("a lead rides in the chip and a mark inside its button", () => {
  const lead = mockEl("input");
  lead.className = "mkui-chip-check";
  const mark = mockEl("svg");
  mark.className = "mkui-icon";
  const { chip, main } = makeChip("c", "", "Listen: order_id", "", () => {}, () => {}, lead, mark);
  // The lead is the chip's first child, outside the button whose click
  // opens the dropdown; the mark is the button's, ahead of the label.
  assert.equal(chip._ch[0], lead);
  assert.equal(main._ch[0], mark);
  assert.equal(main._ch[1].className, "mkui-chip-text");
});

test("a group leads with a clear button travelling inside the first chip", () => {
  const log = [];
  const chips = [makeChip("a", "", "1", "", () => {}, () => {}).chip,
                 makeChip("b", "", "2", "", () => {}, () => {}).chip];
  const g = makeGroup("mkui-chips-sort", "sort", "Clear sort", () => log.push("clear all"), chips);
  assert.equal(g.className, "mkui-chip-group mkui-chips-sort");
  const lead = find(g, "mkui-chip-lead");
  // The icon travels with the first chip so a wrapped line never starts
  // with an orphaned icon.
  assert.equal(lead._ch[1], chips[0]);
  assert.equal(g._ch[1], chips[1], "the rest follow the lead");
  const btn = find(g, "mkui-chip-icon");
  assert.equal(btn.title, "Clear sort");
  assert.ok(find(btn, "mkui-chip-icon-x"), "the group icon wears an × badge: it clears, it does not indicate");
  click(btn);
  assert.deepEqual(log, ["clear all"]);
});

test("removing several things at once takes two clicks", () => {
  const log = [];
  const { chip } = makeChip("c", "", "Listen: a, b", "the tooltip", () => {}, () => {});
  const clear = armedClear(chip, 2, "2 links", "the tooltip", () => log.push("removed"));

  clear();
  assert.deepEqual(log, [], "the first click only arms it");
  assert.ok(chip.classList.contains("mkui-chip-arm"));
  assert.match(chip.title, /Click × again to remove 2 links/);

  clear();
  assert.deepEqual(log, ["removed"]);
});

test("an armed chip disarms itself, and says what it meant again", () => {
  const { chip } = makeChip("c", "", "Listen: a, b", "the tooltip", () => {}, () => {});
  const clear = armedClear(chip, 2, "2 links", "the tooltip", () => {});
  clear();
  fireTimers();
  assert.equal(chip.classList.contains("mkui-chip-arm"), false);
  assert.equal(chip.title, "the tooltip");
  assert.equal(REMOVE_ARM_MS, 4000);
});

test("removing one thing goes through at once", () => {
  const log = [];
  const { chip } = makeChip("c", "", "Listen: a", "", () => {}, () => {});
  armedClear(chip, 1, "1 link", "", () => log.push("removed"))();
  assert.deepEqual(log, ["removed"]);
  assert.equal(chip.classList.contains("mkui-chip-arm"), false);
});

test("the two link directions have their own word and icon", () => {
  assert.equal(linkDirWord("broadcast"), "Broadcast");
  assert.equal(linkDirWord("listen"), "Listen");
  assert.equal(linkIcon("broadcast").className, "mkui-icon mkui-icon-radio");
  assert.equal(linkIcon("listen").className, "mkui-icon mkui-icon-ear");
});
