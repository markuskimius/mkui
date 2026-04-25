// <mkui-workspace>
//
// The area between the menubar and the statusbar. Holds a z-ordered list
// of floating <mkui-frame> elements. Owns:
//
//   - the authoritative pane-element pool (stable identity across re-docks)
//   - frame create / close / z-order operations
//   - all drag logic that spans multiple frames:
//       * frame move / resize (clamped to the workspace rect)
//       * pane tear-out (drag a tab outside its bar → new frame at cursor)
//       * inter-frame drop zones (drag a torn-out frame into another frame)
//
// The workspace never owns a layout tree itself. Each frame is independent.

import "./frame.js";
import { getPaneType, getWidget } from "../core.js";
import { clampToDock, rectToFrac, fracToRect, dropZoneFor, previewRect, snapMove, snapResize, cascadePosition } from "../layout/drag.js";
import { layout, insertPane, removePane, findPane, firstTabGroup } from "../layout/tree.js";

class MkuiWorkspace extends HTMLElement {
  constructor() {
    super();
    this._built = false;
    this._app = null;
    this._panes = new Map();        // paneId  -> pane spec
    this._paneEls = new Map();      // paneId  -> <mkui-pane> (authoritative)
    this._frames = [];              // frame specs, order = z-order (last = top)
    this._frameEls = new Map();     // frameId -> <mkui-frame>
    this._pool = null;              // hidden stash for detached panes
    this._dropOverlay = null;
    this._frameSeq = 0;
  }

  connectedCallback() {
    if (!this._built) {
      this._pool = document.createElement("div");
      this._pool.className = "mkui-pane-pool";
      this._pool.style.display = "none";
      this.appendChild(this._pool);
      this._built = true;
    }
    this._ro = new ResizeObserver(() => this._layoutFrames());
    this._ro.observe(this);
    window.addEventListener("resize", this._onWindowResize);
    window.addEventListener("keydown", this._onKeyDown);
  }
  disconnectedCallback() {
    this._ro?.disconnect();
    window.removeEventListener("resize", this._onWindowResize);
    window.removeEventListener("keydown", this._onKeyDown);
  }
  _onWindowResize = () => this._layoutFrames();

  // Alt+Shift+Left/Right reorders the active tab within its tab group on the
  // top-most frame. We track the "active" group on each frame via
  // _activeTabGroup (set when the user interacts with a tab); if unset, we
  // fall back to the first tab group in the frame's tree.
  _onKeyDown = (e) => {
    if (!(e.altKey && e.shiftKey)) return;
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    const topSpec = this._frames[this._frames.length - 1];
    if (!topSpec) return;
    const frameEl = this._frameEls.get(topSpec.id);
    if (!frameEl) return;
    const tg = frameEl._activeTabGroup ?? firstTabGroup(frameEl.getTree());
    if (!tg || tg.children.length < 2) return;
    const i = tg.active ?? 0;
    const j = e.key === "ArrowLeft" ? i - 1 : i + 1;
    if (j < 0 || j >= tg.children.length) return;
    [tg.children[i], tg.children[j]] = [tg.children[j], tg.children[i]];
    tg.active = j;
    frameEl._activeTabGroup = tg;
    e.preventDefault();
    frameEl._renderInternal();
  };

  setApp(app) {
    this._app = app;
    this._panes = new Map(Object.entries(app.config.panes ?? {}));
    const frames = app.config.frames ?? [];
    this._frames = frames.map((f, i) => ({
      id: f.id ?? this._nextFrameId(),
      title: f.title ?? null,
      x: f.x ?? (0.08 + i * 0.03),
      y: f.y ?? (0.08 + i * 0.03),
      w: f.w ?? 0.5,
      h: f.h ?? 0.5,
      layout: f.layout,
    }));
    this._renderFrames();
  }

  getPaneSpec(id) { return this._panes.get(id); }

  _nextFrameId() {
    this._frameSeq += 1;
    return `frame-${this._frameSeq}`;
  }

  // Pane pool ────────────────────────────────────────────────────────────

  _ensurePaneEl(id) {
    let el = this._paneEls.get(id);
    if (el) return el;
    const spec = this._panes.get(id);
    el = document.createElement("mkui-pane");
    el.setAttribute("data-id", id);
    if (!el._built) el._build();
    if (spec) this._buildPaneContent(el.contentEl, spec);
    else el.contentEl.textContent = `[mkui] unknown pane: ${id}`;
    this._paneEls.set(id, el);
    this._pool.appendChild(el);
    return el;
  }

  _parkPane(el) {
    if (el.parentElement !== this._pool) this._pool.appendChild(el);
    el.style.display = "none";
  }

  _buildPaneContent(host, spec) {
    if (spec.type) {
      const typeFn = getPaneType(spec.type);
      if (typeFn) {
        const result = typeFn(spec, this._app, host);
        if (result instanceof Promise) result.catch(e => { host.textContent = String(e); });
        return;
      }
      host.textContent = `[mkui] unknown pane type: ${spec.type}`;
      return;
    }
    if (spec.widgets) {
      for (const w of spec.widgets) {
        const fn = getWidget(w.type);
        if (fn) fn(w, this._app, host);
      }
      return;
    }
    if (spec.content) host.textContent = spec.content;
  }

  // Frame lifecycle ──────────────────────────────────────────────────────

  _renderFrames() {
    for (const spec of this._frames) {
      if (!this._frameEls.has(spec.id)) {
        const el = document.createElement("mkui-frame");
        el.setAttribute("data-id", spec.id);
        this.appendChild(el);
        if (!el._built) el._build();
        el.setup(this, this._app, spec);
        this._frameEls.set(spec.id, el);
      }
    }
    for (const [id, el] of [...this._frameEls]) {
      if (!this._frames.find(f => f.id === id)) {
        el.remove();
        this._frameEls.delete(id);
      }
    }
    this._layoutFrames();
    this._applyZOrder();
  }

  _layoutFrames() {
    const ws = { x: 0, y: 0, w: this.clientWidth, h: this.clientHeight };
    if (ws.w === 0 || ws.h === 0) return;
    for (const spec of this._frames) {
      const el = this._frameEls.get(spec.id);
      if (!el) continue;
      const r = clampToDock(
        fracToRect({ xFrac: spec.x, yFrac: spec.y, wFrac: spec.w, hFrac: spec.h }, ws),
        ws,
      );
      const frac = rectToFrac(r, ws);
      spec.x = frac.xFrac; spec.y = frac.yFrac;
      spec.w = frac.wFrac; spec.h = frac.hFrac;
      Object.assign(el.style, {
        left: r.x + "px",
        top: r.y + "px",
        width: r.w + "px",
        height: r.h + "px",
      });
    }
  }

  _applyZOrder() {
    const topIdx = this._frames.length - 1;
    for (let i = 0; i < this._frames.length; i++) {
      const el = this._frameEls.get(this._frames[i].id);
      if (!el) continue;
      el.style.zIndex = 10 + i;
      if (i === topIdx) el.setAttribute("data-focused", "");
      else el.removeAttribute("data-focused");
    }
  }

  _raiseFrame(frameEl) {
    const id = frameEl.getAttribute("data-id");
    const idx = this._frames.findIndex(f => f.id === id);
    if (idx < 0 || idx === this._frames.length - 1) return;
    const [spec] = this._frames.splice(idx, 1);
    this._frames.push(spec);
    this._applyZOrder();
  }

  closeFrame(id) {
    const idx = this._frames.findIndex(f => f.id === id);
    if (idx < 0) return;
    const el = this._frameEls.get(id);
    // Park any panes still inside this frame's body, so pane state survives
    // frame closure (they just become hidden in the pool).
    if (el) {
      for (const child of [...el.bodyEl.children]) {
        if (child.tagName === "MKUI-PANE") this._parkPane(child);
      }
      el.remove();
    }
    this._frameEls.delete(id);
    this._frames.splice(idx, 1);
    // Re-apply z-order so the new top-most frame picks up data-focused.
    this._applyZOrder();
  }

  // Public API: create a new frame programmatically. Useful from JS /
  // from menubar actions ("New Window", etc).
  addFrame(spec) {
    const s = {
      id: spec.id ?? this._nextFrameId(),
      title: spec.title ?? null,
      x: spec.x ?? 0.2, y: spec.y ?? 0.2,
      w: spec.w ?? 0.4, h: spec.h ?? 0.4,
      layout: spec.layout,
    };
    this._frames.push(s);
    const el = document.createElement("mkui-frame");
    el.setAttribute("data-id", s.id);
    this.appendChild(el);
    if (!el._built) el._build();
    el.setup(this, this._app, s);
    this._frameEls.set(s.id, el);
    this._layoutFrames();
    this._applyZOrder();
    return s.id;
  }

  showPane(paneId) {
    if (!this._panes.has(paneId)) return;
    for (const spec of this._frames) {
      const el = this._frameEls.get(spec.id);
      if (!el) continue;
      const hit = findPane(el.getTree(), paneId);
      if (hit) {
        hit.tabGroup.active = hit.tabIndex;
        el._renderInternal();
        this._raiseFrame(el);
        return;
      }
    }
    const w = 0.4, h = 0.4;
    const top = this._frames[this._frames.length - 1] ?? null;
    const { x, y } = cascadePosition(top, w, h);
    this.addFrame({
      x, y, w, h,
      layout: { type: "tabs", active: 0, children: [paneId] },
    });
  }

  // Window arrangement ─────────────────────────────────────────────────────

  _animated(fn) {
    for (const el of this._frameEls.values()) el.classList.add("mkui-arranging");
    fn();
    this._layoutFrames();
    setTimeout(() => {
      for (const el of this._frameEls.values()) el.classList.remove("mkui-arranging");
    }, 300);
  }

  arrangeHorizontal() {
    this._clearMaximize();
    this._animated(() => {
      const n = this._frames.length;
      if (n === 0) return;
      const slotW = 1 / n;
      for (let i = 0; i < n; i++) {
        const s = this._frames[i];
        this._capturePreTile(s);
        s.x = i * slotW;
        s.y = 0;
        s.w = slotW;
        s.h = 1;
      }
    });
  }

  arrangeVertical() {
    this._clearMaximize();
    this._animated(() => {
      const n = this._frames.length;
      if (n === 0) return;
      const slotH = 1 / n;
      for (let i = 0; i < n; i++) {
        const s = this._frames[i];
        this._capturePreTile(s);
        s.x = 0;
        s.y = i * slotH;
        s.w = 1;
        s.h = slotH;
      }
    });
  }

  arrangeGrid() {
    this._clearMaximize();
    this._animated(() => {
      const n = this._frames.length;
      if (n === 0) return;
      const cols = Math.ceil(Math.sqrt(n));
      const rows = Math.ceil(n / cols);
      const slotW = 1 / cols;
      const slotH = 1 / rows;
      for (let i = 0; i < n; i++) {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const s = this._frames[i];
        this._capturePreTile(s);
        s.x = col * slotW;
        s.y = row * slotH;
        s.w = slotW;
        s.h = slotH;
      }
    });
  }

  arrangeCascade() {
    this._clearMaximize();
    this._animated(() => {
      const n = this._frames.length;
      if (n === 0) return;
      const step = 0.03;
      const w = Math.max(0.25, 0.55 - n * 0.01);
      const h = Math.max(0.25, 0.55 - n * 0.01);
      for (let i = 0; i < n; i++) {
        const s = this._frames[i];
        s.x = i * step;
        s.y = i * step;
        s.w = w;
        s.h = h;
      }
    });
  }

  // Maximize / restore ────────────────────────────────────────────────────

  toggleMaximize(frameId) {
    if (this._maximized && this._maximized.frameId === frameId) {
      this._restoreMaximize();
    } else {
      this._maximize(frameId);
    }
  }

  _maximize(frameId) {
    if (this._maximized) this._restoreMaximize(false);
    const spec = this._frames.find(f => f.id === frameId);
    if (!spec) return;
    this._capturePreTile(spec);
    this._maximized = { frameId };
    const el = this._frameEls.get(frameId);
    if (el) el.classList.add("mkui-arranging");
    spec.x = 0; spec.y = 0; spec.w = 1; spec.h = 1;
    this._layoutFrames();
    this._raiseFrame(this._frameEls.get(frameId));
    el?.setAttribute("maximized", "");
    setTimeout(() => el?.classList.remove("mkui-arranging"), 300);
  }

  _restoreMaximize(animate = true) {
    if (!this._maximized) return;
    const { frameId } = this._maximized;
    const spec = this._frames.find(f => f.id === frameId);
    const el = this._frameEls.get(frameId);
    if (spec && spec.preTileRect) {
      if (animate && el) el.classList.add("mkui-arranging");
      Object.assign(spec, spec.preTileRect);
      delete spec.preTileRect;
      this._layoutFrames();
      if (animate) setTimeout(() => el?.classList.remove("mkui-arranging"), 300);
    }
    el?.removeAttribute("maximized");
    this._maximized = null;
  }

  _clearMaximize() {
    if (this._maximized) {
      const el = this._frameEls.get(this._maximized.frameId);
      el?.removeAttribute("maximized");
      this._maximized = null;
    }
  }

  isMaximized(frameId) {
    return this._maximized?.frameId === frameId;
  }

  // Per-frame pre-tile restore ────────────────────────────────────────────
  //
  // When a frame is tiled or maximized, capture its pre-tile rect so that a
  // subsequent manual drag can snap it back to that size. Only the oldest
  // pre-tile state is kept — tiling a tiled frame doesn't overwrite it, so
  // the original user-sized rect survives through multiple arrangements.

  _capturePreTile(spec) {
    if (!spec.preTileRect) {
      spec.preTileRect = { x: spec.x, y: spec.y, w: spec.w, h: spec.h };
    }
  }

  _clearTileState(spec, frameEl) {
    delete spec.preTileRect;
    if (this._maximized?.frameId === spec.id) {
      frameEl?.removeAttribute("maximized");
      this._maximized = null;
    }
  }

  // Frame drag / resize ───────────────────────────────────────────────────

  _frameSpecFor(frameEl) {
    const id = frameEl.getAttribute("data-id");
    return this._frames.find(f => f.id === id) ?? null;
  }

  // Collect vertical (x) and horizontal (y) snap guide lines from the
  // workspace boundaries and every other frame's edges.
  _getSnapLines(exceptId) {
    const ws = { w: this.clientWidth, h: this.clientHeight };
    const vLines = [0, ws.w];
    const hLines = [0, ws.h];
    for (const s of this._frames) {
      if (s.id === exceptId) continue;
      const r = fracToRect({ xFrac: s.x, yFrac: s.y, wFrac: s.w, hFrac: s.h }, { x: 0, y: 0, ...ws });
      vLines.push(r.x, r.x + r.w);
      hLines.push(r.y, r.y + r.h);
    }
    return { vLines, hLines };
  }

  _beginFrameMove(ev, frameEl) {
    ev.preventDefault();
    const spec = this._frameSpecFor(frameEl);
    if (!spec) return;
    const ws = { x: 0, y: 0, w: this.clientWidth, h: this.clientHeight };
    let start = fracToRect({ xFrac: spec.x, yFrac: spec.y, wFrac: spec.w, hFrac: spec.h }, ws);
    const wsRect = this.getBoundingClientRect();
    let offX = ev.clientX - wsRect.left - start.x;
    let offY = ev.clientY - wsRect.top - start.y;
    let snap = this._getSnapLines(spec.id);
    const startX = ev.clientX, startY = ev.clientY;
    let restored = false;
    const move = (e) => {
      // On first significant motion of a tiled/maximized frame, restore its
      // pre-tile size under the cursor and refresh the movement baselines.
      if (!restored && spec.preTileRect) {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) < 4) return;
        const pre = spec.preTileRect;
        const newW = pre.w * ws.w;
        const newH = pre.h * ws.h;
        offX = offX / start.w * newW;
        offY = offY / start.h * newH;
        start = { x: 0, y: 0, w: newW, h: newH };
        spec.w = pre.w; spec.h = pre.h;
        this._clearTileState(spec, frameEl);
        snap = this._getSnapLines(spec.id);
        Object.assign(frameEl.style, { width: newW + "px", height: newH + "px" });
        restored = true;
      }
      const wr = this.getBoundingClientRect();
      const raw = { x: e.clientX - wr.left - offX, y: e.clientY - wr.top - offY, w: start.w, h: start.h };
      const snapped = snapMove(raw, snap.vLines, snap.hLines);
      const clamped = clampToDock(snapped, ws);
      const frac = rectToFrac(clamped, ws);
      spec.x = frac.xFrac; spec.y = frac.yFrac;
      spec.w = frac.wFrac; spec.h = frac.hFrac;
      Object.assign(frameEl.style, {
        left: clamped.x + "px",
        top: clamped.y + "px",
      });
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  _beginFrameResize(ev, frameEl, dir) {
    ev.preventDefault();
    ev.stopPropagation();
    const spec = this._frameSpecFor(frameEl);
    if (!spec) return;
    this._clearTileState(spec, frameEl);
    const ws = { x: 0, y: 0, w: this.clientWidth, h: this.clientHeight };
    const start = fracToRect({ xFrac: spec.x, yFrac: spec.y, wFrac: spec.w, hFrac: spec.h }, ws);
    const sx = ev.clientX, sy = ev.clientY;
    const hasN = dir.includes("n"), hasS = dir.includes("s");
    const hasE = dir.includes("e"), hasW = dir.includes("w");
    const minW = 160, minH = 80;
    const { vLines, hLines } = this._getSnapLines(spec.id);
    const move = (e) => {
      let x = start.x, y = start.y, w = start.w, h = start.h;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (hasE) w = Math.max(minW, start.w + dx);
      if (hasS) h = Math.max(minH, start.h + dy);
      if (hasW) {
        const newW = Math.max(minW, start.w - dx);
        x = start.x + (start.w - newW);
        w = newW;
      }
      if (hasN) {
        const newH = Math.max(minH, start.h - dy);
        y = start.y + (start.h - newH);
        h = newH;
      }
      const snapped = snapResize({ x, y, w, h }, dir, vLines, hLines);
      const clamped = clampToDock(snapped, ws);
      const frac = rectToFrac(clamped, ws);
      spec.x = frac.xFrac; spec.y = frac.yFrac;
      spec.w = frac.wFrac; spec.h = frac.hFrac;
      Object.assign(frameEl.style, {
        left: clamped.x + "px",
        top: clamped.y + "px",
        width: clamped.w + "px",
        height: clamped.h + "px",
      });
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  // Pane drag ─────────────────────────────────────────────────────────────
  //
  // Mousedown on a tab starts a pane-drag. If released without significant
  // motion, it's a click and we just switch tabs. If the pointer leaves the
  // tab bar by more than a few pixels, we "tear out" the pane: remove it
  // from the source frame's tree, create a fresh frame holding just that
  // pane at the cursor, and continue tracking the drag as an inter-frame
  // move. On release the torn frame either stays where it is, or merges
  // into a target frame if dropped over one of its drop zones.

  _beginPaneDrag(ev, sourceFrame, paneId, tabGroup, tabBarEl) {
    ev.preventDefault();
    this._raiseFrame(sourceFrame);
    if (sourceFrame._activeTabGroup !== tabGroup) {
      sourceFrame._activeTabGroup = tabGroup;
      sourceFrame._renderInternal();
    }

    const pid = ev.pointerId;
    const startX = ev.clientX, startY = ev.clientY;
    let tornFrame = null;
    let drop = null;
    let liveBar = tabBarEl;
    let ghost = null;
    let indicator = null;
    let inBarDrag = false;
    let dropIdx = -1;
    let grabOffsetX = 0;

    const findLiveBar = () => {
      for (const child of sourceFrame.bodyEl.children) {
        if (child.classList?.contains("mkui-tabbar") && child._tabGroup === tabGroup) return child;
      }
      return null;
    };

    const createGhost = () => {
      const spec = this._panes.get(paneId);
      const label = spec?.title ?? paneId;
      ghost = document.createElement("div");
      ghost.className = "mkui-tab-drag-ghost";
      ghost.textContent = label;
      this.appendChild(ghost);
      indicator = document.createElement("div");
      indicator.className = "mkui-tab-drop-indicator";
      this.appendChild(indicator);
      const tabs = liveBar.querySelectorAll(".mkui-tab");
      const idx = tabGroup.children.indexOf(paneId);
      if (idx >= 0 && idx < tabs.length) {
        grabOffsetX = startX - tabs[idx].getBoundingClientRect().left;
        tabs[idx].classList.add("dragging");
      }
    };

    const destroyGhost = () => {
      if (ghost) { ghost.remove(); ghost = null; }
      if (indicator) { indicator.remove(); indicator = null; }
      liveBar?.querySelectorAll(".mkui-tab.dragging")
        .forEach((t) => t.classList.remove("dragging"));
    };

    const calcDropIdx = (clientX) => {
      const tabs = liveBar.querySelectorAll(".mkui-tab");
      for (let i = 0; i < tabs.length; i++) {
        const r = tabs[i].getBoundingClientRect();
        if (clientX < r.left + r.width / 2) return i;
      }
      return tabs.length;
    };

    const updateIndicator = () => {
      const tabs = liveBar.querySelectorAll(".mkui-tab");
      const barRect = liveBar.getBoundingClientRect();
      let x;
      if (dropIdx < tabs.length) x = tabs[dropIdx].getBoundingClientRect().left;
      else if (tabs.length > 0) x = tabs[tabs.length - 1].getBoundingClientRect().right;
      else x = barRect.left;
      Object.assign(indicator.style, {
        position: "fixed",
        left: (x - 1) + "px",
        top: barRect.top + "px",
        height: barRect.height + "px",
        zIndex: "10002",
      });
    };

    const tearOut = (e) => {
      const newSourceTree = removePane(sourceFrame.getTree(), paneId);
      sourceFrame.setTree(newSourceTree);
      const wr = this.getBoundingClientRect();
      const ws = { x: 0, y: 0, w: this.clientWidth, h: this.clientHeight };
      const w = 360, h = 260;
      const px = e.clientX - wr.left - Math.min(120, w / 2);
      const py = e.clientY - wr.top - 14;
      const frac = rectToFrac(clampToDock({ x: px, y: py, w, h }, ws), ws);
      tornFrame = this._createFrameFor(paneId, frac);
    };

    const onMove = (e) => {
      if (e.pointerId !== pid) return;

      if (!tornFrame && !inBarDrag) {
        const dist = Math.hypot(e.clientX - startX, e.clientY - startY);
        if (dist < 6) return;
        const fresh = findLiveBar();
        if (fresh) liveBar = fresh;
        const bar = liveBar.getBoundingClientRect();
        const outside =
          e.clientX < bar.left - 4 || e.clientX > bar.right + 4 ||
          e.clientY < bar.top - 8  || e.clientY > bar.bottom + 8;
        if (outside) { tearOut(e); return; }
        inBarDrag = true;
        createGhost();
      }

      if (inBarDrag) {
        const bar = liveBar.getBoundingClientRect();
        Object.assign(ghost.style, {
          position: "fixed",
          left: (e.clientX - grabOffsetX) + "px",
          top: bar.top + "px",
          zIndex: "10002",
        });
        const outside =
          e.clientX < bar.left - 4 || e.clientX > bar.right + 4 ||
          e.clientY < bar.top - 8  || e.clientY > bar.bottom + 8;
        if (outside) {
          destroyGhost();
          inBarDrag = false;
          tearOut(e);
          return;
        }
        dropIdx = calcDropIdx(e.clientX);
        updateIndicator();
        return;
      }

      if (tornFrame) {
        const wr = this.getBoundingClientRect();
        const ws = { x: 0, y: 0, w: this.clientWidth, h: this.clientHeight };
        const el = this._frameEls.get(tornFrame.id);
        const spec = tornFrame;
        const start = fracToRect({ xFrac: spec.x, yFrac: spec.y, wFrac: spec.w, hFrac: spec.h }, ws);
        const clamped = clampToDock(
          { x: e.clientX - wr.left - 120, y: e.clientY - wr.top - 14, w: start.w, h: start.h },
          ws,
        );
        const frac = rectToFrac(clamped, ws);
        spec.x = frac.xFrac; spec.y = frac.yFrac;
        Object.assign(el.style, { left: clamped.x + "px", top: clamped.y + "px" });

        drop = this._hitTestForDrop(el, e.clientX, e.clientY);
        if (drop) this._showDropOverlay(drop.previewRect);
        else this._hideDropOverlay();
      }
    };

    const finish = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", finish);
      destroyGhost();
      this._hideDropOverlay();
    };

    const onUp = (e) => {
      if (e.pointerId !== pid) return;
      finish();

      if (!tornFrame && !inBarDrag) {
        const i = tabGroup.children.indexOf(paneId);
        if (i >= 0 && i !== tabGroup.active) {
          tabGroup.active = i;
          sourceFrame._renderInternal();
        }
        return;
      }

      if (inBarDrag) {
        const curIdx = tabGroup.children.indexOf(paneId);
        const effective = dropIdx > curIdx ? dropIdx - 1 : dropIdx;
        if (effective !== curIdx && effective >= 0 && effective < tabGroup.children.length) {
          tabGroup.children.splice(curIdx, 1);
          tabGroup.children.splice(effective, 0, paneId);
          tabGroup.active = effective;
        } else {
          tabGroup.active = curIdx;
        }
        sourceFrame._activeTabGroup = tabGroup;
        sourceFrame._renderInternal();
        return;
      }

      if (drop) {
        const targetFrame = drop.targetFrame;
        const newTree = insertPane(targetFrame.getTree(), drop.targetPaneId, drop.side, paneId);
        targetFrame.setTree(newTree);
        this.closeFrame(tornFrame.id);
        this._raiseFrame(targetFrame);
      }
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", finish);
  }

  _createFrameFor(paneId, frac) {
    const spec = {
      id: this._nextFrameId(),
      title: null,
      x: frac.xFrac, y: frac.yFrac,
      w: frac.wFrac, h: frac.hFrac,
      layout: { type: "tabs", active: 0, children: [paneId] },
    };
    this._frames.push(spec);
    const el = document.createElement("mkui-frame");
    el.setAttribute("data-id", spec.id);
    this.appendChild(el);
    if (!el._built) el._build();
    el.setup(this, this._app, spec);
    this._frameEls.set(spec.id, el);
    this._layoutFrames();
    this._applyZOrder();
    return spec;
  }

  // Hit-test every frame (top-most first) for a drop zone under the cursor.
  _hitTestForDrop(exceptEl, clientX, clientY) {
    for (let i = this._frames.length - 1; i >= 0; i--) {
      const spec = this._frames[i];
      const el = this._frameEls.get(spec.id);
      if (!el || el === exceptEl) continue;
      const body = el.bodyEl.getBoundingClientRect();
      if (clientX < body.left || clientX > body.right ||
          clientY < body.top  || clientY > body.bottom) continue;
      const bx = clientX - body.left;
      const by = clientY - body.top;
      const bodyRect = { x: 0, y: 0, w: body.width, h: body.height };
      const { panes, tabBars } = layout(el.getTree(), bodyRect);

      // Tab bar hit → center drop on that tab group.
      for (const tb of tabBars) {
        const r = tb.rect;
        if (bx >= r.x && bx <= r.x + r.w && by >= r.y && by <= r.y + r.h) {
          const firstId = tb.tabGroup.children[0];
          const paneInfo = panes.get(firstId);
          const full = paneInfo
            ? { x: r.x, y: r.y, w: r.w, h: r.h + paneInfo.rect.h }
            : r;
          return {
            targetFrame: el,
            targetPaneId: firstId,
            side: "center",
            previewRect: this._frameBodyLocalToWorkspace(el, full),
          };
        }
      }

      // Otherwise, hit-test the visible panes for edge/center drops.
      for (const [id, info] of panes) {
        if (!info.visible) continue;
        const r = info.rect;
        if (bx < r.x || bx > r.x + r.w || by < r.y || by > r.y + r.h) continue;
        const zone = dropZoneFor(r, bx, by);
        if (!zone) continue;
        const pr = previewRect(r, zone);
        return {
          targetFrame: el,
          targetPaneId: id,
          side: zone,
          previewRect: this._frameBodyLocalToWorkspace(el, pr),
        };
      }
    }
    return null;
  }

  _frameBodyLocalToWorkspace(frameEl, localRect) {
    const wr = this.getBoundingClientRect();
    const body = frameEl.bodyEl.getBoundingClientRect();
    return {
      x: body.left - wr.left + localRect.x,
      y: body.top  - wr.top  + localRect.y,
      w: localRect.w,
      h: localRect.h,
    };
  }

  _showDropOverlay(r) {
    if (!this._dropOverlay) {
      this._dropOverlay = document.createElement("div");
      this._dropOverlay.className = "mkui-dropzone";
      this.appendChild(this._dropOverlay);
    }
    Object.assign(this._dropOverlay.style, {
      left: r.x + "px", top: r.y + "px",
      width: r.w + "px", height: r.h + "px",
      display: "",
      zIndex: 10000,
    });
  }
  _hideDropOverlay() {
    if (this._dropOverlay) this._dropOverlay.style.display = "none";
  }
}

if (!customElements.get("mkui-workspace")) customElements.define("mkui-workspace", MkuiWorkspace);
export { MkuiWorkspace };
