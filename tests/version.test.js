// Run with: node --test tests/version.test.js
//
// One version, four places: pyproject.toml (the PyPI release), mkui/__init__.py
// (`mkui --version`), package.json (the npm surface), and core.js `VERSION`
// (what `mkui.version()` reports in the browser). A bump must touch all of
// them, so this pins them to each other.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VERSION, version } from "../mkui/static/src/core.js";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const grab = (text, re, what) => {
  const m = re.exec(text);
  assert.ok(m, `no version found in ${what}`);
  return m[1];
};

test("core.js VERSION matches pyproject.toml, mkui/__init__.py, and package.json", () => {
  const py = grab(read("../pyproject.toml"), /^version = "([^"]+)"/m, "pyproject.toml");
  const init = grab(read("../mkui/__init__.py"), /^__version__ = "([^"]+)"/m, "mkui/__init__.py");
  const npm = JSON.parse(read("../package.json")).version;
  assert.equal(VERSION, py);
  assert.equal(init, py);
  assert.equal(npm, py);
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(version(), VERSION);
});
