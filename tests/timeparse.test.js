// Run with: node --test tests/timeparse.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectTimeKind, parseTime, strptime, kindForFormat, kindForSpec,
  inputToBound, boundToInput, inputTypeForKind, presetBounds, tzOffset,
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
  const today = presetBounds("today", "datetime", now);
  assert.equal(today.lo, T - 9.5 * 3600, "UTC midnight for a UTC column");
  assert.equal(today.hi, today.lo + 86400, "exclusive next midnight");
  const todayLocal = presetBounds("today", "datetime", now, true);
  const d = new Date(now * 1000);
  assert.equal(todayLocal.lo, new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000);
  // clock-time columns: today is the whole day, last-hour is by time of day
  assert.deepEqual(presetBounds("today", "time", now), { lo: 0, hi: 86400 });
  const h = presetBounds("1h", "time", now);
  const tod = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() + 0.5;
  assert.ok(Math.abs(h.hi - tod) < 1e-6 && Math.abs(h.lo - Math.max(0, tod - 3600)) < 1e-6);
  assert.equal(presetBounds("nope", "datetime", now), null);
});
