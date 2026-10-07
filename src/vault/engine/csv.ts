// CSV helpers for the human-readable copies in manual exports (docs/vault.md, "CSV and README"). The conventions of
// the apps' own CSVs: every cell double-quoted with inner quotes doubled, CRLF line ends, and text that a spreadsheet
// would run as a formula (= + - @, after optional spaces) prefixed with an apostrophe. The exporter writes the UTF-8
// BOM in front of each file, so descriptors return text without one. A leaf: it imports nothing.

/** One cell: a number is written as is, null as an empty cell. */
export type CsvCell = string | number | null;

/** The byte order mark the exporter writes before every CSV, so spreadsheets read the file as UTF-8. */
export const CSV_BOM = "\uFEFF";

function cell(value: CsvCell): string {
  const text = value === null ? "" : String(value);
  // User-entered text must not turn into a spreadsheet formula; numbers (a negative weight change) stay numbers.
  const safe = typeof value === "string" && /^\s*[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

/** One CSV record without its line end. */
export function csvLine(cells: CsvCell[]): string {
  return cells.map(cell).join(",");
}

/** A whole CSV file (header row first): CRLF after every record, no BOM. */
export function csvFile(rows: CsvCell[][]): string {
  return rows.map((row) => `${csvLine(row)}\r\n`).join("");
}

/** Text without a leading BOM (the apps' own CSV builders start with one; the exporter adds its own). */
export function stripBom(text: string): string {
  return text.startsWith(CSV_BOM) ? text.slice(CSV_BOM.length) : text;
}
