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
