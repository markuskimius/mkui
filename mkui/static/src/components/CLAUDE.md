# mkui/static/src/components — notes kept out of the root CLAUDE.md (40,000-character cap)

## Unknown pane keys

Unknown pane keys: `_reportUnknownPaneKeys` (`setApp`, `_ensurePaneEl`; once per id) → `console.error` and a dismissible strip on the pane (`_showPaneProblem`: `.mkui-pane-problem`, `el._problem`; `.mkui-pane-has-problem` lowers the content) for keys outside `PANE_COMMON_KEYS`, `PANE_RUNTIME_KEYS` and the type's `getPaneTypeKeys` (none = unchecked).

The strip is the same text as the console line, prefixed `Config:`, with `role="alert"` and the full text as its title (the strip ellipsizes). One strip a pane, kept on the element as `el._problem`; its × removes it and the class. A mistake found at `setApp` is shown when the pane is built; one found after (a type registered later) goes on the built pane at once. `tests/layouts.test.js` covers both.
