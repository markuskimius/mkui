# CLAUDE.md

## Project overview

mkui is a config-driven, zero-dependency web GUI framework built with Web Components: a floating-frame workspace with dockable panes. Designed to pair with [mkio](../mkio) as the backend, but works standalone.

## Architecture

- **Workspace** (`<mkui-workspace>`) holds z-ordered floating **frames**
- **Frames** (`<mkui-frame>`) are top-level chrome with 8-way resize handles, each owning an internal normalized layout tree. No dedicated titlebar — every top-edge tab bar doubles as a drag region, the right-most carrying the window controls
- **Panes** (`<mkui-pane>`) are leaf content hosts inside frames, always wrapped in a TabGroup
- Pane elements are pooled at workspace level with stable identity, `appendChild` moving them between frames
- Frame positions are fractions of the workspace and split ratios sum to 1, so proportional resize is automatic. Frame rects are *painted* in whole pixels (`applyFrameRect` rounds edges, not width/height, so snapped frames stay flush).
- Every frame move/resize passes through `clampToDock`
- Focus model: the top frame gets `[data-focused]` (`_applyZOrder`); each frame tracks an `_activeTabGroup` updated on interaction with a tab or pane, and hotkeys act on that group.
- Tab drag: pointer events (mouse + touch) on tabs (`touch-action: none`). Within a bar, a ghost label + accent drop indicator reorder on release; outside, the pane tears into a new frame. On noDock frames (dialogs, login) the tab is titlebar text: mousedown moves the frame, click activates the tab, and CSS must keep these tabs pointer-interactive (never `pointer-events: none`).
- Tab overflow: tabs shrink to `min-width: 3em`; past that `.mkui-tabs` clips, `.mkui-tab-scroll` arrows appear and the bar gets `.mkui-tabbar-overflow` (`updateArrows` in `_renderTabBar`). Rename: ctrl/cmd+click (`contextmenu` + `ctrlKey` on macOS) swaps the label for `.mkui-tab-rename`, Enter/blur committing via `workspace.renamePane`.
- Tab strip look: the bar's bottom line is a `.mkui-tabbar::after` overlay (never a border) the selected tab covers (`z-index: 1`); selected tabs outside the focused group flatten to idle. (`tests/styles.test.js`)
- Theming: `dark`/`light` come from `mkui.css` via `[theme=...]`. Custom themes go in `config.app.themes[name]` as `{ "--mkui-*": value }` overrides, applied inline by `MkuiApp.setTheme(name)`.

## Key files

Paths are under `mkui/static/src/` unless they start with `mkui/`.

- `mkui/__init__.py` — Python package; `static_dir`, `__version__`
- `mkui/__main__.py` — CLI (`init`, `serve`)
- `layout/tree.js` — normalized tree math (normalize, find, insert, remove, layout); `layout/drag.js` — clamp, snap, drop-zone, frac↔rect helpers; both DOM-free
- `components/workspace.js` — frame lifecycle, z-order, arrangement, inter-frame drag routing, snap
- `components/frame.js` — frame chrome, internal tree rendering, splitter drag; defines `<mkui-pane>`
- `components/app.js` — shell: menubar + workspace + statusbar
- `core.js` — `App`, `State` (reactive store), widget/pane-type registries, expression re-exports
- `lib/expr.js` — mkio's expression language, vendored verbatim from `mkio/client/mkio-expr.mjs` (`tests/vendor-sync.test.js`); never edit here, change mkio and re-copy
- `lib/expressions.js` — mkui's wrapper over the expression language (see Expressions)
- `lib/rich.js` — the `rich` expression type, the `mkui` UI function library, `renderRich` (DOM), `richToHTML` (clipboard)
- `lib/timeparse.js` — range-filter time parsing (`detectTimeKind`, `parseTime`, input↔bound, `PRESETS`)
- `lib/icons.js` — `icon(name)` → a currentColor `<svg>` from vendored path data (Lucide + custom)
- `lib/copy.js` — clipboard grids: `gridToTSV` (CRLF, Excel quoting), `gridToHTML`
- `widgets/mkio-table.js` — the `mkio-table` pane type: subscribes to mkio services, renders live tables
- `widgets/mkui-dialog.js` — `openDialog()`: config-driven, live-updating modal forms (see Dialogs)
- `auth.js` — config-driven login dialog; `showLogin()` runs before the app loads
- `layouts.js` — `LayoutManager`: `layout.*` actions, stores, startup restore
- `lib/layouts.js` — layout format, `sanitizeLayout`, `retained`, the stores
- `lib/links.js` — `LinkHub`, the table-link bus (retained values per name, queued delivery, `MAX_CHAIN`); `App.links` owns one
- `mkui/control.py` — `ControlService` / `install(app)`, pushing actions to browsers (see Control channel)
- `mkio-bridge.js` — lazy-loads mkio's `/mkio.js` client
- `mkui/static/styles/mkui.css` — default theme, CSS custom properties

## Commands

- `mkui init [dir]` — scaffold a project (server.toml, config/client.toml, static/index.html)
- `mkui serve [dir] [-p PORT]` — serve a project via mkio
- `node --test tests/*.test.js` — JS unit tests (`version.test.js` pins the four version strings)
- `python -m pytest tests/test_cli.py` — CLI tests
- `python -m build && twine upload dist/*`
- `cd mkui/static && python3 -m http.server 8000` — serve `mkui/static/examples/` (`standalone-json`, `library-js`, `mkio-table`)

## Config format

Runtime input is JSON. `mkui serve` uses mkio's `[config]` routing: `/config/client.json` comes from `config/client.toml` (via `tomllib`), so the browser needs no TOML parser. TOML configs use `""` where JSON would use `null`.

Top-level keys: `app`, `state`, `auth` (optional), `menubar`, `statusbar`, `panes` (id→spec), `frames` (ordered array with position + layout tree), `mkio` (optional).

## Expressions

mkui uses mkio's expression language for everything conditional or derived in config (`lib/expr.js`, vendored; `tests/expressions.test.js` runs mkio's conformance fixtures). `lib/expressions.js` wraps it: one *lenient* `Env` (unknown names → NULL), compiled expressions/templates cached by source, `evalExpr` (warns once per source, null on error), `resolveExpr` (pure `${x}` → raw value, NULL → `""`; mixed → string), `statePaths(src, {template})` listing the `state.<path>`s read. Scopes: `values`/`styles`/`display` (cell scope: `value`, `row`, `col`, `state`, then row fields), `rowStyle` (`row`, `state`, fields), `enable.when` (button scope, see Buttons), dialog `showWhen`/`value`/`title`/`footer.note` (form fields, `form`, context), action `data` (raw fields), text widget `text` (`state`). Extension: `registerExprFunction(name, fn, meta)`, `registerExprLibrary`, `registerExprType`, exported from `core.js`/`index.js`.

## Menubar

`menubar` is a top-level array of `{ label, items }` dropdowns. Item keys:
- `label`; `action` (leaf items only) with optional `args`; `items` — a child array, the nested submenu opening on hover and nesting arbitrarily; `sep` — `true` renders a separator
- `windows` — `true` expands into one `pane.show` leaf per open pane (`workspace.openPanes()`, noDock excluded), rebuilt per open.
- `layouts` — `true` expands into a submenu of saved layouts (state `layouts.list`; `layout.restore` leaves, `args` = id; empty → a `disabled` leaf), firing `layout.refresh`.
- `disabled` — an inert leaf; `shortcut` — right-aligned hint (`.mkui-menu-shortcut`), `mod` rendering it platform-native via `formatShortcut`. Display only; handlers accept either modifier.

Leaf items fire `app.fireAction(action, args)` on mouseup. Built-ins: `app.quit`, `pane.show` (pane ID: switches to its tab and raises the frame, or opens a new frame if parked), `window.tileH`/`tileV`/`grid`/`cascade`, `edit.copy`, `edit.selectAll`, `edit.find`, `table.filter` (`{ pane, filters, merge }` → `workspace.setPaneFilters`; no `pane` targets the focused pane), `table.sort` (`{ pane, sort }`), `table.columns` (`{ pane, visible }`; no `visible` shows all), `table.expand` (`{ pane, depth }`), `table.select` (`{ pane, keys, focus }` → `workspace.selectPane`), `table.link` (`{ pane, link, merge }` or the link keys flat → `workspace.setPaneLink`), `layout.*` (see Saved layouts). Custom actions: `app.registerAction(name, fn)`.

Edit routing: `edit.copy`/`edit.selectAll`/`edit.find` call `workspace.editAction(name)`, which resolves the focused frame's active pane (`workspace.activePaneEl()`) and invokes its `_editActions` hook (`{ copy, selectAll, clearSelection, find, findNext, findPrev }`; any pane type may implement it). The window keydown handler routes Ctrl/Cmd+C, +A, +F, +G, +Shift+G, and Escape through the same hook; editable elements and a native text selection win; `preventDefault` fires only when a pane handled the action. `tests/edit-routing.test.js`.

## Statusbar

`statusbar` config keys: `left`/`right` (widget arrays) and `bindStyle` (CSS property → state path): each value is an inline style on `<mkui-statusbar>`; `null`/`""` removes it.

## mkio connection state

When `config.mkio.url` is present, `<mkui-app>` calls `ensureMkio` with `onConnect`/`onDisconnect` callbacks **before** setting up menubar, workspace, and statusbar — load-bearing: the bridge caches the first caller's promise. Callbacks get the `client` first.

Connection is two-phase: **connect** then **verify**. On WebSocket open, `mkio.connected` is set `true` and the `config.mkio.connected` state map applies; an async `_mkio` reqrep then queries the server's identity. Pass sets `mkio.verified` `true`; fail leaves it `false` and applies `config.mkio.incompatible`. Verification reruns on reconnect.

`config.mkio.expect` (`name` exact, `version`/`protocol`/`mkio` semver-compatible server-side, `expr` exact; mkui vendors `"1"`) is optional: the query still runs to fill `mkio.server.*`, timing out per `config.mkio.timeout` (5s). State maps `config.mkio.connected` / `.disconnected` / `.incompatible` are `"state.path": value` objects applied per lifecycle event.

## Authentication

When `config.auth` is present, `<mkui-app>` shows a login dialog before loading frames. `method: "mkio"` (default) calls `client.auth({username, password})` against mkio's `_mkio_users` (seed users `admin`/`password`, `user`/`password`); `method: "custom"` uses `app.registerAuthHandler({ authenticate({username, password}) })` → `{ user, role }`.

Config keys (under `auth`): `method`; `dialog` (labels and `width`); `connected` — state map applied after login and on reconnect (mkio's client re-authenticates); `disconnected` — state map on disconnect (falls back to `mkio.disconnected`). State paths: `auth.authenticated`, `auth.user`, `auth.role`. Action `auth.logout` reloads the page. With auth enabled, `_mkio` verification is skipped — authentication proves the server; `mkio.connected` still applies on socket open.

Login dialog: a floating frame (`stayOnTop`, `noDock`), `_hideClose = true`, `_extraControls = () => []`: undismissable. Under `mkio.control` the subscription waits for login.

## mkio-table pane type

Built-in pane type that subscribes to an mkio service and renders a live-updating table.

Config keys (under `panes.<id>`):
- `type` = `"mkio-table"` (required)
- `service` — mkio service to subscribe to (required)
- `protocol` — `"query"` (default), `"subpub"`, `"stream"`
- `topic` — string or array; required for subpub (one subscription each)
- `filter` — mkio filter expression (query)
- `columns` — column names to display; default: the first row's keys
- `labels` — column name → display label
- `maxcount` — paged subscriptions' page size (default 200, `null` disables)
- `start` — where stream paged mode opens: `"today"` (default, local midnight) or `""` (the buffer's start)
- `live` — `true` starts stream paged mode live; see Paging
- `rowColumn` — `false` hides the row-number column (default `true`)
- `values` — column → expression; see Derived columns
- `styles` — column → styler, `rowStyle` one for the row; see Conditional styling
- `display` — column → template; see Display templates
- `select` — `{ state = "<path>" }`; see Selection publishing
- `types` — column → `"number"`/`"time"`/`"text"` or `{ type, parse, tz, unit }`; see Range filters
- `filters` — column → filter, or an array of scoped ones; see Configured filters
- `sort`, `visible`, `groups` — see Configured sort, Column visibility, Column groups
- `tree` — `{ child, parent, expand, filterScope, orphans, column }`; see Tree rows
- `link` — `{ broadcast, listen, broadcasting, listening, chips }`; see Table linking

Row identity: query `_mkio_row`, stream `_mkio_ref`, subpub `_mkio_topic`; `_mkio_*` columns hidden.

Derived columns: `values = { col = "<expr>" }` derives a column with an expression in the cell scope — `value` (raw `row[col]`, NULL for a virtual column), `row`, `col`, `state`, then the row's fields. Every column read goes through `cellValue`, so a derived column behaves like a real field everywhere; a virtual one must be listed in `columns`. Button payloads carry raw row fields. A bad expression warns once.

Conditional styling: `styles = { col = <styler> }` styles a cell, `rowStyle = <styler>` the `tr`. A styler is a rule array evaluated first-match-wins — `{ when = "<expr>", ...style }`, no `when` = fallback — one expression yielding a style map (or NULL), or a plain map. Keys: `color`, `background`, `bold`, `italic`, `underline`, `strike`, `caps`, `class`, `css`; strings may be `${...}` templates. Cell rules see the cell scope, row rules `rowScope`; a rule whose condition errors warns once, never matches. Backgrounds are never inline: they ride `--mkui-cell-bg`/`--mkui-row-bg` plus `mkui-cell-styled`/`mkui-row-styled` marker classes placed *before* the selection rules so selection tints win (`tests/styles.test.js`).

Display templates: `display = { col = "<template>" }` controls presentation only — shown text, width stats, clipboard; sorting, filtering, and dropdown values use the value. Cell scope (`cellDisplay` → `{ text, rich, error }`). A template may yield a **rich** value — the `rich` type from `lib/rich.js`, produced by the `mkui` library (`BOLD`, `COLOR`, `BADGE`, `BAR`, `HEAT`, … — README has the list). `renderCell` builds spans via `renderRich` (segment colors inline on the span, never the td; badges/bars ride `--mkui-badge-color`, `--mkui-bar-frac`, `--mkui-bar-color`), the flattened text on `td._mkuiText`. An error renders `#ERR` with the message as tooltip and warns once.

Selection publishing: `select = { state = "path" }` writes the current row into app state on every selection change: the cursor's row, else the first selected row in view order, else `null` (as do a reset, a delete of the published row, and closing the pane). Filter changes republish after pruning, a live replace of that row republishes; deduped on identity.

Programmatic selection: `selectRows(keys, { focus = true })` selects by identity as a click does — one `refreshSelectionStyles`, so followers never see a null between; `[]` clears. A tree opens each key's collapsed ancestors; filters are never touched, so a key they hide comes back `hidden`, one not in `rows` `missing`, the rest `selected` (the first takes the cursor and scrolls); nothing changes unless a key resolves. Hook `_select = { set, get }` (`get` → `{ keys, focus }`); `workspace.selectPane`/`getPaneSelection`; `table.select`; not in layouts, not re-applied after a snapshot.

Numeric alignment: all-numeric columns right-align with per-cell right padding (`--mkui-num-pad`, ch) so decimals line up (`colStats.maxFrac`), the dropdown alike. Flash classes `mkui-flash-in`/`-out`/`-update`. Each pane gets a unique `subid`.

Selection: two exclusive modes plus an always-present **focused cell** (`.mkui-cell-focus`), the *implicit* selection copy, row-unit buttons, and broadcasts fall back to. Row mode: the sticky-left **row-number column** (`rowColumn: false` disables; view position, or per-level in a tree; outside stats/reorder/resize) selects rows — click / ctrl-toggle / shift-range / drag-range, header corner selects all. Cell mode: click places the focus (its row gets `.mkui-row-hl`), drag extends a rect, ctrl/cmd-click adds rects or toggles cells off, shift extends from the anchor. Rects are anchor/focus `(key, col)` pairs plus a `keys` snapshot of the rows spanned when last user-modified (`snapRectKeys`): membership is that record set × the column range, so sorts/filters move the same records and live inserts inside don't join; `rectBounds` resolves keys to view-index runs, cached. Keyboard: arrows/Home/End/PageUp/PageDown move, shift extends, Space selects the focused row (ctrl toggles), Escape clears the selection, keeps the cursor. Filter changes prune `selectedKeys`; copy and actions see view rows only.

Clipboard: `copySelection` builds a grid (row mode: selected rows × visible columns plus a `labels` header; cell mode: bounding grid, blanks outside the rects; fallback: the focused cell) written as TSV and HTML via `ClipboardItem` (`lib/copy.js`; over 100k rows skip HTML).

Buttons: `enable.when = "<expr>"` gates a button on the selection (scope `rows`, `row` (first or NULL), `cells`, `selection` `{ count, rowCount, cellCount, unit }`, `connected`, `state`) plus flags `connected`, `minSelected`, `maxSelected`. `unit`: `"rows"` (default), `"row"`, `"cells"`, `"cell"` — singular units default min/max to 1. Row units get the rows the selection implies (explicit rows, else rows holding selected cells, else the focused cell's row); cell units get `cells: [{ row, column, value }]` plus `cell`, a request per cell. Gates re-evaluate on selection, filter, and connection changes and on a live replace/delete of a selected row. `style = <styler>` (lazily compiled in `updateButtonStates`) sees the button scope plus `enabled`; backgrounds ride `--mkui-btn-bg` + `mkui-btn-styled`.

Sorting: click a header to cycle asc → desc → none, shift+click adding secondary keys, the priority a digit in the caret (`.mkui-sort-num`). Numeric vs string comparison is auto-detected; new rows insert sorted.

Configured sort: `sort = <spec>` seeds `sortKeys` at init and on `mkui-pane-open` (`loadSortSpec`); `sortFromSpec` takes a column name (`"-col"` → desc), `{ col, dir }`, or an array in priority order, a bad spec warning `bad sort` and changing nothing. `getSort()` → `[{ col, dir }]`, `setSort(spec)` replaces and re-applies (`applySort`). Hook `_sort = { set, get }`; `workspace.setPaneSort`/`getPaneSort`; `table.sort`.

Column visibility: one presentation state, `visible` — `null` (default: every non-`_mkio_` column in `columns` order, so later columns show on their own) or an ordered array (exactly these; what the user hid or arrived since stays out). Header reorder and hiding materialise the list; "Show all" returns to `null`. `visibleColumns()` (cached per `columns`/`visible` identity) intersects it with known columns — a name ahead of the data is kept but skipped — and every render, measure, copy, and selection path uses it. `visibleFromSpec`: a name or array (null/`""`/`[]` → all); non-strings or duplicates warn `bad visible`. API via `applyVisible`: `setVisible`/`getVisible` (`null` by default), `showColumns` (`insertShown` places by `columns`-order neighbours), `hideColumns` (the last stays), `showAllColumns`, `resetVisible`. Seeded before the header first renders and on `mkui-pane-open`. Hook `_columns = { set, get }`; `workspace.setPaneColumns`/`getPaneColumns`; `table.columns`.

Columns button & picker: the **Columns button** (`.mkui-columns-btn` + `.mkui-columns-badge` hidden count, `disabled` until columns exist) sits in a right **gutter** of the scroll area (`--mkui-columns-gutter`, 26px) off the sticky `.mkui-columns-anchor`, toggling the **column picker** (`.mkui-columns-picker`, own `picker` slot; it and a filter dropdown close each other): search (a group-label match keeps its group), an actions row ("Show all" / "Hide all" / "Reset", the first two scoped to matches under a query), and the list — flat in `columns` order, or one `.mkui-columns-group` per `colGroups()` entry (tri-state, folded unless it holds a shown column, `pickerExpanded`). "Hide all" keeps the last column; unscoped "Show all" is **two-step** (`SHOW_ALL_ARM_MS`, 4s; a query disarms). A header dropdown's `.mkui-filter-colops` row is that column's own: "Hide column" (inert on the last), the `.mkui-filter-applied` box, the link ops under `advanced`. A chip on a hidden column shows it first.

Column groups: `groups = [{ label, columns }, …]` categorises columns for the picker only — `visible` stays the truth. Parsed once into `colGroupsSpec` (bad entries warn `bad groups[i]` and drop; a column in two groups keeps the first). `colGroups()` cuts configured groups to known columns, omits empty ones, adds an implicit "Other". `inferColumns(row)` orders inferred columns grouped keys first.

Tree rows: `tree = { child, parent }` (names or equal-length lists) nests rows: all `child` fields empty → root, else the parent is the first row whose `parent` fields match. Maps beside `rows`: `parentOf` (null = root, `undefined` = hidden orphan), `kids` (`null` → roots), `depthOf`, `expanded`, `pendingKids` (children awaiting a parent, adopted by `linkRow`; `orphans` `"root"` shows them meanwhile, `"hide"` doesn't). `unlinkRow` re-homes a deleted parent's children; a cycle warns once, stays a root. **`view` is the pre-order flattening of rows whose ancestors are all expanded** (`rebuildView` → `flattenVisible` over `sortedKids`, cached), so selection, keyboard, copy, and buttons see only shown rows. Incremental: `insertRow` → `linkRow`, then `treeInsertIntoView`; re-parenting or a sort-key change dirties the view. `setExpanded` splices the subtree in or cuts its run, `pruneSelection` dropping hidden keys (the cursor climbs to the collapsed row); `setExpandDepth` for bulk. Row numbers are per-level positions (`1`, `5.3`, `5.3.1`) among *all* siblings in sort order — a filtered row keeps its slot: `rankOf` (`shiftRanks` on live insert/delete; `rowLabel`, `rowNumDigits`); a flat table uses view position until a filter is on, then `rankOf` (`flatRanks`). Filters carry `scope` (`roots` default / `children` / `all`; `tree.filterScope` overrides): `matchesFilters` judges `roots`/`children` by level (a miss hides the subtree), `all` goes through `buildSubtreeOk` in `rebuildView` (post-order: ok when the row or any child passes), so while one is active every data change rebuilds (`allScopeActive`). `describeFilter` appends a non-default scope. `filters` is keyed `fkey(col, scope)`, each filter carrying `col`/`scope` (`colFilters(col)`): a column holds up to three, its spec may be an array (`filtersFromSpec`), an entry replacing the column's filters. The dropdown's `.mkui-filter-scopes` tabs (Top / Child / Branch) hold one filter each (`dropdownScope`), shown on alt/option-click of button or chip (`openFilterDropdown(col, th, { advanced, scope })`) or when the column is filtered off `roots`. UI: caret column = `tree.column` when visible, else the first visible (`treeCol`); `.mkui-tree-cell` holds `--mkui-tree-depth`, `.mkui-tree-toggle`, and the `.mkui-tree-text` span `renderCell` writes to (`syncToggle`/`syncDepth` refresh reused `tr`s). Header `.mkui-tree-all` opens all roots / closes all, shift every level; Enter toggles a row, `*` its subtree; `expand` applies as rows link. Hook `_tree = { expand, toggle, expanded }`; `workspace.expandPane`; `table.expand`; not in layouts.

Find: `_editActions.find` (Ctrl/Cmd+F, `edit.find`) opens `.mkui-table-find` between toolbar and scroll area, in the DOM only while open (`findOpen`; `syncToolbar` inserts ahead of it): input, `.mkui-find-toggle`s (regex, case), count, step buttons, close. `compileFind` builds one RegExp (invalid → `.mkui-find-error`); `scanFind` fills `findMatches` `[{ key, col, idx }]` (header first, then `view` × `visibleColumns()` on the shown text) in rAF chunks (`FIND_CHUNK`). `findScanRev` = the `viewRev` scanned: `render` schedules a `FIND_DATA_MS` rescan on drift, `applyVisible` rescans at once, `findPos` surviving by identity. `findGo(dir)` steps and wraps, else starts at the cursor; `showMatch` = cursor move + scroll (`.mkui-cell-match`, `.mkui-th-match`/`-current`). Hooks `findNext`/`findPrev` (`findStep`: Ctrl/Cmd+G / +Shift+G, F3; closed → reopen on the last query, then step); Escape closes, after `clearSelection`. Closed on pane close/open, not in layouts.

Sort & filter chips: the table's DOM is a flex column — `.mkui-table-toolbar` (in the DOM only while it has buttons or chips; `syncToolbar`), `.mkui-table-scroll`, then progress or the paging bar. Buttons first, `.mkui-table-chips` last. `renderChips` (from `updateHeaderState`) builds a `.mkui-chip-group` per kind (sort, filter, link) led by a `.mkui-chip-lead` with the clear button. A chip holds `.mkui-chip-main` and `.mkui-chip-x`: sort chips flip / drop the key; filter chips open the dropdown / clear, and lead with a `.mkui-chip-check` (`makeFilterCheck`, `makeChip`'s `lead`) switching that filter off; alt-click the filter group's lead = `toggleAllFilters`. (`tests/styles.test.js`)

Range filters: numeric and all-time columns get a **Values | Range** switch — `From`/`To` inputs (native pickers on time columns), *Include empty*, *Clear*, presets; typing applies debounced, Enter at once, either dropping the preset. A filter is `{ kind: "values" | "range", … }`, described by `describeFilter`. Numeric `hi` is inclusive; time `hi` is *exclusive*, covering the whole unit typed. Preset bounds resolve against the clock (memoised per second in `rangeBounds`); `syncPresetTimer` re-applies the view every 30s while one is active. Inference in `colStats`: `numeric` first, then `temporal`/`timeKind` (`bumpTemporal`: every non-empty value an mkio ref, ISO-8601, or bare `HH:MM[:SS[.f]]`); nothing else is guessed — `types = { col = … }` declares `parse` (strptime), `unit` (epoch `s`/`ms`/`us`/`ns`), `tz` (`UTC` default, `local`, `+HH:MM`).

Filtering: each column header has one icon slot — the filter button, pinned right, a hamburger until the column is sorted, when `updateHeaderState` swaps in the sort caret. Either opens the same panel (search, "Select all"/"Clear", a checkbox per value), placed by `placeDropdown`. Lists (values and picker) open at content height, capped by `fitList` to end `VIEWPORT_GAP` above `dropdownFloor()` via an inline `max-height` that `resize: vertical` honours; a dragged height is reapplied per kind (`listHeights`). Changes apply at once, filters persist across resubscribes. A values filter records intent (`mode: "include" | "exclude"`): the dropdown starts (and "Select all" resets) in exclude mode, where unchecking hides those values and unseen ones pass; "Clear" flips to include mode, where checking shows only those. An empty exclusion is no filter, an inclusion always is.

Off filters: `f.off` suspends a filter without unmaking it — kept, chipped (`.mkui-chip-off`; `describeFilter(f, { state })` puts `(off)` in the tooltips, not the chip label the box already speaks for), applied by nothing, so every read skips it (`matchesFilters`, `passesAllScoped`, `allScopeActive`, `syncPresetTimer`, `flatRanked` via `anyFilterOn`). `setFiltersOn(keys, on)` from the chip check, the colops `.mkui-filter-applied` box (`curOff` keeps commits off), `toggleAllFilters`. Header btn `.mkui-filter-off` when a column's are all off (CSS after `.active`/`.mkui-filter-linked`, so off wins). Not clearing: `×`/`clearFilters` still drop.

Configured filters: `filters = { col = <filter> }` seeds `filters` at init (before data) and on `mkui-pane-open`. `filterFromSpec(col, spec)`: a list or `{ include }`/`{ exclude }` → a values filter; `from`/`to`/`empty`/`preset` → a range framed by `types[col].type`, else the entry's `type`, else the bounds (numbers → number, strings or a preset → time). Time bounds take the input forms (`inputToBound`), or epoch numbers on a `unit` column. `off = true` on an object spec ships it switched off. A bad entry warns `bad filters.<col>`; `null`/`""` clears. `filterToSpec` is the inverse: `getFilters()` round-trips through `setFilters(map, { merge })` (replace by default; `merge` keeps other columns, `null` clears one). Hook `_filters = { set, get }`; `workspace.setPaneFilters(id, filters, opts)` (builds a never-shown pane first; `id == null` → the focused pane), `getPaneFilters(id)`; `table.filter`.

Virtualized rows: only rows overlapping the viewport (plus overscan) exist in the DOM, two `.mkui-vspacer` rows carrying the rest's height. Data: a `rows` Map plus `baseOrder`; `view` is the filtered+sorted key array driving rendering, `render()` reconciling the visible slice with keyed `tr`s. Inserts/deletes/replaces patch `view`, sort/filter changes dirty it.

Column widths: once the header row exists (init with `columns`, else first data), each header is measured under `width: max-content` and locked via `<colgroup>` + `table-layout: fixed`, capped at 50% of the pane. From there columns only grow: `bumpStats` canvas-measures ingested values, `growColWidth` ratchets once per render; never shrinks, never touches `userSized` columns. In paged streams only the first data sizes columns (`growSuspended`). Widths ignore pane resizes: the table keeps `width: 100%` with no inline width, a trailing auto-width filler (`.mkui-th-filler` + widthless `<col>`) absorbing the rest (`tests/styles.test.js`). Each divider carries a `.mkui-col-resizer` grip (on the *following* header cell's left edge, the filler the last) resizing the column to its left; header cells must not clip overflow. `colWidths` is keyed by name (reset on reopen); double-clicking a grip auto-sizes the column (80% viewport cap) or every selected column.

Column reorder: drag a header (5px threshold), ghost label + drop indicator; the order persists in `visible`.

Paging (query): with `maxcount` (default 200) the client accumulates every page, firing `onSnapshot` once. `applySnapshot` ingests in rAF chunks; a generation counter cancels stale loops.

Paging (stream): with `maxcount` (default 200) a toolbar shows `◀ Earlier | time range | Later ▶ | ● Live | ⟳`; the first fetch starts at local midnight (`start: "today"`, a UTC ref) or the buffer's start (`""`). The range label gives visible rows' local timestamps at adaptive precision plus `(start)`/`(end)`/`(all)`.

Navigation is ref-based, no cursor stack: each page its own `subscribe` via `fetchPage(ref, before)` with `onPage` — Later passes `lastRef`, Earlier `firstRef` with `before: true`. An empty first fetch sets `firstRef` to the start ref; an empty backward one restores the previous page (`prevPageLoadRef`/`-Before`), sets `noPrev`. `⟳` re-fetches from `pageLoadRef`/`pageLoadBefore`; off in live mode.

`● Live` resumes streaming on the main `subid` from the page's `lastRef` and disables Later; Earlier fetches through a separate `pageSubId` (`fetchPrevLive`), prepending without a stream break (`pageFetchPending` guards). Exiting unsubscribes both and re-fetches the saved page; sort, filter, column order persist. `live: true` fetches the start page first and hands off from its `onPage` (`autoLivePending`, re-armed on reopen) — going live from `sub()` would replay the buffer; an empty start page seeds `lastRef` from `getStartRef()`. A drop in live mode shows "Disconnected" for the Live dot (the `mkio.connected` subscription is declared *after* the paging variables — `State.subscribe` fires synchronously), live mode staying on.

Tail following: each subscription callback samples `shouldFollowTail()` *before* ingesting (stream + live, viewport near the bottom), then `scrollToTail()` else `maybeRestoreScroll`; `goLive` sets `tailPending` for one jump. Never query/subpub.

Visibility-aware subscriptions: an `IntersectionObserver` gates the subscription — a hidden pane subscribes when shown, 5 minutes hidden drops it. `mkui-pane-close` sets `closed`, disconnects the observer, unsubscribes; `mkui-pane-open` clears `closed`, drops stale rows/sort/filter/paging/tree/find state (links stay), re-observes.

Stream resume: `lastRef` advances on every snapshot, delta, update, and `fetchPage`, `firstRef` on `fetchPage`. `sub()` with a `lastRef` passes `ref: lastRef` and keeps rows; without one it clears and subscribes from the start. Query/subpub never set it.

Snapshot clearing: query and subpub `applySnapshot` clears rows, DOM, and selection first — auto-reconnect fires `onSnapshot` without `sub()`, so deletes during an outage would linger. Streams append.

## Table linking

`link = { broadcast = { name = col }, listen = { name = col | { column, scope } }, broadcasting, listening, chips }` on a table (`linkFromSpec`; bad → warns `bad link`; `chips = false` → `linkChips`, read once at init; not in `getLink`/layouts). `App.links` is the `LinkHub`: `publish(source, { name: values | null })` retains per name (only the owning source retracts, repeats skipped), queues delivery (no nested callbacks; `MAX_CHAIN` cuts a loop), mirrors `state.link.<name>`. `linkSource` = pane `data-id`, else `subid`. **Broadcast**: `broadcastSelection()` from `publishSelection` and a live insert/replace/delete `inBroadcast` (in the selection, or under a selected row) — `getBroadcastRows()` (selected rows plus, in a tree, every descendant of each — collapsed *and* filtered out, since a filter says what this table shows, not what the record is — once) → distinct `cellText` per name; null when empty/paused/closed. **Listen**: `onLinkDelivery` (ignores own source, paused, closed) → `putLinkFilter(name, values)`: an include filter marked `link: name` at `fkey(column, scope)`, displacing the column's filter into `linkStash` (restored in place on null); `refreshLinkFilters` catches up from `hub.current` at init, `mkui-pane-open`, and toggles. Linked filters: skipped by `getFilters`, kept by replace-mode `loadFilterSpecs` unless an entry names the column; user edits (`dropLinkStash`) take the marker off. `describeFilter` appends `(linked: name)`; header btn `.mkui-filter-linked`. Hook `_link = { set, get }` (`setLink(spec, { merge })`: null entries drop names); `workspace.setPaneLink`/`getPaneLink`; layouts save `panes[id].link` (config, never the filters). UI: the `.mkui-chips-link` group (lead icon = remove all) carries one `.mkui-chip-link.mkui-chip-{broadcast,listen}` per direction (`makeLinkChip`: click toggles `.mkui-chip-off`, × removes, `.mkui-chip-arm` two-step past one name); `.mkui-th-linkmark` (`updateLinkMark`); dropdown colops `makeLinkOp` under `advanced` only (`.mkui-link-op`; listen offers `hub.names()` as a datalist), plus `makeLinkToggle` (`.mkui-link-toggle-{dir}`) per linked direction when `!linkChips`. Pane close: `hub.retract`, unsubscribe. `tests/links.test.js`, table tests "links:".

## Control channel

`config.mkio.control = "<service>"` → `<mkui-app>._subscribeControl` subscribes (subpub, `subid` `mkui-control`, no topic — the client routes topic-keyed subs by `row._mkio_topic`) after connect, or after login under auth; each `update` row `{ action, args }` → `app.fireAction`. Server: `mkui.control.ControlService` (config `{ protocol = "subpub", access = "auth" }`; `on_subscribe` answers an empty snapshot, `send(action, args, user=)` pushes `make_update(op="action")`, `link(pane, …)` builds `table.link`); `install(app)` registers it, returns a late-binding handle; `cmd_serve` installs it. `tests/test_control.py`.

## Saved layouts

`[layouts]` in config enables it (`store` `"mkio"` when `mkio.url` else `"local"`; rest in the README). Saves are unnamed: the owner's layout is their newest entry. `workspace.getLayout()` → `{ version, frames: [{ id, title, x, y, w, h, layout }], focused, panes: { id: { filters, sort, visible, link } } }`: docked frames in z-order (noDock/stayOnTop excluded); view state via the `_filters`/`_sort`/`_columns`/`_link` hooks for open panes only; never a paged table's position. `sanitizeLayout` (lib/layouts.js) throws on a non-layout, drops unknown pane ids. `setLayout(layout, { reopen })` diffs open panes: staying panes move silently, leaving get `mkui-pane-close`, arriving `mkui-pane-open` *then* the saved state (deferred on `el._ready` for async factories). `resetLayout()` = config `frames`, `reopen: true`. `LayoutManager` (src/layouts.js): owner = `auth.user` if authenticated, else `""`; `save` skips a layout `sameLayout` to the newest, then prunes by `retained` (newest `keep` **or** last `keepDays`); `LocalLayoutStore` / `MkioLayoutStore` (`send`/`request` *resolve* with error envelopes). `<mkui-app>` defers frames; `_loadFrames` applies `restoreLatest()` (bounded by `timeout`), else the config frames.

## Dialogs

`openDialog(spec, context, app, extra)`: a modal floating frame (`stayOnTop`, `noDock`) resolving with the form data on submit, `null` on cancel/close.

Types: `hidden`, `readonly`, `select`, `checkbox`, `textarea`, `number`, text (default). `spec.fields` items: `{ group }` headers, `{ row: [...] }` rows (`field.width` = flex proportion), or fields; a body that would scroll grows the frame (≤ 90% of the workspace). `optionsFrom` (service-backed, re-fetched when a `${field.X}` param moves), `optionsFromColumn` (table values). `spec.submit.service` sends via `client.send()` (5s timeout; `submitPerRow` = a request per selected row), errors inline; else it resolves at once. Names starting `_` are never submitted. Fields need no `name`: `fieldState` is keyed by name, DOM by `keyOf(f)` (name, else synthetic), so value/`compute`/`showWhen` work on nameless lines.

Dynamic form: every edit runs `applyDynamic` (`onFieldChange`) over `formScope()` — fields by name (number fields as numbers, blank → NULL), `form`, the opening context. Flags `showWhen` (fields, `{ row }`, `{ group }`, select options), `required`, `disabled`, `readonly` take a boolean or expression; `label`, `placeholder`, `group`, `title`, `footer.note`, `invalidMessage`, `min`/`max`/`step`/`pattern` are templates; `options` may be an expression yielding the list. `value` is the one-time default; `compute` (an expression or `${` template) re-evaluates on every change — always on `hidden`/`readonly`, on an editable field only until the user types in it (`dirty`, cleared by `resetForm`). Computes and option rebuilds loop to a fixed point (declaration order, `MAX_COMPUTE_PASSES`, then one warning), then visibility, attributes (`resolvedAttrs`, read by `validate`), title (`ws.renamePane`), note (rewritten only when its text changes, so submit feedback stays). `tests/dialog.test.js`.

Pin button: an `icon("pin")` toggle before maximize/close (`frameEl._extraControls`); pinned, a *confirmed* submission resets the form rather than closing.

## Conventions

- Zero runtime dependencies; Web Components
- Pointer guards: every mousedown/pointerdown that opens a menu or starts an action/drag checks `ev.button === 0` (exception: the frame-raise mousedown, any button). Modified clicks are inert where the modifier means nothing: sort headers ignore ctrl/cmd/alt (shift keeps multi-sort), the select-all corner ignores all. `tests/pointer-guards.test.js`
- Icons are inline SVGs from `lib/icons.js` (`icon(name)`), never text glyphs: `currentColor`, sized by `.mkui-icon` CSS, which keeps `pointer-events: none` so hits land on the hosting button (`tests/styles.test.js`)
- `registerPaneType(name, factory)` for custom content; `registerWidget(name, factory)` for inline widgets
- Layout tree invariant: every leaf sits inside a `{ type: "tabs", children: [...] }` — never bare strings after normalize
- CSS invariant: `mkui-menubar`/`mkui-statusbar` are `box-sizing: border-box` so their height equals `--mkui-menubar-h`/`--mkui-statusbar-h` exactly; the workspace is positioned by those, and an overhang would paint over snapped frames' borders (`tests/styles.test.js`)
- Tests: `node:test` + `node:assert/strict`
