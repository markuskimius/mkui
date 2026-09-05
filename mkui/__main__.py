"""mkui — scaffold and serve mkui projects."""

import argparse
import shutil
import subprocess
import sys
import webbrowser
from pathlib import Path

try:
    import tomllib
except ModuleNotFoundError:
    import tomli as tomllib

from mkui import __version__, static_dir

# ── Scaffold templates ────────────────────────────────────────────

INDEX_HTML = """\
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>My App</title>
  <link rel="stylesheet" href="/mkui/styles/mkui.css" />
  <script type="module" src="/mkui/src/index.js"></script>
</head>
<body>
  <mkui-app config="/config/client.json"></mkui-app>
</body>
</html>
"""

SERVER_TOML_APPEND = """\

# --- Saved window layouts (mkui's Layout menu) ---
# One row per save, newest = the user's layout, older rows its history
# (`delete` is how the client prunes it); `owner` is the login name ("" for
# the default history when the app has no login). A user reads and writes
# their own rows only:
# the `when` pre-checks bind :user to the login and :owner / :id to the
# request. Rights come from _mkio_rights — `view` is what every role has.

[tables.mkui_layouts]
columns = { id = "INTEGER PRIMARY KEY AUTOINCREMENT", app = "TEXT NOT NULL DEFAULT ''", owner = "TEXT NOT NULL DEFAULT ''", saved = "TEXT DEFAULT CURRENT_TIMESTAMP", layout = "TEXT NOT NULL" }

[services.mkui_layouts]
protocol = "transaction"
description = "Save and delete window layouts"

[services.mkui_layouts.ops]
save = { table = "mkui_layouts", op_type = "insert", fields = ["app", "owner", "layout"], access = { view = "_mkio_users WHERE username = :user AND :owner = :user" } }
delete = { table = "mkui_layouts", op_type = "delete", key = ["id"], access = { view = "mkui_layouts WHERE id = :id AND owner = :user" } }

[services.mkui_layouts_list]
protocol = "reqrep"
description = "A user's saved layouts, newest first"
access = { view = "_mkio_users WHERE username = :user AND :owner = :user" }
sql = "SELECT id, saved FROM mkui_layouts WHERE app = :app AND owner = :owner ORDER BY id DESC"

[services.mkui_layouts_get]
protocol = "reqrep"
description = "One saved layout"
access = { view = "mkui_layouts WHERE id = :id AND owner = :user" }
sql = "SELECT id, saved, layout FROM mkui_layouts WHERE id = :id"

# --- Static file serving ---

[static]
"/" = "./static"
"/mkui" = "<mkui.static_dir>"

# --- Config file serving ---

[config]
"/config" = "./config"
"""

CLIENT_TOML = """\
[app]
title = "My App"
theme = "dark"

[state.status]
message = "Connecting..."
color = "#000000"
background = "#b8b8b8"

# ─── Authentication ───────────────────────────────────────────────────
# Shows a login dialog before the app loads. Uses mkio's built-in auth
# (username/password against the _mkio_users table).
# Remove or comment this section to disable authentication entirely.

[auth]
method = "mkio"

[auth.connected]
"status.message" = "Connected"
"status.color" = ""
"status.background" = ""

[auth.disconnected]
"status.message" = "Disconnected"
"status.color" = "#000000"
"status.background" = "#b8b8b8"

# ─── Menubar ──────────────────────────────────────────────────────────

[[menubar]]
label = "Items"
items = [
  { label = "All Items", action = "pane.show", args = "all-items" },
]

[[menubar]]
label = "Activity"
items = [
  { label = "Feed", action = "pane.show", args = "feed" },
]

[[menubar]]
label = "Layout"
items = [
  { label = "Save Layout", action = "layout.save" },
  { label = "Restore Layout", layouts = true },
  { sep = true },
  { label = "Reset to Default", action = "layout.reset" },
]

[[menubar]]
label = "Window"
items = [
  { label = "Cascade", action = "window.cascade" },
  { label = "Tile", items = [
    { label = "Horizontal", action = "window.tileH" },
    { label = "Vertical",   action = "window.tileV" },
    { label = "Grid",       action = "window.grid" },
  ]},
  { sep = true },
  { windows = true },
]

[[menubar]]
label = "Account"
items = [
  { label = "Log Out", action = "auth.logout" },
]

# ─── Saved layouts ────────────────────────────────────────────────────
# The Layout menu saves the window arrangement (with each open table's
# filters, sort, and columns) under the logged-in user and restores the
# latest save at startup; earlier saves stay restorable. Stored on the
# mkio server in the mkui_layouts table that server.toml declares. Per
# user, the newest `keep` saves or the last `keepDays` days are kept,
# whichever is more.

[layouts]
keep = 10
keepDays = 7

# ─── Statusbar ─────────────────────────────────────────────────────────

[statusbar]
left = [{ type = "text", bind = "status.message" }]
right = [
  { type = "text", bind = "auth.user" },
  { type = "text", text = "my-app" },
]

[statusbar.bindStyle]
color = "status.color"
background = "status.background"

# ─── Panes ─────────────────────────────────────────────────────────────

# Live table of all items (query protocol)
[panes.all-items]
title = "All Items"
type = "mkio-table"
service = "all_items"
protocol = "query"
columns = ["category", "name", "value"]
labels = { category = "Category", name = "Name", value = "Value" }

# Add Item button — opens a dialog form
[[panes.all-items.buttons]]
label = "+ Add Item"
enable = { connected = true }

[panes.all-items.buttons.action]
type = "dialog"

[panes.all-items.buttons.action.dialog]
title = "Add Item"
modal = true
width = 420

[[panes.all-items.buttons.action.dialog.fields]]
row = [
  { name = "category", label = "Category", type = "text", width = 0.4, placeholder = "general" },
  { name = "name", label = "Name", type = "text", width = 0.6, required = true },
]

[[panes.all-items.buttons.action.dialog.fields]]
row = [
  { name = "value", label = "Value", type = "text", width = 1.0 },
]

[panes.all-items.buttons.action.dialog.submit]
label = "Add"
service = "items"
op = "save"

# Remove selected item
[[panes.all-items.buttons]]
label = "Remove"
enable = { connected = true, minSelected = 1 }
action = { type = "transaction", service = "items", op = "remove", data = { category = "${row.category}", name = "${row.name}" } }

# Activity feed (stream protocol)
[panes.feed]
title = "Feed"
type = "mkio-table"
service = "feed"
protocol = "stream"
columns = ["id", "category", "name", "action"]
labels = { id = "ID", category = "Category", name = "Name", action = "Action" }

# ─── Frames ───────────────────────────────────────────────────────────

[[frames]]
id = "main"
x = 0.02
y = 0.03
w = 0.64
h = 0.94
layout = { type = "tabs", active = 0, children = ["all-items"] }

[[frames]]
id = "sidebar"
x = 0.68
y = 0.03
w = 0.30
h = 0.55
layout = { type = "tabs", active = 0, children = ["feed"] }

# ─── mkio connection ──────────────────────────────────────────────────

[mkio]
url = "ws://localhost:8080/ws"

[mkio.connected]
"status.message" = "Connected"
"status.color" = ""
"status.background" = ""
"""


# ── Commands ──────────────────────────────────────────────────────


def cmd_init(args):
    target = Path(args.dir).resolve()

    mkio = shutil.which("mkio")
    if mkio is None:
        print("error: mkio is not installed (pip install mkio)", file=sys.stderr)
        sys.exit(1)

    # Check mkui-specific files before running mkio init
    config_path = target / "config" / "client.toml"
    if config_path.exists():
        print(f"error: {config_path} already exists", file=sys.stderr)
        sys.exit(1)

    # mkio init --no-static creates server.toml without static/index.html
    result = subprocess.run([mkio, "init", str(target), "--no-static"])
    if result.returncode != 0:
        sys.exit(result.returncode)

    # Append mkui routing to server.toml
    server_toml = target / "server.toml"
    with open(server_toml, "a") as f:
        f.write(SERVER_TOML_APPEND)

    # Create static/index.html
    static_subdir = target / "static"
    static_subdir.mkdir(exist_ok=True)
    html_path = static_subdir / "index.html"
    html_path.write_text(INDEX_HTML)
    print(f"Created {html_path}")

    # Create config/client.toml
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(CLIENT_TOML)
    print(f"Created {config_path}")

    print()
    print(f"Next: mkui serve {args.dir}")


def cmd_serve(args):
    from mkio import create_app

    project_dir = Path(args.dir).resolve()
    server_toml = project_dir / "server.toml"

    if not server_toml.is_file():
        print(f"error: {server_toml} not found", file=sys.stderr)
        print(f"       Run `mkui init {args.dir}` to create one.", file=sys.stderr)
        sys.exit(1)

    with open(server_toml, "rb") as f:
        config = tomllib.load(f)

    # Resolve <mkui.static_dir> placeholder to actual package path
    if "static" in config:
        for key, value in config["static"].items():
            if value == "<mkui.static_dir>":
                config["static"][key] = str(static_dir)

    if args.port is not None:
        config["port"] = args.port

    port = config.get("port", 8080)
    url = f"http://localhost:{port}/"

    print(f"mkui v{__version__} — serving {args.dir}")
    print(f"  Local: {url}")
    print()

    if args.open:
        webbrowser.open(url)

    app = create_app(config)
    app.run()


# ── CLI ───────────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(
        prog="mkui",
        description="Config-driven web GUI framework — scaffold and serve projects",
    )
    parser.add_argument(
        "-V", "--version", action="version", version=f"mkui {__version__}"
    )
    sub = parser.add_subparsers(dest="command")

    p_init = sub.add_parser("init", help="Create a starter project")
    p_init.add_argument(
        "dir", nargs="?", default=".", help="target directory (default: .)"
    )

    p_serve = sub.add_parser("serve", help="Serve a project directory")
    p_serve.add_argument(
        "dir", nargs="?", default=".", help="directory to serve (default: .)"
    )
    p_serve.add_argument(
        "-p", "--port", type=int, default=None, help="port (default: from server.toml)"
    )
    p_serve.add_argument(
        "-o", "--open", action="store_true", help="open browser automatically"
    )

    args = parser.parse_args()
    if args.command is None:
        parser.print_help()
        sys.exit(1)

    if args.command == "init":
        cmd_init(args)
    elif args.command == "serve":
        cmd_serve(args)


if __name__ == "__main__":
    main()
