// Rich cell text for mkio-table `display` templates: a `rich` value type for
// the expression language plus the `mkui` function library that produces
// it, and the two renderers — DOM spans for cells, HTML for the clipboard.
//
// A Rich value is an ordered list of segments { text, style, icon?, bar? }.
// Style keys: color, background, bold, italic, underline, strike, class,
// muted, mono, badge (pill color), href. Concatenation (`+`, or adjacency in
// a ${...} template) joins segment lists, so `BOLD(symbol) + ' ' + MUTED(venue)`
// is one Rich value. `STR(rich)` and clipboard text are the flattened text;
// icons and bars flatten to nothing.
//
// Everything here goes through the public extension hooks — nothing in the
// engine knows about rich text.

import { expr } from "./expressions.js";
import { icon } from "./icons.js";

export class Rich {
  constructor(segments) { this.segments = segments; }
  get text() { return richText(this); }
}

export const isRich = (v) => v instanceof Rich;

export function richText(r) {
  let out = "";
  for (const s of r.segments) out += s.text ?? "";
  return out;
}

const seg = (text, style = {}) => ({ text: String(text), style });

/** Coerce anything to a Rich value (strings and scalars become one plain segment). */
export function toRich(v) {
  if (isRich(v)) return v;
  return new Rich(v == null || v === "" ? [] : [seg(expr.toString(v))]);
}

export function richAdd(a, b) {
  return new Rich([...toRich(a).segments, ...toRich(b).segments]);
}

/** Apply style keys to every segment of a value. */
function styled(v, patch) {
  return new Rich(toRich(v).segments.map((s) => ({ ...s, style: { ...s.style, ...patch } })));
}

const STYLE_KEYS = new Set(["color", "background", "bold", "italic", "underline", "strike", "class", "muted", "mono", "badge", "href"]);

// ── Colour helpers ─────────────────────────────────────────────────────

function parseHex(c) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(c ?? "").trim());
  if (!m) throw new expr.ExprError(`HEAT: colors must be #rrggbb, got '${c}'`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const hex2 = (n) => Math.round(n).toString(16).padStart(2, "0");

/** Linear blend of two #rrggbb colors at t ∈ [0, 1]. */
export function mixHex(from, to, t) {
  const a = parseHex(from), b = parseHex(to);
  t = Math.min(Math.max(t, 0), 1);
  return "#" + a.map((x, i) => hex2(x + (b[i] - x) * t)).join("");
}

/** Colour for `v` on a scale lo..hi between two colors; NULL → NULL. */
export function heat(v, lo, hi, from = "#1b2a3a", to = "#e05252") {
  if (v == null) return null;
  if (typeof v !== "number") throw new expr.ExprError("HEAT requires a number");
  const t = hi === lo ? 1 : (v - lo) / (hi - lo);
  return mixHex(from, to, t);
}

// ── Registration ───────────────────────────────────────────────────────

expr.registerType("rich", isRich, {
  add: richAdd,       // `+` with strings or other rich values
  concat: richAdd,    // adjacency in ${...} templates
  toString: richText,
  truthy: (r) => richText(r).length > 0,
});

const named = (fn, params, doc, extra = {}) => [fn, { params, doc, ...extra }];

expr.registerLibrary("mkui", {
  BOLD:      named((x) => styled(x, { bold: true }), ["x"], "Bold."),
  ITALIC:    named((x) => styled(x, { italic: true }), ["x"], "Italic."),
  UNDERLINE: named((x) => styled(x, { underline: true }), ["x"], "Underlined."),
  STRIKE:    named((x) => styled(x, { strike: true }), ["x"], "Struck through."),
  COLOR:     named((x, c) => styled(x, { color: String(c ?? "") }), ["x", "color"], "Text color (any CSS color)."),
  BG:        named((x, c) => styled(x, { background: String(c ?? "") }), ["x", "color"], "Background color behind the text."),
  MUTED:     named((x) => styled(x, { muted: true }), ["x"], "Muted foreground color."),
  MONO:      named((x) => styled(x, { mono: true }), ["x"], "Monospace font."),
  CLASS:     named((x, cls) => styled(x, { class: String(cls ?? "") }), ["x", "class"], "Add CSS class(es) to the segment."),
  STYLE:     named((x, map) => {
    const patch = {};
    for (const [k, v] of Object.entries(map ?? {})) if (STYLE_KEYS.has(k)) patch[k] = v;
    return styled(x, patch);
  }, ["x", "style"], "Apply a style map: {color, background, bold, italic, underline, strike, class, muted, mono, badge, href}."),
  ICON:      named((name) => new Rich([{ text: "", style: {}, icon: String(name ?? "") }]), ["name"], "An inline icon from the icon library."),
  BADGE:     named((x, c) => styled(x, { badge: String(c ?? "") }), ["x", "color"], "A pill with the given background color."),
  BAR:       named((frac, c = null) => new Rich([{ text: "", style: {}, bar: Math.min(Math.max(Number(frac ?? 0), 0), 1), color: c == null ? null : String(c) }]),
                   ["frac", "color"], "An inline meter filled to `frac` (0..1)."),
  LINK:      named((x, url) => styled(x, { href: String(url ?? "") }), ["x", "url"], "A hyperlink (opens in a new tab)."),
  HEAT:      named(heat, ["v", "lo", "hi", "from", "to"], "Color for `v` between `lo` and `hi`, blending `from` (default #1b2a3a) to `to` (default #e05252)."),
});

// ── Renderers ──────────────────────────────────────────────────────────

const NAMED_COLORS = { red: "#e05252", green: "#4caf50", blue: "#0e639c", gray: "#858585", grey: "#858585", orange: "#e08a2e", yellow: "#c9a227" };
const badgeColor = (c) => NAMED_COLORS[c] ?? c;

const warnedIcons = new Set();

/** Render a Rich value into `el` (replacing its content). */
export function renderRich(el, rich) {
  el.textContent = "";
  for (const s of rich.segments) {
    if (s.icon != null) {
      const span = document.createElement("span");
      span.className = "mkui-rich-icon";
      try { span.appendChild(icon(s.icon)); }
      catch (e) {
        if (!warnedIcons.has(s.icon)) { warnedIcons.add(s.icon); console.warn(`[mkui] ICON: ${e.message}`); }
      }
      el.appendChild(span);
      continue;
    }
    if (s.bar != null) {
      const span = document.createElement("span");
      span.className = "mkui-rich-bar";
      span.style.setProperty("--mkui-bar-frac", `${Math.round(s.bar * 1000) / 10}%`);
      if (s.color) span.style.setProperty("--mkui-bar-color", s.color);
      el.appendChild(span);
      continue;
    }
    const st = s.style ?? {};
    const span = document.createElement(st.href ? "a" : "span");
    span.textContent = s.text ?? "";
    if (st.href) { span.href = st.href; span.target = "_blank"; span.rel = "noopener"; span.className = "mkui-rich-link"; }
    if (st.color) span.style.color = st.color;
    if (st.background) span.style.background = st.background;
    if (st.bold) span.style.fontWeight = "bold";
    if (st.italic) span.style.fontStyle = "italic";
    const deco = [st.underline && "underline", st.strike && "line-through"].filter(Boolean).join(" ");
    if (deco) span.style.textDecoration = deco;
    if (st.muted) span.classList.add("mkui-muted");
    if (st.mono) span.classList.add("mkui-mono");
    if (st.badge) { span.classList.add("mkui-rich-badge"); span.style.setProperty("--mkui-badge-color", badgeColor(st.badge)); }
    if (st.class) span.classList.add(...String(st.class).split(/\s+/).filter(Boolean));
    el.appendChild(span);
  }
}

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** HTML for the clipboard: inline styles only, icons and bars dropped. */
export function richToHTML(rich) {
  let out = "";
  for (const s of rich.segments) {
    if (s.icon != null || s.bar != null) continue;
    const st = s.style ?? {};
    const css = [];
    if (st.color) css.push(`color:${st.color}`);
    if (st.background) css.push(`background:${st.background}`);
    if (st.badge) css.push(`background:${badgeColor(st.badge)}`, "color:#fff", "border-radius:8px", "padding:0 6px");
    if (st.bold) css.push("font-weight:bold");
    if (st.italic) css.push("font-style:italic");
    const deco = [st.underline && "underline", st.strike && "line-through"].filter(Boolean).join(" ");
    if (deco) css.push(`text-decoration:${deco}`);
    if (st.mono) css.push("font-family:monospace");
    const text = esc(s.text);
    const attrs = css.length ? ` style="${css.join(";")}"` : "";
    if (st.href) out += `<a href="${esc(st.href)}"${attrs}>${text}</a>`;
    else if (attrs) out += `<span${attrs}>${text}</span>`;
    else out += text;
  }
  return out;
}
