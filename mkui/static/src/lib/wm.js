// Window management under sloppy focus: which keys and clicks move,
// raise and lower a window, the z-order a lower makes, the Window menu's
// items for it, and the per-user preferences behind them. DOM-free
// (`tests/sloppy-focus.test.js`); the workspace does the moving.

// The first step, in pixels, of a keyboard move — the virtual cursor's
// or the window's — before a held key takes over (`Mover`).
export const NUDGE = 5;

// What `windowClick` may be: the modifier of the raise click (shift
// added lowers) and the move drag. Ctrl+Alt is for desktops that take Alt-click for their
// own window dragging (Xfce, KDE before Plasma 6); on Apple platforms,
// where ctrl-click is a right-click, it is always Option.
export const WINDOW_CLICKS = ["alt", "ctrl+alt"];

export function isApple(nav = typeof navigator !== "undefined" ? navigator : null) {
  return /Mac|iPhone|iPad|iPod/.test(nav?.platform || nav?.userAgent || "");
}

// Alt/Option keys: P front, N back; H/J/K/L or the arrows move the
// virtual cursor (`point`), with shift the focused window (`move`), with
// ctrl its bottom-right corner (`resize`; shift added: without snapping).
// Matched on `code`, the physical key: Option on a Mac turns H into "˙"
// and N into a dead key. `{ op: "front" | "back" }`,
// `{ op: "point" | "move" | "resize", code, dir: [x, y] }`, or null.
const DIRS = {
  KeyH: [-1, 0], ArrowLeft: [-1, 0],
  KeyJ: [0, 1], ArrowDown: [0, 1],
  KeyK: [0, -1], ArrowUp: [0, -1],
  KeyL: [1, 0], ArrowRight: [1, 0],
};
export function wmKey(e) {
  if (!e?.altKey || e.metaKey) return null;
  const code = e.code || (typeof e.key === "string" && e.key.startsWith("Arrow") ? e.key : "");
  if (e.ctrlKey) return DIRS[code] ? { op: "resize", code, dir: DIRS[code] } : null;
  if (!e.shiftKey && code === "KeyP") return { op: "front" };
  if (!e.shiftKey && code === "KeyN") return { op: "back" };
  const dir = DIRS[code];
  return dir ? { op: e.shiftKey ? "move" : "point", code, dir } : null;
}

// Whether a text field gives up a key it would otherwise take: Alt+
// H/J/K/L (shift or not) off Apple platforms, where they type nothing.
// Arrows stay the field's (a word jump), and on a Mac Option+letters
// type characters. A resize never: Ctrl+Alt is AltGr on Windows.
export function takesFromField(k, apple = false) {
  return !apple && (k?.op === "point" || k?.op === "move") && /^Key[HJKL]$/.test(k.code);
}

// How a held key moves: `step` px at once, then after `delay` ms a
// steady glide that speeds up from `from` to `to` px/s over `ramp` ms.
export const CURVES = {
  point: { step: NUDGE, delay: 250, from: 300, to: 1500, ramp: 1000 },
  move: { step: NUDGE, delay: 250, from: 150, to: 600, ramp: 1000 },
  resize: { step: NUDGE, delay: 250, from: 150, to: 600, ramp: 1000 },
};

// The held movement keys of one gesture, and how far they have gone.
// `press` answers the first step (null for a key already held: the OS's
// key repeat is not the clock); `tick(now)` the glide since the last
// tick, diagonals as fast as straight lines. A key missing its release —
// Alt let go first, the window losing focus — is `clear`ed by the caller.
export class Mover {
  constructor() {
    this.held = new Map();          // code -> [x, y]
    this.kind = null;               // "point" | "move" | "resize"
    this.since = 0;                 // when the gesture (or its kind) began
    this.last = 0;                  // the last tick
  }
  get active() { return this.held.size > 0; }

  press(kind, code, dir, now) {
    if (this.kind === kind && this.held.has(code)) return null;
    if (this.kind !== kind) this.held.clear();
    if (!this.active) { this.since = now; this.last = now; }
    this.held.set(code, dir);
    this.kind = kind;
    const step = CURVES[kind].step;
    return { dx: dir[0] * step, dy: dir[1] * step };
  }

  release(code) {
    this.held.delete(code);
    if (!this.active) this.kind = null;
  }

  // Shift pressed or let go mid-gesture: the same keys, the other thing
  // moving, its curve started over.
  rekind(kind, now) {
    if (!this.active || this.kind === kind) return;
    this.kind = kind;
    this.since = now;
    this.last = now;
  }

  clear() {
    this.held.clear();
    this.kind = null;
  }

  tick(now) {
    const none = { dx: 0, dy: 0 };
    if (!this.active) return none;
    const c = CURVES[this.kind];
    const gliding = now - this.since - c.delay;      // ms past the delay
    const dt = Math.min(now - this.last, Math.max(0, gliding));
    this.last = now;
    if (dt <= 0) return none;
    let x = 0, y = 0;
    for (const [dx, dy] of this.held.values()) { x += dx; y += dy; }
    const len = Math.hypot(x, y);
    if (!len) return none;                            // opposite keys cancel
    const speed = c.from + (c.to - c.from) * Math.min(1, gliding / c.ramp);
    const d = (speed * dt) / 1000;
    return { dx: (x / len) * d, dy: (y / len) * d };
  }
}

// Whether a pointer event is the real mouse at work, which hands the
// virtual cursor back: any press or wheel, and a move that reports
// movement or sits elsewhere on the screen than `at` (the last real
// position) — a browser sends moves when the page changes under a still
// pointer, and those must not end it.
export function realMove(e, at) {
  if (e?.type !== "pointermove") return true;
  if (e.movementX || e.movementY) return true;
  return !!at && (e.screenX !== at.screenX || e.screenY !== at.screenY);
}

// A primary press the window takes under `windowClick` — dragged it
// moves the frame, released in place it raises, or with shift lowers:
// `{ op: "raise" | "lower" }`, or null for the content's.
export function clickOp(e, windowClick = "alt", apple = false) {
  if (!e || e.button !== 0 || !e.altKey || e.metaKey) return null;
  const mod = apple ? "alt" : windowClick;
  if ((mod === "ctrl+alt") !== !!e.ctrlKey) return null;
  return { op: e.shiftKey ? "lower" : "raise" };
}

// A plain primary press — nothing held — the kind a still click on the
// title bar raises with.
export function plainPress(e) {
  return !!e && e.button === 0 && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
}

// Released where it was pressed: a click, not the end of a drag.
export function stillClick(down, up) {
  return !!down && !!up && down.x === up.x && down.y === up.y;
}

// The frame specs with `id` sent to the bottom of its band: a normal
// frame under the other normal ones, a stay-on-top frame under the other
// stay-on-top ones (still over every normal frame). A modal is never
// lowered; null when nothing would change.
export function lowerOrder(frames, id) {
  const idx = frames.findIndex((f) => f.id === id);
  if (idx < 0) return null;
  const spec = frames[idx];
  if (spec.modal) return null;
  const rest = frames.filter((_, i) => i !== idx);
  const at = spec.stayOnTop ? rest.findIndex((f) => f.stayOnTop) : 0;
  const out = [...rest.slice(0, at < 0 ? rest.length : at), spec, ...rest.slice(at < 0 ? rest.length : at)];
  return out.every((f, i) => f === frames[i]) ? null : out;
}

// The Window menu's own items, after its window list: *Sloppy Focus*
// (ticked when on) — offered while shift was held as the menu opened, or
// once it is on — and, with it on and shift held, the Ctrl+Alt-click
// switch, never on Apple platforms.
export function wmMenuItems({ shift = false, sloppy = false, windowClick = "alt", apple = false } = {}) {
  if (!shift && !sloppy) return [];
  const out = [{ sep: true }, { label: "Sloppy Focus", action: "focus.sloppy", checked: sloppy }];
  if (sloppy && shift && !apple) {
    const on = windowClick === "ctrl+alt";
    out.push({ label: "Raise with Ctrl+Alt-click", action: "focus.windowClick", args: on ? "alt" : "ctrl+alt", checked: on });
  }
  return out;
}

// Per-user preferences, `{ sloppyFocus?, windowClick? }`, in
// localStorage (or any getItem/setItem object): one key per signed-in
// user, the bare key without a login. Blocked or unreadable storage reads
// as nothing chosen; a write to it is dropped.
export const WM_PREFIX = "mkui.wm";
const prefsKey = (user) => (user ? `${WM_PREFIX}:${user}` : WM_PREFIX);

export function readWmPrefs(store, user = "") {
  let o = null;
  try { o = JSON.parse(store?.getItem(prefsKey(user)) ?? "null"); } catch { o = null; }
  const out = {};
  if (typeof o?.sloppyFocus === "boolean") out.sloppyFocus = o.sloppyFocus;
  if (WINDOW_CLICKS.includes(o?.windowClick)) out.windowClick = o.windowClick;
  return out;
}

export function writeWmPrefs(store, user = "", patch = {}) {
  try {
    store?.setItem(prefsKey(user), JSON.stringify({ ...readWmPrefs(store, user), ...patch }));
  } catch { /* blocked storage: the choice lasts this session */ }
}

// Wire sloppy focus into an app: `app.config.app.sloppyFocus` unless the
// user chose otherwise — a preference per user in this browser, re-read
// as a login (`auth`) says who that is — and the actions that choose,
// `focus.sloppy` (true / false, or nothing to toggle) and
// `focus.windowClick` ("alt" / "ctrl+alt"), which keep the choice; the
// workspace's own setters don't.
export function installWm(app, ws, store, { auth = false } = {}) {
  const st = app.state;
  const user = () => st.get("auth.user") ?? "";
  const load = () => {
    const p = readWmPrefs(store, user());
    ws.setSloppyFocus(p.sloppyFocus ?? app.config?.app?.sloppyFocus === true);
    ws.setWindowClick(p.windowClick ?? "alt");
    // The setters mirror into state only once the workspace has its app,
    // which app.js hands it after this runs: a saved choice was in effect
    // while `focus.sloppy` said nothing.
    st.set("focus.sloppy", ws.sloppyFocus());
    st.set("focus.windowClick", ws.windowClick());
  };
  load();
  if (auth) st.subscribe("auth.user", load);
  app.registerAction("focus.sloppy", (_app, on) => {
    const next = typeof on === "boolean" ? on : !ws.sloppyFocus();
    ws.setSloppyFocus(next);
    writeWmPrefs(store, user(), { sloppyFocus: next });
  });
  app.registerAction("focus.windowClick", (_app, mod) => {
    ws.setWindowClick(mod);
    writeWmPrefs(store, user(), { windowClick: ws.windowClick() });
  });
}
