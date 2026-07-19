// Excel-compatible clipboard serialization. A selection is flattened to a
// 2-D string grid, then written in two flavors: text/plain TSV (CRLF rows,
// Excel-style quoting) and a text/html <table> (the flavor spreadsheets
// prefer — it keeps cell structure even when values contain tabs or
// newlines, which TSV can only approximate with quoting).

// Quote a TSV field the way Excel expects: only when it contains a tab,
// newline, or quote; inner quotes are doubled.
export function tsvQuote(v) {
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
    for (const c of grid[i]) out += `<${tag}>${escapeHTML(c)}</${tag}>`;
    out += "</tr>";
  }
  return out + "</table>";
}
