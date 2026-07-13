---
name: verify
description: Launch and drive mkui in a headless browser to verify UI changes end-to-end with screenshots.
---

# Verifying mkui changes at the browser surface

No build step — the served files under `mkui/static/` are the app.

## Launch

- Standalone examples (no backend):
  `cd mkui/static && python3 -m http.server 8901 --bind 127.0.0.1` then open
  `http://127.0.0.1:8901/examples/standalone-json/index.html`
- mkio-table example (live backend, tables, dialogs):
  `cd mkui/static/examples/mkio-table && python3 -m mkui serve .`
  Must run on port 8080 — `config/client.toml` hardcodes `ws://localhost:8080/ws`,
  and `-p <other>` still binds 8080 from server.toml anyway. Free the port first:
  `lsof -ti :8080 | xargs kill`.
- To exercise stream paging (Earlier/Later/Live/refresh toolbar), copy the
  mkio-table example elsewhere, append a `[services.<x>] protocol = "stream"
  primary_table = "orders"` to server.toml and a stream pane + frame to
  config/client.toml. Gotcha: server.toml's `[static] "/mkui" = "../../"` is
  relative to the example dir — rewrite it to the absolute repo
  `mkui/static` path or every `/mkui/*` asset 404s and the page renders blank
  with no console error.

## Drive

No Playwright/puppeteer package on this machine, but Playwright's Chromium is
cached: `~/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell`.
Drive it over CDP with python `websockets` (installed): launch with
`--headless --remote-debugging-port=0 --user-data-dir=$(mktemp -d)`, read the
port from `<profile>/DevToolsActivePort`, get the page ws URL from
`http://127.0.0.1:<port>/json`, then use `Page.navigate`,
`Runtime.evaluate`, `Input.dispatchMouseEvent` (real clicks; shift = modifiers
bit 8), `Page.captureScreenshot` (`clip` + `scale: 2` for zooms). A reusable
driver from a past session may exist in the session scratchpad as `cdp.py`.

## Flows worth driving

- Frame chrome: window controls (`.mkui-frame-actions`), close/maximize.
- Menubar: click a `.mkui-menu` label, hover a `.mkui-menu-item` with children
  to open its submenu.
- Table: click `th` to sort (shift+click for multi-sort superscripts), click
  `.mkui-filter-btn` for the filter dropdown, `+ New Order` toolbar button for
  a dialog with the pin control (`.mkui-dialog-pin`).
- Stream paging: toolbar `.mkui-table-paging`; Earlier disabled at `(start)`,
  `● Live` toggles `.active`, refresh disabled while live.
- Themes: `document.querySelector('mkui-app').setTheme('light')`.
