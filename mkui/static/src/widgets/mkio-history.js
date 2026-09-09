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
import { isRich, richText, renderRich } from "../lib/rich.js";
import { gridToTSV, gridToHTML } from "../lib/copy.js";
import { refToDate } from "../lib/timeparse.js";
import {
  parseHistorySpec, parseChain, cursorOf, diffVersions, blame, pkFromSchema,
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

// A value as an mkio filter expression writes it. Numbers go bare and
// anything else as a quoted string — the only thing this ever builds is
// the key of the record whose history is on show.
function exprLiteral(v) {
  if (v == null) return "NULL";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return `'${String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

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

  const root = el("mkui-history");
  const head = el("mkui-history-head");
  const title = el("mkui-history-title");
  const sub = el("mkui-history-sub");
  const reload = el("mkui-history-reload mkui-icon-btn", "button");
  reload.appendChild(icon("refresh"));
  reload.title = "Re-read this record's versions";
  head.append(title, sub, reload);

  const tableHost = el("mkui-history-table");
  const panel = el("mkui-history-panel");
  root.append(head, tableHost, panel);
  host.textContent = "";
  host.appendChild(root);

  /* ── State ────────────────────────────────────────────────────────── */

  let record = null;      // { key, row, version, of } — the record on show
  let chain = null;       // parseChain over the table's rows
  let cursor = null;      // cursorOf result, when the cursor is known
  let showUnchanged = false;
  let view = "diff";      // "diff" | "blame" — a preference, not per record
  let keyCols = null;     // resolved primary key columns
  let loadGen = 0, stateGen = 0;
  let client = null;
  let built = false;      // the embedded table exists
  let autoSelected = false;  // the cursor's row has had its one selection
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
  function historyColumns(h) {
    const meta = [MKIO_FIELDS.version, MKIO_FIELDS.op, MKIO_FIELDS.user, MKIO_FIELDS.ref];
    const src = h?.columns ?? srcHook()?.columns?.() ?? srcSpec.columns ?? null;
    if (src && !src.length) return null;
    if (!src) return null;                    // nothing known: let the data say
    return [...meta, ...src.filter((c) => !meta.includes(c))];
  }

  // One record's slice of the feed, server-side: the history service is a
  // query over the whole history table, and this narrows it to the key.
  const recordFilter = (key) =>
    Object.entries(key).map(([c, v]) => `${c} == ${exprLiteral(v)}`).join(" && ");

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

  // The key columns: configured, else the base table's primary key, which
  // the server will name (`_mkio` table introspection). Asked for once.
  async function resolveKeyCols(h) {
    if (h.key) return h.key;
    if (keyCols) return keyCols;
    if (!h.table) return null;
    const reply = await client.request("_mkio", { table: h.table });
    if (reply?.type === "error") throw new Error(reply.message ?? "schema unavailable");
    const cols = pkFromSchema(reply?.row);
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
      title.textContent = "History";
      sub.textContent = "";
      status(h
        ? "No `feed` service is configured: the versions are read from a query service over this table's history table."
        : "This table has no `history` block.", "mkui-history-config");
      return;
    }
    if (!record) {
      title.textContent = "History";
      sub.textContent = "";
      chain = null;
      cursor = null;
      status("Select a row to see its history.");
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
    for (const c of cols) key[c] = record.row?.[c];
    if (cols.every((c) => key[c] == null || key[c] === "")) {
      status(`The selected row carries no ${cols.join("/")} to look up.`, "mkui-history-config");
      return;
    }
    record.key = key;
    renderHead();

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
    // The live row's version is the cursor. Without one — a service that
    // drops `_mkio_version`, or a row undone out of existence — the `state`
    // service answers, and a null `current` from it is an answer (the row
    // is gone, cursor 0) rather than a missing one.
    const current = record?.version;
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

  function renderHead() {
    const h = hspec();
    const keyText = record?.key
      ? Object.values(record.key).map((v) => (v == null ? "" : String(v))).join(" · ") : "";
    title.textContent = [h?.table, keyText].filter(Boolean).join(" ") || "History";

    const parts = [];
    if (cursor) {
      parts.push(cursor.current === 0 ? "removed" : `v${cursor.current} of ${cursor.top}`);
      if (cursor.ahead) parts.push(`${plural(cursor.ahead, "version")} ahead`);
    } else if (chain?.top) {
      parts.push(plural(chain.top, "version"));
    }
    if (chain?.gaps.length) parts.push("archived versions missing");
    if (record?.of > 1) parts.push(`first of ${record.of} selected`);
    sub.textContent = parts.join(" · ");
    sub.title = cursor?.ahead
      ? "Versions above the row's own are redo: an edit made here discards them"
      : "";
  }

  function render() {
    renderHead();
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

  // The panel header: what is on show, how much of it, the Diff | Blame
  // switch, whatever else the view offers, and copy.
  function panelHead(what, count, extra = null) {
    const dhead = el("mkui-history-diffhead");
    const pair = el("mkui-history-pair");
    pair.textContent = what;
    const n = el("mkui-history-count");
    n.textContent = count;
    const views = el("mkui-history-views");
    for (const [name, text, tip] of [
      ["diff", "Diff", "What changed between two versions"],
      ["blame", "Blame", "Which version last set each field, and who"],
    ]) {
      const b = el("mkui-history-view", "button");
      if (view === name) b.classList.add("active");
      b.textContent = text;
      b.title = tip;
      b.addEventListener("mousedown", (ev) => {
        if (ev.button !== 0 || view === name) return;
        view = name;
        renderPanel();
      });
      views.appendChild(b);
    }
    dhead.append(pair, n, views);
    if (extra) dhead.appendChild(extra);
    const copy = el("mkui-history-copy", "button");
    copy.textContent = "Copy";
    copy.title = "Copy this panel as a grid";
    copy.addEventListener("mousedown", (ev) => { if (ev.button === 0) copyPanel(); });
    dhead.appendChild(copy);
    panel.appendChild(dhead);
    return dhead;
  }

  function renderPanel() {
    panel.textContent = "";
    if (!chain) return;
    if (!chain.versions.length) {
      status(record ? "No versions are recorded for this record." : "Select a row to see its history.");
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
  }

  function renderDiff() {
    const h = hspec();
    const [from, to, fromV, toV] = diffPair();
    const cols = h?.columns ?? chain.columns;
    const rows = diffVersions(from, to, cols);
    const changed = rows.filter((d) => d.kind !== "same");

    const toggle = el("mkui-history-toggle", "button");
    if (showUnchanged) toggle.classList.add("active");
    toggle.textContent = showUnchanged ? "Hide unchanged" : "Show unchanged";
    toggle.disabled = rows.length === changed.length;
    toggle.addEventListener("mousedown", (ev) => {
      if (ev.button !== 0) return;
      showUnchanged = !showUnchanged;
      renderPanel();
    });
    panelHead(fromV == null ? `v${toV} (first recorded)` : `v${fromV} → v${toV}`,
              changed.length ? plural(changed.length, "change") : "no changes", toggle);

    const fields = el("mkui-history-fields");
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

  function copyPanel() {
    if (!chain || !chain.versions.length) return false;
    const grid = copyGrid();
    if (!navigator?.clipboard?.write) return false;
    const item = new ClipboardItem({
      "text/plain": new Blob([gridToTSV(grid)], { type: "text/plain" }),
      "text/html": new Blob([gridToHTML(grid)], { type: "text/html" }),
    });
    navigator.clipboard.write([item]).catch((e) => console.warn(`[mkio-history] copy failed: ${e.message}`));
    app.state.set("status.message", `Copied ${plural(grid.length - 1, "field")}`);
    return true;
  }

  /* ── Following the tables ─────────────────────────────────────────── */

  // The record the source table's selection implies: its first selected
  // row, with the version it currently sits on.
  function readSelection() {
    const rows = srcHook()?.rows?.() ?? [];
    if (!rows.length) return null;
    const row = rows[0];
    return { key: null, row, version: row?.[MKIO_FIELDS.version] ?? null, of: rows.length };
  }

  const sameRecord = (a, b) =>
    a === b || (!!a && !!b && a.row === b.row && a.of === b.of);

  function refresh(force = false) {
    const next = readSelection();
    if (!force && sameRecord(next, record)) return;
    record = next;
    chain = null;
    cursor = null;
    autoSelected = false;
    load();
  }

  reload.addEventListener("mousedown", (ev) => { if (ev.button === 0) refresh(true); });

  client = await ensureMkio(wsUrl);

  // Follow the source table: every selection change re-reads the record,
  // so clicking down a table walks its records' histories. And follow the
  // embedded one: its rows are the chain, its selection what the panel is
  // about, and both change as versions arrive.
  let unfollow = null, unwatch = null;
  function follow() {
    unfollow?.();
    unfollow = srcId == null ? null : getWs()?.onPaneSelection?.(srcId, () => refresh()) ?? null;
  }
  // The embedded table's rows are the chain and its selection is what the
  // panel is about, so the pane follows both. Armed once the table exists.
  function watchTable() {
    unwatch?.();
    if (!paneEl) return;
    const offData = paneEl._data?.on?.(() => readChain()) ?? null;
    const offSel = paneEl._select?.on?.(() => renderPanel()) ?? null;
    unwatch = () => { offData?.(); offSel?.(); };
  }
  function unfollowAll() {
    unfollow?.(); unfollow = null;
    unwatch?.(); unwatch = null;
  }

  if (paneEl) {
    paneEl.addEventListener("mkui-pane-open", () => { follow(); watchTable(); refresh(true); });
    paneEl.addEventListener("mkui-pane-close", unfollowAll);
  }

  follow();
  refresh(true);

  // The pane's own hook: `showPaneHistory` re-points an open pane at
  // whatever the table has selected now.
  if (paneEl) paneEl._record = { refresh: () => refresh(true), get: () => record };
});
