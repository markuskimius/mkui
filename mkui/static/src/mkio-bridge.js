// Auto-loads mkio's pre-built /mkio.js client from the configured URL's
// origin, so mkui never duplicates mkio's transport code.
//
// Usage:
//   const client = await ensureMkio("ws://localhost:8080/ws");
//   client.subscribe("orders", { onSnapshot, onUpdate });

let loadingPromise = null;
let cachedClient = null;

export async function ensureMkio(wsUrl, opts = {}) {
  if (cachedClient) return cachedClient;
  if (!loadingPromise) loadingPromise = loadAndConnect(wsUrl, opts);
  return loadingPromise;
}

async function loadAndConnect(wsUrl, opts) {
  const httpOrigin = wsUrl.replace(/^ws/, "http").replace(/\/ws.*$/, "");
  if (typeof window.MkioClient === "undefined") {
    await injectScript(httpOrigin + "/mkio.js");
  }
  if (typeof window.MkioClient === "undefined") {
    throw new Error(`[mkui] failed to load MkioClient from ${httpOrigin}/mkio.js`);
  }
  const client = new window.MkioClient(wsUrl, opts);
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
