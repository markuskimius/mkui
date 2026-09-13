// Server verification: what the `_mkio` reply says about the server the
// app reached, and which `incompatible` map to paint when it is not the
// one the config expects. DOM-free (`tests/verify.test.js`).

// The reasons `judgeServer` can give, in the order they are decided: a
// server that never answered is not an mkio server; one that answered
// under another name is a different application, whatever its version;
// only a server of the right name fails on version.
export const REASONS = ["unreachable", "name", "version"];

export const DEFAULT_MESSAGES = {
  unreachable: "Not an mkio server",
  name:        "Wrong application",
  version:     "Incompatible server version",
};

// `info` is the `_mkio` reply row (`null` when the request failed or timed
// out), `expect` the config's `mkio.expect` block. Returns
// `{ verified, reason }`, `reason` null when verified.
export function judgeServer(info, expect) {
  if (!info || typeof info !== "object") return { verified: false, reason: "unreachable" };
  if (expect) {
    if (expect.name && info.name !== expect.name) return { verified: false, reason: "name" };
    if (info.compatible === false) return { verified: false, reason: "version" };
  }
  return { verified: true, reason: null };
}

// The state map to apply for `reason`. `spec` is `config.mkio.incompatible`:
// a flat state map applies as it always did; entries named after a reason
// and holding a map apply on top for that reason only, so a config can
// share the colours and vary the message. Absent, the default message.
export function incompatibleMap(spec, reason) {
  const out = {};
  if (spec && typeof spec === "object") {
    for (const [k, v] of Object.entries(spec)) {
      if (REASONS.includes(k) && v && typeof v === "object") continue;
      out[k] = v;
    }
    const own = spec[reason];
    if (own && typeof own === "object") Object.assign(out, own);
  }
  if (!Object.keys(out).length) out["status.message"] = DEFAULT_MESSAGES[reason] ?? "Incompatible server";
  return out;
}
