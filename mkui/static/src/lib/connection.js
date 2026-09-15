// The connection as the shell paints it: the phase the root `mkio`
// attribute carries, the outage clock behind `mkio.downSince` /
// `mkio.downFor`, and the `config.mkio.offline` options. DOM-free
// (`tests/connection.test.js`); `<mkui-app>` does the painting.

export const PHASES = ["connecting", "connected", "disconnected", "incompatible"];

// `connected` and `reason` are the state paths of those names; `ever`
// whether the socket has opened once in this page's life. Before that
// the app is connecting rather than cut off — a server that is down at
// startup reads the same on the wire, but the page holds nothing stale,
// so the loud treatment waits for a connection to lose.
export function phaseOf({ connected, reason, ever }) {
  if (!connected) return ever ? "disconnected" : "connecting";
  return reason ? "incompatible" : "connected";
}

// How long an outage has run, as a clock: `m:ss`, `h:mm:ss` past an hour.
export function formatDownFor(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// What the shell does about an outage, `config.mkio.offline`: the
// statusbar's dot and counter, the tab title and favicon, the banner
// (shown `delay` seconds into an outage; at once for an incompatible
// server), and the stale marking on the workspace and the panes. `false`
// turns the lot off; a map overrides per key.
export const OFFLINE_DEFAULTS = Object.freeze({
  indicator: true, title: true, favicon: true, banner: true, delay: 3, stale: true,
});

export function offlineOptions(spec) {
  const out = { ...OFFLINE_DEFAULTS };
  if (spec === false) {
    for (const k of Object.keys(out)) out[k] = k === "delay" ? 0 : false;
    return out;
  }
  if (!spec || typeof spec !== "object") return out;
  for (const k of Object.keys(OFFLINE_DEFAULTS)) {
    if (spec[k] === undefined) continue;
    if (k === "delay") {
      const n = Number(spec[k]);
      if (Number.isFinite(n) && n >= 0) out[k] = n;
    } else {
      out[k] = !!spec[k];
    }
  }
  return out;
}

// The outage clock. mkio's client calls the disconnect callback on every
// failed reconnect attempt — about once a second while the server is
// away — so `down()` is true once per outage, the first time, and the
// clock keeps its start through the repeats; `up()` is true once per
// recovery.
export class Outage {
  constructor() { this.since = null; }
  get active() { return this.since != null; }
  down(now = Date.now()) {
    if (this.since != null) return false;
    this.since = now;
    return true;
  }
  up() {
    if (this.since == null) return false;
    this.since = null;
    return true;
  }
  downFor(now = Date.now()) {
    return this.since == null ? null : formatDownFor(now - this.since);
  }
}

// The favicon shown while the connection is down: a red dot. Inline, so a
// page with no icon of its own gets one too.
export const OFFLINE_FAVICON = "data:image/svg+xml," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="#d32f2f"/></svg>');

// The icon href to put back on reconnect: the page's own when it had an
// icon link, else the browser's default location, which is what it was
// showing before. Removing a link the page never had would not do: a tab
// keeps the last icon it loaded until an href changes.
export function restoreIconHref(savedHref, base) {
  if (savedHref != null) return savedHref;
  return base ? new URL("/favicon.ico", base).href : "/favicon.ico";
}

// The tab title while down: the warning glyph, the word, the app's own.
export function offlineTitle(base) {
  return base ? `⚠ Disconnected · ${base}` : "⚠ Disconnected";
}
