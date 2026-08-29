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
- Tab drag: pointer events (mouse + touch) on tabs. Within a bar: ghost label + accent drop indicator, reorder on release; outside the bar: tears the pane out into a new frame. `touch-action: none` on `.mkui-tab`. On noDock frames (dialogs, login) the tab is titlebar text: mousedown moves the frame, click activates the tab; CSS must keep these tabs pointer-interactive (`cursor: move`, never `pointer-events: none`) — guarded by the pointer-guards and styles tests.
- Tab overflow: tabs shrink to `min-width: 3em`; when the strip still overflows, `.mkui-tabs` hides overflow and scroll arrows (`.mkui-tab-scroll`) appear, the bar getting `.mkui-tabbar-overflow` (toggled by `updateArrows` in `_renderTabBar`, which also disables each arrow at its end and scrolls the active tab into view after each render). The strip always shows at least one tab (`.mkui-tabs` `min-width: 76px`; the frame resize floor of 180px covers arrows + one tab + grab area + window controls).
- Tab rename: ctrl+click or cmd+click on a tab swaps the label for an inline input (`.mkui-tab-rename`); Enter/blur commits via `workspace.renamePane(id, title)`, Escape cancels. Triggers: `pointerdown` with `ctrlKey || metaKey` and button 0, plus `contextmenu` with `ctrlKey` (macOS delivers ctrl+click as a context-menu gesture).
- Tab strip look: flush tabs with rounded top corners and radial-gradient bottom flares in `::after`, colored by `--mkui-tab-bg` so they match the body. The bar's bottom line is a `.mkui-tabbar::after` overlay (never a border): the selected tab gets `z-index: 1` and covers it — that break is the selection mark. Selected color `--mkui-tab-active`, idle `--mkui-bg`, `::before` dividers between idle tabs. Selected tabs outside the keyboard-focused group flatten to the idle color with a muted label. Guarded by `tests/styles.test.js`.
- Theming: `dark` and `light` are styled by `mkui.css` via `[theme=...]`. Custom themes go in `config.app.themes[name]` as `{ "--mkui-*": value }` overrides; `MkuiApp.setTheme(name)` applies them as inline styles on the host.

## Key files

- `mkui/__init__.py` — Python package; exposes `static_dir` and `__version__`
- `mkui/__main__.py` — CLI (`mkui init`, `mkui serve`); scaffold templates, mkio `create_app` integration
- `mkui/static/src/layout/tree.js` — normalized tree math (normalize, find, insert, remove, layout), no DOM
- `mkui/static/src/layout/drag.js` — clamp, snap, drop-zone, frac↔rect helpers, no DOM
- `mkui/static/src/components/workspace.js` — frame lifecycle, z-order, arrangement commands, inter-frame drag routing, snap
- `mkui/static/src/components/frame.js` — frame chrome, internal tree rendering, splitter drag; also defines `<mkui-pane>`
- `mkui/static/src/components/app.js` — shell: menubar + workspace + statusbar
- `mkui/static/src/core.js` — `App`, `State` (reactive store), widget/pane-type registries, expression extension re-exports
- `mkui/static/src/lib/expr.js` — mkio's expression language, vendored verbatim from `mkio/client/mkio-expr.mjs` (`tests/vendor-sync.test.js` compares it and `tests/expr_cases.json` with the installed mkio); never edit it here — change mkio and re-copy
- `mkui/static/src/lib/expressions.js` — mkui's lenient `Env`, cached `compileExpr`/`compileTemplate`, `evalExpr` (warn-once, null on error), `resolveExpr`/`resolveObject` for `${...}` templates, `statePaths` (which `state.<path>`s an expression reads), and the `registerExprFunction/Library/Type` re-exports
- `mkui/static/src/lib/rich.js` — the `rich` expression type and the `mkui` UI function library (BOLD, COLOR, BADGE, ICON, BAR, LINK, HEAT, …), plus `renderRich` (DOM spans) and `richToHTML` (clipboard); covered by `tests/rich.test.js`
- `mkui/static/src/lib/timeparse.js` — time parsing for range filters: `detectTimeKind`, `parseTime` (refs, ISO-8601, clock times; `parse`/`tz`/`unit` column specs via `strptime`), input↔bound conversion for the native pickers, relative `PRESETS`; pure, covered by `tests/timeparse.test.js`
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

## Expressions

mkui uses mkio's expression language for everything conditional or derived in config; `lib/expr.js` is mkio's `client/mkio-expr.mjs` vendored verbatim, and `tests/expressions.test.js` runs mkio's conformance fixtures (`tests/expr_cases.json`) against it. Grammar and standard library: see mkio's README/CLAUDE.md. `lib/expressions.js` wraps it: one *lenient* `Env` (unknown names → NULL), compiled expressions/templates cached by source, `evalExpr` warns once per source and returns null on error, `resolveExpr` (pure `${x}` → raw value with NULL → `""`, mixed → string, non-strings pass through), `statePaths(src, {template})` lists the `state.<path>`s an expression reads so widgets subscribe to exactly those. Scopes: `values`/`styles`/`display` (cell scope: `value`, `row`, `col`, `state`, then row fields), `rowStyle` (`row`, `state`, fields), `enable.when` (`rows`, `row`, `cells`, `selection`, `connected`, `state`), dialog `showWhen`/`value`/`title`/`footer.note` (form fields, `form`, context), action `data` (raw fields), text widget `text` (`state`, reactive). Extension: `registerExprFunction(name, fn, meta)` (library `app`), `registerExprLibrary`, `registerExprType` — exported from `core.js`/`index.js`; there is no separate formatter/styler registry.

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

Edit routing: `edit.copy`/`edit.selectAll` call `workspace.editAction(name)`, which resolves the focused frame's active pane (`workspace.activePaneEl()`) and invokes its `_editActions` hook (`{ copy, selectAll, clearSelection }` — any pane type can implement it). The window keydown handler routes Ctrl/Cmd+C, Ctrl/Cmd+A, and Escape through the same hook; INPUT/TEXTAREA/contentEditable events are ignored, a non-collapsed native text selection wins over table copy, and `preventDefault` fires only when a pane handled the action. Covered by `tests/edit-routing.test.js`.

## Statusbar

`statusbar` config keys: `left` (widget array), `right` (widget array), `bindStyle` (optional object mapping CSS property names to state paths). `bindStyle` subscribes to each state path and applies the value as an inline style on `<mkui-statusbar>`. Setting a state value to `null` or empty string `""` removes the inline override (reverts to stylesheet default).

## mkio connection state

When `config.mkio.url` is present, `<mkui-app>` calls `ensureMkio` with `onConnect`/`onDisconnect` callbacks **before** setting up menubar, workspace, and statusbar. This ordering is load-bearing: pane factories also call `ensureMkio` and the bridge caches the first caller's promise, so the app's call must come first for its lifecycle callbacks to register. The bridge passes the `client` as the callbacks' first argument.

Connection is two-phase: **connect** then **verify**. On WebSocket open, `mkio.connected` is set `true` and the `config.mkio.connected` state map applies immediately; an async `_mkio` reqrep then queries the server's identity (name, version, protocol version, mkio version). Pass sets `mkio.verified` `true`; fail leaves it `false` and applies the `config.mkio.incompatible` state map (overwriting the connected map). Verification re-runs on reconnect.

The optional `config.mkio.expect` object declares expected server identity: `name` (exact match), `version`, `protocol`, `mkio` (semver-compatible, checked server-side), `expr` (expression language version, exact match — mkui vendors `"1"`). When `expect` is absent, the `_mkio` query still runs to confirm an mkio server and populate `mkio.server.*`. The request times out per `config.mkio.timeout` (default 5000ms) — non-mkio servers that don't respond are detected as incompatible.

State maps: `config.mkio.connected`, `config.mkio.disconnected`, and `config.mkio.incompatible` are objects of `"state.path": value` entries applied on each lifecycle event. Defaults: `{ "status.message": "Connected" }` / `{ "status.message": "Disconnected" }` / `{ "status.message": "Incompatible server" }`. Combine with `statusbar.bindStyle` for visual feedback.

State paths set by the connection lifecycle: `mkio.connected` (boolean, WebSocket open), `mkio.verified` (boolean, passed `_mkio` verification), `mkio.server.name` / `.version` / `.protocol` / `.mkio` (server identity).

## Authentication

When `config.auth` is present, `<mkui-app>` shows a login dialog before loading frames. The workspace initializes empty; frames are created only after successful authentication (no flash of unauthorized content).

Flavors: `method: "mkio"` (default) calls `client.auth({username, password})` against mkio's `_mkio_users` (seed users `admin`/`password`, `user`/`password`); `method: "custom"` uses `app.registerAuthHandler({ authenticate({username, password}) })`, returning `{ user, role }`; omit `[auth]` for no login.

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
- `rowColumn` — `false` hides the row-number selection column (default `true`; the `table.test.js` harness passes `false` so assertions can index cells directly)
- `values` — object mapping column names to expressions that derive the column from the row (e.g. `{ notional = "qty * price" }`); see Derived columns
- `styles` — object mapping column names to a styler (rule array or expression) that styles the cell from its value; `rowStyle` — one styler for the whole row, conditioned on any of its columns; see Conditional styling
- `display` — object mapping column names to `${...}` templates that control what a cell *shows* (plain or rich text); see Display templates
- `select` — `{ state = "<path>" }` mirrors the current row into app state; see Selection publishing
- `types` — object mapping column names to a filter type: `"number"`, `"time"`, `"text"`, or `{ type = "time", parse = "%d/%m/%Y %H:%M", tz = "local", unit = "ms" }`; see Range filters

When `columns` is pre-configured, the header row renders immediately at init (before any data arrives). When `columns` is omitted, headers render on first data row. Labels are used in both the header row and the column drag ghost.

Row identity: query uses `_mkio_row`, stream uses `_mkio_ref`, subpub uses `_mkio_topic`. All `_mkio_*` columns are hidden from display.

Derived columns: `values = { col = "<expr>" }` derives a column with an expression evaluated in the cell scope — `value` (raw `row[col]`, NULL for a virtual column), `row`, `col`, `state`, then the row's fields by name. Every read of a column value goes through one `cellValue` accessor, so a derived column behaves like a real field everywhere. A virtual column no row carries must be listed in `columns`. Button action payloads bypass derivation and carry raw row fields. A bad expression warns once and yields the raw value / empty. The scope is a two-frame `expr.Scope` (`cellScope`), not a spread.

Conditional styling: `styles = { col = <styler> }` styles a cell; `rowStyle = <styler>` styles the `tr`. A styler is a rule array evaluated first-match-wins — each rule `{ when = "<expr>", ...style }`, a rule without `when` being the fallback — or a single expression yielding a style map (or NULL). Style keys: `color`, `background`, `bold`, `italic`, `underline`, `strike`, `class`, `css`; string values (including inside `css`) may be `${...}` templates (`compileRules` pre-splits static vs. dynamic keys). Cell rules see the cell scope with `value` = `cellValue`; row rules see `rowScope` (no `value`/`col`). A rule whose condition errors warns once and never matches. Styles apply in `buildRow`, are recomputed on replace (`restyleRowStylers`), and `applyStyle` clears what the previous style set. Backgrounds are never inline: they ride `--mkui-cell-bg`/`--mkui-row-bg` custom properties plus `mkui-cell-styled`/`mkui-row-styled` marker classes placed *before* the selection rules so selection tints win (`color-mix` blends) — guarded by `tests/styles.test.js`.

Display templates: `display = { col = "<template>" }` controls presentation only — shown text, width stats, clipboard; sorting, filtering, and filter-dropdown values use the (derived) value. Evaluated in the cell scope with derived columns visible (`cellDisplay` → `{ text, rich, error }`). A template may yield a **rich** value — the `rich` type from `lib/rich.js` (segments `{ text, style, icon?, bar? }`; `add`/`concat` join, `to_string` flattens) produced by the `mkui` library: `BOLD ITALIC UNDERLINE STRIKE COLOR BG MUTED MONO CLASS STYLE ICON BADGE BAR LINK` plus `HEAT(v, lo, hi, from, to)`. `renderCell` builds spans via `renderRich` for rich values (segment colors inline on the span, never the td; badges/bars ride `--mkui-badge-color`, `--mkui-bar-frac`, `--mkui-bar-color` — guarded by `tests/styles.test.js`), remembering the flattened text on `td._mkuiText`; on a live update, display cells re-render when that text changed even if their own column didn't. An evaluation error renders `#ERR` (`.mkui-cell-err`) with the message as tooltip and warns once. Clipboard grid cells become `{ text, html }` for rich cells so TSV gets flattened text and HTML keeps styling via `richToHTML`. Nothing rich-specific lives in the engine — the type and library register through the public hooks.

Selection publishing: `select = { state = "path" }` writes the current row into app state whenever the selection changes. The current row is the cursor's row, else the first selected row in view order, else `null` — so a full reset, a delete of the published row, and closing the pane publish `null`, while Escape keeps the cursor. Filter changes republish after pruning; sorting does not; a live replace of the published row republishes it. Writes are deduped on row identity; without `select` the table never writes app state (beyond the copy toast).

Numeric alignment: columns whose every non-empty value is numeric are right-aligned with per-cell right padding (`--mkui-num-pad`, in ch — exact in the mono font) so decimal points line up: pad = column's widest fraction minus the cell's (`colStats.maxFrac`, a ratchet reset on data clear; growth or a flip to text restyles rendered cells). The filter dropdown decimal-aligns its values the same way with a *left* pad. Guarded by `tests/styles.test.js`.

Animations: inserts flash blue and fade in, deletes flash red and fade out, field updates flash blue on the changed cell. CSS classes: `mkui-flash-in`, `mkui-flash-out`, `mkui-flash-update`.

Each pane instance gets a unique `subid` for multiplexing multiple subscriptions to the same service on one WebSocket.

Selection: two mutually exclusive modes plus an always-present **focused cell** (keyboard cursor, `.mkui-cell-focus`). Row mode: a sticky-left **row-number column** (`rowColumn: false` disables; numbered by view position, excluded from column stats/reorder/resize, counted in the vspacer colspan) selects rows — click / ctrl-toggle / shift-range / drag-range, header corner selects all; `.mkui-selected` tint. Cell mode: clicking a cell places the focus (its row gets the subtle `.mkui-row-hl` wash, distinct from selection); drag extends a rectangle, ctrl/cmd-click adds rects or toggles cells off, shift-click/shift+arrow extends the active rect from its anchor. Cell rects are anchor/focus `(key, col)` pairs plus a `keys` snapshot of the rows spanned when last user-modified (`snapRectKeys`) — membership is that record set × the column range, so sorts/filters move the same records and live inserts inside don't join; `rectBounds` resolves keys to view-index runs lazily, cached per view+selection revision. The focused cell is the *implicit* selection: copy and row-unit buttons fall back to it. Starting either mode clears the other. Keyboard (scroll host `tabindex=0`): arrows move focus, shift+arrows extend, Home/End jump columns (ctrl adds row extremes), PageUp/PageDown jump a viewport, Space selects the focused row (ctrl+Space toggles), Escape clears selection but keeps the cursor. `scrollFocusIntoView` scrolls coarsely by rowH, renders, then corrects by the measured overshoot (plus a horizontal pass clearing the sticky row-number edge). Selection follows the filtered view: filter changes prune `selectedKeys`; copy/actions/select-all only see view rows. Native text selection is disabled on `.mkui-table`.

Clipboard: `copySelection` builds a grid — row mode: selected rows × visible columns plus a `labels` header row; cell mode: bounding grid with blanks outside the rects; fallback: the focused cell — and writes `text/plain` TSV and `text/html` via `ClipboardItem` (`lib/copy.js`; `writeText` fallback; grids over 100k rows skip HTML). Triggered by Ctrl/Cmd+C or `edit.copy` via `_editActions`. Feedback: copied cells pulse (`mkui-flash-copy` — no end keyframe, so it fades to each element's own resting background) and `status.message` briefly shows "Copied N rows/cells", reverting after 2s unless something else wrote the path.

Buttons: `enable.when = "<expr>"` gates a button on the selection — scope `rows`, `row` (first or NULL), `cells`, `selection` `{ count, rowCount, cellCount, unit }`, `connected`, `state` — combined with the structural flags `connected`, `minSelected`, `maxSelected`. `unit` (top-level or under `enable`): `"rows"` (default), `"row"`, `"cells"`, `"cell"` — singular units default min/max to 1. Row units receive the rows the selection implies (explicit rows, else rows containing selected cells, else the focused cell's row). Cell units get `cells: [{ row, column, value }]` plus `cell` in the action context; cell-unit transactions send one request per cell.

Sorting: click a header to cycle ascending → descending → none; shift+click adds secondary keys. Multi-sort priority is a digit knocked out *inside* the caret (`.mkui-sort-num`, painted in the header background; on hover it tracks the filter button's pill). Numeric vs string comparison is auto-detected. New rows insert at the sorted position; sort state persists across resubscribes. Guarded by `tests/styles.test.js`.

Range filters: the dropdown of a numeric column, or a column whose every value is a time, has a **Values | Range** switch (`.mkui-filter-modes`; text columns are unchanged). Range mode: `From`/`To` inputs (`.mkui-filter-bound-input`: `type=number`, or a native `datetime-local`/`date`/`time` picker; time columns add `.mkui-filter-wide`), *Include empty* (blank/unparseable values otherwise drop out), *Clear*, and on time columns relative presets (`.mkui-filter-preset`: Today, Last hour, Last 15 min). Typing applies after a 150ms debounce, Enter at once; typing drops the preset. Model: `filters` maps a column to `{ kind: "values", allowed }` or `{ kind: "range", type, lo, hi, loText, hiText, preset, empty, timeKind, spec, localTz }` — one filter per column; the header button's tooltip describes it. Numeric `hi` is inclusive; time `hi` is *exclusive*, covering the whole unit typed (a date ends at the next midnight, `09:30` at `09:31`) — an epsilon on an epoch value vanishes in double precision. Preset bounds resolve against the clock (memoised per second in `rangeBounds`); a 30s `setTimeout` chain (`syncPresetTimer`) re-applies the view while a preset is active. Inference in `colStats`: `numeric` first, then `temporal`/`timeKind` (`bumpTemporal`: every non-empty value must be an mkio ref, ISO-8601 date/date-time, or bare `HH:MM[:SS[.f]]`; dates and date-times mix, a clock time next to a date flips the column to text), plus `min`/`max` for placeholders. Nothing else is guessed (`03/04/2026` is ambiguous); `types = { col = … }` declares it: `parse` is a strptime over `DATE()`'s `%Y %m %d %H %M %S %f %z` tokens (exclusive), `unit` reads epoch numbers (`s`, `ms`, `us`, `ns`), `tz` reads naive strings in `UTC` (default, matching `EPOCH()`), `local`, or `+HH:MM`. Matching goes through `cellValue`; live inserts/updates test the range like any filter; filters clear on pane reopen. Guarded by `tests/table.test.js`, `tests/timeparse.test.js`, `tests/styles.test.js`.

Filtering: each column header has one icon slot — the filter button, pinned to the cell's right edge. It shows a filled hamburger (`icon("filter")`) until the column is sorted, when `updateHeaderState` swaps in the sort caret (`.mkui-sort-indicator` inside the button). Either icon opens the same panel — search, "Select all"/"Clear", a checkbox per unique value — right-aligned under the button. Changes apply immediately, an active filter tints the icon accent, columns filter independently, and filter state persists across resubscribes.

Virtualized rows: only rows overlapping the viewport (plus 10 overscan) exist as DOM elements; two `.mkui-vspacer` rows carry the height of everything else, so scrolling and resizes are O(visible). Data lives in a `rows` Map plus `baseOrder`; `view` is the filtered+sorted keys array that drives rendering. `render()` reconciles the visible slice, reusing keyed `tr`s (`rowEls`) and leaving in-place rows untouched so flash animations aren't restarted. Inserts/deletes/replaces do incremental `view` surgery (binary search when sorted); sort/filter changes mark the view dirty. Renders trigger on data change, scroll, `ResizeObserver`, and visibility. Row height is the *pitch* between the first two rendered rows (border-collapse makes a single row's rect read ~0.5px short), falling back to one row's height.

Column widths: once the header row exists (init when `columns` is configured, else first data), each header is measured under `width: max-content` and locked via `<colgroup>` + `table-layout: fixed`, capped at 50% of the pane; a 0 measurement retries on data/visibility events. From there columns only grow: `bumpStats` canvas-measures every ingested value in the table font and `growColWidth` ratchets up to fit (numeric: max-integer + max-fraction; text: widest string), half-pane capped, flushed to the colgroup once per render (`widthsDirty`). Auto-grow never shrinks and skips manually resized columns (`userSized`). In paged streams only the first data sizes columns: once `dataSeen`, page loads ingest with `growSuspended` so navigating never jumps the layout; live rows still grow; pane reopen re-arms. Widths never react to pane resizes: the table keeps `width: 100%` with no inline width, so used width is max(pane, sum of `<col>` widths) and a trailing auto-width filler (`.mkui-th-filler` + widthless `<col>`) absorbs the remainder. `tests/styles.test.js` guards: `.mkui-table-fixed` must not declare `width`/`min-width`, and the vspacer `colspan` must equal the real column count (`renderHead` keeps it in sync). Columns are separated by 1px half-alpha `--mkui-border` dividers; `.mkui-th-label` ellipsizes. Each divider carries a `.mkui-col-resizer` grip (7px hit zone, 40px min) resizing the column to its left, sitting on the left edge of the *following* header cell (the filler carries the last) — header cells must not be `overflow: hidden`. Widths are keyed by column name in `colWidths` (survive reorder/resubscribe/paging; reset on pane reopen). Double-clicking a grip auto-sizes its column to fit content/header (capped at 80% of the viewport) and clears `userSized`; when the column is inside the selection, every selected column is fitted.

Column reorder: drag a column header to move it. Uses pointer events for unified mouse and touch support (5px movement threshold distinguishes drag from click). A ghost label and accent-colored drop indicator show the target position. Reorder state persists across resubscribes via a `displayOrder` array separate from the data-derived `columns`.

Paging (query): when `maxcount` is set (default 200), the client accumulates every page and fires `onSnapshot` once. `applySnapshot` ingests rows in `requestAnimationFrame`-batched chunks (≥100 per frame, scaled to finish within ~50 frames), showing "Loading N / Total…" meanwhile; a generation counter cancels stale chunk loops when a new snapshot arrives.

Paging (stream): when `maxcount` is set (default 200), a toolbar shows `◀ Earlier | time range | Later ▶ | ● Live | ⟳`. The initial fetch starts from local midnight (`start: "today"`, converted to UTC for the ref) or the beginning of the buffer (`start: ""`). The range label shows the visible rows' local timestamps with adaptive precision (`HH:MM` → `HH:MM:SS` → sub-second in 3-digit steps as the endpoints converge; cross-day ranges add the date; `No data` when empty) plus a boundary suffix `(start)`, `(end)`, or `(all)`.

Navigation is ref-based with no cursor stack: each page is its own `subscribe` via `fetchPage(ref, before)` with `onPage` — Later passes `lastRef`, Earlier passes `firstRef` with `before: true` — so pages stay correct as records change. Edge cases: starting from midnight leaves Earlier enabled on the first page; an empty initial fetch sets `firstRef` to the requested start ref; an empty backward fetch restores the previous page (`prevPageLoadRef`/`prevPageLoadBefore`) and disables Earlier via `noPrev`. `⟳` re-fetches the current page from `pageLoadRef`/`pageLoadBefore`; disabled in live mode.

`● Live` resumes streaming on the main `subid` from the page's `lastRef`. In live mode Later is disabled and Earlier fetches through a separate `pageSubId` (`fetchPrevLive`), prepending rows without interrupting the stream (`pageFetchPending` blocks double-clicks; `hasEarlierPages` drives the `HH:mm – Live` label). Exiting live unsubscribes both subids and re-fetches the saved page (coordinates only) so inserts/deletes during live are reflected. Sort, filter, and column order persist across mode switches; pane reopen recalculates midnight for the current day.

Tail following: live streams (paged live mode and non-paged streams) read like a terminal. Each subscription callback samples `shouldFollowTail()` *before* ingesting (stream + live, viewport within 8px of the bottom) and calls `scrollToTail()` after; otherwise `maybeRestoreScroll` runs. `goLive` sets `tailPending` to force one jump; a viewport scrolled up is never moved. Query/subpub never follow.

`live: true` still fetches the start page first and hands off from its `onPage` (`autoLivePending` — consumed on the first page, re-armed on pane reopen); going live straight from `sub()` would ignore `start`, replay the whole buffer, and leave `savedPageState` unset. An empty start page leaves `lastRef` null (which `sub()` reads as "from the beginning"), so the handoff seeds it from `getStartRef()`.

Disconnected indicator: the table subscribes to `mkio.connected`; when the socket drops in live mode the toolbar shows "Disconnected" in muted text instead of the Live dot, and live mode stays on so the saved page survives the reconnect. The subscription must be declared *after* all paging variables — `State.subscribe` fires its initial callback synchronously and would otherwise hit a temporal dead zone.

Visibility-aware subscriptions: an `IntersectionObserver` on the pane content gates the subscription — a hidden pane doesn't subscribe until shown, and one hidden for 5 minutes drops its subscription. On frame close (`mkui-pane-close`) the handler sets `closed`, disconnects the observer, and calls `client.unsubscribe(subid)` unconditionally; `closed` blocks `sub()`/`fetchPage()`. Reopening (`mkui-pane-open`) clears `closed`, drops stale rows/sort/filter/paging state (including `lastRef`), and re-observes. In stream paged mode, hidden/shown transitions under 5 minutes keep the current page.

Stream ref-based resume: `lastRef` advances on every snapshot, delta, update, and `fetchPage` completion; `firstRef` on `fetchPage` completion. `sub()` with a non-null `lastRef` passes `ref: lastRef` and preserves existing rows; with null it clears state and subscribes from the beginning. Both reset on pane reopen. `goLive` preserves `lastRef`; `exitLive` re-fetches the page. Query and subpub never set `lastRef` — a re-subscribe takes a fresh snapshot.

Snapshot clearing: for query and subpub, `applySnapshot` unconditionally clears rows, DOM, and selection first — the mkio client's auto-reconnect fires `onSnapshot` through the existing callbacks, bypassing `sub()`/`unsub()`, so server-side deletes during an outage would otherwise linger. Stream appends: a resumed snapshot holds only records after `lastRef`.

## Dialogs

`openDialog(spec, context, app, extra)` creates a modal dialog as a floating frame (`stayOnTop`, `noDock`). Returns a Promise that resolves with the form data on successful submit, or `null` on cancel/close.

Field types: `hidden`, `readonly`, `select`, `checkbox`, `textarea`, `number`, text (default). Fields support `required`, `pattern`, `min`/`max`/`step` validation, `showWhen = "<expr>"` conditional visibility (scope: the form's fields by name, `form`, and the opening context; also on individual select options; a literal boolean works too), `optionsFrom` (async service-backed options), and `optionsFromColumn` (values from table data).

Layout: fields are listed in `spec.fields`. Items can be `{ group: "Header" }` for section headers, `{ row: [field, field] }` for horizontal layout, or plain field objects. `field.width` sets flex proportion in rows. The initial frame height is a guess; after the fields render, a body that would scroll grows the frame by the overflow (capped at 90% of the workspace) and re-centers it vertically — skipped when the workspace rect has zero height.

Submission: when `spec.submit.service` is set, the dialog sends form data via `client.send()` with a configurable timeout (default 5s). `submitPerRow` mode sends one request per selected row. Transaction errors are shown inline and the form stays open for retry. Without a service, the dialog resolves immediately with form data.

Pin button: an `icon("pin")` toggle before maximize/close; active = rotated 45° and accent-colored. While pinned, successful submission resets the form instead of closing — only after the server confirms; errors leave the form for retry. Injected via `frameEl._extraControls`, which `_makeControls()` in frame.js calls on every `_renderInternal` to prepend elements before the window controls, so the callback re-creates the button each render with `pinned` held in a closure.

## Conventions

- Zero runtime dependencies; Web Components for framework-agnostic use
- Pointer guards: every mousedown/pointerdown that opens a menu or starts an action/drag checks `ev.button === 0` (menubar, resize handles, splitters, drag region, tabs, table selection/column resize/reorder) — right/middle clicks are inert. Exception: the frame-raise mousedown is deliberately unguarded (any-button raise). Modified clicks are inert where the modifier has no meaning: sort headers ignore ctrl/cmd/alt (shift keeps multi-sort), the select-all corner ignores all modifiers. Guarded by `tests/pointer-guards.test.js` and `tests/table.test.js`
- Icons are inline SVGs from `lib/icons.js` (`icon(name)`), never text glyphs — they inherit color via `currentColor` and are sized per context by `.mkui-icon` CSS rules. `.mkui-icon` keeps `pointer-events: none` so hit-testing lands on the hosting button (guarded by `tests/styles.test.js`)
- `registerPaneType(name, factory)` for custom content; `registerWidget(name, factory)` for lightweight inline widgets
- Built-in actions prefixed `pane.*` (show), `window.*` (tileH, tileV, grid, cascade), and `app.*` (quit)
- Layout tree invariant: every leaf sits inside a `{ type: "tabs", children: [...] }` — never bare strings after normalize
- CSS invariant: `mkui-menubar` and `mkui-statusbar` are `box-sizing: border-box` so their rendered height equals `--mkui-menubar-h`/`--mkui-statusbar-h` exactly — the workspace is positioned by those variables, and a 1px overhang paints over the border of frames snapped to the top/bottom edge (guarded by `tests/styles.test.js`)
- Tests use `node:test` + `node:assert/strict`; no test framework dependency
