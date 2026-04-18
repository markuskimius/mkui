# CLAUDE.md

## Project overview

mkui is a config-driven, zero-dependency web GUI framework built with Web Components. It provides a floating-frame workspace with dockable panes, proportional resize, and viewport clamping. Designed to pair with [mkio](../mkio) as the backend, but works standalone.

## Architecture

- **Workspace** (`<mkui-workspace>`) holds a z-ordered list of floating **frames**
- **Frames** (`<mkui-frame>`) are top-level chrome with 8-way resize handles; each owns an internal normalized layout tree. There is no dedicated titlebar — every top-edge tab bar doubles as a drag region, and the right-most one carries the window controls
- **Panes** (`<mkui-pane>`) are leaf content hosts inside frames; always wrapped in a TabGroup (structural invariant)
- Pane elements are pooled at the workspace level with stable identity — `appendChild` moves them between frames preserving state
- Frame positions stored as fractions of the workspace; split ratios sum to 1 — proportional resize is automatic
- Every frame move/resize passes through `clampToDock` — nothing escapes the viewport
- Keyboard focus model: the top frame gets `[data-focused]` (set by `_applyZOrder`); each frame tracks an `_activeTabGroup` updated on any mousedown within a tab bar or pane. Hotkeys act on that frame + group.

## Key files

- `mkui/__init__.py` — Python package; exposes `static_dir` for serving assets
- `mkui/static/src/layout/tree.js` — normalized tree math (normalize, find, insert, remove, layout), no DOM
- `mkui/static/src/layout/drag.js` — clamp, snap, drop-zone, frac↔rect helpers, no DOM
- `mkui/static/src/components/workspace.js` — frame lifecycle, z-order, arrangement commands, inter-frame drag routing, snap
- `mkui/static/src/components/frame.js` — frame chrome, internal tree rendering, splitter drag; also defines `<mkui-pane>`
- `mkui/static/src/components/app.js` — shell: menubar + workspace + statusbar
- `mkui/static/src/core.js` — `App`, `State` (reactive store), widget/pane-type registries
- `mkui/static/styles/mkui.css` — default theme via CSS custom properties

## Commands

- `cd mkui/static && python3 -m http.server 8000` — serve examples locally
- `node --test tests/layout.test.js` — run unit tests (node:test, no deps needed)
- `python -m build && twine upload dist/*` — build and publish to PyPI
- Examples at `mkui/static/examples/standalone-json/` and `mkui/static/examples/library-js/`

## Config format

Runtime input is JSON. TOML is parsed server-side by mkio (Python `tomllib`); the browser never needs a TOML parser.

Top-level keys: `app`, `state`, `menubar`, `statusbar`, `panes` (id→spec), `frames` (ordered array with position + layout tree), `mkio` (optional).

## Conventions

- Zero runtime dependencies; Web Components for framework-agnostic use
- `registerPaneType(name, factory)` for custom content; `registerWidget(name, factory)` for lightweight inline widgets
- Built-in actions prefixed `window.*` (tileH, tileV, grid, cascade) and `app.*` (quit)
- Layout tree invariant: every leaf sits inside a `{ type: "tabs", children: [...] }` — never bare strings after normalize
- Tests use `node:test` + `node:assert/strict`; no test framework dependency
