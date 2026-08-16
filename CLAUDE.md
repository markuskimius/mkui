# CLAUDE.md

## Project overview

mkui is a config-driven, zero-dependency web GUI framework built with Web Components. It provides a floating-frame workspace with dockable panes, proportional resize, and viewport clamping. Designed to pair with [mkio](../mkio) as the backend, but works standalone.

## Architecture

- **Workspace** (`<mkui-workspace>`) holds a z-ordered list of floating **frames**
- **Frames** (`<mkui-frame>`) are top-level chrome with 8-way resize handles; each owns an internal normalized layout tree. There is no dedicated titlebar — every top-edge tab bar doubles as a drag region, and the right-most one carries the window controls
- **Panes** (`<mkui-pane>`) are leaf content hosts inside frames; always wrapped in a TabGroup (structural invariant)
- Pane elements are pooled at the workspace level with stable identity — `appendChild` moves them between frames preserving state
- Frame positions stored as fractions of the workspace; split ratios sum to 1 — proportional resize is automatic. Frame rects are *painted* in whole pixels (`applyFrameRect` rounds edges, not width/height, so snapped frames stay flush): the frame's internal layout measures its body via integer `clientWidth`/`clientHeight`, and a fractional frame size would leave a sub-pixel sliver of frame background at the bottom/right edge — visible as a hairline under a pane's horizontal scrollbar
- Every frame move/resize passes through `clampToDock` — nothing escapes the viewport
- Keyboard focus model: the top frame gets `[data-focused]` (set by `_applyZOrder`); each frame tracks an `_activeTabGroup` updated on interaction with a tab or within a pane — clicking a tab bar's empty area (right of the tabs / drag region) raises the frame without changing the group. Hotkeys act on that frame + group.
- Tab drag: pointer events (mouse + touch) on tabs. Dragging within a bar shows a ghost label locked to the bar's Y axis with an accent drop indicator; reorder commits on release. Dragging outside the bar tears the pane out into a new frame. `touch-action: none` on `.mkui-tab` prevents scroll interference. On noDock frames (dialogs, login) the tab is titlebar text: mousedown moves the frame, click activates the tab; CSS must keep these tabs pointer-interactive (`cursor: move`, never `pointer-events: none`) — guarded by the pointer-guards and styles tests.
- Tab overflow: tabs shrink to fit down to `min-width: 3em` (content-box, so 3em of label stays visible). When the strip still overflows, `.mkui-tabs` hides the overflow (no scrollbar) and scroll arrows (`.mkui-tab-scroll`, ‹ ›) appear on either side — the bar gets `.mkui-tabbar-overflow`, toggled by `updateArrows` in `_renderTabBar`, which also disables each arrow at its end. An arrow click scrolls ~60% of the visible strip; drag-to-reorder and tear-out are unchanged. After each render, `_renderTabBar` scrolls the active tab back into view (rebuild resets scrollLeft). The strip always shows at least one tab: `.mkui-tabs` has `min-width: 76px`, the drag region's minimum drops to 12px while overflowing, and the frame resize floor (180px) covers arrows + one tab + grab area + window controls.
- Tab rename: ctrl+click or cmd+click on a tab swaps the label for an inline text input (`.mkui-tab-rename`). Enter/blur commits via `workspace.renamePane(id, title)` (updates the pane spec's `title`, so tab bars and the Window menu pick it up); Escape cancels. Trigger paths: `pointerdown` with `ctrlKey || metaKey` and button 0, plus `contextmenu` with `ctrlKey` (macOS delivers ctrl+click as a context-menu gesture). Meta+click is unreliable on Windows/Linux, so ctrl is the cross-platform trigger and cmd the macOS-native one.
- Tab strip look: tabs are flush shapes (no side gaps) with rounded top corners and outward-curving bottom flares — quarter-circle radial-gradient notches in the tab's `::after`, colored by the `--mkui-tab-bg` custom property so they always match the body. The bar's bottom line is a `.mkui-tabbar::after` overlay (never a border): idle tabs sit under it, the selected tab gets `z-index: 1` and covers it — that line break is the selection mark. Selected tab color is `--mkui-tab-active` (themeable); idle tabs use `--mkui-bg`; thin `::before` dividers separate flush idle tabs and are suppressed around the active/hovered tab. Selected tabs outside the keyboard-focused group (unfocused frame, or unfocused group in the focused frame) flatten to the idle color with a muted label. Guarded by `tests/styles.test.js`.
- Theming: `dark` and `light` are styled by `mkui.css` via `[theme=...]`. Custom themes go in `config.app.themes[name]` as `{ "--mkui-*": value }` overrides; `MkuiApp.setTheme(name)` applies them as inline styles on the host.

## Key files

- `mkui/__init__.py` — Python package; exposes `static_dir` and `__version__`
- `mkui/__main__.py` — CLI (`mkui init`, `mkui serve`); scaffold templates, mkio `create_app` integration
- `mkui/static/src/layout/tree.js` — normalized tree math (normalize, find, insert, remove, layout), no DOM
- `mkui/static/src/layout/drag.js` — clamp, snap, drop-zone, frac↔rect helpers, no DOM
- `mkui/static/src/components/workspace.js` — frame lifecycle, z-order, arrangement commands, inter-frame drag routing, snap
- `mkui/static/src/components/frame.js` — frame chrome, internal tree rendering, splitter drag; also defines `<mkui-pane>`
- `mkui/static/src/components/app.js` — shell: menubar + workspace + statusbar
- `mkui/static/src/core.js` — `App`, `State` (reactive store), widget/pane-type/formatter/styler registries
- `mkui/static/src/lib/icons.js` — SVG icon library: `icon(name)` returns a currentColor `<svg>` from vendored path data (Lucide outlines + custom filled carets/dot/hamburger); sized per context via `.mkui-icon` CSS rules
- `mkui/static/src/lib/copy.js` — clipboard grid serialization: `gridToTSV` (CRLF rows, Excel quoting) and `gridToHTML`, pure functions covered by `tests/copy.test.js`
- `mkui/static/src/widgets/mkio-table.js` — built-in `mkio-table` pane type: subscribes to mkio services, renders live tables
- `mkui/static/src/widgets/mkui-dialog.js` — `openDialog()`: config-driven modal dialogs with validation, RPC submission, and pin-to-keep-open
- `mkui/static/src/auth.js` — config-driven login dialog; `showLogin()` authenticates before the app loads
- `mkui/static/src/mkio-bridge.js` — lazy-loads mkio's `/mkio.js` client from the server origin
- `mkui/static/styles/mkui.css` — default theme via CSS custom properties

## Commands

- `mkui init [dir]` — scaffold a new project (server.toml + config/client.toml + static/index.html)
- `mkui serve [dir] [-p PORT]` — serve a project using mkio's server API
- `node --test tests/*.test.js` — run JS unit tests (node:test, no deps needed)
- `python -m pytest tests/test_cli.py` — run CLI tests (unittest)
- `python -m build && twine upload dist/*` — build and publish to PyPI
- `cd mkui/static && python3 -m http.server 8000` — serve examples locally (standalone/library only)
- Examples at `mkui/static/examples/standalone-json/`, `mkui/static/examples/library-js/`, and `mkui/static/examples/mkio-table/`

## CLI architecture

`mkui init` runs `mkio init --no-static` to generate `server.toml` (ensuring it stays in sync with mkio), then appends `[static]` and `[config]` routing sections, and creates mkui-specific files (`static/index.html`, `config/client.toml`).

`mkui serve` loads `server.toml`, resolves the `<mkui.static_dir>` placeholder to the installed package path, and delegates to `mkio.create_app()`. mkio's server handles all routing: static files, TOML→JSON config, `/mkio.js`, and the WebSocket endpoint.

## Config format

Runtime input is JSON. `mkui serve` uses mkio's `[config]` routing — requests for `/config/client.json` are served from `config/client.toml` (parsed with `tomllib`). The browser never needs a TOML parser. TOML configs use empty string `""` where JSON would use `null` (TOML has no null literal).

Top-level keys: `app`, `state`, `auth` (optional), `menubar`, `statusbar`, `panes` (id→spec), `frames` (ordered array with position + layout tree), `mkio` (optional).

## Menubar

`menubar` is a top-level array. Each element has `label` (dropdown name) and `items` (array of menu items).

Item keys:
- `label` — display text
- `action` — action name fired on click (leaf items only)
- `args` — optional argument passed to action handler
- `items` — child array; presence makes it a nested submenu (opens on hover, nests arbitrarily)
- `sep` — `true` renders a separator line
- `windows` — `true` expands into one `pane.show` leaf per open pane (title from the pane spec); popups rebuild on each open so the list stays live. noDock frames are excluded; source is `workspace.openPanes()`.
- `shortcut` — right-aligned hint on leaf items (`.mkui-menu-shortcut`, muted, guarded by `tests/styles.test.js`). The `mod` token renders platform-native via `formatShortcut` — `⌘C` on Apple platforms, `Ctrl+C` elsewhere. Display only: handlers accept either modifier everywhere.

Leaf items fire `app.fireAction(action, args)` on mouseup. Built-in actions: `app.quit`, `pane.show` (takes pane ID — switches to its tab and raises the frame, or opens a new frame if parked), `window.tileH`, `window.tileV`, `window.grid`, `window.cascade`, `edit.copy`, `edit.selectAll`. Custom actions registered with `app.registerAction(name, fn)`.

Edit routing: `edit.copy`/`edit.selectAll` call `workspace.editAction(name)`, which resolves the focused frame's active tab group's active pane (`workspace.activePaneEl()`) and invokes its `_editActions` hook (`{ copy, selectAll, clearSelection }` — any pane type can implement it; mkio-table does). The workspace's window keydown handler routes Ctrl/Cmd+C, Ctrl/Cmd+A, and Escape through the same hook, with guards: INPUT/TEXTAREA/contentEditable events are ignored, a non-collapsed native text selection wins over table copy, and `preventDefault` fires only when a pane actually handled the action. Covered by `tests/edit-routing.test.js`.

## Statusbar

`statusbar` config keys: `left` (widget array), `right` (widget array), `bindStyle` (optional object mapping CSS property names to state paths). `bindStyle` subscribes to each state path and applies the value as an inline style on `<mkui-statusbar>`. Setting a state value to `null` or empty string `""` removes the inline override (reverts to stylesheet default).

## mkio connection state

When `config.mkio.url` is present, `<mkui-app>` calls `ensureMkio` with `onConnect`/`onDisconnect` callbacks **before** setting up menubar, workspace, and statusbar. This ordering is load-bearing: pane factories also call `ensureMkio` and the bridge caches the first caller's promise, so the app's call must come first for its lifecycle callbacks to register. The bridge passes the `client` as the callbacks' first argument.

Connection is two-phase: **connect** then **verify**. On WebSocket open, `mkio.connected` is set `true` and the `config.mkio.connected` state map applies immediately; an async `_mkio` reqrep then queries the server's identity (name, version, protocol version, mkio version). Pass sets `mkio.verified` `true`; fail leaves it `false` and applies the `config.mkio.incompatible` state map (overwriting the connected map). Verification re-runs on reconnect.

The optional `config.mkio.expect` object declares expected server identity: `name` (exact match), `version`, `protocol`, `mkio` (semver-compatible, checked server-side). When `expect` is absent, the `_mkio` query still runs to confirm an mkio server and populate `mkio.server.*`. The request times out per `config.mkio.timeout` (default 5000ms) — non-mkio servers that don't respond are detected as incompatible.

State maps: `config.mkio.connected`, `config.mkio.disconnected`, and `config.mkio.incompatible` are objects of `"state.path": value` entries applied on each lifecycle event. Defaults: `{ "status.message": "Connected" }` / `{ "status.message": "Disconnected" }` / `{ "status.message": "Incompatible server" }`. Combine with `statusbar.bindStyle` for visual feedback.

State paths set by the connection lifecycle: `mkio.connected` (boolean, WebSocket open), `mkio.verified` (boolean, passed `_mkio` verification), `mkio.server.name` / `.version` / `.protocol` / `.mkio` (server identity).

## Authentication

When `config.auth` is present, `<mkui-app>` shows a login dialog before loading frames. The workspace initializes empty; frames are created only after successful authentication (no flash of unauthorized content).

Three flavors:

1. **mkio built-in** (`method: "mkio"`) — config-only. Calls `client.auth({username, password})` against mkio's `_mkio_users` table. Default seed users: `admin`/`password` (admin role), `user`/`password` (user role).
2. **Custom backend** (`method: "custom"`) — register a handler with `app.registerAuthHandler({ authenticate({username, password}) })` before the app loads. The handler returns `{ user, role }`.
3. **No auth** — omit the `[auth]` section entirely. The app loads directly with no login prompt.

Config keys (under `auth`):
- `method` — `"mkio"` (default) or `"custom"`
- `dialog` — optional object: `title`, `width`, `usernameLabel`, `passwordLabel`, `submitLabel` to customize the login dialog
- `connected` — state map applied after successful authentication and on reconnect (e.g. `{ "status.message": "Connected" }`)
- `disconnected` — state map applied on WebSocket disconnect when auth is enabled (falls back to `mkio.disconnected`)

State paths set by auth: `auth.authenticated` (boolean, true after login), `auth.user` (username), `auth.role` (role).

Built-in action: `auth.logout` — reloads the page (clears auth state).

When auth is enabled, `_mkio` server verification is skipped — authentication itself proves the server. The `mkio.connected` state map still applies on WebSocket connect (clearing the "Connecting..." styling); `auth.connected` applies after login and on reconnect when already authenticated.

Login dialog: floating frame (`stayOnTop`, `noDock`) with `_hideClose = true` and `_extraControls = () => []` so it can't be dismissed. Fields reuse `mkui-dialog-*` CSS classes; empty fields get `mkui-dialog-invalid` red borders; failed auth shows the error and clears the password field.

Reconnect: mkio's client stores `_authData` and auto-re-authenticates. The `onConnect` handler checks `auth.authenticated` — true (reconnect) applies `auth.connected`; false (initial connect before login) applies `mkio.connected`.

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
- `start` — initial position for stream paged mode: `"today"` (default) starts from local midnight, `""` starts from beginning of buffer
- `live` — `true` starts stream paged mode in live mode; see Paging
- `rowColumn` — `false` hides the row-number selection column (default `true`; the `table.test.js` harness passes `false` so long-standing assertions can index cells directly)
- `formatters` — object mapping column names to registered formatter names (e.g. `{ "summary": "fixSummary" }`); see Column formatters
- `styles` — object mapping column names to a styler (registered name or declarative rule array) that styles the cell from its value; `rowStyle` — one styler for the whole row, conditioned on any of its columns; see Conditional styling
- `select` — `{ state = "<path>" }` mirrors the current row into app state; see Selection publishing

When `columns` is pre-configured, the header row renders immediately at init (before any data arrives). When `columns` is omitted, headers render on first data row. Labels are used in both the header row and the column drag ghost.

Row identity: query uses `_mkio_row`, stream uses `_mkio_ref`, subpub uses `_mkio_topic`. All `_mkio_*` columns are hidden from display.

Column formatters: `formatters = { col = "name" }` routes a column through a function registered with `registerFormatter(name, fn)`, called as `(value, row, col)` where `value` is `row[col]`. Every place the table reads a column value — rendering, updates, numeric/width stats, sorting, filter values and matching, clipboard copy — goes through one `cellValue` accessor, so a formatted column behaves like a real field everywhere. A formatter may also invent a **virtual column** that no row carries (`(_v, row) => ...`); list it in `columns` explicitly, since inference only sees keys present on the data. Button action payloads deliberately bypass formatters and carry raw row fields. An unregistered formatter name falls back to the raw value and warns once per name.

Conditional styling: `styles = { col = <styler> }` styles a cell from its value; `rowStyle = <styler>` styles the whole `tr`. A styler is the name of a function registered with `registerStyler(name, fn)` — cell form `(value, row, col) => style`, row form `(row) => style` — or a config-only rule array evaluated first-match-wins. A rule mixes condition keys (`eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `in` = array, `match` = regex; none = always matches, so a bare last rule is the fallback; row rules use `when = { col = <cond> }` — plain value = eq, array = in, object = operators, all listed columns must match) with style keys `color`, `background`, `bold`, `italic`, `underline`, `strike`, `class` (user CSS classes), `css` (extra inline properties). Conditions and styler `value` args test `cellValue` — the formatted value. Styles apply in `buildRow` and are fully recomputed on replace (`restyleRowStylers` — one column can flip another cell's or the row's style); `applyStyle` clears what the previous style set (tracked on `el._mkuiStyle`). Backgrounds are never inline: they ride `--mkui-cell-bg`/`--mkui-row-bg` custom properties plus `mkui-cell-styled`/`mkui-row-styled` marker classes, base rules placed *before* the selection rules so selection tints win, with `color-mix` blends where both apply — guarded by `tests/styles.test.js`. An unregistered styler name warns once and applies nothing.

Selection publishing: `select = { state = "path" }` writes the current row object into app state at that path whenever the selection changes, so a detail pane or chart can follow the table. The current row is the cursor's row, else the first selected row in view order, else `null` — so a full reset (new query/subpub snapshot, page fetch, pane reopen), a delete of the published row, and closing the pane all publish `null`, while Escape keeps the cursor and therefore the published row. Filter changes republish after pruning; sorting does not. A live update replacing the published row republishes the new object. Writes are deduped on row identity, and without `select` the table never writes app state (beyond the copy toast).

Numeric alignment: columns whose every non-empty value is numeric are right-aligned with per-cell right padding (`--mkui-num-pad`, in ch — exact in the mono table font) so decimal points line up: pad = column's widest fraction minus the cell's (`colStats` tracks `numeric`/`maxFrac`). `maxFrac` is a one-way ratchet reset on data clear; when it grows (or a non-numeric value flips the column to text), rendered cells restyle. The filter dropdown decimal-aligns too: value spans get the mono font and a left pad of (max integer width − this value's) since they're left-anchored next to their checkboxes. Guarded by `tests/styles.test.js`.

Animations: inserts flash blue and fade in, deletes flash red and fade out, field updates flash blue on the changed cell. CSS classes: `mkui-flash-in`, `mkui-flash-out`, `mkui-flash-update`.

Each pane instance gets a unique `subid` for multiplexing multiple subscriptions to the same service on one WebSocket.

Selection: two mutually exclusive modes plus an always-present **focused cell** (the keyboard cursor, accent inset outline via `.mkui-cell-focus`). Row mode: a sticky-left **row-number column** (`rowColumn: false` to disable; numbered by view position, excluded from column stats/reorder/resize, counted in the vspacer colspan) selects rows — click / ctrl-toggle / shift-range / drag-range on the numbers, header corner cell selects all; selected rows use the strong `.mkui-selected` tint. Cell mode: clicking a cell places the focus (its row gets the subtle `.mkui-row-hl` wash — visually distinct from selection, guarded by `tests/styles.test.js`); drag extends a rectangle, ctrl/cmd-click adds rects or toggles single cells off, shift-click/shift+arrow extends the active rect from its anchor. Cell rects are stored as anchor/focus `(key, col)` pairs plus a `keys` snapshot of the rows spanned when the rect was last user-modified (`snapRectKeys`) — membership is that record set × the column range, so sorts/filters move the same records around instead of reinterpreting the span, live inserts inside the span don't join, and filtered-out members rejoin when the filter is relaxed; resolution is lazy (`rectBounds` maps member keys to contiguous view-index runs, cached per view+selection revision; last-known indices anchor extension after a delete). The focused cell is the *implicit* selection: copy and row-unit buttons fall back to it. Starting either mode clears the other. Keyboard (scroll host has `tabindex=0`, `.mkui-table-keys`): arrows move focus (collapsing selection), shift+arrows extend (rows in row mode, rect otherwise), Home/End jump columns (ctrl adds row extremes), PageUp/PageDown jump a viewport, Space selects the focused row (ctrl+Space toggles), Escape clears selection but keeps the cursor; the first arrow press only places the cursor. The viewport follows the focused cell: `scrollFocusIntoView` does a coarse rowH-based scroll, renders, then corrects by the focused row's measured overshoot, plus a horizontal pass keeping the focused column clear of the sticky row-number edge. Selection follows the filtered view: filter changes prune `selectedKeys`, and copy/actions/select-all only ever see view rows. Native text selection is disabled on `.mkui-table` (`user-select: none`).

Clipboard: `copySelection` builds a grid — row mode: selected rows × visible columns in `displayOrder` plus a `labels` header row; cell mode: bounding grid with blanks outside the rects; fallback: the focused cell — and writes both `text/plain` TSV and `text/html` flavors via `ClipboardItem` (serialization in `lib/copy.js`; `writeText` fallback; grids over 100k rows skip the HTML flavor to halve peak memory). Triggered by Ctrl/Cmd+C or `edit.copy` through the pane's `_editActions` hook (see Menubar → Edit routing). Copy feedback: the copied rows/cells pulse (`mkui-flash-copy` — its keyframes declare no end frame so the pulse fades to each element's own resting background; an explicit transparent end frame would read as a double flash on selected rows) and `status.message` briefly shows "Copied N rows/cells" (or "Copy failed"), reverting after 2s — the revert is skipped if something else wrote the path in the meantime, and back-to-back copies restore the original pre-copy message.

Buttons: toolbar buttons may declare `unit` (top-level or under `enable`): `"rows"` (default), `"row"`, `"cells"`, `"cell"` — singular units default `minSelected`/`maxSelected` to 1. Row units count/receive the rows implied by the selection (explicit rows, else rows containing selected cells, else the focused cell's row — so plain cell clicks keep row-unit buttons working). Cell units count selected cells (capped enumeration for enablement) and get `cells: [{ row, column, value }]` plus `cell` in the action context; cell-unit transactions send one request per selected cell. `selection` in the context carries `{ count, rowCount, cellCount, unit }`.

Sorting: click a column header to cycle ascending → descending → none; shift+click adds secondary sort keys. Multi-sort priority is a digit knocked out *inside* the 16px caret (`.mkui-sort-num`, painted in the header background color, offset toward the triangle's wide base per direction; on hover it tracks the filter button's pill background). Numeric vs string comparison is auto-detected. New rows insert at the correct sorted position; sort state persists across resubscribes. Guarded by `tests/styles.test.js`.

Filtering: each column header has one icon slot — the filter button, pinned to the cell's right edge (`.mkui-th-label` is `flex: 1`). It shows a filled hamburger (`icon("filter")`, three solid bars matching the sort carets' weight and x-extent) until the column is sorted, when `updateHeaderState` swaps in the sort caret (wrapped in `.mkui-sort-indicator` inside the button). Either icon opens the same panel — search input, "Select all"/"Clear", a checkbox per unique value — right-aligned under the button (left-aligning would push it past a wide column). Changes apply immediately, an active filter tints the icon accent, columns filter independently, and filter state persists across resubscribes.

Virtualized rows: only the rows overlapping the viewport (plus 10 overscan each side) exist as DOM elements; two `.mkui-vspacer` rows (top/bottom of tbody) carry the height of everything else, so scrolling, pane resizes, and frame moves are O(visible) regardless of row count (~40 `tr`s — designed for a million rows). Data lives in a `rows` Map plus a `baseOrder` keys array; `view` is the filtered+sorted keys array that drives rendering. `render()` reconciles the visible slice into the tbody between the spacers, reusing keyed `tr`s (`rowEls` holds only rendered rows) and leaving in-place rows untouched so running flash animations aren't restarted. Inserts/deletes/replaces do incremental `view` surgery (binary search when sorted); sort/filter changes mark the view dirty for a full rebuild. Renders trigger on data change, scroll (sync, unchanged-slice early-exit), pane resize (`ResizeObserver`), and pane visibility. Row height is the *pitch* between the first two rendered rows when possible (border-collapse makes a single row's rect read ~0.5px short, an error that compounds with row index), falling back to one row's rect height.

Column widths: as soon as the header row exists (init when `columns` is configured, else first data), each header is measured under `width: max-content` and locked via `<colgroup>` + `table-layout: fixed`, capped at 50% of the pane; a 0 measurement (pane not laid out yet) retries on data and visibility events. From there columns only grow: `bumpStats` canvas-measures every ingested value in the table font and `growColWidth` ratchets up to fit — numeric columns to max-integer + max-fraction so decimals align, text to the widest string — half-pane capped, flushed to the colgroup once per render (`widthsDirty`). Auto-grow never shrinks and skips manually resized columns (`userSized`). Widths never react to pane/window resizes: the table keeps `width: 100%` with no inline width, so under fixed layout the used width is max(pane, sum of `<col>` widths) — data columns keep their exact widths and a trailing auto-width filler (`.mkui-th-filler` + widthless `<col>`) absorbs the remainder, extending the header row across the pane. Two invariants guard this in `tests/styles.test.js`: `.mkui-table-fixed` must not declare `width`/`min-width` (a pixel width pins the distribution there for good, leaving the filler at 0), and the vspacer `colspan` must equal the real column count (phantom columns swallow the leftover; `renderHead` keeps it in sync). Columns are separated by 1px half-alpha `--mkui-border` dividers (`color-mix`, also guarded); overflowing text ellipsizes (`.mkui-th-label` spans truncate while the sort/filter buttons stay visible). Each divider carries a `.mkui-col-resizer` grip (7px hit zone) resizing the column to its left (40px min); it sits on the left edge of the *following* header cell (the filler carries the last column's) so the overhang stays clickable — header cells must not be `overflow: hidden` (clipping lives on `td` and `.mkui-th-inner`). Widths are keyed by column name in `colWidths`, surviving reorder, resubscribe, and paging-mode switches; pane reopen resets them. A resize drag first syncs stored widths to rendered widths, so a drag before measurement starts from what's on screen. Double-clicking a grip auto-sizes its column to fit — the wider of the widest ingested value (`colStats`) and the header label + icon, capped at 80% of the viewport (not auto-grow's half-pane cap) — and clears `userSized` so auto-grow resumes; when the column is inside the current selection (row mode spans all columns, so Ctrl+A / corner select-all count; cell mode uses the rects' column ranges), every selected column is fitted at once.

Column reorder: drag a column header to move it. Uses pointer events for unified mouse and touch support (5px movement threshold distinguishes drag from click). A ghost label and accent-colored drop indicator show the target position. Reorder state persists across resubscribes via a `displayOrder` array separate from the data-derived `columns`.

Paging (query): when `maxcount` is set (default 200), the subscription uses mkio's paged snapshot protocol — the client accumulates every page and fires `onSnapshot` once. `applySnapshot` ingests rows in `requestAnimationFrame`-batched chunks (≥100 per frame, scaled so any snapshot finishes within ~50 frames) so the UI never freezes, showing "Loading N / Total…" while it runs; only the visible slice reaches the DOM (see Virtualized rows). A generation counter cancels stale chunk loops when a new snapshot arrives.

Paging (stream): when `maxcount` is set (default 200), the table enters paged mode with a toolbar showing `◀ Earlier | time range | Later ▶ | ● Live | ⟳`. The initial fetch starts from local midnight (`start: "today"`, converted to UTC for the ref) or the beginning of the buffer (`start: ""`). The range label shows the visible rows' timestamps in the browser's local timezone with adaptive precision — `HH:MM`, `HH:MM:SS` when the endpoints share a minute, then sub-second in 3-digit steps (ms, µs, ns) when they share a second; cross-day ranges add the date; `No data` when empty — plus a boundary suffix: `(start)`, `(end)`, or `(all)` when the whole dataset fits one page.

Navigation is ref-based with no cursor stack: each page is its own `subscribe` via `fetchPage(ref, before)` with `onPage` — Later passes `lastRef` (last row's `_mkio_ref`), Earlier passes `firstRef` with `before: true` — so pages stay correct as records are added or deleted mid-session. Edge cases: starting from midnight leaves Earlier enabled on the first page (data may precede it); an empty initial fetch sets `firstRef` to the requested start ref so Earlier still works; an empty backward fetch restores the previous page from `prevPageLoadRef`/`prevPageLoadBefore` and disables Earlier via a `noPrev` flag (which keeps that re-fetch's `onPage` from setting `pageHasPrev`). `⟳` re-fetches the current page from `pageLoadRef`/`pageLoadBefore`; disabled in live mode.

`● Live` toggles live streaming, resuming on the main `subid` from the page's `lastRef` so only records after the displayed page transfer. In live mode Later is disabled and Earlier fetches through a separate `pageSubId` (`fetchPrevLive`), prepending rows before `tbody.firstChild` without interrupting the stream (`pageFetchPending` blocks double-clicks; `hasEarlierPages` drives the `HH:mm – Live` label). Exiting live unsubscribes both subids and re-fetches the saved page — coordinates only, no row snapshot — so inserts and deletes during live mode are reflected. Sort, filter, and column order persist across mode switches; a visibility re-show reloads the same saved page; pane reopen recalculates midnight for the current day (handles overnight running).

Tail following: live streams (paged live mode, and non-paged streams — live from the start) read like a terminal. Each subscription callback samples `shouldFollowTail()` *before* ingesting (stream + live, viewport within 8px of the bottom) and calls `scrollToTail()` after; otherwise `maybeRestoreScroll` runs as before. `goLive` sets `tailPending` to force one jump regardless of scroll position; a viewport scrolled up to inspect history is never moved. Query/subpub never follow.

`live: true` starts in live mode, but still fetches the start page first and hands off from its `onPage` (`autoLivePending` — consumed on the first page so exiting live stays exited, re-armed on pane reopen). Going live straight from `sub()` would ignore `start`, replay the whole buffer, and leave `savedPageState` unset so exiting live had no page to return to. An empty start page leaves `lastRef` null, which `sub()` also reads as "from the beginning", so the handoff seeds it from `getStartRef()` (still null under `start: ""`, where the beginning is intended).

Disconnected indicator: the table subscribes to `mkio.connected`. When the socket drops while live mode is active, the toolbar shows "Disconnected" (or `HH:mm – Disconnected` with earlier pages) in muted text instead of the green blinking Live dot; live mode itself stays on so the saved page coordinates survive the reconnect. The subscription must be declared *after* all paging variables (`liveMode`, `pageHasPrev`, …) — `State.subscribe` fires its initial callback synchronously and would otherwise hit a temporal dead zone.

Visibility-aware subscriptions: an `IntersectionObserver` on the pane content element gates the subscription — a pane that starts hidden doesn't subscribe until first shown, and a pane hidden for 5 minutes drops its subscription (cancelled if it reappears first). On frame close the workspace dispatches `mkui-pane-close`: the handler sets `closed`, disconnects the observer, and calls `client.unsubscribe(subid)` unconditionally (bypassing the `subscribed` guard, so the server always hears it); `closed` then blocks `sub()` and `fetchPage()`. Reopening a parked pane dispatches `mkui-pane-open`: it clears `closed`, drops stale rows/sort/filter/paging state (including `lastRef`), and re-observes, triggering a fresh subscription. In stream paged mode, hidden/shown transitions under 5 minutes preserve the current page without re-fetching.

Stream ref-based resume: the table tracks `firstRef`/`lastRef` from `_mkio_ref`. `lastRef` advances on every snapshot, delta, update callback, and `fetchPage` completion; `firstRef` on `fetchPage` completion. `sub()` with a non-null `lastRef` passes `ref: lastRef` and preserves existing rows/DOM, so the server resends nothing; with a null `lastRef` (first subscription) it clears state and subscribes from the beginning. Both reset to null on pane reopen, where a fresh start is intended. `goLive` preserves `lastRef` so live resumes at the current page; `exitLive` re-fetches the page, which sets fresh refs. Query and subpub never set `lastRef` — a re-subscribe after timeout clears state and takes a fresh snapshot.

Snapshot clearing: for query and subpub, `applySnapshot` unconditionally clears all rows, DOM elements, and selection before rendering — the mkio client's auto-reconnect fires `onSnapshot` straight through the existing subscription callbacks, bypassing the table's `sub()`/`unsub()` cycle, so rows deleted server-side during the outage would otherwise linger. Stream preserves existing rows: a resumed snapshot holds only records after `lastRef` and must append.

## Dialogs

`openDialog(spec, context, app, extra)` creates a modal dialog as a floating frame (`stayOnTop`, `noDock`). Returns a Promise that resolves with the form data on successful submit, or `null` on cancel/close.

Field types: `hidden`, `readonly`, `select`, `checkbox`, `textarea`, `number`, text (default). Fields support `required`, `pattern`, `min`/`max`/`step` validation, `showWhen` conditional visibility, `optionsFrom` (async service-backed options), and `optionsFromColumn` (values from table data).

Layout: fields are listed in `spec.fields`. Items can be `{ group: "Header" }` for section headers, `{ row: [field, field] }` for horizontal layout, or plain field objects. `field.width` sets flex proportion in rows. The initial frame height is a guess; after the fields render, a body that would scroll grows the frame by the overflow (capped at 90% of the workspace) and re-centers it vertically — skipped when the workspace rect has zero height.

Submission: when `spec.submit.service` is set, the dialog sends form data via `client.send()` with a configurable timeout (default 5s). `submitPerRow` mode sends one request per selected row. Transaction errors are shown inline and the form stays open for retry. Without a service, the dialog resolves immediately with form data.

Pin button: an SVG pin-icon toggle (`icon("pin")`) in the dialog's titlebar, before maximize/close; active = rotated 45° counterclockwise and accent-colored. While pinned, successful submission resets the form to defaults instead of closing — reset only after the server confirms success; errors leave the form intact for retry. Injected via `frameEl._extraControls`, a callback `_makeControls()` in frame.js calls to prepend custom elements before the window controls; `_makeControls` runs on every `_renderInternal`, so the callback re-creates the button each render, with `pinned` held in a closure shared with the submit handler.

## Conventions

- Zero runtime dependencies; Web Components for framework-agnostic use
- Pointer guards: every mousedown/pointerdown that opens a menu or starts an action/drag checks `ev.button === 0` (menubar open + item activation, frame resize handles, splitters, drag region, tabs — pane drag on normal frames, frame move on noDock — table selection/column resize/reorder) — right/middle clicks are inert. Exception: the frame-raise mousedown is deliberately unguarded (any-button raise, OS convention). Modified clicks are inert where the modifier has no meaning: table sort headers ignore ctrl/cmd/alt (shift keeps multi-sort), the select-all corner ignores all modifiers. Guarded by `tests/pointer-guards.test.js` and `tests/table.test.js`
- Icons are inline SVGs from `lib/icons.js` (`icon(name)`), never text glyphs — they inherit color via `currentColor` and are sized per context by `.mkui-icon` CSS rules. `.mkui-icon` keeps `pointer-events: none` so hit-testing lands on the hosting button (guarded by `tests/styles.test.js`)
- `registerPaneType(name, factory)` for custom content; `registerWidget(name, factory)` for lightweight inline widgets
- Built-in actions prefixed `pane.*` (show), `window.*` (tileH, tileV, grid, cascade), and `app.*` (quit)
- Layout tree invariant: every leaf sits inside a `{ type: "tabs", children: [...] }` — never bare strings after normalize
- CSS invariant: `mkui-menubar` and `mkui-statusbar` are `box-sizing: border-box` so their rendered height equals `--mkui-menubar-h`/`--mkui-statusbar-h` exactly — the workspace is positioned by those variables, and a 1px overhang paints over the border of frames snapped to the top/bottom edge (guarded by `tests/styles.test.js`)
- Tests use `node:test` + `node:assert/strict`; no test framework dependency
