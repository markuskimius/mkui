// Geometry helpers: clamping floating windows inside the viewport, and
// computing dock-drop zones over a target rect.

// Clamp a floating window rect so it stays fully inside the dock area
// (the area between the menubar and statusbar). The dock area is what the
// caller passes in as `dockRect`.
export function clampToDock(rect, dockRect) {
  const w = Math.min(rect.w, dockRect.w);
  const h = Math.min(rect.h, dockRect.h);
  const x = Math.max(dockRect.x, Math.min(rect.x, dockRect.x + dockRect.w - w));
  const y = Math.max(dockRect.y, Math.min(rect.y, dockRect.y + dockRect.h - h));
  return { x, y, w, h };
}

// Convert a floating rect to fractions of the dock area, for storage.
export function rectToFrac(rect, dockRect) {
  return {
    xFrac: (rect.x - dockRect.x) / dockRect.w,
    yFrac: (rect.y - dockRect.y) / dockRect.h,
    wFrac: rect.w / dockRect.w,
    hFrac: rect.h / dockRect.h,
  };
}

export function fracToRect(frac, dockRect) {
  return {
    x: dockRect.x + frac.xFrac * dockRect.w,
    y: dockRect.y + frac.yFrac * dockRect.h,
    w: frac.wFrac * dockRect.w,
    h: frac.hFrac * dockRect.h,
  };
}

// Given a target window rect and a pointer position, decide which dock side
// the user is hovering over: "left" | "right" | "top" | "bottom" | "center" | null.
// Edge bands are 25% of the dimension; the inner area is "center".
export function dropZoneFor(rect, px, py) {
  if (px < rect.x || px > rect.x + rect.w || py < rect.y || py > rect.y + rect.h) {
    return null;
  }
  const fx = (px - rect.x) / rect.w;
  const fy = (py - rect.y) / rect.h;
  const edge = 0.25;
  const distLeft = fx;
  const distRight = 1 - fx;
  const distTop = fy;
  const distBottom = 1 - fy;
  const minDist = Math.min(distLeft, distRight, distTop, distBottom);
  if (minDist > edge) return "center";
  if (minDist === distLeft) return "left";
  if (minDist === distRight) return "right";
  if (minDist === distTop) return "top";
  return "bottom";
}

// ─── Snap ───────────────────────────────────────────────────────────────
// Snap a frame's edges to nearby vertical/horizontal guide lines (other
// frame edges and workspace boundaries). Each axis is independent — x can
// snap while y floats freely.

export const SNAP_THRESHOLD = 10; // pixels

// Snap a rect being *moved* (position changes, size stays fixed).
// vLines: x-coordinates to snap against.  hLines: y-coordinates.
// Returns a new rect with snapped position.
export function snapMove(rect, vLines, hLines, threshold = SNAP_THRESHOLD) {
  return {
    x: rect.x + bestSnap(rect.x, rect.x + rect.w, vLines, threshold),
    y: rect.y + bestSnap(rect.y, rect.y + rect.h, hLines, threshold),
    w: rect.w,
    h: rect.h,
  };
}

// Snap a rect being *resized*. Only the edges that are moving snap.
// `dir` is the resize handle string (e.g. "se", "n", "w").
export function snapResize(rect, dir, vLines, hLines, threshold = SNAP_THRESHOLD) {
  let { x, y, w, h } = rect;
  if (dir.includes("e")) {
    const right = x + w;
    const d = nearest(right, vLines, threshold);
    if (d !== 0) w += d;
  }
  if (dir.includes("w")) {
    const d = nearest(x, vLines, threshold);
    if (d !== 0) { x += d; w -= d; }
  }
  if (dir.includes("s")) {
    const bottom = y + h;
    const d = nearest(bottom, hLines, threshold);
    if (d !== 0) h += d;
  }
  if (dir.includes("n")) {
    const d = nearest(y, hLines, threshold);
    if (d !== 0) { y += d; h -= d; }
  }
  return { x, y, w, h };
}

// Find the best snap delta for a pair of edges (lo, hi) against a set of
// guide lines. Returns the delta to apply, or 0 if nothing is close enough.
function bestSnap(lo, hi, lines, threshold) {
  let best = 0;
  let bestDist = threshold + 1;
  for (const line of lines) {
    const dLo = line - lo;
    const dHi = line - hi;
    if (Math.abs(dLo) < bestDist) { best = dLo; bestDist = Math.abs(dLo); }
    if (Math.abs(dHi) < bestDist) { best = dHi; bestDist = Math.abs(dHi); }
  }
  return bestDist <= threshold ? best : 0;
}

// Find the nearest line to a single edge value.
function nearest(edge, lines, threshold) {
  let best = 0;
  let bestDist = threshold + 1;
  for (const line of lines) {
    const d = line - edge;
    if (Math.abs(d) < bestDist) { best = d; bestDist = Math.abs(d); }
  }
  return bestDist <= threshold ? best : 0;
}

// ─── Cascade placement ──────────────────────────────────────────────
// Pick a position for a new frame by offsetting from an existing one.
// Returns { x, y } in fractional coordinates. Wraps to avoid going
// off-screen given the frame's size (w, h also fractional).

export const CASCADE_STEP = 0.03;

export function cascadePosition(topFrame, w, h, step = CASCADE_STEP) {
  if (!topFrame) return { x: 0.2, y: 0.2 };
  let x = topFrame.x + step;
  let y = topFrame.y + step;
  if (x + w > 1) x = step;
  if (y + h > 1) y = step;
  return { x, y };
}

// ─── Drop preview ───────────────────────────────────────────────────────

// Return the on-screen overlay rect that previews where the window will land
// if dropped on `side` of `targetRect`.
export function previewRect(targetRect, side) {
  const r = targetRect;
  switch (side) {
    case "left":   return { x: r.x, y: r.y, w: r.w / 2, h: r.h };
    case "right":  return { x: r.x + r.w / 2, y: r.y, w: r.w / 2, h: r.h };
    case "top":    return { x: r.x, y: r.y, w: r.w, h: r.h / 2 };
    case "bottom": return { x: r.x, y: r.y + r.h / 2, w: r.w, h: r.h / 2 };
    case "center": return { ...r };
    default:       return null;
  }
}
