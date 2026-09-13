// The `mkio-record` pane type: one record, as a list of fields.
//
// A table shows many records and a detail window shows one — the same
// data, read the other way round. What makes this window useful is that
// it does not have to be told which record twice: `record.listen` puts it
// on the link hub (lib/subject.js), so the table that broadcasts
// `order_id` points every listening window at the order the user picked,
// detail and history alike.
//
// Its content vocabulary is the table's, deliberately: `fields` in place
// of `columns`, then `labels`, `display` and `styles` meaning exactly
// what they mean in a cell, and `groups` folding the list into sections.
// A `source` pane lends all of it, so a detail window beside a table
// usually configures nothing but its service and what it listens for.
//
// The record itself is read with a query subscription narrowed to the
// key, so the window is live: an edit somewhere else arrives here.

import { registerPaneType, getWidget } from "../core.js";
import { ensureMkio } from "../mkio-bridge.js";
import { compileTemplate, expr } from "../lib/expressions.js";
import { icon } from "../lib/icons.js";
import { compileStyler, applyStyle, makeRunner } from "../lib/styles.js";
import { attachRecord, recordFilter } from "../lib/subject.js";
import { makeSubjectControls } from "../lib/subject-ui.js";
import { isRich, richText, renderRich } from "../lib/rich.js";
import { writeGrid, makeCopyStatus } from "../lib/copy.js";
import { pkFromSchema, unversionedFromSchema } from "../lib/history.js";

const el = (cls, tag = "div") => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
};

let _subCounter = 0;

registerPaneType("mkio-record", async (spec, app, host) => {
  const wsUrl = app.config?.mkio?.url;
  if (!wsUrl) {
    host.textContent = "[mkio-record] no mkio.url configured";
    return;
  }
  const getWs = () => host.closest?.("mkui-workspace") ?? null;
  const paneEl = host.closest?.("mkui-pane") ?? null;
  const srcId = spec.source ?? null;
  const srcSpec = (srcId != null ? getWs()?.getPaneSpec?.(srcId) : null) ?? {};
  const service = spec.service ?? srcSpec.service ?? null;
  const warn = (m) => console.warn(`[mkio-record] ${m}`);
  const warnedExprs = new Set();
  const run = makeRunner(warn, warnedExprs);

  // Presentation follows the source table when there is one: the same
  // labels, the same display templates, the same conditional styles, so a
  // status reads here as it reads in the cell.
  const labels = { ...(srcSpec.labels ?? {}), ...(spec.labels ?? {}) };
  const label = (col) => labels[col] ?? col;
  const displaySpecs = { ...(srcSpec.display ?? {}), ...(spec.display ?? {}) };
  const displayExprs = {};
  for (const [c, src] of Object.entries(displaySpecs)) {
    try { displayExprs[c] = compileTemplate(String(src)); }
    catch (e) { warn(`bad display template for ${c}: ${e.message}`); }
  }
  const stylers = {};
  for (const [c, s] of Object.entries({ ...(srcSpec.styles ?? {}), ...(spec.styles ?? {}) }))
    stylers[c] = compileStyler(s, `styles.${c}`, { warn, run });

  // `fields` is this pane's `columns`: which fields, in what order. Left
  // out, the record says — every field it carries, in its own order.
  const fieldsSpec = Array.isArray(spec.fields) ? spec.fields.filter((f) => typeof f === "string")
    : Array.isArray(srcSpec.columns) ? srcSpec.columns : null;

  // `groups = [{ label, columns }]` folds the list into sections, exactly
  // as the table's column picker groups its columns. Anything ungrouped
  // falls into a last, unlabelled section.
  const groupSpec = [];
  for (const [i, g] of (spec.groups ?? srcSpec.groups ?? []).entries()) {
    if (!g || typeof g !== "object" || !Array.isArray(g.columns)) { warn(`bad groups[${i}]`); continue; }
    groupSpec.push({ label: g.label ?? "", columns: g.columns.filter((c) => typeof c === "string") });
  }

  /* ── DOM ──────────────────────────────────────────────────────────── */

  const root = el("mkui-record");
  const toolbar = el("mkui-record-toolbar");
  const subject = makeSubjectControls({
    app, paneEl, ws: getWs, follower: () => follower, warn,
    rowFor: () => row,
  });
  const extrasEl = el("mkui-record-extras");
  const body = el("mkui-record-body");
  toolbar.append(subject.el, extrasEl);
  root.append(toolbar, body);
  host.textContent = "";
  host.appendChild(root);

  const copyBtn = el("mkui-btn mkui-toolbar-btn mkui-record-copy", "button");
  copyBtn.appendChild(icon("copy"));
  copyBtn.appendChild(document.createTextNode("Copy"));
  copyBtn.title = "Copy this record's fields, as a grid";
  copyBtn.addEventListener("mousedown", (ev) => { if (ev.button === 0) copyRecord(); });

  /* ── State ────────────────────────────────────────────────────────── */

  let record = null;      // the subject: { key, row, of, from }
  let row = null;         // the record as the service has it
  let keyCols = null;     // resolved key columns
  let keyColsAsked = null;
  let unversionedCols = [];  // the table's columns its history leaves out
  let client = null;
  let subid = null;
  let subscribed = false;
  let closed = false;
  let missing = false;    // the service answered, and there is no such record
  let loadGen = 0;
  const collapsed = new Set();

  const status = (msg, cls = "") => {
    body.textContent = "";
    const n = el(`mkui-record-empty ${cls}`.trim());
    n.textContent = msg;
    body.appendChild(n);
  };

  /* ── Reading the record ───────────────────────────────────────────── */

  // The key columns: configured, else the source table's `history.key`,
  // else the server's word on the table's primary key. Asked for once,
  // and the flight is shared so two record changes make one request.
  // The table's schema, asked for once: the key when nothing configured
  // one, and the unversioned columns either way — so a configured key
  // still reads it, best-effort.
  // The table: configured, else the source table's `history.table`, else
  // the service's name (a query service is often named after its table).
  function tableSchema() {
    const table = spec.table ?? getWs()?.paneHistory?.(srcId)?.spec?.table ?? service;
    if (!table) return Promise.resolve(null);
    if (!keyColsAsked) {
      keyColsAsked = (async () => {
        const reply = await client.request("_mkio", { table });
        if (reply?.type === "error") throw new Error(reply.message ?? "schema unavailable");
        unversionedCols = unversionedFromSchema(reply?.row);
        return reply?.row ?? null;
      })().catch((e) => { keyColsAsked = null; throw e; });
    }
    return keyColsAsked;
  }

  async function resolveKeyCols() {
    const own = spec.key ?? getWs()?.paneHistory?.(srcId)?.spec?.key ?? null;
    if (own) {
      await tableSchema().catch(() => {});
      return Array.isArray(own) ? own : [own];
    }
    if (keyCols) return keyCols;
    const row = await tableSchema();
    if (!row) return null;
    const cols = pkFromSchema(row);
    if (!cols.length) throw new Error(`table '${row.table ?? spec.table ?? service}' reports no primary key`);
    return (keyCols = cols);
  }

  function unsub() {
    if (!subscribed) return;
    subscribed = false;
    client?.unsubscribe(subid);
  }

  // Point the window at the record on show: unsubscribe, then subscribe
  // to the service narrowed to its key. The subscription is live, so an
  // edit made anywhere arrives here without asking again.
  async function load() {
    const gen = ++loadGen;
    row = null;
    missing = false;
    if (!service) {
      status("No `service` is configured: a detail window reads its record from a query service.", "mkui-record-config");
      return;
    }
    if (!record) {
      unsub();
      syncSubject();
      status(waitingText());
      return;
    }
    let cols;
    try {
      cols = await resolveKeyCols();
    } catch (e) {
      status(`Cannot tell which columns identify a record: ${e.message}`, "mkui-record-config");
      return;
    }
    if (gen !== loadGen || closed) return;
    if (!cols) {
      status("Set `key` (or `table`) so the record can be identified.", "mkui-record-config");
      return;
    }
    const key = {};
    for (const c of cols) key[c] = record.row?.[c] ?? record.key?.[c] ?? null;
    if (cols.every((c) => key[c] == null || key[c] === "")) {
      status(`Nothing names a ${cols.join("/")} to look up.`, "mkui-record-config");
      return;
    }
    record.key = key;
    syncSubject();
    // What the source already gave us shows at once; the subscription
    // then replaces it with the service's own row.
    if (record.row && Object.keys(record.row).length > cols.length) row = record.row;
    render();

    unsub();
    subscribed = true;
    client.subscribe(service, "query", {
      subid,
      filter: recordFilter(key),
      onSnapshot: (snap) => {
        if (gen !== loadGen) return;
        row = snap?.[0] ?? null;
        missing = !row;
        render();
      },
      onDelta: (changes) => {
        if (gen !== loadGen) return;
        for (const ch of changes) apply(ch.op, ch.row);
        render();
      },
      onUpdate: (op, r) => {
        if (gen !== loadGen) return;
        apply(op, r);
        render();
      },
    });
  }

  function apply(op, r) {
    if (op === "delete") { row = null; missing = true; return; }
    row = r;
    missing = false;
  }

  /* ── Rendering ────────────────────────────────────────────────────── */

  // A value as the table would show it: `{ text, rich }`, over the cell
  // scope — `value`, `row`, `col`, `state`, then the record's own fields.
  function cellScope(col) {
    const fields = new expr.Scope(row ?? {}, null, false);
    return new expr.Scope(
      { value: row?.[col] ?? null, row: row ?? null, col, state: app.state.get() }, fields, false);
  }

  function shown(col) {
    const t = displayExprs[col];
    const raw = row?.[col];
    if (!t) return { text: raw == null ? "" : String(raw), rich: null };
    try {
      const v = t.evaluate(cellScope(col));
      if (isRich(v)) return { text: richText(v), rich: v };
      return { text: v == null ? "" : expr.toString(v), rich: null };
    } catch (e) {
      const key = `display.${col}`;
      if (!warnedExprs.has(key)) {
        warnedExprs.add(key);
        warn(`expression error in ${key}: ${e.message}`);
      }
      return { text: "#ERR", rich: null };
    }
  }

  const fieldList = () => fieldsSpec ?? Object.keys(row ?? {}).filter((c) => !c.startsWith("_mkio_"));

  // The fields in their sections: the configured groups cut to the fields
  // actually on show, then everything left over.
  function sections() {
    const cols = fieldList();
    if (!groupSpec.length) return [{ label: "", columns: cols }];
    const taken = new Set();
    const out = [];
    for (const g of groupSpec) {
      const inGroup = g.columns.filter((c) => cols.includes(c) && !taken.has(c));
      for (const c of inGroup) taken.add(c);
      if (inGroup.length) out.push({ label: g.label, columns: inGroup });
    }
    const rest = cols.filter((c) => !taken.has(c));
    if (rest.length) out.push({ label: out.length ? "Other" : "", columns: rest });
    return out;
  }

  function renderField(col) {
    const line = el("mkui-record-field");
    const name = el("mkui-record-fname");
    name.textContent = label(col);
    name.title = col;
    // A column the table keeps no history of: an edit here makes no
    // version, and undo and redo pass it by. Said on the label, so the
    // history pane's silence about it is not a surprise.
    if (unversionedCols.includes(col)) {
      line.classList.add("mkui-record-unversioned");
      name.title = `${col} — not versioned: changes record no version, and undo/redo leave it as it is`;
    }
    const val = el("mkui-record-fvalue");
    const widget = spec.widgets?.[col] ? getWidget(spec.widgets[col]) : null;
    if (widget) {
      try { widget(val, { col, value: row?.[col], row, app }); }
      catch (e) { warn(`widget for ${col} failed: ${e.message}`); }
    } else {
      const s = shown(col);
      if (s.rich) renderRich(val, s.rich);
      else if (s.text === "") { val.classList.add("mkui-record-blank"); val.textContent = "—"; }
      else val.textContent = s.text;
    }
    const styler = stylers[col];
    if (styler) applyStyle(val, styler(cellScope(col)), "--mkui-cell-bg", "mkui-cell-styled");
    line.append(name, val);
    return line;
  }

  function render() {
    syncSubject();
    if (!record) { status(waitingText()); return; }
    if (missing) { status("This record is not in the service — it may have been deleted."); return; }
    if (!row) { status("Reading…"); return; }
    body.textContent = "";
    for (const sec of sections()) {
      const box = el("mkui-record-group");
      if (sec.label) {
        const head = el("mkui-record-group-head", "button");
        head.type = "button";
        head.appendChild(icon("caret-down"));
        head.appendChild(document.createTextNode(sec.label));
        head.addEventListener("mousedown", (ev) => {
          if (ev.button !== 0) return;
          if (collapsed.has(sec.label)) collapsed.delete(sec.label);
          else collapsed.add(sec.label);
          render();
        });
        box.appendChild(head);
        box.classList.toggle("collapsed", collapsed.has(sec.label));
      }
      if (!sec.label || !collapsed.has(sec.label))
        for (const col of sec.columns) box.appendChild(renderField(col));
      body.appendChild(box);
    }
    copyBtn.disabled = false;
  }

  /* ── The subject ──────────────────────────────────────────────────── */

  const waitingText = () => subject.waitingText();

  function syncSubject() {
    subject.sync(record);
    subject.el.appendChild(copyBtn);
    copyBtn.disabled = !row;
  }

  /* ── Copy ─────────────────────────────────────────────────────────── */

  const showCopyStatus = makeCopyStatus(app.state);

  function copyGrid() {
    const grid = [["Field", "Value"]];
    for (const sec of sections())
      for (const col of sec.columns) grid.push([label(col), shown(col).text]);
    return grid;
  }

  function copyRecord() {
    if (!row) return false;
    if (typeof navigator === "undefined" || !navigator.clipboard) return false;
    const grid = copyGrid();
    writeGrid(grid, { headerRows: 1 }).then((ok) => {
      showCopyStatus(ok ? `Copied ${grid.length - 1} fields` : "Copy failed");
    });
    return true;
  }

  /* ── Following the record ─────────────────────────────────────────── */

  client = await ensureMkio(wsUrl);
  subid = `mkui-record-${++_subCounter}`;

  const recordSpec = spec.record !== undefined ? spec.record
    : (srcId != null ? { follow: srcId } : null);

  const follower = attachRecord(paneEl, recordSpec, app, (rec, why) => {
    record = rec;
    if (why === "spec") { syncSubject(); return; }
    load();
  }, { warn, ws: getWs });

  // An embedder's controls, the same contract the table offers.
  if (paneEl) {
    paneEl._toolbar = { extras: () => extrasEl, sync: () => {} };
    // What this window holds, so another window can follow *it*.
    paneEl._data = { rows: () => (row ? [row] : []), selected: () => (row ? [row] : []) };
    paneEl._editActions = { copy: () => copyRecord() };
    paneEl.addEventListener("mkui-pane-open", () => {
      closed = false;
      follower.start();
      follower.refresh();
    });
    paneEl.addEventListener("mkui-pane-close", () => {
      closed = true;
      follower.stop();
      unsub();
    });
  }

  follower.start();
  if (!follower.record) follower.refresh();
});
