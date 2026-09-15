// Run with: node --test tests/shortcut.test.js
//
// lib/shortcut.js: the display label for a shortcut, "mod" spelt for the
// platform. Display only — every handler takes either modifier.
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatShortcut } from "../mkui/static/src/lib/shortcut.js";

const withNavigator = (nav, fn) => {
  const had = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: nav, configurable: true, writable: true });
  try { fn(); } finally {
    if (had) Object.defineProperty(globalThis, "navigator", had); else delete globalThis.navigator;
  }
};

test("formatShortcut: mod is Ctrl, joined with +, off Apple platforms", () => {
  withNavigator({ platform: "Win32" }, () => {
    assert.equal(formatShortcut("mod+Enter"), "Ctrl+Enter");
    assert.equal(formatShortcut("MOD+c"), "Ctrl+c", "the token is case-insensitive, the key is kept as written");
  });
  withNavigator(undefined, () => assert.equal(formatShortcut("mod+C"), "Ctrl+C", "no navigator at all: not Apple"));
});

test("formatShortcut: mod is ⌘, run together, on Apple platforms", () => {
  for (const platform of ["MacIntel", "iPhone", "iPad"])
    withNavigator({ platform }, () => assert.equal(formatShortcut("mod+Enter"), "⌘Enter", platform));
  withNavigator({ userAgent: "Mozilla/5.0 (Macintosh)" }, () =>
    assert.equal(formatShortcut("mod+C"), "⌘C", "the user agent answers when platform is blank"));
});

test("formatShortcut: tokens other than mod pass through, spaces trimmed", () => {
  withNavigator({ platform: "Linux x86_64" }, () => {
    assert.equal(formatShortcut("Esc"), "Esc");
    assert.equal(formatShortcut(" mod + F "), "Ctrl+F");
  });
});
