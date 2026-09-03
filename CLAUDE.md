# CLAUDE.md

## Project overview

mkui is a config-driven, zero-dependency web GUI framework built with Web Components: a floating-frame workspace with dockable panes. Designed to pair with [mkio](../mkio) as the backend, but works standalone.

## Architecture

- **Workspace** (`<mkui-workspace>`) holds a z-ordered list of floating **frames**
- **Frames** (`<mkui-frame>`) are top-level chrome with 8-way resize handles; each owns an internal normalized layout tree. There is no dedicated titlebar — every top-edge tab bar doubles as a drag region, and the right-most one carries the window controls
- **Panes** (`<mkui-pane>`) are leaf content hosts inside frames; always wrapped in a TabGroup (structural invariant)
- Pane elements are pooled at the workspace level with stable identity — `appendChild` moves them between frames preserving state
- Frame positions are fractions of the workspace; split ratios sum to 1, so proportional resize is automatic. Frame rects are *painted* in whole pixels (`applyFrameRect` rounds edges, not width/height, so snapped frames stay flush): the layout measures its body via integer `clientWidth`/`clientHeight`, and a fractional size would leave a sub-pixel hairline
- Every frame move/resize passes through `clampToDock` — nothing escapes the viewport
- Keyboard focus model: the top frame gets `[data-focused]` (`_applyZOrder`); each frame tracks an `_activeTabGroup` updated on interaction with a tab or within a pane — clicking a tab bar's empty area raises the frame without changing the group. Hotkeys act on that frame + group.
- Tab drag: pointer events (mouse + touch) on tabs (`touch-action: none`). Within a bar: ghost label + accent drop indicator, reorder on release; outside: tears the pane out into a new frame. On noDock frames (dialogs, login) the tab is titlebar text: mousedown moves the frame, click activates the tab; CSS must keep these tabs pointer-interactive (`cursor: move`, never `pointer-events: none`).
- Tab overflow: tabs shrink to `min-width: 3em`; when the strip still overflows, `.mkui-tabs` hides overflow and scroll arrows (`.mkui-tab-scroll`) appear, the bar getting `.mkui-tabbar-overflow` (`updateArrows` in `_renderTabBar`, which also scrolls the active tab into view). The strip always shows at least one tab.
- Tab rename: ctrl/cmd+click on a tab swaps the label for an inline input (`.mkui-tab-rename`); Enter/blur commits via `workspace.renamePane(id, title)`, Escape cancels. Triggered by `pointerdown` with `ctrlKey || metaKey` and button 0, plus `contextmenu` with `ctrlKey` (macOS delivers ctrl+click as a context menu).
- Tab strip look: flush tabs with rounded top corners and radial-gradient bottom flares in `::after`, colored by `--mkui-tab-bg`. The bar's bottom line is a `.mkui-tabbar::after` overlay (never a border): the selected tab gets `z-index: 1` and covers it — that break is the selection mark. Selected tabs outside the keyboard-focused group flatten to the idle color. Guarded by `tests/styles.test.js`.
- Theming: `dark` and `light` are styled by `mkui.css` via `[theme=...]`. Custom themes go in `config.app.themes[name]` as `{ "--mkui-*": value }` overrides; `MkuiApp.setTheme(name)` applies them inline on the host.

## Key files

- `mkui/__init__.py` — Python package; exposes `static_dir` and `__version__`
- `mkui/__main__.py` — CLI (`mkui init`, `mkui serve`)
- `mkui/static/src/layout/tree.js` — normalized tree math (normalize, find, insert, remove, layout), no DOM
- `mkui/static/src/layout/drag.js` — clamp, snap, drop-zone, frac↔rect helpers, no DOM
- `mkui/static/src/components/workspace.js` — frame lifecycle, z-order, arrangement commands, inter-frame drag routing, snap
- `mkui/static/src/components/frame.js` — frame chrome, internal tree rendering, splitter drag; also defines `<mkui-pane>`
- `mkui/static/src/components/app.js` — shell: menubar + workspace + statusbar
- `mkui/static/src/core.js` — `App`, `State` (reactive store), widget/pane-type registries, expression extension re-exports
- `mkui/static/src/lib/expr.js` — mkio's expression language, vendored verbatim from `mkio/client/mkio-expr.mjs` (`tests/vendor-sync.test.js` compares it with the installed mkio); never edit it here — change mkio and re-copy
- `mkui/static/src/lib/expressions.js` — mkui's wrapper over the expression language (see Expressions)
- `mkui/static/src/lib/rich.js` — the `rich` expression type and the `mkui` UI function library, plus `renderRich` (DOM) and `richToHTML` (clipboard)
- `mkui/static/src/lib/timeparse.js` — time parsing for range filters (`detectTimeKind`, `parseTime`, input↔bound conversion, `PRESETS`); pure
- `mkui/static/src/lib/icons.js` — `icon(name)` returns a currentColor `<svg>` from vendored path data (Lucide outlines + custom filled carets/dot/hamburger)
- `mkui/static/src/lib/copy.js` — clipboard grid serialization: `gridToTSV` (CRLF rows, Excel quoting) and `gridToHTML`; pure
- `mkui/static/src/widgets/mkio-table.js` — built-in `mkio-table` pane type: subscribes to mkio services, renders live tables
- `mkui/static/src/widgets/mkui-dialog.js` — `openDialog()`: config-driven modal dialogs with validation, RPC submission, pin-to-keep-open
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

`mkui init` runs `mkio init --no-static` for `server.toml`, appends `[static]`/`[config]` routing sections, and writes `static/index.html` + `config/client.toml`. `mkui serve` loads `server.toml`, resolves `<mkui.static_dir>` to the installed package path, and delegates to `mkio.create_app()`.

## Config format

Runtime input is JSON. `mkui serve` uses mkio's `[config]` routing — requests for `/config/client.json` are served from `config/client.toml` (parsed with `tomllib`). The browser never needs a TOML parser. TOML configs use empty string `""` where JSON would use `null` (TOML has no null literal).

Top-level keys: `app`, `state`, `auth` (optional), `menubar`, `statusbar`, `panes` (id→spec), `frames` (ordered array with position + layout tree), `mkio` (optional).

## Expressions

mkui uses mkio's expression language for everything conditional or derived in config (`lib/expr.js`, vendored; `tests/expressions.test.js` runs mkio's conformance fixtures). `lib/expressions.js` wraps it: one *lenient* `Env` (unknown names → NULL), compiled expressions/templates cached by source, `evalExpr` warns once per source and returns null on error, `resolveExpr` (pure `${x}` → raw value with NULL → `""`, mixed → string), `statePaths(src, {template})` lists the `state.<path>`s an expression reads so widgets subscribe to exactly those. Scopes: `values`/`styles`/`display` (cell scope: `value`, `row`, `col`, `state`, then row fields), `rowStyle` (`row`, `state`, fields), `enable.when` (`rows`, `row`, `cells`, `selection`, `connected`, `state`), dialog `showWhen`/`value`/`title`/`footer.note` (form fields, `form`, context), action `data` (raw fields), text widget `text` (`state`, reactive). Extension: `registerExprFunction(name, fn, meta)`, `registerExprLibrary`, `registerExprType` — exported from `core.js`/`index.js`.

## Menubar

`menubar` is a top-level array. Each element has `label` (dropdown name) and `items` (array of menu items).

Item keys:
- `label` — display text
- `action` — action name fired on click (leaf items only)
- `args` — optional argument passed to action handler
- `items` — child array; presence makes it a nested submenu (opens on hover, nests arbitrarily)
- `sep` — `true` renders a separator line
- `windows` — `true` expands into one `pane.show` leaf per open pane (`workspace.openPanes()`, noDock frames excluded); popups rebuild on each open.
- `shortcut` — right-aligned hint on leaf items (`.mkui-menu-shortcut`); `mod` renders platform-native via `formatShortcut` (`⌘C` / `Ctrl+C`). Display only: handlers accept either modifier.

Leaf items fire `app.fireAction(action, args)` on mouseup. Built-in actions: `app.quit`, `pane.show` (pane ID — switches to its tab and raises the frame, or opens a new frame if parked), `window.tileH`/`tileV`/`grid`/`cascade`, `edit.copy`, `edit.selectAll`, `table.filter` (`args = { pane, filters, merge }` → `workspace.setPaneFilters`; no `pane` targets the focused pane), `table.sort` (`{ pane, sort }` → `setPaneSort`), `table.columns` (`{ pane, visible }` → `setPaneColumns`; no `visible` shows all). Custom actions: `app.registerAction(name, fn)`.

Edit routing: `edit.copy`/`edit.selectAll` call `workspace.editAction(name)`, which resolves the focused frame's active pane (`workspace.activePaneEl()`) and invokes its `_editActions` hook (`{ copy, selectAll, clearSelection }` — any pane type can implement it). The window keydown handler routes Ctrl/Cmd+C, Ctrl/Cmd+A, and Escape through the same hook; INPUT/TEXTAREA/contentEditable events are ignored, a non-collapsed native text selection wins over table copy, and `preventDefault` fires only when a pane handled the action. `tests/edit-routing.test.js`.

## Statusbar

`statusbar` config keys: `left` / `right` (widget arrays) and `bindStyle` (CSS property → state path): each path's value is applied as an inline style on `<mkui-statusbar>`; `null` or `""` removes the override.

## mkio connection state

When `config.mkio.url` is present, `<mkui-app>` calls `ensureMkio` with `onConnect`/`onDisconnect` callbacks **before** setting up menubar, workspace, and statusbar — load-bearing, since pane factories also call `ensureMkio` and the bridge caches the first caller's promise. The bridge passes the `client` as the callbacks' first argument.

Connection is two-phase: **connect** then **verify**. On WebSocket open, `mkio.connected` is set `true` and the `config.mkio.connected` state map applies; an async `_mkio` reqrep then queries the server's identity. Pass sets `mkio.verified` `true`; fail leaves it `false` and applies `config.mkio.incompatible`. Verification re-runs on reconnect.

Optional `config.mkio.expect` declares the expected identity: `name` (exact), `version`, `protocol`, `mkio` (semver-compatible, checked server-side), `expr` (expression language version, exact — mkui vendors `"1"`). Without `expect` the query still runs to confirm an mkio server and populate `mkio.server.*`; it times out per `config.mkio.timeout` (default 5000ms).

State maps `config.mkio.connected` / `.disconnected` / `.incompatible` are `"state.path": value` objects applied on each lifecycle event (defaults set `status.message`); combine with `statusbar.bindStyle`. Lifecycle state paths: `mkio.connected`, `mkio.verified`, `mkio.server.name` / `.version` / `.protocol` / `.mkio`.

## Authentication

When `config.auth` is present, `<mkui-app>` shows a login dialog before loading frames (the workspace starts empty). `method: "mkio"` (default) calls `client.auth({username, password})` against mkio's `_mkio_users` (seed users `admin`/`password`, `user`/`password`); `method: "custom"` uses `app.registerAuthHandler({ authenticate({username, password}) })` returning `{ user, role }`.

Config keys (under `auth`): `method`; `dialog` (`title`, `width`, `usernameLabel`, `passwordLabel`, `submitLabel`); `connected` — state map applied after login and on reconnect; `disconnected` — state map on WebSocket disconnect (falls back to `mkio.disconnected`). State paths: `auth.authenticated`, `auth.user`, `auth.role`. Built-in action `auth.logout` reloads the page.

With auth enabled, `_mkio` verification is skipped — authentication proves the server. `mkio.connected` still applies on socket open; `auth.connected` applies after login and on reconnect (mkio's client re-authenticates itself).

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
- `visible` — which columns show, in display order: a column name or an array of names; absent/`""`/`[]` shows every column and follows new ones; see Column visibility
- `groups` — column categories for the picker: an ordered array of `{ label, columns }`; ungrouped columns form an implicit "Other"; without `columns`, display order follows the groups; see Column groups

With `columns` configured the header row renders at init; otherwise on the first data row. Labels are used in the header row and the column drag ghost.

Row identity: query uses `_mkio_row`, stream uses `_mkio_ref`, subpub uses `_mkio_topic`. All `_mkio_*` columns are hidden from display.

Derived columns: `values = { col = "<expr>" }` derives a column with an expression evaluated in the cell scope — `value` (raw `row[col]`, NULL for a virtual column), `row`, `col`, `state`, then the row's fields by name. Every read of a column value goes through one `cellValue` accessor, so a derived column behaves like a real field everywhere. A virtual column no row carries must be listed in `columns`. Button action payloads carry raw row fields. A bad expression warns once and yields the raw value / empty.

Conditional styling: `styles = { col = <styler> }` styles a cell; `rowStyle = <styler>` styles the `tr`. A styler is a rule array evaluated first-match-wins — `{ when = "<expr>", ...style }`, a rule without `when` being the fallback — or a single expression yielding a style map (or NULL). Style keys: `color`, `background`, `bold`, `italic`, `underline`, `strike`, `class`, `css`; string values may be `${...}` templates. Cell rules see the cell scope; row rules see `rowScope`. A rule whose condition errors warns once and never matches. Backgrounds are never inline: they ride `--mkui-cell-bg`/`--mkui-row-bg` plus `mkui-cell-styled`/`mkui-row-styled` marker classes placed *before* the selection rules so selection tints win — guarded by `tests/styles.test.js`.

Display templates: `display = { col = "<template>" }` controls presentation only — shown text, width stats, clipboard; sorting, filtering, and dropdown values use the (derived) value. Evaluated in the cell scope (`cellDisplay` → `{ text, rich, error }`). A template may yield a **rich** value — the `rich` type from `lib/rich.js` produced by the `mkui` library (`BOLD ITALIC UNDERLINE STRIKE COLOR BG MUTED MONO CLASS STYLE ICON BADGE BAR LINK HEAT`). `renderCell` builds spans via `renderRich` (segment colors inline on the span, never the td; badges/bars ride `--mkui-badge-color`, `--mkui-bar-frac`, `--mkui-bar-color`), remembering the flattened text on `td._mkuiText` so a live update re-renders display cells whose text changed. An error renders `#ERR` with the message as tooltip and warns once. 

Selection publishing: `select = { state = "path" }` writes the current row into app state on every selection change: the cursor's row, else the first selected row in view order, else `null` (a full reset, a delete of the published row, and closing the pane publish `null`). Filter changes republish after pruning; a live replace of the published row republishes it. Writes are deduped on identity.

Numeric alignment: all-numeric columns right-align with per-cell right padding (`--mkui-num-pad`, in ch — exact in the mono font) so decimal points line up: pad = column's widest fraction minus the cell's (`colStats.maxFrac`, a ratchet reset on data clear). The filter dropdown decimal-aligns the same way with a *left* pad. Guarded by `tests/styles.test.js`.

Animations: `mkui-flash-in` (insert, blue), `mkui-flash-out` (delete, red), `mkui-flash-update` (changed cell, blue).

Each pane instance gets a unique `subid` so several subscriptions to one service share a WebSocket.

Selection: two mutually exclusive modes plus an always-present **focused cell** (`.mkui-cell-focus`), the *implicit* selection copy and row-unit buttons fall back to. Row mode: the sticky-left **row-number column** (`rowColumn: false` disables; numbered by view position, excluded from stats/reorder/resize) selects rows — click / ctrl-toggle / shift-range / drag-range, header corner selects all. Cell mode: click places the focus (its row gets `.mkui-row-hl`), drag extends a rectangle, ctrl/cmd-click adds rects or toggles cells off, shift extends from the anchor. Rects are anchor/focus `(key, col)` pairs plus a `keys` snapshot of the rows spanned when last user-modified (`snapRectKeys`): membership is that record set × the column range, so sorts/filters move the same records and live inserts inside don't join; `rectBounds` resolves keys to view-index runs, cached per view+selection revision. Keyboard: arrows/Home/End/PageUp/PageDown move, shift extends, Space selects the focused row (ctrl toggles), Escape clears selection but keeps the cursor. Filter changes prune `selectedKeys`; copy and actions only see view rows.

Clipboard: `copySelection` builds a grid — row mode: selected rows × visible columns plus a `labels` header row; cell mode: bounding grid with blanks outside the rects; fallback: the focused cell — and writes `text/plain` TSV and `text/html` via `ClipboardItem` (`lib/copy.js`; `writeText` fallback; grids over 100k rows skip HTML). Copied cells pulse; `status.message` shows "Copied N rows/cells" for 2s.

Buttons: `enable.when = "<expr>"` gates a button on the selection — scope `rows`, `row` (first or NULL), `cells`, `selection` `{ count, rowCount, cellCount, unit }`, `connected`, `state` — combined with the structural flags `connected`, `minSelected`, `maxSelected`. `unit`: `"rows"` (default), `"row"`, `"cells"`, `"cell"` — singular units default min/max to 1. Row units receive the rows the selection implies (explicit rows, else rows containing selected cells, else the focused cell's row). Cell units get `cells: [{ row, column, value }]` plus `cell` in the action context; cell-unit transactions send one request per cell.

Sorting: click a header to cycle ascending → descending → none; shift+click adds secondary keys. Multi-sort priority is a digit knocked out *inside* the caret (`.mkui-sort-num`). Numeric vs string comparison is auto-detected. New rows insert at the sorted position; sort state persists across resubscribes.

Configured sort: `sort = <spec>` seeds `sortKeys` at init and on `mkui-pane-open` (`loadSortSpec`); `sortFromSpec` takes a column name (`"-col"` → desc), `{ col, dir }`, or an array in priority order, rejecting a bad dir, a non-string column, or a duplicate — a bad spec warns `bad sort` and leaves the sort alone. `getSort()` → `[{ col, dir }]`; `setSort(spec)` replaces and re-applies (`applySort` = `updateHeaderState` + `reorder`/`resetOrder`, shared with the header click). Pane hook `_sort = { set, get }`; `workspace.setPaneSort`/`getPaneSort` via `_paneHook`; `table.sort` wraps that. Tests: `table.test.js` ("Configured and programmatic sort"), `pane-filters.test.js`.

Column visibility: one presentation state, `visible` — `null` (default: every non-`_mkio_` column in `columns` order, so columns that appear later show on their own) or an ordered array (exactly these; whatever the user hid, and whatever arrived since, stays out — so config can add a column without disturbing a saved layout). It replaced `displayOrder`: header reorder and hiding both materialise the list; "Show all" returns to `null`. `visibleColumns()` (cached on the identity of `columns`/`visible`, always reassigned) intersects the list with known columns — a name ahead of the data is kept but skipped — and every renderer, measurer, copier, and selection path goes through it. `visibleFromSpec`: a name or array (null/`""`/`[]` → all), rejecting non-strings and duplicates; a name not in configured `columns` warns but is kept; a bad spec warns `bad visible` and leaves the state alone; `defaultVisible` keeps the parsed config list. API: `setVisible`/`getVisible` (`null` in the default state so `set(get())` round-trips), `showColumns` (`insertShown`: after the nearest shown predecessor in `columns` order, else before the nearest follower, else last), `hideColumns` (the last visible column stays), `showAllColumns`, `resetVisible`; all via `applyVisible` = `closeDropdown` + `renderHead` + `initNewColWidths` (header-measures columns not in `headerMeasured`; stats already cover hidden columns, so one comes back at its old width) + `rebuildAllRows` + `render`. Seeded before the header first renders and on `mkui-pane-open`. Pane hook `_columns = { set, get }`; `workspace.setPaneColumns`/`getPaneColumns`; `table.columns`. Tests: `table.test.js`, `pane-filters.test.js`.

Columns button & picker: bulk column changes happen in one place. The **Columns button** (`.mkui-columns-btn`, `columns` icon + `.mkui-columns-badge` hidden count, tooltip "Columns: N of M shown", `disabled` until columns exist) sits in a right **gutter** of the scroll area: `.mkui-table-scroll` has `padding-right: var(--mkui-columns-gutter)` (32px, 4px more than the 28px button, since the last grip straddles the table edge by 3.5px), so the grip is never under the button — also scrolled fully right, end padding being scrollable overflow. The button hangs off `.mkui-columns-anchor`, a zero-height `position: sticky; top: 0; left: 0` block *before* the table, by `right: calc(-1 * gutter)`; its `::before` paints the 4px strip in header colours with `pointer-events: none`; `updateColumnsBtn` sets its height to the header's. Click toggles the **column picker** (`.mkui-columns-picker`, its own `picker` slot so it survives the re-render each change causes; it and a filter dropdown close each other): title ("Columns · N of M shown"); search (label/name; a group-label match keeps its whole group); an actions row mirroring the filter dropdown's — "Show all" / "Hide all" / "Reset", the first two re-labelled "Show/Hide N matching" and scoped to the matches while a query is typed; the list — flat in `columns` order, or one `.mkui-columns-group` per `colGroups()` entry: a head (fold caret, tri-state checkbox toggling the whole group, label, count) over items on an accent rail, folded unless it holds a shown column (`pickerExpanded`; a query unfolds matches). "Reset" = `resetVisible`; "Hide all" keeps the last column; unscoped "Show all" is **two-step** — first click arms ("Show all M? Confirm") for `SHOW_ALL_ARM_MS` (4s; a query disarms), second applies. Each header dropdown's `.mkui-filter-colops` row holds only "Hide column" (inert on the last column) — nothing under one column controls another. A filter chip on a hidden column shows the column before opening its dropdown.

Column groups: `groups = [{ label, columns }, …]` (ordered array of tables) categorises columns for the picker and nothing else — `visible` stays the truth. Parsed once into `colGroupsSpec`: a non-array warns `bad groups`; an entry without a string `label` and array `columns`, or with a non-string column, warns `bad groups[i]` and is dropped, as is a repeated label; a column already in a group warns and stays in the first. `colGroups()` is the runtime view: configured groups cut to known data columns, empty ones omitted, plus an implicit "Other"; `null` without columns or groups (flat picker). `inferColumns(row)` replaces `Object.keys` at the inference sites: with groups, grouped keys first in group order, then the rest (configured `columns` wins).

Sort & filter chips: the table's DOM is always a flex column — `.mkui-table-toolbar` (in the DOM only while it has buttons or chips; `syncToolbar`), `.mkui-table-scroll` holding the table, then progress or the paging bar — so the toolbar never scrolls. Buttons are its first children; `.mkui-table-chips` is last, pushed right by `margin-left: auto`. `renderChips` (from `updateHeaderState`) builds one `.mkui-chip-group` per kind — sort, filter — (`display: contents`), led by a `.mkui-chip-lead` pinning the group's clear button (`.mkui-chip-icon`, the kind's icon with an × badge) to its first chip. A chip holds `.mkui-chip-main` and `.mkui-chip-x`: sort chips flip / drop the key; filter chips open the column's dropdown / clear it. The toolbar is `flex-wrap: wrap`: the cluster sits beside the buttons when it fits, else drops to the next line whole — buttons never move, nothing scrolls horizontally. Guarded by `tests/styles.test.js`.

Range filters: numeric columns and columns whose every value is a time get a **Values | Range** switch. Range mode: `From`/`To` inputs (native date/time pickers on time columns), *Include empty*, *Clear*, and on time columns presets (Today, Last hour, Last 15 min). Typing applies after a 150ms debounce, Enter at once, and drops the preset. One filter per column, `{ kind: "values" | "range", … }`, described by `describeFilter`. Numeric `hi` is inclusive; time `hi` is *exclusive*, covering the whole unit typed (a date ends at the next midnight). Preset bounds resolve against the clock (memoised per second in `rangeBounds`); `syncPresetTimer` re-applies the view every 30s while a preset is active. Inference in `colStats`: `numeric` first, then `temporal`/`timeKind` (`bumpTemporal`: every non-empty value an mkio ref, ISO-8601 date/date-time, or bare `HH:MM[:SS[.f]]`). Nothing else is guessed; `types = { col = … }` declares it: `parse` (strptime over `%Y %m %d %H %M %S %f %z`), `unit` (epoch `s`/`ms`/`us`/`ns`), `tz` (`UTC` default, `local`, `+HH:MM`).

Filtering: each column header has one icon slot — the filter button, pinned right, showing the hamburger until the column is sorted, when `updateHeaderState` swaps in the sort caret. Either opens the same panel — search, "Select all"/"Clear", a checkbox per unique value — right-aligned under the button by `placeDropdown` after mount (the dropdown is `max-content` wide up to a CSS cap, so long values widen it; past the cap the list scrolls sideways, never wrapping). Dropdown lists (values, and the picker's) open at content height, capped by `fitList` so the dropdown ends `VIEWPORT_GAP` (8px) above `dropdownFloor()` — the app statusbar's top, else the viewport bottom: an inline `max-height` on `.mkui-filter-list` (`border-box`, floor `LIST_MIN_H` 40px, measured in values mode) that CSS `resize: vertical` honours, so the corner grip drags the list shorter; a dragged height is reapplied per kind (`listHeights`) on the next open, clamped to the cap; no static `max-height` in CSS. Changes apply immediately, an active filter tints the icon, columns filter independently, and filter state persists across resubscribes. A values filter records intent (`mode: "include" | "exclude"`): the dropdown starts (and "Select all" resets) in exclude mode — unchecking hides those values and everything else passes, including values never seen; "Clear" flips to include mode — checking shows only those. An empty exclusion is no filter; an inclusion always is.

Configured filters: `filters = { col = <filter> }` seeds the `filters` map at init (before data) and on `mkui-pane-open`. `filterFromSpec(col, spec)`: a list or `{ include }`/`{ exclude }` → a values filter; `from`/`to`/`empty`/`preset` → a range whose frame is `types[col].type`, else the entry's `type`, else inferred from the bounds (numbers → number, strings or a preset → time). Time bounds take the input-control forms (`YYYY-MM-DD`, `YYYY-MM-DD[T ]HH:MM[:SS]`, `HH:MM[:SS]`) via `inputToBound`, or epoch numbers on a `unit` column. A bad entry warns `bad filters.<col>` and is skipped; `null`/`""` clears the column. `filterToSpec` is the inverse, so `getFilters()` round-trips through `setFilters(map, { merge })` — replace by default, `merge` keeps other columns, a `null` entry under merge clears one. Pane hook `_filters = { set, get }`; `workspace.setPaneFilters(id, filters, opts)` (builds a never-shown pane first; `id == null` → the focused pane) and `getPaneFilters(id)`; `table.filter` wraps that.

Virtualized rows: only rows overlapping the viewport (plus 10 overscan) exist as DOM elements; two `.mkui-vspacer` rows carry the height of everything else. Data lives in a `rows` Map plus `baseOrder`; `view` is the filtered+sorted keys array that drives rendering. `render()` reconciles the visible slice, reusing keyed `tr`s so flash animations aren't restarted. Inserts/deletes/replaces do incremental `view` surgery (binary search when sorted); sort/filter changes mark the view dirty.

Column widths: once the header row exists (init with `columns`, else first data), each header is measured under `width: max-content` and locked via `<colgroup>` + `table-layout: fixed`, capped at 50% of the pane. From there columns only grow: `bumpStats` canvas-measures every ingested value and `growColWidth` ratchets up to fit, flushed once per render; never shrinks, skips `userSized` columns. In paged streams only the first data sizes columns (`growSuspended` during page loads; reopen re-arms). Widths never react to pane resizes: the table keeps `width: 100%` with no inline width, so used width is max(pane, sum of `<col>` widths) and a trailing auto-width filler (`.mkui-th-filler` + widthless `<col>`) absorbs the remainder (guarded by `tests/styles.test.js`). Each divider carries a `.mkui-col-resizer` grip resizing the column to its left, on the left edge of the *following* header cell (the filler carries the last); header cells must not be `overflow: hidden`. Widths are keyed by name in `colWidths` (reset on reopen). Double-clicking a grip auto-sizes the column (80% viewport cap), or every selected column inside a selection.

Column reorder: drag a header (pointer events, 5px threshold distinguishes drag from click); a ghost label and accent drop indicator show the target. Order persists across resubscribes in `visible` (the ordered visible-column list, see Column visibility), separate from the data-derived `columns`.

Paging (query): when `maxcount` is set (default 200), the client accumulates every page and fires `onSnapshot` once. `applySnapshot` ingests rows in `requestAnimationFrame`-batched chunks (≥100 per frame, scaled to finish within ~50 frames), showing "Loading N / Total…" meanwhile; a generation counter cancels stale chunk loops.

Paging (stream): when `maxcount` is set (default 200), a toolbar shows `◀ Earlier | time range | Later ▶ | ● Live | ⟳`. The initial fetch starts from local midnight (`start: "today"`, converted to UTC for the ref) or the beginning of the buffer (`start: ""`). The range label shows the visible rows' local timestamps with adaptive precision (`HH:MM` → `HH:MM:SS` → sub-second in 3-digit steps as the endpoints converge; cross-day ranges add the date; `No data` when empty) plus a boundary suffix `(start)`, `(end)`, or `(all)`.

Navigation is ref-based with no cursor stack: each page is its own `subscribe` via `fetchPage(ref, before)` with `onPage` — Later passes `lastRef`, Earlier passes `firstRef` with `before: true` — so pages stay correct as records change. Edge cases: starting from midnight leaves Earlier enabled on the first page; an empty initial fetch sets `firstRef` to the requested start ref; an empty backward fetch restores the previous page (`prevPageLoadRef`/`prevPageLoadBefore`) and disables Earlier via `noPrev`. `⟳` re-fetches the current page from `pageLoadRef`/`pageLoadBefore`; disabled in live mode.

`● Live` resumes streaming on the main `subid` from the page's `lastRef`. In live mode Later is disabled and Earlier fetches through a separate `pageSubId` (`fetchPrevLive`), prepending rows without interrupting the stream (`pageFetchPending` blocks double-clicks; `hasEarlierPages` drives the `HH:mm – Live` label). Exiting live unsubscribes both subids and re-fetches the saved page so inserts/deletes during live are reflected. Sort, filter, and column order persist across mode switches; pane reopen recalculates midnight.

Tail following: each subscription callback samples `shouldFollowTail()` *before* ingesting (stream + live, viewport within 8px of the bottom) and calls `scrollToTail()` after; otherwise `maybeRestoreScroll` runs. `goLive` sets `tailPending` to force one jump; a viewport scrolled up is never moved. Query/subpub never follow.

`live: true` still fetches the start page first and hands off from its `onPage` (`autoLivePending` — consumed on the first page, re-armed on pane reopen); going live straight from `sub()` would ignore `start` and replay the whole buffer. An empty start page leaves `lastRef` null, so the handoff seeds it from `getStartRef()`.

Disconnected indicator: the table subscribes to `mkio.connected`; when the socket drops in live mode the toolbar shows "Disconnected" instead of the Live dot, and live mode stays on so the saved page survives the reconnect. The subscription must be declared *after* all paging variables — `State.subscribe` fires its initial callback synchronously.

Visibility-aware subscriptions: an `IntersectionObserver` gates the subscription — a hidden pane doesn't subscribe until shown; hidden 5 minutes drops it (paged streams keep the current page across shorter hides). `mkui-pane-close` sets `closed` (blocks `sub()`/`fetchPage()`), disconnects the observer, and unsubscribes; `mkui-pane-open` clears `closed`, drops stale rows/sort/filter/paging state (including `lastRef`), and re-observes.

Stream ref-based resume: `lastRef` advances on every snapshot, delta, update, and `fetchPage` completion; `firstRef` on `fetchPage` completion. `sub()` with a non-null `lastRef` passes `ref: lastRef` and keeps existing rows; with null it clears state and subscribes from the beginning. Query and subpub never set `lastRef`.

Snapshot clearing: for query and subpub, `applySnapshot` clears rows, DOM, and selection first — auto-reconnect fires `onSnapshot` through the existing callbacks, bypassing `sub()`/`unsub()`, so deletes during an outage would otherwise linger. Streams append: a resumed snapshot holds only records after `lastRef`.

## Dialogs

`openDialog(spec, context, app, extra)` creates a modal dialog as a floating frame (`stayOnTop`, `noDock`). Resolves with the form data on submit, or `null` on cancel/close.

Field types: `hidden`, `readonly`, `select`, `checkbox`, `textarea`, `number`, text (default). Fields support `required`, `pattern`, `min`/`max`/`step`, `showWhen = "<expr>"` (scope: the form's fields by name, `form`, and the opening context; also on individual select options), `optionsFrom` (async service-backed options), and `optionsFromColumn` (values from table data).

Layout: `spec.fields` items are `{ group: "Header" }` section headers, `{ row: [field, field] }` horizontal rows (`field.width` sets flex proportion), or plain fields. Once the fields render, a body that would scroll grows the frame by the overflow (capped at 90% of the workspace) and re-centers it.

Submission: with `spec.submit.service` the dialog sends form data via `client.send()` (timeout default 5s; `submitPerRow` sends one request per selected row); errors show inline and the form stays open. Without a service it resolves at once with the form data.

Pin button: an `icon("pin")` toggle before maximize/close (active = rotated 45°, accent); while pinned, a *confirmed* submission resets the form instead of closing. Injected via `frameEl._extraControls`, which `_makeControls()` calls on every `_renderInternal`.

## Conventions

- Zero runtime dependencies; Web Components for framework-agnostic use
- Pointer guards: every mousedown/pointerdown that opens a menu or starts an action/drag checks `ev.button === 0` — right/middle clicks are inert (exception: the frame-raise mousedown raises on any button). Modified clicks are inert where the modifier has no meaning: sort headers ignore ctrl/cmd/alt (shift keeps multi-sort), the select-all corner ignores all modifiers. Guarded by `tests/pointer-guards.test.js` and `tests/table.test.js`
- Icons are inline SVGs from `lib/icons.js` (`icon(name)`), never text glyphs — `currentColor`, sized per context by `.mkui-icon` CSS. `.mkui-icon` keeps `pointer-events: none` so hit-testing lands on the hosting button (guarded by `tests/styles.test.js`)
- `registerPaneType(name, factory)` for custom content; `registerWidget(name, factory)` for lightweight inline widgets
- Built-in actions prefixed `pane.*` (show), `window.*` (tileH, tileV, grid, cascade), `table.*` (filter, sort), and `app.*` (quit)
- Layout tree invariant: every leaf sits inside a `{ type: "tabs", children: [...] }` — never bare strings after normalize
- CSS invariant: `mkui-menubar`/`mkui-statusbar` are `box-sizing: border-box` so their height equals `--mkui-menubar-h`/`--mkui-statusbar-h` exactly — the workspace is positioned by those, and a 1px overhang would paint over snapped frames' borders (guarded by `tests/styles.test.js`)
- Tests use `node:test` + `node:assert/strict`; no test framework dependency
