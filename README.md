# mkui

[![PyPI](https://img.shields.io/pypi/v/mkui)](https://pypi.org/project/mkui/)
[![Python](https://img.shields.io/pypi/pyversions/mkui)](https://pypi.org/project/mkui/)
[![License](https://img.shields.io/pypi/l/mkui)](https://github.com/markuskimius/mkui/blob/main/LICENSE)

A config-driven, dependency-free web GUI framework with a floating-frame
workspace and dockable panes inside each frame. Designed to pair with
[mkio](https://pypi.org/project/mkio/) — the same project's TOML-driven microservice backend —
but works against any backend (or none at all).

Tables are live, selectable, filterable and copyable; where mkio
[versions](https://pypi.org/project/mkio/) a table, mkui reads the record
history that comes with it — every version of a record as a table of its
own, what changed between any two of them, who last set each field, undo
and redo with a confirmation that says what will change, and the table as
it stood at a moment.

## Model

```
mkui-app
├── mkui-menubar
├── mkui-workspace
│   ├── mkui-frame  ← floating, movable, resizable. Clamped to workspace.
│   │   └── layout tree
│   │       └── TabGroup
│   │           ├── tab bar
│   │           └── mkui-pane  ← leaf content host
│   ├── mkui-frame
│   │   └── split (h | v)
│   │       ├── TabGroup → panes
│   │       └── TabGroup → panes
│   └── ...
└── mkui-statusbar
```

Top-level windows are **frames** — floating chrome with 8-way resize.
There is no dedicated titlebar: every tab bar at the top edge doubles
as a drag region, and the right-most one also carries the window
controls. Frames don't dock into each other. Inside each frame lives
an independent, normalized layout tree of **splits**, **tab groups**,
and **panes**. Docking — splitting, tabbing, tearing out — happens
entirely inside frames.

**Design commitments** (things meant to hold up indefinitely):

- **Structural invariant**: every pane leaf sits inside a tab group. A
  single-pane frame is a single-tab group. This removes a whole class of
  special cases from the renderer and the drop logic.
- **Proportional resize by construction**: frame positions are fractions
  of the workspace rect, and split ratios sum to 1. Resizing the browser
  rescales every frame, every split, and every pane with no extra code.
- **Viewport clamping invariant**: every frame move/resize passes through
  a single `clampToDock` helper. Frames cannot escape the workspace —
  shrinking the viewport drags stragglers back in.
- **Stable pane identity**: pane elements live in a workspace-owned pool
  and are re-parented via `appendChild` when re-docked. Content state,
  subscriptions, scroll position, and DOM focus all survive.
- **Zero runtime dependencies.** Web Components, so it drops into
  React / Vue / Svelte / vanilla identically. All chrome icons (window
  controls, tab scroll arrows, sort carets, filter hamburgers, paging
  controls) are
  inline SVG built from vendored path data — no icon font, no external
  fetch, and they recolor with the theme via `currentColor`.

## Interactions

- **Top tab row** → drag the whitespace next to the tabs to move the
  frame (clamped). **Double-click** the same region to toggle maximize.
  On non-docking frames (dialogs, login) the title tab itself also
  drags the frame — it acts as titlebar text.
  **Frame edges/corners** → 8-way resize (clamped, min 180×80).
- **Dragging a tiled or maximized frame** restores it to its pre-tile
  size under the cursor on first motion. Resize handles or explicit
  maximize-toggle also clear the restore state.
- **Frame close button** → closes the frame; panes inside are parked in
  the pool (state preserved) and can be brought back by code.
- **Tab click** → switch active pane in that tab group. Clicking a tab
  or pane content also makes that group the keyboard-focus target;
  clicking the bar's empty area only raises the frame.
- **Tab drag within the bar** → reorders the tab in its group. If the
  cursor leaves the tab bar by more than a few pixels, the pane is
  **torn out** into a new frame at the cursor.
- **Tab overflow** → tabs shrink to fit the bar, down to 3em of label
  each. If they still don't fit, the strip clips with no scrollbar and
  ‹ › scroll arrows appear on either side of it; arrows dim at their
  end of the strip. The bar always keeps at least one tab plus the
  arrows visible, and the active tab is scrolled back into view
  whenever the bar re-renders.
- **Alt+Shift+Left / Alt+Shift+Right** → move the active tab left or
  right within its group (acts on the top-most frame).
- **Ctrl/Cmd+C, Ctrl/Cmd+A, Ctrl/Cmd+F, Ctrl/Cmd+G (Shift: previous),
  Escape** → copy, select-all, find, find next / previous, and
  cancel or clear-selection, routed to the focused frame's active pane
  (tables implement them all; a dialog answers Escape by closing, so it
  goes whenever its frame is the focused one, whatever has keyboard
  focus; the find keys are taken over from the browser, whose own find
  can't see a virtualized table's off-screen rows). Either modifier
  works on every platform; text inputs and native text selections keep
  the browser behavior.
- **Dragging a torn-out (or any single-pane) frame over another frame**
  shows drop zones: edges split, center adds as a tab. Release to dock.
- **Splitter drag** → resize the ratio between two children of a split.
- **Left button only** — menus, drags, resizes, sorting, and selection
  respond to the primary mouse button; right and middle clicks are inert
  (except that any button raises a frame, matching OS convention).
  Modified clicks are inert where the modifier has no meaning: e.g.
  ctrl/cmd/alt+click on a sort header leaves the sort untouched
  (shift+click still builds multi-column sort).
- **Any mousedown inside a frame** raises it to the top of the z-order.
  The top frame gets an accent border; within it, the last-clicked tab
  group's selected tab is raised in the selected-tab color, while
  selected tabs of other groups (and of unfocused frames) flatten to the
  idle tab color — the raised tab marks the bar keyboard hotkeys act on.

## Configs

mkui's runtime input is JSON. When the backend is mkio, add `config_dir`
to your `server.toml` and point your HTML at `/config/client.json` — mkio
reads `client.toml` from that directory and serves it as JSON. The browser
never needs a TOML parser. For other backends, author or generate
`client.json` directly.

Minimal config:

```json
{
  "app":     { "title": "Trading desk", "theme": "dark" },
  "menubar": [{ "label": "File", "items": [{ "label": "Quit", "action": "app.quit" }] }],
  "statusbar": { "left": [{ "type": "text", "bind": "status.message" }] },

  "panes": {
    "orders":    { "title": "Orders", "type": "mkio-table", "service": "all_orders", "protocol": "query" },
    "chart":     { "title": "Chart",  "widgets": [{ "type": "text", "text": "Chart goes here" }] },
    "inspector": { "title": "Inspector", "widgets": [{ "type": "text", "text": "Properties" }] }
  },

  "frames": [
    {
      "id": "main",
      "x": 0.05, "y": 0.05, "w": 0.65, "h": 0.9,
      "layout": { "type": "tabs", "active": 0, "children": ["orders", "chart"] }
    },
    {
      "id": "aux",
      "x": 0.72, "y": 0.05, "w": 0.23, "h": 0.9,
      "layout": { "type": "tabs", "children": ["inspector"] }
    }
  ],

  "mkio": { "url": "/ws" }
}
```

Frame positions (`x`, `y`, `w`, `h`) are fractions of the workspace rect.

A frame is a **window** the config defines, and it need not be open from
the start. `"open": false` keeps one closed at startup — a composite of
docked and tabbed panes, linked through their own `link` and `record`
blocks, that a single menu item brings up whole:

```json
{ "id": "desk", "title": "Order Desk", "open": false,
  "x": 0.1, "y": 0.1, "w": 0.8, "h": 0.8,
  "layout": { "type": "split", "dir": "h", "ratios": [0.6, 0.4],
              "children": [{ "type": "tabs", "children": ["desk-orders"] },
                           { "type": "tabs", "children": ["desk-detail"] }] } }
```

`frame.show` with the frame's id — a menu item's `action` and `args`, or
`control.frame("desk")` from Python — opens it where the config puts it,
its panes wired as configured. Open already, the window is raised, so
the same item brings back a startup window that was closed. A pane
lives in one window at a time: one open elsewhere moves into the window
as a tab drag would move it, so a window meant to stand beside the main
one uses panes of its own, with link names of its own; a pane that was
parked comes back with the view state it was closed with, as `pane.show`
brings it back. `{ "frames": true }` in a menu lists every defined
window by `title` (else id), and `layout.reset` closes the on-demand
ones again. The Order Book example's *Order Desk* is one.

## Statusbar

`statusbar` is a top-level object with `left` and `right` widget arrays,
plus an optional `bindStyle` map that binds CSS properties to state paths:

```json
"statusbar": {
  "left":  [{ "type": "text", "bind": "status.message" }],
  "right": [{ "type": "text", "text": "v0.1" }],
  "bindStyle": { "background": "status.background", "color": "status.color" }
}
```

Each `bindStyle` entry subscribes to the given state path. When the value
changes, the CSS property is set as an inline style on `<mkui-statusbar>`.
Setting the state value to `null` (or empty string `""`) removes the inline
override, reverting to the stylesheet default. Empty string is treated as
null to support TOML configs, which have no null literal.

## mkio connection state

When `config.mkio.url` is set, `<mkui-app>` automatically connects to the
mkio server and verifies its identity.

`url` is read against the page. mkio serves the page and its socket from
one port, so a relative URL follows the server to whatever host, port and
scheme it is served on — `mkui serve -p 9000`, a browser on another
machine, an https proxy in front:

| `mkio.url` | Connects to |
| --- | --- |
| `"/ws"` | the page's host and port (`wss` on an https page) |
| `":9000/ws"` | the page's host, another port |
| `"//host:9000/ws"` | another host, the page's scheme |
| `"ws://host:9000/ws"` | exactly that — a server elsewhere, or a page opened from a file, which has no host to follow |

Connection is two-phase:

1. **Connect** — WebSocket opens, `mkio.connected` becomes `true`, and the
   `connected` state map is applied immediately.
2. **Verify** — an async `_mkio` request confirms the server is a genuine
   mkio server and optionally checks its name, version, and protocol against
   expectations declared in `config.mkio.expect`. On success `mkio.verified`
   becomes `true`; on failure the `incompatible` state map is applied.
   Verification re-runs on every reconnect.

```json
"mkio": {
  "url": "/ws",
  "expect": {
    "name": "order-book",
    "version": "1.0",
    "protocol": "1.0",
    "expr": "2"
  },
  "connected":    { "status.message": "Connected", "status.background": null },
  "incompatible": {
    "status.background": "#cc0000",
    "unreachable": { "status.message": "Not an mkio server" },
    "name":        { "status.message": "Not the order-book server" },
    "version":     { "status.message": "Incompatible order-book version" }
  },
  "disconnected": { "status.message": "Disconnected", "status.background": "#858585" }
}
```

The `expect` keys are all optional. `name` and `expr` (the expression
language version — mkui vendors version `1`) are checked by exact match;
`version`, `protocol`, and `mkio` use semantic-version matching, delegated
to the server's `_mkio` service: a pin accepts its own major at or above
the pinned minor and patch (`"1.2"` accepts 1.2.0 and every later 1.x,
rejects 2.0.0), and a `0.x` pin only its own minor. When `expect` is
absent, the `_mkio` query still runs to confirm it is an mkio server and
to populate `mkio.server.*` state paths (name, version, protocol, mkio).

**mkui 1.x requires mkio 1.x**, and checks that itself: a server whose
`mkio` is of another major fails verification with reason `version`
whether or not `expect` is set, under `auth` too, once logged in. So
`mkio` is pinned only by an app that needs a particular minor's
additions, and a stale pin — one asking for a release newer than the
server, or a `0.x` pin left over from before mkio 1.0, which no 1.x
server accepts — is quiet: the app connects, the `incompatible` map is
applied for reason `version`, and the statusbar reads "Incompatible
server version" while nothing is wrong with the server. Pin `name` and
`version`, which are your own, and leave `mkio` out unless it matters.
A server that cannot say what it is (`mkio: "dev"`, a source checkout
with no package metadata) is not judged.

The same reply says what the server can do, which lands in
`mkio.server.services` (service name → protocol),
`mkio.server.versioned` (the tables whose every change it records — see
mkio's [versioned tables](../mkio/README.md#versioned-tables)) and
`mkio.server.historySuffix`. A server too old to report them leaves those
paths untouched rather than claiming there are none, and so does the
limited reply a server with authentication gives before login — with
`auth` configured the capabilities are read once the user is logged in,
and again on each reconnect.

The `_mkio` request has a configurable timeout (`config.mkio.timeout`,
default 5000 ms) — non-mkio servers that don't respond are detected as
incompatible.

Verification can fail three ways, and `mkio.reason` says which:

| `mkio.reason` | What happened | Default message |
|---|---|---|
| `unreachable` | No `_mkio` reply: an error, or the timeout | Not an mkio server |
| `name` | The server answered under another `name`: a different application | Wrong application |
| `version` | The right application, but `version`, `protocol`, `mkio` or `expr` failed its check — or the server's mkio is not 1.x, mkui's own requirement | Incompatible server version |

`name` is decided before `version`: another application's version is
moot. The per-key verdict lands in `mkio.server.compatibility`
(`{ version: true, mkio: false, … }`) for a statusbar template to pick
apart. `mkio.reason` is `null` while verified or disconnected.

`incompatible` is a state map, applied whatever the reason. An entry named
after a reason and holding a map applies on top for that reason only, so
the colours are shared and the message varies, as above. A flat map with
no such entries behaves as before; with no map at all each reason paints
its default message.

State maps default to `{ "status.message": "Connected" }` and
`{ "status.message": "Disconnected" }`. mkio's client reconnects on its
own (backing off to once a second) and calls the disconnect callback on
every failed attempt, so the `disconnected` map is re-applied about once a
second while the server is away; everything below fires once per outage.

### Losing the connection

A dropped connection is loud by default, at four distances, so it is seen
from a glance at the statusbar, from the browser's tab strip, and from the
data itself:

- **The statusbar colours itself.** `<mkui-app>` carries the connection
  phase as its `mkio` attribute — `connecting` (before the first open),
  `connected`, `disconnected`, or `incompatible` — and the stylesheet paints
  the statusbar from it: muted while connecting, `--mkui-danger` while
  disconnected, `--mkui-warn` for an incompatible server. A
  `statusbar.bindStyle` map still wins, being inline. A dot at the
  statusbar's left edge is the connection light — steady when connected,
  pulsing while away — and during an outage a clock beside it counts how
  long (`0:42`, `1:02:03` past an hour). The message stays whatever text
  widget the config binds.
- **The browser tab says so.** The document title becomes
  `⚠ Disconnected · <title>` and the favicon a red dot, both restored on
  reconnect — the one signal that reaches a user who has switched tabs.
- **A banner drops in under the menubar** after `delay` seconds (default
  3, so a laptop waking or a Wi-Fi hop never flashes it) with the message
  and the clock, and leaves on reconnect; there is no dismiss. An
  incompatible server gets it at once, in the warn colour, since no
  reconnect will fix that.
- **The data reads as stale.** A hatched, pointer-transparent tint lies
  over the workspace, and every `mkio-table` and `mkio-record` pane stamps
  its toolbar with when it last heard from its service — `as of 14:32:05`
  — cleared by the next snapshot or update once the server is back.

There is no Retry button: the client is already retrying every second.

A subscription can also end while the connection stays up — the server
refuses it, or keeps resetting it (mkio's client first tries again by
itself). The rows stay on screen, so an `mkio-table` then says so: a
`not updating — retry` stamp in its toolbar (`.mkui-table-failed`, the
server's reason in its tooltip). Clicking it subscribes again, as does
the pane coming back into view, and the next data clears it.

Each piece is a key of `mkio.offline`, all on by default; `false` turns
the lot off:

```toml
[mkio.offline]
indicator = true   # the statusbar's dot and clock
title = true       # the tab title
favicon = true     # the tab icon
banner = true      # the strip under the menubar
delay = 3          # seconds down before the banner shows; 0 = at once
stale = true       # the workspace tint and the panes' "as of" stamps
```

State paths: `mkio.downSince` (epoch milliseconds when the outage began,
`null` while up) and `mkio.downFor` (the clock's text, rewritten every
second, `null` while up), for a statusbar template of your own. Styling
hooks: the root's `mkio` attribute, `banner` while the banner shows and
`stale` while the tint does; the tokens `--mkui-danger`, `--mkui-danger-fg`,
`--mkui-warn`, `--mkui-warn-fg`, `--mkui-stale` and `--mkui-banner-h`.

## Authentication

When `config.auth` is present, a login dialog gates the app — no frames
appear until the user authenticates. Three modes:

1. **mkio built-in** (`method: "mkio"`) — calls `client.auth()` against
   mkio's `_mkio_users` table. Config-only, no code needed.
2. **Custom** (`method: "custom"`) — register a handler with
   `app.registerAuthHandler({ authenticate({username, password}) })`.
3. **Disabled** — omit the `auth` section entirely.

```json
"auth": {
  "method": "mkio",
  "connected":    { "status.message": "Connected", "status.background": null },
  "disconnected": { "status.message": "Disconnected", "status.background": "#858585" }
}
```

The login dialog is unclosable (no close button). After login,
`auth.authenticated`, `auth.user`, and `auth.role` state paths are set.
The built-in `auth.logout` action reloads the page.

mkio's scaffold creates default users: `admin`/`password` (admin role)
and `user`/`password` (user role). Customize the dialog labels with
`auth.dialog`: `title`, `usernameLabel`, `passwordLabel`, `submitLabel`.

## Menubar

`menubar` is a top-level array. Each element is a dropdown menu with a
`label` and an `items` array:

```json
"menubar": [
  {
    "label": "File",
    "items": [
      { "label": "New Frame", "action": "demo.newFrame" },
      { "sep": true },
      { "label": "Open Recent", "items": [
          { "label": "foo.txt", "action": "demo.open", "args": "foo.txt" }
        ]
      },
      { "label": "Quit", "action": "app.quit" }
    ]
  },
  {
    "label": "Window",
    "items": [
      { "label": "Cascade", "action": "window.cascade" },
      { "label": "Tile", "items": [
          { "label": "Horizontal", "action": "window.tileH" },
          { "label": "Vertical",   "action": "window.tileV" },
          { "label": "Grid",       "action": "window.grid" }
        ]
      }
    ]
  }
]
```

Item keys:

| Key | Type | Description |
|---|---|---|
| `label` | string | Display text |
| `action` | string | Action name fired on click (leaf items only) |
| `args` | any | Optional argument passed to the action handler |
| `items` | array | Child items — makes this a submenu (opens on hover) |
| `sep` | boolean | `true` renders a horizontal separator line |
| `windows` | boolean | `true` expands into one `pane.show` entry per open pane |
| `frames` | boolean | `true` expands into one `frame.show` entry per window the config's `frames` defines, open or not (see [Configs](#configs)) |
| `layouts` | boolean | `true` makes this a submenu of the saved layouts (see [Layouts](#layouts)) |
| `disabled` | boolean / expression | Renders an inert, muted entry: `true`, or an expression over the menu scope (below) — `disabled = "!pane.can.copy"`. A submenu with nothing live in it greys out by itself |
| `disabledTitle` | string | Tooltip of the item while it is disabled, saying why |
| `showWhen` | boolean / expression | Hides the item while false — `showWhen = "state.auth.role == 'admin'"`. Separators left leading, trailing or doubled by hidden items are dropped, and a submenu with nothing shown goes with them |
| `confirm` | string / object | Ask before firing `action`: a message, or `{ message, title, kind, ok, cancel }` — see [Message boxes](#message-boxes) |
| `shortcut` | string | Right-aligned shortcut hint, e.g. `"mod+C"` — `mod` renders as ⌘ on Apple platforms and Ctrl elsewhere (display only; handlers accept either modifier everywhere) |

Any item with an `items` array is a submenu; submenus nest arbitrarily.
Leaf items (no `items`) fire `action` on click via `app.fireAction()`.

**The menu scope.** `disabled` and `showWhen` expressions are read each
time a menu opens, again at the click, and — for the app state they read
— while the menu stays open, so an item greys out under the pointer when
the connection drops. They see:

| Name | |
|---|---|
| `state` | The app state: `state.mkio.connected`, `state.auth.role`, `state.dialog.suppressed['key']`, your own paths |
| `app` | The config's `app` block |
| `pane` | The focused frame's active pane — `{ id, type, title, can }` — or `NULL` with nothing focused. `can` is the edit actions that pane answers: `can.copy`, `can.selectAll`, `can.find`, `can.undo`, `can.redo`, so `disabled = "!pane.can.find"` greys Find… out over a pane that has no find |
| `selection` | That pane's selection, `{ count, focused }` — the rows it implies, and whether a cursor row stands — or `NULL` for a pane with nothing to select |
| `panes` | The ids of the panes open in a frame: `LEN(panes) < 2`, `'orders' IN panes` |

An expression that does not compile warns once in the console and leaves
the item enabled and shown.

**Built-in actions:** `app.quit`, `pane.show` (takes a pane ID as
`args` — switches to that pane's tab and raises its frame, or, if the
pane is parked/closed, opens a new frame: the window it was closed in,
with the filters, sort, and columns it had, when one is remembered —
see [Layouts](#layouts) — else a fresh one), `window.tileH`, `window.tileV`,
`window.grid`, `window.cascade`, `edit.copy`, `edit.selectAll`,
`edit.find` (the last three route to the focused frame's active pane —
the same path the Ctrl/Cmd+C, Ctrl/Cmd+A, and Ctrl/Cmd+F shortcuts
take), `table.filter` (`args =
{ pane = "<id>", filters = { col = <filter> }, merge = false }` sets a
table's column filters from a menu — same shapes as the pane's `filters`
key; omit `pane` for the focused pane), and `table.sort` (`args = { pane
= "<id>", sort = <spec> }` sets its sort order — same shape as the pane's
`sort` key; no `sort` clears it), and `table.columns` (`args = { pane =
"<id>", visible = [...] }` sets which columns show — same shape as the
pane's `visible` key; no `visible` shows them all), `edit.undo` / `edit.redo` (step the focused
table's selected records along their recorded versions — configured by
`history.undo` / `history.redo`, confirmed unless `history.confirm =
false`), `table.history` (`args = { pane = "<id>", keys = [...] }` opens the
history pane for that table's selected record — `keys` selects the record
first, so a menu item can name the one it means), `table.select` (`args = { pane =
"<id>", keys = [...], focus = true }` selects rows by identity — the
values the table tracks rows by, which for a query table is the row's
primary key; an empty list clears the selection, `focus = false` selects
without moving the cursor; it returns which keys it took), `table.link` (`args
= { pane = "<id>", link = { broadcast, listen, broadcasting, listening },
merge = false }` — or those four keys flat — configures a table's links,
see Table linking; no link clears them), the `layout.*`
actions (`save`, `restore`, `reset` — see [Layouts](#layouts)), and the
`dialog.*` actions (`open`, `alert`, `confirm`, `about` — see
[Message boxes](#message-boxes)).
Register custom actions with `app.registerAction(name, fn)`.

A typical Edit menu:

```json
{ "label": "Edit", "items": [
  { "label": "Copy", "action": "edit.copy", "shortcut": "mod+C" },
  { "sep": true },
  { "label": "Select All", "action": "edit.selectAll", "shortcut": "mod+A" },
  { "label": "Find…", "action": "edit.find", "shortcut": "mod+F" }
]}
```

A typical Window menu lists the arrangement commands first, then the
open windows dynamically:

```json
{ "label": "Window", "items": [
  { "label": "Cascade", "action": "window.cascade" },
  { "sep": true },
  { "windows": true }
]}
```

`{ "windows": true }` expands — every time the menu opens — into one
entry per pane currently hosted in a frame, labeled with the pane's
title. Selecting an entry raises the frame that contains the pane and
switches to its tab (dialogs and other noDock frames are excluded).
Static `pane.show` entries are still useful for reopening panes whose
frame has been closed: a closed window comes back where and as it was.
`frame.show` opens or raises a window the config's `frames` defines —
one declared `"open": false` is closed until an item asks for it — and
`{ "frames": true }` lists them all.

Tabs can be renamed in place: ctrl+click (or cmd+click on macOS) a tab,
edit the title, and press Enter (Escape cancels). The new title is
stored on the pane spec, so tab bars and the Window menu both reflect
it.

## Message boxes

A popup that says something and takes an answer — an About box, a notice,
an "are you sure?" — is a [dialog](#built-in-widgets-and-pane-types-v1)
with a `message` and its own `buttons`, and four actions open one from a
menu item, a button, or the [control channel](#driving-the-app-from-python):

```toml
[[menubar]]
label = "Help"
items = [
  { label = "Keyboard Shortcuts", action = "dialog.open", args = "shortcuts" },
  { label = "About", action = "dialog.about" },
]

[[menubar]]
label = "Layout"
items = [
  { label = "Reset to Default…", action = "layout.reset", confirm = "Return every window to its default place?" },
]
```

| Action | `args` | Opens |
|---|---|---|
| `dialog.about` | — | The About box, built from the `app` block (below) |
| `dialog.alert` | a message, or `{ message, title, kind, ok, details, timeout, suppress, id }` | One OK button; resolves once acknowledged |
| `dialog.confirm` | a message, or `{ message, title, kind, ok, cancel, then = { action, args }, submit = { service, op, data }, arm, enable, details, suppress, modal, fields }` | Cancel / OK, modal; `then` fires on OK only |
| `dialog.resetSuppressed` | a `suppress` key, or nothing for all of them | Nothing: forgets "Don't ask again" answers (below), and says so in `status.message` for a few seconds — "Will ask again (1 remembered answer forgotten)", or that there was nothing to reset — since nothing else changes until a box next asks |
| `dialog.open` | a name under the top-level `dialogs`, or `{ dialog = "<name>" \| { …spec }, context = { … } }` | Any dialog — a message box or a form — from a menu |

**`confirm`** gates an action behind a confirm titled by what carries it
— a menu item, an `mkio-table` toolbar button, a `button` widget:
`confirm = "Quit?"`, or a table with any of `dialog.confirm`'s keys,
`confirm = { message, kind = "danger", ok = "Delete", arm = 2 }`. Anything
but OK fires nothing. On a table button the message sees the button's
scope — `"Cancel ${selection.count} order(s)?"`, `details = "${JOIN(MAP(rows,
r -> STR(r.id)), ', ')}"` — and the action runs over the rows that were
asked about, whatever has been selected since.

**About.** `dialog.about` needs no configuration: it shows `app.title`
and, when the `app` block has them, `version`, `description`,
`copyright`, `icon` (an image URL, in place of the info icon) and `links`
(`[{ label, href }]`), over the lines a bug report wants, kept current
while the box is open — the mkio
server's name and version, the connection, the logged-in user and
role, then mkui's own version and the mkio library's — each shown only
when known. **Copy details** puts all of it on the clipboard. `[app.about]`
overrides any part (`title`, `heading`, `message`, `image`, `links`,
`width`); its `facts = [{ label, value }]` add lines ahead of the
built-in ones, and `builtins = false` drops those — or names the ones
to keep, in order: `builtins = ["server", "mkui", "mkio"]`, out of
`server`, `connection`, `user`, `mkui`, `mkio`.

**The spec.** A message box is a dialog spec, under `[dialogs.<name>]` or
inline, with any of:

| Key | Description |
|---|---|
| `message` | What it says: a `${…}` template, or a list of them, one paragraph each. A newline breaks the line; a [rich](#expressions) value renders as one |
| `heading` | A larger line over the message |
| `kind` | `info`, `success`, `warn`, `danger` or `question`: the icon and its colour. `warn` and `danger` announce themselves to a screen reader as alerts |
| `image` | An image URL shown in place of the kind's icon |
| `facts` | `[{ label, value, showWhen }]` — a two-column list under the message; a line whose value comes out blank is dropped |
| `links` | `[{ label, href }]` — opened in a new tab; `http(s)`, `mailto` and same-site addresses only |
| `details` | The long part — a stack trace, the rows a confirm is about — folded under the message behind a caret, with a copy button of its own: a template, or `{ text, label = "Details", open = false }`. Blank text shows nothing |
| `suppress` | `"key"` (or `{ key, label }`) adds a **Don't ask again** checkbox to a box with `buttons`. Ticked, the answer is kept in the browser's localStorage and given at once next time, without anything opening — its button's `action` and `set` still fire. Cancelling is never remembered, except by a notice whose only button it is. `dialog.resetSuppressed` forgets it; give users a menu item for that. The remembered answers are mirrored in app state at `dialog.suppressed` (`{ key: buttonId }`, kept current across tabs), so that item can be off until there is something to take back: `disabled = "state.dialog.suppressed['orders.fill'] == NULL"` |
| `timeout` | Seconds until the default button presses itself (with none, the box is dismissed), counted down in its label — for a notice that should not wait for anyone. A key or a click in the box calls it off |
| `modal` | `true` dims the workspace under the dialog and keeps the pointer off it, the menubar and the statusbar until it is answered. `dialog.confirm` and every `confirm` key default to it; nothing else does |
| `id` | Opening a dialog whose `id` is already open replaces that one where it stands instead of stacking a second — for a notice a server may push again |
| `buttons` | The footer, in place of Cancel / OK (below) |
| `width`, `height` | Pixels. A message box opens at its content's height; a form's default is 400 |
| `pin` | `false` drops the pin button from a form (a dialog with `buttons` never has one) |

Templates see the dialog's fields, `state`, `app` (the config's `app`
block) and whatever `context` the opener added, and follow the form as it
is edited, like every other template in a dialog — and the app: a dialog
re-evaluates when a `state.…` path it reads changes, so an open About box
shows the connection dropping and a button's `enable = "state.mkio.connected"`
shuts it. `fields` still work —
a confirm that asks for a reason is a message, a `textarea` and two
buttons.

**Buttons.** `buttons = ["Save", …]` or a list of tables:

| Key | Description |
|---|---|
| `label`, `id` | The text, and the name the answer carries — the label in lower case when omitted |
| `kind` | `primary`, `danger`, or plain. With none given anywhere, the default button is `primary` |
| `cancel` | `true` on the one button that dismisses: Escape and the frame's × are this button |
| `default` | `true` on the button Enter presses and the focus starts on. Without it: the first button that neither cancels nor is `danger`. In a `kind = "danger"` dialog the default is the cancel button, and a `danger` button is never the default — Enter must not be how something is destroyed |
| `submit` | `false` answers with the form as it stands, skipping validation and `submit.service` — a "Don't Save" |
| `op` | Stands in for `submit.op` when this button submits — "Save" and "Save & Fill" over one service |
| `submit = { service, op, data }` | This button's own transaction, in place of the dialog's `submit`: the fields plus `data` (templates over the fields, `button` and the context). How a box pushed from a server ([`control.confirm`](#driving-the-app-from-python)) answers it; an error stays in the box |
| `enable` | A boolean or an expression over the form; while false the button is shut, and Enter passes it by. `enable = "typed == row.name"` beside a `typed` field is type-to-confirm |
| `arm` | Seconds the button stays shut after the box opens, counting down in its label — so the double-click that opened a `danger` confirm cannot also answer it |
| `copy` | `true` copies what the box says (title, message, facts, links) and leaves it open; a template copies its result |
| `action`, `args`, `set` | Fired once the box has closed: an [action](#menubar), and/or `set = { "state.path" = value }` written to app state — both resolved against the submitted fields, `button` (the id) and the opening context. On the `cancel` button they run for Escape and × too |

Keys: Enter presses the default button (ctrl/cmd+Enter from anywhere),
Escape the cancel button, ←/→ walk the footer, Tab stays inside the
dialog, and Ctrl/Cmd+C with nothing selected copies the whole message —
its text is selectable too. When the box closes the focus returns to
where it was, and the frame under it is the focused frame again.

**From JavaScript** (library mode, a custom action):

```js
if (await app.confirm("Close 3 scratch pads?", { kind: "danger", ok: "Close" })) closeThem();
await app.alert("Saved.", { kind: "success" });

const res = await app.dialog({            // or the name of one under `dialogs`
  message: "Save your notes before closing?",
  fields: [{ name: "name", label: "Save as", required: true }],
  buttons: [{ label: "Cancel", cancel: true }, { id: "discard", label: "Don't Save", submit: false }, { id: "save", label: "Save" }],
});
// null when dismissed, else { button: "save", data: { name: "…" } }
```

`app.dialog(spec, context)` resolves with the submitted fields for a
plain form, `{ button, data }` when the spec has `buttons`, and `null`
when dismissed. `openDialog(spec, context, app, extra)` is exported for
callers that bring their own mkio client or storage.

A table button opens a named dialog the same way — `action = { type =
"dialog", dialog = "<name>" }` — so one `[dialogs.new-order]` can serve a
toolbar button (with the selection as its context) and a menu item.

## Layouts

The Layout menu lets a user save the window arrangement, go back to an
earlier save, and return to the configured default. A `layouts` table in
the config enables it (an empty one takes every default):

```toml
[layouts]
keep = 10            # per user: the newest 10 saves …
keepDays = 7         # … or the last 7 days, whichever keeps more
autoload = true      # apply the user's latest save at startup
# store = "mkio"     # or "local"; default: mkio when [mkio].url is set
# key = "orders"     # tells apps sharing one store apart; default app.title
# timeout = 5000     # ms per store call
# service = "mkui_layouts"   # transaction service; `<service>_list` / `_get` reqreps

[[menubar]]
label = "Layout"
items = [
  { label = "Save Layout", action = "layout.save" },
  { label = "Restore Layout", layouts = true },
  { sep = true },
  { label = "Reset to Default", action = "layout.reset" },
]
```

A saved layout holds every dockable frame — position and size as
workspace fractions, z-order, and its tab tree with the selected tabs —
plus, for each table open in one, its filters, sort order, and visible
columns. It never holds a paged table's position, and dialogs are never
part of it.

**Closed windows are remembered.** Closing a window doesn't throw its
setup away: for each pane it held, the workspace keeps the window's
position and size and the filters, sort, and columns the pane had at
that moment, and a `pane.show` on that pane brings it back there, set up
that way, rather than in a fresh window at the config's defaults. A
saved layout carries those closed windows too, so they survive a restart
and a `Restore Layout`, and closing a window is a change worth saving.
Two panes closed as tabs of one window come back as two windows at that
window's rect. `Reset to Default` forgets them all.

**One layout per user, with history.** Saves are unnamed. A user's
layout is simply their newest save, and it comes back when the app
starts. Every earlier save stays behind it, so `Restore Layout` lists
them newest first by save time; picking the newest undoes whatever
changed since the last save, picking an older one brings that
arrangement back (and saving then makes it the newest). Saving when
nothing has changed adds no entry.

**Who owns a save.** With a login (`auth`), layouts save under the
user's name and each user sees only their own history. Without one they
save under the default history, shared by everyone using the app.

**How much history stays.** Per user, an entry is kept while it is one
of the newest `keep` saves *or* was saved within the last `keepDays`
days — whichever keeps more, so a busy week is never cut short and a
rare saver never loses their last few. Older entries are deleted after
each save and hidden from the menu as soon as they age out. Set either
to 0 to disable that half of the rule; both at 0 keeps everything.

**The actions.** `layout.save` saves at once. `{ layouts = true }`
expands into one `layout.restore` entry per save — the list refreshes
whenever the menu opens, so saves from another tab appear.
`layout.reset` returns to how the app looks at startup without a saved
layout: the config's `frames` (one declared `open = false` closed), every
pane at its configured filters, sort, and columns, no closed window
remembered. With `autoload` (the default), the user's newest save
is applied when the app starts, after login where there is one; the
config frames load when there is none, or when the store doesn't answer
within `timeout`.

**Where saves live.** With `[mkio].url` the store is the server:
`mkui init` scaffolds a `mkui_layouts` table, a transaction service with
`save` and `delete` ops (delete is how the client prunes), and
`mkui_layouts_list` / `mkui_layouts_get` reqrep services, each locked
with a `when` pre-check so a user reads and writes only rows whose
`owner` is their login. Add the same sections to an existing server
(see the mkio-table example's `server.toml`). Without a server, or with
`store = "local"`, the history lives in the browser's localStorage — per
browser, so it doesn't follow the user to another machine.

**When things change.** A saved layout that names panes the config no
longer has drops them (an emptied frame goes too); one whose panes have
all gone falls back to the default with a status message. Panes added
to the config since a save stay parked and reachable from the Window
menu. Bad or corrupt entries are reported and never half-applied. Frame
rects are re-clamped to the workspace, so a layout saved on a wide
monitor still fits a laptop.

## Table linking

One table's selection can filter another. A table **broadcasts** chosen
columns of its selected rows under names of its own choosing; a table
that **listens** for a name filters one of its columns by whatever
arrives under it. The names are the mapping: the orders table sends its
`id` as `order_id`, the executions table filters `parent_order_id` by it.

```toml
[panes.orders]
link.broadcast = { order_id = "id", symbol = "symbol" }

[panes.executions]
link.listen = { order_id = "parent_order_id" }

[panes.fills]                   # listens and broadcasts: a chain
link.listen = { order_id = "order_id" }
link.broadcast = { exec_id = "id" }
link.broadcasting = false       # configured, but paused until turned on
link.chips = false              # no toolbar chips: pause from the advanced dropdown
```

- **What is sent.** The rows the selection implies — selected rows, else
  the rows containing selected cells, else the focused cell's row — yield
  the distinct values of each broadcast column, in view order. Several
  rows send several values; nothing selected retracts the name. In a
  **tree**, a selected row speaks for its whole subtree: every descendant's
  value goes too, each value once, whether the row is collapsed *or*
  filtered out of this table — a filter says what this table shows, not
  what the record is, and the listener asked for the children of what was
  picked. A live update to a selected row — or, in a tree, a row
  arriving, changing, or leaving under one — re-sends. Every value also
  lands in app state
  at `link.<name>` (a list, or `null`), where a statusbar widget or an
  `enable.when` can read it.
- **What a listener does.** A broadcast becomes an include filter on the
  mapped column — a chip with a link tint, the header icon tinted alike —
  replaced in place by the next broadcast and removed when it is
  retracted. It displaces the column's own filter (from the config or the
  user) and puts it back when the link clears; filters on other columns
  are never touched. Edit that column's filter yourself and it is yours
  until the next broadcast re-links it. A listen entry may be `{ column,
  scope }` on a tree table. A listener opened after the selection was
  made catches up at once, and a table never follows its own broadcasts.
- **Both at once.** A table that listens and broadcasts passes the
  selection along: a filter change from listening prunes its selection,
  and its own broadcast follows. Two tables feeding each other are cut
  off after a bounded number of deliveries, with a warning.
- **Controls.** The toolbar shows one chip per direction — *Broadcast:
  order_id, symbol* and *Listen: order_id* — under a link icon. Click a
  chip to pause or resume that direction (paused is dimmed; pausing
  listening releases the linked filters, pausing broadcasting retracts,
  resuming re-announces the current selection); × removes it (two clicks
  when it holds several names); the group's icon removes every link. Alt/option-click a
  header's filter button (or a filter chip) and its dropdown adds
  *Broadcast as…* and *Listen for…* under *Hide column* — an advanced
  row, like the tree scope tabs, so the everyday dropdown stays as it
  was: click for an inline name (the column's name by default, and the
  listen input offers every name currently broadcast), Enter or blur
  commits, an emptied name removes the link, Escape cancels. Linked
  columns wear the direction icons ahead of their label. `link.chips =
  false` keeps the chips off the toolbar altogether — for a table whose
  links are part of the setup rather than something to fiddle with — and
  the advanced row then also carries *Pause broadcasting* / *Resume
  listening* for the directions the column is linked in (the header
  mark still shows the links and whether they are paused). It is
  presentation config: `getPaneLink` and layouts never carry it.
- **Programmatic.** `workspace.setPaneLink(id, link, { merge })` /
  `getPaneLink(id)` and the `table.link` action take the same shape;
  under `merge` only the keys given change, a `null` name entry dropping
  that name. From Python, see [Driving the app from
  Python](#driving-the-app-from-python).
- **Layouts.** A saved layout carries every pane's link configuration —
  the maps and the paused flags — and restores it; the filters a link
  produces are not saved, they come back from the live selection.
- **Whole windows.** A set of linked panes can be one window the config
  defines and a menu item opens whole — a `frames` entry with `open =
  false`, see [Configs](#configs).

## Detail windows

A table shows many records; a **detail window** shows one. The useful
part is that it need not be told which record twice — it listens on the
same bus a linked table does, so one broadcast points the table, the
detail window and the history window at the same record.

```toml
[panes.orders]
link.broadcast = { order_id = "id" }        # as before

[panes.order_detail]
type    = "mkio-record"
service = "orders"                           # a query service
source  = "orders"                           # labels, display, styles, key
record.listen = { order_id = "id" }          # name -> key column
record.retain = true                         # keep the last record when the source clears
record.title  = "${symbol} #${id}"           # what the tab is called
fields  = ["id", "side", "symbol", "qty", "status"]
groups  = [{ label = "Execution", columns = ["qty", "status"] }]
```

- **Where the record comes from.** The `record` block takes exactly one
  source: `listen` (a map of broadcast name to this window's key column
  — several names make a composite key, and every one of them must have
  arrived before the window has a record), `follow` (a pane whose
  selection it tracks — `record = "orders"` is the short way to write
  it), `state` (a path a table's `select.state` publishes a row to), or
  `key` (one record, forever). A `listen` entry may be `{ column, type }`
  when the value's type matters: broadcasts are strings, and a value that
  reads as a number is sent as one unless `type = "string"` says
  otherwise. Several records broadcast at once shows the first, and the
  chip says how many there were.
- **Pinning.** The pin in the toolbar freezes the window on the record it
  is showing: broadcasts go on arriving and are ignored, so you can pin
  one window and keep clicking. Unpinning catches up with the world. It
  is `record.listening = false` in config, and it survives a saved
  layout, so a pinned window comes back pinned. Open two windows, pin
  one, and you are comparing records.
- **The chip.** One chip per window — *Listen: order_id* under an ear —
  click to pin or unpin, `×` to unlink it altogether. Beside it, a link
  button opens the form that says where the window gets its records:
  the source, the name to listen for (the ones being broadcast right now
  are listed), the pane to follow, `retain`, and the pin. Everything
  the form sets can be written in config or pushed from Python.
- **What it shows.** `fields` is the detail window's `columns` — which
  fields, in what order; left out, the record says. `labels`, `display`
  and `styles` mean exactly what they mean in a table cell, `groups`
  folds the list into sections that collapse, and `widgets = { col =
  "<widget>" }` puts a registered widget in a value's place. A `source`
  pane lends all of it, so a detail window beside its table usually
  configures nothing but its service and what it listens for. The record
  is read with a live query subscription, so an edit made anywhere
  arrives without asking again; **Copy** takes the fields as shown.
- **The history window listens too.** `mkio-history` takes the same
  `record` block — a history window with `record.listen` follows the
  broadcast rather than a table's selection, and needs no table pane
  open at all. Without one it follows its `source` table, as before.
- **Programmatic.** `workspace.setPaneRecord(id, key)` puts a record on
  show; `setPaneRecordSource(id, spec, { merge })` / `getPaneRecordSource(id)`
  say where records come from; `onPaneRecord(id, fn)` follows what the
  window is about. The actions are `record.show` `{ pane, key }`,
  `record.follow` `{ pane, listen | follow | state | key, retain,
  listening, merge }`, and `table.record` `{ pane, from }` — which sends
  a table's selected record to a detail window, for when there is no
  broadcast to wait for. From Python, see [Driving the app from
  Python](#driving-the-app-from-python).
- **Your own detail pane.** A pane type an application registers gets all
  of the above from one call:

  ```js
  import { registerPaneType, attachRecord } from "./mkui/index.js";

  registerPaneType("order-card", async (spec, app, host) => {
    const paneEl = host.closest("mkui-pane");
    const follower = attachRecord(paneEl, spec.record, app, (rec) => render(rec));
    follower.start();
  });
  ```

  `attachRecord` installs the `_record` hook the workspace API, the
  actions, the control channel and saved layouts all speak to. It is
  returned unstarted on purpose: the first read can land synchronously.

## Themes

`dark` and `light` are built-in. To ship additional themes, list them under
`app.themes` — each entry is a flat object of CSS custom property overrides,
applied as inline styles on `<mkui-app>` so every descendant inherits them:

```json
{
  "app": {
    "theme": "solarized",
    "themes": {
      "solarized": {
        "--mkui-bg":        "#002b36",
        "--mkui-bg-alt":    "#073642",
        "--mkui-bg-hover":  "#0a4350",
        "--mkui-fg":        "#93a1a1",
        "--mkui-fg-mute":   "#586e75",
        "--mkui-border":    "#0a4350",
        "--mkui-tab-active": "#0e4d5e",
        "--mkui-accent":    "#268bd2",
        "--mkui-accent-fg": "#fdf6e3",
        "--mkui-focus":     "#eee8d5"
      }
    }
  }
}
```

Any variable from `styles/mkui.css` (`--mkui-*`) may be overridden. Missing
keys fall back to the default (dark) values. The connection colours —
`--mkui-danger` / `-fg` for the statusbar and banner while the server is
away, `--mkui-warn` / `-fg` for an incompatible one, `--mkui-stale` for the
tint over a workspace showing stale data — are among them. Switch themes at runtime with
`appEl.setTheme("solarized")`.

## Standalone mode

```html
<!doctype html>
<link rel="stylesheet" href="/mkui/styles/mkui.css">
<script type="module" src="/mkui/src/index.js"></script>
<mkui-app config="/mkui/client.json"></mkui-app>
```

## Library mode

```js
import { registerPaneType } from "mkui";
import "mkui";   // side-effect: registers custom elements

registerPaneType("clock", (spec, app, host) => {
  const el = document.createElement("div");
  host.appendChild(el);
  setInterval(() => { el.textContent = new Date().toLocaleTimeString(); }, 1000);
});

const root = document.querySelector("mkui-app");
await customElements.whenDefined("mkui-app");
root.setConfig({
  panes:  { clock: { title: "Clock", type: "clock" } },
  frames: [{ id: "f1", x: 0.3, y: 0.3, w: 0.3, h: 0.3,
             layout: { type: "tabs", children: ["clock"] } }],
});

// Add more frames at runtime:
root.workspace.addFrame({ x: 0.5, y: 0.1, w: 0.4, h: 0.4,
                          layout: { type: "tabs", children: ["other-pane"] } });
```

## Built-in widgets and pane types (v1)

- Widgets (lightweight content inside a pane or statusbar slot):
  - `text` — static or `bind`-ed to a state path
  - `button` — fires an action by name
- Pane types (whole-pane custom rendering):
  - `mkio-record` — one record as a list of fields, pointed at that record
    by the link hub, a pane's selection, app state, or config. See
    [Detail windows](#detail-windows).
  - `mkio-table` — subscribes to an mkio service (query, subpub, or stream) and renders a live-updating table with flash animations for inserts, deletes, and field changes — on a [versioned table](../mkio/README.md#versioned-tables) a record someone steps along its versions flashes in a colour of its own instead — amber going back, violet coming forward — because a row changing under you because someone moved its cursor is a different event from one being edited, and the same colours mark a cursor move that brings a row into the table (undoing a delete, redoing an insert) or takes one out of it (undoing version 1). mkio names the step (`cause` on every live update), so both directions are exact; on an update that arrives without it — a projection that drops the counter — only an undo that lowers the version counter is caught, since a redo and a fresh edit both raise it by one with nothing on the row to say which it was. Row identity is per-protocol: query uses `_mkio_row` (the primary key — or, on a query that joins tables, the service's `key` columns; set `key` on a joined query that carries a `history` block so the identity stays the base table's), stream uses `_mkio_ref`, subpub uses `_mkio_topic`. A query row its SQL stops returning — a joined row whose `WHERE` no longer holds — arrives as a delete and leaves the table like any other. Column headers render immediately when `columns` is configured; optional `labels` maps column keys to display text (e.g. `{ "ts": "Timestamp" }`). mkio's own `_mkio_*` columns stay hidden, except the five that carry data rather than identity — `_mkio_version` on a [versioned table](../mkio/README.md#versioned-tables), `_mkio_op` / `_mkio_user` / `_mkio_service` on one of its history tables, and `_mkio_ref`, a stream row's timestamp — each of which shows when `columns` or `visible` names it, under a default label (`Version`, `Op`, `User`, `Service`, `Ref`) that `labels` overrides; hiding one again leaves it in the column picker. Rows are **virtualized** — only the slice overlapping the viewport exists in the DOM, so scrolling, window moves, and window resizes stay fast into the millions of rows. Columns are fully interactive: click a header to sort (shift+click adds secondary sort keys), the hamburger button opens a per-column filter dropdown with search and value checkboxes (the list opens tall enough for every value, stopping short of the app's statusbar, and its corner grip resizes it — the height you drag is kept while the pane lives; the column picker's list behaves the same) — the filter remembers what you meant rather than what was listed: untick values (or Select all, then untick) to hide just those and let everything else through, including values that arrive later via live inserts, updates, or the next stream page; Clear, then tick values to show only those, with anything new staying hidden — numeric columns and columns of timestamps (mkio refs, ISO-8601 dates/date-times, or `HH:MM[:SS]` clock times) add a **Range** mode with From/To bounds (native date/time pickers for time columns, plus Today / Last hour / Last 15 min presets that keep moving with the clock — Today is the browser's calendar day whatever zone the column's stamps are in, so a table of UTC timestamps doesn't empty for the evening once the UTC date turns) and an *include empty* toggle; other date formats aren't guessed — declare them with `types = { col = { type = "time", parse = "%d/%m/%Y %H:%M" } }` (or `unit = "ms"` for epoch numbers, `tz = "local"` for naive local timestamps). The same entry can say how the column **shows**: `format = "%Y-%m-%d %H:%M:%S.%3f"` renders each value through strftime (`%f` the fraction as stored — a stamp keeps its own precision, milliseconds or nanoseconds — `%1f`..`%9f` a fixed width, `%Z` the zone's short name — EDT, UTC, +02:00) and `zone = "local"` (or `"UTC"`, `"+HH:MM"`) picks the zone it is shown in, so a column of UTC stamps reads in the viewer's time while sorting and range filtering keep the stored value, the range picker takes its bounds in the shown zone, a bare date keeps its day, and a value that doesn't parse shows as stored; `format` defaults to the parse pattern and `zone` to `tz`, so either alone is enough. **Default filters** come from config: `filters = { status = { exclude = ["cancelled"] }, qty = { from = 100, to = 500 }, ts = { preset = "1h" } }` seeds the same filters before any data arrives (a bare list `["open", "new"]` means *only those*; `from`/`to` bounds make a number range when they are numbers and a time range when they are strings such as `"2026-03-01"` or `"2026-03-01 09:30"`, a date covering its whole day; `empty = true` lets blank values through; `preset` is `today` — the browser's day — `1h`, or `15m`), and reopening the pane restores them. A filter can be **switched off** instead of cleared: untick the checkbox on its toolbar chip (or *Applied* in that column's dropdown) and it keeps its values, bounds, and scope while applying nothing — the chip stays on the strip dimmed and dashed, the header icon goes muted so a column doesn't read as filtered when it isn't, and ticking it back restores exactly what it was; alt/option-click the filter group's icon to switch every filter off at once, and again to bring them all back. `off = true` on a configured filter ships one set up but not applied, so a table can offer a view that takes one click rather than a trip through the dropdown; the flag rides in the spec, so `getPaneFilters` round-trips it and a saved layout remembers which filters were resting. The same shape drives the programmatic API — `workspace.setPaneFilters(id, filters, { merge })` / `getPaneFilters(id)` — and the `table.filter` menu action. **Sort** likewise comes from config — `sort = "-ts"` or `sort = [{ col = "status" }, "-name"]` (a column name, `-name` for descending, `{ col, dir }`, or an array in priority order), restored on pane reopen and driven programmatically by `workspace.setPaneSort(id, sort)` / `getPaneSort(id)` and the `table.sort` action. **Column visibility** — `visible = ["id", "symbol", "qty"]` shows only those columns, in that order; without it every column shows, *including columns added later* to the config or the data, whereas an explicit list is exactly those — so a config can grow a table without disturbing a layout that was written down. Restored on pane reopen and driven programmatically by `workspace.setPaneColumns(id, visible)` / `getPaneColumns(id)` (which returns `null` while every column shows) and the `table.columns` action. A **Columns button** in a narrow gutter at the right edge of the header row (it stays put as the table scrolls, never covers a column or its resize grip, and wears a badge with the hidden count) opens the **column picker**, the one place for bulk changes: a checkbox per column and, under the search box, the same row the filter dropdown has — *Show all*, *Hide all* (keeps one column; the natural start when picking a few out of hundreds), and *Reset* (back to the config's list). Type a query and the first two become *Show N matching* / *Hide N matching* for whatever the list narrowed to. Unscoped *Show all* takes two clicks, the second a confirm, because on a table with hundreds of columns an accidental show-all is the one action that hurts. Each header's dropdown offers *Hide column* (the last one refuses); nothing under one column controls any other. **Column groups** — `groups = [{ label = "Pricing", columns = ["price", "notional"] }, …]` — categorise the picker: one collapsible section per group with a tri-state checkbox that shows or hides the whole group (bounded, its size printed beside it, one more click reverses it), folded unless it holds a shown column, plus an implicit *Other* for ungrouped columns; a search matches group labels too and unfolds the groups with matches. Groups are structure only, `visible` stays the truth about what shows, and when `columns` is omitted the display order follows the groups so a category's columns sit together. **Tree rows** — `tree = { child = "parent_id", parent = "id" }` — nest rows like a file navigator: a row whose `child` fields are all empty is a root, any other hangs under the row whose `parent` fields carry the same values (`child`/`parent` may be lists of several columns, matched together); only roots show at first, and a caret in the first visible column (or `column = "name"` to pin it) expands a row's children, each with a caret of its own when they have children — shift+click opens or closes a whole subtree, the header's caret opens every root (shift: every level) or closes everything — a shift+click once every level is open closes everything too, so the pair toggles like a row's, Enter toggles the focused row and `*` opens its subtree, and `expand = 1` (or `"all"`) opens that deep at load, as does `workspace.expandPane(id, depth)` / the `table.expand` action. The row-number column numbers by position per level — top-level rows 1..n, the children of row 5 as 5.1..5.m, theirs as 5.3.1 and so on — following the current sort at every level and shifting as rows arrive and leave; a filtered-out row keeps its slot, so the numbers around it show the gap (flat tables skip filtered rows' numbers the same way; a stream page counts its own rows). Expanding and collapsing splice only the affected rows, so a table with thousands of rows stays instant. A child whose parent is absent (a stream ordered child-first, an earlier page) shows as a root until the parent arrives and adopts it, or hides with `orphans = "hide"`. Sorting orders the roots, then each group of siblings, then theirs. Filters apply to the top level by default — a matching top-level row shows with all its children, a failing one takes its subtree with it — and the dropdown looks just as it does on a flat table; alt/option-click the filter button for the advanced dropdown, whose scope row is three tabs — **Top**, **Child** (every top-level row shows; a child is tested and a miss hides its subtree, so a matching grandchild under a missing child stays hidden), and **Branch** (every row is tested, but the way to a match is kept: a row that misses still shows while any descendant matches, at any depth, and a row with no match anywhere below it goes, roots included) — each holding its own filter, so a column can filter all three ways at once; a tab with a filter wears a dot, each filter gets its own chip, and a column filtered off the top opens on that tab without the modifier. In config, `scope` = `roots`, `children`, or `all` on a filter, `filterScope` sets the table's default, and a column takes an array of filters for several scopes: `qty = [{ from = 100, scope = "roots" }, { exclude = [0], scope = "children" }]`. Selection, Ctrl/Cmd+A, and copy see exactly the rows on screen: collapsed rows are never selected or copied, and collapsing a row drops its hidden descendants from the selection. Sorting, filtering, and reordering keep working on hidden columns, and a hidden column comes back at the width it had. Whatever is active shows as **chips** on the table toolbar, so the state is visible and undoable without scrolling the header into view: the sort keys in priority order, then the filtered columns with the same summary the header tooltip gives. Click a sort chip to flip its direction or a filter chip to open that column's dropdown (showing the column first if it is hidden), each filter chip leading with a checkbox that switches that filter off without giving it up, × removes one, and the group's icon clears the whole group. The chips share the toolbar row with the selection buttons — buttons pinned left, chips flowing from the right, the cluster dropping to its own line when a narrow pane can't fit both — and the toolbar disappears when it has nothing to show — when a column is sorted, that header button's icon becomes the sort caret (still opening the filter dropdown, and showing the sort priority as a digit knocked out of the caret under multi-sort) — dragging a header reorders columns, and dragging the grip centered on a column divider resizes the column to its left — double-click the grip to auto-size the column to fit its content (capped at 80% of the viewport; with a selection active, all selected columns fit at once, so select-all + double-click fits the whole table). Column widths start at the header row's width and grow to fit records as they arrive (capped at 50% of the pane width, never shrinking, and never overriding a manual resize) — paging to another page never resizes them, and they don't change when the window resizes — extra pane width flows into a filler column that extends the header row to the pane's right edge, and subtle dividers separate the columns. Columns whose values are all numeric right-align with each value padded so decimal points line up down the column, in the cells and in the filter dropdown's value list alike. Subscriptions are deferred until the pane is first visible, unsubscribed immediately when the frame is closed, and dropped after 5 minutes of being hidden (e.g. inactive tab) — brief tab switches preserve the live connection. Large query snapshots render progressively in chunked batches to avoid freezing the UI. Stream tables support time-anchored paged navigation with a toolbar showing `◀ Earlier | time range | Later ▶ | ● Live | ⟳`. By default, the initial fetch starts from local midnight (`start: "today"`); `start: ""` starts from the beginning of the buffer. The toolbar displays the time range of visible rows in the browser's local timezone with adaptive precision — `HH:MM` down to nanoseconds in 3-digit increments depending on how close the boundary timestamps are; cross-day ranges include the date. Boundary indicators (`(start)`, `(end)`, `(all)`) show when you've reached the edges of the dataset. The `⟳` button re-fetches the current page. Navigation is ref-based (each page fetches relative to the first or last row's `_mkio_ref`), with `before: true` for backward fetches, so pages stay correct even when records are added or deleted mid-session. When navigating backward yields no data, the previous page is automatically restored and the Earlier button is disabled. A toggleable "Live" button switches to real-time streaming from the current page's last ref; in live mode, clicking Earlier uses a separate subscription to fetch and prepend historical pages without interrupting the live stream (toolbar shows `HH:mm – Live`). Live streams follow the tail like a terminal: entering live jumps to the newest row, and while the viewport is parked at the bottom, arriving rows keep scrolling into view — scroll up to inspect history and the viewport stays put. Set `live: true` to start in live mode: the start page loads first and then hands off to the live stream, so `start` is still honored rather than the whole buffer being replayed; exiting live returns to that start page, and reopening the pane re-arms it. Exiting live mode re-fetches the saved page from the server so that rows inserted or deleted during live mode are reflected. When the WebSocket disconnects while live mode is active, the toolbar shows "Disconnected" (or `HH:mm – Disconnected` with earlier pages) in muted text instead of the green blinking "Live" indicator — live mode stays active for seamless reconnect. Stream tables track the last received ref and use it on re-subscribe to avoid duplicate data transfer — existing rows are preserved and only new records are fetched. Query and subpub snapshots fully replace the table on each arrival, so records deleted on the server between disconnect and reconnect are properly removed. Tables are fully selectable, Excel-style: a sticky **row-number column** (disable with `rowColumn: false`) selects rows — click, ctrl/cmd-click to toggle, shift-click for ranges, drag for a range, or click the header corner to select all — while clicking anywhere in a cell — its text, a tree row's caret cell, a rich badge — places the **focused cell** (accent outline; its whole row gets a subtle highlight so the record stays readable, distinct from the stronger row-selection tint). Drag across cells for a rectangle, ctrl/cmd-click to add or remove individual cells, shift-click or shift+arrows to extend; arrows/Home/End/PageUp/PageDown move the cursor, Space (or Shift+Space) selects the focused row, ctrl/cmd+Space toggles it, Ctrl/Cmd+A selects all visible rows, and Escape clears the selection. **Ctrl/Cmd+C copies** the selection to the OS clipboard in both TSV and HTML flavors, so pasting into Excel/Sheets preserves cell and row structure — row selections include a header row of column labels; cell selections copy values only, with blanks outside the selected rectangles; the copied cells pulse and the statusbar briefly shows "Copied N rows/cells" (via the `status.message` state path). **Ctrl/Cmd+F finds** — a compact find strip appears between the toolbar and the header (it exists only while open, so it costs no room otherwise, and the `edit.find` action puts it in a menu): type to search column labels and every cell on screen for a case-insensitive substring, `.*` switches to a regular expression and `Aa` to match case, matches are tinted in place and counted ("3 of 12"), and Enter / Shift+Enter step through them — as do Ctrl/Cmd+G and Ctrl/Cmd+Shift+G from anywhere in the pane (with the strip closed they bring it back on its last search and step at once) and F3 / Shift+F3 from the table — a match is a cursor move, so it scrolls into view and the selection collapses as with an arrow key, while a header match scrolls sideways. Find navigates rather than filters: it never hides a row, it searches what a cell shows (so a `display` template is searched as read), and hidden columns and collapsed tree rows are out of its reach. Live inserts, sorts, and filters keep the match list current, holding on to the current match wherever it moves. Escape closes the strip (from the table, Escape first clears the selection, then closes it). Selection follows the filtered view (hidden rows are never selected or copied) and tracks records rather than positions: re-sorting moves the selection with its rows (rows that sort into the middle of a selected block don't join it), rows inserted live inside a selected range stay unselected, and members hidden by a filter rejoin the selection when the filter is relaxed. Table toolbar buttons can declare a selection `unit` (`"rows"` default, `"row"`, `"cells"`, `"cell"` — singular units imply exactly-one): row-unit buttons receive the rows containing the cell selection (or the focused cell) even when no row is explicitly selected, and cell-unit buttons get a `cells` array of `{ row, column, value }` in their action context. Set `select = { state = "<path>" }` to mirror the current row into app state as the selection moves, so a detail pane or chart can follow the table without any custom code; clearing the cursor publishes `null` (as do deleting that row and closing the pane), and a live update to that row republishes it. **Selection can also be set programmatically** — `workspace.selectPane(id, keys, { focus })` and the `table.select` action select rows by identity, exactly as a click would: the selection publishes to `select.state`, broadcasts through table links, and arms the toolbar buttons, and in a tree the row's collapsed ancestors open so it is on screen. Filters are never touched, so a key a filter hides is reported back rather than revealed — the call returns `{ ok, selected, missing, hidden }`, `missing` for keys the table hasn't loaded and `hidden` for keys a filter excludes, so a "go to this record" command can tell the user which it was instead of silently doing nothing. An empty list clears the selection. Timing matters for a deep link: a pane that has never been shown has no table yet, so the call returns `false`, and a pane whose rows are still arriving reports the key as `missing` — open the pane and wait for its data before selecting into it. Programmatic selections are one-time acts like a click: they are not saved in layouts and not re-applied when a snapshot replaces the rows. Set `link = { broadcast = { order_id = "id" } }` on one table and `link = { listen = { order_id = "parent_id" } }` on another to make the second filter by the first's selection — see **Table linking** below. Set `values = { col = "<expr>" }` to derive a column with an expression over the row — the derived value is what the table renders, sorts, filters, and copies, and it may be a virtual column that no row carries (list it in `columns`). **Conditional styling** colors cells and rows from their values: `styles = { col = <styler> }` styles a cell, `rowStyle = <styler>` styles the whole row, where a styler is a plain style map, a rule array evaluated first-match-wins — each rule is `{ when = "<expr>", ...style keys }`, a rule without `when` being the fallback — or a single expression yielding a style map; style keys are `color`, `background`, `bold`, `italic`, `underline`, `strike`, `caps`, custom `class`, and arbitrary `css`, and any string value may be a `${...}` template. Styled backgrounds blend with, rather than hide, the selection tint, and styles are recomputed on every live update. Toolbar buttons take `enable.when = "<expr>"` over the selected rows, re-evaluated as those rows change live, and a `style` with the same keys as a cell styler — `style = { color = "black", background = "red", bold = true, caps = true }` for a red, bold, upper-cased button, or a rule array whose conditions see the button's scope plus `enabled`, so a Cancel button can turn red only once it is armed (keep `bold` and `caps` the same in every rule: they change the label's width, colors don't). **Display templates** (`display = { col = "${...}" }`) control presentation without touching the value the table sorts and filters by: `${NUM(value, digits: 2, group: TRUE)}` formats, and the `mkui` function library produces rich text — `BOLD`, `ITALIC`, `COLOR`, `MUTED`, `MONO`, `BADGE(x, color)`, `ICON(name)`, `BAR(frac, color)`, `LINK(x, url)`, `HEAT(v, lo, hi)` — which renders as styled spans in the cell, pastes into spreadsheets with its colors and weights intact, and flattens to plain text everywhere else; a template that errors shows `#ERR` with the message on hover.
  - **Record undo/redo** — `history.undo` / `history.redo` on a table pane (a transaction service name, or `{ service, op, label }`) put an Undo and a Redo button in its toolbar, stepping the selected records along their own recorded versions. This is not an editor's undo: it writes to state everyone shares, so it takes no keyboard shortcut and confirms by default, in a dialog that says what the step will do — `Undo 17: v3 → v2` and the fields it moves, read from the `versions` service (`confirm = false` skips the dialog). Undo reads the row's own `_mkio_version`; redo has to know whether a version is recorded *above* the row, which the row cannot say — a `state` service answers it, and failing that the buttons still redo what this session itself undid, the way an editor's redo stack does. Undoing version 1 removes the record, so its row leaves the table with nothing left to select: the selection goes with it and Redo, with nothing selected, offers that record back by name. A disabled button says why in its tooltip. The same steps are available as the `edit.undo` / `edit.redo` actions, for a menu.
  - **As of a moment** — `history.asOf` (a reqrep service name, or `{ service, param }`) puts an *As of…* button on a query table's toolbar. Pick a time and the table shows what it held then: for each record, the newest version recorded at or before the cutoff, which the service reads from the history table in one indexed range scan (the example's `order_as_of` is the SQL). The view is read-only — the live subscription is dropped while it is up, so nothing arrives to overwrite what you are reading, every toolbar button is shut because a historical row is not one to act on, and the strip says `as at 14:32 · read-only` until *Live* re-subscribes. The button reads as pressed while the strip is up; its ×, Escape in the time field, or the button again put it away, going live if a view is up. Worth knowing what it reconstructs: recorded versions, which is not quite what the table showed at the time, because undo and redo move a record's cursor without recording anything — a row undone this afternoon still reads, as of this morning, as whatever its newest version by then was.
  - `mkio-history` — one record's recorded versions **as an ordinary table**, with a panel under it for what changed, for a table whose rows mkio [versions](../mkio/README.md#versioned-tables). The versions are rows like any other, so they come with everything a table has: sort them, filter them, pick the columns, find in them, select and copy them. They arrive oldest first — the chain in the order it happened, which is the direction the diff names it in — and a click on any header re-sorts them. The pane points that table at the `feed` service and narrows it, server-side, to the record — and re-aims the same table as you move from record to record, so the columns, sort and filters you set stay where you put them. A `history` block on the table pane says where its history lives — mkio advertises no history table and writes no service for one, so an application configures the services it wants exposed: `versions` (a reqrep service returning one record's chain, keyed by the record's primary key), optionally `state` (`{ current, top }` — which version the row sits on, for a service that does not pass `_mkio_version` through), `feed` (a query or stream service over the history table: the audit tape), `undo` / `redo` (a transaction service and its op names, for the phase that uses them), `key` (the primary key columns — asked of the server when omitted), `columns` (which fields to diff), `fields` (where a service renamed a meta column), and `table` (the base table, which the client checks against the server's list of versioned ones and warns about when it does not match). The bar between the table and the panel drags, as the ones between panes do, so either can have the room; the panel's own columns — the field, the value before, the value after (or, in Blame, the value and what last set it) — are named in a head row that stays put as the list scrolls, and its grips drag them, as a table's do: one on each divider (between before and after, the arrow's whole column is the grip) and one at the end of the last column. Widths are pixels, fixed from the moment the diff loads: each column starts just wide enough for what it shows, or a third of the panel, whichever is less, and stays put whatever the pane does — narrow the window and the columns keep their widths, the panel scrolling sideways to reach the rest. A double-click on a grip refits the column; widths are kept while the window is open, not in layouts. The field column is one width in both views; Blame's value and provenance columns have their own, since they hold different things from the diff's before and after. The pane follows the table it was opened from, and the panel follows the versions table's own selection: one version diffs against its predecessor, a range diffs its ends, and the version the record currently sits on is what it opens on and selects — not the newest recorded, which for an undone record is the redo branch rather than its present. Unchanged fields are hidden until asked for. The panel says where the record stands in its chain — `v2 of 3` — beside what it is diffing, and the record's own name is the tab's, so several history windows tell themselves apart. A **Blame** view beside the diff reads the same chain the other way: one line per field with its value and the version that last set it — `qty 750 · v2 · alice · 14:31` — so "who last touched this, and when" is one click rather than a walk through the versions; clicking a line selects the version that set it in the table above, and a field never set says so. Values render through the table's own `labels` and `display` templates, so a badge in a cell is a badge in the diff, The view controls — *Diff*, *Blame* and *Show unchanged* — sit in the versions table's toolbar, the row between the tab and the table where a table's buttons go; *Copy* sits with what it copies, at the right of the panel's own header, and takes whichever view is showing as TSV and HTML — the lines it took pulse, the button says *Copied*, and the statusbar says how many fields before putting back what it was showing; a copy that the browser refuses says *Failed* rather than pretending. Ctrl/Cmd+C belongs to the table above and copies the version rows. Open it with the `table.history` action (`{ pane, keys }` — `keys` selects that record first, so a menu item can name the record it means) or `workspace.showPaneHistory(paneId, keys)`; one history pane per table, re-pointed rather than re-opened, and it follows the selection as it moves. Which record it is about is the same `record` block a detail window takes (see [Detail windows](#detail-windows)): configured with `record.listen` it follows a broadcast name instead of a table's selection — and then needs no table pane open at all — and its toolbar carries the same pin, which freezes it on one record while you go on clicking elsewhere.
- Dialogs:
  - **Message boxes** — a dialog with a `message` and its own `buttons` is an alert, a confirm, an About box; `dialog.open` / `dialog.alert` / `dialog.confirm` / `dialog.about` open one from a menu and `app.alert` / `app.confirm` / `app.dialog` from code. See [Message boxes](#message-boxes).
  - `openDialog(spec, context, app, extra)` — config-driven modal dialog with typed fields (text, number, select, checklist, checkbox, textarea, date, time, datetime, readonly, hidden), validation, async service-backed options (`optionsFrom`), and RPC submission with error handling. The dialog floats as a non-docking frame whose title text doubles as a drag handle; if the rendered form is taller than the initial frame, the frame grows to fit it (capped at 90% of the workspace) and re-centers. A **pin button** (SVG pin icon) in the titlebar keeps the dialog open after successful submission — when active, the pin rotates 45° counterclockwise with a smooth transition; the form resets to defaults only after the server confirms success; errors leave the form intact for retry. `pin = "keep"` on the spec makes a pinned submit hold the entered values instead (and their edits, so a compute stays off them) for the next one, clearing errors and re-baselining what counts as changed; a field's own `pin: "reset"` still returns to its default, for a save-as name that must not re-save. **Keys:** Enter submits from a single-line field, ctrl/cmd+Enter submits from anywhere in the form — a textarea, where Enter is a newline, a select, a section head — and Escape cancels, from a field or with the dialog merely the focused frame, unless it is pinned: a pinned dialog ignores Escape (the pin says stay open; × still closes it); the OK button's tooltip shows the shortcut in the platform's own spelling. `submit.then = { action, args }` fires one [action](#menubar) once a submit has gone through — `table.select` on the pane that owns what the dialog just wrote, so the workspace follows the new record and the panes linked to that one follow with it, wherever it was filed — with `args` resolved against the submitted fields over the opening context (`keys = ["${task_id}"]` names the record the server received); a refused submit fires nothing, a pinned dialog fires on every confirmation.
  - **The form is live.** Every edit re-evaluates the spec against the current field values, so a dialog's shape follows what is typed into it. `showWhen = "<expr>"` shows or hides a field, a `{ row }`, a `{ group }` — the header and every item under it, up to the next header — or a single select option; `required`, `disabled`, and `readonly` take a boolean or an expression; `label`, `placeholder`, the group text, the `title`, the `footer.note`, `invalidMessage`, and `min`/`max`/`step`/`pattern` are `${...}` templates; `options` may be an expression yielding the list (strings, or `{ value, label }`); `optionsFrom.empty` names the blank choice a fetched list opens with (a template; a dash otherwise — a static `options` list is not merged into a fetched one); `type = "checklist"` is a scrolling list of tick boxes over `options` or `optionsFrom`, for choosing several records at once: its value is the ticked values joined by commas in list order (so `required` means "tick at least one" and the server splits on the comma), `value = "*"` opens with every row ticked, `all = "Every run"` adds a first row that ticks or clears them all (a dash while only some are), `size` is the rows in view (8), and `none` is what an empty list says; a select with `size = N` (2–40) is a list box N rows tall that scrolls past that — one value still, for a pick among records better seen together than behind a dropdown — and `optionsFrom` re-fetches whenever a `${field.X}` parameter changes, keeping the value the field was given before the list arrived — a default, a compute, another select's `fill` — when the list holds it. `fill = { field = "column", … }` on an `optionsFrom` select copies the picked row's columns into the named fields — a Template dropdown filling an order form from a saved row — skipping blank columns, so a template can leave a field to the user; a filled field counts as edited, so a `compute` on it yields to the pick, and a later pick overrides what was typed. `remember = "key"` keeps a field across openings in the browser's localStorage: a confirmed submit stores its value and the next opening starts from it — a service-backed select once its options hold the value, running its `fill` as a pick would; `remember = { key, value = "<expr>" }` stores the expression's result instead, so a Template pick can be remembered as the name typed into a Save-as field when there is one. `value` is a field's one-time default; `compute = "<expr>"` gives it a value that recalculates on every change — always for a `hidden` or `readonly` field (a `_`-prefixed hidden field is a scratch value that is never submitted, the place for an intermediate result), and for an editable field only until the user types in it, so a suggested default yields to a manual override and returns after a pinned dialog resets. Computed fields may build on each other in any order; a cycle stops after a few rounds with one console warning. Number fields read as numbers in expressions, an empty one as `NULL`, so `(qty ?? 0) > 0` guards a blank. The field set and each field's type stay as declared — declare the superset and gate the variants with `showWhen`. **Sections** — `{ group = "Execution", collapsible = true, collapsed = true }` folds the fields under a header away, for options that are rarely touched or that belong together: the head wears a caret and takes a click, Enter or Space (alt/option-click folds or unfolds every section at once), `collapsed` — a boolean or an expression read once at open — picks where it starts, `remember = "key"` keeps the fold in the browser's localStorage as it changes, and a folded head shows how many of its fields have been edited since the dialog opened (or `summary = "${tif} · ${note}"`, a template, in its place) so a closed section never hides a change. Folded fields are still part of the form — they submit, and a validation error under a folded head unfolds it — and unfolding grows the frame downward from its title bar (the first paint centers it; after that the top stays where it is, or where it was dragged, and rises only by what would fall off the bottom); a plain `{ group }` without `collapsible` stays the static header it always was. A header claims every item after it up to the next header, so a section normally runs to the end of the form; give it `fields = [...]` of its own and it holds those alone — `{ group = "Advanced", collapsible = true, collapsed = true, fields = [...] }` followed by a summary line keeps the line in view under the folded section — and what follows it returns to the enclosing scope, the root or the open section around it. A field needs no `name` when nothing reads or submits it — a `readonly` confirmation line such as `{ type = "readonly", value = "Delete ${row.id}?" }` — and its `value`, `compute`, and `showWhen` still apply. **Temporal fields** use the browser's native pickers and hold canonical values: a `date` is `YYYY-MM-DD`, a `time` is `HH:MM:SS`, and a `datetime` is an ISO-8601 UTC instant (`2026-09-12T21:00:00Z`, with milliseconds when the picker gave them) — the picker shows the browser's local wall clock and the dialog converts, since only the browser knows its zone. `step = 1` on a `datetime` lets the picker take seconds. `time = "optional"` on a `datetime` puts a date picker beside a time picker under the one name: with the time blank the field holds and submits the bare date (`2026-09-12`), with both it submits the instant, so one field can mean "that day" or "that moment" and the server tells which by the shape. A default (or a compute or a reset) is an ISO string or mkio ref, naive meaning UTC as everywhere in mkui; `parse = "%Y%m%d-%H:%M:%S"` (or a list of formats tried in turn, read in `tz`, UTC by default) prefills from a value kept in another format, so a row's own stamp can seed the picker. What the server receives is one shape whatever the browser's zone; formatting it for a wire is the server's job.

- Custom pane types are the primary extensibility surface. Register with
  `registerPaneType(name, factory)`; reference from config as `type = "<name>"`.
- Everything conditional or derived in config is written in the [mkio
  expression language](#expressions) — derived columns (`values`), styling
  rules (`styles` / `rowStyle`), button enablement (`enable.when`), dialog
  field visibility and values (`showWhen`, `compute`), and `${...}` templates in titles, notes,
  action payloads, and statusbar text. Applications extend it with
  `registerExprFunction(name, fn)`; there is no separate formatter or styler
  registry.

## Expressions

mkui evaluates the same expression language as mkio — `lib/expr.js` is
mkio's `mkio-expr.js`, vendored verbatim — so a condition reads identically
whether it is a server-side `where`, a client `filter` sent to the server,
or a styling rule in `client.toml`. The grammar, operators, and standard
library are documented in [mkio's README](../mkio/README.md#expression-language);
in short: `&& || !` or the words `and or not`, `== != < <= > >=`, `in` /
`not in`, `??`, arithmetic, durations (`500ms`, `1.5m` — seconds), `[...]`/`{k: v}`
literals, `a.b[0]` access, `F(x, name: v)` calls (`IF`, `CASE`, `LET`,
`NUM`, `DATE`, `MAP`, `SUM`, `COUNT`, …), lambdas `x -> …`, and pipes
`value |> (x -> …)`. Strings in config may embed expressions as `${...}`
templates.

That is language version 2 (mkio 1.5): a gate can read
`when = "LEN(rows) > 0 and ALL(rows, r -> r.status in ['pending', 'held'])"`.
A server older than 1.5 reports the `expr` expectation as unmet.

mkui evaluates leniently: an unknown name is `NULL` rather than an error
(rows and forms are heterogeneous), and an expression that fails logs one
warning and yields nothing, so a typo degrades a cell or a rule instead of
the pane. Each surface supplies its own scope:

| Surface | Scope (bare names resolve to) |
|---|---|
| `values.<col>`, `styles.<col>`, `display.<col>` | `value` (the cell's value — raw for `values`, derived for `styles`/`display`), `row`, `col`, `state`, then the row's fields by name |
| `rowStyle` | `row`, `state`, then the row's fields |
| `enable.when` | `rows` (the rows the selection implies), `row` (the first), `cells`, `selection` (`count`, `rowCount`, `cellCount`, `unit`), `connected`, `state` |
| menubar item `disabled`, `showWhen` | `state`, `app`, `pane` (`id`, `type`, `title`, `can`), `selection` (`count`, `focused`), `panes` — see [Menubar](#menubar) |
| dialog `showWhen`, `compute`, `required`/`disabled`/`readonly`, `options`, field `value`, `label`, `title`, `footer.note`, … | the form's fields by name (number fields as numbers, blank → `NULL`), `form`, plus the opening context (`row`, `rows`, `cell`, `cells`, `selection`, `state`) |
| action `data`, `dialogService.data`, `rowData` | `row`, `rows`, `cell`, `cells`, `selection`, `state` (raw row fields — never derived values) |
| statusbar / text widget `text` | `state` — the widget re-renders when any `state.<path>` it reads changes |

```toml
[panes.orders]
type = "mkio-table"
columns = ["id", "side", "symbol", "qty", "price", "notional", "status"]
values  = { notional = "ROUND(qty * price, 2)" }
styles  = { side = [ { when = "value == 'Buy'", color = "#4caf50" }, { color = "#e05252" } ],
            qty  = [ { background = "${IF(value > 5000, '#3a2f1b', '')}" } ] }
rowStyle = [ { when = "notional >= 50000 && side == 'Sell'", bold = true } ]
display = { notional = "${NUM(value, digits: 2, group: TRUE)}",
            side     = "${BADGE(value, IF(value == 'Buy', 'green', 'red'))}",
            status   = "${ICON(IF(value == 'filled', 'check', 'clock'))} ${TITLE(value)}",
            fill     = "${BAR(row.filled / qty, '#4caf50')} ${row.filled}/${qty}" }

[[panes.orders.buttons]]
label  = "Fill"
enable = { connected = true, when = "LEN(rows) > 0 && ALL(rows, r -> r.status == 'pending')" }
style  = [{ when = "enabled", background = "#2e7d32", color = "white", bold = true }, { bold = true }]
action = { type = "transaction", service = "orders", op = "fill", data = { id = "${row.id}" } }

[statusbar]
left = [{ type = "text", text = "${state.auth.user ?? 'anonymous'} · ${state.status.message}" }]
```

Extend from JavaScript with the same hooks mkio offers in Python:

```js
import { registerExprFunction, registerExprLibrary, registerExprType } from "/mkui/src/index.js";
registerExprFunction("SPREAD_BPS", (bid, ask) => ((ask - bid) / ask) * 1e4, { numeric: true, params: ["bid", "ask"] });
// client.toml:  values = { spread = "SPREAD_BPS(bid, ask)" }
```

## Quick start

```
pip install mkui mkio
mkui init myapp
mkui serve myapp
# http://localhost:8080/
```

`mkui init` scaffolds a complete project:

```
myapp/
  server.toml          ← mkio server config (schema, services, routes)
  config/
    client.toml        ← mkui app config (panes, menus, layout)
  static/
    index.html         ← entry point
```

`mkui serve` starts an [mkio](https://pypi.org/project/mkio/) server that
handles static files, config serving (TOML→JSON), the WebSocket endpoint,
and the mkio client JS — all from one process, one port.

## Installation

```
pip install mkui[mkio]
```

Runs on Linux, macOS and Windows with the standard CPython 3.9+
interpreter (`mkui serve` needs 3.11+, mkio's floor); it has no compiled
dependencies of its own. On Windows, run mkio 1.0.1 or later: earlier
1.x releases could not start their server there. The files `mkui init`
writes are UTF-8 regardless of the system code page, as TOML requires.

mkio is optional — standalone and library mode need no server — and the
extra pins it to the 1.x line mkui is built against (`mkio>=1.0,<2`).
`mkui serve` refuses to start with an mkio of another major, and the
browser reports one as an incompatible server (see
[mkio connection state](#mkio-connection-state)).

### CLI

```
mkui init [dir]                  # scaffold a new project (default: .)
mkui serve [dir] [-p PORT] [-H HOST] [-o]
                                 # serve with mkio backend; -o opens the browser
                                 # port: server.toml, else 8080; host: server.toml, else 0.0.0.0
mkui --version
mkui <command> -h                # what a command does, writes and needs
```

`serve` reads `server.toml` in the project directory, resolves the
`<mkui.static_dir>` placeholder to the installed package path, and
delegates to `mkio.create_app()`. `--port` and `--host` override `port`
and `host` in `server.toml`; the page and its websocket (`/ws`) are one
listener, so both move together, and a client config with `url = "/ws"`
follows them. Bound to every interface (`0.0.0.0`, the default) `serve`
prints the LAN address beside `localhost`; `-H 127.0.0.1` keeps the app to
this machine. A `client.toml` that still names this machine on another
port (`ws://localhost:8080/ws` under `-p 9000`) gets a warning at startup.

### Library usage

For custom backends (no mkio), serve the static assets directly:

```python
import mkui

# With FastAPI / Starlette:
from starlette.staticfiles import StaticFiles
app.mount("/mkui", StaticFiles(directory=mkui.static_dir))
```

### Driving the app from Python

A Python process that embeds mkio can push actions into every open
browser — the same `table.link`, `table.filter`, `pane.show`, … a menu
item fires, or any action the app registered — through the **control
channel**: an mkio service the browser subscribes to when the client
config names it.

```toml
# config/client.toml
[mkio]
url = "/ws"
control = "_mkui"
```

```python
from mkio import create_app
from mkui.control import install

app = create_app("server.toml")
control = install(app)                 # app.add_service("_mkui", ControlService)

async def on_started():
    await control.link("executions", listen={"order_id": "parent_order_id"})
    await control.link("orders", broadcast={"order_id": "id"})
    await control.link("orders", broadcasting=False)          # pause
    await control.record("order_detail", listen={"order_id": "id"})   # a detail window
    await control.record("order_detail", {"id": 4711})        # or just: show this one
    await control.send("table.filter", {"pane": "orders", "filters": {"status": ["open"]}})
    await control.send("pane.show", "executions", user="mark")  # one login's tabs only
    await control.frame("desk")                               # a window the config defines
    await control.alert("Market closes in 5 minutes", kind="warn", id="close")   # a notice
    await control.confirm("Roll your day orders to tomorrow?", ok="Roll", user="ann",
                          submit={"service": "orders", "op": "roll", "data": {"desk": "fx"}})

app.on_startup(on_started)
app.run()
```

`send(action, args, user=None)` returns how many tabs it reached;
`link(pane, broadcast=, listen=, broadcasting=, listening=, merge=True)`
builds the `table.link` action (`merge=False` replaces the whole
configuration, so `link(pane, merge=False)` clears it);
`record(pane, key)` shows one record in a detail window and
`record(pane, listen=/follow=/state=/pin=/retain=/title=)` says where
that window gets its records; `frame(id)` opens or raises a window the
client's `frames` defines (the `frame.show` action); `subscribers`
and `users()` say who is listening. `alert(message, title=, kind=,
details=, timeout=, id=, suppress=)` puts a [message box](#message-boxes)
on screen — give one you may push again an `id`, and the second replaces
the first where it stands instead of stacking on it. `confirm(message,
submit=, then=, ok=, cancel=, kind=, arm=, details=, timeout=, id=,
modal=)` asks a question. A push has no reply, so the answer comes back
the way everything else reaches a server: `submit = {"service", "op",
"data"}` is the transaction the OK button sends — refused, the box stays
open and says why; cancelled, nothing is sent — and `then = {"action",
"args"}` fires an action in that browser on OK. `dialog(spec_or_name,
context=)` opens anything else: a form from the client's `dialogs`, or a
whole spec whose buttons each carry a `submit` of their own. Nothing is queued for a tab that
connects later — push from an `on_connect` hook, or whenever your own
state changes. The service's default config is `{ protocol = "subpub",
access = "auth" }`; pass `config={"access": "open"}` to `install` for
an app without logins under mkio auth. `mkui serve` installs the service
too, so a config that names it works under the CLI as well (nothing
pushes there — it just keeps the subscription from failing).

## Running the examples

The standalone and library examples need only a static file server:

```
cd mkui/static
python3 -m http.server 8000
# http://localhost:8000/examples/standalone-json/
# http://localhost:8000/examples/library-js/
```

Both show message boxes. The standalone one does it from JSON alone:
Help → About (`dialog.about`, reading the `app` block), File → Welcome…
(a named dialog under `dialogs`, one of its buttons firing an action),
File → Show a notice (`dialog.alert` with a `timeout` that closes it and a
`suppress` box that stops it coming back; Show Notices Again, which a
`showWhen` keeps out of the menu until then, is `dialog.resetSuppressed`), File → Quit (a menu item's `confirm`, modal like
every confirm), and the Console pane's Clear button — a `danger` confirm
whose default is Cancel and whose red button is `arm`ed for two seconds,
with `details` folded under it, chained to a notice through `then`. The library one does
it from code: App → Close Scratch Pads… is `app.confirm` and `app.alert`,
App → Save Changes… an `app.dialog` with a field and three buttons whose
answer lands in the statusbar, and App → Simulate an Error an `app.alert`
with the stack under `details` and an `id`, so a second failure replaces
the box instead of stacking another.

The mkio-table example requires [mkio](https://pypi.org/project/mkio/) 1.x
(its `orders` table is versioned):

```
cd mkui/static/examples/mkio-table
mkio serve          # starts on port 8080 (configured in server.toml)
python seed.py      # (optional) populates sample orders in a loop
# http://localhost:8080/

mkui serve . -p 9000   # …or on another port: the page's `url = "/ws"` follows
python seed.py 9000    # the seeder takes the port (or host:port, or a ws:// URL)
```

Its Help menu has the About box — here with the server's name and version,
mkio's, and the connection beside the app's own lines, and **Copy details**
for a bug report — and Keyboard Shortcuts, a `[dialogs.shortcuts]` message
box with a link and a button that opens Find. Orders → New Order… opens
the form behind the All Orders toolbar's **+ New Order** by name
(`[dialogs.new-order]`: one spec, two ways in), and Layout → Reset to
Default… asks first. The toolbar asks too: **Cancel** is a `danger` confirm
over the selection — modal, its red button armed for two seconds, the
orders about to go listed under `details` — and **Fill** a plain one with
**Don't ask again** (Help → Ask Again Before Filling takes that back).
That item is greyed out, its tooltip saying why, until the box has been
ticked (`disabled` reading `state.dialog.suppressed`), and the Edit and
Record menus grey out what the focused pane cannot do (`pane.can`): focus
Order Detail and open Edit. Orders → Cancel an Order by Id… is type-to-confirm: the red button opens
once CANCEL is typed. Stop the server with About open and its Connection
line changes as you watch.

The history example needs [mkio](https://pypi.org/project/mkio/) 1.x — versioned tables are what it is about — and shows what one gives you:

```
cd mkui/static/examples/history
mkio serve          # starts on port 8080
python seed.py      # four orders: one amended and filled, one undone
# http://localhost:8080/
```

Its `orders` table is `versioned = true`, so mkio records every version of every row in `orders__history`, and `server.toml` writes the four services that expose it — one record's chain, where a record sits in it, the live tape, and the table as at a moment. Its `note` column is `unversioned`: a note records no version, the history pane shows no column for it, and the detail window dims its label to say so. The **Orders** pane shows `_mkio_version` beside the data and carries a `history` block naming those services; the **Audit tape** is an ordinary query pane over the history table, showing mkio's own `_mkio_op` / `_mkio_user` / `_mkio_ref` columns because it names them. Select a change on the tape and the Orders table narrows to that record (the tape broadcasts the id, the table listens); *Go to order* selects it there instead of filtering, which is what a custom action's `args` resolving against the selection is for. Record → History… opens the version timeline with its diff and blame views, Undo and Redo step the selected record along its versions with a confirmation that says what will change, and *As of…* shows the table as it stood before the seeder's edits.

**All Orders** broadcasts the selected orders' `id` and `symbol`; the **Child Orders** frame listens for the id on its `parent_id` column and **Pending** for the symbol, so a selection filters both (the chips on each toolbar show and pause the links, and a saved layout keeps them). `python control.py` serves the example in place of `mkio serve` and rewires those links from Python a few seconds after a browser connects — then pushes a notice (`control.alert`), pushes it again under the same `id` so it replaces the first instead of stacking, and asks a question (`control.confirm`) whose **Mark** button answers with the `ack` transaction: order 1's note changes in All Orders as the box closes. The seeder places child orders under pending parents (and some under other children), so the **Order Tree** tab shows the same orders nested by `parent_id`: expand a parent with its caret, place a child order under the selected row with *+ Child Order*, and try the View menu's expand/collapse actions and alt/option-clicking a filter button for the scope row. The toolbar buttons show both styling forms: the **Pending** tab's Fill and Cancel wear a plain `style` map (green, and black on red in capitals) at all times, while the All Orders Cancel turns red only once a pending order is selected, through a rule conditioned on `enabled`.

The `orders` table is `versioned = true`, so mkio records every version of every row in `orders__history`, and `server.toml` writes the four services that expose it — one record's chain, where a record sits in it, the live tape, and the table as at a moment. **All Orders** names them in a `history` block and shows `_mkio_version` beside the data, which puts *Undo*, *Redo* and *As of…* on its toolbar: filling or cancelling an order moves it to a second version, Undo steps it back with a confirmation that says what will change, and *As of…* shows the book as it stood before the seeder's last few minutes, read-only until *Live* re-subscribes. Undo, Redo and *As of…* arrive with the block; the version timeline does not, so All Orders adds a **History** button of its own beside them — a `table.history` action over one selected record — and Record → History… is the same step from the menubar. Either opens that order's version timeline with its diff and blame views. Record → Audit Tape opens a parked query pane over the history table — every recorded version, newest first, live as they land — whose *Go to order* selects the record in All Orders rather than filtering it (a key All Orders' `status` and `notional` filters hide is reported back rather than revealed). The **Order** window beside them is an `mkio-record` detail pane listening for the same `order_id` the tape broadcasts: click a change and the table narrows, the detail window fills, and its tab takes the record's name — pin it from its toolbar and it stays on that order while you keep clicking. An existing `orders.db` picks all this up on the next start: `auto_migrate = "safe"` creates the history table and records every live row as its baseline version.

## Project layout

```
mkui/                    Python package (pip install mkui)
  __init__.py            Exposes static_dir path and version
  __main__.py            CLI: init + serve commands
  control.py             ControlService: push actions to browsers from Python
  static/
    src/
      core.js            State store, registries, App class
      index.js           Side-effect entry point
      layout/
        tree.js          Normalized tree math
        drag.js          clampToDock, snap, dropZoneFor, frac↔rect
      lib/
        expr.js          mkio's expression language (vendored from mkio, kept in sync by tests)
        expressions.js   mkui's lenient environment, ${...} templates, state-path analysis
        rich.js          rich cell text: the `rich` type, the mkui UI function library, renderers
        layouts.js       saved-layout format, validation, and the localStorage / mkio stores
        links.js         table-link hub: retained named values, queued delivery
        icons.js         SVG icon library (vendored Lucide paths)
        dialogs.js       message-box specs: alert, confirm, About, a menu item's confirm
      components/
        app.js           <mkui-app> — the shell
        menubar.js       <mkui-menubar>
        statusbar.js     <mkui-statusbar>
        workspace.js     <mkui-workspace> — frame list, arrangement, snap
        frame.js         <mkui-frame> + <mkui-pane>
      widgets/
        text.js  button.js  mkio-table.js  mkui-dialog.js
      auth.js            Config-driven login dialog
      layouts.js         Layout menu actions, store selection, startup restore
      mkio-bridge.js     Lazy-loads mkio's /mkio.js client
    styles/mkui.css      Default theme (CSS custom properties)
    examples/
      standalone-json/   Loaded from a static config
      library-js/        Built imperatively from JS
      mkio-table/        Live table backed by mkio query/subpub services
                         (config-only derived columns, styling rules,
                         enable conditions, and record history over a
                         versioned orders table; static/app.js registers
                         an expression function and the order-detail pane)
      history/           Versioned table: the audit tape, the version
                         timeline with diff and blame, record undo/redo,
                         and the table as at a moment (config only)
pyproject.toml           Python build config
tests/
  layout.test.js         Layout tree unit tests (node:test)
  state.test.js          State + connection lifecycle tests (node:test)
  table.test.js          mkio-table pane tests (node:test)
  pane-filters.test.js   Configured filters, sort, visible: specs and API (node:test)
  links.test.js          LinkHub and table-to-table linking (node:test)
  history.test.js        Versioned tables: capabilities, spec, chain logic (node:test)
  history-pane.test.js   mkio-history pane: versions, diff, blame (node:test)
  copy.test.js           Clipboard grids: TSV quoting and HTML (node:test)
  timeparse.test.js      Time detection, parsing, bounds, presets (node:test)
  icons.test.js          Icon library: every name resolves to an SVG (node:test)
  dialog.test.js         Dialog expression + submission tests, message boxes and buttons (node:test)
  popup.test.js          dialog.* action specs, App.dialog/alert/confirm, the menubar's confirm (node:test)
  auth.test.js           Authentication module + state lifecycle tests (node:test)
  expressions.test.js    Expression conformance fixtures + mkui wrapper tests (node:test)
  vendor-sync.test.js    lib/expr.js and expr_cases.json match the installed mkio (node:test)
  rich.test.js           Rich text type, mkui function library, clipboard HTML (node:test)
  styles.test.js         mkui.css layout invariants (node:test)
  tabbar.test.js         Tab bar: drag, reorder, overflow, rename (node:test)
  tab-focus.test.js      Active tab group and focus routing (node:test)
  edit-routing.test.js   edit.* actions and shortcuts reach the pane (node:test)
  pointer-guards.test.js Button/modifier guards on every drag start (node:test)
  windows-menu.test.js   Windows and layouts menu expansion (node:test)
  layouts.test.js        Saved layouts: format, stores, workspace restore, menu (node:test)
  version.test.js        The four version strings agree (node:test)
  verify.test.js         Server verification: reasons, the mkio floor (node:test)
  surface.test.js        The public surface against tests/surface.json:
                         a removal fails until the major is bumped, an
                         addition until it is added (node:test)
  test_cli.py            CLI init/serve tests (unittest)
  test_control.py        ControlService: push actions to browsers (unittest)
  test_examples.py       Each example config against its server: the
                         [mkio.expect] pins, pane services, history
                         blocks, menu and frame pane ids, and every
                         menu and button action against the ones the
                         app registers (unittest)
```

## Versioning

mkui follows [Semantic Versioning](https://semver.org) from 1.0.0 on.
The version reported by `pip`, by `mkui --version`, by `package.json` and
by `mkui.version()` in the browser is the release's semver string, and it
promises:

- **Major** releases may remove or change the meaning of anything below.
  Nothing else does.
- **Minor** releases add features backward-compatibly: new config keys,
  new actions, new state paths, new exports, new pane hooks, new
  expression functions, new CSS tokens.
- **Patch** releases fix bugs without changing documented behavior.

The compatibility promise covers the public surface an application built
on mkui depends on:

- The client config format — the top-level keys, the pane specs and their
  keys, the `mkio`, `auth`, `layouts`, `menubar`, `statusbar` and `dialogs` blocks,
  the expression scopes each surface evaluates in — and the meaning of
  existing keys.
- The library-mode API exported by `src/index.js` and `src/core.js`
  (`App`, `State`, `LinkHub`, the `register*` and `get*` functions,
  `ensureMkio`, `attachRecord` and the record subject, `openDialog` and
  `App`'s `dialog` / `alert` / `confirm`); the built-in
  actions (`app.*`, `pane.*`, `frame.*`, `window.*`, `edit.*`, `table.*`,
  `record.*`, `layout.*`, `auth.*`, `dialog.*`) and their `args`; the documented state paths
  (`mkio.*` including `mkio.downSince` / `mkio.downFor`, `auth.*`,
  `layouts.list`, `link.<name>`, `status.message`, `dialog.suppressed`);
  and the pane hooks a custom pane type may implement (`_editActions`,
  `_filters`, `_sort`, `_columns`, `_link`, `_select`, `_tree`, `_source`,
  `_data`, `_toolbar`, `_record`, `_history`).
- The saved-layout format: a layout written by one 1.x release opens
  under any later 1.x.
- The Python API — `mkui.control.install`, `ControlService` and the
  handle's `send`, `link`, `record`, `frame`, `users` and `subscribers` — and the
  `mkui` CLI: command names, arguments, flags, exit codes.
- The theming contract: the `--mkui-*` custom properties `mkui.css`
  declares on `:root`, the `theme` attribute and `app.themes`.
- The mkio requirement: mkui 1.x works with mkio 1.x.

Not covered: `mkui-*` class names beyond those documented as styling
hooks, the DOM inside a component, the exact text of console warnings,
and `_`-prefixed internals other than the pane hooks above.

`tests/surface.test.js` pins the names that surface is made of in
`tests/surface.json`: a name that leaves fails the suite until the major
is bumped, a name that arrives until it is added to the snapshot, so the
kind of release a change needs is decided by a test rather than recalled
at release time.
