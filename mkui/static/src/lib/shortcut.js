// Shortcut label: the "mod" token renders as the platform-native
// modifier — "⌘C" on Apple platforms, "Ctrl+C" elsewhere. Display only:
// handlers accept either modifier on every platform.
export function formatShortcut(s) {
  const apple = typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || "");
  const parts = String(s).split("+").map((p) =>
    p.trim().toLowerCase() === "mod" ? (apple ? "⌘" : "Ctrl") : p.trim());
  return apple ? parts.join("") : parts.join("+");
}
