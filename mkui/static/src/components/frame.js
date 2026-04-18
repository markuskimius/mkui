// <mkui-frame> + <mkui-pane>
//
// A frame is a floating top-level chrome (resize handles + body). The body
// hosts a normalized layout tree of panes, tab bars, and splitters. There
// is no dedicated titlebar — every tab bar at y=0 carries a flexible
// whitespace region that drags the frame, and the right-most of those
// additionally holds the window controls (maximize, close). So the
// frame's top edge is always just tab row(s), even when the top-level
// layout is a split.
//
// Frames never dock into each other directly — only panes do, via tab
// drag-out / inter-frame drop zones routed by <mkui-workspace>.
//
// Pane elements are pooled at the workspace level (stable identity), so
// moving a pane between frames is a plain appendChild — content state and
// subscriptions survive the re-dock.

import {
  normalize, listPanes, layout, setSplitRatio, firstTabGroup, findPane,
} from "../layout/tree.js";

class MkuiPane extends HTMLElement {
  constructor() {
    super();
    this._built = false;
  }
  connectedCallback() { if (!this._built) this._build(); }
  _build() {
    this._built = true;
    const content = document.createElement("div");
    content.className = "mkui-pane-content";
    this.appendChild(content);
    this._content = content;
  }
  get contentEl() { return this._content; }
}

class MkuiFrame extends HTMLElement {
  constructor() {
    super();
    this._built = false;
    this._tree = null;
    this._workspace = null;
    this._app = null;
    this._id = null;
    this._chromeEls = [];
  }

  connectedCallback() { if (!this._built) this._build(); }

  disconnectedCallback() {
    // Stop the body ResizeObserver so it doesn't fire a stale
    // _renderInternal after the frame has been closed — that would
    // re-appendChild our panes back into a detached body, orphaning them.
    this._bodyRO?.disconnect();
    this._bodyRO = null;
  }

  _build() {
    this._built = true;

    const body = document.createElement("div");
    body.className = "mkui-frame-body";
    this.appendChild(body);

    for (const dir of ["n", "s", "e", "w", "ne", "nw", "se", "sw"]) {
      const h = document.createElement("div");
      h.className = `mkui-frame-resize mkui-frame-resize-${dir}`;
      h.addEventListener("mousedown", (ev) => {
        this._workspace?._beginFrameResize(ev, this, dir);
      });
      this.appendChild(h);
    }

    // Raise to the top of z-order on any interaction inside the frame, and
    // mark whichever tab group sits under the click as the keyboard-focus
    // target. Capture phase so inner stopPropagation can't hide the click.
    this.addEventListener("mousedown", (ev) => {
      this._workspace?._raiseFrame(this);
      this._activateTabGroupFromEvent(ev);
    }, true);

    // Re-render the internal layout whenever the body resizes (either from
    // a frame drag/resize or from viewport-driven clamping).
    this._bodyRO = new ResizeObserver(() => this._renderInternal());
    this._bodyRO.observe(body);

    this._bodyEl = body;
  }

  setup(workspace, app, spec) {
    this._workspace = workspace;
    this._app = app;
    this._id = spec.id;
    this._tree = normalize(spec.layout);
    this._renderInternal();
  }

  get id() { return this._id; }
  get bodyEl() { return this._bodyEl; }
  getTree() { return this._tree; }

  setTree(tree) {
    const normalized = normalize(tree);
    this._tree = normalized;
    // Any stored tabGroup reference (e.g. _activeTabGroup) is from the old
    // tree — normalize rebuilds nodes, so it's no longer in this tree.
    this._activeTabGroup = null;
    this._renderInternal();
    if (this._tree == null) {
      // Frame has no panes left — close it. Safe: closeFrame just unmounts.
      this._workspace?.closeFrame(this._id);
    }
  }

  _renderInternal() {
    // Tear down chrome (tab bars, splitters) — rebuilt fresh each render.
    for (const el of this._chromeEls) el.remove();
    this._chromeEls = [];

    // Park any pane element no longer in this frame's tree. Park them in
    // the workspace pool rather than destroying them so that moving a pane
    // between frames preserves its state.
    const wanted = new Set(this._tree ? listPanes(this._tree) : []);
    for (const child of [...this._bodyEl.children]) {
      if (child.tagName === "MKUI-PANE") {
        const id = child.getAttribute("data-id");
        if (!wanted.has(id)) this._workspace?._parkPane(child);
      }
    }

    if (this._tree == null) return;

    const bw = this._bodyEl.clientWidth;
    const bh = this._bodyEl.clientHeight;
    const layoutRect = { x: 0, y: 0, w: bw, h: bh };
    const { panes, tabBars, splitters } = layout(this._tree, layoutRect);

    // The right-most tab bar at y=0 carries the window controls; every
    // tab bar at y=0 gets a trailing drag region that moves the frame.
    let controlBarIdx = -1;
    let controlBarRight = -Infinity;
    for (let i = 0; i < tabBars.length; i++) {
      if (tabBars[i].rect.y !== 0) continue;
      const right = tabBars[i].rect.x + tabBars[i].rect.w;
      if (right > controlBarRight) {
        controlBarRight = right;
        controlBarIdx = i;
      }
    }

    // Attach + position each pane that should live in this frame.
    for (const [id, info] of panes) {
      const el = this._workspace._ensurePaneEl(id);
      if (el.parentElement !== this._bodyEl) this._bodyEl.appendChild(el);
      Object.assign(el.style, {
        left: info.rect.x + "px",
        top: info.rect.y + "px",
        width: info.rect.w + "px",
        height: info.rect.h + "px",
        display: info.visible ? "" : "none",
      });
    }

    // Whichever tab group the user last interacted with inside this frame
    // is the "focused" one for hotkeys; default to the first if unset.
    const focusedTg = this._activeTabGroup ?? firstTabGroup(this._tree);

    for (let i = 0; i < tabBars.length; i++) {
      const { tabGroup, rect } = tabBars[i];
      const atTop = rect.y === 0;
      const bar = this._renderTabBar(tabGroup, rect, {
        withDrag: atTop,
        withControls: i === controlBarIdx,
        focused: tabGroup === focusedTg,
      });
      this._bodyEl.appendChild(bar);
      this._chromeEls.push(bar);
    }

    // Splitters.
    for (const sp of splitters) {
      const h = document.createElement("div");
      h.className = "mkui-splitter " + (sp.dir === "h" ? "mkui-splitter-h" : "mkui-splitter-v");
      Object.assign(h.style, {
        left: sp.rect.x + "px",
        top: sp.rect.y + "px",
        width: sp.rect.w + "px",
        height: sp.rect.h + "px",
      });
      h.addEventListener("mousedown", (ev) => this._beginSplitterDrag(ev, sp));
      this._bodyEl.appendChild(h);
      this._chromeEls.push(h);
    }
  }

  _renderTabBar(tabGroup, rect, opts = {}) {
    const { withDrag = false, withControls = false, focused = false } = opts;
    const bar = document.createElement("div");
    bar.className = "mkui-tabbar"
      + ((withDrag || withControls) ? " mkui-tabbar-top" : "")
      + (focused ? " mkui-tabbar-focused" : "");
    // Tagged so that an in-flight pane drag can re-locate its source bar
    // after _renderInternal rebuilds the chrome.
    bar._tabGroup = tabGroup;
    Object.assign(bar.style, {
      position: "absolute",
      left: rect.x + "px", top: rect.y + "px",
      width: rect.w + "px", height: rect.h + "px",
    });

    const tabs = document.createElement("div");
    tabs.className = "mkui-tabs";
    for (let i = 0; i < tabGroup.children.length; i++) {
      const id = tabGroup.children[i];
      const spec = this._workspace?.getPaneSpec(id);
      const label = spec?.title ?? id;
      const tab = document.createElement("div");
      tab.className = "mkui-tab" + (i === tabGroup.active ? " active" : "");
      tab.title = label; // tooltip so truncated tabs stay legible
      const labelEl = document.createElement("span");
      labelEl.className = "mkui-tab-label";
      labelEl.textContent = label;
      tab.appendChild(labelEl);
      tab.addEventListener("mousedown", (ev) => {
        if (ev.button !== 0) return;
        ev.stopPropagation();
        this._workspace?._beginPaneDrag(ev, this, id, tabGroup, bar);
      });
      tabs.appendChild(tab);
    }
    bar.appendChild(tabs);

    if (withDrag || withControls) bar.appendChild(this._makeDragRegion());
    if (withControls) bar.appendChild(this._makeControls());

    return bar;
  }

  _makeDragRegion() {
    const drag = document.createElement("div");
    drag.className = "mkui-frame-drag";
    drag.addEventListener("mousedown", (ev) => {
      if (ev.button !== 0) return;
      this._workspace?._beginFrameMove(ev, this);
    });
    drag.addEventListener("dblclick", (ev) => {
      ev.stopPropagation();
      this._workspace?.toggleMaximize(this._id);
    });
    return drag;
  }

  _makeControls() {
    const actions = document.createElement("div");
    actions.className = "mkui-frame-actions";

    const maxBtn = document.createElement("div");
    maxBtn.className = "mkui-frame-btn mkui-frame-maximize";
    maxBtn.innerHTML = "&#9723;";
    maxBtn.title = "Maximize";
    maxBtn.addEventListener("mousedown", (ev) => ev.stopPropagation());
    maxBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      this._workspace?.toggleMaximize(this._id);
    });
    actions.appendChild(maxBtn);

    const closeBtn = document.createElement("div");
    closeBtn.className = "mkui-frame-btn mkui-frame-close";
    closeBtn.textContent = "\u00d7";
    closeBtn.title = "Close";
    closeBtn.addEventListener("mousedown", (ev) => ev.stopPropagation());
    closeBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      this._workspace?.closeFrame(this._id);
    });
    actions.appendChild(closeBtn);

    return actions;
  }

  // Walk up from the event target until we hit a tab bar (tagged with
  // _tabGroup) or a pane (whose id lets us look up its tab group). Splitters,
  // resize handles, and frame chrome not inside a pane leave it unchanged.
  _activateTabGroupFromEvent(ev) {
    let node = ev.target;
    while (node && node !== this && node !== this._bodyEl) {
      if (node._tabGroup) return this._setActiveTabGroup(node._tabGroup);
      if (node.tagName === "MKUI-PANE" && this._tree) {
        const id = node.getAttribute("data-id");
        const hit = findPane(this._tree, id);
        if (hit) this._setActiveTabGroup(hit.tabGroup);
        return;
      }
      node = node.parentElement;
    }
  }

  _setActiveTabGroup(tg) {
    if (this._activeTabGroup === tg) return;
    this._activeTabGroup = tg;
    this._renderInternal();
  }

  _beginSplitterDrag(ev, sp) {
    ev.preventDefault();
    ev.stopPropagation();
    const horiz = sp.dir === "h";
    const startPos = horiz ? ev.clientX : ev.clientY;
    const startRatio = sp.splitNode.ratios[sp.index];
    const dim = sp.parentDim;
    const move = (e) => {
      const cur = horiz ? e.clientX : e.clientY;
      setSplitRatio(sp.splitNode, sp.index, startRatio + (cur - startPos) / dim);
      this._renderInternal();
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }
}

if (!customElements.get("mkui-pane"))  customElements.define("mkui-pane",  MkuiPane);
if (!customElements.get("mkui-frame")) customElements.define("mkui-frame", MkuiFrame);

export { MkuiPane, MkuiFrame };
