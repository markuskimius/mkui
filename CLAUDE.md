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
- Tab drag: pointer events (mouse + touch) on tabs. Dragging within a bar shows a ghost label locked to the bar's Y axis with an accent drop indicator; reorder commits on release. Dragging outside the bar tears the pane out into a new frame. `touch-action: none` on `.mkui-tab` prevents scroll interference.
- Tab overflow: tabs shrink to fit down to `min-width: 3em` (content-box, so 3em of label stays visible). When the strip still overflows, `.mkui-tabs` hides the overflow (no scrollbar) and scroll arrows (`.mkui-tab-scroll`, ‹ ›) appear on either side of the strip — the bar gets `.mkui-tabbar-overflow`, toggled by `updateArrows` in `_renderTabBar`, which also disables each arrow at its end of the strip. Clicking an arrow scrolls by ~60% of the visible strip (smooth). Drag-to-reorder and tear-out are unchanged by overflow. After each render, `_renderTabBar` scrolls the active tab back into view (rebuild resets scrollLeft). The strip always shows at least one tab: `.mkui-tabs` has `min-width: 76px` (one min tab + strip padding), the drag region's minimum drops to 12px while overflowing, and the frame resize floor (180px) covers arrows + one tab + grab area + window controls.
- Tab rename: ctrl+click or cmd+click on a tab swaps the label for an inline text input (`.mkui-tab-rename`). Enter/blur commits via `workspace.renamePane(id, title)` (updates the pane spec's `title`, so tab bars and the Window menu pick it up); Escape cancels. Trigger paths: `pointerdown` with `ctrlKey || metaKey` and button 0, plus `contextmenu` with `ctrlKey` (macOS delivers ctrl+click as a context-menu gesture). Meta+click is unreliable on Windows/Linux (Start menu / window-manager grabs), so ctrl is the cross-platform trigger and cmd the macOS-native one.
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
- `mkui/static/src/core.js` — `App`, `State` (reactive store), widget/pane-type registries
- `mkui/static/src/lib/icons.js` — SVG icon library: `icon(name)` returns a currentColor `<svg>` built from vendored path data (Lucide outlines + custom filled carets/dot/hamburger) — no icon font, no external fetch; sized per context via `.mkui-icon` CSS rules
- `mkui/static/src/lib/copy.js` — clipboard grid serialization: `gridToTSV` (CRLF rows, Excel quoting) and `gridToHTML` (`<table>` flavor), pure functions covered by `tests/copy.test.js`
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
- `windows` — `true` expands into one `pane.show` leaf per currently-open pane (title from the pane spec), so a Window menu can list open windows dynamically. Popups are rebuilt on each open, keeping the list live. noDock frames (dialogs, login) are excluded; the list comes from `workspace.openPanes()`.
- `shortcut` — right-aligned shortcut hint on leaf items (`.mkui-menu-shortcut`, muted, guarded by `tests/styles.test.js`). The `mod` token renders platform-native via `formatShortcut` in menubar.js — `⌘C` on Apple platforms, `Ctrl+C` elsewhere. Display only: handlers accept either modifier on every platform.

Leaf items fire `app.fireAction(action, args)` on mouseup. Built-in actions: `app.quit`, `pane.show` (takes pane ID — switches to its tab and raises the frame, or opens a new frame if parked), `window.tileH`, `window.tileV`, `window.grid`, `window.cascade`, `edit.copy`, `edit.selectAll`. Custom actions registered with `app.registerAction(name, fn)`.

Edit routing: `edit.copy`/`edit.selectAll` call `workspace.editAction(name)`, which resolves the focused frame's active tab group's active pane (`workspace.activePaneEl()`) and invokes its `_editActions` hook (`{ copy, selectAll, clearSelection }` — any pane type can implement it; mkio-table does). The workspace's window keydown handler routes Ctrl/Cmd+C, Ctrl/Cmd+A, and Escape through the same hook, with guards: events from INPUT/TEXTAREA/contentEditable are ignored, a non-collapsed native text selection wins over table copy, and `preventDefault` fires only when a pane actually handled the action (so the browser default survives everywhere else). Covered by `tests/edit-routing.test.js`.

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

## Authentication

When `config.auth` is present, `<mkui-app>` shows a login dialog before loading frames. The workspace is initialized empty (no frames), and frames are created only after successful authentication. This prevents any flash of unauthorized content.

Three flavors:

1. **mkio built-in** (`method: "mkio"`) — config-only. Calls `client.auth({username, password})` against mkio's `_mkio_users` table. Default seed users: `admin`/`password` (admin role), `user`/`password` (user role).
2. **Custom backend** (`method: "custom"`) — register a handler with `app.registerAuthHandler({ authenticate({username, password}) })` before the app loads. The handler returns `{ user, role }`.
3. **No auth** — omit the `[auth]` section entirely. The app loads directly with no login prompt.

Config keys (under `auth`):
- `method` — `"mkio"` (default) or `"custom"`
- `dialog` — optional object: `title`, `width`, `usernameLabel`, `passwordLabel`, `submitLabel` to customize the login dialog
- `connected` — state map applied after successful authentication and on reconnect (e.g. `{ "status.message": "Connected" }`)
- `disconnected` — state map applied on WebSocket disconnect when auth is enabled (falls back to `mkio.disconnected`)

State paths set by auth:
- `auth.authenticated` — boolean, true after successful login
- `auth.user` — username of the authenticated user
- `auth.role` — role of the authenticated user

Built-in action: `auth.logout` — reloads the page (clears auth state).

When auth is enabled, `_mkio` server verification is skipped — authentication itself proves the server is valid. The `mkio.connected` state map is still applied on WebSocket connect (to clear the "Connecting..." initial styling), and `auth.connected` is applied after login and on reconnect when already authenticated.

Login dialog: displayed as a floating frame (`stayOnTop`, `noDock`) with `_hideClose = true` (no close button) to prevent dismissal. The frame's `_extraControls` is set to `() => []` to remove any extra buttons. Username and password fields use existing `mkui-dialog-*` CSS classes. Empty field validation shows red borders via `mkui-dialog-invalid`. Failed auth shows the error in a status span and clears the password field.

Reconnect: mkio's client stores `_authData` and auto-re-authenticates on reconnect. The `onConnect` handler checks `auth.authenticated` — if already true (reconnect), it applies `auth.connected`; if false (initial connect before login), it applies `mkio.connected`.

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
- `rowColumn` — `false` hides the row-number selection column (default `true`; the `table.test.js` harness passes `false` so long-standing assertions can index cells directly)

When `columns` is pre-configured, the header row renders immediately at init (before any data arrives). When `columns` is omitted, headers render on first data row. Labels are used in both the header row and the column drag ghost.

Row identity: query uses `_mkio_row`, stream uses `_mkio_ref`, subpub uses `_mkio_topic`. All `_mkio_*` columns are hidden from display.

Numeric alignment: columns whose every non-empty value is numeric are right-aligned with per-cell right padding (`--mkui-num-pad`, in ch — exact in the monospace table font) so decimal points line up: pad = column's widest fraction minus the cell's (`colStats` tracks per-column `numeric`/`maxFrac`). `maxFrac` is a one-way ratchet reset on data clear; when it grows (or a non-numeric value flips the column to text), rendered cells of that column are restyled. The filter dropdown decimal-aligns numeric columns' values too: spans get the mono font and a left pad of (max integer width − this value's, in ch) since they're left-anchored next to their checkboxes. Guarded by `tests/styles.test.js`.

Animations: inserts flash blue and fade in, deletes flash red and fade out, field updates flash blue on the changed cell. CSS classes: `mkui-flash-in`, `mkui-flash-out`, `mkui-flash-update`.

Each pane instance gets a unique `subid` for multiplexing multiple subscriptions to the same service on one WebSocket.

Selection: two mutually exclusive modes plus an always-present **focused cell** (the keyboard cursor, accent inset outline via `.mkui-cell-focus`). Row mode: a sticky-left **row-number column** (`rowColumn: false` to disable, on by default; numbered by view position, excluded from column stats/reorder/resize, counted in the vspacer colspan) selects rows — click / ctrl-toggle / shift-range / drag-range on the numbers, header corner cell selects all; selected rows use the strong `.mkui-selected` tint. Cell mode: clicking a cell places the focus (its row gets the subtle `.mkui-row-hl` wash so the record stays readable — visually distinct from selection, guarded by `tests/styles.test.js`); drag extends a rectangle, ctrl/cmd-click adds rects or toggles single cells off, shift-click/shift+arrow extends the active rect from its anchor. Cell rects are stored as anchor/focus `(key, col)` pairs (plus last-known indices for deleted anchors) so they survive sorts and live inserts; membership resolves lazily to view/column indices, cached per view+selection revision. The focused cell is the *implicit* selection: copy and row-unit buttons fall back to it when nothing else is selected. Starting either mode clears the other. Keyboard (scroll host has `tabindex=0`, `.mkui-table-keys`): arrows move focus (collapsing selection), shift+arrows extend (rows in row mode, rect otherwise), Home/End jump columns (ctrl adds row extremes), PageUp/PageDown jump a viewport, Space selects the focused row (ctrl+Space toggles), Escape clears selection but keeps the cursor; the first arrow press only places the cursor. The viewport follows the focused cell: `scrollFocusIntoView` does a coarse rowH-based scroll, renders, then measures the focused row's actual rect and corrects by the exact overshoot (residual pitch drift still accumulates over hundreds of rows), plus a horizontal pass that keeps the focused column clear of the sticky row-number edge. Selection follows the filtered view: filter changes prune `selectedKeys`, and copy/actions/select-all only ever see view rows. Native text selection is disabled on `.mkui-table` (`user-select: none`).

Clipboard: `copySelection` builds a grid — row mode: selected rows × visible columns in `displayOrder` plus a `labels` header row; cell mode: bounding grid of selected rows × selected columns with blanks outside the rects; fallback: the focused cell — and writes both `text/plain` TSV and `text/html` table flavors via `ClipboardItem` (serialization in `lib/copy.js`; `writeText` fallback; grids over 100k rows skip the HTML flavor to halve peak memory). Triggered by Ctrl/Cmd+C or `edit.copy` through the pane's `_editActions` hook (see Menubar → Edit routing). Copy feedback: the copied rows/cells pulse (`mkui-flash-copy` — its keyframes declare no end frame, so the pulse fades to each element's own resting background: selection tint, highlight, or transparent; an explicit transparent end frame would read as a double flash on selected rows) and `status.message` briefly shows "Copied N rows/cells" (or "Copy failed"), reverting after 2s — the revert is skipped if something else (e.g. a disconnect state map) wrote the path in the meantime, and back-to-back copies restore the original pre-copy message.

Buttons: toolbar buttons may declare `unit` (top-level or under `enable`): `"rows"` (default), `"row"`, `"cells"`, `"cell"` — singular units default `minSelected`/`maxSelected` to 1. Row units count/receive the rows implied by the selection (explicit rows, else rows containing selected cells, else the focused cell's row — so plain cell clicks keep row-unit buttons working). Cell units count selected cells (capped enumeration for enablement) and get `cells: [{ row, column, value }]` plus `cell` in the action context; cell-unit transactions send one request per selected cell. `selection` in the context carries `{ count, rowCount, cellCount, unit }`.

Sorting: click a column header to cycle ascending → descending → none. Shift+click adds secondary sort keys for multi-column sort; priority is a digit knocked out *inside* the 16px caret (`.mkui-sort-num`, drawn in the header background color, offset toward the triangle's wide base per direction — the icon is sized to barely contain one digit; on hover it tracks the filter button's pill background). Auto-detects numeric vs string comparison. Guarded by `tests/styles.test.js`. New rows insert at the correct sorted position; sort state persists across resubscribes.

Filtering: each column header has one icon slot, the filter button, pinned to the cell's right edge (`.mkui-th-label` is `flex: 1`). It shows a filled hamburger (`icon("filter")`, three solid bars — same solid weight and x-extent as the sort carets but deliberately distinct in shape) until the column is sorted, then `updateHeaderState` swaps in the sort caret (wrapped in `.mkui-sort-indicator` inside the button); either way clicking it opens the filter panel, with a search input, "Select all"/"Clear" links, and checkboxes for each unique value. The panel opens right-aligned under the button (the button sits at the cell's right edge, so left-aligning would push the panel far past a wide column). Changes apply immediately. Active filters show the icon — hamburger or caret — in accent color. Multiple columns can be filtered independently. Filter state persists across resubscribes.

Virtualized rows: only the rows overlapping the viewport (plus 10 overscan each side) exist as DOM elements; two `.mkui-vspacer` rows (top/bottom of tbody) carry the height of everything else, so scrolling, pane resizes, and frame moves are O(visible) regardless of row count (~40 `tr`s for any dataset — designed for a million rows). Data lives in a `rows` Map plus a `baseOrder` keys array (display/insertion order); `view` is the filtered+sorted keys array that drives rendering. `render()` reconciles the visible slice into the tbody between the spacers, reusing keyed `tr`s (`rowEls` holds only rendered rows) and leaving in-place rows untouched so running flash animations aren't restarted. Inserts/deletes/replaces do incremental `view` surgery (binary search when sorted); sort/filter changes mark the view dirty for a full rebuild. Renders trigger on data change, scroll (sync, with an unchanged-slice early-exit), pane resize (`ResizeObserver`), and pane visibility. Row height is measured as the *pitch* between the first two rendered rows when possible (top-to-top distance; border-collapse splits row borders across neighbors, so a single row's rect height reads ~0.5px short — an error that compounds linearly with row index), falling back to one row's rect height (uniform — cells never wrap).

Column widths: as soon as the header row exists (at init when `columns` is configured, otherwise on first data), each column's header width is measured (under `width: max-content` so the pane width doesn't stretch the measurement) and locked in via a `<colgroup>` + `table-layout: fixed`, capped at 50% of the pane's visible width — columns start at header width, never wide-then-collapse. If the pane isn't laid out yet the measurement reads 0 and init retries on data events and visibility. From there columns only grow: `bumpStats` canvas-measures every ingested value in the table font (`ensureMeasureCtx`; numeric strings are counted at 1ch per char, text is skipped when even 2ch per char can't beat the column max) and `growColWidth` ratchets the column up to fit — numeric columns to max-integer + max-fraction width so decimals align, text columns to the widest string — still capped at half the pane, applied to the colgroup once per render (`widthsDirty`), so widths widen live during snapshot ingestion. Auto-grow never shrinks a column and skips manually resized ones (`userSized`). Data-column widths never react to pane/window resizes: the table keeps its base `width: 100%` (no inline width) so under fixed layout the used width is max(pane, sum of `<col>` widths) — data columns always get their exact `<col>` widths and a trailing auto-width filler column (`.mkui-th-filler` header cell + widthless `<col>`) takes the whole remainder, which is what extends the header row across the full pane. Two invariants guard this: `.mkui-table-fixed` must not declare `width`/`min-width` (a pixel width pins the column distribution at that width — later min-width stretching never re-runs it, leaving the filler at 0; guarded by `tests/styles.test.js`), and the virtual-scroll spacer `colspan` must equal the real column count (a larger colspan adds phantom columns that swallow the leftover ~0px each; kept in sync by `renderHead`). Columns are separated by subtle 1px dividers (half-alpha `--mkui-border` via `color-mix`, also guarded). Overflowing cell text clips with an ellipsis (header labels are `.mkui-th-label` spans so they truncate while the sort/filter buttons stay visible). Each column divider carries a `.mkui-col-resizer` grip centered on it (7px hit zone straddling the boundary) — drag to resize the column left of the divider (40px minimum). The grip lives on the left edge of the *following* header cell (the filler cell carries the last column's grip): later cells paint above earlier ones so the overhang stays clickable, and header cells must not be `overflow: hidden` (clipping lives on `td` and `.mkui-th-inner` instead) or the overhang gets cut off. Widths are keyed by column name in a `colWidths` map, so they survive reorder, resubscribe, and paging-mode switches; pane reopen resets them for re-measurement. A resize drag first syncs stored widths to the rendered widths so a drag that precedes measurement starts from what's on screen.

Column reorder: drag a column header to move it. Uses pointer events for unified mouse and touch support (5px movement threshold distinguishes drag from click). A ghost label and accent-colored drop indicator show the target position. Reorder state persists across resubscribes via a `displayOrder` array separate from the data-derived `columns`.

Paging (query): when `maxcount` is set (default 200), the subscription uses mkio's paged snapshot protocol. The mkio client accumulates all pages transparently and fires `onSnapshot` once. `applySnapshot` then ingests rows in `requestAnimationFrame`-batched chunks (at least 100 per frame, scaled so any snapshot completes within ~50 frames) to avoid freezing the UI on large datasets; only the visible slice is ever rendered to the DOM (see Virtualized rows). A progress indicator ("Loading N / Total…") is shown during chunked ingestion. A generation counter cancels stale chunk loops when a new snapshot arrives.

Paging (stream): when `maxcount` is set (default 200), the table enters paged mode with a toolbar showing `◀ Earlier | time range | Later ▶ | ● Live | ⟳`. By default (`start: "today"`), the initial fetch starts from local midnight (converted to UTC for the ref); `start: ""` starts from the beginning of the buffer. The toolbar displays the time range of visible rows in the browser's local timezone instead of page numbers, with adaptive precision: `HH:MM` when the endpoints differ at the minute level, `HH:MM:SS` when they share the same minute, and progressively finer sub-second precision in 3-digit increments (milliseconds, microseconds, nanoseconds) when they share the same second (e.g., `09:15:03.123 – 09:15:03.456`). Cross-day ranges include the date (e.g., `May 26 23:58 – May 27 00:02`). When no data is loaded, the toolbar shows `No data`. Boundary indicators are appended to the time range: `(start)` when at the first page, `(end)` when at the last page, `(all)` when the entire dataset fits in one page. The `⟳` refresh button re-fetches the current page from the server using the saved `pageLoadRef`/`pageLoadBefore` coordinates; it is disabled in live mode. Each page is a separate `subscribe` call via `fetchPage(ref, before)` with `onPage`. Navigation is ref-based: Later passes `lastRef` (last row's `_mkio_ref`) to fetch rows after, Earlier passes `firstRef` (first row's `_mkio_ref`) with `before: true` to fetch rows before. No cursor stack is stored — each navigation is relative to the current page's boundary refs, so pages stay correct even when records are added or deleted mid-session. When starting from midnight, Earlier is always enabled on the initial page (there may be data before midnight). When the initial fetch returns empty, `firstRef` is set to the requested start ref so Earlier can navigate backward from that point. When navigating backward yields an empty result (no earlier data), the table automatically re-fetches the previous page using saved `prevPageLoadRef`/`prevPageLoadBefore` coordinates, restoring the original data and disabling the Earlier button via a `noPrev` flag that prevents `pageHasPrev` from being set `true` on the re-fetch's `onPage` callback. The `● Live` button toggles live streaming mode — when active (accent-colored), the table subscribes for live updates on the main `subid` using ref-based resume from the current page's `lastRef`, so only records after the displayed page are fetched. In live mode, Earlier is enabled when there are previous pages; clicking it uses a separate `pageSubId` subscription to fetch the previous page via `fetchPrevLive()`, which **adds** the fetched rows before the existing data (using a DocumentFragment inserted before `tbody.firstChild`) without interrupting the live stream. The `pageFetchPending` flag disables the Earlier button during a fetch to prevent double-clicks. Toolbar shows `HH:mm – Live` when earlier pages have been loaded via `fetchPrevLive`. The `hasEarlierPages` boolean tracks whether `fetchPrevLive` has loaded pages. Later is always disabled in live mode. Exiting live mode unsubscribes both `subid` and `pageSubId`, then re-fetches the saved page from the server via `fetchPage(pageLoadRef, pageLoadBefore)` — this ensures rows inserted or deleted during live mode are reflected when returning to paged view. The saved page state stores only `pageLoadRef` and `pageLoadBefore` (no row snapshot). Sort, filter, and column order persist across mode switches. Visibility re-show reloads using the saved `pageLoadRef`/`pageLoadBefore` pair, so the same page is restored regardless of the direction it was originally fetched. Pane reopen recalculates the midnight ref for the current day (handles overnight running).

Disconnected indicator: the table subscribes to `mkio.connected` state. When the WebSocket disconnects while live mode is active, the toolbar shows "Disconnected" (or `HH:mm – Disconnected` when earlier pages are loaded) in muted text instead of the green blinking "Live" indicator. Live mode itself stays active so the saved page coordinates are preserved for seamless reconnect. The subscription is placed after all paging variables (`liveMode`, `pageHasPrev`, etc.) are declared to avoid temporal dead zone errors from `State.subscribe`'s synchronous initial callback.

Visibility-aware subscriptions: an `IntersectionObserver` on the pane content element detects visibility changes. Panes that start hidden (inactive tab) do not subscribe until first shown. When a pane becomes hidden (tab switch, park), a 5-minute timer starts; if still hidden when it fires, the subscription is dropped. If the pane reappears before the timer fires, the timer is cancelled and the subscription stays alive. When a frame is closed, the workspace dispatches a `mkui-pane-close` event on each pane element; the close handler sets a `closed` flag, disconnects the `IntersectionObserver`, and unconditionally calls `client.unsubscribe(subid)` (bypassing the `subscribed` guard to ensure the server always receives the unsubscribe). The `closed` flag prevents `sub()` and `fetchPage()` from re-subscribing after close. When a parked pane is reopened via `showPane()`, the workspace dispatches `mkui-pane-open`; the open handler resets `closed`, clears stale rows/sort/filter/paging state (including `lastRef`), and re-observes with the `IntersectionObserver`, which triggers a fresh subscription. In stream paged mode, brief hidden/shown transitions (under 5 minutes) preserve the current page without re-fetching.

Stream ref-based resume: for stream protocol, the table tracks `firstRef` and `lastRef` from `_mkio_ref` fields. `lastRef` is updated on every snapshot, delta, update callback, and `fetchPage` completion. `firstRef` is updated on `fetchPage` completion. When `sub()` is called with a non-null `lastRef`, it passes `ref: lastRef` to `client.subscribe()` and preserves existing rows/DOM — the server sends only records after the ref, avoiding duplicate re-transfer. When `lastRef` is null (first subscription), `sub()` clears state and subscribes from the beginning as before. Both refs are explicitly reset to null on pane reopen (`mkui-pane-open`), where a fresh start is intended. `goLive` preserves `lastRef` so the live subscription resumes from the current page's position; `exitLive` re-fetches the page from the server (via `fetchPage`), which sets fresh `firstRef`/`lastRef` from the response. For query and subpub protocols, `lastRef` is never set — re-subscribe after timeout clears state and fetches a fresh snapshot.

Snapshot clearing: for query and subpub protocols, `applySnapshot` unconditionally clears all existing rows, DOM elements, and selection before rendering the new data. This handles the mkio client's automatic reconnect path — on reconnect the client fires `onSnapshot` directly through the existing subscription callbacks without going through the table's `sub()`/`unsub()` cycle, so records deleted on the server between disconnect and reconnect would otherwise linger as stale rows. For stream protocol, `applySnapshot` preserves existing rows because resumed snapshots contain only records after `lastRef` and must append to the existing table.

## Dialogs

`openDialog(spec, context, app, extra)` creates a modal dialog as a floating frame (`stayOnTop`, `noDock`). Returns a Promise that resolves with the form data on successful submit, or `null` on cancel/close.

Field types: `hidden`, `readonly`, `select`, `checkbox`, `textarea`, `number`, text (default). Fields support `required`, `pattern`, `min`/`max`/`step` validation, `showWhen` conditional visibility, `optionsFrom` (async service-backed options), and `optionsFromColumn` (values from table data).

Layout: fields are listed in `spec.fields`. Items can be `{ group: "Header" }` for section headers, `{ row: [field, field] }` for horizontal layout, or plain field objects. `field.width` sets flex proportion in rows.

Submission: when `spec.submit.service` is set, the dialog sends form data via `client.send()` with a configurable timeout (default 5s). `submitPerRow` mode sends one request per selected row. Transaction errors are shown inline and the form stays open for retry. Without a service, the dialog resolves immediately with form data.

Pin button: an SVG pin-icon toggle (`icon("pin")`) in the dialog's titlebar (frame controls area, before maximize/close). When active, the pin rotates 45° counterclockwise and turns accent-colored (CSS transition, 150ms ease). Successful submission resets the form to its default values instead of closing the dialog. The form is only reset after the server confirms success — errors leave the form intact for retry. The pin button is injected via `frameEl._extraControls`, a callback that `_makeControls()` in frame.js calls to prepend custom elements before the standard window controls. Since `_makeControls` runs on every `_renderInternal`, the callback re-creates the button each render; the `pinned` state is held in a closure shared with the submit handler.

## Conventions

- Zero runtime dependencies; Web Components for framework-agnostic use
- Icons are inline SVGs from `lib/icons.js` (`icon(name)`), never text glyphs — they inherit color via `currentColor` and are sized per context by `.mkui-icon` CSS rules. `.mkui-icon` keeps `pointer-events: none` so hit-testing lands on the hosting button (guarded by `tests/styles.test.js`)
- `registerPaneType(name, factory)` for custom content; `registerWidget(name, factory)` for lightweight inline widgets
- Built-in actions prefixed `pane.*` (show), `window.*` (tileH, tileV, grid, cascade), and `app.*` (quit)
- Layout tree invariant: every leaf sits inside a `{ type: "tabs", children: [...] }` — never bare strings after normalize
- CSS invariant: `mkui-menubar` and `mkui-statusbar` are `box-sizing: border-box` so their rendered height equals `--mkui-menubar-h`/`--mkui-statusbar-h` exactly — the workspace is positioned by those variables, and a 1px overhang paints over the border of frames snapped to the top/bottom edge (guarded by `tests/styles.test.js`)
- Tests use `node:test` + `node:assert/strict`; no test framework dependency
