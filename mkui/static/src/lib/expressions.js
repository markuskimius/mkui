// Resolve ${path.to.value} expressions via dot-path lookups — no eval.
// Pure expressions (entire string is one ${...}) return the raw value;
// mixed templates always return a string.

function lookup(ctx, path) {
  const parts = path.trim().split(".");
  let v = ctx;
  for (const p of parts) {
    if (v == null) return undefined;
    v = v[p];
  }
  return v;
}

const EXPR_RE = /\$\{([^}]+)\}/g;

export function resolveExpr(template, ctx) {
  if (typeof template !== "string") return template;
  if (!template.includes("${")) return template;
  const pure = template.match(/^\$\{([^}]+)\}$/);
  if (pure) {
    const v = lookup(ctx, pure[1]);
    return v == null ? "" : v;
  }
  return template.replace(EXPR_RE, (_, path) => {
    const v = lookup(ctx, path);
    return v == null ? "" : String(v);
  });
}

export function resolveObject(obj, ctx) {
  if (obj == null) return obj;
  if (typeof obj === "string") return resolveExpr(obj, ctx);
  if (Array.isArray(obj)) return obj.map((v) => resolveObject(v, ctx));
  if (typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = resolveObject(v, ctx);
    return out;
  }
  return obj;
}
