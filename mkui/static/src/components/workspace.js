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
import { wmKey, takesFromField, Mover, realMove, clickOp, plainPress, stillClick, lowerOrder, isApple, WINDOW_CLICKS } from "../lib/wm.js";
import { icon } from "../lib/icons.js";

// The smallest a resize leaves a frame. 180 keeps the top bar's minimum
// row intact: scroll arrows + one min-width tab + reduced drag grab area
// + window controls.
const MIN_FRAME_W = 180, MIN_FRAME_H = 80;

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

// Where typing goes: keys it takes (Alt/Option+letters, a word jump on
// alt+arrows) are the field's, not a shortcut's.
function isEditable(t) {
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
}

// The keys any pane may carry beside its type's own, and the ones the
// workspace writes onto a spec at run time (`renamePane`, `setPaneAutoTitle`).
const PANE_COMMON_KEYS = new Set(["title", "type", "widgets", "content"]);
const PANE_RUNTIME_KEYS = new Set(["titled", "baseTitle"]);

// Layout state key → the pane hook that takes it, if the pane has it.
const PANE_STATE_SETTERS = [
  ["filters", (el) => el._filters && ((v) => el._filters.set(v))],
  ["sort", (el) => el._sort && ((v) => el._sort.set(v))],
  ["visible", (el) => el._columns && ((v) => el._columns.set(v))],
  ["columnNumbers", (el) => el._columns?.setNumbers && ((v) => el._columns.setNumbers(v))],
  ["nested", (el) => el._tree?.setNested && ((v) => el._tree.setNested(v))],
  ["widths", (el) => el._columns?.setWidths && ((v) => el._columns.setWidths(v))],
  ["panelWidths", (el) => el._panel && ((v) => el._panel.set(v))],
  ["link", (el) => el._link && ((v) => el._link.set(v))],
  ["record", (el) => el._record && ((v) => el._record.follow(v))],
];

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
    // Sloppy focus (see Window focus): focus follows the pointer into a
    // frame and stays when it leaves for empty space; only a still click
    // on the title bar, a `windowClick`-modified click or a key raises.
    this._sloppy = false;
    this._windowClick = "alt";
    // The effective pointer, { x, y }: the real one's last position, or
    // the virtual cursor's while it shows (`_vcOn`).
    this._pointer = null;
    this._lastReal = null;          // { screenX, screenY }: the real pointer, for `realMove`
    this._vc = null;                // the virtual cursor's element
    this._vcOn = false;
    this._mover = new Mover();      // held Alt+H/J/K/L / arrows
    this._kbResize = null;          // a keyboard resize's unsnapped rect (`_kbResizeStep`)
    this._wmShift = false;          // Shift, as the last key event had it
    this._moverRaf = 0;
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
    // Capture: a window key must beat the pane's own (a table's
    // alt+arrow would move its cursor too).
    window.addEventListener("keydown", this._onWmKey, true);
    window.addEventListener("keyup", this._onWmKeyUp, true);
    window.addEventListener("blur", this._onWmBlur);
    document.addEventListener("visibilitychange", this._onWmBlur);
    for (const t of ["pointermove", "pointerdown", "wheel"]) window.addEventListener(t, this._onTrackPointer, { capture: true, passive: true });
    this.addEventListener("pointermove", this._onPointerMove);
    this.addEventListener("focusin", this._onFocusIn);
  }
  disconnectedCallback() {
    this._ro?.disconnect();
    window.removeEventListener("resize", this._onWindowResize);
    window.removeEventListener("keydown", this._onKeyDown);
    window.removeEventListener("keydown", this._onWmKey, true);
    window.removeEventListener("keyup", this._onWmKeyUp, true);
    window.removeEventListener("blur", this._onWmBlur);
    document.removeEventListener("visibilitychange", this._onWmBlur);
    for (const t of ["pointermove", "pointerdown", "wheel"]) window.removeEventListener(t, this._onTrackPointer, true);
    this.removeEventListener("pointermove", this._onPointerMove);
    this._hideVCursor();
    this.removeEventListener("focusin", this._onFocusIn);
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

  // Tree tables: show the rows nested (`true`) or flat (`false`); no
  // value flips it. Returns whether a pane took it.
  setPaneNested(paneId, nested) {
    const hook = this._paneHook(paneId, "_tree", true);
    if (!hook?.setNested) return false;
    hook.setNested(nested ?? !hook.getNested());
    return true;
  }

  // Whether a tree table shows nested; null without a tree hook.
  getPaneNested(paneId) {
    return this._paneHook(paneId, "_tree", false)?.getNested?.() ?? null;
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

    const id = this._historyPane(srcId);
    this.showPane(id);
    // An open pane re-reads the selection; a pane built just now reads it
    // as it starts, and its factory may still be awaiting its client.
    const hist = this._paneEls.get(id);
    if (hist?._record) hist._record.refresh();
    else hist?._ready?.then(() => hist._record?.refresh());
    return true;
  }

  // A table's history pane: made the first time it is asked for, under an
  // id derived from the table's.
  _historyPane(srcId) {
    const id = `_history:${srcId}`;
    if (!this._panes.has(id)) {
      // Just "History": the record it lands on names the tab from there
      // (`setPaneAutoTitle`), and "History — 4711" is what tells two of
      // these apart — the table's name would only push the record's off
      // the end of a crowded tab bar.
      this.registerPane(id, { type: "mkio-history", source: srcId, title: "History" });
    }
    return id;
  }

  // A layout saved with a history window in it — open, or closed and
  // remembered — names a pane no config declares, which a restore at
  // startup would drop as unknown. Make those it names whose table is
  // still here and still has a history to read.
  _adoptHistoryPanes(layout) {
    const ids = new Set();
    const walk = (n) => {
      if (typeof n === "string") ids.add(n);
      else if (n && Array.isArray(n.children)) n.children.forEach(walk);
    };
    if (Array.isArray(layout?.frames)) for (const f of layout.frames) walk(f?.layout);
    if (layout?.panes && typeof layout.panes === "object") Object.keys(layout.panes).forEach((id) => ids.add(id));
    for (const id of ids) {
      if (!id.startsWith("_history:") || this._panes.has(id)) continue;
      const src = id.slice("_history:".length);
      if (this._panes.get(src)?.history) this._historyPane(src);
    }
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

  // The windows the config defines, in its order: `{ id, title, open,
  // shown }`, `open` false for one kept closed at startup, `shown` true
  // while it is on screen now. What a `{ frames = true }` menu item lists.
  configFrames() {
    return (this._app?.config?.frames ?? [])
      .filter(f => f && typeof f.id === "string" && f.id)
      .map(f => ({ id: f.id, title: f.title ?? null, open: f.open !== false, shown: this._frameEls.has(f.id) }));
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
      const problem = this._paneProblems?.get(id);
      if (problem) this._showPaneProblem(el, problem);
    } else el.contentEl.textContent = `[mkui] unknown pane: ${id}`;
    return el;
  }

  // A config mistake shown where it bites: a strip across the top of the
  // pane, above its content, until dismissed (the console has it too).
  _showPaneProblem(el, text) {
    if (el._problem) return;
    const strip = document.createElement("div");
    strip.className = "mkui-pane-problem";
    strip.setAttribute("role", "alert");
    strip.title = text;
    const msg = document.createElement("span");
    msg.textContent = text;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "mkui-pane-problem-close";
    close.textContent = "×";
    close.title = "Dismiss";
    close.addEventListener("click", () => {
      strip.remove();
      el._problem = null;
      el.classList.remove("mkui-pane-has-problem");
    });
    strip.append(msg, close);
    el.insertBefore(strip, el.firstChild);
    el.classList.add("mkui-pane-has-problem");
    el._problem = strip;
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
      const text = `pane "${id}": unknown key${unknown.length > 1 ? "s" : ""} ` +
        `${unknown.map(k => `"${k}"`).join(", ")} — ${what} takes ${known}`;
      console.error(`[mkui] ${text}`);
      (this._paneProblems ??= new Map()).set(id, `Config: ${text}`);
      const built = this._paneEls?.get(id);
      if (built) this._showPaneProblem(built, `Config: ${text}`);
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
    this._hideVCursor(); // a modal answers the real mouse
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

  // Sloppy focus ──────────────────────────────────────────────────────────
  //
  // With it on, focus follows the pointer: entering a frame focuses it —
  // `[data-focused]`, the hotkeys, the Edit menu — without raising it, and
  // leaving for empty workspace, the menubar or the statusbar keeps it. A
  // held button, an open menu or a modal holds focus still. A frame is
  // raised by a still click on its title bar (pressed and released on the
  // same spot: a drag moves it where it is), a still `windowClick`-
  // modified click (shift added lowers; dragged, it moves the frame from
  // anywhere in it) or Alt/Option+P (+N lowers). Alt/Option+H/J/K/L or
  // the arrows drive a virtual cursor that takes the pointer's part until
  // the real mouse moves; with shift they move the focused frame, the
  // virtual cursor riding along.
  // lib/wm.js decides which, and how fast a held key goes.

  setSloppyFocus(on) {
    this._sloppy = !!on;
    if (!this._sloppy) this._hideVCursor();
    const st = this._app?.state;
    if (st) st.set("focus.sloppy", this._sloppy);
  }
  sloppyFocus() { return this._sloppy; }

  // `"alt"` or `"ctrl+alt"`: the modifier of the raise click; anything
  // else warns and is `"alt"`.
  setWindowClick(mod) {
    if (!WINDOW_CLICKS.includes(mod)) {
      console.warn(`[mkui] bad windowClick ${JSON.stringify(mod)}: want ${WINDOW_CLICKS.map((m) => `"${m}"`).join(" or ")}`);
      mod = "alt";
    }
    this._windowClick = mod;
    const st = this._app?.state;
    if (st) st.set("focus.windowClick", mod);
  }
  windowClick() { return this._windowClick; }

  // A press anywhere in a frame (frame.js, and the tab gestures that
  // cancel the mousedown): it raises, or under sloppy focus only focuses.
  _pressFrame(frameEl) {
    if (this._sloppy) this._focusFrame(frameEl.getAttribute("data-id"));
    else this._raiseFrame(frameEl);
  }

  // Focus without raising. The keyboard follows: the element this frame
  // last had focused gets it back — unless a field is being typed in,
  // which keeps it — else the old frame's element lets go, so its keys
  // don't reach a frame the pointer has left.
  _focusFrame(id) {
    if (id == null || id === this._focusedId || !this._frameEls.has(id)) return;
    this._focusedId = id;
    this._applyZOrder();
    const frameEl = this._frameEls.get(id);
    const ae = typeof document !== "undefined" ? document.activeElement : null;
    if (isEditable(ae) || (ae && frameEl.contains?.(ae))) return;
    const last = frameEl._lastFocus;
    if (last?.isConnected && frameEl.contains?.(last)) last.focus?.({ preventScroll: true });
    else if (ae?.closest?.("mkui-frame")) ae.blur?.();
  }

  _onFocusIn = (e) => {
    const f = e.target?.closest?.("mkui-frame");
    if (f) f._lastFocus = e.target;
  };

  // An open menu or a modal holds the focus where it is.
  _focusHeld() {
    return !!this._app?._element?._menubar?._rootAnchor || this._frames.some((f) => f.modal);
  }

  // The real pointer, anywhere on the page (window, capture): where it
  // is — and, while the virtual cursor shows, the real mouse at work
  // (lib/wm.js `realMove`) takes the pointer's part back.
  _onTrackPointer = (e) => {
    if (this._vcOn) {
      if (!realMove(e, this._lastReal)) return;
      this._hideVCursor();
    }
    if (e.screenX != null) this._lastReal = { screenX: e.screenX, screenY: e.screenY };
    if (e.clientX != null) this._pointer = { x: e.clientX, y: e.clientY };
  };

  _onPointerMove = (e) => {
    if (!this._sloppy || e.buttons || this._vcOn || this._focusHeld()) return;
    const frameEl = e.target?.closest?.("mkui-frame");
    if (frameEl && frameEl.parentElement === this) this._focusFrame(frameEl.getAttribute("data-id"));
  };

  // Whatever is under the effective pointer has the focus: after a
  // lower, and as the virtual cursor moves.
  _refocusUnderPointer() {
    if (!this._pointer || this._focusHeld() || typeof document === "undefined" || !document.elementFromPoint) return;
    const hit = document.elementFromPoint(this._pointer.x, this._pointer.y)?.closest?.("mkui-frame");
    if (hit && hit.parentElement === this) this._focusFrame(hit.getAttribute("data-id"));
  }

  _now() { return typeof performance !== "undefined" ? performance.now() : Date.now(); }

  // The virtual cursor: shown at the effective pointer (else the focused
  // frame's middle), the real one hidden page-wide (`data-mkui-vcursor`
  // on the root: CSS) until `_onTrackPointer` hears the real mouse.
  _showVCursor() {
    if (this._vcOn || typeof document === "undefined") return;
    if (!this._vc) {
      this._vc = document.createElement("div");
      this._vc.className = "mkui-vcursor";
      this._vc.setAttribute("aria-hidden", "true");
      this._vc.appendChild(icon("pointer"));
    }
    (this.closest?.("mkui-app") ?? document.body)?.appendChild(this._vc);
    this._vcOn = true;
    document.documentElement?.setAttribute("data-mkui-vcursor", "");
    let at = this._pointer;
    if (!at) {
      const r = (this._frameEls.get(this._focusedId) ?? this).getBoundingClientRect?.();
      at = r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: 0, y: 0 };
    }
    this._placeVCursor(at.x, at.y);
  }

  _hideVCursor() {
    this._mover.clear();
    if (!this._vcOn) return;
    this._vcOn = false;
    this._vc?.remove();
    if (typeof document !== "undefined") document.documentElement?.removeAttribute("data-mkui-vcursor");
  }

  // Kept on the page; the effective pointer follows.
  _placeVCursor(x, y) {
    const w = typeof window !== "undefined" && window.innerWidth ? window.innerWidth : Infinity;
    const h = typeof window !== "undefined" && window.innerHeight ? window.innerHeight : Infinity;
    x = Math.max(0, Math.min(w - 1, x));
    y = Math.max(0, Math.min(h - 1, y));
    this._pointer = { x, y };
    this._vc.style.transform = `translate(${x}px, ${y}px)`;
  }

  _moveVCursor(dx, dy) {
    this._showVCursor();
    this._placeVCursor(this._pointer.x + dx, this._pointer.y + dy);
    this._refocusUnderPointer();
  }

  // The frame's title bar: its top-edge tab bars — tabs, the drag strip,
  // a dialog's title — but not the buttons, scroll arrows or a rename.
  _inTitlebar(target, frameEl) {
    const bar = target?.closest?.(".mkui-tabbar-top");
    if (!bar || !frameEl.contains?.(bar)) return false;
    return !target.closest(".mkui-frame-actions, .mkui-tab-scroll, .mkui-tab-rename");
  }

  // frame.js's capture-phase pointerdown, before anything in the frame
  // sees the press. Sloppy focus only.
  _framePointerDown(ev, frameEl) {
    if (!this._sloppy || typeof window === "undefined") return;
    const hit = clickOp(ev, this._windowClick, isApple());
    if (hit) {
      // The window's press, not the content's: it and the click it makes
      // go no further (cancelling the pointerdown holds back the
      // mousedown and mouseup). Dragged, it moves the frame where it is;
      // released in place, it raises (shift: lowers).
      ev.stopPropagation();
      const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
      window.addEventListener("click", stop, true);
      this._focusFrame(frameEl.getAttribute("data-id"));
      const down = { x: ev.clientX, y: ev.clientY };
      this._beginFrameMove(ev, frameEl, { pointer: true, onEnd: (e) => {
        setTimeout(() => window.removeEventListener("click", stop, true), 0);
        if (e?.type !== "pointerup" || !stillClick(down, { x: e.clientX, y: e.clientY })) return;
        if (hit.op === "raise") this._raiseFrame(frameEl);
        else this._lowerFrame(frameEl);
      } });
      return;
    }
    if (!plainPress(ev) || !this._inTitlebar(ev.target, frameEl)) return;
    const down = { x: ev.clientX, y: ev.clientY };
    const up = (e) => {
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
      if (e.type === "pointerup" && stillClick(down, { x: e.clientX, y: e.clientY }) && frameEl.isConnected)
        this._raiseFrame(frameEl);
    };
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
  }

  // Alt/Option keys, ahead of the pane's own keys (and of Alt+Shift+
  // arrows' tab reorder). A movement key's first press steps at once; a
  // held one glides (`_runMover`) — the OS's key repeat is ignored.
  _onWmKey = (e) => {
    if (!this._sloppy) return;
    const now = this._now();
    this._wmShift = !!e.shiftKey;
    if (this._mover.active) {
      if (!e.altKey || (this._mover.kind === "resize") !== !!e.ctrlKey) this._mover.clear();
      else if (e.key === "Shift" && this._mover.kind !== "resize") this._mover.rekind("move", now);
    }
    if (!this._mover.active) this._kbResize = null;
    const k = wmKey(e);
    if (!k || (isEditable(e.target) && !takesFromField(k, isApple()))) return;
    const el = this._frameEls.get(this._focusedId);
    if (k.op !== "point" && !el) return;
    e.preventDefault();
    e.stopPropagation();
    if (k.op === "front") this._raiseFrame(el);
    else if (k.op === "back") this._lowerFrame(el);
    else {
      const step = this._mover.press(k.op, k.code, k.dir, now);
      if (step) this._wmStep(k.op, step);
      this._runMover();
    }
  };

  // A release ends that key's part; Alt's (Ctrl's in a resize), the
  // gesture; Shift's turns a window move back into a cursor move, and a
  // resize back to snapping.
  _onWmKeyUp = (e) => {
    this._wmShift = !!e.shiftKey;
    if (!this._mover.active) return;
    if (!e.altKey || (this._mover.kind === "resize" && !e.ctrlKey)) this._mover.clear();
    else if (e.key === "Shift") { if (this._mover.kind !== "resize") this._mover.rekind("point", this._now()); }
    else this._mover.release(e.code);
  };

  // A key's release can go unheard once the page loses focus.
  _onWmBlur = () => this._mover.clear();

  // A cursor step moves the virtual cursor, focusing what it crosses. A
  // window step carries the virtual cursor along — shown if the real one
  // had the part — by as far as the window went, so it keeps its spot on
  // the window; the focus stays with the window being moved.
  _wmStep(kind, { dx, dy }) {
    if (kind === "point") { this._moveVCursor(dx, dy); return; }
    if (kind === "resize") { this._kbResizeStep(this._focusedId, dx, dy, !this._wmShift); return; }
    if (kind !== "move") return;
    const went = this._nudge(this._focusedId, dx, dy);
    if (!went) return;
    this._showVCursor();
    this._placeVCursor(this._pointer.x + went.dx, this._pointer.y + went.dy);
  }

  _runMover() {
    if (this._moverRaf || typeof requestAnimationFrame !== "function") return;
    const frame = () => {
      this._moverRaf = 0;
      if (!this._mover.active) return;
      const d = this._mover.tick(this._now());
      if (d.dx || d.dy) this._wmStep(this._mover.kind, d);
      this._moverRaf = requestAnimationFrame(frame);
    };
    this._moverRaf = requestAnimationFrame(frame);
  }

  // Send a frame to the bottom of its band (lib/wm.js `lowerOrder`).
  _lowerFrame(frameEl) {
    const next = lowerOrder(this._frames, frameEl.getAttribute("data-id"));
    if (next) {
      this._frames.splice(0, this._frames.length, ...next);
      this._applyZOrder();
    }
    this._refocusUnderPointer();
  }

  // Move a frame by (dx, dy) px, clamped to the workspace and unsnapped;
  // a tiled frame leaves its tile state, a maximized one stays. True if
  // it could move.
  nudgeFrame(id, dx, dy) {
    return this._nudge(id, dx, dy) != null;
  }

  // nudgeFrame's work: how far the frame went, `{ dx, dy }` — less than
  // asked at a workspace edge — or null if it couldn't move.
  _nudge(id, dx, dy) {
    const spec = this._frames.find((f) => f.id === id);
    const el = this._frameEls.get(id);
    const ws = { x: 0, y: 0, w: this.clientWidth, h: this.clientHeight };
    if (!spec || !el || this.isMaximized(id) || !ws.w || !ws.h) return null;
    const r = fracToRect({ xFrac: spec.x, yFrac: spec.y, wFrac: spec.w, hFrac: spec.h }, ws);
    const clamped = clampToDock({ ...r, x: r.x + dx, y: r.y + dy }, ws);
    this._clearTileState(spec, el);
    const frac = rectToFrac(clamped, ws);
    spec.x = frac.xFrac; spec.y = frac.yFrac;
    spec.w = frac.wFrac; spec.h = frac.hFrac;
    applyFrameRect(el, clamped);
    return { dx: clamped.x - r.x, dy: clamped.y - r.y };
  }

  // A keyboard resize step: the bottom-right corner by (dx, dy) px,
  // snapping (`snap`) as a mouse resize does. `_kbResize` is the
  // gesture's unsnapped rect, so a glide pulls free of an edge it caught
  // rather than snapping back to it step by step; a fresh press starts
  // it over (`_onWmKey`). A pointer inside the frame keeps its relative
  // spot on it — the virtual cursor, which also stops the real one's
  // hover handing the focus away. How far it went, or null.
  _kbResizeStep(id, dx, dy, snap) {
    const spec = this._frames.find((f) => f.id === id);
    const el = this._frameEls.get(id);
    const ws = { x: 0, y: 0, w: this.clientWidth, h: this.clientHeight };
    if (!spec || !el || this.isMaximized(id) || !ws.w || !ws.h) return null;
    const r = fracToRect({ xFrac: spec.x, yFrac: spec.y, wFrac: spec.w, hFrac: spec.h }, ws);
    let g = this._kbResize;
    if (!g || g.id !== id) {
      this._clearTileState(spec, el);
      g = this._kbResize = { id, ...r };
    }
    g.w = Math.max(MIN_FRAME_W, Math.min(ws.w - g.x, g.w + dx));
    g.h = Math.max(MIN_FRAME_H, Math.min(ws.h - g.y, g.h + dy));
    let rect = { x: g.x, y: g.y, w: g.w, h: g.h };
    if (snap) {
      const { vLines, hLines } = this._getSnapLines(id);
      rect = snapResize(rect, "se", vLines, hLines);
    }
    const clamped = clampToDock(rect, ws);
    const frac = rectToFrac(clamped, ws);
    spec.x = frac.xFrac; spec.y = frac.yFrac;
    spec.w = frac.wFrac; spec.h = frac.hFrac;
    applyFrameRect(el, clamped);
    const went = { dw: clamped.w - r.w, dh: clamped.h - r.h };
    const at = this._pointer;
    const off = this.getBoundingClientRect?.() ?? { left: 0, top: 0 };
    const fx = at && r.w ? (at.x - off.left - r.x) / r.w : -1;
    const fy = at && r.h ? (at.y - off.top - r.y) / r.h : -1;
    if (fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1) {
      this._showVCursor();
      this._placeVCursor(at.x + fx * went.dw, at.y + fy * went.dh);
    }
    return went;
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
  // State a layout brought for a hook the pane does not have yet (a
  // history pane's table, built with its first record) is still the
  // pane's: carried on until it can be applied.
  _paneState(el) {
    const st = { ...(el._pendingView ?? {}) };
    if (el._filters) st.filters = el._filters.get();
    if (el._sort) st.sort = el._sort.get();
    if (el._columns) st.visible = el._columns.get();
    if (el._columns?.getNumbers) st.columnNumbers = el._columns.getNumbers();
    if (el._columns?.getWidths) st.widths = el._columns.getWidths();
    // A tree table shown flat (or nested): a view choice, like the above.
    if (el._tree?.getNested) st.nested = el._tree.getNested();
    // A history pane's panel columns (its table's ride `widths`).
    if (el._panel) st.panelWidths = el._panel.get();
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
  // pending one (`_panel` is not a sign of a built pane: a history pane
  // has it before its factory's first await). What finds no hook to take it waits in `_pendingView`
  // for `_applyPendingState`.
  _applyPaneState(el, st) {
    const gen = el._viewGen = (el._viewGen ?? 0) + 1;
    el._pendingView = null;
    const apply = () => {
      const left = {};
      for (const [key, set] of PANE_STATE_SETTERS) {
        if (!(key in st)) continue;
        const fn = set(el);
        if (fn) fn(st[key]); else left[key] = st[key];
      }
      el._pendingView = Object.keys(left).length ? left : null;
    };
    if (el._filters || el._sort || el._columns || el._link || el._record || !el._ready) apply();
    else el._ready.then(() => { if (el._viewGen === gen) apply(); });
  }

  // A pane that has just grown hooks (a history pane, its table built)
  // takes the saved state that was waiting for them.
  _applyPendingState(el) {
    const st = el?._pendingView;
    if (st) this._applyPaneState(el, st);
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
    this._adoptHistoryPanes(layout);
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

  // `pointer`: follow pointer events — a press whose pointerdown was
  // cancelled (sloppy focus's Alt-drag) gets no mouse events. `onEnd(e)`
  // hears the release.
  _beginFrameMove(ev, frameEl, { pointer = false, onEnd = null } = {}) {
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
      const snapped = e.shiftKey ? snapMove(raw, snap.vLines, snap.hLines) : raw;
      const clamped = clampToDock(snapped, ws);
      const frac = rectToFrac(clamped, ws);
      spec.x = frac.xFrac; spec.y = frac.yFrac;
      spec.w = frac.wFrac; spec.h = frac.hFrac;
      Object.assign(frameEl.style, {
        left: Math.round(clamped.x) + "px",
        top: Math.round(clamped.y) + "px",
      });
    };
    const [MOVE, UP] = pointer ? ["pointermove", "pointerup"] : ["mousemove", "mouseup"];
    const up = (e) => {
      window.removeEventListener(MOVE, move);
      window.removeEventListener(UP, up);
      if (pointer) window.removeEventListener("pointercancel", up);
      onEnd?.(e);
    };
    window.addEventListener(MOVE, move);
    window.addEventListener(UP, up);
    if (pointer) window.addEventListener("pointercancel", up);
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
    const minW = MIN_FRAME_W, minH = MIN_FRAME_H;
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
      const snapped = e.shiftKey ? { x, y, w, h } : snapResize({ x, y, w, h }, dir, vLines, hLines);
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
    this._pressFrame(sourceFrame);
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
