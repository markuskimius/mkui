// Time parsing for column range filters. Pure functions, no DOM.
//
// A column is "temporal" when every non-empty value parses as one of the
// formats mkio itself emits — an mkio ref (`YYYYMMDD HH:MM:SS.ffffff`), an
// ISO-8601 date / date-time (`T` or space, optional fraction and `Z`/offset)
// — or a bare clock time (`HH:MM[:SS[.fff]]`). Anything else (locale dates,
// `12:30 PM`, month names, epoch numbers) is deliberately *not* guessed:
// `03/04/2026` is March 4 or April 3 depending on who wrote it. A pane's
// `types = { col = { type = "time", parse = "%d/%m/%Y %H:%M" } }` declares
// how such a column parses; `unit = "ms"` reads epoch numbers.
//
// Times resolve to seconds since the epoch, except the "time" kind (clock
// time without a date), which resolves to seconds since midnight so a range
// like 09:30–16:00 applies to every day.
//
// Naive strings (no offset) are UTC, matching the expression language's
// EPOCH(); `tz = "local"` reads them in the browser's zone instead, and a
// `+HH:MM` fixes an offset.

const REF_RE = /^(\d{4})(\d{2})(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,12}))?$/;
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?(Z|[+-]\d{2}:?\d{2})?$/;
const CLOCK_RE = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?$/;
const OFFSET_RE = /^([+-])(\d{2}):?(\d{2})$/;

const frac = (f) => f ? parseInt(f.slice(0, 9).padEnd(9, "0"), 10) / 1e9 : 0;

/** Minutes east of UTC for a tz spec; null means the browser's local zone. */
export function tzOffset(tz) {
  if (tz === undefined || tz === null || tz === "" || tz === "UTC" || tz === "utc") return 0;
  if (tz === "local") return null;
  const m = OFFSET_RE.exec(String(tz));
  if (!m) throw new Error(`Unknown time zone '${tz}': use 'UTC', 'local', or '+HH:MM'`);
  return (m[1] === "+" ? 1 : -1) * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10));
}

/** Seconds since the epoch for broken-down fields in the given zone offset. */
function assemble(Y, mo, d, H, M, S, f, offMin) {
  if (offMin === null) return new Date(Y, mo - 1, d, H, M, S).getTime() / 1000 + f;
  return Date.UTC(Y, mo - 1, d, H, M, S) / 1000 - offMin * 60 + f;
}

/**
 * Classify a string: "datetime", "date", "time", or null when it is not
 * one of the natively recognised formats.
 */
export function detectTimeKind(s) {
  if (typeof s !== "string") return null;
  const t = s.trim();
  if (REF_RE.test(t)) return "datetime";
  const m = ISO_RE.exec(t);
  if (m) return m[4] === undefined ? "date" : "datetime";
  if (CLOCK_RE.test(t)) return "time";
  return null;
}

/** Parse a natively recognised string; null when it is none of them. */
function parseNative(s, tz) {
  const t = s.trim();
  let m = REF_RE.exec(t);
  if (m) return assemble(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6], frac(m[7]), tzOffset(tz));
  m = ISO_RE.exec(t);
  if (m) {
    const off = m[8] === undefined ? tzOffset(tz) : m[8] === "Z" ? 0 : tzOffset(m[8]);
    return assemble(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0), frac(m[7]), off);
  }
  m = CLOCK_RE.exec(t);
  if (m) return +m[1] * 3600 + +m[2] * 60 + +(m[3] || 0) + frac(m[4]);
  return null;
}

// strptime over the same token set the expression language's DATE()/TIME()
// format with: %Y %m %d %H %M %S %f %z, plus %% and literal text.
const TOKEN_RE = {
  Y: /^\d{4}/, m: /^\d{1,2}/, d: /^\d{1,2}/, H: /^\d{1,2}/, M: /^\d{1,2}/, S: /^\d{1,2}/,
  f: /^\d{1,9}/, z: /^(?:Z|[+-]\d{2}:?\d{2})/,
};

/** Which kind a strptime format yields: date fields, clock fields, or both. */
export function kindForFormat(fmt) {
  const hasDate = /%[Ymd]/.test(fmt), hasClock = /%[HMSf]/.test(fmt);
  return hasDate && hasClock ? "datetime" : hasDate ? "date" : hasClock ? "time" : null;
}

/** Parse `s` with a strftime-style format; null when it does not match. */
export function strptime(s, fmt, tz) {
  const t = String(s).trim();
  const v = { Y: 1970, m: 1, d: 1, H: 0, M: 0, S: 0, f: 0, z: undefined };
  let i = 0, j = 0;
  while (j < fmt.length) {
    const c = fmt[j];
    if (c !== "%") {
      if (c === " " && /\s/.test(fmt[j + 1] ?? "")) { j++; continue; }
      if (c === " ") { // one format space eats any run of input whitespace
        if (!/\s/.test(t[i] ?? "")) return null;
        while (/\s/.test(t[i] ?? "")) i++;
        j++; continue;
      }
      if (t[i] !== c) return null;
      i++; j++; continue;
    }
    const tok = fmt[j + 1];
    j += 2;
    if (tok === "%") { if (t[i] !== "%") return null; i++; continue; }
    const re = TOKEN_RE[tok];
    if (!re) throw new Error(`Bad time format token: %${tok}`);
    const m = re.exec(t.slice(i));
    if (!m) return null;
    i += m[0].length;
    if (tok === "f") v.f = frac(m[0]);
    else if (tok === "z") v.z = m[0];
    else v[tok] = parseInt(m[0], 10);
  }
  if (i !== t.length) return null;
  const kind = kindForFormat(fmt);
  if (kind === "time") return v.H * 3600 + v.M * 60 + v.S + v.f;
  const off = v.z === undefined ? tzOffset(tz) : v.z === "Z" ? 0 : tzOffset(v.z);
  const secs = assemble(v.Y, v.m, v.d, v.H, v.M, v.S, v.f, off);
  return Number.isFinite(secs) ? secs : null;
}

const UNIT_DIV = { s: 1, ms: 1e3, us: 1e6, ns: 1e9 };

/**
 * Parse a cell value as a time under an optional column spec
 * `{ parse, tz, unit }`. Returns seconds (since the epoch, or since
 * midnight for clock times) or null when the value does not parse.
 */
export function parseTime(v, spec = {}) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    const div = UNIT_DIV[spec.unit ?? "s"];
    if (!div) throw new Error(`Unknown time unit '${spec.unit}': use s, ms, us, or ns`);
    return v / div;
  }
  const s = String(v);
  if (spec.parse) return strptime(s, spec.parse, spec.tz);
  if (spec.unit) {
    const n = Number(s);
    return s.trim() !== "" && Number.isFinite(n) ? parseTime(n, spec) : null;
  }
  return parseNative(s, spec.tz);
}

/** The kind a column spec fixes, or null to detect from the data. */
export function kindForSpec(spec = {}) {
  if (spec.parse) return kindForFormat(spec.parse);
  if (spec.unit) return "datetime";
  return null;
}

// ── Range editor helpers ────────────────────────────────────────────────
//
// The dropdown's inputs are native `datetime-local` / `date` / `time`
// controls, which speak local wall-clock time; a bound is converted to the
// column's seconds frame here. A `hi` bound is *exclusive* and covers the
// whole unit the user typed: a date bound ends at the next midnight, 10:30
// at 10:31, 10:30:15 at 10:30:16 (an epsilon subtracted from an epoch
// value would vanish in double precision, so callers compare `< hi`).

const p2 = (n) => String(n).padStart(2, "0");

/**
 * Seconds for an input control value at one edge of a range; null when the
 * input is blank or malformed. `localTz` says whether the column's naive
 * values are read as local time (the picker is local either way; when the
 * column is UTC the picked wall-clock time is taken as UTC too, so what the
 * user types matches what the cells show).
 */
export function inputToBound(str, kind, edge, localTz = false) {
  if (!str) return null;
  const off = localTz ? null : 0;
  if (kind === "time") {
    const m = CLOCK_RE.exec(str);
    if (!m) return null;
    const secs = +m[1] * 3600 + +m[2] * 60 + +(m[3] || 0) + frac(m[4]);
    return edge === "hi" ? secs + (m[3] === undefined ? 60 : 1) : secs;
  }
  if (kind === "date") {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
    if (!m) return null;
    const secs = assemble(+m[1], +m[2], +m[3], 0, 0, 0, 0, off);
    return edge === "hi" ? secs + 86400 : secs;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?$/.exec(str);
  if (!m) return null;
  const secs = assemble(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] || 0), frac(m[7]), off);
  if (edge !== "hi") return secs;
  return secs + (m[6] === undefined ? 60 : m[7] === undefined ? 1 : 0);
}

/** Input control value for a bound, the inverse of inputToBound's `lo`. */
export function boundToInput(secs, kind, localTz = false) {
  if (secs === null || secs === undefined || !Number.isFinite(secs)) return "";
  if (kind === "time") {
    const s = Math.floor(secs) % 86400;
    return `${p2(Math.floor(s / 3600))}:${p2(Math.floor(s / 60) % 60)}:${p2(s % 60)}`;
  }
  const d = new Date(Math.floor(secs) * 1000);
  const f = localTz
    ? { Y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate(), H: d.getHours(), M: d.getMinutes(), S: d.getSeconds() }
    : { Y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), H: d.getUTCHours(), M: d.getUTCMinutes(), S: d.getUTCSeconds() };
  const date = `${String(f.Y).padStart(4, "0")}-${p2(f.m)}-${p2(f.d)}`;
  return kind === "date" ? date : `${date}T${p2(f.H)}:${p2(f.M)}:${p2(f.S)}`;
}

/** Input `type` for a kind. */
export const inputTypeForKind = (kind) =>
  kind === "date" ? "date" : kind === "time" ? "time" : "datetime-local";

// Relative presets, resolved against `now` (seconds) each time the filter
// is evaluated so a live table keeps "last hour" honest as time passes.
// `hi` is exclusive like inputToBound's.
export const PRESETS = {
  today: { label: "Today" },
  "1h": { label: "Last hour", secs: 3600 },
  "15m": { label: "Last 15 min", secs: 900 },
};

/** `{ lo, hi }` in the column's frame for a preset at time `now`. */
export function presetBounds(name, kind, now = Date.now() / 1000, localTz = false) {
  const p = PRESETS[name];
  if (!p) return null;
  if (kind === "time") {
    const d = new Date(now * 1000);
    const tod = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() + (now % 1);
    return name === "today" ? { lo: 0, hi: 86400 } : { lo: Math.max(0, tod - p.secs), hi: tod };
  }
  if (name === "today") {
    const d = new Date(now * 1000);
    // "Today" is the browser's day for a local column; for a UTC column the
    // UTC day, so the range agrees with the wall-clock dates in the cells.
    const lo = localTz
      ? new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000
      : Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;
    return { lo, hi: lo + 86400 };
  }
  return { lo: now - p.secs, hi: now };
}
