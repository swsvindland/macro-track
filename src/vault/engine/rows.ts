// NDJSON rows (docs/vault.md, "NDJSON rows"): one file per table, one JSON object per line, every line ending in
// "\n", keys = the exported columns in PRAGMA table_info order, values = the raw stored values. JSON cannot carry
// every SQLite value, so three tagged objects cover the rest:
//   INTEGER beyond ±(2^53 − 1)  {"$int":"<decimal>"}   (expo-sqlite reads such integers as lossy doubles)
//   REAL ±Infinity              {"$real":"Infinity"}   (SQLite stores NaN as NULL)
//   BLOB                        {"$hex":"<lowercase hex>"}
// The writer pages through a table by rowid (500 rows per page) on a read-only snapshot connection; a precheck picks
// the plain path or, when any value needs a tag, the typed path. The reader decodes one line at a time with a bounded
// line length, because every archive is untrusted input.
import { File, FileMode } from "expo-file-system";
import type { SQLiteBindValue } from "expo-sqlite";

import { checkAborted, VaultError } from "../errors";
import type { SqlReader, VaultSql } from "../types";

import { q, type Affinity } from "./db";

const PAGE = 500;
const MAX_SAFE = 9007199254740991;
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** What one NDJSON file holds. */
export interface RowSource {
  table: string;
  /** Exported columns in PRAGMA table_info order (device columns already left out). */
  columns: readonly string[];
  /** keys and singleton tables: the row filter (`"key" IN (?, …)`, `"id" = 1`), ANDed to every page. */
  where?: VaultSql;
}

export interface WrittenRows {
  rows: number;
  /** Size of the file (UTF-8 bytes). */
  bytes: number;
  /** Whether the typed path ran (some value needed a $int, $real or $hex tag). */
  tagged: boolean;
}

/** The row filter of a keys-mode table: `"<keyColumn>" IN (?, …)` over the key universe, bound, never inlined. */
export function keysFilter(keyColumn: string, keys: readonly string[]): VaultSql {
  return { sql: `${q(keyColumn)} IN (${keys.map(() => "?").join(", ")})`, params: [...keys] };
}

/** SQL that finds one value the plain path cannot carry (a big integer, a BLOB, an infinite REAL). */
export function precheckSql(source: RowSource): string {
  const tests = source.columns.map((column) => {
    const c = q(column);
    return (
      `(typeof(${c}) = 'integer' AND (${c} > ${MAX_SAFE} OR ${c} < -${MAX_SAFE})) ` +
      `OR typeof(${c}) = 'blob' OR (typeof(${c}) = 'real' AND abs(${c}) = 9e999)`
    );
  });
  const filter = source.where ? `(${source.where.sql}) AND ` : "";
  return `SELECT 1 AS v FROM ${q(source.table)} WHERE ${filter}(${tests.join(" OR ")}) LIMIT 1`;
}

/**
 * One page of rows after the rowid cursor (`first`: no cursor). Values are aliased v0…vn (and their storage classes
 * t0…tn on the typed path), so column names never collide with the query's own names. The rowid comes back as text
 * and is bound as text, so a cursor beyond 2^53 stays exact.
 */
export function pageSql(source: RowSource, tagged: boolean, first: boolean): string {
  const values = source.columns.map((column, i) => {
    const c = q(column);
    if (!tagged) return `${c} AS "v${i}"`;
    return (
      `CASE typeof(${c}) WHEN 'integer' THEN CAST(${c} AS TEXT) WHEN 'blob' THEN lower(hex(${c})) ` +
      `WHEN 'real' THEN CASE WHEN ${c} = 9e999 THEN 'Infinity' WHEN ${c} = -9e999 THEN '-Infinity' ` +
      `ELSE ${c} END ELSE ${c} END AS "v${i}", typeof(${c}) AS "t${i}"`
    );
  });
  const conditions = [
    ...(first ? [] : ["rowid > CAST(? AS INTEGER)"]),
    ...(source.where ? [`(${source.where.sql})`] : []),
  ];
  return (
    `SELECT CAST(rowid AS TEXT) AS "r", ${values.join(", ")} FROM ${q(source.table)}` +
    `${conditions.length ? ` WHERE ${conditions.join(" AND ")}` : ""} ORDER BY rowid LIMIT ${PAGE}`
  );
}

type Encoded = number | string | null | { $int: string } | { $real: string } | { $hex: string };

function plainValue(value: unknown): Encoded {
  if (value === null || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  // Only a write between the precheck and this page could get here; snapshots are read-only.
  throw new VaultError("exportFailed", { detail: "rowValue" });
}

function taggedValue(value: unknown, type: unknown): Encoded {
  if (type === "null") return null;
  if (type === "text" && typeof value === "string") return value;
  if (type === "integer" && typeof value === "string") {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : { $int: value };
  }
  if (type === "real") {
    if (value === "Infinity" || value === "-Infinity") return { $real: value };
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  if (type === "blob" && typeof value === "string") return { $hex: value };
  throw new VaultError("exportFailed", { detail: "rowValue" });
}

/**
 * Writes every row of `source` as NDJSON to `dest` (created; replaced when it exists) and returns the row count and
 * byte size. Yields to the event loop after each page and checks `signal` before it.
 */
export async function writeRows(
  db: SqlReader,
  source: RowSource,
  dest: File,
  options: { signal?: AbortSignal; onPage?: (rows: number) => void } = {}
): Promise<WrittenRows> {
  const filter = source.where?.params ?? [];
  const tagged = db.getFirstSync(precheckSql(source), filter) != null;
  const keys = source.columns.map((column) => `${JSON.stringify(column)}:`);
  const encoder = new TextEncoder();
  dest.create({ intermediates: true, overwrite: true });
  const handle = dest.open(FileMode.WriteOnly);
  let rows = 0;
  let bytes = 0;
  let cursor: string | null = null;
  try {
    for (;;) {
      checkAborted(options.signal);
      const page: Record<string, unknown>[] = db.getAllSync<Record<string, unknown>>(
        pageSql(source, tagged, cursor === null),
        cursor === null ? filter : [cursor, ...filter]
      );
      if (!page.length) break;
      let text = "";
      for (const row of page) {
        let line = "{";
        for (let i = 0; i < keys.length; i++) {
          const value = tagged ? taggedValue(row[`v${i}`], row[`t${i}`]) : plainValue(row[`v${i}`]);
          line += `${i ? "," : ""}${keys[i]}${JSON.stringify(value)}`;
        }
        text += `${line}}\n`;
      }
      const data = encoder.encode(text);
      handle.writeBytes(data);
      bytes += data.length;
      rows += page.length;
      cursor = String(page[page.length - 1].r);
      options.onPage?.(rows);
      if (page.length < PAGE) break;
      await tick();
    }
  } finally {
    handle.close();
  }
  return { rows, bytes, tagged };
}

// ---------------------------------------------------------------------------------------------------------------
// Reading

const corrupt = (detail: string, cause?: unknown) => new VaultError("corrupt", { detail, cause });

const INT = /^-?\d{1,19}$/;
const REAL = /^-?Infinity$/;
const HEX = /^(?:[0-9a-f]{2})*$/;
const INT64_MAX = "9223372036854775807";

/** A decimal that fits a signed 64-bit integer (text compare: same length, then digits). */
function fitsInt64(text: string): boolean {
  const negative = text.startsWith("-");
  const digits = (negative ? text.slice(1) : text).replace(/^0+(?=\d)/, "");
  if (digits.length !== INT64_MAX.length) return digits.length < INT64_MAX.length;
  return digits <= (negative ? "9223372036854775808" : INT64_MAX);
}

/**
 * The bytes of a hex string, as a view into a buffer of at least one byte: drivers bind a buffer without storage (a
 * zero-length one) as NULL instead of an empty BLOB.
 */
function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(Math.max(1, hex.length / 2)).subarray(0, hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * One JSON value of a line as the value to bind. `affinity` is the column's affinity in the scratch DB: a $int is
 * bound as its decimal text, which INTEGER and NUMERIC affinity turn into the exact integer, so other affinities
 * reject it. Anything else than null, a number, a string or one of the three tags is `corrupt`.
 */
export function decodeValue(value: unknown, affinity: Affinity): SQLiteBindValue {
  if (value === null || typeof value === "string") return value;
  // The writer tags infinities; a plain number that overflows to Infinity (1e999) is not ours.
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw corrupt("rowValue");
    return value;
  }
  if (typeof value !== "object" || Array.isArray(value)) throw corrupt("rowValue");
  const entries = Object.entries(value);
  if (entries.length !== 1) throw corrupt("rowValue");
  const [tag, text] = entries[0];
  if (typeof text !== "string") throw corrupt("rowValue");
  if (tag === "$int") {
    if (!INT.test(text) || !fitsInt64(text)) throw corrupt("rowValue");
    if (affinity !== "INTEGER" && affinity !== "NUMERIC") throw corrupt("rowAffinity");
    return text;
  }
  if (tag === "$real") {
    if (!REAL.test(text)) throw corrupt("rowValue");
    return text.startsWith("-") ? -Infinity : Infinity;
  }
  if (tag === "$hex") {
    if (!HEX.test(text)) throw corrupt("rowValue");
    return hexBytes(text);
  }
  throw corrupt("rowValue");
}

/**
 * A decoder for the lines of one table. `columns` are the manifest columns (every line must have exactly these
 * keys); `affinities[i]` is the scratch affinity of `columns[i]`, or null for a column the reader drops (a future
 * vault-owned column this reader does not own). Returns the values of the kept columns, in order.
 */
export function rowDecoder(
  columns: readonly string[],
  affinities: readonly (Affinity | null)[]
): (line: string) => SQLiteBindValue[] {
  if (affinities.length !== columns.length) throw new Error("rowDecoder: one affinity per column");
  return (line) => {
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch (e) {
      throw corrupt("rowJson", e);
    }
    if (row === null || typeof row !== "object" || Array.isArray(row)) throw corrupt("rowJson");
    const record = row as Record<string, unknown>;
    if (Object.keys(record).length !== columns.length) throw corrupt("rowKeys");
    const values: SQLiteBindValue[] = [];
    for (let i = 0; i < columns.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(record, columns[i])) throw corrupt("rowKeys");
      const kept = affinities[i];
      if (kept !== null) values.push(decodeValue(record[columns[i]], kept));
    }
    return values;
  };
}

/** The NDJSON line cap: a line longer than this (in UTF-16 units, never more than its UTF-8 bytes) is corrupt. */
export const MAX_LINE = 8 * 1024 * 1024;

/**
 * Calls `onLine` for every line of `file` and returns the line count. Reads 256 KiB at a time through one streaming
 * UTF-8 decoder (invalid UTF-8 is corrupt), fails `corrupt` as soon as a line grows beyond `maxLine` without a
 * newline, and when the file does not end with one. Yields to the event loop after each read.
 */
export async function readLines(
  file: File,
  options: { maxLine: number; chunkBytes?: number; signal?: AbortSignal },
  onLine: (line: string) => void
): Promise<number> {
  const chunk = options.chunkBytes ?? 256 * 1024;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const decode = (bytes?: Uint8Array) => {
    try {
      return bytes ? decoder.decode(bytes, { stream: true }) : decoder.decode();
    } catch (e) {
      throw corrupt("utf8", e);
    }
  };
  const handle = file.open(FileMode.ReadOnly);
  let pending = "";
  let count = 0;
  try {
    const size = handle.size ?? 0;
    for (let done = 0; done < size;) {
      checkAborted(options.signal);
      const bytes = handle.readBytes(Math.min(chunk, size - done));
      if (!bytes.length) break;
      done += bytes.length;
      const text = decode(bytes);
      let start = 0;
      for (let end = text.indexOf("\n"); end >= 0; end = text.indexOf("\n", start)) {
        const line = pending + text.slice(start, end);
        pending = "";
        if (line.length > options.maxLine) throw corrupt("lineLength");
        onLine(line);
        count++;
        start = end + 1;
      }
      pending += text.slice(start);
      if (pending.length > options.maxLine) throw corrupt("lineLength");
      await tick();
    }
    pending += decode();
    if (pending.length) throw corrupt("lineEnd");
  } finally {
    handle.close();
  }
  return count;
}
