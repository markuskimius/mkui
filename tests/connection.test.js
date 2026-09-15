// Run with: node --test tests/connection.test.js
//
// The connection as the shell paints it (lib/connection.js): the phase
// behind the root `mkio` attribute, the outage clock, and the
// `mkio.offline` options.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  phaseOf, formatDownFor, offlineOptions, OFFLINE_DEFAULTS, Outage, offlineTitle, restoreIconHref, OFFLINE_FAVICON,
} from "../mkui/static/src/lib/connection.js";

test("phaseOf: connecting until the first open, disconnected after it", () => {
  assert.equal(phaseOf({ connected: false, reason: null, ever: false }), "connecting");
  assert.equal(phaseOf({ connected: undefined, reason: undefined, ever: false }), "connecting");
  assert.equal(phaseOf({ connected: false, reason: null, ever: true }), "disconnected");
});

test("phaseOf: connected, or incompatible while a reason stands", () => {
  assert.equal(phaseOf({ connected: true, reason: null, ever: true }), "connected");
  for (const reason of ["unreachable", "name", "version"])
    assert.equal(phaseOf({ connected: true, reason, ever: true }), "incompatible");
});

test("formatDownFor: m:ss, h:mm:ss past an hour, never negative", () => {
  assert.equal(formatDownFor(0), "0:00");
  assert.equal(formatDownFor(999), "0:00");
  assert.equal(formatDownFor(42_000), "0:42");
  assert.equal(formatDownFor(65_000), "1:05");
  assert.equal(formatDownFor(3_600_000), "1:00:00");
  assert.equal(formatDownFor(3_723_000), "1:02:03");
  assert.equal(formatDownFor(-5_000), "0:00");
});

test("offlineOptions: defaults, per-key overrides, false for none", () => {
  assert.deepEqual(offlineOptions(undefined), { ...OFFLINE_DEFAULTS });
  assert.deepEqual(offlineOptions(null), { ...OFFLINE_DEFAULTS });
  assert.deepEqual(offlineOptions("yes"), { ...OFFLINE_DEFAULTS });
  assert.deepEqual(offlineOptions({ banner: false, delay: 10 }), { ...OFFLINE_DEFAULTS, banner: false, delay: 10 });
  assert.deepEqual(offlineOptions({ delay: "7" }), { ...OFFLINE_DEFAULTS, delay: 7 });
  assert.deepEqual(offlineOptions({ delay: 0 }), { ...OFFLINE_DEFAULTS, delay: 0 });
  // a bad delay keeps the default; unknown keys are ignored
  assert.deepEqual(offlineOptions({ delay: -1, delay2: 5, extra: true }), { ...OFFLINE_DEFAULTS });
  assert.deepEqual(offlineOptions({ delay: "soon" }), { ...OFFLINE_DEFAULTS });
  assert.deepEqual(offlineOptions(false),
    { indicator: false, title: false, favicon: false, banner: false, delay: 0, stale: false });
});

test("Outage: one transition per outage under the client's repeated disconnect callbacks", () => {
  const o = new Outage();
  assert.equal(o.active, false);
  assert.equal(o.downFor(), null);
  assert.equal(o.up(), false, "up() while up is no transition");
  assert.equal(o.down(1000), true);
  assert.equal(o.active, true);
  // mkio's client fires onDisconnect on every failed reconnect attempt
  assert.equal(o.down(2000), false);
  assert.equal(o.down(3000), false);
  assert.equal(o.since, 1000, "the clock keeps its start");
  assert.equal(o.downFor(43_000), "0:42");
  assert.equal(o.up(), true);
  assert.equal(o.up(), false);
  assert.equal(o.since, null);
  assert.equal(o.downFor(), null);
  // the next outage starts its own clock
  assert.equal(o.down(9000), true);
  assert.equal(o.downFor(9000), "0:00");
});

test("offlineTitle prefixes the app's title, and stands alone without one", () => {
  assert.equal(offlineTitle("Order Book"), "⚠ Disconnected · Order Book");
  assert.equal(offlineTitle(""), "⚠ Disconnected");
});

test("restoreIconHref: the page's own icon, else the browser's default location", () => {
  assert.equal(restoreIconHref("/img/app.png", "http://h/app/"), "/img/app.png");
  // A page without an icon link was showing /favicon.ico; point the link
  // there rather than removing it, or the red dot stays.
  assert.equal(restoreIconHref(null, "http://h/app/index.html"), "http://h/favicon.ico");
  assert.equal(restoreIconHref(undefined, "http://h:8080/"), "http://h:8080/favicon.ico");
  assert.equal(restoreIconHref(null), "/favicon.ico");
  assert.notEqual(restoreIconHref(null, "http://h/"), OFFLINE_FAVICON);
});

test("OFFLINE_FAVICON is an inline SVG data URI", () => {
  assert.match(OFFLINE_FAVICON, /^data:image\/svg\+xml,/);
  assert.match(decodeURIComponent(OFFLINE_FAVICON), /<circle /);
});
