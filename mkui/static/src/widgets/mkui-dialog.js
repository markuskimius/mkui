import { resolveExpr, resolveObject, evalExpr, expr } from "../lib/expressions.js";
import { icon } from "../lib/icons.js";
import { strptime, parseTime, inputToBound, boundToInput, inputTypeForKind, kindForFormat, detectTimeKind } from "../lib/timeparse.js";

let dialogSeq = 0;

// Temporal fields render as the browser's native pickers. What they hold
// and submit is canonical: a `date` is `YYYY-MM-DD`, a `time` `HH:MM:SS`,
// and a `datetime` an ISO-8601 UTC instant (`YYYY-MM-DDTHH:MM:SS[.fff]Z`) —
// the picker shows the browser's local wall clock, and only the browser
// knows that zone, so the conversion happens here rather than on a server.
// An incoming value (a default, a compute, a reset) is an ISO string or
// mkio ref (naive = UTC, as everywhere in mkui), or, with `parse`, one of
// those strftime formats read in `tz`. A `datetime` with `time: "optional"`
// is a date picker beside a time picker: with the time blank it holds and
// submits the bare date, so one field can mean "this day" or "this instant".
const TEMPORAL = { date: "date", time: "time", datetime: "datetime" };

const optionalTime = (field) => field.type === "datetime" && field.time === "optional";

// `{ secs, kind }` for an incoming value, or null.
function temporalParse(field, v) {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v).trim();
  const fmts = field.parse == null ? [] : [].concat(field.parse);
  for (const fmt of fmts) {
    const secs = strptime(s, fmt, field.tz);
    if (secs !== null) return { secs, kind: kindForFormat(fmt) };
  }
  const secs = parseTime(s);
  return secs === null ? null : { secs, kind: detectTimeKind(s) ?? TEMPORAL[field.type] };
}

// The canonical string for a kind: a date, a clock time, or a UTC instant.
function canonicalTemporal(kind, secs) {
  if (secs === null || secs === undefined || !Number.isFinite(secs)) return "";
  if (kind !== "datetime") return boundToInput(secs, kind);
  const ms = Math.round((secs - Math.floor(secs)) * 1000);
  const whole = Math.floor(secs) + (ms === 1000 ? 1 : 0);
  const frac = ms === 0 || ms === 1000 ? "" : "." + String(ms).padStart(3, "0");
  return boundToInput(whole, "datetime") + frac + "Z";
}

// What a field holds for a parsed value: its own kind, except that an
// optional-time field keeps a bare date as one.
function temporalValue(field, parsed) {
  if (!parsed) return "";
  const kind = optionalTime(field) && parsed.kind === "date" ? "date" : TEMPORAL[field.type];
  return canonicalTemporal(kind, parsed.secs);
}

// Picker string(s) for a parsed value: `{ date, time }` for the optional
// pair, else the one control's value.
function temporalInput(field, parsed) {
  if (optionalTime(field)) {
    if (!parsed) return { date: "", time: "" };
    if (parsed.kind === "date") return { date: boundToInput(parsed.secs, "date"), time: "" };
    const [date, time] = boundToInput(parsed.secs, "datetime", true).split("T");
    return { date, time };
  }
  const kind = TEMPORAL[field.type];
  return parsed ? boundToInput(parsed.secs, kind, kind === "datetime") : "";
}

function temporalRead(type, str) {
  const kind = TEMPORAL[type];
  return canonicalTemporal(kind, inputToBound(str, kind, "lo", kind === "datetime"));
}

function temporalReadPair(date, time) {
  if (!date) return "";
  if (!time) return canonicalTemporal("date", inputToBound(date, "date", "lo"));
  return temporalRead("datetime", `${date}T${time}`);
}

// Computed fields may feed each other; the dynamic pass repeats until no
// field value changes, giving up (and warning) after this many rounds.
export const MAX_COMPUTE_PASSES = 8;

export function openDialog(spec, context, app, extra = {}) {
  return new Promise((resolve) => {
    const ws = app._element?.workspace ?? app._element?._workspace;
    if (!ws) {
      console.error("[mkui-dialog] no workspace found");
      resolve(null);
      return;
    }

    const paneId = `_dialog-${++dialogSeq}`;
    let resolved = false;

    // `fieldState` is keyed by name: only named fields have a value the
    // form can read or submit. The DOM-side maps are keyed by `keyOf(f)` —
    // the name, or a synthetic key for a nameless field (a read-only line,
    // say), so its value, compute, and showWhen still apply.
    const fieldState = {};   // name → current value (what submit sends)
    const fieldEls = {};     // key → wrapper div
    const fieldInputs = {};  // key → input / select / textarea
    const fieldParts = {};   // key → { label, ro } extra DOM refs
    const resolvedAttrs = {}; // key → { required, disabled, readonly, min, max, step, pattern }
    const optionsKey = {};   // key → key of the option list last built
    const optionRows = {};   // key → the rows an optionsFrom select was built from
    const pendingRecall = new Set(); // selects whose remembered value awaits their options
    const wanted = {};       // key → value asked of an optionsFrom select before its options arrived
    const storage = extra?.storage ?? (typeof localStorage !== "undefined" ? localStorage : null);
    const rememberKey = (f) => typeof f.remember === "string" ? f.remember : f.remember?.key;
    const dirty = new Set(); // keys the user has typed into (compute stays off them)
    const allFields = [];
    const anonKey = new Map(); // nameless field → its synthetic key
    const keyOf = (f) => f.name || anonKey.get(f);
    const rowOf = new Map(); // field → the { row } item holding it
    const containers = [];   // [{ item, el }] for sections and rows: showWhen
    const sections = [];     // [{ item, el, head, label, body, summary?, open }] per { group }
    const sectionOf = new Map(); // field → the { group } item heading it
    const initial = {};      // name → value at open (or the last reset): what "changed" means
    let computeWarned = false;
    let built = false;       // the dynamic pass waits for the whole form

    // A `{ group }` heads a section: every item up to the next one is under
    // it, so its showWhen hides them and `collapsible` folds them. One
    // carrying `fields` is bounded — it holds those alone, and what follows
    // it stays where it was (the root, or the open section around it).
    function flattenFields(items, row = null, group = null) {
      for (const item of items) {
        if (item.group != null) {
          if (Array.isArray(item.fields)) flattenFields(item.fields, null, item);
          else group = item;
          continue;
        }
        if (item.row) { flattenFields(item.row, item, group); continue; }
        if (!item.name) anonKey.set(item, `#${allFields.length}`);
        allFields.push(item);
        if (row) rowOf.set(item, row);
        if (group) sectionOf.set(item, group);
      }
    }
    flattenFields(spec.fields ?? []);

    // Scope for every expression the form evaluates after it opens: the
    // fields at the root (shadowing the dialog context), plus `form`, the
    // context (row, rows, selection, state, ...).
    // Number fields hold strings in `fieldState` (what submit sends); the
    // scope sees them as numbers, an empty one as NULL, so `qty * price`
    // works and `(qty ?? 0) > 0` guards the blank.
    function formScope() {
      const vals = { ...fieldState };
      for (const f of allFields) {
        if (f.type !== "number" || !f.name) continue;
        const v = vals[f.name];
        if (v === "" || v == null) { vals[f.name] = null; continue; }
        const n = Number(v);
        if (Number.isFinite(n)) vals[f.name] = n;
      }
      return { ...context, ...vals, form: vals };
    }
    // A flag key (`showWhen`, `required`, `disabled`, `readonly`) is a
    // literal boolean or an expression string.
    function truthy(cond) {
      if (cond == null) return false;
      if (typeof cond !== "string") return !!cond;
      return expr.truthy(evalExpr(cond, formScope()));
    }
    const shown = (cond) => cond == null ? true : truthy(cond);
    // `value` is the one-time default; `compute` re-evaluates on every change.
    // Either is a bare expression, or a `${...}` template when it holds one.
    function evalValue(src) {
      if (typeof src !== "string") return src ?? "";
      if (src.includes("${")) return resolveExpr(src, formScope());
      const v = evalExpr(src, formScope());
      return v == null ? "" : v;
    }
    function defaultValue(field) {
      return field.value == null ? "" : resolveExpr(field.value, formScope());
    }
    function isShown(field) {
      if (!shown(field.showWhen)) return false;
      const row = rowOf.get(field);
      if (row && !shown(row.showWhen)) return false;
      const group = sectionOf.get(field);
      return group ? shown(group.showWhen) : true;
    }

    // Write a value into a field's DOM and (when named) its state; true
    // when the state changed.
    function setFieldValue(field, v) {
      const name = field.name;
      const key = keyOf(field);
      const input = fieldInputs[key];
      let next;
      if (field.type === "hidden") {
        next = v;
      } else if (field.type === "readonly") {
        next = v;
        const ro = fieldParts[key]?.ro;
        if (ro) ro.textContent = v == null ? "" : String(v);
      } else if (field.type === "checkbox") {
        next = !!v;
        if (input) input.checked = next;
      } else if (field.type === "select") {
        if (input) {
          const want = v == null || v === "" ? "" : String(v);
          input.value = want !== "" ? want : (input.options?.[0]?.value ?? "");
          next = input.value;
          // A service-backed select asked for a value its options don't
          // hold yet (a default, a compute, a fill from another select's
          // pick, while both lists are still loading) keeps the ask and
          // honours it when the options arrive.
          if (want !== "" && next !== want && field.optionsFrom && !Array.isArray(optionRows[key])) {
            wanted[key] = want;
            next = want;
          }
        } else next = v == null ? "" : String(v);
      } else if (TEMPORAL[field.type]) {
        const parsed = temporalParse(field, v);
        next = temporalValue(field, parsed);
        const shown = temporalInput(field, parsed);
        if (optionalTime(field)) {
          if (input) input.value = shown.date;
          const time = fieldParts[key]?.time;
          if (time) time.value = shown.time;
        } else if (input) input.value = shown;
      } else {
        next = v == null ? "" : String(v);
        if (input) input.value = next;
      }
      if (!name) return false;
      const changed = !Object.is(fieldState[name], next);
      fieldState[name] = next;
      return changed;
    }

    // A section: the header, then a body holding the items under it. A
    // collapsible one gets a caret, a summary badge, and a head that is a
    // button — click, Enter or Space fold it, alt/option folds every
    // section the same way.
    function renderSection(item) {
      const el = document.createElement("div");
      el.className = "mkui-dialog-section";
      const head = document.createElement("div");
      head.className = "mkui-dialog-group";
      const label = document.createElement("span");
      label.className = "mkui-dialog-group-label";
      label.textContent = resolveExpr(item.group, formScope());
      const sbody = document.createElement("div");
      sbody.className = "mkui-dialog-section-body";
      const sec = { item, el, head, label, body: sbody, open: true };
      if (item.collapsible) {
        el.classList.add("mkui-dialog-collapsible");
        const caret = document.createElement("span");
        caret.className = "mkui-dialog-caret";
        caret.appendChild(icon("chevron-right"));
        const summary = document.createElement("span");
        summary.className = "mkui-dialog-group-summary";
        head.append(caret, label, summary);
        head.tabIndex = 0;
        head.setAttribute("role", "button");
        head.addEventListener("click", (ev) => toggleSection(sec, ev.altKey));
        head.addEventListener("keydown", (ev) => {
          if (ev.key !== "Enter" && ev.key !== " ") return;
          ev.preventDefault();
          ev.stopPropagation(); // Enter on the head folds; it never submits
          toggleSection(sec, ev.altKey);
        });
        sec.summary = summary;
      } else head.appendChild(label);
      el.append(head, sbody);
      sections.push(sec);
      return sec;
    }

    function setSectionOpen(sec, open) {
      sec.open = open;
      sec.el.classList.toggle("mkui-dialog-collapsed", !open);
      sec.head.setAttribute("aria-expanded", String(open));
      syncSection(sec);
    }
    function toggleSection(sec, all = false) {
      const open = !sec.open;
      for (const s of all ? sections.filter((x) => x.item.collapsible) : [sec]) {
        setSectionOpen(s, open);
        // Fold state is a preference, kept the moment it changes — unlike a
        // field's `remember`, which waits for a confirmed submit.
        const key = s.item.remember;
        if (key && storage) {
          try { storage.setItem(key, open ? "open" : "closed"); } catch { /* full or blocked */ }
        }
      }
      fitFrame();
    }
    // Remembered, else `collapsed` (a boolean or an expression) read once.
    function initialFold(sec) {
      const key = sec.item.remember;
      if (key && storage) {
        let v = null;
        try { v = storage.getItem(key); } catch { /* blocked */ }
        if (v === "open" || v === "closed") return v === "open";
      }
      return !truthy(sec.item.collapsed);
    }
    // The header's text, and — while folded — its summary: `summary`, a
    // template, else how many of its fields no longer hold what they
    // opened with, so a folded section can't hide a change from view.
    function syncSection(sec) {
      const t = resolveExpr(sec.item.group, formScope());
      if (sec.label.textContent !== t) sec.label.textContent = t;
      if (!sec.summary) return;
      let s = "";
      if (!sec.open) {
        if (sec.item.summary != null) s = resolveExpr(sec.item.summary, formScope());
        else { const n = changedIn(sec); s = n ? `${n} changed` : ""; }
      }
      s = s == null ? "" : String(s);
      if (sec.summary.textContent !== s) sec.summary.textContent = s;
    }
    function changedIn(sec) {
      let n = 0;
      for (const f of allFields) {
        if (sectionOf.get(f) !== sec.item || !f.name) continue;
        if (f.type === "hidden" || f.type === "readonly" || !isShown(f)) continue;
        if (!Object.is(fieldState[f.name], initial[f.name])) n++;
      }
      return n;
    }
    function snapshotInitial() {
      for (const f of allFields) if (f.name) initial[f.name] = fieldState[f.name];
      for (const sec of sections) syncSection(sec);
    }

    function renderFieldItem(field) {
      if (field.type === "hidden") {
        setFieldValue(field, defaultValue(field));
        return null;
      }

      const wrapper = document.createElement("div");
      wrapper.className = "mkui-dialog-field";
      const parts = {};

      if (field.label != null) {
        const lbl = document.createElement("label");
        lbl.textContent = resolveExpr(field.label, formScope());
        wrapper.appendChild(lbl);
        parts.label = lbl;
      }

      const onEdit = (input, read) => () => {
        dirty.add(keyOf(field));
        if (field.name) fieldState[field.name] = read(input);
        onFieldChange(field.name ?? null, applyFill(field));
      };

      let input;
      if (field.type === "readonly") {
        const ro = document.createElement("div");
        ro.className = "mkui-dialog-readonly";
        wrapper.appendChild(ro);
        parts.ro = ro;
      } else if (field.type === "select") {
        input = document.createElement("select");
        populateSelect(input, field, extra);
        input.addEventListener("change", onEdit(input, (i) => i.value));
        wrapper.appendChild(input);
      } else if (field.type === "checkbox") {
        input = document.createElement("input");
        input.type = "checkbox";
        input.style.width = "auto";
        input.addEventListener("change", onEdit(input, (i) => i.checked));
        wrapper.appendChild(input);
      } else if (field.type === "textarea") {
        input = document.createElement("textarea");
        if (field.rows) input.rows = field.rows;
        input.addEventListener("input", onEdit(input, (i) => i.value));
        wrapper.appendChild(input);
      } else if (optionalTime(field)) {
        const pair = document.createElement("div");
        pair.className = "mkui-dialog-datetime";
        // Side by side even under a stylesheet cached from before this type.
        pair.style.display = "flex";
        pair.style.gap = "6px";
        input = document.createElement("input");
        input.type = "date";
        input.style.flex = "1";
        input.style.minWidth = "0";
        const time = document.createElement("input");
        time.type = "time";
        time.style.flex = "1";
        time.style.minWidth = "0";
        const read = () => temporalReadPair(input.value, time.value);
        input.addEventListener("input", onEdit(input, read));
        time.addEventListener("input", onEdit(time, read));
        pair.append(input, time);
        wrapper.appendChild(pair);
        parts.time = time;
      } else if (TEMPORAL[field.type]) {
        input = document.createElement("input");
        input.type = inputTypeForKind(TEMPORAL[field.type]);
        input.addEventListener("input", onEdit(input, (i) => temporalRead(field.type, i.value)));
        wrapper.appendChild(input);
      } else {
        input = document.createElement("input");
        input.type = field.type === "number" ? "number" : "text";
        input.addEventListener("input", onEdit(input, (i) => i.value));
        wrapper.appendChild(input);
      }

      const key = keyOf(field);
      fieldEls[key] = wrapper;
      fieldParts[key] = parts;
      if (input) fieldInputs[key] = input;
      if (field.type === "select") syncOptions(field);
      setFieldValue(field, defaultValue(field));
      if (field.type === "select") fetchOptionsFrom(input, field, extra);

      return wrapper;
    }

    ws.registerPane(paneId, {
      title: resolveExpr(spec.title ?? "Dialog", context),
      type: "_dialog",
    });
    let currentTitle = resolveExpr(spec.title ?? "Dialog", context);

    const widthPx = spec.width ?? 400;
    const wsRect = ws.getBoundingClientRect();
    const wFrac = Math.min(widthPx / wsRect.width, 0.9);
    const hFrac = Math.min(0.6, 400 / wsRect.height);
    const xFrac = Math.max(0, (1 - wFrac) / 2);
    const yFrac = Math.max(0, (1 - hFrac) / 2);

    let pinned = false;
    function makePinBtn() {
      const btn = document.createElement("div");
      btn.className = "mkui-frame-btn mkui-dialog-pin" + (pinned ? " mkui-dialog-pin-active" : "");
      btn.appendChild(icon("pin"));
      btn.title = pinned ? "Pinned — will stay open after submit" : "Pin to keep open after submit";
      btn.addEventListener("mousedown", (ev) => ev.stopPropagation());
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        pinned = !pinned;
        btn.classList.toggle("mkui-dialog-pin-active", pinned);
        btn.title = pinned ? "Pinned — will stay open after submit" : "Pin to keep open after submit";
      });
      return btn;
    }

    const frameId = ws.addFrame({
      x: xFrac, y: yFrac, w: wFrac, h: hFrac,
      stayOnTop: true,
      noDock: true,
      layout: { type: "tabs", active: 0, children: [paneId] },
    });

    const frameEl = ws._frameEls.get(frameId);
    if (frameEl) {
      frameEl._extraControls = () => [makePinBtn()];
      frameEl._renderInternal();
    }

    const paneEl = ws._paneEls.get(paneId);
    if (!paneEl) { resolve(null); return; }
    const host = paneEl.contentEl;
    host.textContent = "";

    const container = document.createElement("div");
    container.className = "mkui-dialog-content";

    const body = document.createElement("div");
    body.className = "mkui-dialog-body";

    // `target` is the body, or the open section's; a bounded section renders
    // its own fields into itself and leaves the target alone.
    function renderItems(items, target) {
      for (const item of items) {
        if (item.group != null) {
          const sec = renderSection(item);
          target.appendChild(sec.el);
          containers.push({ item, el: sec.el });
          if (Array.isArray(item.fields)) renderItems(item.fields, sec.body);
          else target = sec.body;
          continue;
        }

        if (item.row) {
          const rowDiv = document.createElement("div");
          rowDiv.className = "mkui-dialog-row";
          for (const f of item.row) {
            const el = renderFieldItem(f);
            if (el) {
              if (f.width) el.style.flex = `1 1 ${f.width * 100}%`;
              rowDiv.appendChild(el);
            }
          }
          target.appendChild(rowDiv);
          containers.push({ item, el: rowDiv });
          continue;
        }

        const el = renderFieldItem(item);
        if (el) target.appendChild(el);
      }
    }
    renderItems(spec.fields ?? [], body);

    container.appendChild(body);

    const footer = document.createElement("div");
    footer.className = "mkui-dialog-footer";

    const status = document.createElement("span");
    status.className = "mkui-dialog-status";
    footer.appendChild(status);
    // The note shares the span with submit feedback ("Sending...", errors,
    // "OK"); it is rewritten only when its own text changes.
    let lastNote;
    function syncNote() {
      if (!spec.footer?.note) return;
      const t = resolveExpr(spec.footer.note, formScope());
      if (t === lastNote) return;
      lastNote = t;
      status.textContent = t;
      status.className = "mkui-dialog-status";
    }

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "mkui-btn";
    cancelBtn.textContent = spec.cancel?.label ?? "Cancel";
    cancelBtn.addEventListener("click", close);

    const submitBtn = document.createElement("button");
    submitBtn.className = "mkui-btn mkui-btn-primary";
    submitBtn.textContent = spec.submit?.label ?? "OK";
    submitBtn.addEventListener("click", submit);

    footer.append(cancelBtn, submitBtn);
    container.appendChild(footer);

    host.appendChild(container);

    const firstInput = host.querySelector("input:not([type=hidden]):not([type=checkbox]), select, textarea");
    firstInput?.focus();

    const onKey = (e) => {
      if (e.key === "Escape") close();
      if (e.key === "Enter" && e.target.tagName !== "TEXTAREA") submit();
    };
    host.addEventListener("keydown", onKey);

    paneEl.addEventListener("mkui-pane-close", () => {
      if (!resolved) {
        resolved = true;
        host.removeEventListener("keydown", onKey);
        queueMicrotask(() => ws.unregisterPane(paneId));
        resolve(null);
      }
    });

    built = true;
    onFieldChange(null, recallAll());
    snapshotInitial();
    for (const sec of sections) if (sec.item.collapsible) setSectionOpen(sec, initialFold(sec));
    let seen = false; // the open-time fit may re-center; after it, the title bar is the anchor
    fitFrame();
    seen = true;

    // The frame's height is a guess: when the body has to scroll — at open,
    // or once a section unfolds — grow the frame by the overflow so the
    // whole form and the footer show, capped at 90% of the workspace.
    // Never shrinks: a fold leaves room, not a jump. The open-time fit
    // re-centers vertically, nothing having been seen yet; afterwards the
    // title bar stays where it is (or where it was dragged) and the frame
    // grows downward, moving up only by what would fall off the bottom.
    function fitFrame() {
      const bodyOverflow = body.scrollHeight - body.clientHeight;
      if (bodyOverflow <= 0) return;
      const fspec = ws._frames.find((f) => f.id === frameId);
      const rect = ws.getBoundingClientRect();
      if (!fspec || !(rect.height > 0)) return;
      const curPx = frameEl?.offsetHeight ?? fspec.h * rect.height;
      const newFrac = Math.min((curPx + bodyOverflow) / rect.height, 0.9);
      if (newFrac <= fspec.h) return;
      fspec.h = newFrac;
      fspec.y = seen ? Math.min(fspec.y, 1 - newFrac) : Math.max(0, (1 - newFrac) / 2);
      ws._layoutFrames();
    }

    // `fill = { field: column }` on a service-backed select copies the
    // picked row's columns into other fields — a Template dropdown filling
    // an order form. A blank column is skipped, so a template can leave a
    // field to the user; a filled field counts as edited, so its compute
    // yields to the pick, and a later pick overrides a typed value. Returns
    // the fields it moved.
    function applyFill(field) {
      if (!field.fill || field.type !== "select") return [];
      const rows = optionRows[keyOf(field)];
      const sel = fieldInputs[keyOf(field)];
      const col = field.optionsFrom?.value;
      const picked = rows && col ? rows.find((r) => String(r[col] ?? "") === String(sel?.value ?? "")) : null;
      if (!picked) return [];
      const filled = [];
      for (const [target, column] of Object.entries(field.fill)) {
        const v = picked[column];
        if (v == null || v === "") continue;
        const tf = allFields.find((f) => f.name === target && f.type !== "readonly");
        if (!tf) continue;
        dirty.add(keyOf(tf));
        if (setFieldValue(tf, v)) filled.push(target);
      }
      return filled;
    }

    // `remember = "key"` (or `{ key, value }`) keeps a field across
    // openings in localStorage (`extra.storage` in tests): a confirmed
    // submit stores its value — or `value`, an expression over the form,
    // for a pick a typed name should stand in for — and the next opening
    // starts the field from it, a service-backed select once its options
    // hold the value, running its fill as a pick would.
    function recalled(f) {
      const key = rememberKey(f);
      if (!key || !storage) return null;
      try { return storage.getItem(key); } catch { return null; }
    }
    // Apply a field's remembered value; the fields a select's fill moved.
    function recallField(f) {
      const v = recalled(f);
      if (v == null || v === "" || f.type === "readonly") return [];
      if (f.type === "select" && f.optionsFrom) {
        const sel = fieldInputs[keyOf(f)];
        if (!Array.isArray(optionRows[keyOf(f)]) || !sel) { pendingRecall.add(f); return []; }
        if (![...sel.options].some((o) => o.value === v)) return [];
        sel.value = v;
        if (f.name) fieldState[f.name] = v;
        return applyFill(f);
      }
      setFieldValue(f, v);
      return [];
    }
    function recallAll() {
      const filled = [];
      for (const f of allFields) filled.push(...recallField(f));
      return filled;
    }
    function storeRemembered() {
      if (!storage) return;
      for (const f of allFields) {
        const key = rememberKey(f);
        if (!key) continue;
        const v = f.remember?.value != null ? evalValue(f.remember.value) : (f.name ? fieldState[f.name] : "");
        try { storage.setItem(key, v == null ? "" : String(v)); } catch { /* full or blocked: nothing to remember */ }
      }
    }

    // `name` is the edited field (null at open), `filled` the fields a
    // pick copied into. Service-backed options re-fetch for them and for
    // every field a compute moved along the way.
    function onFieldChange(name, filled = []) {
      const before = { ...fieldState };
      applyDynamic();
      const moved = new Set(name == null ? [] : [name, ...filled]);
      for (const k of Object.keys(fieldState)) if (!Object.is(before[k], fieldState[k])) moved.add(k);
      for (const k of moved) refreshDependentOptions(k);
    }

    // The dynamic pass: computed values and option lists to a fixed point,
    // then visibility, labels, attributes, title, and footer note.
    function applyDynamic() {
      if (resolved || !built) return;
      for (let pass = 0; ; pass++) {
        let changed = false;
        for (const f of allFields) {
          if (f.compute == null || dirty.has(keyOf(f))) continue;
          if (setFieldValue(f, evalValue(f.compute))) changed = true;
        }
        for (const f of allFields) if (syncOptions(f)) changed = true;
        if (!changed) break;
        if (pass >= MAX_COMPUTE_PASSES) {
          if (!computeWarned) {
            computeWarned = true;
            console.warn("[mkui-dialog] computed fields did not settle (a compute cycle?)");
          }
          break;
        }
      }

      for (const { item, el } of containers) el.style.display = shown(item.showWhen) ? "" : "none";
      for (const sec of sections) syncSection(sec);
      for (const f of allFields) {
        const el = fieldEls[keyOf(f)];
        if (!el) continue;
        el.style.display = shown(f.showWhen) ? "" : "none";
        syncAttrs(f, el);
      }

      const title = resolveExpr(spec.title ?? "Dialog", formScope());
      if (title !== currentTitle) {
        currentTitle = title;
        ws.renamePane?.(paneId, title);
      }
      syncNote();
    }

    // Static `options` with per-option `showWhen`, or an expression yielding
    // the list; the select is rebuilt only when the list differs from the
    // one it holds. True when the rebuild moved the field's value.
    function syncOptions(f) {
      if (f.type !== "select" || f.optionsFrom || f.optionsFromColumn) return false;
      const sel = fieldInputs[keyOf(f)];
      if (!sel) return false;
      const opts = currentOptions(f);
      const key = JSON.stringify(opts.map((o) => [o.value, o.label]));
      if (optionsKey[keyOf(f)] === key) return false;
      optionsKey[keyOf(f)] = key;
      const prev = sel.value;
      sel.innerHTML = "";
      for (const o of opts) {
        const opt = document.createElement("option");
        opt.value = o.value;
        opt.textContent = o.label;
        sel.appendChild(opt);
      }
      const keep = [...sel.options].some((o) => o.value === prev);
      sel.value = keep ? prev : (sel.options[0]?.value ?? "");
      if (!f.name) return false;
      const changed = fieldState[f.name] !== sel.value;
      fieldState[f.name] = sel.value;
      return changed;
    }
    function currentOptions(f) {
      const raw = typeof f.options === "string" ? evalExpr(f.options, formScope()) : f.options;
      return normalizeOptions(raw).filter((o) => shown(o.showWhen));
    }

    function syncAttrs(f, el) {
      const scope = formScope();
      const a = {
        required: truthy(f.required),
        disabled: truthy(f.disabled),
        readonly: truthy(f.readonly),
        min: resolveExpr(f.min, scope),
        max: resolveExpr(f.max, scope),
        step: resolveExpr(f.step, scope),
        pattern: resolveExpr(f.pattern, scope),
      };
      resolvedAttrs[keyOf(f)] = a;
      const parts = fieldParts[keyOf(f)] ?? {};
      if (parts.label) {
        const t = resolveExpr(f.label, scope);
        if (parts.label.textContent !== t) parts.label.textContent = t;
      }
      const input = fieldInputs[keyOf(f)];
      if (!input) return;
      const holdsLoad = input._mkuiLoading === true;
      const plain = f.type !== "select" && f.type !== "checkbox";
      if (!holdsLoad) input.disabled = a.disabled || (!plain && a.readonly);
      if (plain) input.readOnly = a.readonly;
      if (f.placeholder != null) {
        const p = resolveExpr(f.placeholder, scope);
        if (input.placeholder !== p) input.placeholder = p;
      }
      // An optional-time pair: `step` is the time picker's (seconds), the
      // rest the date's, and both follow disabled/readonly together.
      const time = parts.time;
      const stepTarget = time ?? input;
      for (const k of ["min", "max", "step"]) {
        const v = a[k];
        const target = k === "step" ? stepTarget : input;
        if (v == null || v === "") target.removeAttribute?.(k);
        else if (String(target[k]) !== String(v)) target[k] = v;
      }
      if (time) {
        time.disabled = input.disabled;
        time.readOnly = input.readOnly;
      }
    }

    function refreshDependentOptions(changedField) {
      for (const f of allFields) {
        if (!f.optionsFrom) continue;
        const paramStr = JSON.stringify(f.optionsFrom.params ?? {});
        if (!paramStr.includes("${field." + changedField + "}")) continue;
        fetchOptionsFrom(fieldInputs[keyOf(f)], f, extra);
      }
    }

    function cleanup() {
      host.removeEventListener("keydown", onKey);
      ws.unregisterPane(paneId);
    }

    function close() {
      if (resolved) return;
      resolved = true;
      ws.closeFrame(frameId);
      cleanup();
      resolve(null);
    }

    function resetForm() {
      dirty.clear();
      for (const f of allFields) {
        if (f.type === "readonly" || f.type === "hidden") continue;
        setFieldValue(f, defaultValue(f));
        const el = fieldEls[keyOf(f)];
        if (el) {
          el.classList.remove("mkui-dialog-invalid");
          const err = el.querySelector(".mkui-dialog-error");
          if (err) err.remove();
        }
      }
      onFieldChange(null, recallAll());
      snapshotInitial();
      const firstInput = host.querySelector("input:not([type=hidden]):not([type=checkbox]), select, textarea");
      firstInput?.focus();
    }

    function collectData() {
      const data = {};
      for (const f of allFields) {
        if (!f.name || f.name.startsWith("_")) continue;
        if (f.type === "readonly") continue;
        if (!isShown(f)) continue;
        data[f.name] = fieldState[f.name] ?? "";
      }
      return data;
    }

    // `submit.then = { action, args }` fires an mkui action once a submit
    // has gone through — `table.select` on the pane that owns what was just
    // written, so the workspace follows the record the dialog made or moved
    // rather than leaving it wherever the linked panes were looking. `args`
    // resolve against what was submitted (the fields by name, `form`) over
    // the opening context, so `keys = ["${task_id}"]` names the record the
    // server received, scratch fields and all. A refused submit fires
    // nothing; a pinned one fires on every confirmation.
    function follow(data) {
      const then = spec.submit?.then;
      if (!then) return;
      if (typeof then !== "object" || !then.action) {
        console.warn("[mkui-dialog] submit.then: expected { action, args }");
        return;
      }
      if (typeof app?.fireAction !== "function") return;
      try {
        app.fireAction(then.action, resolveObject(then.args ?? null, { ...context, ...data, form: data }));
      } catch (e) {
        console.warn(`[mkui-dialog] submit.then ${then.action} failed: ${e.message}`);
      }
    }

    async function submit() {
      if (resolved) return;
      if (!validate()) return;
      const data = collectData();

      const client = extra.client;
      const svc = spec.submit?.service;
      if (svc && client?.send) {
        submitBtn.disabled = true;
        cancelBtn.disabled = true;
        status.textContent = "Sending...";
        status.className = "mkui-dialog-status";
        try {
          const sends = [];
          if (spec.submitPerRow && context.rows?.length > 0) {
            for (const row of context.rows) {
              const rowCtx = { ...context, row };
              const perRowData = resolveObject(spec.rowData ?? {}, rowCtx);
              sends.push(client.send(svc, { ...data, ...perRowData }, { op: spec.submit.op }));
            }
          } else {
            sends.push(client.send(svc, data, { op: spec.submit.op }));
          }
          const timeout = spec.submit?.timeout ?? 5000;
          const withTimeout = (p) => Promise.race([
            p,
            new Promise((_, rej) => setTimeout(() => rej(new Error("Timed out")), timeout)),
          ]);
          const results = await withTimeout(Promise.all(sends));
          const err = results.find(r => r.type === "error");
          if (err) {
            status.textContent = err.message || err.data?.message || "Transaction failed";
            status.className = "mkui-dialog-status mkui-dialog-status-error";
            submitBtn.disabled = false;
            cancelBtn.disabled = false;
            return;
          }
          storeRemembered();
          if (pinned) {
            status.textContent = "OK";
            status.className = "mkui-dialog-status";
            submitBtn.disabled = false;
            cancelBtn.disabled = false;
            resetForm();
          } else {
            resolved = true;
            ws.closeFrame(frameId);
            cleanup();
            resolve(data);
          }
          follow(data);
        } catch (e) {
          status.textContent = e.message || "Transaction failed";
          status.className = "mkui-dialog-status mkui-dialog-status-error";
          submitBtn.disabled = false;
          cancelBtn.disabled = false;
        }
      } else {
        storeRemembered();
        if (pinned) {
          resetForm();
        } else {
          resolved = true;
          ws.closeFrame(frameId);
          cleanup();
          resolve(data);
        }
        follow(data);
      }
    }

    function validate() {
      let ok = true;
      let unfolded = false;
      for (const f of allFields) {
        if (!f.name) continue;
        const el = fieldEls[f.name];
        if (!el) continue;
        if (!isShown(f)) continue;

        el.classList.remove("mkui-dialog-invalid");
        const existing = el.querySelector(".mkui-dialog-error");
        if (existing) existing.remove();

        const val = fieldState[f.name];
        const a = resolvedAttrs[f.name] ?? {};
        const message = () => f.invalidMessage != null ? resolveExpr(f.invalidMessage, formScope()) : null;
        let err = null;

        if (a.required && (val === "" || val == null || val === false)) {
          err = message() ?? "Required";
        } else if (a.pattern && val) {
          try {
            if (!new RegExp(a.pattern).test(String(val))) {
              err = message() ?? "Invalid format";
            }
          } catch (_) {}
        } else if (f.type === "number" && val !== "" && val != null) {
          const n = Number(val);
          if (a.min != null && a.min !== "" && n < Number(a.min)) err = message() ?? `Min: ${a.min}`;
          if (a.max != null && a.max !== "" && n > Number(a.max)) err = message() ?? `Max: ${a.max}`;
        }

        if (err) {
          ok = false;
          el.classList.add("mkui-dialog-invalid");
          const msg = document.createElement("div");
          msg.className = "mkui-dialog-error";
          msg.textContent = err;
          el.appendChild(msg);
          // An error behind a folded header must be seen to be fixed.
          const sec = sections.find((s) => s.item === sectionOf.get(f));
          if (sec && !sec.open) { setSectionOpen(sec, true); unfolded = true; }
        }
      }
      if (unfolded) fitFrame();
      return ok;
    }

    async function fetchOptionsFrom(selectEl, field, extra) {
      if (!field.optionsFrom || !selectEl) return;
      const client = extra.client;
      if (!client?.request) return;

      const params = resolveObject(field.optionsFrom.params ?? {}, { ...context, field: fieldState });
      const hasUnresolved = Object.values(params).some((v) => v === "");
      optionRows[keyOf(field)] = null;
      if (hasUnresolved) {
        selectEl.innerHTML = "";
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "—";
        selectEl.appendChild(opt);
        if (field.name) fieldState[field.name] = "";
        applyDynamic();
        return;
      }

      selectEl.disabled = true;
      selectEl._mkuiLoading = true;
      try {
        const resp = await client.request(field.optionsFrom.service, params);
        const rows = Array.isArray(resp) ? resp : resp?.rows ?? [];
        optionRows[keyOf(field)] = rows;
        selectEl.innerHTML = "";
        const emptyOpt = document.createElement("option");
        emptyOpt.value = "";
        emptyOpt.textContent = "—";
        selectEl.appendChild(emptyOpt);
        for (const r of rows) {
          const opt = document.createElement("option");
          opt.value = r[field.optionsFrom.value] ?? "";
          opt.textContent = r[field.optionsFrom.label] ?? opt.value;
          selectEl.appendChild(opt);
        }
        // Keep what the field was given before the list came (or held
        // before a re-fetch) when the list has it; else start blank.
        const keep = wanted[keyOf(field)] ?? (field.name ? fieldState[field.name] : "");
        delete wanted[keyOf(field)];
        const has = keep != null && keep !== "" && [...selectEl.options].some((o) => o.value === String(keep));
        selectEl.value = has ? String(keep) : "";
        if (field.name) fieldState[field.name] = selectEl.value;
      } catch (e) {
        console.error("[mkui-dialog] optionsFrom error:", e);
      } finally {
        selectEl._mkuiLoading = false;
        selectEl.disabled = resolvedAttrs[keyOf(field)]?.disabled ?? false;
      }
      if (pendingRecall.delete(field)) {
        const filled = recallField(field);
        if (filled.length || (field.name && fieldState[field.name] !== "")) {
          onFieldChange(field.name ?? null, filled);
          return;
        }
      }
      applyDynamic();
    }
  });
}

export function normalizeOptions(options) {
  if (!Array.isArray(options)) return [];
  return options.map((o) => {
    if (o == null || typeof o !== "object") return { value: String(o ?? ""), label: String(o ?? "") };
    return { value: o.value ?? "", label: o.label ?? o.value ?? "", showWhen: o.showWhen };
  });
}

function populateSelect(sel, field, extra) {
  if (field.optionsFromColumn && extra.tableRows) {
    const col = field.optionsFromColumn;
    const vals = new Set();
    for (const row of extra.tableRows.values()) {
      const v = row[col];
      if (v != null) vals.add(String(v));
    }
    const sorted = [...vals].sort();
    const emptyOpt = document.createElement("option");
    emptyOpt.value = "";
    emptyOpt.textContent = "—";
    sel.appendChild(emptyOpt);
    for (const v of sorted) {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = v;
      sel.appendChild(opt);
    }
    return;
  }

  if (field.optionsFrom) return;
  // Static / expression options are built by the dynamic pass (syncOptions).
}
