// Shortcut label: the "mod" token renders as the platform-native
// modifier — "⌘C" on Apple platforms, "Ctrl+C" elsewhere. Display only:
// handlers accept either modifier on every platform.
import { isApple } from "./wm.js";

export function formatShortcut(s) {
  const apple = isApple();
  const parts = String(s).split("+").map((p) =>
    p.trim().toLowerCase() === "mod" ? (apple ? "⌘" : "Ctrl") : p.trim());
  return apple ? parts.join("") : parts.join("+");
}
