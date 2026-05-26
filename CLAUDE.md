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

- `mkui/__init__.py` — Python package; exposes `static_dir` and `__version__`
- `mkui/__main__.py` — CLI (`mkui init`, `mkui serve`); scaffold templates, mkio `create_app` integration
- `mkui/static/src/layout/tree.js` — normalized tree math (normalize, find, insert, remove, layout), no DOM
- `mkui/static/src/layout/drag.js` — clamp, snap, drop-zone, frac↔rect helpers, no DOM
- `mkui/static/src/components/workspace.js` — frame lifecycle, z-order, arrangement commands, inter-frame drag routing, snap
- `mkui/static/src/components/frame.js` — frame chrome, internal tree rendering, splitter drag; also defines `<mkui-pane>`
- `mkui/static/src/components/app.js` — shell: menubar + workspace + statusbar
- `mkui/static/src/core.js` — `App`, `State` (reactive store), widget/pane-type registries
- `mkui/static/src/widgets/mkio-table.js` — built-in `mkio-table` pane type: subscribes to mkio services, renders live tables
- `mkui/static/src/widgets/mkui-dialog.js` — `openDialog()`: config-driven modal dialogs with validation, RPC submission, and pin-to-keep-open
- `mkui/static/src/mkio-bridge.js` — lazy-loads mkio's `/mkio.js` client from the server origin
- `mkui/static/styles/mkui.css` — default theme via CSS custom properties

## Commands

- `mkui init [dir]` — scaffold a new project (server.toml + config/client.toml + static/index.html)
- `mkui serve [dir] [-p PORT]` — serve a project using mkio's server API
- `node --test tests/layout.test.js tests/state.test.js tests/table.test.js tests/dialog.test.js` — run JS unit tests (node:test, no deps needed)
- `python -m pytest tests/test_cli.py` — run CLI tests (unittest)
- `python -m build && twine upload dist/*` — build and publish to PyPI
- `cd mkui/static && python3 -m http.server 8000` — serve examples locally (standalone/library only)
- Examples at `mkui/static/examples/standalone-json/`, `mkui/static/examples/library-js/`, and `mkui/static/examples/mkio-table/`

## CLI architecture

`mkui init` runs `mkio init --no-static` to generate `server.toml` (ensuring it stays in sync with mkio), then appends `[static]` and `[config]` routing sections, and creates mkui-specific files (`static/index.html`, `config/client.toml`).

`mkui serve` loads `server.toml`, resolves the `<mkui.static_dir>` placeholder to the installed package path, and delegates to `mkio.create_app()`. mkio's server handles all routing: static files, TOML→JSON config, `/mkio.js`, and the WebSocket endpoint.

## Config format

Runtime input is JSON. `mkui serve` uses mkio's `[config]` routing — requests for `/config/client.json` are served from `config/client.toml` (parsed with `tomllib`). The browser never needs a TOML parser. TOML configs use empty string `""` where JSON would use `null` (TOML has no null literal).

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

`statusbar` config keys: `left` (widget array), `right` (widget array), `bindStyle` (optional object mapping CSS property names to state paths). `bindStyle` subscribes to each state path and applies the value as an inline style on `<mkui-statusbar>`. Setting a state value to `null` or empty string `""` removes the inline override (reverts to stylesheet default).

## mkio connection state

When `config.mkio.url` is present, `<mkui-app>` calls `ensureMkio` with `onConnect`/`onDisconnect` callbacks **before** setting up menubar, workspace, and statusbar components. This ordering is load-bearing: pane factories (e.g., `mkio-table`) also call `ensureMkio`, and the bridge caches the first caller's promise — so the app's call must come first to ensure lifecycle callbacks are registered. The bridge wraps user callbacks to pass the `client` as the first argument, enabling verification logic in the callbacks.

Connection is two-phase: **connect** then **verify**. When the WebSocket opens, `mkio.connected` is set to `true` and the `config.mkio.connected` state map is applied immediately. Then an async `_mkio` reqrep request queries the server's identity (name, version, protocol version, mkio version). If verification passes, `mkio.verified` is set to `true`. If it fails, `mkio.verified` stays `false` and the `config.mkio.incompatible` state map is applied (overwriting the connected state map). On reconnect, verification re-runs automatically.

The optional `config.mkio.expect` object declares expected server identity. Keys: `name` (exact string match), `version`, `protocol`, `mkio` (all semver-compatible, checked server-side). When `expect` is absent, the `_mkio` query still runs to confirm it is an mkio server and populate `mkio.server.*` state paths. The `_mkio` request has a configurable timeout (`config.mkio.timeout`, default 5000ms) — non-mkio servers that don't respond are detected as incompatible.

State maps: `config.mkio.connected`, `config.mkio.disconnected`, and `config.mkio.incompatible` are objects of `"state.path": value` entries applied on each lifecycle event. Defaults: `{ "status.message": "Connected" }` / `{ "status.message": "Disconnected" }` / `{ "status.message": "Incompatible server" }`. Combine with `statusbar.bindStyle` for visual feedback.

State paths set by the connection lifecycle:
- `mkio.connected` — boolean, WebSocket is open
- `mkio.verified` — boolean, server passed `_mkio` verification
- `mkio.server.name` — server's application name
- `mkio.server.version` — server's application version
- `mkio.server.protocol` — server's protocol version
- `mkio.server.mkio` — server's mkio package version

## mkio-table pane type

Built-in pane type that subscribes to an mkio service and renders a live-updating table.

Config keys (under `panes.<id>`):
- `type` = `"mkio-table"` (required)
- `service` — mkio service name to subscribe to (required)
- `protocol` — `"query"` (default), `"subpub"`, or `"stream"`
- `topic` — string or array of strings; required for subpub (one subscription per topic if array)
- `filter` — mkio filter expression (query only)
- `columns` — array of column names to display; defaults to all keys from the first row
- `labels` — object mapping column names to display labels (e.g. `{ "ts": "Timestamp" }`); defaults to the column name
- `maxcount` — page size for paged subscriptions (default 200, `null` to disable)

When `columns` is pre-configured, the header row renders immediately at init (before any data arrives). When `columns` is omitted, headers render on first data row. Labels are used in both the header row and the column drag ghost.

Row identity: query uses `_mkio_row`, stream uses `_mkio_ref`, subpub uses `_mkio_topic`. All `_mkio_*` columns are hidden from display.

Animations: inserts flash blue and fade in, deletes flash red and fade out, field updates flash blue on the changed cell. CSS classes: `mkui-flash-in`, `mkui-flash-out`, `mkui-flash-update`.

Each pane instance gets a unique `subid` for multiplexing multiple subscriptions to the same service on one WebSocket.

Sorting: click a column header to cycle ascending → descending → none. Shift+click adds secondary sort keys for multi-column sort; priority shown with superscript numbers (▲¹ ▼²). Auto-detects numeric vs string comparison. New rows insert at the correct sorted position; sort state persists across resubscribes.

Filtering: each column header has a ▾ dropdown button. Click to open a filter panel with a search input, "Select all"/"Clear" links, and checkboxes for each unique value. Changes apply immediately. Active filters show the ▾ in accent color. Multiple columns can be filtered independently. Filter state persists across resubscribes.

Column reorder: drag a column header to move it. Uses pointer events for unified mouse and touch support (5px movement threshold distinguishes drag from click). A ghost label and accent-colored drop indicator show the target position. Reorder state persists across resubscribes via a `displayOrder` array separate from the data-derived `columns`.

Paging (query): when `maxcount` is set (default 200), the subscription uses mkio's paged snapshot protocol. The mkio client accumulates all pages transparently and fires `onSnapshot` once. `applySnapshot` then renders rows in `requestAnimationFrame`-batched chunks of 100 to avoid freezing the UI on large datasets. A progress indicator ("Loading N / Total…") is shown during chunked rendering. A generation counter cancels stale chunk loops when a new snapshot arrives.

Paging (stream): when `maxcount` is set (default 200), the table enters paged mode with a toolbar showing `◀ Prev | Page N | Next ▶ | ● Live`. Each page is a separate `subscribe` call with `onPage` (disables the mkio client's auto-paging). A `pageRefs` stack of cursor values enables backward navigation. The `● Live` button toggles live streaming mode — when active (accent-colored), prev/next are disabled and the table subscribes for live updates; clicking it again exits live mode and returns to page 1.

Visibility-aware subscriptions: an `IntersectionObserver` on the pane content element detects visibility changes. Panes that start hidden (inactive tab) do not subscribe until first shown. When a pane becomes hidden (tab switch, park), a 5-minute timer starts; if still hidden when it fires, the subscription is dropped. If the pane reappears before the timer fires, the timer is cancelled and the subscription stays alive. When a frame is closed, the workspace dispatches a `mkui-pane-close` event on each pane element; the close handler sets a `closed` flag, disconnects the `IntersectionObserver`, and unconditionally calls `client.unsubscribe(subid)` (bypassing the `subscribed` guard to ensure the server always receives the unsubscribe). The `closed` flag prevents `sub()` and `loadPage()` from re-subscribing after close. When a parked pane is reopened via `showPane()`, the workspace dispatches `mkui-pane-open`; the open handler resets `closed`, clears stale rows/sort/filter/paging state (including `lastRef`), and re-observes with the `IntersectionObserver`, which triggers a fresh subscription. In stream paged mode, brief hidden/shown transitions (under 5 minutes) preserve the current page without re-fetching.

Stream ref-based resume: for stream protocol, the table tracks a `lastRef` from the `_mkio_ref` field of the last received row (updated on every snapshot, delta, and update callback). When `sub()` is called with a non-null `lastRef`, it passes `ref: lastRef` to `client.subscribe()` and preserves existing rows/DOM — the server sends only records after the ref, avoiding duplicate re-transfer. When `lastRef` is null (first subscription), `sub()` clears state and subscribes from the beginning as before. `lastRef` is explicitly reset to null on mode switches (`goLive`, `exitLive`) and pane reopen (`mkui-pane-open`), where a fresh start is intended. For query and subpub protocols, `lastRef` is never set — re-subscribe after timeout clears state and fetches a fresh snapshot.

## Dialogs

`openDialog(spec, context, app, extra)` creates a modal dialog as a floating frame (`stayOnTop`, `noDock`). Returns a Promise that resolves with the form data on successful submit, or `null` on cancel/close.

Field types: `hidden`, `readonly`, `select`, `checkbox`, `textarea`, `number`, text (default). Fields support `required`, `pattern`, `min`/`max`/`step` validation, `showWhen` conditional visibility, `optionsFrom` (async service-backed options), and `optionsFromColumn` (values from table data).

Layout: fields are listed in `spec.fields`. Items can be `{ group: "Header" }` for section headers, `{ row: [field, field] }` for horizontal layout, or plain field objects. `field.width` sets flex proportion in rows.

Submission: when `spec.submit.service` is set, the dialog sends form data via `client.send()` with a configurable timeout (default 5s). `submitPerRow` mode sends one request per selected row. Transaction errors are shown inline and the form stays open for retry. Without a service, the dialog resolves immediately with form data.

Pin button: a 📌 toggle in the dialog's titlebar (frame controls area, before maximize/close). When active (accent-colored), successful submission resets the form to its default values instead of closing the dialog. The form is only reset after the server confirms success — errors leave the form intact for retry. The pin button is injected via `frameEl._extraControls`, a callback that `_makeControls()` in frame.js calls to prepend custom elements before the standard window controls. Since `_makeControls` runs on every `_renderInternal`, the callback re-creates the button each render; the `pinned` state is held in a closure shared with the submit handler.

## Conventions

- Zero runtime dependencies; Web Components for framework-agnostic use
- `registerPaneType(name, factory)` for custom content; `registerWidget(name, factory)` for lightweight inline widgets
- Built-in actions prefixed `pane.*` (show), `window.*` (tileH, tileV, grid, cascade), and `app.*` (quit)
- Layout tree invariant: every leaf sits inside a `{ type: "tabs", children: [...] }` — never bare strings after normalize
- Tests use `node:test` + `node:assert/strict`; no test framework dependency
