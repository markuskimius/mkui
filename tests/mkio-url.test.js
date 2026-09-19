import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { resolveMkioUrl, mkioHttpBase } from "../mkui/static/src/lib/mkio-url.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// What `location` holds for a page at that address.
function page(href) {
  const u = new URL(href);
  return { protocol: u.protocol, host: u.host, hostname: u.hostname, port: u.port };
}

test("a path follows the page's host and port", () => {
  assert.equal(resolveMkioUrl("/ws", page("http://localhost:9000/")), "ws://localhost:9000/ws");
  assert.equal(resolveMkioUrl("/ws", page("http://192.168.1.20:8080/app/")), "ws://192.168.1.20:8080/ws");
  assert.equal(resolveMkioUrl("/ws", page("http://example.com/")), "ws://example.com/ws");
  assert.equal(resolveMkioUrl("/ws", page("http://[::1]:9000/")), "ws://[::1]:9000/ws");
  assert.equal(resolveMkioUrl("/proxied/ws", page("http://example.com/")), "ws://example.com/proxied/ws");
});

test("an https page gets a secure socket", () => {
  assert.equal(resolveMkioUrl("/ws", page("https://example.com/")), "wss://example.com/ws");
  assert.equal(resolveMkioUrl("//api.example.com/ws", page("https://example.com/")), "wss://api.example.com/ws");
  assert.equal(resolveMkioUrl(":9000/ws", page("https://example.com:8443/")), "wss://example.com:9000/ws");
});

test("a port alone keeps the page's host", () => {
  const loc = page("http://myhost:3000/");
  assert.equal(resolveMkioUrl(":9000/ws", loc), "ws://myhost:9000/ws");
  assert.equal(resolveMkioUrl("ws://:9000/ws", loc), "ws://myhost:9000/ws");
  assert.equal(resolveMkioUrl("wss://:9000/ws", loc), "wss://myhost:9000/ws");
  assert.equal(resolveMkioUrl(":9000", loc), "ws://myhost:9000/ws");
});

test("an absolute URL is used as written, whatever the page", () => {
  for (const loc of [page("https://example.com:9000/"), page("file:///tmp/index.html"), undefined]) {
    assert.equal(resolveMkioUrl("ws://localhost:8080/ws", loc), "ws://localhost:8080/ws");
    assert.equal(resolveMkioUrl("wss://mkio.example.com/ws", loc), "wss://mkio.example.com/ws");
    assert.equal(resolveMkioUrl("ws://[::1]:8080/ws", loc), "ws://[::1]:8080/ws");
  }
});

test("http(s) reads as ws(s), and a missing path is mkio's /ws", () => {
  assert.equal(resolveMkioUrl("http://localhost:8080/ws"), "ws://localhost:8080/ws");
  assert.equal(resolveMkioUrl("https://example.com"), "wss://example.com/ws");
  assert.equal(resolveMkioUrl("ws://localhost:8080"), "ws://localhost:8080/ws");
  assert.equal(resolveMkioUrl("  /ws  ", page("http://localhost:9000/")), "ws://localhost:9000/ws");
});

test("a relative URL on a page with no host says what to write instead", () => {
  for (const loc of [page("file:///tmp/index.html"), undefined, null]) {
    assert.throws(() => resolveMkioUrl("/ws", loc), /relative to the page.*ws:\/\/host:port\/ws/);
    assert.throws(() => resolveMkioUrl(":9000/ws", loc), /relative to the page/);
  }
});

test("what is not a URL is refused by name", () => {
  for (const bad of ["", "   ", null, undefined, 8080, "ws", "localhost:8080/ws", "ftp://host/ws"]) {
    assert.throws(() => resolveMkioUrl(bad, page("http://localhost:8080/")), /bad mkio\.url/, String(bad));
  }
});

test("mkio.js loads from beside the socket", () => {
  assert.equal(mkioHttpBase("ws://localhost:8080/ws"), "http://localhost:8080");
  assert.equal(mkioHttpBase("wss://example.com/ws"), "https://example.com");
  assert.equal(mkioHttpBase("ws://example.com/proxied/ws"), "http://example.com/proxied");
  assert.equal(mkioHttpBase("ws://[::1]:9000/ws"), "http://[::1]:9000");
  // the host may itself start "ws": only the path's last segment is cut
  assert.equal(mkioHttpBase("ws://wsgate:8080/ws"), "http://wsgate:8080");
});

test("the bridge resolves the URL before it loads or connects", () => {
  const src = readFileSync(join(root, "mkui/static/src/mkio-bridge.js"), "utf8");
  const resolve = src.indexOf("resolveMkioUrl(url)");
  assert.ok(resolve > 0, "loadAndConnect resolves config.mkio.url");
  assert.ok(resolve < src.indexOf("injectScript(httpOrigin"), "before /mkio.js is fetched");
  assert.ok(resolve < src.indexOf("new window.MkioClient(wsUrl"), "before the client is made");
});

test("ensureMkio dials the page's own port for a relative URL", async () => {
  const made = [];
  class FakeClient {
    constructor(url, opts) { made.push({ url, opts }); }
    async connect() {}
  }
  const had = { window: globalThis.window, location: globalThis.location };
  globalThis.window = { MkioClient: FakeClient };
  globalThis.location = page("http://192.168.1.20:9000/");
  try {
    const { ensureMkio } = await import("../mkui/static/src/mkio-bridge.js");
    let connected = 0;
    const client = await ensureMkio("/ws", { onConnect: () => connected++ });
    assert.equal(made.length, 1);
    assert.equal(made[0].url, "ws://192.168.1.20:9000/ws");
    made[0].opts.onConnect();
    assert.equal(connected, 1, "the caller's callbacks survive");
    // one client per page: a second caller gets the same one
    assert.equal(await ensureMkio("/ws"), client);
    assert.equal(made.length, 1);
  } finally {
    for (const [k, v] of Object.entries(had)) {
      if (v === undefined) delete globalThis[k]; else globalThis[k] = v;
    }
  }
});
