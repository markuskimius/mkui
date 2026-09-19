// Where the mkio socket is: `config.mkio.url` read against the page that
// asks. mkio serves the page and its socket from one port, so a config
// that names the socket relative to the page (`"/ws"`) follows the server
// to whatever host, port and scheme it is served on: `mkui serve -p 9000`,
// a browser on another machine, an https proxy in front. DOM-free
// (`tests/mkio-url.test.js`).
//
//   "/ws"                   the page's host and port
//   ":9000/ws"              the page's host, another port
//   "//host:9000/ws"        another host, the page's scheme
//   "ws://:9000/ws"         a scheme, the page's host
//   "ws://host:9000/ws"     absolute: used as written
//
// A missing scheme follows the page (`https:` → `wss`), a missing path is
// mkio's `/ws`, and `http(s)://` is read as `ws(s)://`.

const FORM = /^(?:(?:(wss?|https?):)?\/\/([^/]*))?(\/.*)?$/i;

export function resolveMkioUrl(url, loc = globalThis.location) {
  const src = typeof url === "string" ? url.trim() : "";
  // `:9000/ws` is `//:9000/ws` said shorter.
  const m = FORM.exec(/^:\d/.test(src) ? "//" + src : src);
  if (!src || !m) throw new Error(`[mkui] bad mkio.url ${JSON.stringify(url)}`);
  const [, scheme, authority = "", path = "/ws"] = m;

  let host = authority;
  if (!authority || authority.startsWith(":")) {
    // No host of its own: the page's. A page opened from a file has none.
    if (!loc?.hostname || !/^https?:$/.test(loc.protocol)) {
      throw new Error(
        `[mkui] mkio.url ${JSON.stringify(url)} is relative to the page, ` +
        `and this page was not served over http: name the server in full (ws://host:port/ws)`
      );
    }
    host = authority ? loc.hostname + authority : loc.host;
  }

  const secure = scheme ? /^(wss|https)$/i.test(scheme) : loc?.protocol === "https:";
  return `${secure ? "wss" : "ws"}://${host}${path}`;
}

// The http origin serving that socket's `/mkio.js`: the socket's address
// less its trailing `/ws`, so a path prefix (a reverse proxy) is kept.
export function mkioHttpBase(wsUrl) {
  const u = new URL(wsUrl);
  const scheme = u.protocol === "wss:" ? "https:" : "http:";
  return `${scheme}//${u.host}${u.pathname.replace(/\/ws\/?$/, "").replace(/\/$/, "")}`;
}
