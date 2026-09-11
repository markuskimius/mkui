// Conditional styling — the `styles` / `rowStyle` vocabulary, and the
// applying of what it yields to an element.
//
// A **styler** is one of three shapes, all meaning "given a scope, hand
// back a style map or nothing":
//
//   [{ when = "qty > 100", color = "red" }, { color = "gray" }]   rules
//   { bold = true }                                              one map
//   "state.alarm ? { color: 'red' } : NULL"                       expression
//
// Rules are first-match-wins and a rule without `when` is the fallback.
// Style keys are STYLE_KEYS; any string value may be a `${...}` template
// evaluated against the same scope, and `css` takes a map of raw CSS
// properties. A rule whose condition errors warns once and never matches.
//
// Backgrounds never go inline: `applyStyle` writes them to a custom
// property and adds a marker class, so the stylesheet decides how a
// styled background and a selection tint combine (tests/styles.test.js).
//
// Lifted out of `mkio-table` when the detail pane needed the same
// vocabulary — a `styles` block reads the same wherever it is written.

import { compileExpr, compileTemplate, expr } from "./expressions.js";

export const STYLE_KEYS = ["color", "background", "bold", "italic", "underline", "strike", "caps", "class", "css"];

const defaultWarn = (m) => console.warn(`[mkui] ${m}`);

// One compiled thing, run against a scope: an error warns once per label
// and reads as nothing, so a bad rule cannot break a render loop.
export function makeRunner(warn = defaultWarn, warned = new Set()) {
  return (c, scope, label) => {
    try { return c.evaluate(scope); }
    catch (e) {
      if (!warned.has(label)) {
        warned.add(label);
        warn(`expression error in ${label}: ${e.message}`);
      }
      return null;
    }
  };
}

function compileRules(rules, label, warn, run) {
  const compiled = rules.map((rule, i) => {
    let test = null;
    if (rule.when != null) {
      try { test = compileExpr(String(rule.when)); }
      catch (e) {
        warn(`bad style rule in ${label}: ${e.message}`);
        test = { evaluate: () => false };
      }
    }
    const style = {};
    const dynamic = [];
    const dynamicCss = []; // [prop, CompiledTemplate] inside `css`
    const tmpl = (v) => {
      try { return compileTemplate(v); }
      catch (e) { warn(`bad style template in ${label}: ${e.message}`); return null; }
    };
    for (const k of STYLE_KEYS) {
      if (!(k in rule)) continue;
      const v = rule[k];
      if (typeof v === "string" && v.includes("${")) {
        const t = tmpl(v);
        if (t) dynamic.push([k, t]);
      } else if (k === "css" && v && typeof v === "object") {
        const css = {};
        for (const [prop, pv] of Object.entries(v)) {
          if (typeof pv === "string" && pv.includes("${")) { const t = tmpl(pv); if (t) dynamicCss.push([prop, t]); }
          else css[prop] = pv;
        }
        style.css = css;
      } else style[k] = v;
    }
    return { test, style, dynamic, dynamicCss, label: `${label}[${i}]` };
  });
  return (scope) => {
    for (const r of compiled) {
      if (r.test && !expr.truthy(run(r.test, scope, r.label))) continue;
      if (!r.dynamic.length && !r.dynamicCss.length) return r.style;
      const out = { ...r.style };
      for (const [k, t] of r.dynamic) {
        const v = run(t, scope, r.label);
        if (v == null || v === "") continue;
        out[k] = typeof v === "object" ? v : String(v);
      }
      if (r.dynamicCss.length) {
        out.css = { ...(out.css ?? {}) };
        for (const [prop, t] of r.dynamicCss) {
          const v = run(t, scope, r.label);
          if (v != null && v !== "") out.css[prop] = String(v);
        }
      }
      return out;
    }
    return null;
  };
}

// `(scope) => style | null` from any of the three shapes.
export function compileStyler(spec, label, opts = {}) {
  const warn = opts.warn ?? defaultWarn;
  const run = opts.run ?? makeRunner(warn);
  if (Array.isArray(spec)) return compileRules(spec, label, warn, run);
  if (spec && typeof spec === "object") return compileRules([spec], label, warn, run);
  let c;
  try { c = compileExpr(String(spec)); }
  catch (e) {
    warn(`bad styler expression in ${label}: ${e.message}`);
    return () => null;
  }
  return (scope) => {
    const v = run(c, scope, label);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  };
}

// Apply a style result to an element, first clearing whatever the
// previous one set. Backgrounds ride a custom property + marker class so
// the stylesheet stays in charge of precedence — selection tints blend
// with (rather than vanish under) a styled background.
export function applyStyle(el, style, bgProp, bgClass) {
  const prev = el._mkuiStyle;
  if (!prev && !style) return;
  if (prev) {
    el.style.color = "";
    el.style.fontWeight = "";
    el.style.fontStyle = "";
    el.style.textDecoration = "";
    el.style.textTransform = "";
    el.style.removeProperty(bgProp);
    el.classList.remove(bgClass);
    if (prev.class) el.classList.remove(...String(prev.class).split(/\s+/));
    if (prev.css) for (const k of Object.keys(prev.css)) el.style.removeProperty(k);
  }
  el._mkuiStyle = style ?? null;
  if (!style) return;
  if (style.color) el.style.color = style.color;
  if (style.bold) el.style.fontWeight = "bold";
  if (style.italic) el.style.fontStyle = "italic";
  const deco = [style.underline && "underline", style.strike && "line-through"]
    .filter(Boolean).join(" ");
  if (deco) el.style.textDecoration = deco;
  if (style.caps) el.style.textTransform = "uppercase";
  if (style.background) {
    el.style.setProperty(bgProp, style.background);
    el.classList.add(bgClass);
  }
  if (style.class) el.classList.add(...String(style.class).split(/\s+/));
  if (style.css)
    for (const [k, v] of Object.entries(style.css)) el.style.setProperty(k, v);
}
