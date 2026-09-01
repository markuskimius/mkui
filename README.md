# mkui

[![PyPI](https://img.shields.io/pypi/v/mkui)](https://pypi.org/project/mkui/)
[![Python](https://img.shields.io/pypi/pyversions/mkui)](https://pypi.org/project/mkui/)
[![License](https://img.shields.io/pypi/l/mkui)](https://github.com/markuskimius/mkui/blob/main/LICENSE)

A config-driven, dependency-free web GUI framework with a floating-frame
workspace and dockable panes inside each frame. Designed to pair with
[mkio](https://pypi.org/project/mkio/) — the same project's TOML-driven microservice backend —
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
  React / Vue / Svelte / vanilla identically. All chrome icons (window
  controls, tab scroll arrows, sort carets, filter hamburgers, paging
  controls) are
  inline SVG built from vendored path data — no icon font, no external
  fetch, and they recolor with the theme via `currentColor`.

## Interactions

- **Top tab row** → drag the whitespace next to the tabs to move the
  frame (clamped). **Double-click** the same region to toggle maximize.
  On non-docking frames (dialogs, login) the title tab itself also
  drags the frame — it acts as titlebar text.
  **Frame edges/corners** → 8-way resize (clamped, min 180×80).
- **Dragging a tiled or maximized frame** restores it to its pre-tile
  size under the cursor on first motion. Resize handles or explicit
  maximize-toggle also clear the restore state.
- **Frame close button** → closes the frame; panes inside are parked in
  the pool (state preserved) and can be brought back by code.
- **Tab click** → switch active pane in that tab group. Clicking a tab
  or pane content also makes that group the keyboard-focus target;
  clicking the bar's empty area only raises the frame.
- **Tab drag within the bar** → reorders the tab in its group. If the
  cursor leaves the tab bar by more than a few pixels, the pane is
  **torn out** into a new frame at the cursor.
- **Tab overflow** → tabs shrink to fit the bar, down to 3em of label
  each. If they still don't fit, the strip clips with no scrollbar and
  ‹ › scroll arrows appear on either side of it; arrows dim at their
  end of the strip. The bar always keeps at least one tab plus the
  arrows visible, and the active tab is scrolled back into view
  whenever the bar re-renders.
- **Alt+Shift+Left / Alt+Shift+Right** → move the active tab left or
  right within its group (acts on the top-most frame).
- **Ctrl/Cmd+C, Ctrl/Cmd+A, Escape** → copy, select-all, and
  clear-selection, routed to the focused frame's active pane (tables
  implement all three). Either modifier works on every platform; text
  inputs and native text selections keep the browser behavior.
- **Dragging a torn-out (or any single-pane) frame over another frame**
  shows drop zones: edges split, center adds as a tab. Release to dock.
- **Splitter drag** → resize the ratio between two children of a split.
- **Left button only** — menus, drags, resizes, sorting, and selection
  respond to the primary mouse button; right and middle clicks are inert
  (except that any button raises a frame, matching OS convention).
  Modified clicks are inert where the modifier has no meaning: e.g.
  ctrl/cmd/alt+click on a sort header leaves the sort untouched
  (shift+click still builds multi-column sort).
- **Any mousedown inside a frame** raises it to the top of the z-order.
  The top frame gets an accent border; within it, the last-clicked tab
  group's selected tab is raised in the selected-tab color, while
  selected tabs of other groups (and of unfocused frames) flatten to the
  idle tab color — the raised tab marks the bar keyboard hotkeys act on.

## Configs

mkui's runtime input is JSON. When the backend is mkio, add `config_dir`
to your `server.toml` and point your HTML at `/config/client.json` — mkio
reads `client.toml` from that directory and serves it as JSON. The browser
never needs a TOML parser. For other backends, author or generate
`client.json` directly.

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
Setting the state value to `null` (or empty string `""`) removes the inline
override, reverting to the stylesheet default. Empty string is treated as
null to support TOML configs, which have no null literal.

## mkio connection state

When `config.mkio.url` is set, `<mkui-app>` automatically connects to the
mkio server and verifies its identity. Connection is two-phase:

1. **Connect** — WebSocket opens, `mkio.connected` becomes `true`, and the
   `connected` state map is applied immediately.
2. **Verify** — an async `_mkio` request confirms the server is a genuine
   mkio server and optionally checks its name, version, and protocol against
   expectations declared in `config.mkio.expect`. On success `mkio.verified`
   becomes `true`; on failure the `incompatible` state map is applied.
   Verification re-runs on every reconnect.

```json
"mkio": {
  "url": "ws://localhost:8080/ws",
  "expect": {
    "name": "order-book",
    "version": "1.0",
    "protocol": "1.0",
    "mkio": "0.2",
    "expr": "1"
  },
  "connected":    { "status.message": "Connected", "status.background": null },
  "incompatible": { "status.message": "Wrong server", "status.background": "#cc0000" },
  "disconnected": { "status.message": "Disconnected", "status.background": "#858585" }
}
```

The `expect` keys are all optional. `name` and `expr` (the expression
language version — mkui vendors version `1`) are checked by exact match;
`version`, `protocol`, and `mkio` use semver-compatible matching (delegated
to the server's `_mkio` service). When `expect` is absent, the `_mkio`
query still runs to confirm it is an mkio server and to populate
`mkio.server.*` state paths (name, version, protocol, mkio).

The `_mkio` request has a configurable timeout (`config.mkio.timeout`,
default 5000 ms) — non-mkio servers that don't respond are detected as
incompatible.

State maps default to `{ "status.message": "Connected" }`,
`{ "status.message": "Disconnected" }`, and
`{ "status.message": "Incompatible server" }`. Combine with
`statusbar.bindStyle` to change the statusbar appearance on disconnect or
server mismatch.

## Authentication

When `config.auth` is present, a login dialog gates the app — no frames
appear until the user authenticates. Three modes:

1. **mkio built-in** (`method: "mkio"`) — calls `client.auth()` against
   mkio's `_mkio_users` table. Config-only, no code needed.
2. **Custom** (`method: "custom"`) — register a handler with
   `app.registerAuthHandler({ authenticate({username, password}) })`.
3. **Disabled** — omit the `auth` section entirely.

```json
"auth": {
  "method": "mkio",
  "connected":    { "status.message": "Connected", "status.background": null },
  "disconnected": { "status.message": "Disconnected", "status.background": "#858585" }
}
```

The login dialog is unclosable (no close button). After login,
`auth.authenticated`, `auth.user`, and `auth.role` state paths are set.
The built-in `auth.logout` action reloads the page.

mkio's scaffold creates default users: `admin`/`password` (admin role)
and `user`/`password` (user role). Customize the dialog labels with
`auth.dialog`: `title`, `usernameLabel`, `passwordLabel`, `submitLabel`.

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
| `windows` | boolean | `true` expands into one `pane.show` entry per open pane |
| `shortcut` | string | Right-aligned shortcut hint, e.g. `"mod+C"` — `mod` renders as ⌘ on Apple platforms and Ctrl elsewhere (display only; handlers accept either modifier everywhere) |

Any item with an `items` array is a submenu; submenus nest arbitrarily.
Leaf items (no `items`) fire `action` on click via `app.fireAction()`.

**Built-in actions:** `app.quit`, `pane.show` (takes a pane ID as
`args` — switches to that pane's tab and raises its frame, or opens a
new frame if the pane is parked/closed), `window.tileH`, `window.tileV`,
`window.grid`, `window.cascade`, `edit.copy`, `edit.selectAll` (the last
two route to the focused frame's active pane — the same path the
Ctrl/Cmd+C and Ctrl/Cmd+A shortcuts take), and `table.filter` (`args =
{ pane = "<id>", filters = { col = <filter> }, merge = false }` sets a
table's column filters from a menu — same shapes as the pane's `filters`
key; omit `pane` for the focused pane). Register custom actions with
`app.registerAction(name, fn)`.

A typical Edit menu:

```json
{ "label": "Edit", "items": [
  { "label": "Copy", "action": "edit.copy", "shortcut": "mod+C" },
  { "sep": true },
  { "label": "Select All", "action": "edit.selectAll", "shortcut": "mod+A" }
]}
```

A typical Window menu lists the arrangement commands first, then the
open windows dynamically:

```json
{ "label": "Window", "items": [
  { "label": "Cascade", "action": "window.cascade" },
  { "sep": true },
  { "windows": true }
]}
```

`{ "windows": true }` expands — every time the menu opens — into one
entry per pane currently hosted in a frame, labeled with the pane's
title. Selecting an entry raises the frame that contains the pane and
switches to its tab (dialogs and other noDock frames are excluded).
Static `pane.show` entries are still useful for reopening panes whose
frame has been closed.

Tabs can be renamed in place: ctrl+click (or cmd+click on macOS) a tab,
edit the title, and press Enter (Escape cancels). The new title is
stored on the pane spec, so tab bars and the Window menu both reflect
it.

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
        "--mkui-tab-active": "#0e4d5e",
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
<mkui-app config="/mkui/client.json"></mkui-app>
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
  - `mkio-table` — subscribes to an mkio service (query, subpub, or stream) and renders a live-updating table with flash animations for inserts, deletes, and field changes. Row identity is per-protocol: query uses `_mkio_row`, stream uses `_mkio_ref`, subpub uses `_mkio_topic`. Column headers render immediately when `columns` is configured; optional `labels` maps column keys to display text (e.g. `{ "ts": "Timestamp" }`). Rows are **virtualized** — only the slice overlapping the viewport exists in the DOM, so scrolling, window moves, and window resizes stay fast into the millions of rows. Columns are fully interactive: click a header to sort (shift+click adds secondary sort keys), the hamburger button opens a per-column filter dropdown with search and value checkboxes — the filter remembers what you meant rather than what was listed: untick values (or Select all, then untick) to hide just those and let everything else through, including values that arrive later via live inserts, updates, or the next stream page; Clear, then tick values to show only those, with anything new staying hidden — numeric columns and columns of timestamps (mkio refs, ISO-8601 dates/date-times, or `HH:MM[:SS]` clock times) add a **Range** mode with From/To bounds (native date/time pickers for time columns, plus Today / Last hour / Last 15 min presets that keep moving with the clock) and an *include empty* toggle; other date formats aren't guessed — declare them with `types = { col = { type = "time", parse = "%d/%m/%Y %H:%M" } }` (or `unit = "ms"` for epoch numbers, `tz = "local"` for naive local timestamps). **Default filters** come from config: `filters = { status = { exclude = ["cancelled"] }, qty = { from = 100, to = 500 }, ts = { preset = "1h" } }` seeds the same filters before any data arrives (a bare list `["open", "new"]` means *only those*; `from`/`to` bounds make a number range when they are numbers and a time range when they are strings such as `"2026-03-01"` or `"2026-03-01 09:30"`, a date covering its whole day; `empty = true` lets blank values through; `preset` is `today`, `1h`, or `15m`), and reopening the pane restores them. The same shape drives the programmatic API — `workspace.setPaneFilters(id, filters, { merge })` / `getPaneFilters(id)` — and the `table.filter` menu action — when a column is sorted, that button's icon becomes the sort caret (still opening the filter dropdown, and showing the sort priority as a digit knocked out of the caret under multi-sort) — dragging a header reorders columns, and dragging the grip centered on a column divider resizes the column to its left — double-click the grip to auto-size the column to fit its content (capped at 80% of the viewport; with a selection active, all selected columns fit at once, so select-all + double-click fits the whole table). Column widths start at the header row's width and grow to fit records as they arrive (capped at 50% of the pane width, never shrinking, and never overriding a manual resize) — paging to another page never resizes them, and they don't change when the window resizes — extra pane width flows into a filler column that extends the header row to the pane's right edge, and subtle dividers separate the columns. Columns whose values are all numeric right-align with each value padded so decimal points line up down the column, in the cells and in the filter dropdown's value list alike. Subscriptions are deferred until the pane is first visible, unsubscribed immediately when the frame is closed, and dropped after 5 minutes of being hidden (e.g. inactive tab) — brief tab switches preserve the live connection. Large query snapshots render progressively in chunked batches to avoid freezing the UI. Stream tables support time-anchored paged navigation with a toolbar showing `◀ Earlier | time range | Later ▶ | ● Live | ⟳`. By default, the initial fetch starts from local midnight (`start: "today"`); `start: ""` starts from the beginning of the buffer. The toolbar displays the time range of visible rows in the browser's local timezone with adaptive precision — `HH:MM` down to nanoseconds in 3-digit increments depending on how close the boundary timestamps are; cross-day ranges include the date. Boundary indicators (`(start)`, `(end)`, `(all)`) show when you've reached the edges of the dataset. The `⟳` button re-fetches the current page. Navigation is ref-based (each page fetches relative to the first or last row's `_mkio_ref`), with `before: true` for backward fetches, so pages stay correct even when records are added or deleted mid-session. When navigating backward yields no data, the previous page is automatically restored and the Earlier button is disabled. A toggleable "Live" button switches to real-time streaming from the current page's last ref; in live mode, clicking Earlier uses a separate subscription to fetch and prepend historical pages without interrupting the live stream (toolbar shows `HH:mm – Live`). Live streams follow the tail like a terminal: entering live jumps to the newest row, and while the viewport is parked at the bottom, arriving rows keep scrolling into view — scroll up to inspect history and the viewport stays put. Set `live: true` to start in live mode: the start page loads first and then hands off to the live stream, so `start` is still honored rather than the whole buffer being replayed; exiting live returns to that start page, and reopening the pane re-arms it. Exiting live mode re-fetches the saved page from the server so that rows inserted or deleted during live mode are reflected. When the WebSocket disconnects while live mode is active, the toolbar shows "Disconnected" (or `HH:mm – Disconnected` with earlier pages) in muted text instead of the green blinking "Live" indicator — live mode stays active for seamless reconnect. Stream tables track the last received ref and use it on re-subscribe to avoid duplicate data transfer — existing rows are preserved and only new records are fetched. Query and subpub snapshots fully replace the table on each arrival, so records deleted on the server between disconnect and reconnect are properly removed. Tables are fully selectable, Excel-style: a sticky **row-number column** (disable with `rowColumn: false`) selects rows — click, ctrl/cmd-click to toggle, shift-click for ranges, drag for a range, or click the header corner to select all — while clicking a cell places the **focused cell** (accent outline; its whole row gets a subtle highlight so the record stays readable, distinct from the stronger row-selection tint). Drag across cells for a rectangle, ctrl/cmd-click to add or remove individual cells, shift-click or shift+arrows to extend; arrows/Home/End/PageUp/PageDown move the cursor, Space (or Shift+Space) selects the focused row, ctrl/cmd+Space toggles it, Ctrl/Cmd+A selects all visible rows, and Escape clears the selection. **Ctrl/Cmd+C copies** the selection to the OS clipboard in both TSV and HTML flavors, so pasting into Excel/Sheets preserves cell and row structure — row selections include a header row of column labels; cell selections copy values only, with blanks outside the selected rectangles; the copied cells pulse and the statusbar briefly shows "Copied N rows/cells" (via the `status.message` state path). Selection follows the filtered view (hidden rows are never selected or copied) and tracks records rather than positions: re-sorting moves the selection with its rows (rows that sort into the middle of a selected block don't join it), rows inserted live inside a selected range stay unselected, and members hidden by a filter rejoin the selection when the filter is relaxed. Table toolbar buttons can declare a selection `unit` (`"rows"` default, `"row"`, `"cells"`, `"cell"` — singular units imply exactly-one): row-unit buttons receive the rows containing the cell selection (or the focused cell) even when no row is explicitly selected, and cell-unit buttons get a `cells` array of `{ row, column, value }` in their action context. Set `select = { state = "<path>" }` to mirror the current row into app state as the selection moves, so a detail pane or chart can follow the table without any custom code; clearing the cursor publishes `null` (as do deleting that row and closing the pane), and a live update to that row republishes it. Set `values = { col = "<expr>" }` to derive a column with an expression over the row — the derived value is what the table renders, sorts, filters, and copies, and it may be a virtual column that no row carries (list it in `columns`). **Conditional styling** colors cells and rows from their values: `styles = { col = <styler> }` styles a cell, `rowStyle = <styler>` styles the whole row, where a styler is a rule array evaluated first-match-wins — each rule is `{ when = "<expr>", ...style keys }`, a rule without `when` being the fallback — or a single expression yielding a style map; style keys are `color`, `background`, `bold`, `italic`, `underline`, `strike`, custom `class`, and arbitrary `css`, and any string value may be a `${...}` template. Styled backgrounds blend with, rather than hide, the selection tint, and styles are recomputed on every live update. Toolbar buttons take `enable.when = "<expr>"` over the selected rows. **Display templates** (`display = { col = "${...}" }`) control presentation without touching the value the table sorts and filters by: `${NUM(value, digits: 2, group: TRUE)}` formats, and the `mkui` function library produces rich text — `BOLD`, `ITALIC`, `COLOR`, `MUTED`, `MONO`, `BADGE(x, color)`, `ICON(name)`, `BAR(frac, color)`, `LINK(x, url)`, `HEAT(v, lo, hi)` — which renders as styled spans in the cell, pastes into spreadsheets with its colors and weights intact, and flattens to plain text everywhere else; a template that errors shows `#ERR` with the message on hover.
- Dialogs:
  - `openDialog(spec, context, app, extra)` — config-driven modal dialog with typed fields (text, number, select, checkbox, textarea, readonly, hidden), validation, conditional visibility (`showWhen`), async service-backed options (`optionsFrom`), and RPC submission with error handling. The dialog floats as a non-docking frame whose title text doubles as a drag handle; if the rendered form is taller than the initial frame, the frame grows to fit it (capped at 90% of the workspace) and re-centers. A **pin button** (SVG pin icon) in the titlebar keeps the dialog open after successful submission — when active, the pin rotates 45° counterclockwise with a smooth transition; the form resets to defaults only after the server confirms success; errors leave the form intact for retry.
- Custom pane types are the primary extensibility surface. Register with
  `registerPaneType(name, factory)`; reference from config as `type = "<name>"`.
- Everything conditional or derived in config is written in the [mkio
  expression language](#expressions) — derived columns (`values`), styling
  rules (`styles` / `rowStyle`), button enablement (`enable.when`), dialog
  field visibility (`showWhen`), and `${...}` templates in titles, notes,
  action payloads, and statusbar text. Applications extend it with
  `registerExprFunction(name, fn)`; there is no separate formatter or styler
  registry.

## Expressions

mkui evaluates the same expression language as mkio — `lib/expr.js` is
mkio's `mkio-expr.js`, vendored verbatim — so a condition reads identically
whether it is a server-side `where`, a client `filter` sent to the server,
or a styling rule in `client.toml`. The grammar, operators, and standard
library are documented in [mkio's README](../mkio/README.md#expression-language);
in short: `&& || !`, `== != < <= > >=`, `??`, arithmetic, `[...]`/`{k: v}`
literals, `a.b[0]` access, `F(x, name: v)` calls (`IF`, `CASE`, `LET`,
`NUM`, `DATE`, `MAP`, `SUM`, …), lambdas `x -> …`, and pipes
`value |> (x -> …)`. Strings in config may embed expressions as `${...}`
templates.

mkui evaluates leniently: an unknown name is `NULL` rather than an error
(rows and forms are heterogeneous), and an expression that fails logs one
warning and yields nothing, so a typo degrades a cell or a rule instead of
the pane. Each surface supplies its own scope:

| Surface | Scope (bare names resolve to) |
|---|---|
| `values.<col>`, `styles.<col>`, `display.<col>` | `value` (the cell's value — raw for `values`, derived for `styles`/`display`), `row`, `col`, `state`, then the row's fields by name |
| `rowStyle` | `row`, `state`, then the row's fields |
| `enable.when` | `rows` (the rows the selection implies), `row` (the first), `cells`, `selection` (`count`, `rowCount`, `cellCount`, `unit`), `connected`, `state` |
| dialog `showWhen`, field `value`, `title`, `footer.note` | the form's fields by name, `form`, plus the opening context (`row`, `rows`, `cell`, `cells`, `selection`, `state`) |
| action `data`, `dialogService.data`, `rowData` | `row`, `rows`, `cell`, `cells`, `selection`, `state` (raw row fields — never derived values) |
| statusbar / text widget `text` | `state` — the widget re-renders when any `state.<path>` it reads changes |

```toml
[panes.orders]
type = "mkio-table"
columns = ["id", "side", "symbol", "qty", "price", "notional", "status"]
values  = { notional = "ROUND(qty * price, 2)" }
styles  = { side = [ { when = "value == 'Buy'", color = "#4caf50" }, { color = "#e05252" } ],
            qty  = [ { background = "${IF(value > 5000, '#3a2f1b', '')}" } ] }
rowStyle = [ { when = "notional >= 50000 && side == 'Sell'", bold = true } ]
display = { notional = "${NUM(value, digits: 2, group: TRUE)}",
            side     = "${BADGE(value, IF(value == 'Buy', 'green', 'red'))}",
            status   = "${ICON(IF(value == 'filled', 'check', 'clock'))} ${TITLE(value)}",
            fill     = "${BAR(row.filled / qty, '#4caf50')} ${row.filled}/${qty}" }

[[panes.orders.buttons]]
label  = "Fill"
enable = { connected = true, when = "LEN(rows) > 0 && ALL(rows, r -> r.status == 'pending')" }
action = { type = "transaction", service = "orders", op = "fill", data = { id = "${row.id}" } }

[statusbar]
left = [{ type = "text", text = "${state.auth.user ?? 'anonymous'} · ${state.status.message}" }]
```

Extend from JavaScript with the same hooks mkio offers in Python:

```js
import { registerExprFunction, registerExprLibrary, registerExprType } from "/mkui/src/index.js";
registerExprFunction("SPREAD_BPS", (bid, ask) => ((ask - bid) / ask) * 1e4, { numeric: true, params: ["bid", "ask"] });
// client.toml:  values = { spread = "SPREAD_BPS(bid, ask)" }
```

## Quick start

```
pip install mkui mkio
mkui init myapp
mkui serve myapp
# http://localhost:8080/
```

`mkui init` scaffolds a complete project:

```
myapp/
  server.toml          ← mkio server config (schema, services, routes)
  config/
    client.toml        ← mkui app config (panes, menus, layout)
  static/
    index.html         ← entry point
```

`mkui serve` starts an [mkio](https://pypi.org/project/mkio/) server that
handles static files, config serving (TOML→JSON), the WebSocket endpoint,
and the mkio client JS — all from one process, one port.

## Installation

```
pip install mkui mkio
```

### CLI

```
mkui init [dir]               # scaffold a new project (default: .)
mkui serve [dir] [-p PORT]    # serve with mkio backend (default port from server.toml)
mkui --version
```

`serve` reads `server.toml` in the project directory, resolves the
`<mkui.static_dir>` placeholder to the installed package path, and
delegates to `mkio.create_app()`. The `--port` flag overrides the
port in `server.toml`.

### Library usage

For custom backends (no mkio), serve the static assets directly:

```python
import mkui

# With FastAPI / Starlette:
from starlette.staticfiles import StaticFiles
app.mount("/mkui", StaticFiles(directory=mkui.static_dir))
```

## Running the examples

The standalone and library examples need only a static file server:

```
cd mkui/static
python3 -m http.server 8000
# http://localhost:8000/examples/standalone-json/
# http://localhost:8000/examples/library-js/
```

The mkio-table example requires [mkio](https://pypi.org/project/mkio/):

```
cd mkui/static/examples/mkio-table
mkio serve          # starts on port 8080 (configured in server.toml)
python seed.py      # (optional) populates sample orders in a loop
# http://localhost:8080/
```

## Project layout

```
mkui/                    Python package (pip install mkui)
  __init__.py            Exposes static_dir path and version
  __main__.py            CLI: init + serve commands
  static/
    src/
      core.js            State store, registries, App class
      index.js           Side-effect entry point
      layout/
        tree.js          Normalized tree math
        drag.js          clampToDock, snap, dropZoneFor, frac↔rect
      lib/
        expr.js          mkio's expression language (vendored from mkio, kept in sync by tests)
        expressions.js   mkui's lenient environment, ${...} templates, state-path analysis
        rich.js          rich cell text: the `rich` type, the mkui UI function library, renderers
        icons.js         SVG icon library (vendored Lucide paths)
      components/
        app.js           <mkui-app> — the shell
        menubar.js       <mkui-menubar>
        statusbar.js     <mkui-statusbar>
        workspace.js     <mkui-workspace> — frame list, arrangement, snap
        frame.js         <mkui-frame> + <mkui-pane>
      widgets/
        text.js  button.js  mkio-table.js  mkui-dialog.js
      auth.js            Config-driven login dialog
      mkio-bridge.js     Lazy-loads mkio's /mkio.js client
    styles/mkui.css      Default theme (CSS custom properties)
    examples/
      standalone-json/   Loaded from a static config
      library-js/        Built imperatively from JS
      mkio-table/        Live table backed by mkio query/subpub services
                         (config-only derived columns, styling rules, and
                         enable conditions; static/app.js registers an
                         expression function and the order-detail pane)
pyproject.toml           Python build config
tests/
  layout.test.js         Layout tree unit tests (node:test)
  state.test.js          State + connection lifecycle tests (node:test)
  table.test.js          mkio-table pane tests (node:test)
  dialog.test.js         Dialog expression + submission tests (node:test)
  auth.test.js           Authentication module + state lifecycle tests (node:test)
  expressions.test.js    Expression conformance fixtures + mkui wrapper tests (node:test)
  vendor-sync.test.js    lib/expr.js and expr_cases.json match the installed mkio (node:test)
  rich.test.js           Rich text type, mkui function library, clipboard HTML (node:test)
  styles.test.js         mkui.css layout invariants (node:test)
  test_cli.py            CLI init/serve tests (unittest)
```
