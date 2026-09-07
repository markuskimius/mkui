# CLAUDE.md

## Project overview

mkui is a config-driven, zero-dependency web GUI framework built with Web Components: a floating-frame workspace with dockable panes. Designed to pair with [mkio](../mkio) as the backend, but works standalone.

## Architecture

- **Workspace** (`<mkui-workspace>`) holds a z-ordered list of floating **frames**
- **Frames** (`<mkui-frame>`) are top-level chrome with 8-way resize handles; each owns an internal normalized layout tree. There is no dedicated titlebar — every top-edge tab bar doubles as a drag region, and the right-most one carries the window controls
- **Panes** (`<mkui-pane>`) are leaf content hosts inside frames; always wrapped in a TabGroup
- Pane elements are pooled at the workspace level with stable identity — `appendChild` moves them between frames
- Frame positions are fractions of the workspace; split ratios sum to 1, so proportional resize is automatic. Frame rects are *painted* in whole pixels (`applyFrameRect` rounds edges, not width/height, so snapped frames stay flush; a fractional size would leave a hairline).
- Every frame move/resize passes through `clampToDock`; nothing escapes the viewport
- Keyboard focus model: the top frame gets `[data-focused]` (`_applyZOrder`); each frame tracks an `_activeTabGroup` updated on interaction with a tab or within a pane. Hotkeys act on that group.
- Tab drag: pointer events (mouse + touch) on tabs (`touch-action: none`). Within a bar: ghost label + accent drop indicator, reorder on release; outside: tears the pane out into a new frame. On noDock frames (dialogs, login) the tab is titlebar text: mousedown moves the frame, click activates the tab; CSS must keep these tabs pointer-interactive (never `pointer-events: none`).
- Tab overflow: tabs shrink to `min-width: 3em`; past that `.mkui-tabs` clips and scroll arrows (`.mkui-tab-scroll`) appear, the bar getting `.mkui-tabbar-overflow` (`updateArrows` in `_renderTabBar`, which also scrolls the active tab into view).
- Tab rename: ctrl/cmd+click on a tab (plus `contextmenu` with `ctrlKey` on macOS) swaps the label for an inline input (`.mkui-tab-rename`); Enter/blur commits via `workspace.renamePane(id, title)`, Escape cancels.
- Tab strip look: flush tabs with rounded top corners and radial-gradient bottom flares in `::after`, colored by `--mkui-tab-bg`. The bar's bottom line is a `.mkui-tabbar::after` overlay (never a border): the selected tab gets `z-index: 1` and covers it. Selected tabs outside the keyboard-focused group flatten to the idle color. (`tests/styles.test.js`)
- Theming: `dark` and `light` come from `mkui.css` via `[theme=...]`. Custom themes go in `config.app.themes[name]` as `{ "--mkui-*": value }` overrides; `MkuiApp.setTheme(name)` applies them inline.

## Key files

Paths are under `mkui/static/src/` unless they start with `mkui/`.

- `mkui/__init__.py` — Python package; exposes `static_dir` and `__version__`
- `mkui/__main__.py` — CLI (`mkui init`, `mkui serve`)
- `layout/tree.js` — normalized tree math (normalize, find, insert, remove, layout); `layout/drag.js` — clamp, snap, drop-zone, frac↔rect helpers; both DOM-free
- `components/workspace.js` — frame lifecycle, z-order, arrangement, inter-frame drag routing, snap
- `components/frame.js` — frame chrome, internal tree rendering, splitter drag; defines `<mkui-pane>`
- `components/app.js` — shell: menubar + workspace + statusbar
- `core.js` — `App`, `State` (reactive store), widget/pane-type registries, expression re-exports
- `lib/expr.js` — mkio's expression language, vendored verbatim from `mkio/client/mkio-expr.mjs` (`tests/vendor-sync.test.js` checks); never edit it here — change mkio and re-copy
- `lib/expressions.js` — mkui's wrapper over the expression language (see Expressions)
- `lib/rich.js` — the `rich` expression type and the `mkui` UI function library, plus `renderRich` (DOM) and `richToHTML` (clipboard)
- `lib/timeparse.js` — time parsing for range filters (`detectTimeKind`, `parseTime`, input↔bound, `PRESETS`)
- `lib/icons.js` — `icon(name)` returns a currentColor `<svg>` from vendored path data (Lucide outlines + custom filled shapes)
- `lib/copy.js` — clipboard grids: `gridToTSV` (CRLF, Excel quoting), `gridToHTML`
- `widgets/mkio-table.js` — built-in `mkio-table` pane type: subscribes to mkio services, renders live tables
- `widgets/mkui-dialog.js` — `openDialog()`: config-driven modal dialogs with validation, RPC submission, pin-to-keep-open
- `auth.js` — config-driven login dialog; `showLogin()` runs before the app loads
- `layouts.js` — `LayoutManager`: `layout.*` actions, stores, startup restore
- `lib/layouts.js` — layout format, `sanitizeLayout`, `retained`, the stores
- `lib/links.js` — `LinkHub`: table-link bus (retained values per name, queued delivery, `MAX_CHAIN`); `App.links` owns one
- `mkui/control.py` — `ControlService` / `install(app)`: pushes actions to browsers (see Control channel)
- `mkio-bridge.js` — lazy-loads mkio's `/mkio.js` client
- `mkui/static/styles/mkui.css` — default theme via CSS custom properties

## Commands

- `mkui init [dir]` — scaffold a project (server.toml, config/client.toml, static/index.html)
- `mkui serve [dir] [-p PORT]` — serve a project via mkio
- `node --test tests/*.test.js` — run JS unit tests (node:test; `version.test.js` pins the four version strings)
- `python -m pytest tests/test_cli.py` — CLI tests
- `python -m build && twine upload dist/*`
- `cd mkui/static && python3 -m http.server 8000` — serve the examples
- Examples in `mkui/static/examples/` (`standalone-json`, `library-js`, `mkio-table`)

## Config format

Runtime input is JSON. `mkui serve` uses mkio's `[config]` routing — `/config/client.json` is served from `config/client.toml` (parsed with `tomllib`), so the browser never needs a TOML parser. TOML configs use `""` where JSON would use `null`.

Top-level keys: `app`, `state`, `auth` (optional), `menubar`, `statusbar`, `panes` (id→spec), `frames` (ordered array with position + layout tree), `mkio` (optional).

## Expressions

mkui uses mkio's expression language for everything conditional or derived in config (`lib/expr.js`, vendored; `tests/expressions.test.js` runs mkio's conformance fixtures). `lib/expressions.js` wraps it: one *lenient* `Env` (unknown names → NULL), compiled expressions/templates cached by source, `evalExpr` warns once per source and returns null on error, `resolveExpr` (pure `${x}` → raw value, NULL → `""`; mixed → string), `statePaths(src, {template})` lists the `state.<path>`s read. Scopes: `values`/`styles`/`display` (cell scope: `value`, `row`, `col`, `state`, then row fields), `rowStyle` (`row`, `state`, fields), `enable.when` (button scope, see Buttons), dialog `showWhen`/`value`/`title`/`footer.note` (form fields, `form`, context), action `data` (raw fields), text widget `text` (`state`). Extension: `registerExprFunction(name, fn, meta)`, `registerExprLibrary`, `registerExprType` — exported from `core.js`/`index.js`.

## Menubar

`menubar` is a top-level array of `{ label, items }` dropdowns.

Item keys:
- `label`; `action` (leaf items only) with optional `args`; `items` — child array, making a nested submenu (opens on hover, nests arbitrarily); `sep` — `true` renders a separator
- `windows` — `true` expands into one `pane.show` leaf per open pane (`workspace.openPanes()`, noDock excluded); popups rebuild per open.
- `layouts` — `true` expands into a submenu of saved layouts (state `layouts.list`; `layout.restore` leaves, `args` = id; empty → a `disabled` leaf); building fires `layout.refresh`.
- `disabled` — `true` renders an inert leaf; `shortcut` — right-aligned hint on leaf items (`.mkui-menu-shortcut`); `mod` renders platform-native via `formatShortcut` (`⌘C` / `Ctrl+C`). Display only: handlers accept either modifier.

Leaf items fire `app.fireAction(action, args)` on mouseup. Built-in actions: `app.quit`, `pane.show` (pane ID — switches to its tab and raises the frame, or opens a new frame if parked), `window.tileH`/`tileV`/`grid`/`cascade`, `edit.copy`, `edit.selectAll`, `edit.find`, `table.filter` (`{ pane, filters, merge }` → `workspace.setPaneFilters`; no `pane` targets the focused pane), `table.sort` (`{ pane, sort }`), `table.columns` (`{ pane, visible }`; no `visible` shows all), `table.expand` (`{ pane, depth }`), `table.link` (`{ pane, link, merge }` or the link keys flat → `workspace.setPaneLink`), `layout.*` (see Saved layouts). Custom actions: `app.registerAction(name, fn)`.

Edit routing: `edit.copy`/`edit.selectAll`/`edit.find` call `workspace.editAction(name)`, which resolves the focused frame's active pane (`workspace.activePaneEl()`) and invokes its `_editActions` hook (`{ copy, selectAll, clearSelection, find, findNext, findPrev }` — any pane type can implement it). The window keydown handler routes Ctrl/Cmd+C, +A, +F, +G, +Shift+G, and Escape through the same hook; editable elements and a native text selection win, and `preventDefault` fires only when a pane handled the action. `tests/edit-routing.test.js`.

## Statusbar

`statusbar` config keys: `left` / `right` (widget arrays) and `bindStyle` (CSS property → state path): each value is an inline style on `<mkui-statusbar>`; `null` or `""` removes it.

## mkio connection state

When `config.mkio.url` is present, `<mkui-app>` calls `ensureMkio` with `onConnect`/`onDisconnect` callbacks **before** setting up menubar, workspace, and statusbar — load-bearing: the bridge caches the first caller's promise. Callbacks get the `client` first.

Connection is two-phase: **connect** then **verify**. On WebSocket open, `mkio.connected` is set `true` and the `config.mkio.connected` state map applies; an async `_mkio` reqrep then queries the server's identity. Pass sets `mkio.verified` `true`; fail leaves it `false` and applies `config.mkio.incompatible`. Verification reruns on reconnect.

`config.mkio.expect` (`name` exact, `version`/`protocol`/`mkio` semver-compatible server-side, `expr` exact — mkui vendors `"1"`) is optional: the query still runs to fill `mkio.server.*`, timing out per `config.mkio.timeout` (5s). State maps `config.mkio.connected` / `.disconnected` / `.incompatible` are `"state.path": value` objects applied per lifecycle event.

## Authentication

When `config.auth` is present, `<mkui-app>` shows a login dialog before loading frames. `method: "mkio"` (default) calls `client.auth({username, password})` against mkio's `_mkio_users` (seed users `admin`/`password`, `user`/`password`); `method: "custom"` uses `app.registerAuthHandler({ authenticate({username, password}) })` → `{ user, role }`.

Config keys (under `auth`): `method`; `dialog` (`title`, `width`, `usernameLabel`, `passwordLabel`, `submitLabel`); `connected` — state map applied after login and on reconnect (mkio's client re-authenticates itself); `disconnected` — state map on disconnect (falls back to `mkio.disconnected`). State paths: `auth.authenticated`, `auth.user`, `auth.role`. Action `auth.logout` reloads the page. With auth enabled, `_mkio` verification is skipped — authentication proves the server; `mkio.connected` still applies on socket open.

Login dialog: a floating frame (`stayOnTop`, `noDock`), `_hideClose = true`, `_extraControls = () => []`: undismissable. With `mkio.control`, the control subscription waits for login.

## mkio-table pane type

Built-in pane type that subscribes to an mkio service and renders a live-updating table.

Config keys (under `panes.<id>`):
- `type` = `"mkio-table"` (required)
- `service` — mkio service to subscribe to (required)
- `protocol` — `"query"` (default), `"subpub"`, `"stream"`
- `topic` — string or array; required for subpub (one subscription per topic)
- `filter` — mkio filter expression (query)
- `columns` — column names to display; defaults to the first row's keys
- `labels` — column name → display label
- `maxcount` — page size for paged subscriptions (default 200, `null` disables)
- `start` — initial position for stream paged mode: `"today"` (default) starts from local midnight, `""` from the buffer's start
- `live` — `true` starts stream paged mode in live mode; see Paging
- `rowColumn` — `false` hides the row-number column (default `true`; the `table.test.js` harness passes `false` so assertions index cells directly)
- `values` — column → expression deriving it from the row; see Derived columns
- `styles` — column → styler (rule array or expression); `rowStyle` — one styler for the row; see Conditional styling
- `display` — column → `${...}` template controlling what a cell *shows*; see Display templates
- `select` — `{ state = "<path>" }` mirrors the current row into app state; see Selection publishing
- `types` — column → `"number"`, `"time"`, `"text"`, or `{ type = "time", parse, tz, unit }`; see Range filters
- `filters` — column → default filter: a value list, `{ include }` / `{ exclude }`, `{ from, to, empty, type }`, or `{ preset }`; see Configured filters
- `sort` — a column name (`"-col"` descending), `{ col, dir }`, or an array in priority order; see Configured sort
- `visible` — a name or array of columns to show, in order; absent/`""`/`[]` shows all and follows new ones; see Column visibility
- `groups` — picker categories, an ordered array of `{ label, columns }`; see Column groups
- `tree` — `{ child, parent, expand, filterScope, orphans, column }` nests rows by value; see Tree rows
- `link` — `{ broadcast, listen, broadcasting, listening }` couples tables by selection; see Table linking

Row identity: query `_mkio_row`, stream `_mkio_ref`, subpub `_mkio_topic`; `_mkio_*` columns are hidden. The header renders at init with `columns`, else on the first row.

Derived columns: `values = { col = "<expr>" }` derives a column with an expression in the cell scope — `value` (raw `row[col]`, NULL for a virtual column), `row`, `col`, `state`, then the row's fields. Every column read goes through `cellValue`, so a derived column behaves like a real field everywhere; a virtual one must be listed in `columns`. Button payloads carry raw row fields. A bad expression warns once.

Conditional styling: `styles = { col = <styler> }` styles a cell, `rowStyle = <styler>` the `tr`. A styler is a rule array evaluated first-match-wins — `{ when = "<expr>", ...style }`, no `when` = fallback — one expression yielding a style map (or NULL), or a plain map (one unconditional rule). Keys: `color`, `background`, `bold`, `italic`, `underline`, `strike`, `caps`, `class`, `css`; strings may be `${...}` templates. Cell rules see the cell scope; row rules `rowScope`. A rule whose condition errors warns once, never matches. Backgrounds are never inline: they ride `--mkui-cell-bg`/`--mkui-row-bg` plus `mkui-cell-styled`/`mkui-row-styled` marker classes placed *before* the selection rules so selection tints win (as does `.mkui-cell-match`; `tests/styles.test.js`).

Display templates: `display = { col = "<template>" }` controls presentation only — shown text, width stats, clipboard; sorting, filtering, and dropdown values use the value. Cell scope (`cellDisplay` → `{ text, rich, error }`). A template may yield a **rich** value — the `rich` type from `lib/rich.js` produced by the `mkui` library (`BOLD ITALIC UNDERLINE STRIKE COLOR BG MUTED MONO CLASS STYLE ICON BADGE BAR LINK HEAT`). `renderCell` builds spans via `renderRich` (segment colors inline on the span, never the td; badges/bars ride `--mkui-badge-color`, `--mkui-bar-frac`, `--mkui-bar-color`), keeping the flattened text on `td._mkuiText`. An error renders `#ERR` with the message as tooltip and warns once.

Selection publishing: `select = { state = "path" }` writes the current row into app state on every selection change: the cursor's row, else the first selected row in view order, else `null` (a reset, a delete of the published row, and closing the pane publish `null`). Filter changes republish after pruning, a live replace of that row republishes; deduped on identity.

Numeric alignment: all-numeric columns right-align with per-cell right padding (`--mkui-num-pad`, in ch) so decimals line up (`colStats.maxFrac`); the filter dropdown pads left the same way. Flash classes: `mkui-flash-in` / `-out` / `-update`. Each pane gets a unique `subid`.

Selection: two exclusive modes plus an always-present **focused cell** (`.mkui-cell-focus`), the *implicit* selection copy, row-unit buttons, and broadcasts fall back to. Row mode: the sticky-left **row-number column** (`rowColumn: false` disables; view position, or per-level positions in a tree; outside stats/reorder/resize) selects rows — click / ctrl-toggle / shift-range / drag-range, header corner selects all. Cell mode: click places the focus (its row gets `.mkui-row-hl`; `handleRowPointerDown` climbs `closest("td")`), drag extends a rect, ctrl/cmd-click adds rects or toggles cells off, shift extends from the anchor. Rects are anchor/focus `(key, col)` pairs plus a `keys` snapshot of the rows spanned when last user-modified (`snapRectKeys`): membership is that record set × the column range, so sorts/filters move the same records and live inserts inside don't join; `rectBounds` resolves keys to view-index runs, cached. Keyboard: arrows/Home/End/PageUp/PageDown move, shift extends, Space selects the focused row (ctrl toggles), Escape clears selection, keeps the cursor. Filter changes prune `selectedKeys`; copy and actions see view rows only.

Clipboard: `copySelection` builds a grid — row mode: selected rows × visible columns plus a `labels` header; cell mode: bounding grid, blanks outside the rects; fallback: the focused cell — written as TSV and HTML via `ClipboardItem` (`lib/copy.js`; over 100k rows skip HTML); `status.message` shows "Copied N rows/cells".

Buttons: `enable.when = "<expr>"` gates a button on the selection — scope `rows`, `row` (first or NULL), `cells`, `selection` `{ count, rowCount, cellCount, unit }`, `connected`, `state` — plus the flags `connected`, `minSelected`, `maxSelected`. `unit`: `"rows"` (default), `"row"`, `"cells"`, `"cell"` — singular units default min/max to 1. Row units receive the rows the selection implies (explicit rows, else rows containing selected cells, else the focused cell's row); cell units get `cells: [{ row, column, value }]` plus `cell`, a request per cell. Gates re-evaluate on selection, filter, and connection changes and on a live replace/delete of a selected row. `style = <styler>` (compiled lazily in `updateButtonStates`, applied with the gate) sees the button scope plus `enabled`; backgrounds ride `--mkui-btn-bg` + `mkui-btn-styled` (hover/press still tint).

Sorting: click a header to cycle ascending → descending → none; shift+click adds secondary keys, the priority a digit in the caret (`.mkui-sort-num`). Numeric vs string comparison is auto-detected. New rows insert in sorted position.

Configured sort: `sort = <spec>` seeds `sortKeys` at init and on `mkui-pane-open` (`loadSortSpec`); `sortFromSpec` takes a column name (`"-col"` → desc), `{ col, dir }`, or an array in priority order — a bad spec warns `bad sort`, changes nothing. `getSort()` → `[{ col, dir }]`; `setSort(spec)` replaces and re-applies (`applySort`). Hook `_sort = { set, get }`; `workspace.setPaneSort`/`getPaneSort`; `table.sort`.

Column visibility: one presentation state, `visible` — `null` (default: every non-`_mkio_` column in `columns` order, so later columns show on their own) or an ordered array (exactly these; whatever the user hid or arrived since stays out). Header reorder and hiding materialise the list; "Show all" returns to `null`. `visibleColumns()` (cached per `columns`/`visible` identity) intersects the list with known columns — a name ahead of the data is kept but skipped — and every renderer, measurer, copier, and selection path uses it. `visibleFromSpec`: a name or array (null/`""`/`[]` → all); non-strings or duplicates warn `bad visible`, change nothing. API: `setVisible`/`getVisible` (`null` in the default state), `showColumns` (`insertShown` places by `columns`-order neighbours), `hideColumns` (the last visible column stays), `showAllColumns`, `resetVisible` (to `defaultVisible`); all via `applyVisible`. Seeded before the header first renders and on `mkui-pane-open`. Hook `_columns = { set, get }`; `workspace.setPaneColumns`/`getPaneColumns`; `table.columns`.

Columns button & picker: The **Columns button** (`.mkui-columns-btn`, `columns` icon + `.mkui-columns-badge` hidden count, `disabled` until columns exist) sits in a right **gutter** of the scroll area (`--mkui-columns-gutter`, 26px) off `.mkui-columns-anchor`, a zero-height sticky block before the table; `updateColumnsBtn` matches the header height. Click toggles the **column picker** (`.mkui-columns-picker`, own `picker` slot; it and a filter dropdown close each other): title, search (label/name; a group-label match keeps its group), an actions row — "Show all" / "Hide all" / "Reset", the first two scoped to matches under a query — and the list: flat in `columns` order, or one `.mkui-columns-group` per `colGroups()` entry (fold caret, tri-state checkbox, count; folded unless it holds a shown column, `pickerExpanded`). "Hide all" keeps the last column; unscoped "Show all" is **two-step** (`SHOW_ALL_ARM_MS`, 4s; a query disarms). Each header dropdown's `.mkui-filter-colops` row holds "Hide column" (inert on the last) and the two link ops (see Table linking) — all scoped to that column. A chip on a hidden column shows it before opening its dropdown.

Column groups: `groups = [{ label, columns }, …]` categorises columns for the picker only — `visible` stays the truth. Parsed once into `colGroupsSpec` (bad entries warn `bad groups[i]`, dropped; a column in two groups keeps the first). `colGroups()`: configured groups cut to known columns, empty ones omitted, plus an implicit "Other". `inferColumns(row)` orders inferred columns grouped keys first.

Tree rows: `tree = { child, parent }` (names or equal-length lists) nests rows: all `child` fields empty → root; else the parent is the first row whose `parent` fields match (`byParentVals`). Maps beside `rows`: `parentOf` (null = root, `undefined` = hidden orphan), `kids` (`null` → roots), `depthOf`, `expanded`, `pendingKids` (children awaiting a parent — `linkRow` adopts them; `orphans` `"root"` shows them meanwhile, `"hide"` doesn't). `unlinkRow` re-homes a deleted parent's children; a cycle warns once, stays a root. **`view` is the pre-order flattening of rows whose ancestors are all expanded** (`rebuildView` → `flattenVisible` over `sortedKids`, cached), so selection, keyboard, copy, and buttons see only shown rows; `viewIndexOf` is linear in a tree. Incremental: `insertRow` → `linkRow` then `treeInsertIntoView`; re-parenting or a sort-key change marks the view dirty. `setExpanded` splices the subtree in or cuts its run, `pruneSelection` dropping hidden keys (the cursor climbs to the collapsed row); `setExpandDepth` for bulk. Row numbers are positions per level (`1`, `5.3`, `5.3.1`) among *all* siblings in sort order — a filtered row keeps its slot: `rankOf` (`shiftRanks` on live insert/delete); `render` labels via `rowLabel`, ratchets `rowNumDigits`. A flat table numbers by view position until a filter is active, then by `rankOf` (`flatRanks`). Filters carry `scope` (`roots` default / `children` / `all`; `tree.filterScope` overrides): `matchesFilters` judges `roots`/`children` by level (a miss hides the subtree), `all` goes through `buildSubtreeOk` in `rebuildView` (post-order: ok when the row passes or any child is ok), so while one is active every data change rebuilds (`allScopeActive`). `describeFilter` appends a non-default scope. `filters` is keyed `fkey(col, scope)`, each filter carrying `col`/`scope` (`colFilters(col)`): a column holds up to three, its spec may be an array of filter objects (`filtersFromSpec`), and an entry replaces the column's filters. The dropdown's `.mkui-filter-scopes` row (Top / Child / Branch) is tabs, one filter each (`dropdownScope`; set tabs `.mkui-filter-scope-set`), shown on alt/option-click of button or chip (`openFilterDropdown(col, th, { advanced, scope })`) or when the column is filtered off `roots`. UI: caret column = `tree.column` when visible, else the first visible (`treeCol`); `.mkui-tree-cell` carries `--mkui-tree-depth`, a `.mkui-tree-toggle` (`.open`; `.mkui-tree-leaf`) and the `.mkui-tree-text` span `renderCell` writes to (`td._mkuiTreeText`); `syncToggle`/`syncDepth` refresh reused `tr`s. Header `.mkui-tree-all`: opens all roots / closes all, shift every level; Enter toggles a row, `*` opens its subtree. `expand` (depth or `"all"`) applies as rows link. Hook `_tree = { expand, toggle, expanded }`; `workspace.expandPane`; `table.expand`. Not in layouts.

Find: `_editActions.find` (Ctrl/Cmd+F, `edit.find`) opens `.mkui-table-find` between toolbar and scroll area, in the DOM only while open (`findOpen`; `syncToolbar` inserts ahead of it): `.mkui-find-input`, two `.mkui-find-toggle`s (`.*` regex, `Aa` case; `.active`), `.mkui-find-count`, `.mkui-find-btn`s, `.mkui-find-close`. `compileFind` builds one RegExp (invalid → `.mkui-find-error`). `scanFind` fills `findMatches` `[{ key, col, idx }]` — header matches first (`key` null), then `view` × `visibleColumns()` on the shown text — in rAF chunks (`FIND_CHUNK`). `findScanRev` = the `viewRev` scanned: `render` schedules a `FIND_DATA_MS` rescan when it drifts, `applyVisible` rescans at once; the current match (`findPos`) survives by identity. `findGo(dir)` steps and wraps, else starts at the cursor; `showMatch` = cursor move + scroll. `styleRowSelection` toggles `.mkui-cell-match` off `td._mkuiText`; `refreshFindHeaderStyles` sets `.mkui-th-match` / `-current`. Input debounce `FIND_INPUT_MS`; Enter / shift+Enter step; Escape closes. `findNext`/`findPrev` hooks (`findStep`: Ctrl/Cmd+G / +Shift+G; closed → reopen on the last query, then step); F3 in the table, where `clearSelection` closes once nothing is selected. Closed on pane close/open; not in layouts.

Sort & filter chips: the table's DOM is a flex column — `.mkui-table-toolbar` (in the DOM only while it has buttons or chips; `syncToolbar`), `.mkui-table-scroll`, then progress or the paging bar. Buttons first; `.mkui-table-chips` last, pushed right. `renderChips` (from `updateHeaderState`) builds a `.mkui-chip-group` per kind — sort, filter, link — led by a `.mkui-chip-lead` with the group's clear button. A chip holds `.mkui-chip-main` and `.mkui-chip-x`: sort chips flip / drop the key; filter chips open the dropdown / clear. (`tests/styles.test.js`)

Range filters: numeric columns and columns whose every value is a time get a **Values | Range** switch. Range mode: `From`/`To` inputs (native date/time pickers on time columns), *Include empty*, *Clear*, time presets (Today, Last hour, Last 15 min). Typing applies after a debounce, Enter at once; both drop the preset. A filter is `{ kind: "values" | "range", … }`, described by `describeFilter`. Numeric `hi` is inclusive; time `hi` is *exclusive*, covering the whole unit typed. Preset bounds resolve against the clock (memoised per second in `rangeBounds`); `syncPresetTimer` re-applies the view every 30s while a preset is active. Inference in `colStats`: `numeric` first, then `temporal`/`timeKind` (`bumpTemporal`: every non-empty value an mkio ref, ISO-8601 date/date-time, or bare `HH:MM[:SS[.f]]`); nothing else is guessed — `types = { col = … }` declares `parse` (strptime), `unit` (epoch `s`/`ms`/`us`/`ns`), `tz` (`UTC` default, `local`, `+HH:MM`).

Filtering: each column header has one icon slot — the filter button, pinned right, a hamburger until the column is sorted, when `updateHeaderState` swaps in the sort caret. Either opens the same panel — search, "Select all"/"Clear", a checkbox per value — placed by `placeDropdown`. Lists (values and picker) open at content height, capped by `fitList` to end `VIEWPORT_GAP` above `dropdownFloor()` (statusbar top, else viewport bottom) via an inline `max-height` on `.mkui-filter-list` that CSS `resize: vertical` honours; a dragged height is reapplied per kind (`listHeights`). Changes apply immediately, an active filter tints the icon, and filter state persists across resubscribes. A values filter records intent (`mode: "include" | "exclude"`): the dropdown starts (and "Select all" resets) in exclude mode — unchecking hides those values, unseen values pass; "Clear" flips to include mode — checking shows only those. An empty exclusion is no filter; an inclusion always is.

Configured filters: `filters = { col = <filter> }` seeds the `filters` map at init (before data) and on `mkui-pane-open`. `filterFromSpec(col, spec)`: a list or `{ include }`/`{ exclude }` → a values filter; `from`/`to`/`empty`/`preset` → a range framed by `types[col].type`, else the entry's `type`, else the bounds (numbers → number, strings or a preset → time). Time bounds take the input forms (`YYYY-MM-DD`, `YYYY-MM-DD[T ]HH:MM[:SS]`, `HH:MM[:SS]`) via `inputToBound`, or epoch numbers on a `unit` column. A bad entry warns `bad filters.<col>`; `null`/`""` clears. `filterToSpec` is the inverse, so `getFilters()` round-trips through `setFilters(map, { merge })` — replace by default; `merge` keeps other columns, a `null` entry clearing one. Hook `_filters = { set, get }`; `workspace.setPaneFilters(id, filters, opts)` (builds a never-shown pane first; `id == null` → the focused pane), `getPaneFilters(id)`; `table.filter`.

Virtualized rows: only rows overlapping the viewport (plus overscan) exist in the DOM; two `.mkui-vspacer` rows carry the rest's height. Data lives in a `rows` Map plus `baseOrder`; `view` is the filtered+sorted key array driving rendering. `render()` reconciles the visible slice, reusing keyed `tr`s. Inserts/deletes/replaces patch `view`; sort/filter changes mark it dirty.

Column widths: once the header row exists (init with `columns`, else first data), each header is measured under `width: max-content` and locked via `<colgroup>` + `table-layout: fixed`, capped at 50% of the pane. From there columns only grow: `bumpStats` canvas-measures every ingested value and `growColWidth` ratchets up, flushed once per render; never shrinks, never touches `userSized` columns. In paged streams only the first data sizes columns (`growSuspended`). Widths ignore pane resizes: the table keeps `width: 100%` with no inline width, and a trailing auto-width filler (`.mkui-th-filler` + widthless `<col>`) absorbs the rest (`tests/styles.test.js`). Each divider carries a `.mkui-col-resizer` grip resizing the column to its left, on the left edge of the *following* header cell (the filler carries the last); header cells must not clip overflow. `colWidths` is keyed by name (reset on reopen). Double-clicking a grip auto-sizes the column (80% viewport cap), or every selected column.

Column reorder: drag a header (5px threshold separates drag from click); ghost label + accent drop indicator. Order persists in `visible`.

Paging (query): with `maxcount` (default 200) the client accumulates every page, firing `onSnapshot` once. `applySnapshot` ingests rows in rAF chunks, showing "Loading N / Total…"; a generation counter cancels stale loops.

Paging (stream): with `maxcount` (default 200) a toolbar shows `◀ Earlier | time range | Later ▶ | ● Live | ⟳`. The initial fetch starts from local midnight (`start: "today"`, a UTC ref) or the buffer's start (`start: ""`). The range label shows the visible rows' local timestamps at adaptive precision (cross-day adds the date; `No data` when empty) plus `(start)`, `(end)`, or `(all)`.

Navigation is ref-based, no cursor stack: each page is its own `subscribe` via `fetchPage(ref, before)` with `onPage` — Later passes `lastRef`, Earlier `firstRef` with `before: true`. An empty initial fetch sets `firstRef` to the start ref; an empty backward fetch restores the previous page (`prevPageLoadRef`/`prevPageLoadBefore`) and sets `noPrev`. `⟳` re-fetches from `pageLoadRef`/`pageLoadBefore`; off in live mode.

`● Live` resumes streaming on the main `subid` from the page's `lastRef`. Live disables Later; Earlier fetches through a separate `pageSubId` (`fetchPrevLive`), prepending rows without a stream break (`pageFetchPending` blocks double-clicks). Exiting live unsubscribes both and re-fetches the saved page; sort, filter, and column order persist.

Tail following: each subscription callback samples `shouldFollowTail()` *before* ingesting (stream + live, viewport near the bottom), then `scrollToTail()`, else `maybeRestoreScroll`; `goLive` sets `tailPending` for one jump. Query/subpub never follow.

`live: true` fetches the start page first and hands off from its `onPage` (`autoLivePending`, re-armed on reopen); going live from `sub()` would replay the whole buffer. An empty start page seeds `lastRef` from `getStartRef()`.

Disconnected indicator: the table subscribes to `mkio.connected`; a drop in live mode shows "Disconnected" instead of the Live dot, live mode staying on. Declare the subscription *after* all paging variables — `State.subscribe` fires its initial callback synchronously.

Visibility-aware subscriptions: an `IntersectionObserver` gates the subscription — a hidden pane doesn't subscribe until shown; hidden 5 minutes drops it. `mkui-pane-close` sets `closed` (blocks `sub()`/`fetchPage()`), disconnects the observer, unsubscribes; `mkui-pane-open` clears `closed`, drops stale rows/sort/filter/paging/tree/find state (links stay), re-observes.

Stream ref-based resume: `lastRef` advances on every snapshot, delta, update, and `fetchPage`; `firstRef` on `fetchPage`. `sub()` with a `lastRef` passes `ref: lastRef` and keeps rows; without one it clears and subscribes from the start. Query/subpub never set it.

Snapshot clearing: for query and subpub, `applySnapshot` clears rows, DOM, selection first — auto-reconnect fires `onSnapshot` without `sub()`, so outage deletes would linger; streams append.

## Table linking

`link = { broadcast = { name = col }, listen = { name = col | { column, scope } }, broadcasting, listening }` on a table (`linkFromSpec`; bad → warns `bad link`). `App.links` is the `LinkHub`: `publish(source, { name: values | null })` retains per name (only the owning source retracts; repeats skipped), queues delivery (no nested callbacks; `MAX_CHAIN` cuts a loop), mirrors `state.link.<name>`. `linkSource` = pane `data-id`, else `subid`. **Broadcast**: `broadcastSelection()` from `publishSelection` and a live replace of a selected row — `getSelectedRows()` → distinct `cellText` per name in view order; null when empty / paused / closed. **Listen**: `onLinkDelivery` (ignores own source, paused, closed) → `putLinkFilter(name, values)`: an include filter marked `link: name` at `fkey(column, scope)`, displacing the column's filter into `linkStash` (restored in place on null); `refreshLinkFilters` catches up from `hub.current` at init, `mkui-pane-open`, toggles. Linked filters: skipped by `getFilters`, kept by replace-mode `loadFilterSpecs` unless an entry names the column; user edits (`dropLinkStash`) take the marker off. `describeFilter` appends `(linked: name)`; header btn `.mkui-filter-linked`. Hook `_link = { set, get }` (`setLink(spec, { merge })`: null entries drop names); `workspace.setPaneLink`/`getPaneLink`; layouts save `panes[id].link` (config, never the filters). UI: `.mkui-chips-link` group (lead `link` icon = remove all), one `.mkui-chip-link.mkui-chip-{broadcast,listen}` per direction (`makeLinkChip`: main click toggles, `.mkui-chip-off`; × removes, `.mkui-chip-arm` two-step past one name); `.mkui-th-linkmark` (`updateLinkMark`, `radio`/`ear` icons, `.mkui-link-off`); dropdown colops `makeLinkOp` (`.mkui-link-op`, inline `.mkui-link-input`; listen offers `hub.names()` as a datalist). Pane close: `hub.retract`, unsubscribe. `tests/links.test.js`, table tests "links:".

## Control channel

`config.mkio.control = "<service>"` → `<mkui-app>._subscribeControl` subscribes (subpub, `subid` `mkui-control`, no topic — the client routes topic-keyed subs by `row._mkio_topic`) after connect, or after login under auth; each `update` row `{ action, args }` → `app.fireAction`. Server: `mkui.control.ControlService` (config `{ protocol = "subpub", access = "auth" }`; `on_subscribe` answers an empty snapshot, `send(action, args, user=)` pushes `make_update(op="action")`, `link(pane, …)` builds `table.link`); `install(app)` registers it, returns a late-binding handle; `cmd_serve` installs it. `tests/test_control.py`.

## Saved layouts

`[layouts]` in config enables it (`store` `"mkio"` when `mkio.url` else `"local"`; rest in the README). Saves are unnamed: the owner's layout is their newest entry. `workspace.getLayout()` → `{ version, frames: [{ id, title, x, y, w, h, layout }], focused, panes: { id: { filters, sort, visible, link } } }`: docked frames in z-order (noDock/stayOnTop excluded); view state via the `_filters`/`_sort`/`_columns`/`_link` hooks for open panes only; never a paged table's position. `sanitizeLayout` (lib/layouts.js) throws on a non-layout, drops unknown pane ids. `setLayout(layout, { reopen })` diffs open panes: staying panes move silently, leaving get `mkui-pane-close`, arriving `mkui-pane-open` *then* the saved state, deferred on `el._ready` while an async factory installs hooks. `resetLayout()` = config `frames`, `reopen: true`. `LayoutManager` (src/layouts.js): owner = `auth.user` if authenticated, else `""`; `save` skips a layout `sameLayout` to the newest, then prunes by `retained` (newest `keep` **or** last `keepDays`); `LocalLayoutStore` / `MkioLayoutStore` (`send`/`request` *resolve* with error envelopes). `<mkui-app>` defers frames; `_loadFrames` applies `restoreLatest()` (bounded by `timeout`), else the config frames.

## Dialogs

`openDialog(spec, context, app, extra)` creates a modal dialog as a floating frame (`stayOnTop`, `noDock`); resolves with the form data on submit, `null` on cancel/close.

Field types: `hidden`, `readonly`, `select`, `checkbox`, `textarea`, `number`, text (default); `required`, `pattern`, `min`/`max`/`step`, `showWhen = "<expr>"` (scope: the fields by name, `form`, the opening context; also on select options), `optionsFrom` (async, service-backed), `optionsFromColumn` (table values). `spec.fields` items are `{ group }` headers, `{ row: [...] }` rows (`field.width` = flex proportion), or fields; a body that would scroll grows the frame (≤ 90% of the workspace). With `spec.submit.service` the dialog sends via `client.send()` (timeout 5s; `submitPerRow` = a request per selected row), errors inline; without one it resolves at once.

Pin button: an `icon("pin")` toggle before maximize/close; pinned, a *confirmed* submission resets the form instead of closing. Injected via `frameEl._extraControls`.

## Conventions

- Zero runtime dependencies; Web Components for framework-agnostic use
- Pointer guards: every mousedown/pointerdown that opens a menu or starts an action/drag checks `ev.button === 0` (exception: the frame-raise mousedown raises on any button). Modified clicks are inert where the modifier means nothing: sort headers ignore ctrl/cmd/alt (shift keeps multi-sort), the select-all corner ignores all modifiers. `tests/pointer-guards.test.js`
- Icons are inline SVGs from `lib/icons.js` (`icon(name)`), never text glyphs — `currentColor`, sized by `.mkui-icon` CSS, which keeps `pointer-events: none` so hits land on the hosting button (`tests/styles.test.js`)
- `registerPaneType(name, factory)` for custom content; `registerWidget(name, factory)` for inline widgets
- Layout tree invariant: every leaf sits inside a `{ type: "tabs", children: [...] }` — never bare strings after normalize
- CSS invariant: `mkui-menubar`/`mkui-statusbar` are `box-sizing: border-box` so their height equals `--mkui-menubar-h`/`--mkui-statusbar-h` exactly — the workspace is positioned by those; an overhang would paint over snapped frames' borders (`tests/styles.test.js`)
- Tests: `node:test` + `node:assert/strict`
