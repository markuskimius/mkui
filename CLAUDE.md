# CLAUDE.md

## Project overview

mkui: a config-driven, zero-dependency Web Components GUI framework: floating frames, dockable panes. Pairs with [mkio](../mkio) or stands alone.

## Architecture

- **Workspace** (`<mkui-workspace>`): z-ordered floating **frames**
- **Frames** (`<mkui-frame>`): top-level chrome with 8-way resize handles, each owning a normalized layout tree. No titlebar: every top-edge tab bar doubles as a drag region, the right-most carrying the window controls
- **Panes** (`<mkui-pane>`): leaf content hosts inside frames, always in a TabGroup
- Pane elements are pooled at workspace level with stable identity, `appendChild` moving them between frames (pooled *before* their content is built)
- Frame positions are workspace fractions, split ratios sum to 1: proportional resize is automatic. Frame rects are painted in whole pixels (`applyFrameRect` rounds edges, not sizes, so snapped frames stay flush).
- Frame moves/resizes all go through `clampToDock`
- Focus model: the focused frame (`_focusedId`: the last raised; `closeFrame` hands it to the top one left) gets `[data-focused]` (`_applyZOrder`); each frame tracks an `_activeTabGroup`, updated on tab or pane interaction; hotkeys act on it.
- Tab drag: pointer events on tabs (`touch-action: none`); in a bar a ghost label + drop indicator reorder on release; outside it the pane tears into a new frame. On noDock frames (dialogs, login) the tab is titlebar text: mousedown moves the frame, click activates it; CSS must keep them pointer-interactive.
- Tab overflow: past `min-width: 3em` `.mkui-tabs` clips, `.mkui-tab-scroll` arrows appear and the bar gets `.mkui-tabbar-overflow` (`updateArrows`). Rename: ctrl/cmd+click (`contextmenu` + `ctrlKey` on macOS) swaps the label for `.mkui-tab-rename`, Enter/blur committing via `workspace.renamePane`, which sets `titled`, the flag stopping `setPaneAutoTitle` overwriting a chosen name.
- Tab strip look: the bar's bottom line is a `.mkui-tabbar::after` overlay (never a border) the selected tab covers (`z-index: 1`); selected tabs outside the focused group flatten to idle.
- Theming: `dark`/`light` come from `mkui.css` via `[theme=...]`; custom themes in `config.app.themes[name]` are `{ "--mkui-*": value }` overrides applied inline by `MkuiApp.setTheme(name)`.

## Key files

Paths are under `mkui/static/src/` unless they start `mkui/`.

- `layout/tree.js` — normalized tree math (normalize, find, insert, remove, layout); `layout/drag.js` — clamp, snap, drop-zone, frac↔rect helpers; both DOM-free
- `components/workspace.js` — frame lifecycle, z-order, arrangement, inter-frame drag routing, snap
- `components/frame.js` — frame chrome, internal tree rendering, splitter drag; defines `<mkui-pane>`
- `components/app.js` — the shell
- `core.js` — `App`, `State` (reactive store), the registries, expression re-exports
- `lib/expr.js` — mkio's expression language, vendored verbatim from `mkio/client/mkio-expr.mjs` (`tests/vendor-sync.test.js`); never edit: change mkio and re-copy
- `lib/expressions.js` — mkui's wrapper over it (see Expressions)
- `lib/rich.js` — the `rich` expression type, the `mkui` UI function library, `renderRich` (DOM), `richToHTML` (clipboard)
- `lib/timeparse.js` — time parsing (`detectTimeKind`, `parseTime`, input↔bound, `refToDate`/`dateToRef`, `PRESETS`)
- `lib/icons.js` — `icon(name)`: vendored SVG paths (Lucide + custom)
- `lib/copy.js` — clipboard grids: `gridToTSV` (CRLF, Excel quoting), `gridToHTML`
- `lib/history.js` — versioned tables (`__history`): capabilities, the `history` spec, the chain logic (`tests/history.test.js`)
- `lib/subject.js` — which record a window is about (see Detail windows). `lib/subject-ui.js` — the detail panes' pin/chip strip; `lib/record-config.js` — the form behind its config button
- `lib/chips.js` — `makeChip`/`makeGroup`/`armedClear`; `lib/styles.js` — `compileStyler`/`applyStyle`; shared by table and record panes
- `widgets/mkio-record.js` — `mkio-record`: one record as a field list
- `widgets/mkio-table.js` — `mkio-table`: live tables over mkio services
- `widgets/mkui-dialog.js` — `openDialog()`: live-updating forms and message boxes (see Dialogs)
- `auth.js` — the login dialog (`showLogin()`, before the app loads)
- `layouts.js` / `lib/layouts.js` — `LayoutManager`; the format, the stores (see Saved layouts)
- `lib/links.js` — `LinkHub` (see Table linking)
- `lib/verify.js` — why a server was rejected; the mkio floor (see mkio connection state)
- `lib/connection.js` — the outage treatment
- `lib/mkio-url.js` — `resolveMkioUrl`: `mkio.url` read against the page, for `mkio-bridge.js` (`tests/mkio-url.test.js`)
- `mkui/control.py` — the server side of the Control channel
- `mkui/static/styles/mkui.css` — default theme, CSS custom properties

## Commands

- `mkui serve [dir] [-p PORT] [-H HOST] [-o]` — serve a project (mkio). Page and socket (`/ws`) are one listener; templates say `url = "/ws"`, following `-p`/`-H`; `client_url_warnings` flags a config dialing another local port
- `node --test tests/*.test.js` — JS unit tests (`version.test.js` pins the four version strings; `SURFACE_UPDATE=1` regenerates `tests/surface.json`)
- `python -m pytest tests/` — CLI, control and example-config tests (`test_examples.py` checks each `[mkio.expect]`, pane service, `history` block and named dialog against its server)
- `examples/mkio-table`, `examples/history`: `python -m mkui serve .` + `python seed.py [port]`; both `versioned`

## Config format

Runtime input is JSON. `mkui serve` uses mkio's `[config]` routing: `/config/client.json` comes from `config/client.toml` (`tomllib`), TOML uses `""` for JSON `null`; an inline table must fit on one line (else `[panes.x.display]`).

Top-level keys: `app`, `state`, `auth`, `menubar`, `statusbar` (`left`/`right` widgets, `bindStyle` = CSS property → state path), `panes` (id→spec), `frames` (ordered; position + layout tree), `mkio`, `layouts`, `dialogs` (name→spec).

## Expressions

mkio's expression language does everything conditional or derived in config (`lib/expr.js`; `tests/expressions.test.js` runs mkio's fixtures). `lib/expressions.js` wraps it: one *lenient* `Env` (unknown names → NULL), compiled expressions/templates cached by source, `evalExpr` (warns once per source, null on error), `resolveExpr` (pure `${x}` → raw value, NULL → `""`; mixed → string), `statePaths(src, {template})` listing the state paths read. Scopes per surface: the README's table; the cell scope (`values`/`styles`/`display`) is `value`, `row`, `col`, `state`, then the row's fields. Extension points (`registerExprFunction`, `-Library`, `-Type`) come from `core.js`.

## Menubar

`menubar` is a top-level array of `{ label, items }` dropdowns; the item keys are the README's. Per open: `windows` → one `pane.show` leaf per `workspace.openPanes()` (noDock excluded), `layouts` → a submenu off state `layouts.list` (`layout.restore` leaves, `args` = id; empty → a `disabled` leaf; fires `layout.refresh`). `shortcut` is a display-only hint (`.mkui-menu-shortcut`, `formatShortcut` renders `mod` platform-native); handlers take either modifier.

Leaf items fire `app.fireAction(action, args)` on mouseup. Built-ins (`tests/surface.json` names them): `pane.show` (pane ID: raises its frame, or opens a parked one), `table.*` (each `{ pane, … }` → the matching `workspace.setPane*`/`selectPane`/`expandPane`; no `pane` = the focused pane; `table.link` also takes the link keys flat), `layout.*` (see Saved layouts), `dialog.*` (see Dialogs). Custom: `app.registerAction`.

Item flags: `disabled`/`showWhen` take a boolean or expression over `menuScope` (`lib/menu.js`, `tests/menu.test.js`: `state`, `app`, `panes`, `pane` + `can` and `selection` from `workspace.focusInfo()`), read per open, at mouseup, live on state (`_refreshFlags`). State `dialog.suppressed` mirrors `suppress` answers; `State._notify` reaches subscribers *under* a set path too.

Edit routing: `edit.*` call `workspace.editAction(name)`, which invokes the `_editActions` hook of the focused frame's active pane (`activePaneEl()`) (`copy`, `selectAll`, `clearSelection`, `cancel`, `find`, `findNext`/`-Prev`, `undo`, `redo`; any pane type may implement it). Window keydown routes Ctrl/Cmd+C, +A, +F, +G, +Shift+G and Escape through the same hook (Escape: `cancel`, then `clearSelection`); editable elements and a native selection win; `preventDefault` only when a pane handled it. `tests/edit-routing.test.js`.

## mkio connection state

With `config.mkio.url`, `<mkui-app>` calls `ensureMkio` with `onConnect`/`onDisconnect` **before** setting up menubar, workspace, statusbar (the bridge caches the first caller's promise).

Connection is two-phase: **connect** then **verify**. On open `mkio.connected` goes `true` and `config.mkio.connected` applies; an async `_mkio` reqrep then asks who it is: a pass sets `mkio.verified`, a failure sets `mkio.reason` (`unreachable` | `name` | `version`, in that order) and applies `config.mkio.incompatible` (the flat map, an entry per reason on top, defaults per reason). Reruns on reconnect. `tests/verify.test.js`.

Capabilities ride the same reply: `capture` writes `mkio.server.services`/`.versioned`/`.historySuffix` only when it carries them (the pre-login reply under auth leaves them). Under auth `_verify` never runs: `_probe` re-reads after login and on authenticated reconnects, judging the floor alone.

**mkio floor**: mkui 1.x is built against mkio 1.x. `judgeServer` fails reason `version` on a reply whose `mkio` major is not `MKIO_MAJOR`, `expect` or not (an unparseable `"dev"` passes); `mkui serve` refuses another major (`check_mkio`); `config.mkio.expect` is optional (keys in the README): the query runs either way to fill `mkio.server.*`, timing out per `config.mkio.timeout` (5s). The `connected`/`disconnected`/`incompatible` maps are `"state.path": value` objects.

**Outage treatment** (`_watchConnection`; `lib/connection.js`, `tests/connection.test.js`): off `mkio.connected`/`mkio.reason` it stamps the phase (`connecting` | `connected` | `disconnected` | `incompatible`) as the root `mkio` attribute, keying the statusbar colours (`--mkui-danger`/`--mkui-warn`), the `.mkui-conn-dot` light and the `[stale]` tint. mkio's client fires `onDisconnect` on every failed retry (~1s); `Outage.down()` is true once per outage: sets `mkio.downSince`, ticks `mkio.downFor`, swaps tab title/favicon, sets `[stale]`, shows `.mkui-banner` (before the workspace; `[banner]` shifts it by `--mkui-banner-h`) after `offline.delay`, at once when incompatible. Panes stamp `.mkui-table-stale`/`.mkui-record-stale` ("as of HH:MM:SS") on disconnect, cleared by the next callback (`heard()`). `mkio.offline` keys default on. No Retry: the client retries.

## Authentication

`config.auth` → a login dialog before frames load. `method: "mkio"` (default) calls `client.auth(...)` against mkio's `_mkio_users`; `"custom"` uses `app.registerAuthHandler({ authenticate })` → `{ user, role }`.

Config keys are the README's; `connected` applies after login *and* on reconnect (mkio's client re-authenticates), `disconnected` falls back to `mkio.disconnected`. State: `auth.authenticated`/`user`/`role`. Action `auth.logout` reloads the page. `_verify` is skipped (see above); `mkio.connected` still applies on socket open.

Login dialog: `stayOnTop`, `noDock`, undismissable (`_hideClose`, empty `_extraControls`).

## mkio-table pane type

Config keys are the README's; `type` and `service` are required. Defaults: `protocol` `"query"`, `columns` the first row's keys, `maxcount` 200 (`null` = no paging), `start` `"today"`. A subpub `topic` may be a list, one subscription each.

Row identity: query `_mkio_row` (the pk, or a join's `key`), stream `_mkio_ref`, subpub `_mkio_topic`. `_mkio_*` columns hide unless `columns`/`visible` names one of `SHOWABLE_COLUMNS` (lib/history.js); `noteMkioCols` remembers it, so hiding keeps it in the picker, and `MKIO_LABELS` heads it.

Derived columns: `values = { col = "<expr>" }` derives a column with a cell-scope expression, `value` the raw `row[col]` (NULL for a virtual column). Every column read goes through `cellValue`, so a derived column acts like a real field; a virtual one must be listed in `columns`. Button payloads carry raw row fields; a bad expression warns once.

Conditional styling: `styles = { col = <styler> }` styles a cell, `rowStyle = <styler>` the `tr`. The styler shapes and style keys are the README's; `lib/styles.js` compiles (`compileStyler`) and applies (`applyStyle`) them, shared with `mkio-record`. Cell rules see the cell scope, row rules `rowScope`; a rule whose condition errors warns once, never matches. Backgrounds are never inline: they ride `--mkui-cell-bg`/`--mkui-row-bg` plus `mkui-cell-styled`/`mkui-row-styled` marker classes placed *before* the selection rules so selection tints win (`tests/styles.test.js`).

Display templates: `display = { col = "<template>" }` is presentation only (shown text, width stats, clipboard); sorting, filtering and dropdowns use the value. Cell scope (`cellDisplay` → `{ text, rich, error }`). A template may yield a **rich** value (`lib/rich.js`, produced by the `mkui` library the README lists). `renderCell` builds spans via `renderRich` (segment colors inline on the span, never the td; badges/bars ride `--mkui-badge-color`, `--mkui-bar-frac`, `--mkui-bar-color`), flattened text on `td._mkuiText`. An error renders `#ERR`, warns once.

Selection publishing: `select = { state = "path" }` writes the current row to app state per selection change (the cursor's row, else the first selected in view order, else `null`), deduped by identity.

Programmatic selection: `selectRows(keys, { focus = true })` selects by identity as a click does (one `refreshSelectionStyles`: followers never see null); `[]` clears. A tree opens each key's collapsed ancestors; filters are untouched, so a key they hide comes back `hidden`, one not in `rows` `missing`, the rest `selected`. Hook `_select` (`get` → `{ keys, focus }`, `on` for followers); `workspace.selectPane`/`getPaneSelection`; `table.select`; not in layouts, not re-applied after a snapshot.

Numeric alignment: per-cell padding (`--mkui-num-pad`, ch) aligns decimals (`colStats.maxFrac`), dropdown too. Flashes `mkui-flash-in`/`-out`/`-update`; a `subid` per pane.

Selection: two exclusive modes plus an always-present **focused cell** (`.mkui-cell-focus`), the *implicit* selection copy, row-unit buttons and broadcasts fall back to (its row `.mkui-row-hl`). Row mode: the sticky-left **row-number column** (`rowColumn: false` disables; view position, per-level in a tree; outside stats/reorder/resize). Rects are anchor/focus `(key, col)` pairs plus a `keys` snapshot of the rows spanned when last user-modified (`snapRectKeys`): membership is that record set × the column range, so sorts/filters move the same records and live inserts don't join (`rectBounds` maps keys to view-index runs). Escape clears the selection, not the cursor. Filter changes prune `selectedKeys`; copy and actions see view rows only.

Clipboard: `copySelection` builds the README's grid via `writeGrid` + `makeCopyStatus` (`lib/copy.js`, shared with history and `mkio-record`; 100k+ rows skip HTML).

Buttons: `enable.when = "<expr>"` gates one on the selection (scope `rows`, `row` (first or NULL), `cells`, `selection` `{ count, rowCount, cellCount, unit }`, `connected`, `state`) beside `connected`/`minSelected`/`maxSelected` and `unit` (singular units default min/max to 1). Gates re-evaluate on selection, filter and connection changes and on a live change to a selected row (`refreshButtons`). A button's `args`/`data` resolve against the button scope. `style = <styler>` sees the button scope plus `enabled`; backgrounds ride `--mkui-btn-bg` + `mkui-btn-styled`.

Sorting: priority is a digit in the caret (`.mkui-sort-num`); numeric vs string auto-detected.

Configured sort: `sort = <spec>` seeds `sortKeys` at init and on `mkui-pane-open` (`loadSortSpec`); `sortFromSpec` reads the README's shapes, a bad one warns `bad sort`, changes nothing. `setSort` replaces and re-applies (`applySort`). Hook `_sort`; `workspace.setPaneSort`/`getPaneSort`; `table.sort`.

Column visibility: one presentation state, `visible`: `null` (default) or an ordered array (README). Header-drag reorder and hiding materialise the list; "Show all" returns to `null`. `visibleColumns()` (cached) intersects it with known columns (a name ahead of the data is kept, skipped); every render, measure, copy and selection path uses it. `visibleFromSpec` warns `bad visible` on a non-string or a duplicate. API via `applyVisible`: `setVisible`/`getVisible`, `showColumns` (placed by `columns`-order neighbours), `hideColumns` (the last stays), `showAllColumns`, `resetVisible`; seeded before the header first renders and on `mkui-pane-open`. Hook `_columns = { set, get }`; `workspace.setPaneColumns`/`getPaneColumns`; `table.columns`.

Columns button & picker: `.mkui-columns-btn` (+ `.mkui-columns-badge` hidden count) rides a right **gutter** (`--mkui-columns-gutter`, 26px) off the sticky `.mkui-columns-anchor`, toggling `.mkui-columns-picker` (it and a filter dropdown close each other): search, an actions row scoped to the matches, then the list, flat in `columns` order or one tri-state `.mkui-columns-group` per `colGroups()` entry, folded unless it holds a shown column. "Hide all" keeps the last column; unscoped "Show all" is two-step (a query disarms). The header dropdown's `.mkui-filter-colops` row is that column's own: "Hide column" (inert on the last), `.mkui-filter-applied`, the link ops under `advanced`.

Column groups: `groups` categorises columns for the picker only; `visible` stays the truth. Parsed once into `colGroupsSpec` (bad entries warn `bad groups[i]`; a column in two keeps the first). `colGroups()` cuts them to known columns, drops empty ones, adds "Other". `inferColumns(row)` puts grouped keys first.

Tree rows (`tree = { child, parent }`, README). Maps beside `rows`: `parentOf` (null = root, `undefined` = hidden orphan), `kids` (`null` → roots), `depthOf`, `expanded`, `pendingKids` (adopted by `linkRow` on arrival). `unlinkRow` re-homes a deleted parent's children; a cycle warns once. **`view` = pre-order flattening of rows whose ancestors are all expanded** (`rebuildView` → `flattenVisible`, cached). Live: `insertRow` → `linkRow` → `treeInsertIntoView`; a re-parent or sort-key change dirties the view, a re-parent `syncToggle`s both parents. `setExpanded` splices the subtree in or out, `pruneSelection` drops hidden keys; `setExpandDepth` does bulk. Row numbers are per-level positions among *all* siblings in sort order (`rankOf`, `shiftRanks`, `rowLabel`; flat tables: `flatRanks`). Filters carry `scope` (`roots` default / `children` / `all`; `tree.filterScope` overrides): `matchesFilters` judges `roots`/`children` by level, `all` via `buildSubtreeOk` in `rebuildView`, so while one is on every change rebuilds (`allScopeActive`). `filters` is keyed `fkey(col, scope)`, up to three a column (`filtersFromSpec` reads an array); `.mkui-filter-scopes` tabs (Top / Child / Branch) hold one each, shown on alt/option-click or when a column is filtered off `roots`. Caret column = `tree.column` if visible, else the first (`treeCol`); header `.mkui-tree-all` opens the roots (shift: all levels) or closes all — shift with `allExpanded()` closes all too, so shift-clicks pair up (caret and title synced in `render()`). Hook `_tree = { expand, toggle, expanded }`; `workspace.expandPane`/`table.expand`; not in layouts.

Find: `_editActions.find` (Ctrl/Cmd+F, `edit.find`) opens `.mkui-table-find` (`findOpen`). `compileFind` builds one RegExp (invalid → `.mkui-find-error`); `scanFind` fills `findMatches` (header first, then `view` × `visibleColumns()` on shown text) in rAF chunks. `findScanRev` = the `viewRev` scanned: `render` reschedules on drift, `applyVisible` rescans at once, `findPos` surviving by identity. `findGo(dir)` steps and wraps; `showMatch` = cursor move + scroll (`.mkui-cell-match`, `.mkui-th-match`/`-current`). Hooks `findNext`/`findPrev` (`findStep`: Ctrl/Cmd+G / +Shift+G, F3; closed → reopen on the last query, then step); Escape closes, after `clearSelection`. Not in layouts.

Sort & filter chips: the table's DOM is a flex column: toolbar, the find and as-of bars while open, the scroll area, then progress or the paging bar. The toolbar exists only while it has buttons, extras or chips (`syncToolbar`); buttons first, `.mkui-table-chips` last. `renderChips` builds a `.mkui-chip-group` per kind (sort, filter, link) led by a `.mkui-chip-lead` with the clear button (`lib/chips.js`); a filter chip's `.mkui-chip-check` switches that filter off, alt-click on the lead is `toggleAllFilters`.

Range filters: numeric and all-time columns get a **Values | Range** switch (typing applies debounced, Enter at once; either drops the preset). A filter is `{ kind: "values" | "range", … }` (`describeFilter`). Numeric `hi` is inclusive; time `hi` *exclusive*, covering the whole unit typed. Preset bounds resolve against the clock (`rangeBounds`, memoised per second; `today` is the browser's day even on a UTC column); `syncPresetTimer` re-applies every 30s. Inference in `colStats`: `numeric` first, then `temporal`/`timeKind` (`bumpTemporal`: every value an mkio ref, ISO-8601 or a bare clock time); nothing else is guessed: `types = { col = … }` declares `parse`, `unit`, `tz` (lib/timeparse.js); `format`/`zone` render the cell (`formatTime`; bare `%f` = the fraction as parsed, via `strptimeFields`; `timeShown` feeds `cellDisplay`, `shownDifferently` covers it where `display` templates are special-cased; `isLocalCol` follows `zone` for the picker).

Filtering: each column header has one icon slot, `updateHeaderState` swapping the hamburger for the sort caret; either opens the same panel, placed by `placeDropdown`. Lists open at content height, capped by `fitList` above `dropdownFloor()` (an inline `max-height`, `resize: vertical`); a dragged height is kept per kind. Changes apply at once; filters persist across resubscribes. A values filter records intent (`mode: "include" | "exclude"`): an empty exclusion is no filter, an inclusion always is.

Off filters: `f.off` suspends one without unmaking it: kept, chipped (`.mkui-chip-off`; `describeFilter(f, { state })` puts `(off)` in the tooltip), applied by nothing: every read skips it (`matchesFilters`, `allScopeActive`, `syncPresetTimer`, `flatRanked`, via `anyFilterOn`). `setFiltersOn(keys, on)` from the chip check, the colops `.mkui-filter-applied` box, `toggleAllFilters`. Header btn `.mkui-filter-off` when a column's are all off (CSS after `.active`/`.mkui-filter-linked`). `×`/`clearFilters` still drop.

Configured filters: `filters = { col = <filter> }` seeds them at init (before data) and on `mkui-pane-open`. `filterFromSpec(col, spec)` reads the README's shapes, framing a range by `types[col].type` else the entry's `type` else the bounds, through `inputToBound`; `off = true` ships one switched off. A bad entry warns `bad filters.<col>`; `null`/`""` clears. `filterToSpec` is the inverse: `getFilters()` round-trips through `setFilters(map, { merge })` (replace by default; `merge` keeps other columns, `null` clears one). Hook `_filters`; `workspace.setPaneFilters(id, filters, opts)` (`id == null` = the focused pane), `getPaneFilters(id)`; `table.filter`.

Embedding: `_source = { set({ filter, topic }), get }` re-aims a table at another slice of its service; `_data = { rows, view, selected, on }` reads what it holds, `on` coalescing to one call per task; `_toolbar = { extras, sync }` takes an embedder's controls into the toolbar (made on demand; `sync`, since an empty toolbar is not in the DOM).

Virtualized rows: only those in the viewport (plus overscan) are in the DOM, two `.mkui-vspacer` rows carrying the rest's height. Data: a `rows` Map plus `baseOrder`; `view` is the filtered+sorted key array, `render()` reconciling the shown slice with keyed `tr`s (stepping over a deleted row's `_leaving` element, which fades out in place until `animationend` removes it); inserts/deletes/replaces patch it, sort/filter changes dirty it.

Column widths: once the header row exists (`columns`, else first data), each header is measured under `width: max-content`, locked via `<colgroup>` + `table-layout: fixed`, capped at half the pane. They only grow: `bumpStats` canvas-measures values, `growColWidth` ratchets once per render, sparing `userSized`. Paged streams size columns from first data only (`growSuspended`). Pane resizes don't move them: a trailing filler (`.mkui-th-filler` + widthless `<col>`) absorbs the rest (`tests/styles.test.js`). Each divider's `.mkui-col-resizer` grip (on the *following* header cell's left edge) resizes the column to its left; header cells must not clip. `colWidths` is keyed by name (reset on reopen); a grip's double-click auto-sizes every selected column (80% viewport cap).

Paging (query): the client accumulates every page, firing `onSnapshot` once; `applySnapshot` ingests in chunks (`nextChunk`: rAF or a 250 ms timer for hidden tabs; a generation counter drops stale ones; `ingestTouched` skips rows a live change reached first). `applyInsert` of a held row replaces. `onNack` stamps `mkui-table-failed` (click resubscribes).

Paging (stream): the first fetch starts at local midnight (`start: "today"`, a UTC ref) or the buffer's start (`""`). Ref-based: each page its own `subscribe` via `fetchPage(ref, before)` + `onPage` (Later: `lastRef`; Earlier: `firstRef`, `before: true`). An empty first fetch sets `firstRef` to the start ref; an empty backward one restores the prior page (`prevPageLoadRef`/`-Before`), sets `noPrev`. `⟳` re-fetches from `pageLoadRef`/`pageLoadBefore`; off in live mode. `lastRef` advances on each snapshot, delta, update, `fetchPage`; `sub()` with `lastRef` keeps rows and resumes there, else clears (query/subpub never set it).

`● Live` resumes streaming on the main `subid` from `lastRef`, disabling Later; Earlier prepends through `pageSubId` (`fetchPrevLive`). Exiting unsubscribes both and re-fetches the saved page, view state kept. `live: true` fetches the start page first, handing off from its `onPage` (`autoLivePending`, re-armed on reopen), as going live from `sub()` would replay the buffer; an empty start page seeds `lastRef` from `getStartRef()`. A drop in live mode shows "Disconnected" for the Live dot, live mode staying on (the `mkio.connected` subscription sits *after* the paging variables: `State.subscribe` fires synchronously).

Tail following: callbacks sample `shouldFollowTail()` *before* ingesting (stream + live, near bottom), then `scrollToTail()`.

Visibility-aware subscriptions: an `IntersectionObserver` gates them (5 min hidden drops). `mkui-pane-close` sets `closed` and unsubscribes; `mkui-pane-open` clears it, drops stale rows/sort/filter/paging/tree/find/undo state (links stay), re-observes.

Snapshot clearing: query/subpub `applySnapshot` clears rows, DOM, selection (a reconnect fires `onSnapshot` without `sub()`); streams append.

## Table linking

`link` (README shape) is read by `linkFromSpec` (bad → warns); `chips = false` → `linkChips`, read once. `App.links` is the `LinkHub`: `publish(source, { name: values | null })` retains per name (owner-only retract, repeats skipped), queues delivery (`MAX_CHAIN` cuts a loop), mirrors `state.link.<name>`. `linkSource` = pane `data-id` else `subid`. **Broadcast**: `broadcastSelection()` from `publishSelection` and a live change `inBroadcast`: `getBroadcastRows()` (selected rows plus, in a tree, every descendant, collapsed or filtered) → distinct `cellText` per name; null when empty/paused/closed. **Listen**: `onLinkDelivery` (ignores own source, paused, closed) → `putLinkFilter`: an include filter marked `link: name` at `fkey(column, scope)`, the column's own stashed in `linkStash` (restored on null); `refreshLinkFilters` catches up from `hub.current` at init, pane open and toggles. Linked filters: skipped by `getFilters`, kept by replace-mode `loadFilterSpecs` unless an entry names the column; a user edit unmarks (`dropLinkStash`). Hook `_link = { set, get }` (`setLink(spec, { merge })`: null entries drop names); `workspace.setPaneLink`/`getPaneLink`; layouts save `panes[id].link` (config, never the filters). UI: `makeLinkChip`, `.mkui-th-linkmark`, dropdown `makeLinkOp`, `makeLinkToggle` when `!linkChips`. Close: `hub.retract`, unsubscribe. (`tests/links.test.js`)

## Detail windows

Which record a window is about is `lib/subject.js`, DOM-free: `parseRecordSpec` reads the `record` block (one of `follow`/`listen`/`state`/`key`, plus `retain`, `listening`, `title`; bare string = `follow`; throws → callers warn `bad record`), `recordSpecToConfig`/`mergeRecordSpec` round-trip it for layouts and `merge`, and `RecordFollower` emits `{ key, row, of, from }` with a *why* (`change` | `refresh` reload the pane, `spec` redraws controls). `sameSubject` dedupes by key, else row identity. `coerce` makes a hub string a number only when it round-trips (`"007"` stays). Every source read goes through `_offer`, honouring the pin (`listening: false`) and `retain`. `attachRecord(paneEl, spec, app, onRecord, { ws, warn })` installs `_record = { get, set, on, follow, config, refresh }` and returns the follower **unstarted** (its first read can land synchronously, before the caller's `const` exists). (`tests/subject.test.js`)

Workspace: `paneRows` (`_history.rows()` ?? `_data.selected()`), `setPaneRecord`/`-Source` + getters, `onPaneRecord`, `showPaneRecord` (= `table.record`); actions `record.show`/`record.follow`; layouts carry `panes[id].record`, the config only. `mkio-record`: `fields`/`labels`/`display`/`styles`/`groups`/`widgets` (a `source` pane lends them), one live query subscription per record, hooks `_data`/`_toolbar`/`_editActions.copy`; key columns from `spec.key`, else the source's `history.key`, else `pkFromSchema`. (`tests/record-pane.test.js`)

## Record history

`mkio-history` (pane type; `source` = the table lending its `history` block, `labels`, `display` and, without a `record` block, its selection): an `mkio-table` over `history.feed`, filtered server-side to the record (`recordFilter`; `_mkio_version` ascending, mkio's columns first), a panel below. `ensureTable` builds it once, `_source.set` re-aims it per record (view state kept); the pane reads `_data` (the chain) and `_select` (one version vs its predecessor, a range's ends, else `defaultVersion`, the cursor, selected once a record). Key from `history.key`, else a shared `_mkio` `{table}` request whose `unversioned` list (`unversionedFromSchema`) drops those columns from the versions table and marks the field `mkui-record-unversioned` in `mkio-record`; the cursor is the row's `_mkio_version`, else `history.state`. Hooks land on the pane. No head: the record names the tab (`setPaneAutoTitle`), `v2 of 3` and Copy sit in the panel header (`.mkui-history-at`). Lines are one grid (`.mkui-history-fields[data-view]`, `fit-content`, min the panel; subgrid lines) under a sticky `.mkui-history-cols` head whose `.mkui-history-colgrip`s (`dragColumn`; floor `MIN_COL`, no ceiling: the panel scrolls) set `--mkui-hist-name`/`-mid`/`-last` on the panel in px (`widths`: `name` shared, a pair per view; `sizeColumns` fits a null at render or the panel's first layout to content, capped by `FIT_SHARE`; dblclick refits; not in layouts); `panelLines` skips the head; the subject strip, Diff | Blame, unchanged ride the table's toolbar via `_toolbar` (`.mkui-record-bar` before). `showPaneHistory(paneId, keys)` registers `_history:<src>` once, then re-points it (`table.history`). (`tests/history-pane.test.js`)

A cursor move flashes `mkui-flash-undo`/`-redo` (`-out` as the row leaves), from `cause` (`onUpdate`'s 3rd arg); else only a fallen `_mkio_version` is caught.

As of: `history.asOf` (`{ service, param = "as_of" }`, query tables only). The button toggles (`syncAsOfBtn`, `active` while `asOfOpen`); the bar's × and Escape `closeAsOf`, going live first. `applyAsOf` requests it, stamps `idKey` on the rows via `mkioRowId` (mkio's `_mkio_row` shape, absent from a reqrep reply), unsubscribes, `applySnapshot`s. While `asOfRef` is set every button is shut, apply* drops live changes, `sub()` refuses; Live re-subscribes.

Blame: the `Diff | Blame` switch (`view`, a preference outliving the record) reads `blame(chain, { upto })`; a line's click goes to it.

Undo/redo: `history.undo` / `history.redo` (`{ service, op, label }`) put a button each in the toolbar (`.mkui-history-step`), over the selection. Undo reads the row's `_mkio_version`; redo needs what is recorded *above* it, which it cannot tell: `history.state` (debounced probe, `cursorCache`, dropped on a `cause`) or this session's undos (`undoneHere`). An undo at v1 removes the row, so the intent is marked *before* the send (its delete beats the ack): `applyDelete` files it under `undoneAway`, clears the selection; Redo unselected takes the top. `confirm` (default on) is a dialog (`submitPerRow` + `rowData` over the keys) reading `versions` for the fields moved. Hooks `_editActions.undo`/`redo`, `_history.step`/`can`; no shortcut: shared state. Keys as `mkio-record`'s.

## Control channel

`config.mkio.control = "<service>"` → `<mkui-app>._subscribeControl` subscribes (subpub, `subid` `mkui-control`, no topic) after connect, or after login under auth; each `update` row `{ action, args }` → `app.fireAction`. Server: `mkui.control.ControlService` (`{ protocol = "subpub", access = "auth" }`; `on_subscribe` answers an empty snapshot, `send(action, args, user=)` pushes `make_update(op="action")`, `link(pane, …)` builds `table.link`, `alert`/`confirm`/`dialog` the `dialog.*` ones, a button's `submit = { service, op, data }` sending the answer); `install(app)` registers it, returning a late-binding handle; `cmd_serve` installs it. `tests/test_control.py`.

## Saved layouts

`[layouts]` enables it (`store` `"mkio"` when `mkio.url`, else `"local"`). `workspace.getLayout()` → `{ version, frames, focused, panes }`: docked frames in z-order (no noDock/stayOnTop); open panes' view state via the `_filters`/`_sort`/`_columns`/`_link` hooks (`_paneState`), never a paged table's position. `sanitizeLayout` throws on a non-layout, drops unknown panes; `LAYOUT_VERSION` per major. `setLayout(layout, { reopen })` diffs open panes: stayers move, leavers get `mkui-pane-close`, arrivals `mkui-pane-open` then saved state (`_applyPaneState`, waits on `el._ready`). `resetLayout()` = `frames`, `reopen: true`. **Closed windows**: `_closed` (paneId → `{ frame: { x, y, w, h, title }, …state }`) is written by `_rememberPane` as a dockable frame closes (`closeFrame`, `setLayout`'s leavers: state read before the close event), rides `panes[id]` in the layout (`frame` marks a closed entry; the sanitizer keeps a known pane's, drops unknown), is overlaid by a restored layout's entries, consumed by `showPane` (opens at `frame`, applies the state after `mkui-pane-open`; else the cascade), cleared by `reopen` and `unregisterPane`. `LayoutManager`: owner = `auth.user` if authenticated, else `""`; `save` skips a `sameLayout` to the newest, prunes by `retained`; stores *resolve* with error envelopes. `_loadFrames`: `restoreLatest()` within `timeout`, else `frames`.

## Dialogs

`openDialog(spec, context, app, extra)`: a `stayOnTop`, `noDock` frame resolving with the form data on submit, `null` on cancel/close.

`spec.fields` — item kinds, field types (incl. `checklist`, a select's `size`), `optionsFrom` (`fill`, `remember`, `empty`), submit: `mkui/static/src/widgets/CLAUDE.md`.

Sections: a `{ group }` heads `.mkui-dialog-section` with every item to the next header (`sectionOf`; its `showWhen` hides them via `isShown`), or with its own `fields` just those. `collapsible` makes the head a button (`renderSection`: caret, summary pill; click/Enter/Space, alt = all); `collapsed` (bool/expr, read once); `remember` (per toggle); `.mkui-dialog-collapsed` hides the body; folded fields still submit and `validate` unfolds a failing one. Summary: `summary`, else `changedIn` vs `initial` (snapshot at open/`resetForm`). `fitFrame()` grows the frame (never shrinks): centered at open, then title-bar-anchored (`seen`), rising only by any overshoot below.

Dynamic form: every edit runs `applyDynamic` (`onFieldChange`) over `formScope()`: fields by name (numbers as numbers, blank → NULL), `form`, the open context. Flags `showWhen` (fields, `{ row }`, `{ group }`, select options), `required`, `disabled`, `readonly` take a boolean or expression; text keys and `min`/`max`/`step`/`pattern` are templates; `options` may be an expression yielding the list. `value` is the one-time default; `compute` (expression or `${` template) re-evaluates on every change: always on `hidden`/`readonly`, on an editable field until the user types (`dirty`, cleared by `resetForm`). Computes and option rebuilds loop to a fixed point (`MAX_COMPUTE_PASSES`, then one warn); then visibility, attributes (`resolvedAttrs`), title, note. `tests/dialog.test.js`.

Keys (`onKey`): Escape closes unless `pinned` (`cancel`, also the pane's `_editActions.cancel` for a window-level Escape on the focused frame); Enter submits off a single-line field (a textarea or button keeps it); ctrl/cmd+Enter submits anywhere, defaults stopped, section heads letting it bubble.

Message boxes: `hasMessage(spec)` → `.mkui-dialog-message` (`syncMessage`). `normalizeButtons(spec)` replaces footer and pin: one `cancel` (= Escape, ×; `dismissed()`), a `default` never `danger`, `effects` after close; resolves `{ button, data }` (`finish`). `syncButtons` + a `ticker`: busy/`enable`/`arm`/`timeout`. `suppress` answers from storage before anything is built; `id` replaces the open one (`openIds`); `modal` → workspace `.mkui-scrim` under the top modal frame + root `[modal]`; `specStatePaths` re-runs the dynamic pass on state. `lib/dialogs.js` (`tests/popup.test.js`) builds the specs; `asks(item)` (sync), then `confirmed(app, item, ctx)`, gate menus and buttons. `App.dialog(spec | name, ctx)`/`alert`/`confirm` back `dialog.*`.

Pin button: `icon("pin")` via `frameEl._extraControls`; pinned, a *confirmed* submit resets the form instead of closing (`resetForm`): `spec.pin = "keep"` holds every field's value and dirty mark, a field's own `pin: "reset"` (or the default) restores its default and re-runs its `remember` recall (`resets`); errors clear and `snapshotInitial` re-baselines either way.

## Conventions

- Pointer guards: every mousedown/pointerdown that opens a menu or starts an action/drag checks `ev.button === 0` (except the frame-raise mousedown). Modified clicks are inert where the modifier means nothing: sort headers ignore ctrl/cmd/alt (shift keeps multi-sort), the select-all corner ignores all. `tests/pointer-guards.test.js`
- Icons are inline SVGs (`icon(name)`), never text glyphs: `currentColor`, sized by `.mkui-icon`, whose `pointer-events: none` lands hits on the hosting button (`tests/styles.test.js`)
- `registerPaneType(name, factory)`: custom content; `registerWidget`: inline widgets
- Layout tree invariant: every leaf sits inside a `{ type: "tabs", children: [...] }`; no bare strings after normalize
- CSS invariant: `mkui-menubar`/`mkui-statusbar` are `box-sizing: border-box` so their height equals `--mkui-menubar-h`/`--mkui-statusbar-h` exactly; the workspace is positioned by those (`tests/styles.test.js`)
- Stability: mkui 1.x follows Semantic Versioning over the surface README "Versioning" lists. `tests/surface.test.js` decides: a removal fails until the major is bumped, an addition until `tests/surface.json` lists it.
- Platforms: Linux, macOS, Windows (mkio 1.0.1+). `cmd_init` writes `encoding="utf-8"`; `.gitattributes` keeps LF for `vendor-sync.test.js`.
- Tests: `node:test` + `assert/strict`
