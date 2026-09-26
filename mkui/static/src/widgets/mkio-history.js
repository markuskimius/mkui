// The `mkio-history` pane type: one record's recorded versions as an
// ordinary table, with a panel under it for what changed.
//
// mkio 0.3.0 keeps every version of a `versioned = true` table's rows in a
// companion history table, and the live row's `_mkio_version` is a cursor
// into that chain (lib/history.js). Those versions are rows like any
// other, so this pane shows them in an `mkio-table` — sorting, filtering,
// the column picker, find, copy and selection all come with it — pointed
// at the `history.feed` service and narrowed, server-side, to one record.
// Re-aiming that table (`_source`) rather than rebuilding it is what keeps
// the columns, sort and filters the user set as they walk from record to
// record.
//
// Under the table sits the panel: **Diff** (what changed between two
// versions) and **Blame** (which version last set each field), driven by
// the table's own selection — one version diffs against its predecessor, a
// range diffs its ends, and nothing selected reads the newest change.
//
// The pane follows a table pane (`source`): it reads that pane's `history`
// block, its labels and display templates, and the record its selection
// implies, re-reading whenever the selection moves. `workspace
// .showPaneHistory` opens one, and the `table.history` action fires it.

import { registerPaneType, getPaneType } from "../core.js";
import { ensureMkio } from "../mkio-bridge.js";
import { compileTemplate, expr } from "../lib/expressions.js";
import { icon } from "../lib/icons.js";
import { attachRecord, recordFilter } from "../lib/subject.js";
import { makeSubjectControls } from "../lib/subject-ui.js";
import { isRich, richText, renderRich } from "../lib/rich.js";
import { writeGrid, makeCopyStatus } from "../lib/copy.js";
import { refToDate } from "../lib/timeparse.js";
import {
  parseHistorySpec, parseChain, cursorOf, diffVersions, blame, pkFromSchema, unversionedFromSchema,
  MKIO_FIELDS, MKIO_LABELS,
} from "../lib/history.js";

const el = (cls, tag = "div") => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
};

// A version's time, from the ref the transaction was stamped with: the
// clock alone for today, the date too for anything older.
function fmtWhen(ref) {
  const d = refToDate(ref);
  if (!d) return "";
  const p = (n) => String(n).padStart(2, "0");
  const clock = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return clock;
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[d.getMonth()]} ${d.getDate()} ${clock}`;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// The config keys a history window reads (beside `title`/`type`), for the
// workspace's unknown-key check.
const HISTORY_KEYS = ["source", "history", "record", "labels", "display"];

registerPaneType("mkio-history", async (spec, app, host) => {
  const wsUrl = app.config?.mkio?.url;
  if (!wsUrl) {
    host.textContent = "[mkio-history] no mkio.url configured";
    return;
  }
  // Looked up on each use: a pane is in the workspace by the time it runs
  // (see `_ensurePaneEl`), but a factory called any other way may not be,
  // and a `null` here would silently read as "this table has no history".
  const getWs = () => host.closest?.("mkui-workspace") ?? null;
  const paneEl = host.closest?.("mkui-pane") ?? null;
  const srcId = spec.source ?? null;
  const srcSpec = (srcId != null ? getWs()?.getPaneSpec?.(srcId) : null) ?? {};

  // The source table's `history` block is the configuration; a history pane
  // written by hand may carry its own. Reuse the table's parsed one when it
  // is there, so the config is read (and warned about) exactly once.
  const srcHook = () => (srcId == null ? null : getWs()?.paneHistory?.(srcId) ?? null);
  const ownSpec = spec.history !== undefined
    ? parseHistorySpec(spec.history, { warn: (m) => console.warn(`[mkio-history] ${m}`) })
    : null;
  const hspec = () => ownSpec ?? srcHook()?.spec ?? null;

  // Presentation follows the table: the same labels, and the same display
  // templates, so a status reads in the panel as it reads in the cell.
  const labels = { ...(srcSpec.labels ?? {}), ...(spec.labels ?? {}) };
  const label = (col) => labels[col] ?? MKIO_LABELS[col] ?? col;
  const displaySpecs = {
    [MKIO_FIELDS.ref]: `\${REF_TIME(value, fmt: '%Y-%m-%d %H:%M:%S', tz: 'local')}`,
    ...(srcSpec.display ?? {}), ...(spec.display ?? {}),
  };
  const displayExprs = {};
  for (const [c, src] of Object.entries(displaySpecs)) {
    try { displayExprs[c] = compileTemplate(String(src)); }
    catch (e) { console.warn(`[mkio-history] bad display template for ${c}: ${e.message}`); }
  }
  const warnedExprs = new Set();

  // A value as the table would show it: `{ text, rich }`. The cell scope is
  // the table's — `value`, `row`, `col`, `state`, then the version's own
  // fields — over the version being shown rather than the live row.
  function shown(row, col) {
    const t = displayExprs[col];
    const raw = row?.[col];
    if (!t) return { text: raw == null ? "" : String(raw), rich: null };
    const fields = new expr.Scope(row ?? {}, null, false);
    const scope = new expr.Scope(
      { value: raw ?? null, row: row ?? null, col, state: app.state.get() }, fields, false);
    try {
      const v = t.evaluate(scope);
      if (isRich(v)) return { text: richText(v), rich: v };
      return { text: v == null ? "" : expr.toString(v), rich: null };
    } catch (e) {
      const key = `display.${col}`;
      if (!warnedExprs.has(key)) {
        warnedExprs.add(key);
        console.warn(`[mkio-history] expression error in ${key}: ${e.message}`);
      }
      return { text: "#ERR", rich: null };
    }
  }

  /* ── DOM ──────────────────────────────────────────────────────────── */

  // No head: the record is the tab's name, the cursor is the selected
  // row, and the subject controls ride the table's toolbar. What is left
  // is the versions, the splitter, and the panel.
  const root = el("mkui-history");
  // The subject controls ride the versions table's toolbar — but until
  // that table exists there is no toolbar, and an empty window is exactly
  // when the user wants to see (and fix) what it is waiting for. So they
  // start in a strip of their own, which is removed once the toolbar can
  // carry them.
  const subject = makeSubjectControls({
    app, paneEl, ws: getWs, follower: () => follower,
    warn: (m) => console.warn(`[mkio-history] ${m}`),
  });
  const ownBar = el("mkui-record-bar");
  ownBar.appendChild(subject.el);
  const tableHost = el("mkui-history-table");
  const splitter = el("mkui-history-split");
  const panel = el("mkui-history-panel");
  root.append(ownBar, tableHost, splitter, panel);
  host.textContent = "";
  host.appendChild(root);

  // The divider between the versions and the panel, dragged as the ones
  // between panes are: the table's share of the pane is a fraction, so it
  // holds when the pane itself is resized.
  const MIN_SHARE = 0.15, MAX_SHARE = 0.9;
  let tableShare = 0.65;
  const applyShare = () => { tableHost.style.flexBasis = `${(tableShare * 100).toFixed(2)}%`; };
  applyShare();

  splitter.addEventListener("mousedown", (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    const rect = root.getBoundingClientRect?.();
    if (!rect?.height) return;
    splitter.classList.add("dragging");
    const move = (e) => {
      const share = (e.clientY - rect.top) / rect.height;
      tableShare = Math.min(MAX_SHARE, Math.max(MIN_SHARE, share));
      applyShare();
    };
    const up = () => {
      splitter.classList.remove("dragging");
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });

  // The panel's columns — the field's name, the value before (or at)
  // the version, the value after (or what last set it) — are dragged at
  // the grips in the head row over the lines, as a table's are. The
  // lines are one grid (each line a subgrid of it), so a column is one
  // width down the whole list. Widths are pixels — set on the panel
  // itself, which outlives every render — and fixed from the first
  // render: a column starts just wide enough for what it shows, capped
  // at a third of the panel (`sizeColumns`), and stays put whatever the
  // pane does, the panel scrolling sideways when they outgrow it. `null`
  // is a column not yet fitted, which the next render (or the panel's
  // first layout, if it was hidden) fits; a double-click on a grip
  // refits it. The field column is the same in both views and has one
  // width; the other two hold different things in Diff (before, after)
  // and Blame (value, provenance), so each view keeps its own.
  const WIDTH_VARS = ["--mkui-hist-name", "--mkui-hist-mid", "--mkui-hist-last"];
  const MIN_COL = 56, LINE_PAD = 8, FIT_SHARE = 1 / 3;
  const widths = { name: null, diff: [null, null], blame: [null, null] };
  const getWidth = (i) => (i === 0 ? widths.name : widths[view][i - 1]);
  const setWidth = (i, px) => { if (i === 0) widths.name = px; else widths[view][i - 1] = px; };
  function applyColWidths() {
    WIDTH_VARS.forEach((v, i) => {
      const px = getWidth(i);
      if (px == null) panel.style.removeProperty(v);
      else panel.style.setProperty(v, `${Math.round(px)}px`);
    });
  }
  // Which of the head's cells a width index is: the last is the last
  // column, whichever that is in the view (the diff's fourth, blame's
  // third); a track is its cell, plus the line's padding for the first
  // (the list's last track is an empty filler, so the last column's cell
  // is not inset).
  const cellOf = (i, cells) => (i === WIDTH_VARS.length - 1 ? cells.length - 1 : i);
  const padOf = (col) => (col === 0 ? LINE_PAD : 0);
  const unfitted = () => WIDTH_VARS.some((_, i) => getWidth(i) == null);

  // Fit the unfitted columns: lay the list out content-sized for a
  // moment, read each track, and fix it at that or a third of the
  // panel, whichever is less. A panel with no width yet (a hidden tab)
  // is left for its first layout.
  function sizeColumns(box, cells) {
    const width = unfitted() ? panel.getBoundingClientRect?.()?.width : 0;
    if (width) {
      const cap = Math.floor(width * FIT_SHARE);
      box.style.gridTemplateColumns = cells.map(() => "max-content").join(" ");
      WIDTH_VARS.forEach((_, i) => {
        if (getWidth(i) != null) return;
        const col = cellOf(i, cells);
        const pad = padOf(col);
        const track = Math.ceil(cells[col].getBoundingClientRect().width) + pad;
        setWidth(i, Math.max(MIN_COL + pad, Math.min(cap, track)));
      });
      box.style.gridTemplateColumns = "";
    }
    applyColWidths();                  // this view's, fitted or not
  }
  const headCells = () => {
    const box = panel.querySelector?.(".mkui-history-fields");
    const head = box?.querySelector(".mkui-history-cols");
    return head ? [box, [...head.children]] : null;
  };
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => {
      const found = unfitted() && headCells();
      if (found) sizeColumns(...found);
    }).observe(panel);
  }

  // The head over the lines: what each column is, and a grip per
  // column — on the left edge of the cell after it, or, for the last,
  // its own right edge. The diff's third column is the arrow: an empty
  // cell, so its whole column is the grip between before and after.
  function colsHead(box, titles) {
    const head = el("mkui-history-cols");
    const cells = titles.map((t) => {
      const c = el("mkui-history-col");
      c.appendChild(document.createTextNode(t));
      c.title = t;
      head.appendChild(c);
      return c;
    });
    const last = cells.length - 1;
    for (let i = 0; i < WIDTH_VARS.length; i++) {
      const grip = el("mkui-history-colgrip");
      const end = i === WIDTH_VARS.length - 1;     // the last column's own
      const at = end ? last : i + 1;               // the cell that carries it
      if (end) grip.classList.add("mkui-history-colgrip-end");
      else if (titles[at] === "") grip.classList.add("mkui-history-colgrip-wide");
      grip.title = "Drag to resize; double-click to reset";
      grip.addEventListener("mousedown", (ev) => {
        if (ev.button !== 0) return;
        ev.preventDefault();
        ev.stopPropagation();
        dragColumn(i, grip, box, cells, ev.clientX);
      });
      grip.addEventListener("dblclick", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        setWidth(i, null);
        sizeColumns(box, cells);
      });
      cells[at].appendChild(grip);
    }
    box.appendChild(head);
    return head;
  }

  // The drag moves the column by the pointer's travel, so wherever on
  // the grip it took hold, nothing jumps; there is no ceiling — the
  // panel scrolls — only a floor.
  function dragColumn(i, grip, box, cells, x0) {
    const col = cellOf(i, cells);
    const cell = cells[col].getBoundingClientRect?.();
    if (!cell?.width) return;
    const pad = padOf(col);
    const start = cell.width + pad;
    const lo = MIN_COL + pad;
    grip.classList.add("dragging");
    const move = (e) => {
      setWidth(i, Math.max(lo, start + e.clientX - x0));
      applyColWidths();
    };
    const up = () => {
      grip.classList.remove("dragging");
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  /* ── State ────────────────────────────────────────────────────────── */

  let record = null;      // { key, row, version, of } — the record on show
  let chain = null;       // parseChain over the table's rows
  let cursor = null;      // cursorOf result, when the cursor is known
  let showUnchanged = false;
  let view = "diff";      // "diff" | "blame" — a preference, not per record
  let keyCols = null;     // resolved primary key columns
  let unversionedCols = [];  // the table's columns its history leaves out
  let loadGen = 0, stateGen = 0;
  let client = null;
  let built = false;      // the embedded table exists
  let autoSelected = false;  // the cursor's row has had its one selection
  let controlsPlaced = false;  // ...in the table's toolbar, once it exists
  let building = null;    // ...or is on its way: two loads must not race
                          // one another into building two of them

  const status = (msg, cls = "") => {
    panel.textContent = "";
    const n = el(`mkui-history-empty ${cls}`.trim());
    n.textContent = msg;
    panel.appendChild(n);
  };

  // The embedded table installs its hooks on the pane element this pane
  // lives in, so they are this pane's hooks too: `edit.copy` and Ctrl/Cmd+F
  // reach the versions, and a saved layout keeps their columns and filters.
  const dataHook = () => (built ? paneEl?._data ?? null : null);
  const sourceHook = () => (built ? paneEl?._source ?? null : null);

  /* ── The versions table ───────────────────────────────────────────── */

  // Its columns: mkio's own first — the version, what wrote it, who and
  // when — then the record's, as the source table has them. They are named
  // rather than inferred because `_mkio_*` columns show only when a config
  // asks for them.
  // A column the table leaves out of its history (`unversioned`) has no
  // version to show and would sit empty: dropped.
  function historyColumns(h) {
    const meta = [MKIO_FIELDS.version, MKIO_FIELDS.op, MKIO_FIELDS.user, MKIO_FIELDS.ref];
    const src = h?.columns ?? srcHook()?.columns?.() ?? srcSpec.columns ?? null;
    if (src && !src.length) return null;
    if (!src) return null;                    // nothing known: let the data say
    return [...meta, ...src.filter((c) => !meta.includes(c) && !unversionedCols.includes(c))];
  }

  // The feed is a query over the whole history table; `recordFilter`
  // narrows it to one record, server-side.

  // Awaited: the table installs its hooks as its factory settles, and
  // this pane reads its rows and selection through them. Built once — a
  // pane opened and pointed at a record in the same breath loads twice,
  // and two tables would leave the pane reading the hooks of the one it
  // is not showing.
  function ensureTable(h, key) {
    if (!building) building = buildTable(h, key).then((ok) => (built = ok));
    return building;
  }

  async function buildTable(h, key) {
    const factory = getPaneType("mkio-table");
    if (!factory) return false;
    await factory({
      type: "mkio-table",
      service: h.feed,
      protocol: "query",
      filter: recordFilter(key),
      columns: historyColumns(h),
      labels: { ...labels },
      display: displaySpecs,
      sort: MKIO_FIELDS.version,   // oldest first: the chain in the order it happened
      rowColumn: false,
    }, app, tableHost);
    watchTable();
    return true;
  }

  /* ── Reading the chain ────────────────────────────────────────────── */

  // The table's schema (`_mkio` table introspection), asked for once and
  // shared: it names the primary key when the config did not, and the
  // unversioned columns either way, which is why a configured key still
  // reads it — best-effort there, since the key is already known.
  let schemaFlight = null;   // the flight, so two loads share one request
  function tableSchema(h) {
    if (!h.table) return Promise.resolve(null);
    if (!schemaFlight) {
      schemaFlight = (async () => {
        const reply = await client.request("_mkio", { table: h.table });
        if (reply?.type === "error") throw new Error(reply.message ?? "schema unavailable");
        unversionedCols = unversionedFromSchema(reply?.row);
        return reply?.row ?? null;
      })().catch((e) => { schemaFlight = null; throw e; });   // a failure may be retried
    }
    return schemaFlight;
  }

  // The key columns: configured, else the base table's primary key.
  async function resolveKeyCols(h) {
    if (h.key) {
      await tableSchema(h).catch(() => {});
      return h.key;
    }
    if (keyCols) return keyCols;
    const row = await tableSchema(h);
    if (!row) return null;
    const cols = pkFromSchema(row);
    if (!cols.length) throw new Error(`table '${h.table}' reports no primary key`);
    return (keyCols = cols);
  }

  const rowsOf = (reply) => reply?.rows ?? (reply?.row ? [reply.row] : []);

  // Point the table at the record on show. The first call builds it; the
  // rest re-aim it, which is what keeps the view the user set.
  async function load() {
    const gen = ++loadGen;
    const h = hspec();
    if (!h?.feed) {
      syncSubject();
      status(h
        ? "No `feed` service is configured: the versions are read from a query service over this table's history table."
        : "This table has no `history` block.", "mkui-history-config");
      return;
    }
    if (!record) {
      chain = null;
      cursor = null;
      syncSubject();
      status(waitingText());
      return;
    }

    let cols;
    try {
      cols = await resolveKeyCols(h);
    } catch (e) {
      status(`Cannot tell which columns identify a record: ${e.message}`, "mkui-history-config");
      return;
    }
    if (gen !== loadGen) return;
    if (!cols) {
      status("Set `history.key` (or `history.table`) so the record can be identified.", "mkui-history-config");
      return;
    }

    const key = {};
    for (const c of cols) key[c] = record.row?.[c] ?? record.key?.[c] ?? null;
    if (cols.every((c) => key[c] == null || key[c] === "")) {
      status(record.from === "listen"
        ? `Nothing broadcast under ${follower.names().join(", ")} names a ${cols.join("/")}.`
        : `The selected row carries no ${cols.join("/")} to look up.`, "mkui-history-config");
      return;
    }
    record.key = key;
    syncSubject();

    if (!built) await ensureTable(h, key);
    else sourceHook()?.set({ filter: recordFilter(key) });
    if (gen !== loadGen) return;
    // The rows arrive on the table's subscription; every change to them
    // comes back through `readChain`.
    readChain();
  }

  // The chain is whatever the table holds: every version of this record,
  // whatever the user has sorted or filtered on top of it.
  function readChain() {
    const h = hspec();
    chain = parseChain(dataHook()?.rows() ?? [], { fields: h?.fields });
    // The live row's version is the cursor. Without one — a record named
    // by a link rather than a row, a service that drops `_mkio_version`,
    // or a row undone out of existence — the `state` service answers, and
    // a null `current` from it is an answer (the row is gone, cursor 0)
    // rather than a missing one.
    const current = record?.row?.[h?.fields?.version ?? MKIO_FIELDS.version] ?? null;
    if (current != null) cursor = cursorOf(chain, current);
    else if (h?.state && record?.key) askState(h, record.key);
    selectDefault();
    render();
  }

  async function askState(h, key) {
    const gen = ++stateGen;
    try {
      const st = rowsOf(await client.request(h.state, key))[0];
      if (gen !== stateGen || !st || !("current" in st) || !chain) return;
      cursor = cursorOf(chain, st.current ?? 0);
      selectDefault();
      render();
    } catch (e) {
      console.warn(`[mkio-history] '${h.state}' failed: ${e.message}`);
    }
  }

  /* ── Rendering ────────────────────────────────────────────────────── */

  // Where the record stands in its chain. This used to head the pane; the
  // panel is where a fact about the chain belongs, and the cursor's own
  // row is marked by being the selected one.
  function cursorText() {
    if (cursor) return cursor.current === 0 ? "removed" : `v${cursor.current} of ${cursor.top}`;
    if (chain?.top) return plural(chain.top, "version");
    return "";
  }

  function render() {
    syncSubject();
    renderPanel();
  }

  // The versions the panel is about: the table's selection — one row
  // against its predecessor, a range between its ends — and the newest
  // recorded when nothing is picked, which is the change just made.
  function picked() {
    if (!chain?.versions.length) return [];
    const field = hspec()?.fields?.version ?? MKIO_FIELDS.version;
    const vs = [];
    for (const row of dataHook()?.selected?.() ?? []) {
      const raw = row?.[field] ?? row?.version;
      const v = typeof raw === "number" ? raw : parseInt(raw, 10);
      if (Number.isFinite(v) && chain.byVersion.has(v) && !vs.includes(v)) vs.push(v);
    }
    // Nothing picked: the version the record is *on*, which for a row
    // sitting below its top is not the newest recorded — that one is the
    // redo branch, and showing it would read as the record's present.
    if (!vs.length) return [defaultVersion()];
    vs.sort((a, b) => a - b);
    return vs.length === 1 ? [vs[0]] : [vs[0], vs[vs.length - 1]];
  }

  // The pair on show: the ends of the picked range, or a single version
  // against the one before it.
  function diffPair() {
    const vs = picked();
    if (!vs.length) return [null, null, null, null];
    if (vs.length === 2) return [chain.byVersion.get(vs[0]), chain.byVersion.get(vs[1]), vs[0], vs[1]];
    const to = chain.byVersion.get(vs[0]) ?? null;
    let from = null;
    for (const v of chain.versions) if (v.version < vs[0]) from = v;
    return [from, to, from?.version ?? null, vs[0]];
  }

  const defaultVersion = () => {
    const cur = cursor?.current;
    return cur && chain.byVersion.has(cur) ? cur : chain.top;
  };

  // The version the record is on marks itself by being selected: the table
  // draws the selection, and the panel opens on the record as it stands.
  // Once per record, and never over a selection the user made.
  function selectDefault() {
    if (autoSelected || !chain?.versions.length) return;
    const key = chain.byVersion.get(defaultVersion())?.row?._mkio_row;
    if (key == null || !paneEl?._select) return;
    if ((dataHook()?.selected?.() ?? []).length) { autoSelected = true; return; }
    autoSelected = true;
    paneEl._select.set([key]);
  }

  const atVersion = () => {
    const vs = picked();
    return vs.length ? vs[vs.length - 1] : null;
  };

  // The controls sit in the versions table's toolbar — the row between the
  // tab and the table, where a table's buttons go — and are built once,
  // then updated in place. The panel below keeps only the line saying
  // what it is showing.
  const views = el("mkui-history-views");
  const viewBtns = {};
  for (const [name, text, tip] of [
    ["diff", "Diff", "What changed between two versions"],
    ["blame", "Blame", "Which version last set each field, and who"],
  ]) {
    const b = el("mkui-history-view", "button");
    b.textContent = text;
    b.title = tip;
    b.addEventListener("mousedown", (ev) => {
      if (ev.button !== 0 || view === name) return;
      view = name;
      renderPanel();
    });
    views.appendChild(b);
    viewBtns[name] = b;
  }
  // A toggle and an action, so they wear the toolbar's button chrome; the
  // Diff | Blame pair is one-of-two, so it is a segmented control instead.
  const unchangedBtn = el("mkui-btn mkui-toolbar-btn mkui-history-toggle", "button");
  unchangedBtn.addEventListener("mousedown", (ev) => {
    if (ev.button !== 0) return;
    showUnchanged = !showUnchanged;
    renderPanel();
  });
  // Copy sits with what it copies — the panel's own header — rather than
  // in the toolbar over the table, which is a different grid entirely.
  const copyBtn = el("mkui-history-copy", "button");
  copyBtn.appendChild(icon("copy"));
  copyBtn.appendChild(document.createTextNode("Copy"));
  copyBtn.title = "Copy what this panel shows, as a grid";
  copyBtn.addEventListener("mousedown", (ev) => { if (ev.button === 0) copyPanel(); });

  // The subject controls: the pin that freezes this window on the record
  // it holds, and the chip saying where its records come from. They lead
  // the extras, ahead of Diff | Blame.
  function placeControls() {
    const slot = paneEl?._toolbar;
    if (!slot) return;                 // still on the pane's own strip
    if (!controlsPlaced) {
      controlsPlaced = true;
      slot.extras().append(subject.el, views, unchangedBtn);
      slot.sync();
    }
    ownBar.remove();                   // the toolbar carries them now
  }

  const waitingText = () => subject.waitingText();

  function syncSubject() {
    placeControls();
    subject.sync(record);
  }

  // What the panel is showing, in the panel: the controls are elsewhere.
  function panelHead(what, count) {
    const dhead = el("mkui-history-diffhead");
    const pair = el("mkui-history-pair");
    pair.textContent = what;
    const n = el("mkui-history-count");
    n.textContent = count;
    const at = el("mkui-history-at");
    at.textContent = cursorText();
    at.title = at.textContent ? "Where this record stands in its chain" : "";
    dhead.append(pair, n, at, copyBtn);
    panel.appendChild(dhead);
    return dhead;
  }

  // The controls follow the panel: which view is on, and whether there is
  // anything unchanged to show.
  function syncControls(hasUnchanged = false) {
    for (const [name, b] of Object.entries(viewBtns)) b.classList.toggle("active", view === name);
    unchangedBtn.textContent = showUnchanged ? "Hide unchanged" : "Show unchanged";
    unchangedBtn.classList.toggle("active", showUnchanged);
    unchangedBtn.disabled = view !== "diff" || !hasUnchanged;
    copyBtn.disabled = !chain?.versions.length;
  }

  function renderPanel() {
    panel.textContent = "";
    placeControls();
    syncControls();
    if (!chain) return;
    if (!chain.versions.length) {
      status(record ? "No versions are recorded for this record." : waitingText());
      return;
    }
    if (view === "blame") renderBlame(); else renderDiff();
  }

  // Per-field provenance as at the version on show: which version last
  // gave each field the value it has there, and who wrote it. Clicking a
  // line selects that version in the table, so blame navigates the chain.
  function renderBlame() {
    const h = hspec();
    const at = atVersion();
    const cols = h?.columns ?? chain.columns;
    const entry = chain.byVersion.get(at) ?? null;
    const who = blame(chain, { columns: cols, upto: at });
    const known = cols.filter((c) => who[c]);
    panelHead(`as at v${at}`, `${known.length} of ${plural(cols.length, "field")} set`);

    const fields = el("mkui-history-fields");
    fields.dataset.view = "blame";
    const head = colsHead(fields, ["Field", "Value", "Last set"]);
    for (const col of cols) {
      const b = who[col];
      const line = el("mkui-history-blame");
      if (!b) line.classList.add("mkui-history-unset");
      const name = el("mkui-history-fname");
      name.textContent = label(col);
      name.title = col;
      const val = el("mkui-history-bvalue");
      if (entry && entry.values[col] != null && entry.values[col] !== "") {
        const s = shown(entry.values, col);
        if (s.rich) renderRich(val, s.rich);
        else val.textContent = s.text;
      } else {
        val.classList.add("mkui-history-blank");
        val.textContent = "—";
      }
      const src = el("mkui-history-bwho");
      if (b) {
        src.textContent = [`v${b.version}`, b.user, fmtWhen(b.ref)].filter(Boolean).join(" · ");
        src.title = `${label(col)} last changed at v${b.version}${b.user ? ` by ${b.user}` : ""}`;
        line.addEventListener("mousedown", (ev) => { if (ev.button === 0) goToVersion(b.version); });
      } else {
        src.textContent = "never set";
      }
      line.append(name, val, src);
      fields.appendChild(line);
    }
    panel.appendChild(fields);
    sizeColumns(fields, [...head.children]);
  }

  function renderDiff() {
    const h = hspec();
    const [from, to, fromV, toV] = diffPair();
    const cols = h?.columns ?? chain.columns;
    const rows = diffVersions(from, to, cols);
    const changed = rows.filter((d) => d.kind !== "same");

    syncControls(rows.length !== changed.length);
    panelHead(fromV == null ? `v${toV} (first recorded)` : `v${fromV} → v${toV}`,
              changed.length ? plural(changed.length, "change") : "no changes");

    const fields = el("mkui-history-fields");
    fields.dataset.view = "diff";
    const head = colsHead(fields, ["Field", fromV == null ? "—" : `v${fromV}`, "", `v${toV}`]);
    for (const d of rows) {
      if (d.kind === "same" && !showUnchanged) continue;
      const line = el(`mkui-history-field mkui-history-${d.kind}`);
      const name = el("mkui-history-fname");
      name.textContent = label(d.col);
      name.title = d.col;
      line.appendChild(name);
      line.appendChild(value(from, d.col, d.from, "from"));
      const arrow = el("mkui-history-arrow");
      arrow.textContent = "→";
      line.appendChild(arrow);
      line.appendChild(value(to, d.col, d.to, "to"));
      fields.appendChild(line);
    }
    panel.appendChild(fields);
    sizeColumns(fields, [...head.children]);
  }

  // One side of a field's change, rendered as the table would render it —
  // an absent side (before an insert, after a removal) reads as a dash.
  function value(row, col, raw, side) {
    const n = el(`mkui-history-${side}`);
    if (row == null || raw == null || raw === "") {
      n.classList.add("mkui-history-blank");
      n.textContent = "—";
      return n;
    }
    const s = shown(row.values ?? row, col);
    if (s.rich) renderRich(n, s.rich);
    else n.textContent = s.text;
    return n;
  }

  // Select a version in the table by its identity, so the panel and the
  // table agree on what is being looked at.
  function goToVersion(v) {
    const key = chain?.byVersion.get(v)?.row?._mkio_row;
    if (key == null || !paneEl?._select) { renderPanel(); return; }
    paneEl._select.set([key]);
  }

  /* ── Copy ─────────────────────────────────────────────────────────── */

  // The panel as it is shown, as a grid: the diff's two columns, or
  // blame's value and provenance. (Ctrl/Cmd+C is the table's, and copies
  // the version rows.)
  function copyGrid() {
    const h = hspec();
    const cols = h?.columns ?? chain.columns;
    if (view === "blame") {
      const at = atVersion();
      const entry = chain.byVersion.get(at) ?? null;
      const who = blame(chain, { columns: cols, upto: at });
      const grid = [["", `v${at}`, "Version", "User", "When"]];
      for (const col of cols) {
        const b = who[col];
        grid.push([label(col), entry ? shown(entry.values, col).text : "",
          b ? `v${b.version}` : "", b?.user ?? "", b ? fmtWhen(b.ref) : ""]);
      }
      return grid;
    }
    const [from, to, fromV, toV] = diffPair();
    const rows = diffVersions(from, to, cols).filter((d) => showUnchanged || d.kind !== "same");
    const grid = [["", fromV == null ? "(none)" : `v${fromV}`, `v${toV}`]];
    for (const d of rows) {
      grid.push([label(d.col),
        from == null || d.from == null ? "" : shown(from.values, d.col).text,
        to == null || d.to == null ? "" : shown(to.values, d.col).text]);
    }
    return grid;
  }

  // Feedback in three places, as a table's copy has it: the lines that
  // went pulse, so it is plain *what* was taken; the button says so where
  // the click was; and the statusbar says it in words, then puts back
  // whatever it was showing.
  const showCopyStatus = makeCopyStatus(app.state);
  let copyBtnTimer = null;

  function pulse(node) {
    node.classList.remove("mkui-flash-copy");
    void node.offsetWidth;                       // restart a running animation
    node.classList.add("mkui-flash-copy");
    node.addEventListener?.("animationend",
      () => node.classList.remove("mkui-flash-copy"), { once: true });
  }

  function sayCopied(text, ok) {
    copyBtn.textContent = "";
    copyBtn.appendChild(icon(ok ? "check" : "close"));
    copyBtn.appendChild(document.createTextNode(text));
    copyBtn.classList.toggle("mkui-history-copied", ok);
    if (copyBtnTimer) clearTimeout(copyBtnTimer);
    copyBtnTimer = setTimeout(() => {
      copyBtnTimer = null;
      copyBtn.classList.remove("mkui-history-copied");
      copyBtn.textContent = "";
      copyBtn.appendChild(icon("copy"));
      copyBtn.appendChild(document.createTextNode("Copy"));
    }, 1600);
  }

  function copyPanel() {
    if (!chain || !chain.versions.length) return false;
    if (typeof navigator === "undefined" || !navigator.clipboard) return false;
    const grid = copyGrid();
    for (const line of panelLines()) pulse(line);
    const what = plural(grid.length - 1, "field");
    writeGrid(grid, { headerRows: 1 }).then((ok) => {
      sayCopied(ok ? "Copied" : "Failed", ok);
      showCopyStatus(ok ? `Copied ${what}` : "Copy failed");
    });
    return true;
  }

  // The lines the grid was built from — a diff's fields, or blame's.
  function panelLines() {
    const box = panel.querySelector?.(".mkui-history-fields");
    return box ? [...(box.children ?? [])].filter((n) => !n.classList.contains("mkui-history-cols")) : [];
  }

  /* ── Following the record ─────────────────────────────────────────── */

  client = await ensureMkio(wsUrl);

  // Where the record comes from. A `record` block says so outright — and
  // `record.listen` is what puts this window on the link hub, so a
  // broadcast from any table points it at a record. Without one it
  // follows the source table's selection, which is what a history pane
  // opened from a table has always done.
  const recordSpec = spec.record !== undefined ? spec.record
    : (srcId != null ? { follow: srcId } : null);

  // The embedded table's rows are the chain and its selection is what the
  // panel is about, so the pane follows both. Armed once the table exists.
  let unwatch = null;
  function watchTable() {
    unwatch?.();
    if (!paneEl) return;
    const offData = paneEl._data?.on?.(() => readChain()) ?? null;
    const offSel = paneEl._select?.on?.(() => renderPanel()) ?? null;
    unwatch = () => { offData?.(); offSel?.(); };
  }

  // `attachRecord` installs `paneEl._record`, which is what the workspace
  // API, the `record.*` actions, the control channel and saved layouts
  // all speak to. A "spec" change is only the controls moving; a record
  // change (or a refresh) re-reads the chain.
  const follower = attachRecord(paneEl, recordSpec, app, (rec, why) => {
    record = rec;
    if (why === "spec") { syncSubject(); return; }
    chain = null;
    cursor = null;
    autoSelected = false;
    load();
  }, { warn: (m) => console.warn(`[mkio-history] ${m}`), ws: getWs });
  follower.start();

  if (paneEl) {
    paneEl.addEventListener("mkui-pane-open", () => {
      follower.start();
      watchTable();
      follower.refresh();
    });
    paneEl.addEventListener("mkui-pane-close", () => {
      follower.stop();
      unwatch?.();
      unwatch = null;
    });
  }

  // `attachRecord` starts the follower, which reads its source at once —
  // a retained broadcast, a selection already made. Only an empty one
  // needs prompting, so the window renders what it is waiting for.
  if (!follower.record) follower.refresh();
}, HISTORY_KEYS);
