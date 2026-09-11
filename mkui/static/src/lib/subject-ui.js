// The subject strip: a detail window's one persistent control.
//
//   [📌] [👂 Listen: order_id ×] [🔗]
//
// The pin freezes the window on the record it holds; the chip says where
// its records come from and pauses or removes that; the last button opens
// the form that reconfigures it (lib/record-config.js). Every one of them
// goes through `follower.setSpec`, so config, the actions, the control
// channel and a saved layout all agree with what the mouse does.
//
// Shared by `mkio-history` and `mkio-record` — they show very different
// things about a record, but "which record, and where from" is one
// question, and it should look and behave the same in both.

import { icon } from "./icons.js";
import { makeChip } from "./chips.js";
import { describeRecord } from "./subject.js";
import { openRecordConfig } from "./record-config.js";
import { compileTemplate, expr } from "./expressions.js";

const el = (cls, tag = "div") => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
};

// `follower` is a *function*: the strip is built before the follower
// exists (its first read can land synchronously, so it is started last).
// `rowFor(record)` says which row names the tab — a detail window knows
// more about the record than the subject does.
export function makeSubjectControls({ app, paneEl, ws, follower, rowFor = null, warn = null } = {}) {
  const f = () => follower();
  const say = warn ?? ((m) => console.warn(`[mkui] record: ${m}`));
  const strip = el("mkui-record-subject");

  const pinBtn = el("mkui-btn mkui-toolbar-btn mkui-record-pin", "button");
  pinBtn.appendChild(icon("pin"));
  pinBtn.addEventListener("mousedown", (ev) => {
    if (ev.button !== 0) return;
    f().setSpec({ listening: !f().listening }, { merge: true });
  });

  const cfgBtn = el("mkui-btn mkui-toolbar-btn mkui-record-config", "button");
  cfgBtn.appendChild(icon("link"));
  cfgBtn.title = "Where this window gets its record…";
  cfgBtn.addEventListener("mousedown", (ev) => {
    if (ev.button !== 0) return;
    const id = paneEl?.dataset?.id ?? null;
    const panes = (ws?.()?.openPanes?.() ?? []).filter((p) => p.id !== id);
    openRecordConfig(f(), app, { panes });
  });

  // The tab is where the record's name lives: "History — 4711", from the
  // `record.title` template when there is one, else the key values.
  let titleSrc = null, titleTmpl = null, warned = false;
  function recordText(record) {
    if (!record) return "";
    const src = f().spec.title;
    if (src !== titleSrc) {
      titleSrc = src;
      titleTmpl = null;
      if (src) {
        try { titleTmpl = compileTemplate(String(src)); }
        catch (e) { say(`bad record.title: ${e.message}`); }
      }
    }
    const row = (rowFor ? rowFor(record) : null) ?? record.row ?? record.key ?? {};
    if (titleTmpl) {
      try {
        const fields = new expr.Scope(row, null, false);
        const scope = new expr.Scope(
          { row, key: record.key ?? null, state: app.state.get() }, fields, false);
        const v = titleTmpl.evaluate(scope);
        return v == null ? "" : expr.toString(v);
      } catch (e) {
        if (!warned) { warned = true; say(`expression error in record.title: ${e.message}`); }
      }
    }
    const key = record.key;
    if (!key) return "";
    return Object.values(key).map((v) => (v == null ? "" : String(v))).filter(Boolean).join(" · ");
  }

  // What an empty window is waiting for. "Select a row" is no help to a
  // window nobody selects into.
  function waitingText() {
    const spec = f().spec;
    const names = Object.keys(spec.listen);
    if (spec.mode === "listen" && names.length) return `Waiting for ${names.join(", ")}.`;
    if (spec.mode === "follow") return `Select a row in '${spec.follow}'.`;
    if (spec.mode === "state") return "Nothing has been published for this window yet.";
    return "No record: this window has nothing to follow.";
  }

  // Redraw from the record on show and the configuration behind it, and
  // put the record's name on the tab.
  function sync(record) {
    const spec = f().spec;
    const id = paneEl?.dataset?.id ?? null;
    if (id != null) ws?.()?.setPaneAutoTitle?.(id, recordText(record));
    const on = spec.listening;
    const fixed = spec.mode === "key" || spec.mode == null;
    pinBtn.classList.toggle("active", !on);
    pinBtn.disabled = fixed;
    pinBtn.title = fixed
      ? "This window is set to one record"
      : on ? "Pin this window to the record it is showing"
           : "Pinned — click to follow again";
    strip.textContent = "";
    strip.appendChild(pinBtn);
    const d = describeRecord(spec, record);
    if (d) {
      const { chip } = makeChip(`mkui-chip-record mkui-chip-${d.mode}`, "", d.text, d.title,
        () => f().setSpec({ listening: !d.on }, { merge: true }),
        () => f().setSpec(null), null, icon(d.mode === "listen" ? "ear" : "link"));
      chip.classList.toggle("mkui-chip-off", !d.on);
      strip.appendChild(chip);
    }
    strip.appendChild(cfgBtn);
  }

  return { el: strip, sync, waitingText, recordText };
}
