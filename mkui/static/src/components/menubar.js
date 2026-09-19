// <mkui-menubar> — top menubar with cascading dropdown popups. Config:
//
//   [[menubar]]
//   label = "File"
//   items = [
//     { label = "New",  action = "window.new" },
//     { sep = true },
//     { label = "Open Recent", items = [
//         { label = "foo.txt", action = "demo.open", args = "foo.txt" },
//       ] },
//     { label = "Quit", action = "app.quit" },
//   ]
//
// Any item with an `items` array renders as an expandable submenu that
// opens to the right on hover; otherwise it's a leaf that fires `action`.
//
// A leaf with `confirm` (a message, or `{ message, title, kind, ok,
// cancel }`) asks in a message box first, and fires only on OK.
//
// `disabled` and `showWhen` take a boolean or an expression over the menu
// scope (lib/menu.js: `state`, `app`, `pane`, `selection`, `panes`), read
// as the menu opens, again at the click, and — for the `state` they read —
// while it stays open. `disabledTitle` is the tooltip saying why.
//
// An item of `{ windows = true }` expands into one `pane.show` leaf per
// currently-open pane — popups are rebuilt on every open, so the list
// always reflects the live workspace.

import { icon } from "../lib/icons.js";

import { formatShortcut } from "../lib/shortcut.js";
import { asks, confirmed } from "../lib/dialogs.js";
import { menuScope, itemFlags, visibleItems, itemStatePaths } from "../lib/menu.js";
export { formatShortcut };

class MkuiMenubar extends HTMLElement {
  constructor() {
    super();
    this._app = null;
    this._rootAnchor = null;           // currently-open top-level <div class="mkui-menu">
    this._openStack = [];              // [{ popup, parentAnchor, depth }], depth 0 = root popup
    this._docHandler = null;
    this._docUpHandler = null;
    this._pressActive = false;         // true between opening mousedown and its matching mouseup
    this._unsubs = [];                 // state subscriptions of the open menu
  }

  _scope() {
    const ws = this._app?._element?.workspace ?? this._app?._element?._workspace ?? null;
    return menuScope(this._app, ws);
  }

  setApp(app) {
    this._app = app;
    this._render();
  }

  _render() {
    this.innerHTML = "";
    const items = this._app?.config?.menubar ?? [];
    for (const menu of items) {
      const el = document.createElement("div");
      el.className = "mkui-menu";
      el.textContent = menu.label;
      el.addEventListener("mousedown", (ev) => {
        if (ev.button !== 0) return;
        ev.stopPropagation();
        if (this._rootAnchor === el) this._closeAll();
        else { this._closeAll(); this._openRoot(el, menu); this._pressActive = true; }
      });
      el.addEventListener("mouseenter", () => {
        // Swap between open menus when hovering across the menubar.
        if (!this._rootAnchor || this._rootAnchor === el) return;
        this._closeAll();
        this._openRoot(el, menu);
      });
      this.appendChild(el);
    }

    if (!this._docHandler) {
      this._docHandler = (ev) => {
        if (!this._rootAnchor) return;
        if (this.contains(ev.target)) return;
        this._closeAll();
      };
      document.addEventListener("mousedown", this._docHandler);
    }
    if (!this._docUpHandler) {
      this._docUpHandler = (ev) => {
        if (!this._pressActive) return;
        this._pressActive = false;
        if (!this._rootAnchor) return;
        if (this.contains(ev.target)) return;
        this._closeAll();
      };
      document.addEventListener("mouseup", this._docUpHandler);
    }
  }

  _openRoot(anchor, menu) {
    this._rootAnchor = anchor;
    anchor.classList.add("open");
    const popup = this._buildPopup(menu.items ?? [], 0);
    // Follow the state the menu's flags read while it is open (`subscribe`
    // answers at once: those first calls are not changes).
    const state = this._app?.state;
    if (typeof state?.subscribe === "function") {
      let live = false;
      for (const path of itemStatePaths(menu.items)) this._unsubs.push(state.subscribe(path, () => { if (live) this._refreshFlags(); }));
      live = true;
    }
    popup.style.left = anchor.offsetLeft + "px";
    popup.style.top = this.clientHeight + "px";
    this.appendChild(popup);
    this._openStack.push({ popup, parentAnchor: anchor, depth: 0 });
  }

  // Replace dynamic markers with concrete items at popup-build time.
  _expandItems(items) {
    const out = [];
    for (const item of items) {
      if (item.windows) {
        const panes = this._app?._element?.workspace?.openPanes?.() ?? [];
        for (const p of panes) out.push({ label: p.title, action: "pane.show", args: p.id });
      } else if (item.layouts) {
        out.push(this._layoutsSubmenu(item));
      } else {
        out.push(item);
      }
    }
    return out;
  }

  // `{ label, layouts = true }` becomes a submenu with one leaf per saved
  // layout (state `layouts.list`, newest first), firing `layout.restore`
  // with the entry id — or a single disabled leaf when nothing is saved.
  // Building it asks the layout manager to refresh the list, so the next
  // open reflects other tabs' saves.
  _layoutsSubmenu(item) {
    const app = this._app;
    if (app?.actions?.has("layout.refresh")) app.fireAction("layout.refresh");
    const entries = app?.state?.get("layouts.list") ?? [];
    const items = entries.length
      ? entries.map(e => ({ label: e.label ?? String(e.id), action: "layout.restore", args: e.id }))
      : [{ label: "No saved layouts", disabled: true }];
    // With nothing live in it the submenu itself greys out; the tooltip
    // says what the muted entry inside would have.
    return { label: item.label, items, disabledTitle: "No saved layouts" };
  }

  _buildPopup(items, depth) {
    const popup = document.createElement("div");
    popup.className = "mkui-menu-popup";
    popup._mkuiItems = [];   // [{ el, item, rec }] for `_refreshFlags`
    for (const rec of visibleItems(this._expandItems(items), this._scope())) {
      const item = rec.item;
      if (item.sep) {
        const s = document.createElement("div");
        s.className = "mkui-menu-sep";
        popup.appendChild(s);
        continue;
      }
      const it = document.createElement("div");
      it.className = "mkui-menu-item";
      const hasSubmenu = Array.isArray(item.items) && item.items.length > 0;
      if (hasSubmenu) it.classList.add("mkui-menu-item-submenu");
      // A disabled item is inert: no action, no submenu, no hover highlight.
      if (rec.disabled) it.classList.add("mkui-menu-item-disabled");
      if (rec.title) it.title = rec.title;
      popup._mkuiItems.push({ el: it, item, rec });
      it.appendChild(document.createTextNode(item.label));
      if (hasSubmenu) {
        const arrow = document.createElement("span");
        arrow.className = "mkui-menu-item-arrow";
        arrow.appendChild(icon("chevron-right"));
        it.appendChild(arrow);
      } else if (item.shortcut) {
        const sc = document.createElement("span");
        sc.className = "mkui-menu-shortcut";
        sc.textContent = formatShortcut(item.shortcut);
        it.appendChild(sc);
      }
      it.addEventListener("mouseenter", () => {
        // If the same submenu is already open at depth+1, leave it alone.
        // Otherwise close deeper popups and open this one's submenu (if any).
        const existing = this._openStack.find(e => e.depth === depth + 1);
        if (existing && existing.parentAnchor === it) return;
        this._closeFromDepth(depth + 1);
        if (hasSubmenu && !rec.disabled) this._openSubmenu(it, item, depth + 1);
      });
      it.addEventListener("mousedown", (ev) => {
        if (ev.button !== 0) return;
        ev.stopPropagation();
        this._pressActive = true;
      });
      it.addEventListener("mouseup", (ev) => {
        if (ev.button !== 0) return;
        ev.stopPropagation();
        this._pressActive = false;
        if (hasSubmenu) return; // hover already opened it
        // Asked again at the click: the state may have moved since the
        // popup was built.
        const now = itemFlags(item, this._scope());
        if (rec.disabled || now.disabled || now.hidden) return;
        this._closeAll();
        this._fire(item);
      });
      popup.appendChild(it);
    }
    return popup;
  }

  // A leaf fires its action — after asking, when it carries `confirm` (a
  // message, or `{ message, title, kind, ok, cancel }`): anything but OK
  // fires nothing.
  async _fire(item) {
    if (!item.action) return;
    if (asks(item) && !await confirmed(this._app, item)) return;
    this._app.fireAction(item.action, item.args);
  }

  _openSubmenu(parentItem, item, depth) {
    const popup = this._buildPopup(item.items, depth);
    popup.classList.add("mkui-menu-popup-sub");
    const r = parentItem.getBoundingClientRect();
    const mbRect = this.getBoundingClientRect();
    popup.style.left = (r.right - mbRect.left) + "px";
    popup.style.top = (r.top - mbRect.top) + "px";
    this.appendChild(popup);
    this._openStack.push({ popup, parentAnchor: parentItem, depth });
  }

  _closeFromDepth(depth) {
    while (this._openStack.length && this._openStack[this._openStack.length - 1].depth >= depth) {
      this._openStack.pop().popup.remove();
    }
  }

  // The state an open menu reads has changed: grey out, or bring back,
  // what it now says. (What `showWhen` hides is settled at the next open.)
  _refreshFlags() {
    const scope = this._scope();
    for (const { popup } of this._openStack) {
      const recs = visibleItems((popup._mkuiItems ?? []).map((e) => e.item), scope);
      for (const e of popup._mkuiItems ?? []) {
        const next = recs.find((r) => r.item === e.item);
        if (!next) continue;
        e.rec.disabled = next.disabled;
        e.el.classList.toggle("mkui-menu-item-disabled", next.disabled);
        e.el.title = next.title;
      }
    }
  }

  _closeAll() {
    for (const off of this._unsubs.splice(0)) off?.();
    this._closeFromDepth(0);
    if (this._rootAnchor) {
      this._rootAnchor.classList.remove("open");
      this._rootAnchor = null;
    }
  }
}

if (!customElements.get("mkui-menubar")) customElements.define("mkui-menubar", MkuiMenubar);
export { MkuiMenubar };
