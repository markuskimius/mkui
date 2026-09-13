// Run with: node --test tests/verify.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeServer, incompatibleMap, DEFAULT_MESSAGES, parseSemver, mkioSupported, MKIO_MAJOR } from "../mkui/static/src/lib/verify.js";

const expect = { name: "order-book", version: "1.0" };

test("judgeServer: a reply of the right name that passes the version check verifies", () => {
  assert.deepEqual(judgeServer({ name: "order-book", compatible: true }, expect), { verified: true, reason: null });
  assert.deepEqual(judgeServer({ name: "order-book" }, expect), { verified: true, reason: null });
});

test("judgeServer: no reply is 'unreachable', whatever the config expects", () => {
  assert.deepEqual(judgeServer(null, expect), { verified: false, reason: "unreachable" });
  assert.deepEqual(judgeServer(undefined, undefined), { verified: false, reason: "unreachable" });
});

test("judgeServer: another application is 'name', even when its version would pass", () => {
  assert.deepEqual(judgeServer({ name: "inventory", compatible: true }, expect), { verified: false, reason: "name" });
  // and 'name' wins over a failed version check: the version of another app is moot
  assert.deepEqual(judgeServer({ name: "inventory", compatible: false }, expect), { verified: false, reason: "name" });
});

test("judgeServer: the right name failing the version check is 'version'", () => {
  assert.deepEqual(judgeServer({ name: "order-book", compatible: false }, expect), { verified: false, reason: "version" });
});

test("judgeServer: without an expect block any answer verifies", () => {
  assert.deepEqual(judgeServer({ name: "anything", compatible: false }, undefined), { verified: true, reason: null });
});

// mkui's own floor: mkio 1.x. Semantic versioning from mkio 1.0.0 means a
// minor release only adds, so the major is the whole question.
test("parseSemver: two or three dot-parts, nothing else", () => {
  assert.deepEqual(parseSemver("1.2.3"), [1, 2, 3]);
  assert.deepEqual(parseSemver("1.2"), [1, 2, 0]);
  assert.deepEqual(parseSemver(" 10.0.1 "), [10, 0, 1]);
  for (const bad of ["1", "1.2.3.4", "1.x", "dev", "", null, undefined, 1.2, "v1.0.0"])
    assert.equal(parseSemver(bad), null, `parseSemver(${JSON.stringify(bad)})`);
});

test("mkioSupported: the built-against major passes, another fails, an unreadable one passes", () => {
  assert.equal(MKIO_MAJOR, 1);
  for (const ok of ["1.0.0", "1.7.2", "1.0", "1.99.99"]) assert.equal(mkioSupported(ok), true, ok);
  for (const no of ["0.10.0", "0.5.1", "2.0.0", "2.0"]) assert.equal(mkioSupported(no), false, no);
  // a source checkout with no package metadata reports "dev": not judged
  for (const dev of ["dev", "", null, undefined]) assert.equal(mkioSupported(dev), true, String(dev));
});

test("judgeServer: a server of another mkio major is 'version', expect block or not", () => {
  assert.deepEqual(judgeServer({ name: "order-book", mkio: "0.10.0", compatible: true }, expect), { verified: false, reason: "version" });
  assert.deepEqual(judgeServer({ name: "order-book", mkio: "2.0.0" }, undefined), { verified: false, reason: "version" });
  assert.deepEqual(judgeServer({ name: "order-book", mkio: "2.0.0" }, null), { verified: false, reason: "version" });
  // the right major verifies as before; a reply without `mkio` is not judged on it
  assert.deepEqual(judgeServer({ name: "order-book", mkio: "1.3.0" }, expect), { verified: true, reason: null });
  assert.deepEqual(judgeServer({ name: "order-book", mkio: "1.3.0" }, undefined), { verified: true, reason: null });
  assert.deepEqual(judgeServer({ name: "order-book" }, undefined), { verified: true, reason: null });
  assert.deepEqual(judgeServer({ name: "order-book", mkio: "dev" }, expect), { verified: true, reason: null });
});

test("judgeServer: 'name' still wins over the mkio floor", () => {
  assert.deepEqual(judgeServer({ name: "inventory", mkio: "0.10.0" }, expect), { verified: false, reason: "name" });
});

test("incompatibleMap: a flat state map applies unchanged for every reason", () => {
  const flat = { "status.message": "Wrong server", "status.background": "#cc0000" };
  for (const reason of ["unreachable", "name", "version"])
    assert.deepEqual(incompatibleMap(flat, reason), flat);
});

test("incompatibleMap: a reason entry applies on top of the shared entries", () => {
  const spec = {
    "status.message": "Wrong server",
    "status.background": "#cc0000",
    name:    { "status.message": "Not the order-book server" },
    version: { "status.message": "Server too old", "status.background": "#cc8800" },
  };
  assert.deepEqual(incompatibleMap(spec, "name"),
    { "status.message": "Not the order-book server", "status.background": "#cc0000" });
  assert.deepEqual(incompatibleMap(spec, "version"),
    { "status.message": "Server too old", "status.background": "#cc8800" });
  // a reason without its own entry gets the shared ones only
  assert.deepEqual(incompatibleMap(spec, "unreachable"),
    { "status.message": "Wrong server", "status.background": "#cc0000" });
});

test("incompatibleMap: reason entries alone fall back to the default message for the others", () => {
  const spec = { name: { "status.message": "Wrong app" } };
  assert.deepEqual(incompatibleMap(spec, "name"), { "status.message": "Wrong app" });
  assert.deepEqual(incompatibleMap(spec, "version"), { "status.message": DEFAULT_MESSAGES.version });
});

test("incompatibleMap: no config gives one default message per reason", () => {
  assert.deepEqual(incompatibleMap(undefined, "unreachable"), { "status.message": "Not an mkio server" });
  assert.deepEqual(incompatibleMap(undefined, "name"), { "status.message": "Wrong application" });
  assert.deepEqual(incompatibleMap(undefined, "version"), { "status.message": "Incompatible server version" });
});

test("incompatibleMap: a reason-named entry that is not a map is an ordinary state entry", () => {
  // `name` holding a string is a state path, not a per-reason map
  assert.deepEqual(incompatibleMap({ name: "x", "status.message": "Wrong server" }, "name"),
    { name: "x", "status.message": "Wrong server" });
});

test("incompatibleMap: an unknown reason with no config still paints a message", () => {
  assert.deepEqual(incompatibleMap(undefined, "whatever"), { "status.message": "Incompatible server" });
});

test("incompatibleMap: never mutates the config it reads", () => {
  const spec = { "status.background": "#cc0000", name: { "status.message": "Wrong app" } };
  const copy = JSON.parse(JSON.stringify(spec));
  incompatibleMap(spec, "name");
  incompatibleMap(spec, "version");
  assert.deepEqual(spec, copy);
});

// The app's wiring: the reason is reset when a verification starts, set
// beside `verified` when it ends, and cleared on disconnect.
const appSrc = await (async () => {
  const { readFileSync } = await import("node:fs");
  return readFileSync(new URL("../mkui/static/src/components/app.js", import.meta.url), "utf8");
})();

test("<mkui-app> resets mkio.reason with mkio.verified when a verification starts", () => {
  assert.match(appSrc, /st\.set\("mkio\.verified", false\);\n\s*st\.set\("mkio\.reason", null\);\n\s*st\.set\("mkio\.server", \{\}\);/);
});

test("<mkui-app> sets mkio.reason from judgeServer and applies incompatibleMap for it", () => {
  assert.match(appSrc, /const \{ verified, reason \} = judgeServer\(info, expect\);\n\s*st\.set\("mkio\.verified", verified\);\n\s*st\.set\("mkio\.reason", reason\);\n\s*if \(!verified\) apply\(incompatibleMap\(config\.mkio\.incompatible, reason\)\);/);
});

test("<mkui-app> still records what the server said before judging it", () => {
  // a rejected server's identity stays readable in mkio.server.* for the statusbar
  const judge = appSrc.indexOf("judgeServer(info, expect)");
  const record = appSrc.indexOf('st.set("mkio.server.name",');
  const compat = appSrc.indexOf('st.set("mkio.server.compatibility", info.compatibility)');
  assert.ok(record > 0 && record < judge);
  assert.ok(compat > 0 && compat < judge);
});

test("<mkui-app> judges the mkio floor under auth too, where _verify never runs", () => {
  const probe = appSrc.slice(appSrc.indexOf("this._probe = async"), appSrc.indexOf("this._verify = async"));
  assert.match(probe, /const \{ verified, reason \} = judgeServer\(info, null\);\n\s*st\.set\("mkio\.verified", verified\);\n\s*st\.set\("mkio\.reason", reason\);\n\s*if \(!verified\) apply\(incompatibleMap\(config\.mkio\.incompatible, reason\)\);/);
  // what it judges is recorded first, for the statusbar
  assert.ok(probe.indexOf('st.set("mkio.server.mkio", info.mkio ?? null)') < probe.indexOf("judgeServer(info, null)"));
  // and a failed read judges nothing: the login already proved the server
  assert.ok(probe.indexOf("could not read server capabilities") < probe.indexOf("return;"));
});

test("<mkui-app> clears mkio.reason on disconnect", () => {
  assert.match(appSrc, /onDisconnect: \(\) => \{\n\s*st\.set\("mkio\.connected", false\);\n\s*st\.set\("mkio\.verified", false\);\n\s*st\.set\("mkio\.reason", null\);/);
});
