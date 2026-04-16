// <mkui-frame> + <mkui-pane>
//
// A frame is a floating top-level chrome (titlebar, resize handles, body).
// Its body hosts a normalized layout tree of panes, tab bars, and splitters.
// Frames never dock into each other directly — only panes do, via tab
// drag-out / inter-frame drop zones routed by <mkui-workspace>.
//
// Pane elements are pooled at the workspace level (stable identity), so
// moving a pane between frames is a plain appendChild — content state and
// subscriptions survive the re-dock.

import {
  normalize, listPanes, layout, setSplitRatio, TABBAR_H,
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
    this._explicitTitle = null;
    this._chromeEls = [];
  }

  connectedCallback() { if (!this._built) this._build(); }

  _build() {
    this._built = true;

    const titlebar = document.createElement("div");
    titlebar.className = "mkui-frame-titlebar";
    const titleSpan = document.createElement("span");
    titleSpan.className = "mkui-frame-title";
    titlebar.appendChild(titleSpan);
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

    titlebar.appendChild(actions);

    const body = document.createElement("div");
    body.className = "mkui-frame-body";

    this.appendChild(titlebar);
    this.appendChild(body);

    for (const dir of ["n", "s", "e", "w", "ne", "nw", "se", "sw"]) {
      const h = document.createElement("div");
      h.className = `mkui-frame-resize mkui-frame-resize-${dir}`;
      h.addEventListener("mousedown", (ev) => {
        this._workspace?._beginFrameResize(ev, this, dir);
      });
      this.appendChild(h);
    }

    titlebar.addEventListener("mousedown", (ev) => {
      if (ev.button !== 0) return;
      if (ev.target.closest(".mkui-frame-actions")) return;
      this._workspace?._beginFrameMove(ev, this);
    });

    // Raise to the top of z-order on any interaction inside the frame.
    this.addEventListener("mousedown", () => this._workspace?._raiseFrame(this), true);

    // Re-render the internal layout whenever the body resizes (either from
    // a frame drag/resize or from viewport-driven clamping).
    this._bodyRO = new ResizeObserver(() => this._renderInternal());
    this._bodyRO.observe(body);

    this._titlebarEl = titlebar;
    this._titleSpan = titleSpan;
    this._bodyEl = body;
  }

  setup(workspace, app, spec) {
    this._workspace = workspace;
    this._app = app;
    this._id = spec.id;
    this._explicitTitle = spec.title ?? null;
    this._tree = normalize(spec.layout);
    this._renderInternal();
  }

  get id() { return this._id; }
  get bodyEl() { return this._bodyEl; }
  getTree() { return this._tree; }

  setTree(tree) {
    const normalized = normalize(tree);
    this._tree = normalized;
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

    if (this._tree == null) {
      this._titleSpan.textContent = this._explicitTitle ?? "";
      return;
    }

    const bw = this._bodyEl.clientWidth;
    const bh = this._bodyEl.clientHeight;
    const bodyRect = { x: 0, y: 0, w: bw, h: bh };
    const { panes, tabBars, splitters } = layout(this._tree, bodyRect);

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

    // Tab bars.
    for (const { tabGroup, rect } of tabBars) {
      const bar = this._renderTabBar(tabGroup, rect);
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

    this._updateTitle();
  }

  _updateTitle() {
    if (this._explicitTitle) {
      this._titleSpan.textContent = this._explicitTitle;
      return;
    }
    // Fall back to the title of the first pane in traversal order.
    const ids = this._tree ? listPanes(this._tree) : [];
    if (ids.length === 0) { this._titleSpan.textContent = ""; return; }
    const spec = this._workspace?.getPaneSpec(ids[0]);
    this._titleSpan.textContent = spec?.title ?? ids[0];
  }

  _renderTabBar(tabGroup, rect) {
    const bar = document.createElement("div");
    bar.className = "mkui-tabbar";
    Object.assign(bar.style, {
      position: "absolute",
      left: rect.x + "px", top: rect.y + "px",
      width: rect.w + "px", height: rect.h + "px",
    });
    for (let i = 0; i < tabGroup.children.length; i++) {
      const id = tabGroup.children[i];
      const spec = this._workspace?.getPaneSpec(id);
      const tab = document.createElement("div");
      tab.className = "mkui-tab" + (i === tabGroup.active ? " active" : "");
      tab.textContent = spec?.title ?? id;
      tab.addEventListener("mousedown", (ev) => {
        if (ev.button !== 0) return;
        ev.stopPropagation();
        this._workspace?._beginPaneDrag(ev, this, id, tabGroup, bar);
      });
      bar.appendChild(tab);
    }
    return bar;
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
