// Run with: node --test tests/vendor-sync.test.js
//
// lib/expr.js and tests/expr_cases.json are vendored verbatim from the mkio
// package (client/mkio-expr.mjs, tests/expr_cases.json). This test compares
// them with the installed mkio's copies so the two never drift; it skips
// when python3 or mkio isn't available.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const here = fileURLToPath(new URL(".", import.meta.url));

function mkioDir() {
  try {
    return execFileSync("python3", ["-c", "import mkio, os; print(os.path.dirname(mkio.__file__))"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

const dir = mkioDir();

test("vendored lib/expr.js matches mkio's client/mkio-expr.mjs", { skip: !dir && "mkio not installed" }, () => {
  const theirs = join(dir, "client", "mkio-expr.mjs");
  assert.ok(existsSync(theirs), `missing ${theirs} — mkio too old?`);
  const ours = readFileSync(join(here, "../mkui/static/src/lib/expr.js"), "utf8");
  assert.equal(ours, readFileSync(theirs, "utf8"),
    "lib/expr.js differs from the installed mkio — re-vendor with: cp <mkio>/client/mkio-expr.mjs mkui/static/src/lib/expr.js");
});

test("vendored tests/expr_cases.json matches mkio's fixtures", { skip: !dir && "mkio not installed" }, () => {
  const theirs = join(dir, "..", "..", "tests", "expr_cases.json");   // editable install: src/mkio -> repo/tests
  if (!existsSync(theirs)) return;                                     // wheel installs don't ship tests
  const ours = readFileSync(join(here, "expr_cases.json"), "utf8");
  assert.equal(ours, readFileSync(theirs, "utf8"), "tests/expr_cases.json differs from mkio's — re-copy it");
});
