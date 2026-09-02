# CLAUDE.md

## Project overview

mkui is a config-driven, zero-dependency web GUI framework built with Web Components: a floating-frame workspace with dockable panes. Designed to pair with [mkio](../mkio) as the backend, but works standalone.

## Architecture

- **Workspace** (`<mkui-workspace>`) holds a z-ordered list of floating **frames**
- **Frames** (`<mkui-frame>`) are top-level chrome with 8-way resize handles; each owns an internal normalized layout tree. There is no dedicated titlebar — every top-edge tab bar doubles as a drag region, and the right-most one carries the window controls
- **Panes** (`<mkui-pane>`) are leaf content hosts inside frames; always wrapped in a TabGroup (structural invariant)
- Pane elements are pooled at the workspace level with stable identity — `appendChild` moves them between frames preserving state
- Frame positions are fractions of the workspace; split ratios sum to 1, so proportional resize is automatic. Frame rects are *painted* in whole pixels (`applyFrameRect` rounds edges, not width/height, so snapped frames stay flush): the layout measures its body via integer `clientWidth`/`clientHeight`, and a fractional size would leave a sub-pixel hairline at the bottom/right edge
- Every frame move/resize passes through `clampToDock` — nothing escapes the viewport
- Keyboard focus model: the top frame gets `[data-focused]` (set by `_applyZOrder`); each frame tracks an `_activeTabGroup` updated on interaction with a tab or within a pane — clicking a tab bar's empty area (right of the tabs / drag region) raises the frame without changing the group. Hotkeys act on that frame + group.
- Tab drag: pointer events (mouse + touch) on tabs (`touch-action: none`). Within a bar: ghost label + accent drop indicator, reorder on release; outside: tears the pane out into a new frame. On noDock frames (dialogs, login) the tab is titlebar text: mousedown moves the frame, click activates the tab; CSS must keep these tabs pointer-interactive (`cursor: move`, never `pointer-events: none`) — guarded by the pointer-guards and styles tests.
- Tab overflow: tabs shrink to `min-width: 3em`; when the strip still overflows, `.mkui-tabs` hides overflow and scroll arrows (`.mkui-tab-scroll`) appear, the bar getting `.mkui-tabbar-overflow` (`updateArrows` in `_renderTabBar`, which also scrolls the active tab into view). The strip always shows at least one tab (`min-width: 76px`; the 180px frame floor covers arrows + a tab + grab area + controls).
- Tab rename: ctrl/cmd+click on a tab swaps the label for an inline input (`.mkui-tab-rename`); Enter/blur commits via `workspace.renamePane(id, title)`, Escape cancels. Triggered by `pointerdown` with `ctrlKey || metaKey` and button 0, plus `contextmenu` with `ctrlKey` (macOS delivers ctrl+click as a context menu).
- Tab strip look: flush tabs with rounded top corners and radial-gradient bottom flares in `::after`, colored by `--mkui-tab-bg`. The bar's bottom line is a `.mkui-tabbar::after` overlay (never a border): the selected tab gets `z-index: 1` and covers it — that break is the selection mark. Selected tabs outside the keyboard-focused group flatten to the idle color with a muted label. Guarded by `tests/styles.test.js`.
- Theming: `dark` and `light` are styled by `mkui.css` via `[theme=...]`. Custom themes go in `config.app.themes[name]` as `{ "--mkui-*": value }` overrides; `MkuiApp.setTheme(name)` applies them as inline styles on the host.

## Key files

- `mkui/__init__.py` — Python package; exposes `static_dir` and `__version__`
- `mkui/__main__.py` — CLI (`mkui init`, `mkui serve`)
- `mkui/static/src/layout/tree.js` — normalized tree math (normalize, find, insert, remove, layout), no DOM
- `mkui/static/src/layout/drag.js` — clamp, snap, drop-zone, frac↔rect helpers, no DOM
- `mkui/static/src/components/workspace.js` — frame lifecycle, z-order, arrangement commands, inter-frame drag routing, snap
- `mkui/static/src/components/frame.js` — frame chrome, internal tree rendering, splitter drag; also defines `<mkui-pane>`
- `mkui/static/src/components/app.js` — shell: menubar + workspace + statusbar
- `mkui/static/src/core.js` — `App`, `State` (reactive store), widget/pane-type registries, expression extension re-exports
- `mkui/static/src/lib/expr.js` — mkio's expression language, vendored verbatim from `mkio/client/mkio-expr.mjs` (`tests/vendor-sync.test.js` compares it and `tests/expr_cases.json` with the installed mkio); never edit it here — change mkio and re-copy
- `mkui/static/src/lib/expressions.js` — mkui's wrapper over the expression language (see Expressions)
- `mkui/static/src/lib/rich.js` — the `rich` expression type and the `mkui` UI function library, plus `renderRich` (DOM spans) and `richToHTML` (clipboard); `tests/rich.test.js`
- `mkui/static/src/lib/timeparse.js` — time parsing for range filters (`detectTimeKind`, `parseTime`, input↔bound conversion, `PRESETS`); pure, `tests/timeparse.test.js`
- `mkui/static/src/lib/icons.js` — `icon(name)` returns a currentColor `<svg>` from vendored path data (Lucide outlines + custom filled carets/dot/hamburger)
- `mkui/static/src/lib/copy.js` — clipboard grid serialization: `gridToTSV` (CRLF rows, Excel quoting) and `gridToHTML`; pure, `tests/copy.test.js`
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

`mkui init` runs `mkio init --no-static` for `server.toml` (kept in sync with mkio), appends `[static]`/`[config]` routing sections, and writes `static/index.html` + `config/client.toml`. `mkui serve` loads `server.toml`, resolves `<mkui.static_dir>` to the installed package path, and delegates to `mkio.create_app()`, whose server handles static files, TOML→JSON config, `/mkio.js`, and the WebSocket.

## Config format

Runtime input is JSON. `mkui serve` uses mkio's `[config]` routing — requests for `/config/client.json` are served from `config/client.toml` (parsed with `tomllib`). The browser never needs a TOML parser. TOML configs use empty string `""` where JSON would use `null` (TOML has no null literal).

Top-level keys: `app`, `state`, `auth` (optional), `menubar`, `statusbar`, `panes` (id→spec), `frames` (ordered array with position + layout tree), `mkio` (optional).

## Expressions

mkui uses mkio's expression language for everything conditional or derived in config (`lib/expr.js`, vendored; `tests/expressions.test.js` runs mkio's conformance fixtures against it). Grammar and standard library: see mkio's README/CLAUDE.md. `lib/expressions.js` wraps it: one *lenient* `Env` (unknown names → NULL), compiled expressions/templates cached by source, `evalExpr` warns once per source and returns null on error, `resolveExpr` (pure `${x}` → raw value with NULL → `""`, mixed → string, non-strings pass through), `statePaths(src, {template})` lists the `state.<path>`s an expression reads so widgets subscribe to exactly those. Scopes: `values`/`styles`/`display` (cell scope: `value`, `row`, `col`, `state`, then row fields), `rowStyle` (`row`, `state`, fields), `enable.when` (`rows`, `row`, `cells`, `selection`, `connected`, `state`), dialog `showWhen`/`value`/`title`/`footer.note` (form fields, `form`, context), action `data` (raw fields), text widget `text` (`state`, reactive). Extension: `registerExprFunction(name, fn, meta)` (library `app`), `registerExprLibrary`, `registerExprType` — exported from `core.js`/`index.js`; there is no separate formatter/styler registry.

## Menubar

`menubar` is a top-level array. Each element has `label` (dropdown name) and `items` (array of menu items).

Item keys:
- `label` — display text
- `action` — action name fired on click (leaf items only)
- `args` — optional argument passed to action handler
- `items` — child array; presence makes it a nested submenu (opens on hover, nests arbitrarily)
- `sep` — `true` renders a separator line
- `windows` — `true` expands into one `pane.show` leaf per open pane (from `workspace.openPanes()`, noDock frames excluded); popups rebuild on each open so the list stays live.
- `shortcut` — right-aligned hint on leaf items (`.mkui-menu-shortcut`, guarded by `tests/styles.test.js`); `mod` renders platform-native via `formatShortcut` (`⌘C` / `Ctrl+C`). Display only: handlers accept either modifier.

Leaf items fire `app.fireAction(action, args)` on mouseup. Built-in actions: `app.quit`, `pane.show` (takes pane ID — switches to its tab and raises the frame, or opens a new frame if parked), `window.tileH`, `window.tileV`, `window.grid`, `window.cascade`, `edit.copy`, `edit.selectAll`, `table.filter` (`args = { pane, filters, merge }` → `workspace.setPaneFilters`; no `pane` targets the focused pane), `table.sort` (`args = { pane, sort }` → `workspace.setPaneSort`). Custom actions registered with `app.registerAction(name, fn)`.

Edit routing: `edit.copy`/`edit.selectAll` call `workspace.editAction(name)`, which resolves the focused frame's active pane (`workspace.activePaneEl()`) and invokes its `_editActions` hook (`{ copy, selectAll, clearSelection }` — any pane type can implement it). The window keydown handler routes Ctrl/Cmd+C, Ctrl/Cmd+A, and Escape through the same hook; INPUT/TEXTAREA/contentEditable events are ignored, a non-collapsed native text selection wins over table copy, and `preventDefault` fires only when a pane handled the action. Covered by `tests/edit-routing.test.js`.

## Statusbar

`statusbar` config keys: `left` / `right` (widget arrays) and `bindStyle` (CSS property → state path): each path's value is applied as an inline style on `<mkui-statusbar>`; `null` or `""` removes the override.

## mkio connection state

When `config.mkio.url` is present, `<mkui-app>` calls `ensureMkio` with `onConnect`/`onDisconnect` callbacks **before** setting up menubar, workspace, and statusbar — load-bearing, since pane factories also call `ensureMkio` and the bridge caches the first caller's promise. The bridge passes the `client` as the callbacks' first argument.

Connection is two-phase: **connect** then **verify**. On WebSocket open, `mkio.connected` is set `true` and the `config.mkio.connected` state map applies; an async `_mkio` reqrep then queries the server's identity (name, version, protocol, mkio version). Pass sets `mkio.verified` `true`; fail leaves it `false` and applies `config.mkio.incompatible` (overwriting the connected map). Verification re-runs on reconnect.

Optional `config.mkio.expect` declares the expected identity: `name` (exact), `version`, `protocol`, `mkio` (semver-compatible, checked server-side), `expr` (expression language version, exact — mkui vendors `"1"`). Without `expect` the query still runs to confirm an mkio server and populate `mkio.server.*`; it times out per `config.mkio.timeout` (default 5000ms), so non-mkio servers are detected as incompatible.

State maps `config.mkio.connected` / `.disconnected` / `.incompatible` are `"state.path": value` objects applied on each lifecycle event (defaults set `status.message` to "Connected" / "Disconnected" / "Incompatible server"); combine with `statusbar.bindStyle`. Lifecycle state paths: `mkio.connected` (socket open), `mkio.verified`, `mkio.server.name` / `.version` / `.protocol` / `.mkio`.

## Authentication

When `config.auth` is present, `<mkui-app>` shows a login dialog before loading frames (the workspace starts empty, so nothing unauthorized flashes). `method: "mkio"` (default) calls `client.auth({username, password})` against mkio's `_mkio_users` (seed users `admin`/`password`, `user`/`password`); `method: "custom"` uses `app.registerAuthHandler({ authenticate({username, password}) })` returning `{ user, role }`.

Config keys (under `auth`): `method` (`"mkio"` default, or `"custom"`); `dialog` (`title`, `width`, `usernameLabel`, `passwordLabel`, `submitLabel`); `connected` — state map applied after login and on reconnect; `disconnected` — state map on WebSocket disconnect (falls back to `mkio.disconnected`). State paths: `auth.authenticated`, `auth.user`, `auth.role`. Built-in action `auth.logout` reloads the page.

With auth enabled, `_mkio` verification is skipped — authentication proves the server. `mkio.connected` still applies on socket open (clearing the "Connecting..." styling); `auth.connected` applies after login and on reconnect when already authenticated (mkio's client stores `_authData` and re-authenticates itself).

Login dialog: a floating frame (`stayOnTop`, `noDock`) with `_hideClose = true` and `_extraControls = () => []` so it can't be dismissed; fields reuse the `mkui-dialog-*` classes.

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
- `rowColumn` — `false` hides the row-number column (default `true`; the `table.test.js` harness passes `false` so assertions index cells directly)
- `values` — object mapping column names to expressions that derive the column from the row (e.g. `{ notional = "qty * price" }`); see Derived columns
- `styles` — object mapping column names to a styler (rule array or expression) that styles the cell from its value; `rowStyle` — one styler for the whole row, conditioned on any of its columns; see Conditional styling
- `display` — object mapping column names to `${...}` templates that control what a cell *shows* (plain or rich text); see Display templates
- `select` — `{ state = "<path>" }` mirrors the current row into app state; see Selection publishing
- `types` — object mapping column names to a filter type: `"number"`, `"time"`, `"text"`, or `{ type = "time", parse = "%d/%m/%Y %H:%M", tz = "local", unit = "ms" }`; see Range filters
- `filters` — object mapping column names to a default filter: a value list `["open"]` (include), `{ include = [...] }` / `{ exclude = [...] }`, a range `{ from, to, empty, type }`, or `{ preset = "today" | "1h" | "15m" }`; see Configured filters
- `sort` — default sort order: a column name (`"-col"` for descending), `{ col, dir }`, or an array of those in priority order; see Configured sort

With `columns` configured the header row renders at init; otherwise on the first data row. Labels are used in the header row and the column drag ghost.

Row identity: query uses `_mkio_row`, stream uses `_mkio_ref`, subpub uses `_mkio_topic`. All `_mkio_*` columns are hidden from display.

Derived columns: `values = { col = "<expr>" }` derives a column with an expression evaluated in the cell scope — `value` (raw `row[col]`, NULL for a virtual column), `row`, `col`, `state`, then the row's fields by name. Every read of a column value goes through one `cellValue` accessor, so a derived column behaves like a real field everywhere. A virtual column no row carries must be listed in `columns`. Button action payloads bypass derivation and carry raw row fields. A bad expression warns once and yields the raw value / empty. The scope is a two-frame `expr.Scope` (`cellScope`), not a spread.

Conditional styling: `styles = { col = <styler> }` styles a cell; `rowStyle = <styler>` styles the `tr`. A styler is a rule array evaluated first-match-wins — each rule `{ when = "<expr>", ...style }`, a rule without `when` being the fallback — or a single expression yielding a style map (or NULL). Style keys: `color`, `background`, `bold`, `italic`, `underline`, `strike`, `class`, `css`; string values (including inside `css`) may be `${...}` templates (`compileRules` pre-splits static vs. dynamic keys). Cell rules see the cell scope; row rules see `rowScope` (no `value`/`col`). A rule whose condition errors warns once and never matches. Styles apply in `buildRow`, are recomputed on replace (`restyleRowStylers`), and `applyStyle` clears what the previous style set. Backgrounds are never inline: they ride `--mkui-cell-bg`/`--mkui-row-bg` custom properties plus `mkui-cell-styled`/`mkui-row-styled` marker classes placed *before* the selection rules so selection tints win (`color-mix`) — guarded by `tests/styles.test.js`.

Display templates: `display = { col = "<template>" }` controls presentation only — shown text, width stats, clipboard; sorting, filtering, and dropdown values use the (derived) value. Evaluated in the cell scope with derived columns visible (`cellDisplay` → `{ text, rich, error }`). A template may yield a **rich** value — the `rich` type from `lib/rich.js` (segments `{ text, style, icon?, bar? }`; `add`/`concat` join, `to_string` flattens) produced by the `mkui` library: `BOLD ITALIC UNDERLINE STRIKE COLOR BG MUTED MONO CLASS STYLE ICON BADGE BAR LINK` plus `HEAT(v, lo, hi, from, to)`. `renderCell` builds spans via `renderRich` (segment colors inline on the span, never the td; badges/bars ride `--mkui-badge-color`, `--mkui-bar-frac`, `--mkui-bar-color` — guarded by `tests/styles.test.js`), remembering the flattened text on `td._mkuiText` so a live update re-renders display cells whose text changed. An error renders `#ERR` (`.mkui-cell-err`) with the message as tooltip and warns once. Clipboard cells become `{ text, html }` for rich values. Nothing rich-specific lives in the engine — the type and library register through the public hooks.

Selection publishing: `select = { state = "path" }` writes the current row into app state on every selection change: the cursor's row, else the first selected row in view order, else `null` (a full reset, a delete of the published row, and closing the pane publish `null`; Escape keeps the cursor). Filter changes republish after pruning; sorting does not; a live replace of the published row republishes it. Writes are deduped on identity; without `select` the table never writes app state (beyond the copy toast).

Numeric alignment: all-numeric columns right-align with per-cell right padding (`--mkui-num-pad`, in ch — exact in the mono font) so decimal points line up: pad = column's widest fraction minus the cell's (`colStats.maxFrac`, a ratchet reset on data clear; growth or a flip to text restyles rendered cells). The filter dropdown decimal-aligns the same way with a *left* pad. Guarded by `tests/styles.test.js`.

Animations: `mkui-flash-in` (insert, blue), `mkui-flash-out` (delete, red), `mkui-flash-update` (changed cell, blue).

Each pane instance gets a unique `subid` so several subscriptions to one service share a WebSocket.

Selection: two mutually exclusive modes plus an always-present **focused cell** (keyboard cursor, `.mkui-cell-focus`), the *implicit* selection copy and row-unit buttons fall back to. Row mode: the sticky-left **row-number column** (`rowColumn: false` disables; numbered by view position, excluded from stats/reorder/resize, counted in the vspacer colspan) selects rows — click / ctrl-toggle / shift-range / drag-range, header corner selects all; `.mkui-selected` tint. Cell mode: click places the focus (its row gets the `.mkui-row-hl` wash), drag extends a rectangle, ctrl/cmd-click adds rects or toggles cells off, shift extends from the anchor. Rects are anchor/focus `(key, col)` pairs plus a `keys` snapshot of the rows spanned when last user-modified (`snapRectKeys`): membership is that record set × the column range, so sorts/filters move the same records and live inserts inside don't join; `rectBounds` resolves keys to view-index runs, cached per view+selection revision. Starting either mode clears the other. Keyboard on the scroll host (`tabindex=0`): arrows/Home/End/PageUp/PageDown move, shift extends, Space selects the focused row (ctrl toggles), Escape clears selection but keeps the cursor; `scrollFocusIntoView` scrolls coarsely by rowH, then corrects by the measured overshoot. Filter changes prune `selectedKeys`; copy/actions/select-all only see view rows. Native text selection is off on `.mkui-table`.

Clipboard: `copySelection` builds a grid — row mode: selected rows × visible columns plus a `labels` header row; cell mode: bounding grid with blanks outside the rects; fallback: the focused cell — and writes `text/plain` TSV and `text/html` via `ClipboardItem` (`lib/copy.js`; `writeText` fallback; grids over 100k rows skip HTML). Triggered by Ctrl/Cmd+C or `edit.copy` via `_editActions`. Copied cells pulse (`mkui-flash-copy` — no end keyframe, so it fades to each element's own background) and `status.message` shows "Copied N rows/cells" for 2s unless something else wrote the path.

Buttons: `enable.when = "<expr>"` gates a button on the selection — scope `rows`, `row` (first or NULL), `cells`, `selection` `{ count, rowCount, cellCount, unit }`, `connected`, `state` — combined with the structural flags `connected`, `minSelected`, `maxSelected`. `unit` (top-level or under `enable`): `"rows"` (default), `"row"`, `"cells"`, `"cell"` — singular units default min/max to 1. Row units receive the rows the selection implies (explicit rows, else rows containing selected cells, else the focused cell's row). Cell units get `cells: [{ row, column, value }]` plus `cell` in the action context; cell-unit transactions send one request per cell.

Sorting: click a header to cycle ascending → descending → none; shift+click adds secondary keys. Multi-sort priority is a digit knocked out *inside* the caret (`.mkui-sort-num`, painted in the header background; on hover it tracks the filter button's pill). Numeric vs string comparison is auto-detected. New rows insert at the sorted position; sort state persists across resubscribes. Guarded by `tests/styles.test.js`.

Configured sort: `sort = <spec>` seeds `sortKeys` at init and on `mkui-pane-open` (`loadSortSpec`); `sortFromSpec` takes a column name (`"-col"` → desc), `{ col, dir }`, or an array in priority order, rejecting a bad dir, a non-string column, or a duplicate — a bad spec warns `bad sort` and leaves the sort alone. `getSort()` → `[{ col, dir }]`; `setSort(spec)` replaces and re-applies (`applySort` = `updateHeaderState` + `reorder`/`resetOrder`, shared with the header click). The pane exposes `_sort = { set, get }`; `workspace.setPaneSort`/`getPaneSort` route to it via `_paneHook`, and `table.sort` wraps that. Tests: `table.test.js` ("Configured and programmatic sort"), `pane-filters.test.js`.

Sort & filter chips: the table's DOM is always a flex column — `.mkui-table-toolbar` (in the DOM only while it has buttons or chips; `syncToolbar` inserts it before the scroll area), `.mkui-table-scroll` holding the table, then progress or the paging bar — so the toolbar never scrolls. Buttons are the toolbar's first children; `.mkui-table-chips` is its last, pushed right by `margin-left: auto`. `renderChips` (called from `updateHeaderState`, so every sort/filter change refreshes it) builds one `.mkui-chip-group` per kind (`display: contents`, so chips wrap individually), led by a `.mkui-chip-lead` that pins the group's clear button (`.mkui-chip-icon`: the `sort`/`filter` icon with an × badge, `.mkui-chip-icon-x`, so it reads as an action rather than the header's state tint) to its first chip. A chip (`.mkui-chip`, `data-col`, tooltip) holds a `.mkui-chip-main` button (`.mkui-chip-text`, plus a caret on sort chips) and a `.mkui-chip-x` button: sort chips flip the direction / drop the key; filter chips `scrollHeaderIntoView` and toggle `openFilterDropdown` / `clearFilters([col])`; text is `label(col)` and, for filters, `describeFilter`. Wrapping: the toolbar is `flex-wrap: wrap`; the cluster's hypothetical size is its max-content width, so it sits beside the buttons when it fits and otherwise drops to the next line whole, shrinking and wrapping its chips end-aligned — buttons never move, nothing scrolls horizontally. Guarded by `tests/styles.test.js`; behavior in `table.test.js` ("Sort & filter chips").

Range filters: numeric columns and columns whose every value is a time get a **Values | Range** switch (`.mkui-filter-modes`). Range mode: `From`/`To` inputs (`.mkui-filter-bound-input`; native `datetime-local`/`date`/`time` pickers on time columns, which add `.mkui-filter-wide`), *Include empty* (blank/unparseable values otherwise drop out), *Clear*, and on time columns presets (`.mkui-filter-preset`: Today, Last hour, Last 15 min). Typing applies after a 150ms debounce, Enter at once; typing drops the preset. Model: `filters` maps a column to `{ kind: "values", mode, values }` or `{ kind: "range", type, lo, hi, loText, hiText, preset, empty, timeKind, spec, localTz }` — one filter per column, described by `describeFilter` (header tooltip and chip). Numeric `hi` is inclusive; time `hi` is *exclusive*, covering the whole unit typed (a date ends at the next midnight, `09:30` at `09:31`) — an epsilon on an epoch vanishes in double precision. Preset bounds resolve against the clock (memoised per second in `rangeBounds`); `syncPresetTimer` re-applies the view every 30s while a preset is active. Inference in `colStats`: `numeric` first, then `temporal`/`timeKind` (`bumpTemporal`: every non-empty value an mkio ref, ISO-8601 date/date-time, or bare `HH:MM[:SS[.f]]`; dates and date-times mix, a clock time next to a date flips the column to text), plus `min`/`max` for placeholders. Nothing else is guessed (`03/04/2026` is ambiguous); `types = { col = … }` declares it: `parse` is a strptime over `%Y %m %d %H %M %S %f %z`, `unit` reads epoch numbers (`s`, `ms`, `us`, `ns`), `tz` reads naive strings in `UTC` (default, matching `EPOCH()`), `local`, or `+HH:MM`. Matching goes through `cellValue`; live rows test the range like any filter; pane reopen resets to the configured defaults.

Filtering: each column header has one icon slot — the filter button, pinned right, showing the hamburger (`icon("filter")`) until the column is sorted, when `updateHeaderState` swaps in the sort caret (`.mkui-sort-indicator`). Either opens the same panel — search, "Select all"/"Clear", a checkbox per unique value — right-aligned under the button. Changes apply immediately, an active filter tints the icon accent, columns filter independently, and filter state persists across resubscribes. A values filter records intent: `{ kind: "values", mode: "include" | "exclude", values }`. The dropdown starts (and "Select all" resets) in exclude mode — unchecking hides those values and everything else passes, including values never seen; "Clear" flips to include mode — checking shows only those, unseen values stay hidden. An empty exclusion is no filter; an inclusion always is. Tooltip: `N values` / `All but N values`.

Configured filters: `filters = { col = <filter> }` seeds the `filters` map at init (before data, so a header rendered from `columns` shows them active) and again on `mkui-pane-open`. `filterFromSpec(col, spec)`: a list or `{ include }`/`{ exclude }` → a values filter (an empty exclusion is no filter); `from`/`to`/`empty`/`preset` → a range whose frame is `types[col].type`, else the entry's `type`, else inferred from the bounds (numbers → number, strings or a preset → time). Time bounds take the input-control forms (`YYYY-MM-DD`, `YYYY-MM-DD[T ]HH:MM[:SS]`, `HH:MM[:SS]`) via `inputToBound` under the kind detected from the text (a date on a date-time column ends at the next midnight; `loText`/`hiText` are rewritten via `boundToInput` when the typed kind differs so the dropdown restores them), or epoch numbers on a `unit` column. A bad entry warns `bad filters.<col>` and is skipped; `null`/`""` clears the column. `filterToSpec` is the inverse, so `getFilters()` round-trips through `setFilters(map, { merge })` — replace by default, `merge` keeps other columns, a `null` entry under merge clears one. The pane element exposes `_filters = { set, get }`; `workspace.setPaneFilters(id, filters, opts)` (builds a never-shown pane first; `id == null` → `activePaneEl()`) and `getPaneFilters(id)` route to it via `_paneHook`; `table.filter` wraps that. Tests: `table.test.js` ("Configured and programmatic filters"), `pane-filters.test.js`.

Virtualized rows: only rows overlapping the viewport (plus 10 overscan) exist as DOM elements; two `.mkui-vspacer` rows carry the height of everything else. Data lives in a `rows` Map plus `baseOrder`; `view` is the filtered+sorted keys array that drives rendering. `render()` reconciles the visible slice, reusing keyed `tr`s (`rowEls`) and leaving in-place rows untouched so flash animations aren't restarted. Inserts/deletes/replaces do incremental `view` surgery (binary search when sorted); sort/filter changes mark the view dirty. Renders trigger on data change, scroll, `ResizeObserver`, and visibility. Row height is the *pitch* between the first two rendered rows (border-collapse makes a single row's rect read ~0.5px short), falling back to one row's height.

Column widths: once the header row exists (init with `columns`, else first data), each header is measured under `width: max-content` and locked via `<colgroup>` + `table-layout: fixed`, capped at 50% of the pane (a 0 measurement retries on data/visibility events). From there columns only grow: `bumpStats` canvas-measures every ingested value and `growColWidth` ratchets up to fit (numeric: max-integer + max-fraction; text: widest string), half-pane capped, flushed once per render (`widthsDirty`); never shrinks, skips `userSized` columns. In paged streams only the first data sizes columns (`dataSeen` → page loads ingest with `growSuspended`; live rows still grow; reopen re-arms). Widths never react to pane resizes: the table keeps `width: 100%` with no inline width, so used width is max(pane, sum of `<col>` widths) and a trailing auto-width filler (`.mkui-th-filler` + widthless `<col>`) absorbs the remainder — `tests/styles.test.js` guards that `.mkui-table-fixed` declares no `width`/`min-width` and that the vspacer `colspan` equals the column count. Each divider carries a `.mkui-col-resizer` grip (7px hit zone, 40px min) resizing the column to its left, on the left edge of the *following* header cell (the filler carries the last) — header cells must not be `overflow: hidden`. Widths are keyed by column name in `colWidths` (survive reorder/resubscribe/paging; reset on reopen). Double-clicking a grip auto-sizes the column (80% viewport cap) and clears `userSized`; inside a selection, every selected column is fitted.

Column reorder: drag a header (pointer events, 5px threshold distinguishes drag from click); a ghost label and accent drop indicator show the target. Order persists across resubscribes in `displayOrder`, separate from the data-derived `columns`.

Paging (query): when `maxcount` is set (default 200), the client accumulates every page and fires `onSnapshot` once. `applySnapshot` ingests rows in `requestAnimationFrame`-batched chunks (≥100 per frame, scaled to finish within ~50 frames), showing "Loading N / Total…" meanwhile; a generation counter cancels stale chunk loops when a new snapshot arrives.

Paging (stream): when `maxcount` is set (default 200), a toolbar shows `◀ Earlier | time range | Later ▶ | ● Live | ⟳`. The initial fetch starts from local midnight (`start: "today"`, converted to UTC for the ref) or the beginning of the buffer (`start: ""`). The range label shows the visible rows' local timestamps with adaptive precision (`HH:MM` → `HH:MM:SS` → sub-second in 3-digit steps as the endpoints converge; cross-day ranges add the date; `No data` when empty) plus a boundary suffix `(start)`, `(end)`, or `(all)`.

Navigation is ref-based with no cursor stack: each page is its own `subscribe` via `fetchPage(ref, before)` with `onPage` — Later passes `lastRef`, Earlier passes `firstRef` with `before: true` — so pages stay correct as records change. Edge cases: starting from midnight leaves Earlier enabled on the first page; an empty initial fetch sets `firstRef` to the requested start ref; an empty backward fetch restores the previous page (`prevPageLoadRef`/`prevPageLoadBefore`) and disables Earlier via `noPrev`. `⟳` re-fetches the current page from `pageLoadRef`/`pageLoadBefore`; disabled in live mode.

`● Live` resumes streaming on the main `subid` from the page's `lastRef`. In live mode Later is disabled and Earlier fetches through a separate `pageSubId` (`fetchPrevLive`), prepending rows without interrupting the stream (`pageFetchPending` blocks double-clicks; `hasEarlierPages` drives the `HH:mm – Live` label). Exiting live unsubscribes both subids and re-fetches the saved page (coordinates only) so inserts/deletes during live are reflected. Sort, filter, and column order persist across mode switches; pane reopen recalculates midnight for the current day.

Tail following: live streams read like a terminal. Each subscription callback samples `shouldFollowTail()` *before* ingesting (stream + live, viewport within 8px of the bottom) and calls `scrollToTail()` after; otherwise `maybeRestoreScroll` runs. `goLive` sets `tailPending` to force one jump; a viewport scrolled up is never moved. Query/subpub never follow.

`live: true` still fetches the start page first and hands off from its `onPage` (`autoLivePending` — consumed on the first page, re-armed on pane reopen); going live straight from `sub()` would ignore `start`, replay the whole buffer, and leave `savedPageState` unset. An empty start page leaves `lastRef` null (which `sub()` reads as "from the beginning"), so the handoff seeds it from `getStartRef()`.

Disconnected indicator: the table subscribes to `mkio.connected`; when the socket drops in live mode the toolbar shows "Disconnected" in muted text instead of the Live dot, and live mode stays on so the saved page survives the reconnect. The subscription must be declared *after* all paging variables — `State.subscribe` fires its initial callback synchronously and would otherwise hit a temporal dead zone.

Visibility-aware subscriptions: an `IntersectionObserver` gates the subscription — a hidden pane doesn't subscribe until shown; hidden 5 minutes drops it (paged streams keep the current page across shorter hides). `mkui-pane-close` sets `closed` (blocks `sub()`/`fetchPage()`), disconnects the observer, and unsubscribes unconditionally; `mkui-pane-open` clears `closed`, drops stale rows/sort/filter/paging state (including `lastRef`), and re-observes.

Stream ref-based resume: `lastRef` advances on every snapshot, delta, update, and `fetchPage` completion; `firstRef` on `fetchPage` completion. `sub()` with a non-null `lastRef` passes `ref: lastRef` and keeps existing rows; with null it clears state and subscribes from the beginning. Both reset on pane reopen. Query and subpub never set `lastRef` — a re-subscribe takes a fresh snapshot.

Snapshot clearing: for query and subpub, `applySnapshot` clears rows, DOM, and selection first — auto-reconnect fires `onSnapshot` through the existing callbacks, bypassing `sub()`/`unsub()`, so deletes during an outage would otherwise linger. Streams append: a resumed snapshot holds only records after `lastRef`.

## Dialogs

`openDialog(spec, context, app, extra)` creates a modal dialog as a floating frame (`stayOnTop`, `noDock`). Returns a Promise that resolves with the form data on successful submit, or `null` on cancel/close.

Field types: `hidden`, `readonly`, `select`, `checkbox`, `textarea`, `number`, text (default). Fields support `required`, `pattern`, `min`/`max`/`step` validation, `showWhen = "<expr>"` conditional visibility (scope: the form's fields by name, `form`, and the opening context; also on individual select options; a literal boolean works too), `optionsFrom` (async service-backed options), and `optionsFromColumn` (values from table data).

Layout: `spec.fields` items are `{ group: "Header" }` section headers, `{ row: [field, field] }` horizontal rows (`field.width` sets flex proportion), or plain fields. Once the fields render, a body that would scroll grows the frame by the overflow (capped at 90% of the workspace) and re-centers it — skipped when the workspace rect has zero height.

Submission: with `spec.submit.service` the dialog sends form data via `client.send()` (timeout default 5s; `submitPerRow` sends one request per selected row); errors show inline and the form stays open for retry. Without a service it resolves at once with the form data.

Pin button: an `icon("pin")` toggle before maximize/close (active = rotated 45°, accent); while pinned, a *confirmed* submission resets the form instead of closing. Injected via `frameEl._extraControls`, which `_makeControls()` calls on every `_renderInternal`, so the callback re-creates the button each render with `pinned` in a closure.

## Conventions

- Zero runtime dependencies; Web Components for framework-agnostic use
- Pointer guards: every mousedown/pointerdown that opens a menu or starts an action/drag checks `ev.button === 0` — right/middle clicks are inert (exception: the frame-raise mousedown raises on any button). Modified clicks are inert where the modifier has no meaning: sort headers ignore ctrl/cmd/alt (shift keeps multi-sort), the select-all corner ignores all modifiers. Guarded by `tests/pointer-guards.test.js` and `tests/table.test.js`
- Icons are inline SVGs from `lib/icons.js` (`icon(name)`), never text glyphs — `currentColor`, sized per context by `.mkui-icon` CSS. `.mkui-icon` keeps `pointer-events: none` so hit-testing lands on the hosting button (guarded by `tests/styles.test.js`)
- `registerPaneType(name, factory)` for custom content; `registerWidget(name, factory)` for lightweight inline widgets
- Built-in actions prefixed `pane.*` (show), `window.*` (tileH, tileV, grid, cascade), `table.*` (filter, sort), and `app.*` (quit)
- Layout tree invariant: every leaf sits inside a `{ type: "tabs", children: [...] }` — never bare strings after normalize
- CSS invariant: `mkui-menubar`/`mkui-statusbar` are `box-sizing: border-box` so their height equals `--mkui-menubar-h`/`--mkui-statusbar-h` exactly — the workspace is positioned by those, and a 1px overhang would paint over snapped frames' borders (guarded by `tests/styles.test.js`)
- Tests use `node:test` + `node:assert/strict`; no test framework dependency
