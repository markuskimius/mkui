// Server verification: what the `_mkio` reply says about the server the
// app reached, and which `incompatible` map to paint when it is not the
// one the config expects — or not one this mkui can talk to at all: mkui
// 1.x is built against mkio 1.x, and a server of another major fails
// verification whether or not the config expects anything. DOM-free
// (`tests/verify.test.js`).

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

// The mkio major this mkui is built against. mkio follows semantic
// versioning from 1.0.0: a minor release only adds, so any 1.x server
// speaks what this client speaks, and a 2.x server may not.
export const MKIO_MAJOR = 1;

// `"1.2.3"` → `[1, 2, 3]`, `"1.2"` → `[1, 2, 0]`; null for anything else
// (the same two-or-three-part rule mkio's `_mkio` service reads).
export function parseSemver(s) {
  if (typeof s !== "string") return null;
  const m = /^\s*(\d+)\.(\d+)(?:\.(\d+))?\s*$/.exec(s);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

// Whether a server reporting `mkio: version` is one this mkui supports.
// A version that cannot be parsed — `"dev"` from a source checkout with
// no package metadata, an empty string — passes: mkui cannot judge it,
// and refusing would block every development server. Callers may warn.
export function mkioSupported(version) {
  const v = parseSemver(version);
  return v === null || v[0] === MKIO_MAJOR;
}

// `info` is the `_mkio` reply row (`null` when the request failed or timed
// out), `expect` the config's `mkio.expect` block. Returns
// `{ verified, reason }`, `reason` null when verified. The mkio floor is
// judged with or without an `expect` block: it is mkui's own
// requirement, not the config's.
export function judgeServer(info, expect) {
  if (!info || typeof info !== "object") return { verified: false, reason: "unreachable" };
  if (expect?.name && info.name !== expect.name) return { verified: false, reason: "name" };
  if (info.mkio != null && !mkioSupported(info.mkio)) return { verified: false, reason: "version" };
  if (expect && info.compatible === false) return { verified: false, reason: "version" };
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
