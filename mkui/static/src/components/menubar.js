// <mkui-menubar> — top menubar with dropdown popups. Config:
//
//   [[menubar]]
//   label = "File"
//   items = [
//     { label = "New",  action = "window.new" },
//     { sep = true },
//     { label = "Quit", action = "app.quit" },
//   ]

class MkuiMenubar extends HTMLElement {
  constructor() {
    super();
    this._app = null;
    this._openPopup = null;
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
        this._toggleMenu(el, menu);
      });
      this.appendChild(el);
    }
    document.addEventListener("mousedown", () => this._closePopup());
  }

  _toggleMenu(anchor, menu) {
    if (this._openPopup) {
      this._closePopup();
      return;
    }
    const popup = document.createElement("div");
    popup.className = "mkui-menu-popup";
    popup.style.left = anchor.offsetLeft + "px";
    for (const item of menu.items ?? []) {
      if (item.sep) {
        const s = document.createElement("div");
        s.className = "mkui-menu-sep";
        popup.appendChild(s);
        continue;
      }
      const it = document.createElement("div");
      it.className = "mkui-menu-item";
      it.textContent = item.label;
      it.addEventListener("mousedown", (ev) => {
        ev.stopPropagation();
        this._closePopup();
        if (item.action) this._app.fireAction(item.action, item.args);
      });
      popup.appendChild(it);
    }
    anchor.classList.add("open");
    this.appendChild(popup);
    this._openPopup = { popup, anchor };
  }

  _closePopup() {
    if (!this._openPopup) return;
    this._openPopup.popup.remove();
    this._openPopup.anchor.classList.remove("open");
    this._openPopup = null;
  }
}

if (!customElements.get("mkui-menubar")) customElements.define("mkui-menubar", MkuiMenubar);
export { MkuiMenubar };
