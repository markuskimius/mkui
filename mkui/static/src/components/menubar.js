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

class MkuiMenubar extends HTMLElement {
  constructor() {
    super();
    this._app = null;
    this._rootAnchor = null;           // currently-open top-level <div class="mkui-menu">
    this._openStack = [];              // [{ popup, parentAnchor, depth }], depth 0 = root popup
    this._docHandler = null;
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
        ev.stopPropagation();
        if (this._rootAnchor === el) this._closeAll();
        else { this._closeAll(); this._openRoot(el, menu); }
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
  }

  _openRoot(anchor, menu) {
    this._rootAnchor = anchor;
    anchor.classList.add("open");
    const popup = this._buildPopup(menu.items ?? [], 0);
    popup.style.left = anchor.offsetLeft + "px";
    popup.style.top = this.clientHeight + "px";
    this.appendChild(popup);
    this._openStack.push({ popup, parentAnchor: anchor, depth: 0 });
  }

  _buildPopup(items, depth) {
    const popup = document.createElement("div");
    popup.className = "mkui-menu-popup";
    for (const item of items) {
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
      it.appendChild(document.createTextNode(item.label));
      if (hasSubmenu) {
        const arrow = document.createElement("span");
        arrow.className = "mkui-menu-item-arrow";
        arrow.textContent = "\u25B8"; // ▸
        it.appendChild(arrow);
      }
      it.addEventListener("mouseenter", () => {
        // If the same submenu is already open at depth+1, leave it alone.
        // Otherwise close deeper popups and open this one's submenu (if any).
        const existing = this._openStack.find(e => e.depth === depth + 1);
        if (existing && existing.parentAnchor === it) return;
        this._closeFromDepth(depth + 1);
        if (hasSubmenu) this._openSubmenu(it, item, depth + 1);
      });
      it.addEventListener("mousedown", (ev) => {
        ev.stopPropagation();
        if (hasSubmenu) return; // hover already opened it
        this._closeAll();
        if (item.action) this._app.fireAction(item.action, item.args);
      });
      popup.appendChild(it);
    }
    return popup;
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

  _closeAll() {
    this._closeFromDepth(0);
    if (this._rootAnchor) {
      this._rootAnchor.classList.remove("open");
      this._rootAnchor = null;
    }
  }
}

if (!customElements.get("mkui-menubar")) customElements.define("mkui-menubar", MkuiMenubar);
export { MkuiMenubar };
