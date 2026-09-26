// Run with: node --test tests/timeparse.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectTimeKind, parseTime, strptime, kindForFormat, kindForSpec,
  inputToBound, boundToInput, inputTypeForKind, presetBounds, tzOffset,
  refToDate, dateToRef, strftime, formatTime, formatsTime,
} from "../mkui/static/src/lib/timeparse.js";

const T = Date.UTC(2026, 7, 29, 9, 30, 0) / 1000; // 2026-08-29T09:30:00Z

test("detects the natively recognised kinds and nothing else", () => {
  assert.equal(detectTimeKind("20260829 09:30:00.123456"), "datetime");
  assert.equal(detectTimeKind("2026-08-29T09:30:00Z"), "datetime");
  assert.equal(detectTimeKind("2026-08-29 09:30"), "datetime");
  assert.equal(detectTimeKind("2026-08-29"), "date");
  assert.equal(detectTimeKind("09:30"), "time");
  assert.equal(detectTimeKind("09:30:15.5"), "time");
  // Deliberately not guessed: locale dates, 12-hour clocks, epoch numbers.
  assert.equal(detectTimeKind("03/04/2026"), null);
  assert.equal(detectTimeKind("9:30 PM"), null);
  assert.equal(detectTimeKind("1787995800"), null);
  assert.equal(detectTimeKind("Aug 29 2026"), null);
  assert.equal(detectTimeKind(42), null);
});

test("parses refs and ISO strings as UTC seconds, clock times as seconds since midnight", () => {
  assert.equal(parseTime("20260829 09:30:00"), T);
  assert.equal(parseTime("20260829 09:30:00.500000"), T + 0.5);
  assert.equal(parseTime("2026-08-29T09:30:00Z"), T);
  assert.equal(parseTime("2026-08-29 09:30"), T);
  assert.equal(parseTime("2026-08-29T11:30:00+02:00"), T);
  assert.equal(parseTime("2026-08-29"), T - 9.5 * 3600);
  assert.equal(parseTime("09:30"), 34200);
  assert.equal(parseTime("09:30:15.25"), 34215.25);
  assert.equal(parseTime(""), null);
  assert.equal(parseTime(null), null);
  assert.equal(parseTime("nope"), null);
});

test("tz reads naive strings in another zone; explicit offsets still win", () => {
  assert.equal(parseTime("2026-08-29 11:30", { tz: "+02:00" }), T);
  assert.equal(parseTime("2026-08-29T09:30:00Z", { tz: "+02:00" }), T);
  const local = parseTime("2026-08-29 09:30", { tz: "local" });
  assert.equal(local, new Date(2026, 7, 29, 9, 30).getTime() / 1000);
  assert.equal(tzOffset("UTC"), 0);
  assert.equal(tzOffset("local"), null);
  assert.equal(tzOffset("-05:30"), -330);
  assert.throws(() => tzOffset("PST"), /Unknown time zone/);
});

test("unit reads epoch numbers (and numeric strings)", () => {
  assert.equal(parseTime(T, {}), T);
  assert.equal(parseTime(T * 1000, { unit: "ms" }), T);
  assert.equal(parseTime(String(T * 1e6), { unit: "us" }), T);
  assert.equal(parseTime("x", { unit: "ms" }), null);
  assert.throws(() => parseTime(1, { unit: "weeks" }), /Unknown time unit/);
});

test("strptime handles the strftime token set", () => {
  assert.equal(strptime("29/08/2026 09:30", "%d/%m/%Y %H:%M"), T);
  assert.equal(strptime("29/8/2026 9:30", "%d/%m/%Y %H:%M"), T, "single-digit fields");
  assert.equal(strptime("2026-08-29 09:30:00.250", "%Y-%m-%d %H:%M:%S.%f"), T + 0.25);
  assert.equal(strptime("2026-08-29 11:30 +02:00", "%Y-%m-%d %H:%M %z"), T);
  assert.equal(strptime("50% 09:30", "50%% %H:%M"), 34200);
  assert.equal(strptime("29/08/2026   09:30", "%d/%m/%Y %H:%M"), T, "a format space eats a run");
  assert.equal(strptime("29-08-2026", "%d/%m/%Y"), null, "literal mismatch");
  assert.equal(strptime("29/08/2026 09:30 extra", "%d/%m/%Y %H:%M"), null, "trailing input");
  assert.throws(() => strptime("x", "%Q"), /Bad time format token/);
});

test("format and spec kinds", () => {
  assert.equal(kindForFormat("%d/%m/%Y %H:%M"), "datetime");
  assert.equal(kindForFormat("%d/%m/%Y"), "date");
  assert.equal(kindForFormat("%H:%M"), "time");
  assert.equal(kindForFormat("nothing"), null);
  assert.equal(kindForSpec({ parse: "%H:%M" }), "time");
  assert.equal(kindForSpec({ unit: "ms" }), "datetime");
  assert.equal(kindForSpec({}), null);
});

test("parse spec applies the format; fallback never guesses", () => {
  assert.equal(parseTime("29/08/2026 09:30", { parse: "%d/%m/%Y %H:%M" }), T);
  assert.equal(parseTime("2026-08-29T09:30:00Z", { parse: "%d/%m/%Y %H:%M" }), null,
    "a parse format is exclusive — ISO no longer matches");
});

test("input bounds: an exclusive hi covers the whole unit typed, in the column's zone", () => {
  assert.equal(inputToBound("2026-08-29T09:30", "datetime", "lo"), T);
  assert.equal(inputToBound("2026-08-29T09:30", "datetime", "hi"), T + 60);
  assert.equal(inputToBound("2026-08-29T09:30:00", "datetime", "hi"), T + 1);
  assert.equal(inputToBound("2026-08-29T09:30:00.5", "datetime", "hi"), T + 0.5);
  assert.equal(inputToBound("2026-08-29", "date", "lo"), T - 9.5 * 3600);
  assert.equal(inputToBound("2026-08-29", "date", "hi"), T - 9.5 * 3600 + 86400);
  assert.equal(inputToBound("09:30", "time", "lo"), 34200);
  assert.equal(inputToBound("09:30", "time", "hi"), 34260);
  assert.equal(inputToBound("09:30:15", "time", "hi"), 34216);
  assert.equal(inputToBound("", "datetime", "lo"), null);
  assert.equal(inputToBound("garbage", "datetime", "lo"), null);
  // local columns read the picker's wall-clock time in the browser's zone
  assert.equal(inputToBound("2026-08-29T09:30", "datetime", "lo", true),
    new Date(2026, 7, 29, 9, 30).getTime() / 1000);
});

test("boundToInput round-trips a lo bound", () => {
  assert.equal(boundToInput(T, "datetime"), "2026-08-29T09:30:00");
  assert.equal(boundToInput(T, "date"), "2026-08-29");
  assert.equal(boundToInput(34215, "time"), "09:30:15");
  assert.equal(boundToInput(null, "datetime"), "");
  const local = new Date(2026, 7, 29, 9, 30).getTime() / 1000;
  assert.equal(boundToInput(local, "datetime", true), "2026-08-29T09:30:00");
  assert.equal(inputTypeForKind("datetime"), "datetime-local");
  assert.equal(inputTypeForKind("date"), "date");
  assert.equal(inputTypeForKind("time"), "time");
});

test("presets resolve relative to now", () => {
  const now = T + 0.5;
  assert.deepEqual(presetBounds("1h", "datetime", now), { lo: now - 3600, hi: now });
  assert.deepEqual(presetBounds("15m", "datetime", now), { lo: now - 900, hi: now });
  // "today" is the browser's calendar day, on a UTC column too: an
  // evening table must not empty when the UTC date rolls over
  const today = presetBounds("today", "datetime", now);
  const d = new Date(now * 1000);
  assert.equal(today.lo, new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000, "local midnight");
  assert.equal(today.hi, today.lo + 86400, "exclusive next midnight");
  assert.ok(today.lo <= now && now < today.hi, "now is inside today");
  // clock-time columns: today is the whole day, last-hour is by time of day
  assert.deepEqual(presetBounds("today", "time", now), { lo: 0, hi: 86400 });
  const h = presetBounds("1h", "time", now);
  const tod = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() + 0.5;
  assert.ok(Math.abs(h.hi - tod) < 1e-6 && Math.abs(h.lo - Math.max(0, tod - 3600)) < 1e-6);
  assert.equal(presetBounds("nope", "datetime", now), null);
});

/* ── mkio refs ────────────────────────────────────────────────────────── */
// A ref is what mkio stamps on every record and every recorded version:
// `YYYYMMDD HH:MM:SS.ffffffffffff`, always UTC. These two turn one into a
// Date to show, and a Date into a cutoff to send.

test("refToDate reads a ref as UTC", () => {
  const d = refToDate("20260908 16:47:06.039064000000");
  assert.equal(d.toISOString(), "2026-09-08T16:47:06.000Z");
  assert.equal(refToDate("20260908 16:47:06").toISOString(), "2026-09-08T16:47:06.000Z",
    "the sub-second field is optional");
});

test("refToDate refuses anything that is not a ref", () => {
  for (const bad of ["2026-09-08T16:47:06Z", "16:47:06", "", "nope", null, undefined, 42])
    assert.equal(refToDate(bad), null, String(bad));
});

test("dateToRef writes one back, zeroed below the second", () => {
  const d = new Date(Date.UTC(2026, 8, 8, 16, 47, 6, 500));
  assert.equal(dateToRef(d), "20260908 16:47:06.000000000000");
  assert.equal(dateToRef(new Date(Date.UTC(2026, 0, 2, 3, 4, 5))), "20260102 03:04:05.000000000000",
    "every field is padded, so refs sort lexicographically");
});

test("a ref round-trips through a Date", () => {
  const ref = "20260908 16:47:06.000000000000";
  assert.equal(dateToRef(refToDate(ref)), ref);
});

test("strftime writes the strptime token set, %f six digits or a fixed width", () => {
  assert.equal(strftime(T + 0.25, "%S.%f %2f %9f", "UTC", "2500"), "00.2500 25 250000000", "stored digits win over the double");
  assert.equal(strftime(T, "%Y-%m-%d %H:%M:%S"), "2026-08-29 09:30:00");
  assert.equal(strftime(T, "%Y-%m-%d %H:%M:%S", "+02:00"), "2026-08-29 11:30:00");
  assert.equal(strftime(T + 0.25, "%S.%f"), "00.250000");
  assert.equal(strftime(T + 0.123456, "%S.%3f %6f %9f"), "00.123 123456 123456000", "truncated, never rounded; a double keeps microseconds");
  assert.equal(strftime(T, "%H:%M %z", "-05:30"), "04:00 -0530");
  assert.equal(strftime(T, "%H:%M %Z"), "09:30 UTC");
  assert.equal(strftime(T, "%Z", "utc"), "UTC");
  assert.equal(strftime(T, "%Z", "-05:30"), "-05:30", "a fixed offset is named as written");
  const zone = strftime(T, "%Z", "local");
  assert.match(zone, /^\S+$/, "the browser's own zone has a short name");
  assert.equal(zone, new Intl.DateTimeFormat(undefined, { timeZoneName: "short" }).formatToParts(new Date(T * 1000)).find(p => p.type === "timeZoneName").value);
  assert.throws(() => strftime(T, "%3Z"), /Bad time format token/);
  assert.equal(strftime(T, "50%% %H:%M"), "50% 09:30");
  assert.equal(strftime(34215, "%H:%M:%S"), "09:30:15", "seconds since midnight under UTC");
  assert.throws(() => strftime(T, "%Q"), /Bad time format token/);
  assert.throws(() => strftime(T, "%3Y"), /Bad time format token/);
  assert.throws(() => strftime(T, "%H", "PST"), /Unknown time zone/);
});

test("formatTime renders a value under its column spec", () => {
  const fix = { parse: "%Y%m%d-%H:%M:%S.%f" };
  assert.equal(formatsTime(fix), false, "parse alone leaves the cell as it is");
  assert.ok(formatsTime({ ...fix, zone: "local" }));
  assert.ok(formatsTime({ format: "%H:%M" }));
  assert.equal(formatTime("20260829-09:30:15.250", { ...fix, format: "%H:%M:%S.%3f", zone: "+01:00" }), "10:30:15.250");
  assert.equal(formatTime("20260829-09:30:15.250", { ...fix, zone: "+01:00" }), "20260829-10:30:15.250", "zone alone keeps the parse pattern and the digits as stored");
  assert.equal(formatTime("20260829-09:30:15.250123456", { ...fix, format: "%S.%f" }), "15.250123456", "a bare %f writes the stored fraction back, every digit");
  assert.equal(formatTime("20260829-09:30:15.250123456789", { ...fix, format: "%S.%f %3f %9f" }), "15.250123456789 250 250123456", "picoseconds parse; a width truncates the stored digits");
  assert.equal(formatTime("20260829-09:30:15.2", { ...fix, format: "%S.%f %6f" }), "15.2 200000", "a width pads them");
  assert.equal(formatTime("20260829-09:30:15", { parse: "%Y%m%d-%H:%M:%S", format: "%S.%f" }), "15.000000", "no %f in the parse pattern: six computed digits");
  assert.equal(formatTime("09:30:15.25", { parse: "%H:%M:%S.%f", format: "%H:%M:%S.%f" }), "09:30:15.25", "a clock time keeps its digits too");
  assert.equal(formatTime("20260829-09:30:15.250", { ...fix, format: "%d/%m %H:%M" }), "29/08 09:30", "format alone never shifts the clock");
  assert.equal(formatTime("20260829-09:30:15.250", { ...fix, tz: "+02:00", format: "%H:%M" }), "09:30", "…even when the column reads in an offset");
  assert.equal(formatTime("20260829-09:30:15.250", { ...fix, tz: "+02:00", format: "%H:%M", zone: "UTC" }), "07:30");
  assert.equal(formatTime("2026-08-29T09:30:00Z", { zone: "+02:00" }), "2026-08-29 11:30:00", "a native stamp gets the kind's default pattern");
  assert.equal(formatTime("2026-08-29", { zone: "+02:00", format: "%d/%m/%Y" }), "29/08/2026", "a bare date keeps its day");
  assert.equal(formatTime("29/08/2026", { parse: "%d/%m/%Y", zone: "-05:00" }), "29/08/2026");
  assert.equal(formatTime("09:30", { format: "%H:%M:%S", zone: "+02:00" }), "09:30:00", "a clock time has no zone to move");
  assert.equal(formatTime(1787995800250, { unit: "ms", format: "%H:%M:%S.%3f", zone: "+00:00" }), "09:30:00.250");
  assert.equal(formatTime("nope", { ...fix, zone: "local" }), null, "unparseable: the caller shows the value");
  assert.equal(formatTime("", { ...fix, zone: "local" }), null);
  const local = new Date(T * 1000);
  const p = (n) => String(n).padStart(2, "0");
  assert.equal(formatTime("20260829-09:30:00.000", { ...fix, format: "%Y-%m-%d %H:%M", zone: "local" }),
    `${local.getFullYear()}-${p(local.getMonth() + 1)}-${p(local.getDate())} ${p(local.getHours())}:${p(local.getMinutes())}`,
    "local is the browser's zone");
});
