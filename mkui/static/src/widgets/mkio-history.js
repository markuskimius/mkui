// The `mkio-history` pane type: one record's recorded versions, and what
// changed between any two of them.
//
// mkio 0.3.0 keeps every version of a `versioned = true` table's rows in a
// companion history table, and the live row's `_mkio_version` is a cursor
// into that chain (lib/history.js). This pane reads the chain through the
// `versions` service the application configured — mkio advertises no
// history table and writes no service for one — and shows it as a
// timeline beside a field-by-field diff.
//
// The pane follows a table pane (`source`): it reads that pane's `history`
// block, its labels and display templates, and the record its selection
// implies, re-reading whenever the selection moves. `workspace
// .showPaneHistory` opens one, and the `table.history` action fires it.

import { registerPaneType } from "../core.js";
import { ensureMkio } from "../mkio-bridge.js";
import { compileTemplate, expr } from "../lib/expressions.js";
import { icon } from "../lib/icons.js";
import { isRich, richText, renderRich } from "../lib/rich.js";
import { gridToTSV, gridToHTML } from "../lib/copy.js";
import { refToDate } from "../lib/timeparse.js";
import {
  parseHistorySpec, parseChain, cursorOf, diffVersions, blame, pkFromSchema, MKIO_LABELS,
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
  // templates, so a status reads in the diff as it reads in the cell.
  const labels = { ...(srcSpec.labels ?? {}), ...(spec.labels ?? {}) };
  const label = (col) => labels[col] ?? MKIO_LABELS[col] ?? col;
  const displayExprs = {};
  for (const [c, src] of Object.entries(spec.display ?? srcSpec.display ?? {})) {
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

  const body = el("mkui-history-body");
  const list = el("mkui-history-list");
  const diff = el("mkui-history-diff");
  body.append(list, diff);
  root.append(head, body);
  host.textContent = "";
  host.appendChild(root);

  /* ── State ────────────────────────────────────────────────────────── */

  let record = null;      // { key, version, row } — the record on show
  let chain = null;       // parseChain result
  let cursor = null;      // cursorOf result
  let selVersion = null;  // the version being viewed
  let baseVersion = null; // what it is compared against (null = its predecessor)
  let showUnchanged = false;
  let panel = "diff";     // "diff" | "blame"
  let keyCols = null;     // resolved primary key columns
  let loadGen = 0;        // cancels a load whose record changed under it
  let client = null;

  const status = (msg, cls = "") => {
    diff.textContent = "";
    const n = el(`mkui-history-empty ${cls}`.trim());
    n.textContent = msg;
    diff.appendChild(n);
  };

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

  // Everything the pane knows about one record: its versions, and where the
  // live row sits among them. The cursor is the base row's `_mkio_version`
  // when the table's service passes it through; a `state` service answers
  // for one that doesn't (and for a record whose row is gone entirely).
  async function load() {
    const gen = ++loadGen;
    const h = hspec();
    if (!h?.versions) {
      title.textContent = "History";
      sub.textContent = "";
      status(h ? "No `versions` service is configured for this table." : "This table has no `history` block.", "mkui-history-config");
      list.textContent = "";
      return;
    }
    if (!record) {
      title.textContent = "History";
      sub.textContent = "";
      list.textContent = "";
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

    let reply;
    try {
      reply = await client.request(h.versions, key);
    } catch (e) {
      status(`Could not read '${h.versions}': ${e.message}`, "mkui-history-error");
      return;
    }
    if (gen !== loadGen) return;
    if (reply?.type === "error") {
      status(`'${h.versions}' refused: ${reply.message}`, "mkui-history-error");
      return;
    }

    chain = parseChain(rowsOf(reply), { fields: h.fields });

    // The live row's version is the cursor. Without one — a service that
    // drops `_mkio_version`, or a row undone out of existence — ask the
    // `state` service if there is one; a null `current` from it is an
    // answer (the row is gone, cursor 0), not a missing one. Failing that
    // the chain shows with no cursor rather than a guessed one.
    let current = record.version;
    let known = current != null;
    if (!known && h.state) {
      try {
        const st = rowsOf(await client.request(h.state, key))[0];
        if (gen !== loadGen) return;
        if (st && "current" in st) { current = st.current ?? 0; known = true; }
      } catch (e) {
        console.warn(`[mkio-history] '${h.state}' failed: ${e.message}`);
      }
    }
    cursor = known ? cursorOf(chain, current) : null;

    // Open on the version the row is at, else the newest recorded.
    selVersion = cursor?.current && chain.byVersion.has(cursor.current)
      ? cursor.current : chain.top || null;
    baseVersion = null;
    render();
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
    } else if (chain) {
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
    renderList();
    renderPanel();
  }

  function renderList() {
    list.textContent = "";
    if (!chain) return;
    // Newest first: the version a reader is looking for is usually a recent
    // one, and the redo branch sits above the cursor as the model draws it.
    const desc = [...chain.versions].reverse();
    let prev = null;
    for (const entry of desc) {
      if (prev && prev.version > entry.version + 1) {
        const gap = el("mkui-history-gap");
        gap.textContent = `${plural(prev.version - entry.version - 1, "version")} archived`;
        list.appendChild(gap);
      }
      prev = entry;

      const row = el("mkui-history-ver");
      row.dataset.version = String(entry.version);
      if (cursor && entry.version === cursor.current) row.classList.add("current");
      if (cursor && entry.version > cursor.current) row.classList.add("ahead");
      if (entry.version === selVersion) row.classList.add("sel");
      if (entry.version === baseVersion) row.classList.add("base");

      const num = el("mkui-history-vnum");
      num.textContent = `v${entry.version}`;
      const op = el("mkui-history-op");
      op.textContent = entry.op ?? "";
      if (entry.op) op.dataset.op = String(entry.op);
      const user = el("mkui-history-user");
      user.textContent = entry.user ?? "";
      const when = el("mkui-history-when");
      when.textContent = fmtWhen(entry.ref);
      when.title = entry.ref ?? "";
      row.append(num, op, user, when);
      if (cursor && entry.version === cursor.current) row.title = "The version this row is on";
      else if (cursor && entry.version > cursor.current) row.title = "Redo: reachable, until the next edit discards it";

      row.addEventListener("mousedown", (ev) => {
        if (ev.button !== 0) return;
        // Ctrl/cmd-click pins the other side of the comparison, so any two
        // versions can be diffed; clicking it again releases it.
        if (ev.ctrlKey || ev.metaKey) {
          baseVersion = baseVersion === entry.version ? null : entry.version;
        } else {
          selVersion = entry.version;
          if (baseVersion === entry.version) baseVersion = null;
        }
        render();
      });
      list.appendChild(row);
    }
  }

  // The two versions on show: the selected one, against the pinned base or
  // else its own predecessor (nothing, at the first recorded version).
  function diffPair() {
    if (!chain || selVersion == null) return [null, null, null, null];
    const to = chain.byVersion.get(selVersion) ?? null;
    if (baseVersion != null && baseVersion !== selVersion) {
      const a = chain.byVersion.get(baseVersion) ?? null;
      // Always read low → high, whichever was clicked first.
      return baseVersion < selVersion ? [a, to, baseVersion, selVersion] : [to, a, selVersion, baseVersion];
    }
    let from = null;
    for (const v of chain.versions) if (v.version < selVersion) from = v;
    return [from, to, from?.version ?? null, selVersion];
  }

  // The panel header, shared by both views: what is on show, how much of
  // it, the Diff | Blame switch, and whatever else the view offers.
  function panelHead(what, count, extra = null) {
    const dhead = el("mkui-history-diffhead");
    const pair = el("mkui-history-pair");
    pair.textContent = what;
    const n = el("mkui-history-count");
    n.textContent = count;
    const views = el("mkui-history-views");
    for (const [name, text, title] of [
      ["diff", "Diff", "What changed between two versions"],
      ["blame", "Blame", "Which version last set each field, and who"],
    ]) {
      const b = el("mkui-history-view", "button");
      if (panel === name) b.classList.add("active");
      b.textContent = text;
      b.title = title;
      b.addEventListener("mousedown", (ev) => {
        if (ev.button !== 0 || panel === name) return;
        panel = name;
        renderPanel();
      });
      views.appendChild(b);
    }
    dhead.append(pair, n, views);
    if (extra) dhead.appendChild(extra);
    diff.appendChild(dhead);
    return dhead;
  }

  function renderPanel() {
    diff.textContent = "";
    if (!chain) return;
    if (!chain.versions.length) {
      status("No versions are recorded for this record.");
      return;
    }
    if (panel === "blame") renderBlame(); else renderDiff();
  }

  // Per-field provenance as at the selected version: the version that last
  // gave each field the value it has there, and who wrote it. Clicking a
  // line goes to that version, so blame is a way to navigate the chain and
  // not only to read it.
  function renderBlame() {
    const h = hspec();
    const cols = h?.columns ?? chain.columns;
    const at = chain.byVersion.get(selVersion) ?? null;
    const who = blame(chain, { columns: cols, upto: selVersion });
    const known = cols.filter((c) => who[c]);
    panelHead(`as at v${selVersion}`, `${known.length} of ${plural(cols.length, "field")} set`);

    const fields = el("mkui-history-fields");
    for (const col of cols) {
      const b = who[col];
      const line = el("mkui-history-blame");
      if (!b) line.classList.add("mkui-history-unset");
      const name = el("mkui-history-fname");
      name.textContent = label(col);
      name.title = col;
      const val = el("mkui-history-bvalue");
      if (at && at.values[col] != null && at.values[col] !== "") {
        const shownVal = shown(at.values, col);
        if (shownVal.rich) renderRich(val, shownVal.rich);
        else val.textContent = shownVal.text;
      } else {
        val.classList.add("mkui-history-blank");
        val.textContent = "—";
      }
      const src = el("mkui-history-bwho");
      if (b) {
        src.textContent = [`v${b.version}`, b.user, fmtWhen(b.ref)].filter(Boolean).join(" · ");
        src.title = `${label(col)} last changed at v${b.version}${b.user ? ` by ${b.user}` : ""}`;
        line.addEventListener("mousedown", (ev) => {
          if (ev.button !== 0) return;
          selVersion = b.version;
          baseVersion = null;
          render();
        });
      } else {
        src.textContent = "never set";
      }
      line.append(name, val, src);
      fields.appendChild(line);
    }
    diff.appendChild(fields);
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
    diff.appendChild(fields);
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

  /* ── Following the table ──────────────────────────────────────────── */

  // The record the source table's selection implies: its first selected
  // row, with the version it currently sits on.
  function readSelection() {
    const hook = srcHook();
    const rows = hook?.rows?.() ?? [];
    if (!rows.length) return null;
    const row = rows[0];
    return { key: null, row, version: row?._mkio_version ?? null, of: rows.length };
  }

  const sameRecord = (a, b) =>
    a === b || (!!a && !!b && a.row === b.row && a.of === b.of);

  function refresh(force = false) {
    const next = readSelection();
    if (!force && sameRecord(next, record)) return;
    record = next;
    chain = null;
    cursor = null;
    selVersion = null;
    baseVersion = null;
    load();
  }

  reload.addEventListener("mousedown", (ev) => { if (ev.button === 0) refresh(true); });

  client = await ensureMkio(wsUrl);

  // Follow the table: every selection change re-reads the record, so
  // clicking down a table walks its records' histories.
  let unfollow = null;
  function follow() {
    unfollow?.();
    unfollow = srcId == null ? null : getWs()?.onPaneSelection?.(srcId, () => refresh()) ?? null;
  }

  if (paneEl) {
    // Copy hook: Ctrl/Cmd+C and `edit.copy` take the diff as it is shown —
    // a grid of field, before, after — in TSV and HTML, like a table's.
    paneEl._editActions = { copy: () => copyDiff() };
    paneEl.addEventListener("mkui-pane-open", () => { follow(); refresh(true); });
    paneEl.addEventListener("mkui-pane-close", () => { unfollow?.(); unfollow = null; });
  }

  // The panel as it is shown, as a grid: the diff's two columns, or
  // blame's value and provenance.
  function copyGrid() {
    const h = hspec();
    const cols = h?.columns ?? chain.columns;
    if (panel === "blame") {
      const at = chain.byVersion.get(selVersion) ?? null;
      const who = blame(chain, { columns: cols, upto: selVersion });
      const grid = [["", `v${selVersion}`, "Version", "User", "When"]];
      for (const col of cols) {
        const b = who[col];
        grid.push([label(col), at ? shown(at.values, col).text : "",
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

  function copyDiff() {
    if (!chain || !chain.versions.length) return false;
    const grid = copyGrid();
    const write = navigator?.clipboard?.write;
    if (!write) return false;
    const item = new ClipboardItem({
      "text/plain": new Blob([gridToTSV(grid)], { type: "text/plain" }),
      "text/html": new Blob([gridToHTML(grid)], { type: "text/html" }),
    });
    navigator.clipboard.write([item]).catch((e) => console.warn(`[mkio-history] copy failed: ${e.message}`));
    app.state.set("status.message", `Copied ${plural(grid.length - 1, "field")}`);
    return true;
  }

  follow();
  refresh(true);

  // The pane's own hook: `showPaneHistory` re-points an open pane at
  // whatever the table has selected now.
  if (paneEl) paneEl._record = { refresh: () => refresh(true), get: () => record };
});
