// Run with: node --test tests/verify.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeServer, incompatibleMap, DEFAULT_MESSAGES } from "../mkui/static/src/lib/verify.js";

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

test("<mkui-app> clears mkio.reason on disconnect", () => {
  assert.match(appSrc, /onDisconnect: \(\) => \{\n\s*st\.set\("mkio\.connected", false\);\n\s*st\.set\("mkio\.verified", false\);\n\s*st\.set\("mkio\.reason", null\);/);
});
