import { resolveExpr, resolveObject, evalExpr, expr } from "../lib/expressions.js";
import { icon } from "../lib/icons.js";
import { formatShortcut } from "../lib/shortcut.js";
import { isRich, richText, renderRich } from "../lib/rich.js";
import { statePaths } from "../lib/expressions.js";
import { suppressSpec, suppressedAnswer, storeSuppressed, readSuppressed } from "../lib/dialogs.js";
import { strptime, parseTime, inputToBound, boundToInput, inputTypeForKind, kindForFormat, detectTimeKind } from "../lib/timeparse.js";

let dialogSeq = 0;

// Dialogs open under a spec `id`: firing one again replaces the open one
// where it stands instead of stacking a second (a server pushing the same
// notice on every retry).
const openIds = new Map();

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

// A message box is a dialog that says something: `message` (a template, or
// a list of them, one paragraph each), a `heading` over it, `facts`
// (`[{ label, value }]`, a blank value dropping the line), `links`
// (`[{ label, href }]`), an `image` URL, and a `kind` picking the icon and
// its accent. Fields may follow; with none it is an alert, a confirm, an
// About box.
export const DIALOG_KINDS = {
  info: "info", success: "circle-check", warn: "triangle-alert",
  danger: "octagon-alert", question: "circle-help",
};
const BUTTON_KINDS = ["plain", "primary", "danger"];

export const hasMessage = (spec) =>
  spec?.message != null || spec?.heading != null || spec?.image != null || spec?.details != null
  || (Array.isArray(spec?.facts) && spec.facts.length > 0)
  || (Array.isArray(spec?.links) && spec.links.length > 0);

// The app-state paths a spec reads, anywhere in it: `${state.…}` in any
// string, `state.…` in the keys that hold a bare expression. The dialog
// re-runs its dynamic pass when one of them changes, so a box follows the
// app — the connection in an About box, a count in a confirm — while open.
const EXPR_KEYS = new Set(["showWhen", "enable", "compute", "required", "disabled", "readonly", "collapsed", "options"]);
export function specStatePaths(spec) {
  const out = new Set();
  const walk = (v, key) => {
    if (typeof v === "string") {
      const template = v.includes("${");
      if (!template && !EXPR_KEYS.has(key)) return;
      for (const p of statePaths(v, { template })) if (p) out.add(p);
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(spec, null);
  return out;
}

// `buttons = [{ id, label, kind, default, cancel, submit, op, copy, enable,
// arm, action, args, set }]` (`submit`: false, or `{ service, op, data }`) replaces the Cancel / OK pair; null without it, and the
// dialog is the form it always was. A bare string is its label, the id the
// label in lower case. One button at most cancels (the first to say so):
// Escape and × are that button. The default — what Enter presses and
// where the focus starts — is the one saying `default`, else the first
// that neither cancels nor is dangerous; in a `danger` dialog it is the
// cancel button unless one says otherwise, and never a `danger` button:
// Enter must not be how something is destroyed. With no kind given
// anywhere the default wears `primary`.
export function normalizeButtons(spec) {
  const list = spec?.buttons;
  if (!Array.isArray(list) || list.length === 0) return null;
  const out = [];
  let said = null;
  for (const [i, raw] of list.entries()) {
    const b = typeof raw === "string" ? { label: raw } : raw;
    if (!b || typeof b !== "object" || (b.id == null && b.label == null)) {
      console.warn(`[mkui-dialog] bad buttons[${i}]: expected { id, label }`);
      continue;
    }
    const id = String(b.id ?? String(b.label).toLowerCase());
    if (out.some((o) => o.id === id)) {
      console.warn(`[mkui-dialog] bad buttons[${i}]: duplicate id "${id}"`);
      continue;
    }
    out.push({
      ...b, id,
      label: b.label ?? id,
      kind: BUTTON_KINDS.includes(b.kind) ? b.kind : "plain",
      cancel: b.cancel === true && !out.some((o) => o.cancel),
      default: false,
    });
    if (b.default === true) said ??= out[out.length - 1];
  }
  if (out.length === 0) return null;
  const safe = (b) => b.kind !== "danger" && b.copy == null;
  if (said && !safe(said)) console.warn(`[mkui-dialog] buttons: "${said.id}" cannot be the default`);
  const def = (said && safe(said) ? said : null)
    ?? (spec.kind === "danger" ? out.find((b) => b.cancel) : out.find((b) => !b.cancel && safe(b)));
  if (def) {
    def.default = true;
    if (!def.cancel && out.every((b) => b.kind === "plain")) def.kind = "primary";
  }
  return out;
}

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
    // `buttons`, early: a suppressed box answers before anything is built.
    const btnSpecs = normalizeButtons(spec);
    const suppress = suppressSpec(spec, btnSpecs);
    if (suppress) {
      const id = suppressedAnswer(storage, suppress.key);
      const b = id == null ? null : btnSpecs.find((x) => x.id === id && suppress.remembers(x));
      if (b) {
        // A remembered cancel (a notice's only button) is a dismissal.
        resolve(b.cancel ? null : { button: b.id, data: {}, suppressed: true });
        effects(b, b.cancel ? null : {});
        return;
      }
    }
    const openId = spec.id == null ? null : String(spec.id);
    const place = openId == null ? null : openIds.get(openId)?.replace() ?? null;

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
          if (ev.ctrlKey || ev.metaKey) return; // mod+Enter submits from anywhere
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

    // `buttons` replace the footer pair (and the pin: a box that answers a
    // question has nothing to stay open for); a message box opens at its
    // content's height — a short guess `fitFrame` grows — rather than a
    // form's.
    const messaged = hasMessage(spec);
    const pinnable = !btnSpecs && spec.pin !== false;

    const widthPx = spec.width ?? 400;
    const heightPx = spec.height ?? (messaged ? 140 : 400);
    const wsRect = ws.getBoundingClientRect();
    const wFrac = Math.min(widthPx / wsRect.width, 0.9);
    const hFrac = Math.min(0.6, heightPx / wsRect.height);
    const xFrac = place?.x ?? Math.max(0, (1 - wFrac) / 2);
    const yFrac = place?.y ?? Math.max(0, (1 - hFrac) / 2);

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
      modal: spec.modal === true,
      layout: { type: "tabs", active: 0, children: [paneId] },
    });
    // Fired again under the same `id`, this one goes — quietly: no answer,
    // no cancel effects — and says where it stood.
    const me = {
      replace() {
        const f = ws._frames.find((x) => x.id === frameId);
        const at = f ? { x: f.x, y: f.y } : null;
        if (!resolved) {
          resolved = true;
          ws.closeFrame(frameId);
          cleanup();
          resolve(null);
        }
        return at;
      },
    };
    if (openId != null) openIds.set(openId, me);

    const frameEl = ws._frameEls.get(frameId);
    if (frameEl) {
      frameEl._extraControls = () => pinnable ? [makePinBtn()] : [];
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
    // The message block leads the body: the kind's icon (or `image`)
    // beside the heading, the paragraphs, the facts and the links. Its
    // text is templates over the form scope, rewritten by the dynamic pass
    // only where it changed; a rich value renders as one. It is selectable,
    // and copied whole by the pane's `copy`.
    const msg = { paras: [], shown: {} };
    const putText = (el, key, v) => {
      const text = isRich(v) ? richText(v) : (v == null ? "" : String(v));
      if (msg.shown[key] === text) return text;
      msg.shown[key] = text;
      el.textContent = "";
      if (isRich(v)) renderRich(el, v);
      else el.textContent = text;
      return text;
    };
    const paragraphs = () => spec.message == null ? [] : [].concat(spec.message);
    function currentFacts() {
      const out = [];
      for (const f of Array.isArray(spec.facts) ? spec.facts : []) {
        if (!f || typeof f !== "object" || !shown(f.showWhen)) continue;
        const value = resolveExpr(f.value ?? "", formScope());
        const text = isRich(value) ? richText(value) : (value == null ? "" : String(value));
        if (text.trim() === "") continue;
        out.push({ label: String(resolveExpr(f.label ?? "", formScope()) ?? ""), value, text: text.trim() });
      }
      return out;
    }
    function syncMessage() {
      if (!messaged) return;
      if (msg.heading) putText(msg.heading, "heading", resolveExpr(spec.heading, formScope()));
      paragraphs().forEach((p, i) => putText(msg.paras[i], `p${i}`, resolveExpr(p, formScope())));
      if (msg.details) {
        const t = putText(msg.details.text, "details", resolveExpr(detailsSpec.text ?? "", formScope()));
        msg.details.el.style.display = t.trim() === "" ? "none" : "";
      }
      if (!msg.facts) return;
      const facts = currentFacts();
      const key = JSON.stringify(facts.map((f) => [f.label, f.text]));
      if (key === msg.factsKey) return;
      msg.factsKey = key;
      msg.list = facts;
      msg.facts.innerHTML = "";
      msg.facts.style.display = facts.length ? "" : "none";
      for (const f of facts) {
        const dt = document.createElement("dt");
        dt.textContent = f.label;
        const dd = document.createElement("dd");
        if (isRich(f.value)) renderRich(dd, f.value);
        else dd.textContent = f.text;
        msg.facts.append(dt, dd);
      }
    }
    // `details = "<template>"` (or `{ text, label, open }`): the long part —
    // a stack trace, the rows a confirm is about — folded under the
    // message, with a copy button of its own.
    const detailsSpec = spec.details == null ? null
      : typeof spec.details === "object" ? spec.details : { text: spec.details };
    function dialogText() {
      const lines = [currentTitle];
      if (msg.heading) lines.push(msg.shown.heading ?? "");
      paragraphs().forEach((_, i) => lines.push(msg.shown[`p${i}`] ?? ""));
      for (const f of msg.list ?? []) lines.push(`${f.label}: ${f.text}`);
      for (const l of msg.links ?? []) lines.push(l.label === l.href ? l.href : `${l.label}: ${l.href}`);
      const said = lines.filter((l) => l !== "").join("\n");
      const details = (msg.shown.details ?? "").trim();
      return msg.details && details !== "" ? `${said}\n\n${details}` : said;
    }
    if (messaged) {
      const kindIcon = DIALOG_KINDS[spec.kind];
      const box = document.createElement("div");
      box.className = "mkui-dialog-message" + (kindIcon ? ` mkui-dialog-kind-${spec.kind}` : "");
      if (spec.image != null || kindIcon) {
        const mark = document.createElement("div");
        mark.className = "mkui-dialog-message-icon";
        if (spec.image != null) {
          const img = document.createElement("img");
          img.alt = "";
          // The picture arrives after the first fit.
          img.addEventListener("load", () => fitFrame());
          img.src = String(resolveExpr(spec.image, context) ?? "");
          mark.appendChild(img);
        } else {
          mark.appendChild(icon(kindIcon));
        }
        box.appendChild(mark);
      }
      const text = document.createElement("div");
      text.className = "mkui-dialog-message-text";
      text.id = `${paneId}-message`;
      if (spec.heading != null) {
        msg.heading = document.createElement("div");
        msg.heading.className = "mkui-dialog-heading";
        text.appendChild(msg.heading);
      }
      for (const _ of paragraphs()) {
        const p = document.createElement("p");
        p.className = "mkui-dialog-para";
        msg.paras.push(p);
        text.appendChild(p);
      }
      if (Array.isArray(spec.facts) && spec.facts.length) {
        msg.facts = document.createElement("dl");
        msg.facts.className = "mkui-dialog-facts";
        text.appendChild(msg.facts);
      }
      if (detailsSpec) {
        const el = document.createElement("div");
        el.className = "mkui-dialog-details";
        const head = document.createElement("div");
        head.className = "mkui-dialog-details-head";
        const toggle = document.createElement("button");
        toggle.className = "mkui-dialog-details-toggle";
        toggle.type = "button";
        const caret = document.createElement("span");
        caret.className = "mkui-dialog-caret";
        caret.appendChild(icon("chevron-right"));
        const label = document.createElement("span");
        label.textContent = String(resolveExpr(detailsSpec.label ?? "Details", context) ?? "");
        toggle.append(caret, label);
        const copyBtn = document.createElement("button");
        copyBtn.className = "mkui-dialog-details-copy";
        copyBtn.type = "button";
        copyBtn.title = "Copy details";
        copyBtn.appendChild(icon("copy"));
        copyBtn.addEventListener("click", () => writeClip(msg.shown.details ?? ""));
        head.append(toggle, copyBtn);
        const pre = document.createElement("pre");
        pre.className = "mkui-dialog-details-text";
        const setOpen = (open) => {
          el.classList.toggle("mkui-dialog-details-open", open);
          toggle.setAttribute("aria-expanded", String(open));
          if (open && built) fitFrame();
        };
        toggle.addEventListener("click", () => setOpen(!el.classList.contains("mkui-dialog-details-open")));
        setOpen(detailsSpec.open === true);
        el.append(head, pre);
        text.appendChild(el);
        msg.details = { el, text: pre };
      }
      // A link opens in a new tab, and only a web, mail or same-site
      // address is one: a spec may come from a server (`dialogService`, the
      // control channel), and `javascript:` is not a place to go.
      msg.links = [];
      for (const [i, l] of (Array.isArray(spec.links) ? spec.links : []).entries()) {
        const href = String(resolveExpr(l?.href ?? "", context) ?? "");
        if (!/^(https?:|mailto:|[/.#])/i.test(href)) {
          console.warn(`[mkui-dialog] bad links[${i}]: expected an http(s), mailto or relative href`);
          continue;
        }
        msg.links.push({ href, label: String(resolveExpr(l.label ?? href, context) ?? href) });
      }
      if (msg.links.length) {
        const row = document.createElement("div");
        row.className = "mkui-dialog-links";
        for (const l of msg.links) {
          const a = document.createElement("a");
          a.href = l.href;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          a.textContent = l.label;
          row.appendChild(a);
        }
        text.appendChild(row);
      }
      box.appendChild(text);
      body.appendChild(box);
    }

    renderItems(spec.fields ?? [], body);

    let suppressBox = null;
    if (suppress) {
      const label = document.createElement("label");
      label.className = "mkui-dialog-suppress";
      suppressBox = document.createElement("input");
      suppressBox.type = "checkbox";
      const span = document.createElement("span");
      span.textContent = suppress.label;
      label.append(suppressBox, span);
      body.appendChild(label);
    }

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

    // The footer's buttons: the Cancel / OK pair, or the spec's own.
    // `footerBtns` is what a send disables and the arrow keys walk;
    // `defaultBtn` is what Enter presses and where the focus starts when
    // the form has no input to take it.
    const footerBtns = [];
    const btnRecs = [];   // { spec, el, label, armUntil } per button
    let defaultBtn = null;
    let pressDefault = () => submit();
    if (btnSpecs) {
      for (const b of btnSpecs) {
        const el = document.createElement("button");
        el.className = "mkui-btn" + (b.kind === "plain" ? "" : ` mkui-btn-${b.kind}`);
        const label = String(resolveExpr(b.label, context) ?? "");
        el.textContent = label;
        if (b.default && !b.cancel) el.title = formatShortcut("mod+Enter");
        el.addEventListener("click", () => press(b));
        footerBtns.push(el);
        btnRecs.push({ spec: b, el, label, armUntil: Number(b.arm) > 0 ? Date.now() + Number(b.arm) * 1000 : 0 });
        if (b.default) defaultBtn = el;
      }
      const def = btnSpecs.find((b) => b.default);
      pressDefault = () => { if (def) press(def); };
    } else {
      const cancelBtn = document.createElement("button");
      cancelBtn.className = "mkui-btn";
      cancelBtn.textContent = spec.cancel?.label ?? "Cancel";
      cancelBtn.addEventListener("click", close);

      const submitBtn = document.createElement("button");
      submitBtn.className = "mkui-btn mkui-btn-primary";
      submitBtn.textContent = spec.submit?.label ?? "OK";
      submitBtn.title = formatShortcut("mod+Enter");
      submitBtn.addEventListener("click", () => submit());

      footerBtns.push(cancelBtn, submitBtn);
      for (const el of footerBtns) btnRecs.push({ spec: {}, el, label: el.textContent, armUntil: 0 });
      defaultBtn = submitBtn;
    }

    // A button is off while a send is out, while its `enable` (a boolean
    // or an expression over the form: type the name to delete it) says
    // so, and while it is arming: `arm = 2` keeps it shut for two seconds
    // after the box opens, counting down in its label, so a double-click
    // that opened the box cannot also answer it. `timeout = 10` on the
    // spec presses the default button (or dismisses) when it runs out,
    // counting down there; a key or a click in the box calls it off.
    let busy = false;
    let deadline = Number(spec.timeout) > 0 ? Date.now() + Number(spec.timeout) * 1000 : 0;
    const defaultRec = btnRecs.find((r) => r.el === defaultBtn) ?? null;
    const secsLeft = (t) => Math.max(0, Math.ceil((t - Date.now()) / 1000));
    function syncButtons() {
      for (const r of btnRecs) {
        const arming = r.armUntil ? secsLeft(r.armUntil) : 0;
        const counting = deadline && r === defaultRec ? secsLeft(deadline) : 0;
        r.el.disabled = busy || arming > 0 || (r.spec.enable != null && !truthy(r.spec.enable));
        const text = r.label + (arming > 0 ? ` (${arming})` : counting > 0 ? ` (${counting})` : "");
        if (r.el.textContent !== text) r.el.textContent = text;
      }
    }
    const setBusy = (b) => { busy = b; syncButtons(); };
    let ticker = null;
    function tick() {
      if (resolved) { stopTicker(); return; }
      for (const r of btnRecs) if (r.armUntil && Date.now() >= r.armUntil) r.armUntil = 0;
      const ran = deadline && Date.now() >= deadline;
      if (ran) deadline = 0;
      syncButtons();
      if (!deadline && !btnRecs.some((r) => r.armUntil)) stopTicker();
      if (ran) { if (defaultRec) pressDefault(); else close(); }
    }
    function stopTicker() { if (ticker != null) { clearInterval(ticker); ticker = null; } }
    function callOffTimeout() { if (deadline) { deadline = 0; syncButtons(); } }
    if (deadline || btnRecs.some((r) => r.armUntil)) ticker = setInterval(tick, 200);
    host.addEventListener("mousedown", callOffTimeout);

    footer.append(...footerBtns);
    container.appendChild(footer);

    host.appendChild(container);

    // What the dialog is, for a screen reader: a warning interrupts.
    paneEl.setAttribute?.("role", spec.kind === "warn" || spec.kind === "danger" ? "alertdialog" : "dialog");
    paneEl.setAttribute?.("aria-label", currentTitle);
    if (messaged) paneEl.setAttribute?.("aria-describedby", `${paneId}-message`);

    // The focus goes to the first input, else the default button, and back
    // to whatever held it once the dialog is gone.
    const opener = document.activeElement;
    const firstInput = host.querySelector("input:not([type=hidden]):not([type=checkbox]), select, textarea");
    (firstInput ?? defaultBtn ?? footerBtns[0])?.focus();

    // Escape cancels — unless pinned: the pin says stay open, whatever the
    // key, and × is still there. From a field the keydown lands here; with
    // nothing in the form focused (the title, the pin button, the body
    // clicked) it reaches the window, whose Escape the workspace routes to
    // the focused frame's pane through `_editActions.cancel` — the same
    // decision, so the dialog closes on Escape whenever its frame is the
    // focused one. A handled Escape is claimed (`preventDefault`) so the
    // window sees one owner; an ignored one keeps the browser default,
    // which still shuts an open select list.
    const cancel = () => {
      if (pinned || resolved) return false;
      close();
      return true;
    };
    // Copy, with no text selected, takes what a message box says — the
    // title, the message, the facts, the links — as plain text.
    const copy = () => {
      if (!messaged || resolved) return false;
      writeClip(dialogText());
      return true;
    };
    paneEl._editActions = messaged ? { cancel, copy } : { cancel };

    // Enter submits from a single-line field; ctrl/cmd+Enter from anywhere,
    // a textarea included (there plain Enter is a newline). On a button
    // Enter is the browser's own click — Enter on Cancel must cancel — and
    // the modified one is ours alone, so its default (that click) is stopped;
    // on a link it follows the link. With `buttons` both press the default
    // one. Left/right walk the footer's buttons, and Tab stays in the dialog.
    const onKey = (e) => {
      callOffTimeout();
      if (e.key === "Escape") { if (cancel()) e.preventDefault(); return; }
      if (e.key === "Tab") { trapTab(e); return; }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        const i = footerBtns.indexOf(e.target);
        if (i < 0) return;
        const n = footerBtns.length;
        footerBtns[(i + (e.key === "ArrowRight" ? 1 : n - 1)) % n].focus();
        e.preventDefault();
        return;
      }
      if (e.key !== "Enter") return;
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); pressDefault(); return; }
      const tag = e.target?.tagName;
      if (tag !== "TEXTAREA" && tag !== "BUTTON" && tag !== "A") pressDefault();
    };
    function trapTab(e) {
      const els = [...(host.querySelectorAll?.("input:not([type=hidden]), select, textarea, button, a[href], [tabindex]:not([tabindex='-1'])") ?? [])]
        .filter((el) => !el.disabled && el.offsetParent !== null);
      if (els.length === 0) return;
      const first = els[0], last = els[els.length - 1];
      const at = document.activeElement;
      if (e.shiftKey ? (at === first || !host.contains(at)) : (at === last || !host.contains(at))) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    }
    host.addEventListener("keydown", onKey);

    paneEl.addEventListener("mkui-pane-close", () => {
      if (!resolved) {
        resolved = true;
        host.removeEventListener("keydown", onKey);
        teardown();
        queueMicrotask(() => ws.unregisterPane(paneId));
        resolve(null);
        dismissed();
      }
    });

    built = true;
    onFieldChange(null, recallAll());
    // Follow the app state the spec reads (`subscribe` answers at once:
    // those first calls are not changes).
    const unsubs = [];
    if (typeof app?.state?.subscribe === "function") {
      let live = false;
      for (const path of specStatePaths(spec)) unsubs.push(app.state.subscribe(path, () => { if (live) applyDynamic(); }));
      live = true;
    }
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
        paneEl.setAttribute?.("aria-label", title);
      }
      syncMessage();
      syncNote();
      syncButtons();
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

    function teardown() {
      stopTicker();
      for (const off of unsubs.splice(0)) off?.();
      if (openId != null && openIds.get(openId) === me) openIds.delete(openId);
    }
    function cleanup() {
      teardown();
      host.removeEventListener("keydown", onKey);
      ws.unregisterPane(paneId);
      if (opener?.isConnected) opener.focus?.();
    }

    // Dismissed — Cancel, Escape, × — a dialog resolves null. With
    // `buttons` that is the cancel button however it came about, so what
    // that button sets or fires happens for all three.
    function close() {
      if (resolved) return;
      resolved = true;
      ws.closeFrame(frameId);
      cleanup();
      resolve(null);
      dismissed();
    }
    // "Don't ask again", ticked: keep the answer, and tell the app state
    // (`dialog.suppressed`) so a menu's "ask again" item comes alive.
    function rememberAnswer(b) {
      if (!suppress || !suppressBox?.checked || !suppress.remembers(b)) return;
      storeSuppressed(storage, suppress.key, b.id);
      app?.state?.set?.("dialog.suppressed", readSuppressed(storage));
    }
    function dismissed() {
      const b = btnSpecs?.find((x) => x.cancel);
      if (!b) return;
      rememberAnswer(b);
      effects(b, null);
    }

    // What a button does besides answering: `set = { "state.path": value }`
    // writes app state, `action` (+ `args`) fires an mkui action — both
    // resolved against the submitted fields over the opening context, as
    // `submit.then` is, and both after the dialog has closed.
    function effects(b, data) {
      const scope = { ...context, ...(data ?? {}), form: data ?? {}, button: b.id };
      try {
        if (b.set && typeof b.set === "object" && app?.state?.set) {
          for (const [path, v] of Object.entries(resolveObject(b.set, scope))) app.state.set(path, v);
        }
        if (b.action && typeof app?.fireAction === "function") {
          app.fireAction(b.action, resolveObject(b.args ?? null, scope));
        }
      } catch (e) {
        console.warn(`[mkui-dialog] button ${b.id} failed: ${e.message}`);
      }
    }

    function writeClip(text) {
      const done = (ok) => {
        status.textContent = ok ? "Copied" : "Copy failed";
        status.className = "mkui-dialog-status" + (ok ? "" : " mkui-dialog-status-error");
        lastNote = undefined;
      };
      try {
        Promise.resolve(navigator.clipboard.writeText(text)).then(() => done(true), () => done(false));
      } catch { done(false); }
    }

    // A button press. `copy` (true = what the dialog says, or a template)
    // fills the clipboard and stays; `cancel` dismisses; `submit = false`
    // answers with the form as it stands — a Discard has nothing to
    // validate or send; anything else is a submit under its id, its `op`
    // standing in for `submit.op`.
    function press(b) {
      if (resolved || btnRecs.find((r) => r.spec === b)?.el.disabled) return;
      if (b.copy != null && b.copy !== false) {
        writeClip(b.copy === true ? dialogText() : String(resolveExpr(b.copy, formScope()) ?? ""));
        return;
      }
      if (b.cancel) { close(); return; }
      if (b.submit === false) { finish(b, collectData()); return; }
      submit(b);
    }

    // The dialog is answered: closed, resolved — the data, or with
    // `buttons` `{ button, data }` — then `submit.then` and the button's
    // own effects.
    function finish(b, data) {
      if (b) rememberAnswer(b);
      resolved = true;
      ws.closeFrame(frameId);
      cleanup();
      resolve(btnSpecs ? { button: b.id, data } : data);
      if (b?.submit !== false) follow(data);
      if (b) effects(b, data);
    }

    // After a pinned submit: `pin = "reset"` (the default) restores every
    // field's default; `pin = "keep"` leaves the entered values — and their
    // dirty marks, so a compute doesn't take them back — for the next
    // submit, except fields that say `pin: "reset"` themselves (a save-as
    // name that must not re-save). Errors clear and "changed" re-baselines
    // either way.
    function resets(f) {
      return f.type !== "readonly" && f.type !== "hidden" && (f.pin ?? spec.pin) !== "keep";
    }
    function resetForm() {
      const reset = allFields.filter(resets);
      for (const f of allFields) {
        const el = fieldEls[keyOf(f)];
        if (el) {
          el.classList.remove("mkui-dialog-invalid");
          const err = el.querySelector(".mkui-dialog-error");
          if (err) err.remove();
        }
      }
      for (const f of reset) {
        dirty.delete(keyOf(f));
        setFieldValue(f, defaultValue(f));
      }
      const filled = [];
      for (const f of reset) filled.push(...recallField(f));
      onFieldChange(null, filled);
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

    async function submit(btn = null) {
      if (resolved) return;
      if (!validate()) return;
      const data = collectData();

      // A button's own `submit = { service, op, data }` is where its answer
      // goes — a question the server pushed, answered by a transaction —
      // in place of the spec's: the fields, plus `data` resolved against
      // them, `button` and the opening context. With nobody to send it to
      // the box stays open and says so; the spec's own submit keeps its
      // old leniency (no client: resolve at once).
      const client = extra.client;
      const own = btn?.submit && typeof btn.submit === "object" ? btn.submit : null;
      const svc = own ? own.service : spec.submit?.service;
      const op = own ? (own.op ?? btn.op) : (btn?.op ?? spec.submit?.op);
      const payload = own?.data == null ? data
        : { ...data, ...resolveObject(own.data, { ...context, ...data, form: data, button: btn.id }) };
      if (own && !(svc && client?.send)) {
        status.textContent = svc ? "Not connected" : "No service to send to";
        status.className = "mkui-dialog-status mkui-dialog-status-error";
        return;
      }
      if (svc && client?.send) {
        setBusy(true);
        status.textContent = "Sending...";
        status.className = "mkui-dialog-status";
        try {
          const sends = [];
          if (!own && spec.submitPerRow && context.rows?.length > 0) {
            for (const row of context.rows) {
              const rowCtx = { ...context, row };
              const perRowData = resolveObject(spec.rowData ?? {}, rowCtx);
              sends.push(client.send(svc, { ...data, ...perRowData }, { op }));
            }
          } else {
            sends.push(client.send(svc, payload, { op }));
          }
          const timeout = own?.timeout ?? spec.submit?.timeout ?? 5000;
          const withTimeout = (p) => Promise.race([
            p,
            new Promise((_, rej) => setTimeout(() => rej(new Error("Timed out")), timeout)),
          ]);
          const results = await withTimeout(Promise.all(sends));
          const err = results.find(r => r.type === "error");
          if (err) {
            status.textContent = err.message || err.data?.message || "Transaction failed";
            status.className = "mkui-dialog-status mkui-dialog-status-error";
            setBusy(false);
            return;
          }
          storeRemembered();
          if (pinned) {
            status.textContent = "OK";
            status.className = "mkui-dialog-status";
            setBusy(false);
            resetForm();
            follow(data);
          } else {
            finish(btn, data);
          }
        } catch (e) {
          status.textContent = e.message || "Transaction failed";
          status.className = "mkui-dialog-status mkui-dialog-status-error";
          setBusy(false);
        }
      } else {
        storeRemembered();
        if (pinned) {
          resetForm();
          follow(data);
        } else {
          finish(btn, data);
        }
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
