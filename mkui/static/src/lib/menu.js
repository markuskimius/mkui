// What a menu item's expressions see and what they decide: `disabled` and
// `showWhen` take a boolean or an expression, read each time the menu
// opens and again at the click. DOM-free (`tests/menu.test.js`); the
// popups are components/menubar.js.

import { compileExpr, evalExpr, expr, statePaths } from "./expressions.js";

// The menu scope: `state`, `app` (the config's block), `pane` — the
// focused frame's active pane, `{ id, type, title, can }` or NULL (`can.copy`,
// `can.find`, …: the edit actions it answers) — its
// `selection` (`{ count, focused }`: the rows the selection implies, and
// whether a cursor row stands; NULL for a pane with nothing to select) and
// `panes`, the ids open in a frame.
export function menuScope(app, ws) {
  const info = ws?.focusInfo?.() ?? null;
  return {
    state: app?.state?.get?.() ?? {},
    app: app?.config?.app ?? {},
    pane: info?.pane ?? null,
    selection: info?.selection ?? null,
    panes: (ws?.openPanes?.() ?? []).map((p) => p.id),
  };
}

// A flag is a literal boolean or an expression. One that errors falls
// back — warning once — so a typo leaves an item enabled and shown rather
// than out of reach.
function flag(v, scope, fallback) {
  if (v == null) return fallback;
  if (typeof v !== "string") return !!v;
  try {
    return expr.truthy(compileExpr(v).call(scope));
  } catch {
    evalExpr(v, scope);   // the one warning
    return fallback;
  }
}

// `{ disabled, hidden, title }` for one item. `disabledTitle` says why,
// as the tooltip of an item that is off.
export function itemFlags(item, scope) {
  const hidden = !flag(item?.showWhen, scope, true);
  const disabled = flag(item?.disabled, scope, false);
  return { disabled, hidden, title: disabled && item?.disabledTitle ? String(item.disabledTitle) : "" };
}

// The items a popup shows, each `{ item, disabled, title }`: hidden ones
// gone, a submenu with nothing live in it disabled, and no separator left
// leading, trailing, or doubled by what was hidden.
export function visibleItems(items, scope) {
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== "object") continue;
    if (item.sep) {
      if (flag(item.showWhen, scope, true) && out.length && !out[out.length - 1].item.sep) out.push({ item, disabled: false, title: "" });
      continue;
    }
    const f = itemFlags(item, scope);
    if (f.hidden) continue;
    if (Array.isArray(item.items) && item.items.length) {
      const kids = visibleItems(item.items, scope).filter((k) => !k.item.sep);
      if (kids.length === 0) continue;
      if (kids.every((k) => k.disabled)) f.disabled = true;
    }
    out.push({ item, disabled: f.disabled, title: f.disabled && item.disabledTitle ? String(item.disabledTitle) : "" });
  }
  while (out.length && out[out.length - 1].item.sep) out.pop();
  return out;
}

// The app-state paths the flags of these items (submenus included) read:
// what an open popup follows, so an item greys out as the state moves.
export function itemStatePaths(items) {
  const out = new Set();
  const walk = (list) => {
    for (const item of Array.isArray(list) ? list : []) {
      for (const k of ["disabled", "showWhen"]) {
        if (typeof item?.[k] === "string") for (const p of statePaths(item[k])) if (p) out.add(p);
      }
      walk(item?.items);
    }
  };
  walk(items);
  return out;
}
