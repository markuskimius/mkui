// Message boxes as specs: what `dialog.alert`, `dialog.confirm` and
// `dialog.about` — and `App.alert` / `App.confirm` behind them — hand to
// `openDialog`, and the `confirm` key that gates an action behind one.
// DOM-free (`tests/popup.test.js`); the dialog itself is
// widgets/mkui-dialog.js.

const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);

// `args` of the message actions: a bare string (or a list of paragraphs)
// is the message.
export function messageArgs(args) {
  if (typeof args === "string" || Array.isArray(args)) return { message: args };
  return isObj(args) ? args : {};
}

// The keys a message box passes through to the dialog untouched.
const PASSED = ["title", "kind", "heading", "image", "facts", "links", "details", "width", "height", "fields",
  "id", "modal", "suppress", "timeout"];
function passed(o, base) {
  const spec = { ...base };
  for (const k of PASSED) if (o[k] != null) spec[k] = o[k];
  return spec;
}

// One button, and every way out is that button.
export function alertSpec(args) {
  const o = messageArgs(args);
  return passed(o, {
    title: "Message",
    kind: "info",
    message: o.message ?? "",
    buttons: [{ id: "ok", label: o.ok ?? "OK", kind: "primary", cancel: true, default: true }],
  });
}

// OK / Cancel. `then = { action, args }` rides the OK button, so a confirm
// fired from config does something with its answer. In a `danger` confirm
// the OK button is a danger button, and the default is Cancel. A confirm
// is modal unless it says otherwise; `submit = { service, op, data }` (the
// transaction OK sends: how a question a server pushed gets its answer), `arm` (seconds the OK button waits
// before it can be pressed) and `enable` (an expression over the confirm's
// fields: type the name to delete it) ride the OK button too.
export function confirmSpec(args) {
  const o = messageArgs(args);
  const kind = o.kind ?? "question";
  const ok = { id: "ok", label: o.ok ?? "OK", kind: kind === "danger" ? "danger" : "primary" };
  if (isObj(o.then) && o.then.action) { ok.action = o.then.action; ok.args = o.then.args ?? null; }
  if (isObj(o.submit)) ok.submit = o.submit;
  if (o.arm != null) ok.arm = o.arm;
  if (o.enable != null) ok.enable = o.enable;
  return passed({ ...o, kind }, {
    title: "Confirm",
    modal: true,
    message: o.message ?? "",
    buttons: [{ id: "cancel", label: o.cancel ?? "Cancel", cancel: true }, ok],
  });
}

// `confirm = "Discard this arrangement?"` (or a confirm's args) on a
// menubar item: the spec to ask before its action fires; null without one.
export function confirmOf(item) {
  const c = item?.confirm;
  if (c == null || c === false || c === "") return null;
  if (typeof c !== "string" && !Array.isArray(c) && !isObj(c)) {
    console.warn("[mkui] bad confirm: expected a message or { message, … }");
    return null;
  }
  // "Reset to Default…" asks under the title "Reset to Default".
  const title = typeof item.label === "string" ? item.label.replace(/\s*(…|\.\.\.)$/, "") : item.label;
  return confirmSpec({ title, ...messageArgs(c), then: null });
}

// Whether `item` asks at all. Callers check this before awaiting
// `confirmed`, so an item that does not ask still acts in the same task.
export const asks = (item) => item?.confirm != null && item.confirm !== false && item.confirm !== "";

// Ask what `item.confirm` says, if it says anything: true when the action
// may go ahead. `item` is a menu item, a table button, a button widget;
// `context` is what the confirm's templates see beside `state` and `app`.
export async function confirmed(app, item, context = {}) {
  const ask = confirmOf(item);
  if (!ask) return true;
  if (typeof app?.dialog !== "function") return false;
  const res = await app.dialog(ask, context);
  return res?.button === "ok";
}

// `suppress = "key"` (or `{ key, label }`) gives a box with `buttons` a
// "Don't ask again" checkbox: ticked, the answer is kept in storage under
// `mkui.suppress.<key>` and given at once the next time, nothing opening.
// A cancel is never remembered — except by a box whose only button it is,
// a notice that need not be shown twice.
export const SUPPRESS_PREFIX = "mkui.suppress.";
export function suppressSpec(spec, buttons) {
  const raw = spec?.suppress;
  const key = typeof raw === "string" ? raw : isObj(raw) ? raw.key : null;
  if (!buttons || typeof key !== "string" || key === "") return null;
  const lone = buttons.length === 1;
  return {
    key,
    label: (isObj(raw) && raw.label) || (lone ? "Don't show this again" : "Don't ask again"),
    remembers: (b) => b.copy == null && (!b.cancel || lone),
  };
}
export function suppressedAnswer(storage, key) {
  try { return storage?.getItem(SUPPRESS_PREFIX + key) ?? null; } catch { return null; }
}
export function storeSuppressed(storage, key, buttonId) {
  try { storage?.setItem(SUPPRESS_PREFIX + key, buttonId); } catch { /* full or blocked */ }
}
// Every remembered answer, `{ key: buttonId }`: what the app mirrors into
// state at `dialog.suppressed`, so a menu item can grey out its "ask
// again" while there is nothing to take back.
export function readSuppressed(storage) {
  const out = {};
  try {
    for (let i = 0; i < (storage?.length ?? 0); i++) {
      const k = storage.key(i);
      if (k?.startsWith(SUPPRESS_PREFIX)) out[k.slice(SUPPRESS_PREFIX.length)] = storage.getItem(k);
    }
  } catch { /* blocked storage: nothing is remembered */ }
  return out;
}

// Forget one remembered answer, or with no key all of them; how many went.
export function resetSuppressed(storage, key = null) {
  let n = 0;
  try {
    const keys = [];
    for (let i = 0; i < (storage?.length ?? 0); i++) keys.push(storage.key(i));
    for (const k of keys) {
      if (!k?.startsWith(SUPPRESS_PREFIX)) continue;
      if (key != null && k !== SUPPRESS_PREFIX + key) continue;
      storage.removeItem(k);
      n++;
    }
  } catch { /* blocked storage: nothing was remembered */ }
  return n;
}

// What `dialog.resetSuppressed` tells the statusbar, given how many went.
export const resetMessage = (n) => n === 0
  ? "Nothing to reset: no \"Don't ask again\" box has been ticked"
  : `Will ask again (${n} remembered answer${n === 1 ? "" : "s"} forgotten)`;

// The About box, from what the config already says (`app.title`,
// `version`, `description`, `copyright`, `icon`, `links`) and what the app
// knows: the server it reached, who is logged in, mkui's own version —
// the lines a bug report wants, which "Copy details" takes. `app.about`
// overrides any part (`title`, `heading`, `message`, `image`, `links`,
// `width`), `facts` adding lines of its own ahead of the built-in ones
// (`builtins = false` drops those; a list of their names picks and orders
// them).
export function aboutSpec(config, { version } = {}) {
  const a = isObj(config?.app) ? config.app : {};
  const about = isObj(a.about) ? a.about : {};
  const name = a.title ?? "mkui";
  const join = (...xs) => xs.filter((x) => x != null && x !== "").join(" ");

  // Templates over `state`, so the box follows the connection while open.
  // What is happening first — the server, the connection, who is logged
  // in — then the two libraries' versions, side by side.
  const lines = {
    server: { label: "Server", value: "${state.mkio.server.name} ${state.mkio.server.version}" },
    connection: { label: "Connection", value: !config?.mkio?.url ? ""
      : "${IF(state.mkio.connected, IF(state.mkio.reason, 'Incompatible (' + state.mkio.reason + ')', 'Connected'), 'Disconnected')}" },
    user: { label: "User", value: "${IF(state.auth.authenticated, state.auth.user + IF(state.auth.role, ' (' + state.auth.role + ')', ''), '')}" },
    mkui: { label: "mkui", value: version ?? "" },
    mkio: { label: "mkio", value: "${state.mkio.server.mkio}" },
  };
  // `builtins`: false for none, or a list of the names above — the lines
  // an app wants, in the order it wants them.
  const names = about.builtins === false ? []
    : Array.isArray(about.builtins) ? about.builtins : Object.keys(lines);
  for (const n of names) if (!Object.hasOwn(lines, n)) console.warn(`[mkui] app.about.builtins: unknown line "${n}"`);
  const builtins = names.filter((n) => Object.hasOwn(lines, n)).map((n) => lines[n]);
  const image = about.image ?? a.icon ?? null;
  const spec = {
    title: about.title ?? `About ${name}`,
    width: about.width ?? 420,
    heading: about.heading ?? join(name, a.version),
    message: about.message ?? [a.description, a.copyright].filter((x) => x != null && x !== ""),
    facts: [...(Array.isArray(about.facts) ? about.facts : []), ...builtins],
    links: about.links ?? a.links ?? [],
    buttons: [
      { id: "copy", label: "Copy details", copy: true },
      { id: "ok", label: "OK", kind: "primary", cancel: true, default: true },
    ],
  };
  if (image != null) spec.image = image;
  else spec.kind = "info";
  return spec;
}

// True when the spec talks to a service — a submit, or a select's
// `optionsFrom` — and so needs the mkio client to open.
export function needsClient(spec) {
  if (spec?.submit?.service) return true;
  if ((Array.isArray(spec?.buttons) ? spec.buttons : []).some((b) => b?.submit?.service)) return true;
  const walk = (items) => (Array.isArray(items) ? items : []).some((i) =>
    i?.optionsFrom || walk(i?.row) || walk(i?.fields));
  return walk(spec?.fields);
}
