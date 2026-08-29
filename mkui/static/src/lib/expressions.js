// mkui's view of the mkio expression language (lib/expr.js, vendored from
// mkio's client/mkio-expr.mjs — tests/vendor-sync.test.js keeps it identical).
//
// Everything mkui evaluates goes through here with one *lenient* environment:
// unknown names are NULL rather than errors, because UI scopes (rows, form
// fields, app state) are heterogeneous by nature. Compiled expressions and
// templates are cached by source string. Evaluation errors are reported once
// per source via console.warn and yield null, so a bad expression in config
// degrades one cell or rule instead of taking the pane down.

import * as expr from "./expr.js";

export { expr };
export const env = new expr.Env({ strict: false });

const templates = new Map();
const compiled = new Map();
const warned = new Set();

function warnOnce(src, e) {
  if (warned.has(src)) return;
  warned.add(src);
  console.warn(`[mkui] expression error in ${JSON.stringify(src)}: ${e.message}`);
}

/** Compile a "text ${expr}" template (cached). Throws ExprError on bad syntax. */
export function compileTemplate(src) {
  let t = templates.get(src);
  if (!t) { t = expr.compileTemplate(src, env); templates.set(src, t); }
  return t;
}

/** Compile a bare expression (cached). Throws ExprError on bad syntax. */
export function compileExpr(src) {
  let c = compiled.get(src);
  if (!c) { c = expr.compile(src, env); compiled.set(src, c); }
  return c;
}

/**
 * Evaluate a bare expression string against a scope object. Syntax and
 * evaluation errors warn once and yield null. Non-strings pass through, so
 * config keys may hold either a literal value or an expression.
 */
export function evalExpr(src, scope) {
  if (typeof src !== "string") return src;
  try {
    return compileExpr(src).call(scope);
  } catch (e) {
    warnOnce(src, e);
    return null;
  }
}

/**
 * Resolve a template string against a scope. A template that is exactly one
 * ${...} yields the raw value (NULL → ""); mixed templates yield a string;
 * strings without ${ are returned unchanged, as are non-strings.
 */
export function resolveExpr(template, scope) {
  if (typeof template !== "string" || !template.includes("${")) return template;
  try {
    const v = compileTemplate(template).call(scope);
    return v == null ? "" : v;
  } catch (e) {
    warnOnce(template, e);
    return "";
  }
}

/** Resolve every template string inside a nested object / array. */
export function resolveObject(obj, scope) {
  if (obj == null) return obj;
  if (typeof obj === "string") return resolveExpr(obj, scope);
  if (Array.isArray(obj)) return obj.map((v) => resolveObject(v, scope));
  if (typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = resolveObject(v, scope);
    return out;
  }
  return obj;
}

/**
 * The `state.a.b` paths an expression or template reads, as dotted strings
 * ("a.b"), so a widget can subscribe to exactly those. A bare `state`
 * reference (or a computed key) yields "" — subscribe to the root.
 */
export function statePaths(src, { template = false } = {}) {
  const paths = new Set();
  let asts;
  try {
    asts = template
      ? compileTemplate(src).parts.filter((p) => p[0] === "expr").map((p) => p[1].ast)
      : [compileExpr(src).ast];
  } catch {
    return paths;
  }
  const chain = (n) => {
    // Returns { path, open } if n is state[.k]* — `open` is false once a
    // computed key is met, after which outer keys no longer extend the path.
    if (n.type === "Name") return n.name === "state" ? { path: [], open: true } : null;
    if (n.type === "Index") {
      const base = chain(n.target);
      if (!base) return null;
      if (!base.open) return base;
      if (n.key.type === "Literal") return { path: [...base.path, String(n.key.value)], open: true };
      return { path: base.path, open: false };
    }
    return null;
  };
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    const c = chain(n);
    if (c) { paths.add(c.path.join(".")); if (n.type === "Index") walk(n.key); return; }
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach((x) => (Array.isArray(x) ? x.forEach(walk) : walk(x)));
      else if (v && typeof v === "object" && v.type) walk(v);
    }
  };
  asts.forEach(walk);
  return paths;
}

/** Register an application function, usable from every mkui expression. */
export function registerExprFunction(name, fn, meta = {}) {
  return expr.registerFunction(name, fn, { library: "app", ...meta });
}
export function registerExprLibrary(name, functions) { return expr.registerLibrary(name, functions); }
export function registerExprType(name, isInstance, hooks) { return expr.registerType(name, isInstance, hooks); }
