// Run with: node --test tests/tab-focus.test.js
//
// Covers frame._activateTabGroupFromEvent: a tab group becomes the
// keyboard-focus target only when the user clicks an actual tab or pane
// content. Clicking a tab bar's empty area (the drag whitespace right of
// the tabs), the window controls, or other frame chrome must leave the
// active group unchanged — those clicks raise the frame, nothing more.
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.HTMLElement = class {};
globalThis.customElements = { get: () => undefined, define: () => {} };
globalThis.document = { createElement: () => ({ style: {}, addEventListener() {} }) };

const { MkuiFrame } = await import("../mkui/static/src/components/frame.js");

const group = (...children) => ({ type: "tabs", active: 0, children });

function makeFrame(tree = null) {
  const frame = new MkuiFrame();
  frame._bodyEl = {};
  frame._tree = tree;
  frame.renders = 0;
  frame._renderInternal = () => frame.renders++;
  return frame;
}

// Minimal DOM node for the handler's upward walk. Chains terminate at
// frame._bodyEl (or null), exactly like the real chrome hierarchy.
function el({ cls = [], tag = "DIV", tabGroup, id, parent = null } = {}) {
  return {
    tagName: tag,
    classList: { contains: (c) => cls.includes(c) },
    _tabGroup: tabGroup,
    getAttribute: () => id ?? null,
    parentElement: parent,
  };
}

// Builds a tab bar chain for `g`: bar > .mkui-tabs > .mkui-tab > label.
function makeBar(frame, g) {
  const bar = el({ cls: ["mkui-tabbar"], tabGroup: g, parent: frame._bodyEl });
  const tabs = el({ cls: ["mkui-tabs"], parent: bar });
  const tab = el({ cls: ["mkui-tab"], parent: tabs });
  const label = el({ cls: ["mkui-tab-label"], tag: "SPAN", parent: tab });
  return { bar, tabs, tab, label };
}

test("clicking a tab activates its group", () => {
  const g = group("a", "b");
  const frame = makeFrame(g);
  const { label } = makeBar(frame, g);
  frame._activateTabGroupFromEvent({ target: label });
  assert.equal(frame._activeTabGroup, g);
  assert.equal(frame.renders, 1);
});

test("clicking the bar's empty area does not activate the group", () => {
  const g = group("a");
  const frame = makeFrame(g);
  const { bar } = makeBar(frame, g);
  frame._activateTabGroupFromEvent({ target: bar });
  assert.equal(frame._activeTabGroup, undefined);
  assert.equal(frame.renders, 0);
});

test("clicking the tabs container between/right of tabs does not activate", () => {
  const g = group("a");
  const frame = makeFrame(g);
  const { tabs } = makeBar(frame, g);
  frame._activateTabGroupFromEvent({ target: tabs });
  assert.equal(frame._activeTabGroup, undefined);
  assert.equal(frame.renders, 0);
});

test("clicking the drag region does not activate the group", () => {
  const g = group("a");
  const frame = makeFrame(g);
  const { bar } = makeBar(frame, g);
  const drag = el({ cls: ["mkui-tabbar-drag"], parent: bar });
  frame._activateTabGroupFromEvent({ target: drag });
  assert.equal(frame._activeTabGroup, undefined);
  assert.equal(frame.renders, 0);
});

test("clicking pane content activates the pane's group in a split", () => {
  const left = group("a");
  const right = group("b");
  const frame = makeFrame({ type: "split", dir: "h", ratios: [0.5, 0.5],
                            children: [left, right] });
  const pane = el({ tag: "MKUI-PANE", id: "b", parent: frame._bodyEl });
  const content = el({ cls: ["mkui-pane-content"], parent: pane });
  const deep = el({ tag: "BUTTON", parent: content });
  frame._activateTabGroupFromEvent({ target: deep });
  assert.equal(frame._activeTabGroup, right);
  assert.equal(frame.renders, 1);
});

test("re-clicking a tab of the already-active group does not re-render", () => {
  const g = group("a");
  const frame = makeFrame(g);
  frame._activeTabGroup = g;
  const { tab } = makeBar(frame, g);
  frame._activateTabGroupFromEvent({ target: tab });
  assert.equal(frame.renders, 0);
});

test("clicks inside a tab's rename input still count as the tab", () => {
  const g = group("a");
  const frame = makeFrame(g);
  const { tab } = makeBar(frame, g);
  const input = el({ cls: ["mkui-tab-rename"], tag: "INPUT", parent: tab });
  frame._activateTabGroupFromEvent({ target: input });
  assert.equal(frame._activeTabGroup, g);
});

test("frame chrome outside any bar or pane leaves the group unchanged", () => {
  const g = group("a");
  const frame = makeFrame(g);
  frame._activeTabGroup = g;
  const splitter = el({ cls: ["mkui-splitter"], parent: frame._bodyEl });
  frame._activateTabGroupFromEvent({ target: splitter });
  assert.equal(frame._activeTabGroup, g);
  assert.equal(frame.renders, 0);
});
