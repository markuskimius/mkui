// Layout tree for a single frame. Pure data + math, no DOM.
//
// Canonical invariants (after normalize):
//
//   Tree    := null | Split | TabGroup
//   Split   : { type: "split", dir: "h"|"v", ratios: number[], children: (Split|TabGroup)[] }
//             — always ≥ 2 children; ratios sum to 1
//   TabGroup: { type: "tabs", active: number, children: string[] }
//             — always ≥ 1 child; children are pane id strings
//
// Every leaf sits inside a TabGroup, so "where a pane lives" always has a
// tab bar associated with it. A frame that holds a single pane is a
// single-tab group; dragging a second pane in either adds a tab (center
// drop) or wraps the group in a new split (edge drop).

export function isLeaf(n) { return typeof n === "string"; }
export function isTabs(n) { return n != null && typeof n === "object" && n.type === "tabs"; }
export function isSplit(n) { return n != null && typeof n === "object" && n.type === "split"; }

export function normalizeRatios(ratios, n) {
  if (!ratios || ratios.length !== n) return new Array(n).fill(1 / n);
  const sum = ratios.reduce((a, b) => a + b, 0);
  if (sum <= 0) return new Array(n).fill(1 / n);
  return ratios.map(r => r / sum);
}

// Normalize a raw tree (possibly written casually in config) into the
// canonical form. Bare leaf strings become single-tab groups, single-child
// splits collapse to their child, and empty tabs/splits drop out.
export function normalize(tree) {
  if (tree == null) return null;
  if (isLeaf(tree)) return { type: "tabs", active: 0, children: [tree] };
  if (isTabs(tree)) {
    const children = tree.children.filter(c => isLeaf(c));
    if (children.length === 0) return null;
    return {
      type: "tabs",
      active: Math.min(Math.max(0, tree.active ?? 0), children.length - 1),
      children,
    };
  }
  if (isSplit(tree)) {
    const children = tree.children.map(normalize).filter(Boolean);
    if (children.length === 0) return null;
    if (children.length === 1) return children[0];
    return {
      type: "split",
      dir: tree.dir === "v" ? "v" : "h",
      ratios: normalizeRatios(tree.ratios, children.length),
      children,
    };
  }
  return null;
}

// Walk the tree in traversal order, returning all pane ids.
export function listPanes(tree) {
  const out = [];
  (function walk(n) {
    if (n == null) return;
    if (isTabs(n)) { for (const c of n.children) out.push(c); return; }
    if (isSplit(n)) { for (const c of n.children) walk(c); return; }
  })(tree);
  return out;
}

// Find the TabGroup containing `paneId`. Returns { tabGroup, tabIndex } or null.
export function findPane(tree, paneId) {
  if (tree == null) return null;
  if (isTabs(tree)) {
    const i = tree.children.indexOf(paneId);
    return i >= 0 ? { tabGroup: tree, tabIndex: i } : null;
  }
  if (isSplit(tree)) {
    for (const c of tree.children) {
      const hit = findPane(c, paneId);
      if (hit) return hit;
    }
  }
  return null;
}

// Remove a pane id from the tree. Collapses emptied tab groups and single-
// child splits. Returns the new root, which may be null if the tree is now
// empty — in that case the owning frame should close itself.
export function removePane(tree, paneId) {
  if (tree == null) return null;
  if (isTabs(tree)) {
    const children = tree.children.filter(c => c !== paneId);
    if (children.length === 0) return null;
    return {
      type: "tabs",
      active: Math.min(tree.active ?? 0, children.length - 1),
      children,
    };
  }
  if (isSplit(tree)) {
    const newChildren = [];
    const newRatios = [];
    for (let i = 0; i < tree.children.length; i++) {
      const r = removePane(tree.children[i], paneId);
      if (r != null) {
        newChildren.push(r);
        newRatios.push(tree.ratios[i]);
      }
    }
    if (newChildren.length === 0) return null;
    if (newChildren.length === 1) return newChildren[0];
    return {
      type: "split",
      dir: tree.dir,
      ratios: normalizeRatios(newRatios, newChildren.length),
      children: newChildren,
    };
  }
  return tree;
}

// Insert `newPaneId` into the tree relative to an existing pane.
//   side ∈ "left" | "right" | "top" | "bottom" | "center"
// "center" adds the new pane as a tab in the same tab group as the target.
// The side directions wrap the target's tab group in a new split.
export function insertPane(tree, targetPaneId, side, newPaneId) {
  if (tree == null) return { type: "tabs", active: 0, children: [newPaneId] };
  const hit = findPane(tree, targetPaneId);
  if (!hit) return tree;
  if (side === "center") {
    const tg = hit.tabGroup;
    return replaceTabGroup(tree, tg, {
      type: "tabs",
      active: tg.children.length,
      children: [...tg.children, newPaneId],
    });
  }
  const dir = side === "left" || side === "right" ? "h" : "v";
  const before = side === "left" || side === "top";
  const newTabs = { type: "tabs", active: 0, children: [newPaneId] };
  const wrapped = {
    type: "split",
    dir,
    ratios: [0.5, 0.5],
    children: before ? [newTabs, hit.tabGroup] : [hit.tabGroup, newTabs],
  };
  return replaceTabGroup(tree, hit.tabGroup, wrapped);
}

function replaceTabGroup(tree, oldTg, replacement) {
  if (tree === oldTg) return replacement;
  if (tree == null || isLeaf(tree) || isTabs(tree)) return tree;
  return {
    ...tree,
    children: tree.children.map(c => replaceTabGroup(c, oldTg, replacement)),
  };
}

// Adjust the ratio between child `index` and child `index+1` of a split.
// Mutates; clamps so each stays above 5% of the pair's total.
export function setSplitRatio(splitNode, index, newRatio) {
  const ratios = splitNode.ratios;
  const min = 0.05;
  const total = ratios[index] + ratios[index + 1];
  const r = Math.max(min, Math.min(total - min, newRatio));
  ratios[index] = r;
  ratios[index + 1] = total - r;
}

// ─── Layout ─────────────────────────────────────────────────────────────────
// Given a normalized tree and a pixel rect (the frame body), compute:
//   panes     : Map<paneId, { rect, visible, tabGroup }>
//   tabBars   : [{ tabGroup, rect }]
//   splitters : [{ splitNode, index, dir, rect, parentDim }]
//
// `parentDim` is the size of the split's own slot along the split axis; it
// lets splitter drag convert pixel deltas into ratio deltas accurately
// regardless of how deeply nested the split is.

export const TABBAR_H = 28;
export const SPLITTER_W = 4;

export function layout(tree, rect) {
  const out = { panes: new Map(), tabBars: [], splitters: [] };
  walkLayout(tree, rect, out);
  return out;
}

function walkLayout(node, rect, out) {
  if (node == null) return;
  if (isTabs(node)) {
    const barH = Math.min(TABBAR_H, rect.h);
    const tabRect = { x: rect.x, y: rect.y, w: rect.w, h: barH };
    const bodyRect = { x: rect.x, y: rect.y + barH, w: rect.w, h: Math.max(0, rect.h - barH) };
    out.tabBars.push({ tabGroup: node, rect: tabRect });
    const active = node.active ?? 0;
    for (let i = 0; i < node.children.length; i++) {
      out.panes.set(node.children[i], {
        rect: { ...bodyRect },
        visible: i === active,
        tabGroup: node,
      });
    }
    return;
  }
  if (isSplit(node)) {
    const horiz = node.dir === "h";
    const parentDim = horiz ? rect.w : rect.h;
    let offset = 0;
    for (let i = 0; i < node.children.length; i++) {
      const r = node.ratios[i];
      let cr;
      if (horiz) {
        const isLast = i === node.children.length - 1;
        const cw = isLast ? rect.w - offset : Math.round(rect.w * r);
        cr = { x: rect.x + offset, y: rect.y, w: cw, h: rect.h };
        offset += cw;
      } else {
        const isLast = i === node.children.length - 1;
        const ch = isLast ? rect.h - offset : Math.round(rect.h * r);
        cr = { x: rect.x, y: rect.y + offset, w: rect.w, h: ch };
        offset += ch;
      }
      walkLayout(node.children[i], cr, out);
      if (i < node.children.length - 1) {
        const sw = SPLITTER_W;
        const spRect = horiz
          ? { x: cr.x + cr.w - sw / 2, y: cr.y, w: sw, h: cr.h }
          : { x: cr.x, y: cr.y + cr.h - sw / 2, w: cr.w, h: sw };
        out.splitters.push({ splitNode: node, index: i, dir: node.dir, rect: spRect, parentDim });
      }
    }
  }
}
