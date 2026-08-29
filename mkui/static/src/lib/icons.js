// SVG icon library. One <svg> per call, drawn from vendored path data —
// no icon font, no fetch, no runtime dependency. Outline paths come from
// Lucide (https://lucide.dev, ISC license); the filled shapes (carets,
// dot, hamburger) are custom and span most of the 24-box so they stay
// legible at the tiny sizes where a 2px outline stroke would break down.
//
// All icons live in a 24×24 viewBox and inherit color via currentColor
// (stroke for outline icons, fill for filled ones), so hover/active/theme
// color rules on the parent apply unchanged. Rendered size is set in CSS
// via .mkui-icon and per-context overrides.

const OUTLINE = {
  close: ["M19 5 5 19", "m5 5 14 14"],
  maximize: ["M4 4h16v16H4z"],
  pin: [
    "M12 17v5",
    "M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z",
  ],
  refresh: [
    "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8",
    "M21 3v5h-5",
    "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16",
    "M8 16H3v5",
  ],
  "chevron-left": ["m15 18-6-6 6-6"],
  "chevron-right": ["m9 18 6-6-6-6"],
  // Status glyphs for rich cell text (ICON('check') / ICON('clock')).
  check: ["M20 6 9 17l-5-5"],
  clock: ["M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20z", "M12 6v6l4 2"],
};

const FILLED = {
  "caret-up": ["M12 5l9 13H3z"],
  "caret-down": ["M12 19 3 6h18z"],
  dot: ["M12 4a8 8 0 1 1 0 16 8 8 0 0 1 0-16z"],
  // Hamburger — three solid bars, slightly inset from the carets' x 3–21
  // extent so it reads a touch lighter, and vertically a hair tighter than
  // the carets so solid bars don't read taller than a triangle; same
  // 24-box, so the filter button's icon swap on sort keeps the same
  // footprint.
  filter: ["M4.5 6h15v3h-15z", "M4.5 10.5h15v3h-15z", "M4.5 15h15v3h-15z"],
};

const NS = "http://www.w3.org/2000/svg";

export function icon(name) {
  const outline = OUTLINE[name];
  const paths = outline ?? FILLED[name];
  if (!paths) throw new Error("unknown icon: " + name);
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "mkui-icon mkui-icon-" + name);
  if (outline) {
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
  } else {
    svg.setAttribute("fill", "currentColor");
  }
  for (const d of paths) {
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", d);
    svg.appendChild(p);
  }
  return svg;
}
