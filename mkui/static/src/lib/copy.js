// Excel-compatible clipboard serialization. A selection is flattened to a
// 2-D string grid, then written in two flavors: text/plain TSV (CRLF rows,
// Excel-style quoting) and a text/html <table> (the flavor spreadsheets
// prefer — it keeps cell structure even when values contain tabs or
// newlines, which TSV can only approximate with quoting).

// A grid cell is a string, or { text, html } when the table rendered rich
// content — TSV takes the flattened text, the HTML flavor the markup.
export function cellText(c) {
  return c != null && typeof c === "object" ? (c.text ?? "") : c;
}

// Quote a TSV field the way Excel expects: only when it contains a tab,
// newline, or quote; inner quotes are doubled.
export function tsvQuote(v) {
  v = cellText(v);
  const s = v == null ? "" : String(v);
  return /[\t\n\r"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function gridToTSV(grid) {
  return grid.map((row) => row.map(tsvQuote).join("\t")).join("\r\n");
}

export function escapeHTML(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// The first `headerRows` rows render as <th> cells (row-mode copies carry
// the column labels; cell-mode copies pass 0).
export function gridToHTML(grid, headerRows = 0) {
  let out = "<table>";
  for (let i = 0; i < grid.length; i++) {
    const tag = i < headerRows ? "th" : "td";
    out += "<tr>";
    for (const c of grid[i]) {
      const inner = c != null && typeof c === "object" && c.html != null ? c.html : escapeHTML(cellText(c));
      out += `<${tag}>${inner}</${tag}>`;
    }
    out += "</tr>";
  }
  return out + "</table>";
}

/* ── Writing, and saying so ───────────────────────────────────────────── */

// Very large grids skip the HTML flavor to halve peak string memory — TSV
// alone still pastes into spreadsheets.
export const HTML_COPY_MAX_ROWS = 100000;

/**
 * Put a grid on the clipboard in both flavors, falling back to plain text
 * where `ClipboardItem` is missing or the write is refused. Resolves true
 * when it landed, false when it did not — a caller that says "Copied"
 * should say it on the answer, not on the attempt.
 */
export async function writeGrid(grid, { headerRows = 0 } = {}) {
  const clip = typeof navigator !== "undefined" ? navigator.clipboard : null;
  if (!clip) return false;
  const tsv = gridToTSV(grid);
  if (clip.write && typeof ClipboardItem !== "undefined" &&
      typeof Blob !== "undefined" && grid.length <= HTML_COPY_MAX_ROWS) {
    try {
      await clip.write([new ClipboardItem({
        "text/plain": new Blob([tsv], { type: "text/plain" }),
        "text/html": new Blob([gridToHTML(grid, headerRows)], { type: "text/html" }),
      })]);
      return true;
    } catch { /* fall through to writeText */ }
  }
  try {
    await clip.writeText(tsv);
    return true;
  } catch {
    return false;
  }
}

/**
 * Announce a copy on the statusbar's conventional state path, reverting
 * after a moment. The revert fires only if the message is still ours, so a
 * connection update landing mid-timeout is never clobbered; back-to-back
 * copies keep the original message to restore. One per caller.
 */
export function makeCopyStatus(state, ms = 2000) {
  let timer = null, prev = null;
  return function status(msg) {
    if (!state?.get || !state?.set) return;
    if (timer) clearTimeout(timer);
    else prev = state.get("status.message");
    state.set("status.message", msg);
    timer = setTimeout(() => {
      timer = null;
      if (state.get("status.message") === msg) state.set("status.message", prev ?? "");
    }, ms);
  };
}
