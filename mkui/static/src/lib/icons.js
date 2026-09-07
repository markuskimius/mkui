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
  "chevron-up": ["m18 15-6-6-6 6"],
  "chevron-down": ["m6 9 6 6 6-6"],
  // Find strip on tables (Lucide search / regex / case-sensitive).
  search: ["M11 3a8 8 0 1 1 0 16 8 8 0 0 1 0-16z", "m21 21-4.3-4.3"],
  regex: ["M17 3v10", "m12.67 5.5 8.66 5", "m12.67 10.5 8.66-5", "M9 17a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2v-2z"],
  "case-sensitive": ["m3 15 4-8 4 8", "M4 13h6", "M18 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6z", "M21 9v6"],
  // Sort group icon on the table toolbar chips (Lucide arrow-up-down).
  sort: ["m21 16-4 4-4-4", "M17 20V4", "m3 8 4-4 4 4", "M7 4v16"],
  // Hidden-columns group icon on the table toolbar chips (Lucide columns-3).
  columns: ["M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z", "M9 3v18", "M15 3v18"],
  // Status glyphs for rich cell text (ICON('check') / ICON('clock')).
  check: ["M20 6 9 17l-5-5"],
  // Table links (Lucide link / radio / ear): the chip group's lead, and
  // the broadcast and listen directions on chips, header marks, dropdown
  // ops.
  link: ["M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71", "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"],
  radio: ["M4.9 19.1C1 15.2 1 8.8 4.9 4.9", "M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5", "M12 10a2 2 0 1 1 0 4 2 2 0 0 1 0-4z", "M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5", "M19.1 4.9C23 8.8 23 15.2 19.1 19.1"],
  ear: ["M6 8.5a6.5 6.5 0 1 1 13 0c0 6-6 6-6 10a3.5 3.5 0 1 1-7 0", "M15 8.5a2.5 2.5 0 0 0-5 0v1a2 2 0 1 1 0 4"],
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
