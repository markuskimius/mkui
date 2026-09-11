// "Where does this window get its record?" — the form behind a detail
// window's subject button.
//
// Everything it sets can also be written in config or pushed from Python;
// this is the same configuration reached with a mouse, so a user who was
// handed a window listening for the wrong name can fix it without anyone
// editing a file. It applies through the same `setSpec` the chip and the
// pin use, so a saved layout carries the result.

import { openDialog } from "../widgets/mkui-dialog.js";
import { recordSpecToConfig } from "./subject.js";

const MODE_OPTIONS = [
  { value: "listen", label: "Listen for a broadcast name" },
  { value: "follow", label: "Follow another pane's selection" },
  { value: "state", label: "Read a row from app state" },
  { value: "key", label: "Stay on one record" },
  { value: "none", label: "Nothing — leave it where it is" },
];

// The form's fields, and the hint under them. Pure, so what the form
// offers for a given configuration is testable without a workspace.
// `broadcast`: the names live on the hub now; `panes`: `[{ id, title }]`,
// what "follow" may name.
export function recordConfigForm(spec, { broadcast = [], panes = [] } = {}) {
  const cfg = recordSpecToConfig(spec);
  const names = Object.keys(spec.listen);
  const firstName = names[0] ?? "";
  const firstCol = firstName ? spec.listen[firstName].column : "";

  // The dialog's one note is its footer's, and it takes a template — so
  // the hint follows the mode the form is on. The expression language has
  // no ternary: `IF(cond, a, b)` is the form.
  let hint = broadcast.length
    ? `Being broadcast now: ${broadcast.join(", ")}`
    : "Nothing is being broadcast yet — a table's advanced header dropdown (alt-click its filter button) adds a name.";
  if (names.length > 1) hint += ` This window listens for ${names.length} names; applying here replaces them with one.`;

  return {
    title: "Record source",
    width: 420,
    fields: [
      { name: "mode", label: "Source", type: "select", options: MODE_OPTIONS, value: spec.mode ?? "none" },
      { name: "lname", label: "Name", showWhen: "mode == 'listen'", value: firstName },
      { name: "lcolumn", label: "Key column", showWhen: "mode == 'listen'", value: firstCol },
      { name: "pane", label: "Pane", type: "select", showWhen: "mode == 'follow'", value: spec.follow ?? "",
        options: panes.map((p) => ({ value: p.id, label: p.title ?? p.id })) },
      { name: "path", label: "State path", showWhen: "mode == 'state'", value: spec.state ?? "" },
      { name: "retain", label: "Keep the last record when the source clears",
        type: "checkbox", value: cfg.retain, showWhen: "mode != 'key' && mode != 'none'" },
      { name: "listening", label: "Follow changes (unpinned)",
        type: "checkbox", value: cfg.listening, showWhen: "mode != 'key' && mode != 'none'" },
    ],
    footer: { note: `\${IF(mode == 'listen', ${lit(hint)}, '')}` },
    submit: { label: "Apply" },
  };
}

// An expression-language string literal.
const lit = (t) => `'${String(t).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

// The form's answers as a `record` block. The form says where the records
// come from; everything else the block carries — what the tab is called —
// is not its business to drop. `current` is the record on show, which is
// what "stay on one record" means.
export function recordSpecFromForm(res, spec, current = null) {
  const next = { retain: !!res.retain, listening: res.listening !== false };
  if (spec.title) next.title = spec.title;
  if (res.mode === "listen" && res.lname && res.lcolumn) next.listen = { [res.lname]: res.lcolumn };
  else if (res.mode === "follow" && res.pane) next.follow = res.pane;
  else if (res.mode === "state" && res.path) next.state = res.path;
  else if (res.mode === "key") {
    // Staying on one record means the one on show, which is what the pin
    // does — but written down, so a saved layout comes back on it.
    const key = current?.key ?? spec.key;
    if (key) next.key = { ...key };
    next.listening = true;
  }
  return next;
}

// Open the form and apply what it says. Resolves with the new
// configuration, or null when the user cancelled.
export async function openRecordConfig(follower, app, opts = {}) {
  const res = await openDialog(recordConfigForm(follower.spec, {
    broadcast: app?.links?.names?.() ?? [],
    panes: opts.panes ?? [],
  }), {}, app);
  if (!res) return null;
  const next = recordSpecFromForm(res, follower.spec, follower.record);
  follower.setSpec(next);
  return next;
}
