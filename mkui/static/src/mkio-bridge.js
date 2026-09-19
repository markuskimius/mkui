// Auto-loads mkio's pre-built /mkio.js client from the configured URL's
// origin, so mkui never duplicates mkio's transport code.
//
// Usage:
//   const client = await ensureMkio("/ws");
//   client.subscribe("orders", { onSnapshot, onUpdate });
//
// The URL may be relative to the page (`lib/mkio-url.js`), so a config
// follows its server to whatever host and port it is served on.

import { resolveMkioUrl, mkioHttpBase } from "./lib/mkio-url.js";

let loadingPromise = null;
let cachedClient = null;

export async function ensureMkio(wsUrl, opts = {}) {
  if (cachedClient) return cachedClient;
  if (!loadingPromise) loadingPromise = loadAndConnect(wsUrl, opts);
  return loadingPromise;
}

async function loadAndConnect(url, opts) {
  const wsUrl = resolveMkioUrl(url);
  const httpOrigin = mkioHttpBase(wsUrl);
  if (typeof window.MkioClient === "undefined") {
    await injectScript(httpOrigin + "/mkio.js");
  }
  if (typeof window.MkioClient === "undefined") {
    throw new Error(`[mkui] failed to load MkioClient from ${httpOrigin}/mkio.js`);
  }
  const userOnConnect = opts.onConnect;
  const userOnDisconnect = opts.onDisconnect;
  const client = new window.MkioClient(wsUrl, {
    ...opts,
    onConnect:    () => userOnConnect?.(client),
    onDisconnect: () => userOnDisconnect?.(client),
  });
  await client.connect();
  cachedClient = client;
  return client;
}

function injectScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("script load failed: " + src));
    document.head.appendChild(s);
  });
}
