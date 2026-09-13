# CLAUDE.md

## Project overview

mkui: a config-driven, zero-dependency Web Components GUI framework: a floating-frame workspace with dockable panes. Pairs with [mkio](../mkio) as the backend; works standalone.

## Architecture

- **Workspace** (`<mkui-workspace>`) holds z-ordered floating **frames**
- **Frames** (`<mkui-frame>`) are top-level chrome with 8-way resize handles, each owning an internal normalized layout tree. No dedicated titlebar: every top-edge tab bar doubles as a drag region, the right-most carrying the window controls
- **Panes** (`<mkui-pane>`) are leaf content hosts inside frames, always wrapped in a TabGroup
- Pane elements are pooled at workspace level with stable identity, `appendChild` moving them between frames (into the pool *before* their content is built)
- Frame positions are fractions of the workspace and split ratios sum to 1, so proportional resize is automatic. Frame rects are *painted* in whole pixels (`applyFrameRect` rounds edges, not width/height, so snapped frames stay flush).
- Every frame move/resize goes through `clampToDock`
- Focus model: the top frame gets `[data-focused]` (`_applyZOrder`); each frame tracks an `_activeTabGroup`, updated on interaction with a tab or pane; hotkeys act on it.
- Tab drag: pointer events (mouse + touch) on tabs (`touch-action: none`); within a bar a ghost label + drop indicator reorder on release, outside the pane tears into a new frame. On noDock frames (dialogs, login) the tab is titlebar text: mousedown moves the frame, click activates the tab, and CSS must keep these tabs pointer-interactive (never `pointer-events: none`).
- Tab overflow: past `min-width: 3em` `.mkui-tabs` clips, `.mkui-tab-scroll` arrows appear and the bar gets `.mkui-tabbar-overflow` (`updateArrows` in `_renderTabBar`). Rename: ctrl/cmd+click (`contextmenu` + `ctrlKey` on macOS) swaps the label for `.mkui-tab-rename`, Enter/blur committing via `workspace.renamePane`, which sets `titled`, the flag stopping `setPaneAutoTitle` (a detail window hanging its record's name off the pane's title) overwriting a name the user chose.
- Tab strip look: the bar's bottom line is a `.mkui-tabbar::after` overlay (never a border) the selected tab covers (`z-index: 1`); selected tabs outside the focused group flatten to idle. (`tests/styles.test.js`)
- Theming: `dark`/`light` come from `mkui.css` via `[theme=...]`. Custom themes go in `config.app.themes[name]` as `{ "--mkui-*": value }` overrides, applied inline by `MkuiApp.setTheme(name)`.

## Key files

Paths are under `mkui/static/src/` unless they start with `mkui/`.

- `layout/tree.js` — normalized tree math (normalize, find, insert, remove, layout); `layout/drag.js` — clamp, snap, drop-zone, frac↔rect helpers; both DOM-free
- `components/workspace.js` — frame lifecycle, z-order, arrangement, inter-frame drag routing, snap
- `components/frame.js` — frame chrome, internal tree rendering, splitter drag; defines `<mkui-pane>`
- `components/app.js` — shell: menubar + workspace + statusbar
- `core.js` — `App`, `State` (reactive store), widget/pane-type registries, expression re-exports
- `lib/expr.js` — mkio's expression language, vendored verbatim from `mkio/client/mkio-expr.mjs` (`tests/vendor-sync.test.js`); never edit here: change mkio and re-copy
- `lib/expressions.js` — mkui's wrapper over the expression language (see Expressions)
- `lib/rich.js` — the `rich` expression type, the `mkui` UI function library, `renderRich` (DOM), `richToHTML` (clipboard)
- `lib/timeparse.js` — time parsing (`detectTimeKind`, `parseTime`, input↔bound, `refToDate`/`dateToRef`, `PRESETS`)
- `lib/icons.js` — `icon(name)` → a currentColor `<svg>` from vendored path data (Lucide + custom)
- `lib/copy.js` — clipboard grids: `gridToTSV` (CRLF, Excel quoting), `gridToHTML`
- `lib/history.js` — versioned tables (`__history`): capabilities, the `history` spec, the chain logic; DOM-free (`tests/history.test.js`)
- `lib/subject.js` — which record a window is about: the `record` block, `RecordFollower`, `attachRecord`, `recordFilter`; DOM-free bar the last (`tests/subject.test.js`). `lib/subject-ui.js` — the pin/chip strip both detail panes wear; `lib/record-config.js` — the form behind its config button
- `lib/chips.js` — `makeChip`/`makeGroup`/`armedClear`; `lib/styles.js` — `compileStyler`/`applyStyle`. Both lifted out of `mkio-table` so the record panes match it
- `widgets/mkio-record.js` — the `mkio-record` pane type: one record as a field list
- `widgets/mkio-table.js` — the `mkio-table` pane type: subscribes to mkio services, renders live tables
- `widgets/mkui-dialog.js` — `openDialog()`: config-driven, live-updating modal forms (see Dialogs)
- `auth.js` — config-driven login dialog; `showLogin()` runs before the app loads
- `layouts.js` / `lib/layouts.js` — `LayoutManager` (`layout.*` actions, startup restore); the format: `sanitizeLayout`, `retained`, the stores
- `lib/links.js` — `LinkHub`, the table-link bus (retained values per name, queued delivery, `MAX_CHAIN`); `App.links` owns one
- `lib/verify.js` — `judgeServer`/`incompatibleMap`: why a server was rejected
- `mkui/control.py` — `ControlService` / `install(app)`, pushing actions to browsers (see Control channel)
- `mkui/static/styles/mkui.css` — default theme, CSS custom properties

## Commands

- `mkui serve [dir] [-p PORT]` — serve a project via mkio
- `node --test tests/*.test.js` — JS unit tests (`version.test.js` pins the four version strings)
- `python -m pytest tests/` — CLI, control and example-config tests (`test_examples.py` checks each `[mkio.expect]`, pane service and `history` block against its server); `python -m build && twine upload dist/*` releases
- `examples/mkio-table`, `examples/history`: `python -m mkui serve .` + `python seed.py`; both `versioned`, the second about nothing else

## Config format

Runtime input is JSON. `mkui serve` uses mkio's `[config]` routing: `/config/client.json` comes from `config/client.toml` (via `tomllib`), so the browser needs no TOML parser; TOML configs use `""` where JSON would use `null`, and an inline table (`display = { … }`) must fit on one line (a multi-line one is a parse error: use `[panes.x.display]`).

Top-level keys: `app`, `state`, `auth`, `menubar`, `statusbar` (`left`/`right` widgets, `bindStyle` = CSS property → state path), `panes` (id→spec), `frames` (ordered, position + layout tree), `mkio`.

## Expressions

mkui uses mkio's expression language for everything conditional or derived in config (`lib/expr.js`, vendored; `tests/expressions.test.js` runs mkio's conformance fixtures). `lib/expressions.js` wraps it: one *lenient* `Env` (unknown names → NULL), compiled expressions/templates cached by source, `evalExpr` (warns once per source, null on error), `resolveExpr` (pure `${x}` → raw value, NULL → `""`; mixed → string), `statePaths(src, {template})` listing the `state.<path>`s read. Which scope each surface gets is the README's table; the cell scope (`values`/`styles`/`display`) is `value`, `row`, `col`, `state`, then the row's fields. Extension points (`registerExprFunction`, `-Library`, `-Type`) are exported from `core.js`.

## Menubar

`menubar` is a top-level array of `{ label, items }` dropdowns; the item keys are the README's. Rebuilt per open: `windows` → one `pane.show` leaf per `workspace.openPanes()` (noDock excluded), `layouts` → a submenu off state `layouts.list` (`layout.restore` leaves, `args` = id; empty → a `disabled` leaf; fires `layout.refresh`). `shortcut` is a display-only hint (`.mkui-menu-shortcut`, `formatShortcut` renders `mod` platform-native); handlers take either modifier.

Leaf items fire `app.fireAction(action, args)` on mouseup. Built-ins: `app.quit`, `pane.show` (pane ID: raises its frame, or opens one if parked), `window.tileH`/`tileV`/`grid`/`cascade`, `edit.copy`, `edit.selectAll`, `edit.find`, `edit.undo`/`redo`, `table.filter`/`sort`/`columns`/`expand`/`select`/`link`/`history` (each `{ pane, … }` → the matching `workspace.setPane*`/`selectPane`/`expandPane`; no `pane` targets the focused pane, and `table.link` also takes the link keys flat), `layout.*` (see Saved layouts). Custom actions: `app.registerAction(name, fn)`.

Edit routing: `edit.copy`/`edit.selectAll`/`edit.find` call `workspace.editAction(name)`, which resolves the focused frame's active pane (`workspace.activePaneEl()`) and invokes its `_editActions` hook (`{ copy, selectAll, clearSelection, find, findNext, findPrev, undo, redo }`; any pane type may implement it). The window keydown handler routes Ctrl/Cmd+C, +A, +F, +G, +Shift+G, and Escape through the same hook; editable elements and a native text selection win; `preventDefault` fires only when a pane handled the action. `tests/edit-routing.test.js`.

## mkio connection state

When `config.mkio.url` is present, `<mkui-app>` calls `ensureMkio` with `onConnect`/`onDisconnect` callbacks **before** setting up menubar, workspace, and statusbar (the bridge caches the first caller's promise). Callbacks get the `client`.

Connection is two-phase: **connect** then **verify**. On open `mkio.connected` goes `true` and `config.mkio.connected` applies; an async `_mkio` reqrep then asks who it is: a pass sets `mkio.verified`, a failure sets `mkio.reason` (`unreachable` | `name` | `version`, in that order) and applies `config.mkio.incompatible` (the flat map, an entry per reason on top, defaults per reason). Reruns on reconnect. `tests/verify.test.js`.

Capabilities ride the same reply: `capture` writes `mkio.server.services`/`.versioned`/`.historySuffix` only when it carries them (an old server, or the pre-login reply under auth, leaves them be). Under auth `_verify` never runs: `_probe` re-reads after login and on authenticated reconnects.

`config.mkio.expect` is optional (keys in the README): the query runs either way to fill `mkio.server.*`, timing out per `config.mkio.timeout` (5s). An `expect.mkio` pin goes stale on every mkio minor release (semver is exact-minor below 1.0), quietly reading reason `version` (`tests/test_examples.py`). The `connected` / `disconnected` / `incompatible` maps are `"state.path": value` objects applied per lifecycle event.

## Authentication

When `config.auth` is present, `<mkui-app>` shows a login dialog before loading frames. `method: "mkio"` (default) calls `client.auth(...)` against mkio's `_mkio_users`; `"custom"` uses `app.registerAuthHandler({ authenticate })` → `{ user, role }`.

Config keys are the README's; `connected` is applied after login *and* on reconnect (mkio's client re-authenticates), `disconnected` falls back to `mkio.disconnected`. State paths: `auth.authenticated`, `auth.user`, `auth.role`. Action `auth.logout` reloads the page. With auth enabled, `_mkio` verification is skipped (authentication proves the server); `mkio.connected` still applies on socket open.

Login dialog: a floating frame (`stayOnTop`, `noDock`), undismissable via `_hideClose` and an empty `_extraControls`.

## mkio-table pane type

Config keys are the README's; `type` and `service` are required. Defaults worth knowing: `protocol` `"query"`, `columns` the first row's keys, `maxcount` 200 (`null` disables paging), `start` `"today"` (local midnight; `""` = the buffer's start). A subpub `topic` may be a list, one subscription each. The rest have sections of their own (`values` → Derived columns, `styles`/`rowStyle` → Conditional styling, `types` → Range filters).

Row identity: query `_mkio_row`, stream `_mkio_ref`, subpub `_mkio_topic`. `_mkio_*` columns hide unless `columns`/`visible` names one of `SHOWABLE_COLUMNS` (lib/history.js); `noteMkioCols` remembers it, so hiding keeps it in the picker, and `MKIO_LABELS` heads it.

Derived columns: `values = { col = "<expr>" }` derives a column with an expression in the cell scope, where `value` is the raw `row[col]` (NULL for a virtual column). Every column read goes through `cellValue`, so a derived column behaves like a real field everywhere; a virtual one must be listed in `columns`. Button payloads carry raw row fields. A bad expression warns once.

Conditional styling: `styles = { col = <styler> }` styles a cell, `rowStyle = <styler>` the `tr`. The three styler shapes and the style keys are the README's; `lib/styles.js` compiles them (`compileStyler`) and applies the result (`applyStyle`), shared with `mkio-record`. Cell rules see the cell scope, row rules `rowScope`; a rule whose condition errors warns once, never matches. Backgrounds are never inline: they ride `--mkui-cell-bg`/`--mkui-row-bg` plus `mkui-cell-styled`/`mkui-row-styled` marker classes placed *before* the selection rules so selection tints win (`tests/styles.test.js`).

Display templates: `display = { col = "<template>" }` controls presentation only (shown text, width stats, clipboard); sorting, filtering and dropdown values use the value. Cell scope (`cellDisplay` → `{ text, rich, error }`). A template may yield a **rich** value, the `rich` type from `lib/rich.js`, produced by the `mkui` library (README lists it). `renderCell` builds spans via `renderRich` (segment colors inline on the span, never the td; badges/bars ride `--mkui-badge-color`, `--mkui-bar-frac`, `--mkui-bar-color`), the flattened text on `td._mkuiText`. An error renders `#ERR`, the message as tooltip, warning once.

Selection publishing: `select = { state = "path" }` writes the current row into app state on every selection change (the cursor's row, else the first selected in view order, else `null`), deduped on identity.

Programmatic selection: `selectRows(keys, { focus = true })` selects by identity as a click does (one `refreshSelectionStyles`, so followers never see a null); `[]` clears. A tree opens each key's collapsed ancestors; filters are never touched, so a key they hide comes back `hidden`, one not in `rows` `missing`, the rest `selected`; nothing changes unless one resolves. Hook `_select` (`get` → `{ keys, focus }`, `on` for followers); `workspace.selectPane`/`getPaneSelection`; `table.select`; not in layouts, not re-applied after a snapshot.

Numeric alignment: per-cell padding (`--mkui-num-pad`, ch) lines the decimals up (`colStats.maxFrac`), dropdown too. Flashes `mkui-flash-in`/`-out`/`-update`; each pane gets a unique `subid`.

Selection: two exclusive modes plus an always-present **focused cell** (`.mkui-cell-focus`), the *implicit* selection copy, row-unit buttons and broadcasts fall back to; its row gets `.mkui-row-hl`. Row mode: the sticky-left **row-number column** (`rowColumn: false` disables; view position, or per-level in a tree; outside stats/reorder/resize). Rects are anchor/focus `(key, col)` pairs plus a `keys` snapshot of the rows spanned when last user-modified (`snapRectKeys`): membership is that record set × the column range, so sorts/filters move the same records and live inserts inside don't join; `rectBounds` resolves keys to view-index runs, cached. Escape clears the selection, keeps the cursor. Filter changes prune `selectedKeys`; copy and actions see view rows only.

Clipboard: `copySelection` builds the README's grid via `writeGrid` + `makeCopyStatus` (`lib/copy.js`, shared with the history panel and `mkio-record`; over 100k rows skip HTML).

Buttons: `enable.when = "<expr>"` gates one on the selection (scope `rows`, `row` (first or NULL), `cells`, `selection` `{ count, rowCount, cellCount, unit }`, `connected`, `state`) alongside `connected`/`minSelected`/`maxSelected` and `unit` (singular units default min/max to 1). Gates re-evaluate on selection, filter and connection changes, and on a live replace/delete of a selected row (`refreshButtons`). An `action` button's `args` resolve against the button scope, as a transaction's `data` does. `style = <styler>` sees the button scope plus `enabled`; backgrounds ride `--mkui-btn-bg` + `mkui-btn-styled`.

Sorting: the priority rides a digit in the caret (`.mkui-sort-num`); numeric vs string is auto-detected; new rows insert sorted.

Configured sort: `sort = <spec>` seeds `sortKeys` at init and on `mkui-pane-open` (`loadSortSpec`); `sortFromSpec` reads the README's shapes, a bad one warning `bad sort` and changing nothing. `setSort` replaces and re-applies (`applySort`). Hook `_sort`; `workspace.setPaneSort`/`getPaneSort`; `table.sort`.

Column visibility: one presentation state, `visible`: `null` (the default) or an ordered array, meaning what the README says. Reorder and hiding materialise the list; "Show all" returns to `null`. `visibleColumns()` (cached per `columns`/`visible` identity) intersects it with known columns (a name ahead of the data is kept but skipped); every render, measure, copy and selection path uses it. `visibleFromSpec` warns `bad visible` on a non-string or a duplicate. API via `applyVisible`: `setVisible`/`getVisible` (`null` by default), `showColumns` (placed by `columns`-order neighbours), `hideColumns` (the last stays), `showAllColumns`, `resetVisible`. Seeded before the header first renders and on `mkui-pane-open`. Hook `_columns = { set, get }`; `workspace.setPaneColumns`/`getPaneColumns`; `table.columns`.

Columns button & picker: `.mkui-columns-btn` (+ `.mkui-columns-badge` hidden count, `disabled` until columns exist) rides a right **gutter** (`--mkui-columns-gutter`, 26px) off the sticky `.mkui-columns-anchor`, toggling `.mkui-columns-picker` (own `picker` slot; it and a filter dropdown close each other): search, an actions row scoped to the query's matches, then the list, flat in `columns` order or one tri-state `.mkui-columns-group` per `colGroups()` entry, folded unless it holds a shown column. "Hide all" keeps the last column; unscoped "Show all" is two-step (a query disarms). The header dropdown's `.mkui-filter-colops` row is that column's own: "Hide column" (inert on the last), `.mkui-filter-applied`, the link ops under `advanced`.

Column groups: `groups` categorises columns for the picker only; `visible` stays the truth. Parsed once into `colGroupsSpec` (bad entries warn `bad groups[i]`; a column in two keeps the first). `colGroups()` cuts them to known columns, drops empty ones, adds an implicit "Other". `inferColumns(row)` puts grouped keys first.

Tree rows: `tree = { child, parent }` nests rows per the README. Maps beside `rows`: `parentOf` (null = root, `undefined` = hidden orphan), `kids` (`null` → roots), `depthOf`, `expanded`, `pendingKids` (adopted by `linkRow` when the parent arrives). `unlinkRow` re-homes a deleted parent's children; a cycle warns once, stays a root. **`view` is the pre-order flattening of rows whose ancestors are all expanded** (`rebuildView` → `flattenVisible`, cached). Live: `insertRow` → `linkRow` → `treeInsertIntoView`; re-parenting or a sort-key change dirties the view. `setExpanded` splices the subtree in or out and `pruneSelection` drops hidden keys; `setExpandDepth` does bulk. Row numbers are per-level positions among *all* siblings in sort order (`rankOf`, `shiftRanks`, `rowLabel`); flat tables use view position until filtered, then `rankOf` (`flatRanks`). Filters carry `scope` (`roots` default / `children` / `all`; `tree.filterScope` overrides): `matchesFilters` judges `roots`/`children` by level, `all` via `buildSubtreeOk` in `rebuildView`, so while one is active every data change rebuilds (`allScopeActive`). `filters` is keyed `fkey(col, scope)`; a column holds up to three (`filtersFromSpec` reads an array). The `.mkui-filter-scopes` tabs (Top / Child / Branch) hold one filter each (`dropdownScope`), shown on alt/option-click or when the column is filtered off `roots`. Caret column = `tree.column` when visible, else the first visible (`treeCol`); `.mkui-tree-cell` holds `--mkui-tree-depth`, `.mkui-tree-toggle`, `.mkui-tree-text`. Header `.mkui-tree-all` opens the roots (shift: all levels) or closes all. Hook `_tree = { expand, toggle, expanded }`; `workspace.expandPane` / `table.expand`; not in layouts.

Find: `_editActions.find` (Ctrl/Cmd+F, `edit.find`) opens `.mkui-table-find` (`findOpen`). `compileFind` builds one RegExp (invalid → `.mkui-find-error`); `scanFind` fills `findMatches` (header first, then `view` × `visibleColumns()` on shown text) in rAF chunks. `findScanRev` = the `viewRev` scanned: `render` reschedules on drift, `applyVisible` rescans at once, `findPos` surviving by identity. `findGo(dir)` steps and wraps, else starts at the cursor; `showMatch` = cursor move + scroll (`.mkui-cell-match`, `.mkui-th-match`/`-current`). Hooks `findNext`/`findPrev` (`findStep`: Ctrl/Cmd+G / +Shift+G, F3; closed → reopen on the last query, then step); Escape closes, after `clearSelection`. Closed on pane close/open, not in layouts.

Sort & filter chips: the table's DOM is a flex column: toolbar, the find and as-of bars while open, the scroll area, then progress or the paging bar. The toolbar is in the DOM only while it has buttons, extras or chips (`syncToolbar`); buttons first, `.mkui-table-chips` last. `renderChips` builds a `.mkui-chip-group` per kind (sort, filter, link) led by a `.mkui-chip-lead` with the clear button (`lib/chips.js`); a filter chip's `.mkui-chip-check` switches that filter off, alt-click on the lead is `toggleAllFilters`. (`tests/styles.test.js`)

Range filters: numeric and all-time columns get a **Values | Range** switch (typing applies debounced, Enter at once, either dropping the preset). A filter is `{ kind: "values" | "range", … }`, described by `describeFilter`. Numeric `hi` is inclusive; time `hi` is *exclusive*, covering the whole unit typed. Preset bounds resolve against the clock (memoised per second in `rangeBounds`; `today` is the browser's calendar day even on a UTC column, like a stream's `start`, so an evening table doesn't empty when the UTC date turns); `syncPresetTimer` re-applies the view every 30s while one is on. Inference in `colStats`: `numeric` first, then `temporal`/`timeKind` (`bumpTemporal`: every non-empty value an mkio ref, ISO-8601, or bare `HH:MM[:SS[.f]]`); nothing else is guessed: `types = { col = … }` declares `parse`, `unit`, `tz` (lib/timeparse.js).

Filtering: each column header has one icon slot, `updateHeaderState` swapping the hamburger for the sort caret; either opens the same panel, placed by `placeDropdown`. Lists open at content height, capped by `fitList` above `dropdownFloor()` (an inline `max-height` that `resize: vertical` honours); a dragged height is kept per kind. Changes apply at once, filters persist across resubscribes. A values filter records intent (`mode: "include" | "exclude"`, the README has the behaviour): an empty exclusion is no filter, an inclusion always is.

Off filters: `f.off` suspends one without unmaking it: kept, chipped (`.mkui-chip-off`; `describeFilter(f, { state })` puts `(off)` in the tooltip, not the label), applied by nothing: every read skips it (`matchesFilters`, `allScopeActive`, `syncPresetTimer`, `flatRanked`, all via `anyFilterOn`). `setFiltersOn(keys, on)` from the chip check, the colops `.mkui-filter-applied` box, `toggleAllFilters`. Header btn `.mkui-filter-off` when a column's are all off (CSS after `.active`/`.mkui-filter-linked`, so off wins). `×`/`clearFilters` still drop.

Configured filters: `filters = { col = <filter> }` seeds them at init (before data) and on `mkui-pane-open`. `filterFromSpec(col, spec)` reads the README's shapes, framing a range by `types[col].type` else the entry's `type` else the bounds, through `inputToBound`; `off = true` ships one switched off. A bad entry warns `bad filters.<col>`; `null`/`""` clears. `filterToSpec` is the inverse: `getFilters()` round-trips through `setFilters(map, { merge })` (replace by default; `merge` keeps other columns, `null` clears one). Hook `_filters`; `workspace.setPaneFilters(id, filters, opts)` (builds a never-shown pane first; `id == null` = the focused pane), `getPaneFilters(id)`; `table.filter`.

Embedding: `_source = { set({ filter, topic }), get }` re-aims a table at another slice of its service (unsub, clear, re-subscribe); `_data = { rows, view, selected, on }` reads what it holds, `on` coalescing to one call per task; `_toolbar = { extras, sync }` takes an embedder's controls into the toolbar (made on demand; `sync`, as an empty toolbar is not in the DOM).

Virtualized rows: only those overlapping the viewport (plus overscan) are in the DOM, two `.mkui-vspacer` rows carrying the rest's height. Data: a `rows` Map plus `baseOrder`; `view` is the filtered+sorted key array, `render()` reconciling the shown slice with keyed `tr`s. Inserts/deletes/replaces patch it; sort/filter changes dirty it.

Column widths: once the header row exists (init with `columns`, else first data), each header is measured under `width: max-content` and locked via `<colgroup>` + `table-layout: fixed`, capped at half the pane. They only grow: `bumpStats` canvas-measures ingested values, `growColWidth` ratchets once per render; never shrinks, never touches `userSized`. In paged streams only the first data sizes columns (`growSuspended`). Widths ignore pane resizes: the table keeps `width: 100%` with no inline width, a trailing auto-width filler (`.mkui-th-filler` + widthless `<col>`) absorbing the rest (`tests/styles.test.js`). Each divider carries a `.mkui-col-resizer` grip (on the *following* header cell's left edge, the filler the last) resizing the column to its left; header cells must not clip overflow. `colWidths` is keyed by name (reset on reopen); a grip's double-click auto-sizes every selected column at once (80% viewport cap).

Column reorder: drag a header (5px); the order lands in `visible`.

Paging (query): the client accumulates every page, firing `onSnapshot` once; `applySnapshot` ingests in rAF chunks, a generation counter cancelling stale ones.

Paging (stream): the toolbar is the README's; the first fetch starts at local midnight (`start: "today"`, a UTC ref) or the buffer's start (`""`).

Navigation is ref-based, no cursor stack: each page its own `subscribe` via `fetchPage(ref, before)` with `onPage`: Later passes `lastRef`, Earlier `firstRef` with `before: true`. An empty first fetch sets `firstRef` to the start ref; an empty backward one restores the previous page (`prevPageLoadRef`/`-Before`), sets `noPrev`. `⟳` re-fetches from `pageLoadRef`/`pageLoadBefore`; off in live mode. `lastRef` advances on every snapshot, delta, update and `fetchPage`, `firstRef` on `fetchPage`; `sub()` with `lastRef` keeps rows and resumes there, without one it clears and starts over (query/subpub never set it).

`● Live` resumes streaming on the main `subid` from the page's `lastRef` and disables Later; Earlier fetches through a separate `pageSubId` (`fetchPrevLive`), prepending without a stream break. Exiting unsubscribes both and re-fetches the saved page; sort, filter, column order persist. `live: true` fetches the start page first and hands off from its `onPage` (`autoLivePending`, re-armed on reopen), as going live from `sub()` would replay the buffer; an empty start page seeds `lastRef` from `getStartRef()`. A drop in live mode shows "Disconnected" for the Live dot (the `mkio.connected` subscription is declared *after* the paging variables: `State.subscribe` fires synchronously), live mode staying on.

Tail following: each subscription callback samples `shouldFollowTail()` *before* ingesting (stream + live, viewport near the bottom), then `scrollToTail()` else `maybeRestoreScroll`; `goLive` sets `tailPending` once.

Visibility-aware subscriptions: an `IntersectionObserver` gates them (5 minutes hidden drops one). `mkui-pane-close` sets `closed`, disconnects, unsubscribes; `mkui-pane-open` clears `closed`, drops stale rows/sort/filter/paging/tree/find/undo state (links stay), re-observes.

Snapshot clearing: query/subpub `applySnapshot` clears rows, DOM and selection first (auto-reconnect fires `onSnapshot` without `sub()`, so an outage's deletes would linger). Streams append.

## Table linking

`link` (shape in the README) is read by `linkFromSpec` (bad → warns `bad link`); `chips = false` → `linkChips`, read once at init. `App.links` is the `LinkHub`: `publish(source, { name: values | null })` retains per name (only the owner retracts, repeats skipped), queues delivery (`MAX_CHAIN` cuts a loop), mirrors `state.link.<name>`. `linkSource` = pane `data-id`, else `subid`. **Broadcast**: `broadcastSelection()` from `publishSelection` and a live change `inBroadcast`: `getBroadcastRows()` (selected rows plus, in a tree, every descendant, collapsed and filtered out alike: a filter says what the table shows, not what the record is) → distinct `cellText` per name; null when empty/paused/closed. **Listen**: `onLinkDelivery` (ignores own source, paused, closed) → `putLinkFilter`: an include filter marked `link: name` at `fkey(column, scope)`, displacing the column's own into `linkStash` (restored on null); `refreshLinkFilters` catches up from `hub.current` at init, `mkui-pane-open`, and toggles. Linked filters: skipped by `getFilters`, kept by replace-mode `loadFilterSpecs` unless an entry names the column; a user edit (`dropLinkStash`) takes the marker off. Hook `_link = { set, get }` (`setLink(spec, { merge })`: null entries drop names); `workspace.setPaneLink`/`getPaneLink`; layouts save `panes[id].link` (config, never the filters). UI: `.mkui-chip-link.mkui-chip-{broadcast,listen}` (`makeLinkChip`), `.mkui-th-linkmark`, dropdown `makeLinkOp` under `advanced`, `makeLinkToggle` when `!linkChips`. Pane close: `hub.retract`, unsubscribe. (`tests/links.test.js`)

## Detail windows

Which record a window is about is `lib/subject.js`, DOM-free: `parseRecordSpec` reads the `record` block (one of `follow`/`listen`/`state`/`key`, plus `retain`, `listening`, `title`; bare string = `follow`; throws → callers warn `bad record`), `recordSpecToConfig`/`mergeRecordSpec` round-trip it for layouts and `merge`, and `RecordFollower` emits `{ key, row, of, from }` with a *why* (`change` | `refresh` | `spec`: a pane reloads on the first two, redraws controls on the third). `sameSubject` dedupes by key, else row identity. `coerce` makes a hub string a number only when it round-trips (`"007"` stays a string). Every source read goes through `_offer`, honouring the pin (`listening: false`) and `retain`. `attachRecord(paneEl, spec, app, onRecord, { ws, warn })` installs `_record = { get, set, on, follow, config, refresh }` and returns the follower **unstarted**: its first read can land synchronously, so a callback reaching the caller's `const` would hit the TDZ. (`tests/subject.test.js`)

Workspace: `paneRows` (`_history.rows()` ?? `_data.selected()`), `setPaneRecord`/`-Source` + getters, `onPaneRecord`, `showPaneRecord` (= `table.record`); actions `record.show`/`record.follow`; layouts carry `panes[id].record`, the configuration only (the key comes back from the hub). `mkio-record`: `fields`/`labels`/`display`/`styles`/`groups`/`widgets` (a `source` pane lends them), one live query subscription per record, hooks `_data`/`_toolbar`/`_editActions.copy`; key columns from `spec.key`, else the source's `history.key`, else `pkFromSchema`. (`tests/record-pane.test.js`)

## Record history

`mkio-history` (pane type; `source` = the table it lends its `history` block, `labels`, `display`, and, without a `record` block, the selection it follows): an embedded `mkio-table` over `history.feed`, filtered server-side to the record (`recordFilter`; `_mkio_version` ascending, mkio's columns then the source table's), and a panel under it. `ensureTable` builds it once, `_source.set` re-aims it per record (keeping the user's columns, sort and filters), and the pane reads `_data` (rows = the chain, `on` = they changed) and `_select` (what the panel is about: one version against its predecessor, a range between its ends, else `defaultVersion`, the cursor, selected once per record so the table marks it). Key from `history.key`, else an `_mkio` `{table}` request (one shared flight); the cursor is the record row's `_mkio_version`, else `history.state` answers. The table's hooks land on this pane's element: `edit.copy` and find are the versions'. **No head**: the record names the tab (`setPaneAutoTitle`), `v2 of 3` sits in the panel header (`.mkui-history-at`), and the subject strip, Diff | Blame and unchanged ride the table's toolbar via `_toolbar` (on `.mkui-record-bar` until that table exists). Copy is in the panel header. `showPaneHistory(paneId, keys)` registers `_history:<src>` once and re-points it (`table.history`). (`tests/history-pane.test.js`)

A version cursor move flashes `mkui-flash-undo`/`-redo` (`-out` shape when the row leaves), from mkio 0.5's `cause` (`onUpdate`'s 3rd arg); without one only a *fallen* `_mkio_version` is caught.

As of: `history.asOf` (`{ service, param = "as_of" }`, query tables only). `applyAsOf` requests it, stamps `idKey` on the rows from the key columns (a reqrep reply carries none), `unsub()`s, `applySnapshot`s. While `asOfRef` is set every button is shut, the apply* paths drop live changes, `sub()` refuses; Live re-subscribes.

Blame: the panel's `Diff | Blame` switch (`panel`, a preference outliving the record) reads `blame(chain, { upto: selVersion })`, which version last gave each field its value there; a click goes to that version.

Undo/redo: `history.undo` / `history.redo` (`{ service, op, label }`) put a button each in the toolbar (`.mkui-history-step`), over the selection. Undo reads the row's `_mkio_version`; redo needs what is recorded *above* it, which the row cannot say: `history.state` (debounced probe, `cursorCache`, dropped on any `cause` so a step made while unselected re-probes) or this session's own undos (`undoneHere`). An undo at version 1 removes the row, so the intent is marked *before* the send (its delete beats the ack): `applyDelete` files it under `undoneAway` and clears the selection, and Redo with nothing selected takes the newest. `confirm` (default on) is an ordinary dialog (`submitPerRow` + `rowData` over the key columns) reading `versions` for the fields the step moves. Hooks `_editActions.undo`/`redo` and `_history.step`/`can`; no shortcut is bound, as this writes to shared state. Key columns: `history.key`, else `pkFromSchema` on an `_mkio` reply.

## Control channel

`config.mkio.control = "<service>"` → `<mkui-app>._subscribeControl` subscribes (subpub, `subid` `mkui-control`, no topic: the client routes topic-keyed subs by `row._mkio_topic`) after connect, or after login under auth; each `update` row `{ action, args }` → `app.fireAction`. Server: `mkui.control.ControlService` (`{ protocol = "subpub", access = "auth" }`; `on_subscribe` answers an empty snapshot, `send(action, args, user=)` pushes `make_update(op="action")`, `link(pane, …)` builds `table.link`); `install(app)` registers it and returns a late-binding handle, `cmd_serve` installs it. `tests/test_control.py`.

## Saved layouts

`[layouts]` enables it (`store` `"mkio"` when `mkio.url` else `"local"`). `workspace.getLayout()` → `{ version, frames, focused, panes }`: docked frames in z-order (noDock/stayOnTop excluded); pane view state through the `_filters`/`_sort`/`_columns`/`_link` hooks, open panes only; never a paged table's position. `sanitizeLayout` (lib/layouts.js) throws on a non-layout, drops unknown panes. `setLayout(layout, { reopen })` diffs open panes: stayers move, leavers get `mkui-pane-close`, arrivals `mkui-pane-open` then the saved state (on `el._ready`). `resetLayout()` = config `frames`, `reopen: true`. `LayoutManager` (src/layouts.js): owner = `auth.user` when authenticated, else `""`; `save` skips one `sameLayout` to the newest, then prunes by `retained`; the stores' `send`/`request` *resolve* with error envelopes. `<mkui-app>` defers frames: `_loadFrames` applies `restoreLatest()` within `timeout`, else config `frames`.

## Dialogs

`openDialog(spec, context, app, extra)`: a modal floating frame (`stayOnTop`, `noDock`) resolving with the form data on submit, `null` on cancel/close.

`spec.fields` items: `{ group }` headers, `{ row: [...] }` rows (`field.width` = flex proportion), or fields (the README lists the types; temporal fields are native pickers holding canonical values: `datetime` a UTC ISO instant via `lib/timeparse.js`, `parse`/`tz` reading other formats; `time: "optional"` renders a date + time pair in `.mkui-dialog-datetime`, `parts.time` the second, a bare date while the time is blank). `optionsFrom` re-fetches when a `${field.X}` param moves (`fill = { field: column }` on that select copies the picked row into named fields via `applyFill`: blanks skipped, targets `dirty`, moved names to `onFieldChange`; `remember = key | { key, value }` stores the field, or `value`'s result, in `extra.storage`/localStorage on a confirmed submit (`storeRemembered`), `recallAll` restoring it at open and reset), `optionsFromColumn` takes table values. `spec.submit.service` sends via `client.send()` (5s timeout; `submitPerRow` = one request per selected row, merged with `rowData`), errors inline; else it resolves at once. `submit.then = { action, args }` → `follow(data)` per confirmed submit: `app.fireAction`, `args` over `{ ...context, ...data, form: data }`. Names starting `_` are never submitted. Fields need no `name`: `fieldState` is keyed by name, DOM by `keyOf(f)` (name, else synthetic).

Sections: a `{ group }` heads `.mkui-dialog-section`, holding every item to the next header (`sectionOf`; its `showWhen` hides them, via `isShown`). `collapsible` makes the head a button (`renderSection`: caret, summary pill; click/Enter/Space, alt = all); `collapsed` (bool or expr, read once), `remember` (stored per toggle, not submit); `.mkui-dialog-collapsed` hides the body; folded fields still submit, `validate` unfolds a failing one. The summary is `summary`, else `changedIn` against `initial` (snapshot at open and `resetForm`). `fitFrame()` grows the frame (never shrinks) at open and unfold.

Dynamic form: every edit runs `applyDynamic` (`onFieldChange`) over `formScope()`: fields by name (number fields as numbers, blank → NULL), `form`, the opening context. Flags `showWhen` (fields, `{ row }`, `{ group }`, select options), `required`, `disabled`, `readonly` take a boolean or expression; the text keys and `min`/`max`/`step`/`pattern` are templates; `options` may be an expression yielding the list. `value` is the one-time default; `compute` (an expression or `${` template) re-evaluates on every change: always on `hidden`/`readonly`, on an editable field only until the user types in it (`dirty`, cleared by `resetForm`). Computes and option rebuilds loop to a fixed point (`MAX_COMPUTE_PASSES`, then one warning), then visibility, attributes (`resolvedAttrs`, read by `validate`), title, note (rewritten only on change, so submit feedback stays). `tests/dialog.test.js`.

Pin button: `icon("pin")` through `frameEl._extraControls`; pinned, a *confirmed* submission resets the form rather than closing.

## Conventions

- Pointer guards: every mousedown/pointerdown that opens a menu or starts an action/drag checks `ev.button === 0` (exception: the frame-raise mousedown, any button). Modified clicks are inert where the modifier means nothing: sort headers ignore ctrl/cmd/alt (shift keeps multi-sort), the select-all corner ignores all. `tests/pointer-guards.test.js`
- Icons are inline SVGs from `lib/icons.js` (`icon(name)`), never text glyphs: `currentColor`, sized by `.mkui-icon` CSS, whose `pointer-events: none` lands hits on the hosting button (`tests/styles.test.js`)
- `registerPaneType(name, factory)` for custom content; `registerWidget(name, factory)` for inline widgets
- Layout tree invariant: every leaf sits inside a `{ type: "tabs", children: [...] }`; no bare strings after normalize
- CSS invariant: `mkui-menubar`/`mkui-statusbar` are `box-sizing: border-box` so their height equals `--mkui-menubar-h`/`--mkui-statusbar-h` exactly; the workspace is positioned by those, and an overhang would paint over snapped frames' borders (`tests/styles.test.js`)
- Tests: `node:test`, `node:assert/strict`
