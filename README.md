# mkui

A config-driven, dependency-free web GUI framework with a floating-frame
workspace and dockable panes inside each frame. Designed to pair with
[mkio](../mkio) — the same project's TOML-driven microservice backend —
but works against any backend (or none at all).

## Model

```
mkui-app
├── mkui-menubar
├── mkui-workspace
│   ├── mkui-frame  ← floating, movable, resizable. Clamped to workspace.
│   │   └── layout tree
│   │       └── TabGroup
│   │           ├── tab bar
│   │           └── mkui-pane  ← leaf content host
│   ├── mkui-frame
│   │   └── split (h | v)
│   │       ├── TabGroup → panes
│   │       └── TabGroup → panes
│   └── ...
└── mkui-statusbar
```

Top-level windows are **frames** — floating chrome with 8-way resize.
There is no dedicated titlebar: every tab bar at the top edge doubles
as a drag region, and the right-most one also carries the window
controls. Frames don't dock into each other. Inside each frame lives
an independent, normalized layout tree of **splits**, **tab groups**,
and **panes**. Docking — splitting, tabbing, tearing out — happens
entirely inside frames.

**Design commitments** (things meant to hold up indefinitely):

- **Structural invariant**: every pane leaf sits inside a tab group. A
  single-pane frame is a single-tab group. This removes a whole class of
  special cases from the renderer and the drop logic.
- **Proportional resize by construction**: frame positions are fractions
  of the workspace rect, and split ratios sum to 1. Resizing the browser
  rescales every frame, every split, and every pane with no extra code.
- **Viewport clamping invariant**: every frame move/resize passes through
  a single `clampToDock` helper. Frames cannot escape the workspace —
  shrinking the viewport drags stragglers back in.
- **Stable pane identity**: pane elements live in a workspace-owned pool
  and are re-parented via `appendChild` when re-docked. Content state,
  subscriptions, scroll position, and DOM focus all survive.
- **Zero runtime dependencies.** Web Components, so it drops into
  React / Vue / Svelte / vanilla identically.

## Interactions

- **Top tab row** → drag the whitespace next to the tabs to move the
  frame (clamped). **Double-click** the same region to toggle maximize.
  **Frame edges/corners** → 8-way resize (clamped, min 160×80).
- **Dragging a tiled or maximized frame** restores it to its pre-tile
  size under the cursor on first motion. Resize handles or explicit
  maximize-toggle also clear the restore state.
- **Frame close button** → closes the frame; panes inside are parked in
  the pool (state preserved) and can be brought back by code.
- **Tab click** → switch active pane in that tab group.
- **Tab drag within the bar** → reorders the tab in its group. If the
  cursor leaves the tab bar by more than a few pixels, the pane is
  **torn out** into a new frame at the cursor.
- **Alt+Shift+Left / Alt+Shift+Right** → move the active tab left or
  right within its group (acts on the top-most frame).
- **Dragging a torn-out (or any single-pane) frame over another frame**
  shows drop zones: edges split, center adds as a tab. Release to dock.
- **Splitter drag** → resize the ratio between two children of a split.
- **Any mousedown inside a frame** raises it to the top of the z-order.
  The top frame gets an accent border; within it, the last-clicked tab
  group's active-tab underline stays at full accent while others dim —
  that's the bar keyboard hotkeys act on.

## Configs

mkui's runtime input is JSON. When the backend is mkio, mkio's Python
side parses `app.toml` with stdlib `tomllib` and serves the result as
JSON — so the browser never needs a TOML parser. For other backends,
author or generate `app.json` directly.

Minimal config:

```json
{
  "app":     { "title": "Trading desk", "theme": "dark" },
  "menubar": [{ "label": "File", "items": [{ "label": "Quit", "action": "app.quit" }] }],
  "statusbar": { "left": [{ "type": "text", "bind": "status.message" }] },

  "panes": {
    "orders":    { "title": "Orders", "type": "mkio-table", "service": "all_orders", "protocol": "query" },
    "chart":     { "title": "Chart",  "widgets": [{ "type": "text", "text": "Chart goes here" }] },
    "inspector": { "title": "Inspector", "widgets": [{ "type": "text", "text": "Properties" }] }
  },

  "frames": [
    {
      "id": "main",
      "x": 0.05, "y": 0.05, "w": 0.65, "h": 0.9,
      "layout": { "type": "tabs", "active": 0, "children": ["orders", "chart"] }
    },
    {
      "id": "aux",
      "x": 0.72, "y": 0.05, "w": 0.23, "h": 0.9,
      "layout": { "type": "tabs", "children": ["inspector"] }
    }
  ],

  "mkio": { "url": "ws://localhost:8080/ws" }
}
```

Frame positions (`x`, `y`, `w`, `h`) are fractions of the workspace rect.

## Statusbar

`statusbar` is a top-level object with `left` and `right` widget arrays,
plus an optional `bindStyle` map that binds CSS properties to state paths:

```json
"statusbar": {
  "left":  [{ "type": "text", "bind": "status.message" }],
  "right": [{ "type": "text", "text": "v0.1" }],
  "bindStyle": { "background": "status.background", "color": "status.color" }
}
```

Each `bindStyle` entry subscribes to the given state path. When the value
changes, the CSS property is set as an inline style on `<mkui-statusbar>`.
Setting the state value to `null` removes the inline override, reverting to
the stylesheet default.

## mkio connection state

When `config.mkio.url` is set, `<mkui-app>` automatically connects to the
mkio server and tracks connection lifecycle. The optional `connected` and
`disconnected` keys are state maps — on each event, every entry is applied
via `state.set(path, value)`:

```json
"mkio": {
  "url": "ws://localhost:8080/ws",
  "connected":    { "status.message": "Connected", "status.background": null },
  "disconnected": { "status.message": "Disconnected", "status.background": "#858585" }
}
```

If omitted, the defaults are `{ "status.message": "Connected" }` and
`{ "status.message": "Disconnected" }`. Combine with `statusbar.bindStyle`
to change the statusbar appearance on disconnect.

## Menubar

`menubar` is a top-level array. Each element is a dropdown menu with a
`label` and an `items` array:

```json
"menubar": [
  {
    "label": "File",
    "items": [
      { "label": "New Frame", "action": "demo.newFrame" },
      { "sep": true },
      { "label": "Open Recent", "items": [
          { "label": "foo.txt", "action": "demo.open", "args": "foo.txt" }
        ]
      },
      { "label": "Quit", "action": "app.quit" }
    ]
  },
  {
    "label": "Window",
    "items": [
      { "label": "Cascade", "action": "window.cascade" },
      { "label": "Tile", "items": [
          { "label": "Horizontal", "action": "window.tileH" },
          { "label": "Vertical",   "action": "window.tileV" },
          { "label": "Grid",       "action": "window.grid" }
        ]
      }
    ]
  }
]
```

Item keys:

| Key | Type | Description |
|---|---|---|
| `label` | string | Display text |
| `action` | string | Action name fired on click (leaf items only) |
| `args` | any | Optional argument passed to the action handler |
| `items` | array | Child items — makes this a submenu (opens on hover) |
| `sep` | boolean | `true` renders a horizontal separator line |

Any item with an `items` array is a submenu; submenus nest arbitrarily.
Leaf items (no `items`) fire `action` on click via `app.fireAction()`.

**Built-in actions:** `app.quit`, `pane.show` (takes a pane ID as
`args` — switches to that pane's tab and raises its frame, or opens a
new frame if the pane is parked/closed), `window.tileH`, `window.tileV`,
`window.grid`, `window.cascade`. Register custom actions with
`app.registerAction(name, fn)`.

A typical Window menu lists each pane for quick access:

```json
{ "label": "Window", "items": [
  { "label": "Explorer",  "action": "pane.show", "args": "explorer" },
  { "label": "Console",   "action": "pane.show", "args": "console" },
  { "sep": true },
  { "label": "Cascade",   "action": "window.cascade" }
]}
```

## Themes

`dark` and `light` are built-in. To ship additional themes, list them under
`app.themes` — each entry is a flat object of CSS custom property overrides,
applied as inline styles on `<mkui-app>` so every descendant inherits them:

```json
{
  "app": {
    "theme": "solarized",
    "themes": {
      "solarized": {
        "--mkui-bg":        "#002b36",
        "--mkui-bg-alt":    "#073642",
        "--mkui-bg-hover":  "#0a4350",
        "--mkui-fg":        "#93a1a1",
        "--mkui-fg-mute":   "#586e75",
        "--mkui-border":    "#0a4350",
        "--mkui-accent":    "#268bd2",
        "--mkui-accent-fg": "#fdf6e3",
        "--mkui-focus":     "#eee8d5"
      }
    }
  }
}
```

Any variable from `styles/mkui.css` (`--mkui-*`) may be overridden. Missing
keys fall back to the default (dark) values. Switch themes at runtime with
`appEl.setTheme("solarized")`.

## Standalone mode

```html
<!doctype html>
<link rel="stylesheet" href="/mkui/styles/mkui.css">
<script type="module" src="/mkui/src/index.js"></script>
<mkui-app config="/mkui/config.json"></mkui-app>
```

## Library mode

```js
import { registerPaneType } from "mkui";
import "mkui";   // side-effect: registers custom elements

registerPaneType("clock", (spec, app, host) => {
  const el = document.createElement("div");
  host.appendChild(el);
  setInterval(() => { el.textContent = new Date().toLocaleTimeString(); }, 1000);
});

const root = document.querySelector("mkui-app");
await customElements.whenDefined("mkui-app");
root.setConfig({
  panes:  { clock: { title: "Clock", type: "clock" } },
  frames: [{ id: "f1", x: 0.3, y: 0.3, w: 0.3, h: 0.3,
             layout: { type: "tabs", children: ["clock"] } }],
});

// Add more frames at runtime:
root.workspace.addFrame({ x: 0.5, y: 0.1, w: 0.4, h: 0.4,
                          layout: { type: "tabs", children: ["other-pane"] } });
```

## Built-in widgets and pane types (v1)

- Widgets (lightweight content inside a pane or statusbar slot):
  - `text` — static or `bind`-ed to a state path
  - `button` — fires an action by name
- Pane types (whole-pane custom rendering):
  - `mkio-table` — subscribes to an mkio service (query, subpub, or stream) and renders a live-updating table with flash animations for inserts, deletes, and field changes. Subscriptions are automatically paused when the pane is not visible (hidden tab, closed frame) and resumed with a fresh snapshot when it reappears.
- Custom pane types are the primary extensibility surface. Register with
  `registerPaneType(name, factory)`; reference from config as `type = "<name>"`.

## Installation

```
pip install mkui
```

Then serve the static assets from your Python backend:

```python
import mkui

# With mkio (toml config):
#   [static]
#   "/mkui" = "<result of mkui.static_dir>"

# With FastAPI / Starlette:
from starlette.staticfiles import StaticFiles
app.mount("/mkui", StaticFiles(directory=mkui.static_dir))
```

## Running the examples

```
cd mkui/static
python3 -m http.server 8000
# http://localhost:8000/examples/standalone-json/
# http://localhost:8000/examples/library-js/
```

## Project layout

```
mkui/                    Python package (pip install mkui)
  __init__.py            Exposes static_dir path
  static/
    src/
      core.js            State store, registries, App class
      index.js           Side-effect entry point
      layout/
        tree.js          Normalized tree math
        drag.js          clampToDock, snap, dropZoneFor, frac↔rect
      components/
        app.js           <mkui-app> — the shell
        menubar.js       <mkui-menubar>
        statusbar.js     <mkui-statusbar>
        workspace.js     <mkui-workspace> — frame list, arrangement, snap
        frame.js         <mkui-frame> + <mkui-pane>
      widgets/
        text.js  button.js  mkio-table.js
      mkio-bridge.js     Lazy-loads mkio's /mkio.js client
    styles/mkui.css      Default theme (CSS custom properties)
    examples/
      standalone-json/   Loaded from a static config
      library-js/        Built imperatively from JS
      mkio-table/        Live table backed by mkio query/subpub services
pyproject.toml           Python build config
package.json             JS dev tooling
tests/layout.test.js     40 layout unit tests
tests/state.test.js      15 state + connection lifecycle tests
```
