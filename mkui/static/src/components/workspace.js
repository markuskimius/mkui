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
import { getPaneType, getWidget, getPaneTypeKeys } from "../core.js";
import { clampToDock, rectToFrac, fracToRect, dropZoneFor, previewRect, snapMove, snapResize, cascadePosition } from "../layout/drag.js";
import { layout, normalize, insertPane, removePane, findPane, firstTabGroup, listPanes } from "../layout/tree.js";
import { sanitizeLayout, pruneTree, LAYOUT_VERSION } from "../lib/layouts.js";

// Write a frame rect to an element's style in whole pixels. Frame geometry
// is fractional (frac × workspace size, pointer deltas), but the frame's
// internal layout measures its body via clientWidth/clientHeight — integers
// — so a fractional frame size leaves a sub-pixel sliver of frame background
// along the bottom/right edge (a hairline under a pane's horizontal
// scrollbar). Rounding the edges (not width/height independently) keeps
// frames flush with the dock and with frames they're snapped against.
function applyFrameRect(el, r) {
  const x = Math.round(r.x), y = Math.round(r.y);
  Object.assign(el.style, {
    left: x + "px",
    top: y + "px",
    width: (Math.round(r.x + r.w) - x) + "px",
    height: (Math.round(r.y + r.h) - y) + "px",
  });
}

// The keys any pane may carry beside its type's own, and the ones the
// workspace writes onto a spec at run time (`renamePane`, `setPaneAutoTitle`).
const PANE_COMMON_KEYS = new Set(["title", "type", "widgets", "content"]);
const PANE_RUNTIME_KEYS = new Set(["titled", "baseTitle"]);

class MkuiWorkspace extends HTMLElement {
  constructor() {
    super();
    this._built = false;
    this._app = null;
    this._panes = new Map();        // paneId  -> pane spec
    this._paneEls = new Map();      // paneId  -> <mkui-pane> (authoritative)
    this._keysReported = new Set(); // paneIds whose unknown keys were reported
    this._frames = [];              // frame specs, order = z-order (last = top)
    this._frameEls = new Map();     // frameId -> <mkui-frame>
    this._pool = null;              // hidden stash for detached panes
    // paneId -> { frame: { x, y, w, h, title }, ...view state }: the windows
    // closed this session (or by a restored layout), each remembered as it
    // was so `showPane` brings it back there. See Saved layouts.
    this._closed = new Map();
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
    const t = e.target;
    const inText = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);

    // Edit shortcuts (Ctrl/Cmd+C, +A, +F, +G, +Shift+G, Escape) route to the focused
    // frame's active pane via its _editActions hook. Guards: text inputs
    // and native text selections always win — the browser's own
    // copy/select-all must keep working.
    if (!inText) {
      if (e.key === "Escape") {
        // A pane that can be dismissed (a dialog) goes first; the rest
        // clear their selection.
        if (this.editAction("cancel") || this.editAction("clearSelection")) e.preventDefault();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        const k = typeof e.key === "string" ? e.key.toLowerCase() : "";
        // Ctrl/Cmd+G steps to the next find match, with shift the previous
        // — the browser's own find-next keys, taken over with Ctrl/Cmd+F.
        if (k === "g") {
          if (this.editAction(e.shiftKey ? "findPrev" : "findNext")) e.preventDefault();
          return;
        }
        if (e.shiftKey) return;
        if (k === "c") {
          const sel = typeof window !== "undefined" && window.getSelection
            ? window.getSelection() : null;
          if (sel && !sel.isCollapsed) return;
          if (this.editAction("copy")) e.preventDefault();
          return;
        }
        if (k === "a") {
          if (this.editAction("selectAll")) e.preventDefault();
          return;
        }
        if (k === "f") {
          // Taken over from the browser: its own find can't see a
          // virtualized table's off-screen rows.
          if (this.editAction("find")) e.preventDefault();
          return;
        }
      }
    }

    if (!(e.altKey && e.shiftKey)) return;
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    if (inText) return;
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

  // The pane element with keyboard focus per the frame focus model: the
  // focused frame's active tab group's active tab.
  activePaneEl() {
    const el = this._frameEls.get(this._focusedId);
    if (!el?.getTree) return null;
    const tg = el._activeTabGroup ?? firstTabGroup(el.getTree());
    const id = tg?.children?.[tg.active ?? 0];
    return id != null ? this._paneEls.get(id) ?? null : null;
  }

  // What has the focus, for a menu's expressions (lib/menu.js): the
  // active pane as `{ id, type, title, can }` — `can` the edit actions it
  // answers (`can.copy`, `can.find`, `can.undo`, …: its `_editActions`) —
  // and its selection as `{ count, focused }`, null for a pane with no
  // `_select` hook; or null when no frame is focused.
  focusInfo() {
    const el = this.activePaneEl();
    if (!el) return null;
    const id = el.getAttribute?.("data-id") ?? el.dataset?.id ?? null;
    const spec = id != null ? this._panes.get(id) : null;
    const sel = el._select?.get?.() ?? null;
    return {
      pane: {
        id, type: spec?.type ?? null, title: spec?.title ?? id,
        can: Object.fromEntries(Object.entries(el._editActions ?? {}).filter(([, fn]) => typeof fn === "function").map(([k]) => [k, true])),
      },
      selection: sel ? { count: sel.keys?.length ?? 0, focused: sel.focus != null } : null,
    };
  }

  // Fire an edit action ("copy" | "selectAll" | "clearSelection" | "find" |
  // "findNext" | "findPrev" | "undo" | "redo" | "cancel") on the
  // active pane's _editActions hook. Returns whether the pane handled it —
  // false means the caller should leave the browser default alone.
  editAction(name) {
    const fn = this.activePaneEl()?._editActions?.[name];
    return fn ? fn() !== false : false;
  }

  // A pane's view hook (`_filters`, `_sort`, `_columns`, `_link`, `_tree`,
  // or `_select`, exposed by mkio-table). By
  // id, a pane that was never shown is built first when `build` is set,
  // so a setter can run ahead of opening it; with no id, the focused
  // frame's active pane is the target.
  _paneHook(paneId, name, build) {
    const el = paneId == null ? this.activePaneEl()
      : build ? (this._panes.has(paneId) ? this._ensurePaneEl(paneId) : null)
      : this._paneEls.get(paneId);
    return el?.[name] ?? null;
  }

  // Column filters: `filters` maps column names to the config-shaped
  // filters the pane's `filters` key takes, replacing the current set
  // unless `merge` is set. Returns whether a pane took the filters.
  setPaneFilters(paneId, filters, opts = {}) {
    const hook = this._paneHook(paneId, "_filters", true);
    if (!hook) return false;
    hook.set(filters, opts);
    return true;
  }

  // The same shape back, or null when the pane has no filters hook.
  getPaneFilters(paneId) {
    return this._paneHook(paneId, "_filters", false)?.get() ?? null;
  }

  // Sort order: the shape the pane's `sort` key takes — a column name
  // ("-col" descending), `{ col, dir }`, or an array in priority order;
  // null clears. Returns whether a pane took it.
  setPaneSort(paneId, sort) {
    const hook = this._paneHook(paneId, "_sort", true);
    if (!hook) return false;
    hook.set(sort);
    return true;
  }

  // `[{ col, dir }]` in priority order, or null without a sort hook.
  getPaneSort(paneId) {
    return this._paneHook(paneId, "_sort", false)?.get() ?? null;
  }

  // Visible columns: the shape the pane's `visible` key takes — a column
  // name or an array in display order; null shows every column (and follows
  // new ones). Returns whether a pane took it.
  setPaneColumns(paneId, visible) {
    const hook = this._paneHook(paneId, "_columns", true);
    if (!hook) return false;
    hook.set(visible);
    return true;
  }

  // The list back, null when every column shows (or without a columns hook).
  getPaneColumns(paneId) {
    return this._paneHook(paneId, "_columns", false)?.get() ?? null;
  }

  // Table links: the shape the pane's `link` key takes — `{ broadcast,
  // listen, broadcasting, listening }`; `merge` overlays the keys given
  // (a null name entry drops it), else the whole configuration is
  // replaced (null clears). Returns whether a pane took it.
  setPaneLink(paneId, link, opts = {}) {
    const hook = this._paneHook(paneId, "_link", true);
    if (!hook) return false;
    hook.set(link, opts);
    return true;
  }

  // The same shape back, or null without a link hook.
  getPaneLink(paneId) {
    return this._paneHook(paneId, "_link", false)?.get() ?? null;
  }

  // Tree tables: open rows down to `depth` (a number, or "all"; 0 closes
  // every row). Returns whether a pane took it.
  expandPane(paneId, depth) {
    const hook = this._paneHook(paneId, "_tree", true);
    if (!hook) return false;
    hook.expand(depth);
    return true;
  }

  // Select rows by identity (`_mkio_row` / `_mkio_ref` / `_mkio_topic`),
  // as a click would: the selection publishes and broadcasts, collapsed
  // tree ancestors open, filters stay. `opts.focus` (default true) moves
  // the cursor to the first key and scrolls to it. Returns false without
  // a pane, else `{ ok, selected, missing, hidden }` — `missing` keys are
  // not loaded, `hidden` ones a filter keeps out; `ok` when every key
  // resolved. An empty list clears the selection.
  selectPane(paneId, keys, opts = {}) {
    const hook = this._paneHook(paneId, "_select", true);
    if (!hook) return false;
    return hook.set(keys, opts);
  }

  // `{ keys, focus }` — the rows the selection implies and the cursor's
  // row — or null without a selection hook.
  getPaneSelection(paneId) {
    return this._paneHook(paneId, "_select", false)?.get() ?? null;
  }

  // Subscribe to a pane's selection: `fn` runs on every change, and the
  // returned function unsubscribes. null when the pane has no selection to
  // follow. A detail pane (mkio-history) follows a table this way.
  onPaneSelection(paneId, fn) {
    return this._paneHook(paneId, "_select", false)?.on?.(fn) ?? null;
  }

  // A pane's record-history hook — `{ spec, rows }`, the parsed `history`
  // block and the rows its selection implies — or null when the pane has
  // no history configured.
  paneHistory(paneId) {
    return this._paneHook(paneId, "_history", false);
  }

  // The rows a pane's selection implies — what a detail window follows
  // when its `record.follow` names this pane. A table with a `history`
  // block answers through that hook (it knows which rows are records);
  // any other table answers with its selected rows. Never builds a pane:
  // an unopened one has no selection to speak of.
  paneRows(paneId) {
    const el = paneId == null ? this.activePaneEl() : this._paneEls.get(paneId);
    if (!el) return [];
    return el._history?.rows?.() ?? el._data?.selected?.() ?? [];
  }

  // The record a detail pane is about: `key` maps its key columns to
  // values, `null` empties it. Returns whether a pane took it.
  setPaneRecord(paneId, key) {
    const hook = this._paneHook(paneId, "_record", true);
    if (!hook) return false;
    hook.set(key);
    return true;
  }

  // `{ key, row, of, from }` — the record on show and where it came from
  // — or null without a record hook.
  getPaneRecord(paneId) {
    return this._paneHook(paneId, "_record", false)?.get() ?? null;
  }

  // Where a detail pane gets its subject: the shape its `record` block
  // takes (`{ follow | listen | state | key, retain, listening, title }`).
  // Under `merge` only the keys given change. Returns whether a pane
  // took it.
  setPaneRecordSource(paneId, spec, opts = {}) {
    const hook = this._paneHook(paneId, "_record", true);
    if (!hook) return false;
    return hook.follow(spec, opts) !== false;
  }

  // The same shape back, or null without a record hook.
  getPaneRecordSource(paneId) {
    return this._paneHook(paneId, "_record", false)?.config() ?? null;
  }

  // Subscribe to a pane's record: `fn` runs on every change, and the
  // returned function unsubscribes. null when the pane has no record.
  onPaneRecord(paneId, fn) {
    return this._paneHook(paneId, "_record", false)?.on?.(fn) ?? null;
  }

  // Send a table's selected record to a detail pane: raise it, then hand
  // it the row (every field, so the pane picks whichever columns are its
  // key). `from` names the table, else the focused pane answers. This is
  // the `table.record` action — the way to fill a detail window that
  // listens for nothing.
  showPaneRecord(paneId, opts = {}) {
    if (paneId == null) return false;
    const row = this.paneRows(opts.from ?? null)[0] ?? null;
    this.showPane(paneId);
    const el = this._paneEls.get(paneId);
    // A pane built just now installs its hook as its factory settles.
    if (el && !el._record && el._ready) {
      el._ready.then(() => el._record?.set(row));
      return true;
    }
    return this.setPaneRecord(paneId, row);
  }

  // Open (or raise) the history pane for a table pane's selected record:
  // one history pane per table, so firing it again re-points the one that
  // is open rather than piling up windows. `keys` selects those rows in
  // the table first, so a deep link can name the record it means. Returns
  // false when the pane has no `history` block to read.
  showPaneHistory(paneId = null, keys = null) {
    const el = paneId == null ? this.activePaneEl() : this._paneEls.get(paneId);
    const srcId = el?.dataset?.id ?? paneId;
    if (srcId == null || !el?._history) return false;
    if (keys && keys.length) this.selectPane(srcId, keys);

    const id = `_history:${srcId}`;
    if (!this._panes.has(id)) {
      // Just "History": the record it lands on names the tab from there
      // (`setPaneAutoTitle`), and "History — 4711" is what tells two of
      // these apart — the table's name would only push the record's off
      // the end of a crowded tab bar.
      this.registerPane(id, { type: "mkio-history", source: srcId, title: "History" });
    }
    this.showPane(id);
    // An open pane re-reads the selection; a pane built just now reads it
    // as it starts, and its factory may still be awaiting its client.
    const hist = this._paneEls.get(id);
    if (hist?._record) hist._record.refresh();
    else hist?._ready?.then(() => hist._record?.refresh());
    return true;
  }

  setApp(app) {
    this._app = app;
    this._panes = new Map(Object.entries(app.config.panes ?? {}));
    // Every pane the config declares, checked now for keys its type does
    // not read; a type registered later than this is checked when its
    // first pane is built (`_ensurePaneEl`), once per pane either way.
    for (const [id, spec] of this._panes) this._reportUnknownPaneKeys(id, spec);
    this._frames = this._configFrameSpecs(app.config.frames);
    if (this._frames.length > 0) {
      this._focusedId = this._frames[this._frames.length - 1].id;
    }
    this._renderFrames();
  }

  // Frame specs from the config's `frames` array — the startup layout,
  // which `resetLayout` returns to. An entry with `open = false` is
  // defined but not opened: a window `showFrame` brings up on demand.
  // Fresh spec objects each call: specs are mutated by moves and resizes.
  _configFrameSpecs(frames) {
    return (frames ?? []).map((f, i) => f.open === false ? null : this._frameSpecFrom(f, i)).filter(Boolean);
  }

  _frameSpecFrom(f, i = 0) {
    return {
      id: f.id ?? this._nextFrameId(),
      title: f.title ?? null,
      x: f.x ?? (0.08 + i * 0.03),
      y: f.y ?? (0.08 + i * 0.03),
      w: f.w ?? 0.5,
      h: f.h ?? 0.5,
      layout: f.layout,
    };
  }

  // The windows the config defines, in its order: `{ id, title, open }`,
  // `open` false for one kept closed at startup. What a `{ frames = true }`
  // menu item lists.
  configFrames() {
    return (this._app?.config?.frames ?? [])
      .filter(f => f && typeof f.id === "string" && f.id)
      .map(f => ({ id: f.id, title: f.title ?? null, open: f.open !== false }));
  }

  getPaneSpec(id) { return this._panes.get(id); }

  registerPane(id, spec) {
    this._panes.set(id, spec);
  }

  unregisterPane(id) {
    const el = this._paneEls.get(id);
    if (el) el.remove();
    this._paneEls.delete(id);
    this._panes.delete(id);
    this._closed.delete(id);
  }

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
    // `_ready` resolves once an async pane factory (mkio-table awaits its
    // client) has finished — its hooks (`_filters`, ...) exist only then.
    el._ready = null;
    // In the pool before its content is built: a pane factory that looks
    // up the workspace it lives in (`closest("mkui-workspace")`, as
    // mkio-history does to follow another pane) would otherwise be run
    // against a detached element.
    this._paneEls.set(id, el);
    this._pool.appendChild(el);
    if (spec) {
      this._reportUnknownPaneKeys(id, spec);
      el._ready = this._buildPaneContent(el.contentEl, spec);
    } else el.contentEl.textContent = `[mkui] unknown pane: ${id}`;
    return el;
  }

  _parkPane(el) {
    if (el.parentElement !== this._pool) this._pool.appendChild(el);
    el.style.display = "none";
  }

  // A pane key its type does not read is a mistake nobody sees — mkui reads
  // the keys it knows and leaves the rest — so it is reported on the console
  // (console.error, the browser's stderr), once per pane. A type's keys are
  // what it gave `registerPaneType`; a custom type that gave none is not
  // checked. A widgets/content pane takes the common keys alone. Returns
  // the unknown keys.
  _reportUnknownPaneKeys(id, spec) {
    if (!spec || typeof spec !== "object" || this._keysReported.has(id)) return [];
    const own = spec.type ? getPaneTypeKeys(spec.type)
      : (spec.widgets || spec.content !== undefined) ? new Set() : null;
    if (!own) return [];
    this._keysReported.add(id);
    const unknown = Object.keys(spec).filter(k => !own.has(k) && !PANE_COMMON_KEYS.has(k) && !PANE_RUNTIME_KEYS.has(k));
    if (unknown.length) {
      const known = [...new Set([...PANE_COMMON_KEYS, ...own])].sort().join(", ");
      const what = spec.type ? `pane type ${spec.type}` : "a widgets pane";
      console.error(`[mkui] pane "${id}": unknown key${unknown.length > 1 ? "s" : ""} ` +
        `${unknown.map(k => `"${k}"`).join(", ")} — ${what} takes ${known}`);
    }
    return unknown;
  }

  // Returns the factory's promise for an async pane type, else null.
  _buildPaneContent(host, spec) {
    if (spec.type) {
      const typeFn = getPaneType(spec.type);
      if (typeFn) {
        const result = typeFn(spec, this._app, host);
        if (result instanceof Promise) {
          return result.catch(e => { host.textContent = String(e); });
        }
        return null;
      }
      host.textContent = `[mkui] unknown pane type: ${spec.type}`;
      return null;
    }
    if (spec.widgets) {
      for (const w of spec.widgets) {
        const fn = getWidget(w.type);
        if (fn) fn(w, this._app, host);
      }
      return null;
    }
    if (spec.content) host.textContent = spec.content;
    return null;
  }

  // Frame lifecycle ──────────────────────────────────────────────────────

  // Create and register the <mkui-frame> for a spec already in `_frames`.
  _mountFrame(spec) {
    const el = document.createElement("mkui-frame");
    el.setAttribute("data-id", spec.id);
    this.appendChild(el);
    if (!el._built) el._build();
    el.setup(this, this._app, spec);
    this._frameEls.set(spec.id, el);
    return el;
  }

  _renderFrames() {
    for (const spec of this._frames) {
      if (!this._frameEls.has(spec.id)) this._mountFrame(spec);
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
      applyFrameRect(el, r);
    }
  }

  _applyZOrder() {
    const normal = [];
    const onTop = [];
    for (const spec of this._frames) {
      if (spec.stayOnTop) onTop.push(spec);
      else normal.push(spec);
    }
    const ordered = [...normal, ...onTop];
    // Two z-steps a frame, so the scrim can sit under the modal one.
    let modalAt = -1;
    for (let i = 0; i < ordered.length; i++) {
      const el = this._frameEls.get(ordered[i].id);
      if (!el) continue;
      el.style.zIndex = 10 + 2 * i;
      if (ordered[i].modal) modalAt = i;
      if (ordered[i].id === this._focusedId) el.setAttribute("data-focused", "");
      else el.removeAttribute("data-focused");
    }
    this._applyScrim(modalAt < 0 ? null : ordered[modalAt], 10 + 2 * modalAt - 1);
  }

  // A `modal` frame (a confirm) keeps the pointer off everything under it:
  // `.mkui-scrim` covers the workspace just below the top-most modal
  // frame, and the app root's `[modal]` stills the menubar and statusbar
  // (CSS). A press on the scrim goes nowhere but back to that frame.
  _applyScrim(spec, z) {
    const root = this.closest?.("mkui-app") ?? null;
    if (!spec) {
      this._scrim?.remove();
      this._scrim = null;
      root?.removeAttribute("modal");
      return;
    }
    if (!this._scrim) {
      this._scrim = document.createElement("div");
      this._scrim.className = "mkui-scrim";
      this._scrim.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const top = [...this._frames].reverse().find((f) => f.modal);
        const el = top && this._frameEls.get(top.id);
        if (!el) return;
        el.classList.remove("mkui-frame-nudge");
        void el.offsetWidth;
        el.classList.add("mkui-frame-nudge");
      });
      this.appendChild(this._scrim);
    }
    this._scrim.style.zIndex = z;
    root?.setAttribute("modal", "");
  }

  _raiseFrame(frameEl) {
    const id = frameEl.getAttribute("data-id");
    const idx = this._frames.findIndex(f => f.id === id);
    if (idx < 0) return;
    this._focusedId = id;
    const spec = this._frames[idx];
    if (spec.stayOnTop) {
      if (idx === this._frames.length - 1) { this._applyZOrder(); return; }
      this._frames.splice(idx, 1);
      this._frames.push(spec);
    } else {
      const firstOnTop = this._frames.findIndex(f => f.stayOnTop);
      const target = firstOnTop < 0 ? this._frames.length - 1 : firstOnTop - 1;
      if (idx === target) { this._applyZOrder(); return; }
      this._frames.splice(idx, 1);
      const insertAt = firstOnTop < 0 ? this._frames.length : this._frames.findIndex(f => f.stayOnTop);
      this._frames.splice(insertAt, 0, spec);
    }
    this._applyZOrder();
  }

  closeFrame(id) {
    const idx = this._frames.findIndex(f => f.id === id);
    if (idx < 0) return;
    const spec = this._frames[idx];
    const el = this._frameEls.get(id);
    if (el) {
      // A closed window is remembered before its panes hear of it: what a
      // dialog or the login frame held is not (they are never in a layout).
      if (!spec.noDock && !spec.stayOnTop) {
        for (const paneId of listPanes(el.getTree?.() ?? null)) this._rememberPane(paneId, spec);
      }
      for (const child of [...el.bodyEl.children]) {
        if (child.tagName === "MKUI-PANE") {
          child.dispatchEvent(new CustomEvent("mkui-pane-close"));
          this._parkPane(child);
        }
      }
      el.remove();
    }
    this._frameEls.delete(id);
    this._frames.splice(idx, 1);
    // The focus falls to the new top-most frame — under a closing dialog,
    // the one it was opened over — so the keyboard and the Edit menu still
    // have a pane to act on; then z-order paints `data-focused` on it.
    if (this._focusedId === id) this._focusedId = this._frames[this._frames.length - 1]?.id ?? null;
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
      stayOnTop: spec.stayOnTop ?? false,
      noDock: spec.noDock ?? false,
      modal: spec.modal === true,
    };
    this._frames.push(s);
    this._focusedId = s.id;
    this._mountFrame(s);
    this._layoutFrames();
    this._applyZOrder();
    return s.id;
  }

  // Saved layouts ─────────────────────────────────────────────────────────
  //
  // A layout is the dockable frames (z-order, fractional rects, trees —
  // so the active tabs come along) plus the view state of every pane open
  // in one, read through the `_filters` / `_sort` / `_columns` / `_link`
  // hooks — and the windows that were closed: for a pane in no frame,
  // `_closed` keeps the rect and title of the window it was last in and
  // the view state it had, snapshotted as the window closed, so `showPane`
  // brings it back where and as it was. The layout carries those entries
  // too (`panes[id].frame`), a restore takes them over, and a reset
  // forgets them. Modal dialogs and the login frame (noDock) are never
  // part of one. See lib/layouts.js for the format; src/layouts.js for
  // the menu and stores.

  _dockedFrames() {
    return this._frames.filter(f => !f.noDock && !f.stayOnTop);
  }

  _openPaneIds() {
    const out = new Set();
    for (const spec of this._dockedFrames()) {
      const tree = this._frameEls.get(spec.id)?.getTree?.();
      if (tree) for (const id of listPanes(tree)) out.add(id);
    }
    return out;
  }

  // A pane's view state through its hooks: what a layout carries for it.
  _paneState(el) {
    const st = {};
    if (el._filters) st.filters = el._filters.get();
    if (el._sort) st.sort = el._sort.get();
    if (el._columns) st.visible = el._columns.get();
    if (el._link) st.link = el._link.get();
    // A detail window's subject configuration — where it gets its
    // records, and whether it is pinned. Never the record itself: that
    // comes back from the live broadcast, as a link's filters do.
    if (el._record) st.record = el._record.config();
    return st;
  }

  // Saved view state onto a pane — once its hooks exist: a pane built just
  // now by an async factory (the startup restore, a first `showPane`) gets
  // them only when `_ready` resolves; a later application supersedes a
  // pending one.
  _applyPaneState(el, st) {
    const apply = () => {
      if ("filters" in st) el._filters?.set(st.filters);
      if ("sort" in st) el._sort?.set(st.sort);
      if ("visible" in st) el._columns?.set(st.visible);
      if ("link" in st) el._link?.set(st.link);
      if ("record" in st) el._record?.follow(st.record);
    };
    const gen = el._viewGen = (el._viewGen ?? 0) + 1;
    if (el._filters || el._sort || el._columns || el._link || el._record || !el._ready) apply();
    else el._ready.then(() => { if (el._viewGen === gen) apply(); });
  }

  // Remember a pane's window as it closes: the frame it sat in and the
  // view state it has now — read before the close event, which is what
  // the pane will come back to.
  _rememberPane(id, spec) {
    const el = this._paneEls.get(id);
    if (!el) return;
    const frame = { x: spec.x, y: spec.y, w: spec.w, h: spec.h, title: spec.title ?? null };
    this._closed.set(id, structuredClone({ frame, ...this._paneState(el) }));
  }

  getLayout() {
    const frames = [];
    for (const spec of this._dockedFrames()) {
      const tree = this._frameEls.get(spec.id)?.getTree?.();
      if (!tree) continue;
      frames.push({
        id: spec.id, title: spec.title ?? null,
        x: spec.x, y: spec.y, w: spec.w, h: spec.h,
        layout: structuredClone(tree),
      });
    }
    const panes = {};
    const open = this._openPaneIds();
    for (const id of open) {
      const el = this._paneEls.get(id);
      if (!el) continue;
      const st = this._paneState(el);
      if (Object.keys(st).length) panes[id] = structuredClone(st);
    }
    // The closed windows, as remembered.
    for (const [id, st] of this._closed) {
      if (open.has(id) || !this._panes.has(id)) continue;
      panes[id] = structuredClone(st);
    }
    const focused = frames.some(f => f.id === this._focusedId) ? this._focusedId : null;
    return { version: LAYOUT_VERSION, frames, focused, panes };
  }

  // Replace the docked frames with a layout's. Panes that stay open move
  // between frames the way a tab drag moves them, keeping their state;
  // panes leaving get `mkui-pane-close`, panes arriving `mkui-pane-open`
  // and then their saved view state (open resets a table to its config).
  // `reopen` closes and reopens every pane — the config-defaults reset
  // `resetLayout` wants, which also forgets every closed window. Throws on
  // something that isn't a layout; returns the sanitized layout, whose
  // `dropped` lists pane ids the app no longer has. A layout with no
  // frames is applied as such.
  setLayout(layout, opts = {}) {
    const clean = sanitizeLayout(layout, this._panes);
    const reopen = opts.reopen === true;
    const before = this._openPaneIds();
    const after = new Set();
    for (const f of clean.frames) for (const id of listPanes(f.layout)) after.add(id);

    this._clearMaximize();
    // Closed windows: a pane the layout closes is remembered where it is
    // now, then the layout's own closed entries take over — one it opens
    // is forgotten, a reset forgets them all.
    for (const spec of this._dockedFrames()) {
      const tree = this._frameEls.get(spec.id)?.getTree?.();
      if (!tree) continue;
      for (const id of listPanes(tree)) if (!after.has(id)) this._rememberPane(id, spec);
    }
    if (reopen) this._closed.clear();
    for (const id of after) this._closed.delete(id);
    for (const [id, st] of Object.entries(clean.panes)) {
      if (!after.has(id)) this._closed.set(id, structuredClone(st));
    }
    for (const id of before) {
      if (reopen || !after.has(id)) {
        this._paneEls.get(id)?.dispatchEvent(new CustomEvent("mkui-pane-close"));
      }
    }
    for (const spec of this._dockedFrames()) {
      const el = this._frameEls.get(spec.id);
      if (el) {
        for (const child of [...el.bodyEl.children]) {
          if (child.tagName === "MKUI-PANE") this._parkPane(child);
        }
        el.remove();
      }
      this._frameEls.delete(spec.id);
    }
    this._frames = this._frames.filter(f => f.noDock || f.stayOnTop);

    // Dockable frames sit below every stayOnTop one (dialogs, login).
    const used = new Set(this._frames.map(f => f.id));
    let at = this._frames.findIndex(f => f.stayOnTop);
    if (at < 0) at = this._frames.length;
    let last = null;
    for (const f of clean.frames) {
      const id = f.id && !used.has(f.id) ? f.id : this._nextFrameId();
      used.add(id);
      const m = /^frame-(\d+)$/.exec(id);
      if (m) this._frameSeq = Math.max(this._frameSeq, Number(m[1]));
      const spec = { id, title: f.title, x: f.x, y: f.y, w: f.w, h: f.h, layout: f.layout };
      this._frames.splice(at++, 0, spec);
      this._mountFrame(spec);
      last = id;
      if (f.id != null && f.id === clean.focused) clean.focused = id;
    }

    for (const id of after) {
      if (reopen || !before.has(id)) {
        this._paneEls.get(id)?.dispatchEvent(new CustomEvent("mkui-pane-open"));
      }
    }
    for (const [id, st] of Object.entries(clean.panes)) {
      const el = after.has(id) ? this._paneEls.get(id) : null;
      if (el) this._applyPaneState(el, st);
    }

    this._focusedId = clean.focused ?? last;
    this._layoutFrames();
    this._applyZOrder();
    return clean;
  }

  // Back to the startup layout: the config's frames, every pane at its
  // configured filters, sort, and columns, no closed window remembered —
  // as if the app had just loaded without a saved layout.
  resetLayout() {
    const frames = this._configFrameSpecs(this._app?.config?.frames);
    return this.setLayout({ version: LAYOUT_VERSION, frames, panes: {} }, { reopen: true });
  }

  showPane(paneId) {
    if (!this._panes.has(paneId)) return;
    for (const spec of this._frames) {
      const el = this._frameEls.get(spec.id);
      if (!el) continue;
      const hit = findPane(el.getTree(), paneId);
      if (hit) {
        hit.tabGroup.active = hit.tabIndex;
        el._activeTabGroup = hit.tabGroup;
        el._renderInternal();
        this._raiseFrame(el);
        return;
      }
    }
    // A parked pane: back to the window it was closed in, with the view
    // state it had (a layout may have restored it closed); else a fresh
    // window cascaded off the top one.
    const mem = this._closed.get(paneId) ?? null;
    this._closed.delete(paneId);
    const w = mem?.frame?.w ?? 0.4, h = mem?.frame?.h ?? 0.4;
    const top = this._frames[this._frames.length - 1] ?? null;
    const { x, y } = mem?.frame ?? cascadePosition(top, w, h);
    this.addFrame({
      x, y, w, h, title: mem?.frame?.title ?? null,
      layout: { type: "tabs", active: 0, children: [paneId] },
    });
    const paneEl = this._paneEls.get(paneId);
    if (!paneEl) return;
    paneEl.dispatchEvent(new CustomEvent("mkui-pane-open"));
    if (mem) this._applyPaneState(paneEl, mem);
  }

  // A window the config defines, by frame id — a composite of docked and
  // tabbed panes whose links and record sources are in their own specs,
  // so it comes up wired. Open under that id (a saved layout keeps frame
  // ids), it is raised; else it is built from its definition at the
  // definition's rect: a pane of it open in another window moves over, as
  // a tab drag would move it, and a parked one opens with the view state
  // it was closed with, as `showPane` gives it. Returns whether a window
  // was raised or opened; a definition naming no known pane warns.
  showFrame(frameId) {
    const open = this._frameEls.get(frameId);
    if (open) { this._raiseFrame(open); return true; }
    const def = (this._app?.config?.frames ?? []).find(f => f?.id === frameId);
    if (!def) return false;
    const dropped = [];
    const tree = pruneTree(def.layout, this._panes, dropped);
    if (tree == null) {
      console.warn(`mkui: frame ${frameId} names no pane the app has`);
      return false;
    }
    const spec = this._frameSpecFrom(def);
    spec.id = frameId;
    spec.layout = tree;
    const arriving = [];
    for (const paneId of listPanes(normalize(tree))) {
      let moved = false;
      for (const f of this._frames) {
        const el = this._frameEls.get(f.id);
        if (!el || !findPane(el.getTree(), paneId)) continue;
        el.setTree(removePane(el.getTree(), paneId));   // an emptied frame closes itself
        moved = true;
        break;
      }
      if (!moved) arriving.push(paneId);
    }
    this.addFrame(spec);
    for (const paneId of arriving) {
      const el = this._paneEls.get(paneId);
      if (!el) continue;
      const mem = this._closed.get(paneId) ?? null;
      this._closed.delete(paneId);
      el.dispatchEvent(new CustomEvent("mkui-pane-open"));
      if (mem) this._applyPaneState(el, mem);
    }
    return true;
  }

  // All panes currently hosted in a frame ("open windows"), in frame
  // z-order then tree order. noDock frames (dialogs, login) are excluded.
  openPanes() {
    const out = [];
    for (const spec of this._frames) {
      if (spec.noDock) continue;
      const tree = this._frameEls.get(spec.id)?.getTree();
      if (!tree) continue;
      for (const id of listPanes(tree)) {
        out.push({ id, title: this._panes.get(id)?.title ?? id });
      }
    }
    return out;
  }

  renamePane(id, title) {
    const spec = this._panes.get(id);
    // A name the user typed is theirs: `titled` stops a detail pane
    // retitling its own tab from the record it lands on.
    if (spec) { spec.title = title; spec.titled = true; }
    else this._panes.set(id, { title, titled: true });
    this._retitle(id);
  }

  // The tab a detail pane writes as it moves from record to record —
  // "History — 4711". `text` hangs off the pane's configured title, which
  // is remembered the first time so the suffix never accumulates; an
  // empty `text` puts the plain title back. A pane the user renamed
  // keeps their name. Returns whether the tab changed.
  setPaneAutoTitle(id, text) {
    const spec = this._panes.get(id);
    if (!spec || spec.titled) return false;
    if (spec.baseTitle === undefined) spec.baseTitle = spec.title ?? null;
    const base = spec.baseTitle ?? id;
    const next = text ? `${base} — ${text}` : base;
    if (spec.title === next) return false;
    spec.title = next;
    this._retitle(id);
    return true;
  }

  _retitle(id) {
    for (const el of this._frameEls.values()) {
      const tree = el.getTree();
      if (tree && findPane(tree, id)) el._renderInternal();
    }
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
        Object.assign(frameEl.style, { width: Math.round(newW) + "px", height: Math.round(newH) + "px" });
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
        left: Math.round(clamped.x) + "px",
        top: Math.round(clamped.y) + "px",
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
    // 180 keeps the top bar's minimum row intact: scroll arrows + one
    // min-width tab + reduced drag grab area + window controls.
    const minW = 180, minH = 80;
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
      applyFrameRect(frameEl, clamped);
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
        Object.assign(el.style, { left: Math.round(clamped.x) + "px", top: Math.round(clamped.y) + "px" });

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
    this._mountFrame(spec);
    this._layoutFrames();
    this._applyZOrder();
    return spec;
  }

  // Hit-test every frame (top-most first) for a drop zone under the cursor.
  _hitTestForDrop(exceptEl, clientX, clientY) {
    for (let i = this._frames.length - 1; i >= 0; i--) {
      const spec = this._frames[i];
      const el = this._frameEls.get(spec.id);
      if (!el || el === exceptEl || spec.noDock) continue;
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
