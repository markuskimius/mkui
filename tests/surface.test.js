// Run with: node --test tests/surface.test.js
// Regenerate:  SURFACE_UPDATE=1 node --test tests/surface.test.js
//
// The public surface, pinned. mkui follows Semantic Versioning from 1.0.0
// (README "Versioning"): removing or changing the meaning of anything an
// application can depend on is a MAJOR release, adding is MINOR. This
// test holds a snapshot of the names that surface is made of —
// tests/surface.json — and compares it with what the source declares
// today, so the kind of release a change needs is decided by a failing
// test rather than remembered at release time:
//
//   - a name in the snapshot that the source no longer has fails until
//     VERSION's major goes above the snapshot's `major` (then the message
//     says to regenerate);
//   - a name the source has that the snapshot lacks fails until it is
//     added to the snapshot, which is the moment to notice it is public
//     and that the release is at least MINOR.
//
// What is pinned: the library-mode exports of index.js and core.js; the
// built-in actions (`registerAction` names, plus `app.quit`, handled in
// `App.fireAction` itself); the state paths the app writes (`st.set` /
// `state.set` literals: the `mkio.*`, `auth.*`, `layouts.list` and
// `status.message` paths a statusbar template or a `bindStyle` reads); the
// theme tokens (`--mkui-*` in mkui.css's `:root`, what `app.themes`
// overrides); the pane hooks a custom pane type may implement or a
// workspace API reads; the saved-layout format version; the Python
// control API and the CLI subcommands. Meanings are not pinned — only a
// reviewer can judge those — but a renamed or dropped name is caught.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

globalThis.HTMLElement ??= class {};
globalThis.customElements ??= { get: () => undefined, define: () => {} };

const here = fileURLToPath(new URL(".", import.meta.url));
const root = join(here, "..");
const src = join(root, "mkui/static/src");
const SNAPSHOT = join(here, "surface.json");
const read = (p) => readFileSync(p, "utf8");

const { VERSION } = await import("../mkui/static/src/core.js");
const index = await import("../mkui/static/src/index.js");
const core = await import("../mkui/static/src/core.js");
const { LAYOUT_VERSION } = await import("../mkui/static/src/lib/layouts.js");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".js")) out.push(p);
  }
  return out;
}
const sources = walk(src).map((p) => [relative(root, p), read(p)]);
const allSrc = sources.map(([, s]) => s).join("\n");

const uniq = (xs) => [...new Set(xs)].sort();
const matches = (text, re) => { const out = []; for (const m of text.matchAll(re)) out.push(m[1]); return out; };

// The pane hooks: the `_name` properties a pane element carries for the
// workspace, the actions and an embedding pane to read. Listed here
// rather than scraped — every `_x =` in the source is not a hook — and
// checked to still be assigned somewhere.
const PANE_HOOKS = ["_editActions", "_filters", "_sort", "_columns", "_link", "_select",
  "_tree", "_source", "_data", "_toolbar", "_record", "_history", "_ready"];

function collect() {
  const actions = uniq([...matches(allSrc, /registerAction\("([a-zA-Z.]+)"/g), "app.quit"]);
  assert.ok(/name === "app\.quit"/.test(read(join(src, "core.js"))), "app.quit is handled in App.fireAction");
  const statePaths = uniq(matches(allSrc, /\b(?:st|state)\.set\("([a-zA-Z][a-zA-Z0-9.]*)"/g));
  const css = read(join(root, "mkui/static/styles/mkui.css"));
  const rootBlock = /:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  const themeTokens = uniq(matches(rootBlock, /(--mkui-[a-z0-9-]+)\s*:/g));
  const hooks = PANE_HOOKS.filter((h) => new RegExp(`\\.${h}\\s*=[^=]`).test(allSrc));
  const control = read(join(root, "mkui/control.py"));
  // the service's public methods: the body of `class ControlService`, up
  // to the next top-level definition (the module docstring's example
  // defines an indented function too, which is not one)
  const svcBody = /^class ControlService\b[\s\S]*?(?=^(?:class|def) )/m.exec(control)?.[0] ?? "";
  const cli = read(join(root, "mkui/__main__.py"));
  return {
    major: Number(VERSION.split(".")[0]),
    exports: {
      "index.js": Object.keys(index).sort(),
      "core.js": Object.keys(core).sort(),
    },
    actions,
    statePaths,
    themeTokens,
    paneHooks: hooks,
    layoutVersion: LAYOUT_VERSION,
    python: {
      control: uniq([
        ...matches(control, /^def ([a-z][a-z_]*)\(/gm),
        ...matches(control, /^class ([A-Z][A-Za-z]*)\(/gm),
        // reachable through the install() handle as well
        ...matches(svcBody, /^    (?:async )?def ([a-z][a-z_]*)\(/gm).map((m) => `ControlService.${m}`),
      ]),
      cli: uniq(matches(cli, /add_parser\("([a-z]+)"/g)),
    },
  };
}

const live = collect();

if (process.env.SURFACE_UPDATE) {
  writeFileSync(SNAPSHOT, JSON.stringify(live, null, 2) + "\n");
  console.log(`wrote ${relative(root, SNAPSHOT)} for ${VERSION}`);
}

const snap = JSON.parse(read(SNAPSHOT));
const majorBumped = live.major > snap.major;

const REGEN = "regenerate the snapshot: SURFACE_UPDATE=1 node --test tests/surface.test.js";
function compareNames(what, was, now) {
  const removed = was.filter((x) => !now.includes(x));
  const added = now.filter((x) => !was.includes(x));
  if (removed.length) {
    assert.fail(majorBumped
      ? `${what}: ${removed.join(", ")} left the public surface with the major bump — ${REGEN}`
      : `${what}: ${removed.join(", ")} left the public surface. That is a MAJOR change under semantic ` +
        `versioning (README "Versioning"): restore the name, or bump VERSION's major and ${REGEN}`);
  }
  if (added.length) {
    assert.fail(`${what}: ${added.join(", ")} joined the public surface. Document it and add it to ` +
      `tests/surface.json (${REGEN}); the release is at least MINOR.`);
  }
}

test("surface.json is the snapshot of this major", () => {
  assert.equal(typeof snap.major, "number");
  assert.ok(live.major >= snap.major, `VERSION ${VERSION} is below the snapshot's major ${snap.major}`);
  if (majorBumped) assert.fail(`VERSION ${VERSION} bumped the major past the snapshot's ${snap.major} — ${REGEN}`);
});

test("library exports: index.js and core.js", () => {
  for (const file of Object.keys(snap.exports)) compareNames(`exports of ${file}`, snap.exports[file], live.exports[file] ?? []);
  for (const file of Object.keys(live.exports)) assert.ok(file in snap.exports, `new entry file ${file}: ${REGEN}`);
});

test("built-in actions", () => compareNames("actions", snap.actions, live.actions));

test("state paths the app writes", () => compareNames("state paths", snap.statePaths, live.statePaths));

test("theme tokens in mkui.css :root", () => compareNames("theme tokens", snap.themeTokens, live.themeTokens));

test("pane hooks", () => compareNames("pane hooks", snap.paneHooks, live.paneHooks));

test("saved-layout format version", () => {
  if (live.layoutVersion !== snap.layoutVersion) {
    assert.fail(majorBumped
      ? `LAYOUT_VERSION moved ${snap.layoutVersion} → ${live.layoutVersion} with the major bump — ${REGEN}`
      : `LAYOUT_VERSION moved ${snap.layoutVersion} → ${live.layoutVersion}: a layout saved by this major ` +
        `must open under every later release of it. Read the old shape instead, or bump the major and ${REGEN}`);
  }
});

test("python: control API and CLI subcommands", () => {
  compareNames("mkui.control", snap.python.control, live.python.control);
  compareNames("mkui CLI subcommands", snap.python.cli, live.python.cli);
});

test("the snapshot lists every category the collector knows, and no other", () => {
  assert.deepEqual(Object.keys(snap).sort(), Object.keys(live).sort(), REGEN);
});
