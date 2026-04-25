# CLAUDE.md

## Project overview

mkui is a config-driven, zero-dependency web GUI framework built with Web Components. It provides a floating-frame workspace with dockable panes, proportional resize, and viewport clamping. Designed to pair with [mkio](../mkio) as the backend, but works standalone.

## Architecture

- **Workspace** (`<mkui-workspace>`) holds a z-ordered list of floating **frames**
- **Frames** (`<mkui-frame>`) are top-level chrome with 8-way resize handles; each owns an internal normalized layout tree. There is no dedicated titlebar — every top-edge tab bar doubles as a drag region, and the right-most one carries the window controls
- **Panes** (`<mkui-pane>`) are leaf content hosts inside frames; always wrapped in a TabGroup (structural invariant)
- Pane elements are pooled at the workspace level with stable identity — `appendChild` moves them between frames preserving state
- Frame positions stored as fractions of the workspace; split ratios sum to 1 — proportional resize is automatic
- Every frame move/resize passes through `clampToDock` — nothing escapes the viewport
- Keyboard focus model: the top frame gets `[data-focused]` (set by `_applyZOrder`); each frame tracks an `_activeTabGroup` updated on any interaction within a tab bar or pane. Hotkeys act on that frame + group.
- Tab drag: pointer events (mouse + touch) on tabs. Dragging within a bar shows a ghost label locked to the bar's Y axis with an accent drop indicator; reorder commits on release. Dragging outside the bar tears the pane out into a new frame. `touch-action: none` on `.mkui-tab` prevents scroll interference.
- Theming: `dark` and `light` are styled by `mkui.css` via `[theme=...]`. Custom themes go in `config.app.themes[name]` as `{ "--mkui-*": value }` overrides; `MkuiApp.setTheme(name)` applies them as inline styles on the host.

## Key files

- `mkui/__init__.py` — Python package; exposes `static_dir` for serving assets
- `mkui/static/src/layout/tree.js` — normalized tree math (normalize, find, insert, remove, layout), no DOM
- `mkui/static/src/layout/drag.js` — clamp, snap, drop-zone, frac↔rect helpers, no DOM
- `mkui/static/src/components/workspace.js` — frame lifecycle, z-order, arrangement commands, inter-frame drag routing, snap
- `mkui/static/src/components/frame.js` — frame chrome, internal tree rendering, splitter drag; also defines `<mkui-pane>`
- `mkui/static/src/components/app.js` — shell: menubar + workspace + statusbar
- `mkui/static/src/core.js` — `App`, `State` (reactive store), widget/pane-type registries
- `mkui/static/src/widgets/mkio-table.js` — built-in `mkio-table` pane type: subscribes to mkio services, renders live tables
- `mkui/static/src/mkio-bridge.js` — lazy-loads mkio's `/mkio.js` client from the server origin
- `mkui/static/styles/mkui.css` — default theme via CSS custom properties

## Commands

- `cd mkui/static && python3 -m http.server 8000` — serve examples locally
- `node --test tests/layout.test.js tests/state.test.js` — run unit tests (node:test, no deps needed)
- `python -m build && twine upload dist/*` — build and publish to PyPI
- Examples at `mkui/static/examples/standalone-json/`, `mkui/static/examples/library-js/`, and `mkui/static/examples/mkio-table/`

## Config format

Runtime input is JSON. TOML is parsed server-side by mkio (Python `tomllib`); the browser never needs a TOML parser.

Top-level keys: `app`, `state`, `menubar`, `statusbar`, `panes` (id→spec), `frames` (ordered array with position + layout tree), `mkio` (optional).

## Menubar

`menubar` is a top-level array. Each element has `label` (dropdown name) and `items` (array of menu items).

Item keys:
- `label` — display text
- `action` — action name fired on click (leaf items only)
- `args` — optional argument passed to action handler
- `items` — child array; presence makes it a nested submenu (opens on hover, nests arbitrarily)
- `sep` — `true` renders a separator line

Leaf items fire `app.fireAction(action, args)` on mouseup. Built-in actions: `app.quit`, `pane.show` (takes pane ID — switches to its tab and raises the frame, or opens a new frame if parked), `window.tileH`, `window.tileV`, `window.grid`, `window.cascade`. Custom actions registered with `app.registerAction(name, fn)`.

## Statusbar

`statusbar` config keys: `left` (widget array), `right` (widget array), `bindStyle` (optional object mapping CSS property names to state paths). `bindStyle` subscribes to each state path and applies the value as an inline style on `<mkui-statusbar>`. Setting a state value to `null` removes the inline override (reverts to stylesheet default).

## mkio connection state

When `config.mkio.url` is present, `<mkui-app>` calls `ensureMkio` with `onConnect`/`onDisconnect` callbacks **before** setting up menubar, workspace, and statusbar components. This ordering is load-bearing: pane factories (e.g., `mkio-table`) also call `ensureMkio`, and the bridge caches the first caller's promise — so the app's call must come first to ensure lifecycle callbacks are registered. The bridge also explicitly fires `onConnect` after the initial `client.connect()` resolves, since `MkioClient` may only fire it on reconnections.

The optional `config.mkio.connected` and `config.mkio.disconnected` are state maps (object of `"state.path": value` entries) applied on each lifecycle event. Defaults: `{ "status.message": "Connected" }` / `{ "status.message": "Disconnected" }`. Combine with `statusbar.bindStyle` for visual feedback (e.g., changing statusbar background on disconnect).

## mkio-table pane type

Built-in pane type that subscribes to an mkio service and renders a live-updating table.

Config keys (under `panes.<id>`):
- `type` = `"mkio-table"` (required)
- `service` — mkio service name to subscribe to (required)
- `protocol` — `"query"` (default), `"subpub"`, or `"stream"`
- `topic` — string or array of strings; required for subpub (one subscription per topic if array)
- `filter` — mkio filter expression (query only)
- `columns` — array of column names to display; defaults to all keys from the first row

Row identity: query uses `_mkio_row`, subpub uses `_mkio_topic`. All `_mkio_*` columns are hidden from display.

Animations: inserts flash blue and fade in, deletes flash red and fade out, field updates flash blue on the changed cell. CSS classes: `mkui-flash-in`, `mkui-flash-out`, `mkui-flash-update`.

Each pane instance gets a unique `subid` for multiplexing multiple subscriptions to the same service on one WebSocket.

Sorting: click a column header to cycle ascending → descending → none. Shift+click adds secondary sort keys for multi-column sort; priority shown with superscript numbers (▲¹ ▼²). Auto-detects numeric vs string comparison. New rows insert at the correct sorted position; sort state persists across resubscribes.

Filtering: each column header has a ▾ dropdown button. Click to open a filter panel with a search input, "Select all"/"Clear" links, and checkboxes for each unique value. Changes apply immediately. Active filters show the ▾ in accent color. Multiple columns can be filtered independently. Filter state persists across resubscribes.

Column reorder: drag a column header to move it. Uses pointer events for unified mouse and touch support (5px movement threshold distinguishes drag from click). A ghost label and accent-colored drop indicator show the target position. Reorder state persists across resubscribes via a `displayOrder` array separate from the data-derived `columns`.

Visibility-aware subscriptions: an `IntersectionObserver` on the pane content element detects when the pane becomes hidden (tab switch, frame close/park) and calls `client.unsubscribe(subid)`. When the pane reappears the subscription is re-established — table state is cleared first so the fresh server snapshot populates a clean table.

## Conventions

- Zero runtime dependencies; Web Components for framework-agnostic use
- `registerPaneType(name, factory)` for custom content; `registerWidget(name, factory)` for lightweight inline widgets
- Built-in actions prefixed `pane.*` (show), `window.*` (tileH, tileV, grid, cascade), and `app.*` (quit)
- Layout tree invariant: every leaf sits inside a `{ type: "tabs", children: [...] }` — never bare strings after normalize
- Tests use `node:test` + `node:assert/strict`; no test framework dependency
