// SQL helpers every engine module and every descriptor shares (docs/vault.md, "The descriptor contract"): identifier
// quoting, the schema level of a database, table introspection and the validator helpers descriptors use. A leaf: it
// imports only types, so src/vault-app.ts can import it statically and it never reaches app code (vault-kit check).
import type { SQLiteBindValue, SQLiteRunResult } from "expo-sqlite";

import type { Journal, SqlReader } from "../types";

/**
 * A connection the engine writes on (live, snapshot, scratch). An expo-sqlite SQLiteDatabase satisfies it; the
 * overloads mirror expo-sqlite's own (with and without bound parameters).
 */
export interface SqlHandle extends SqlReader {
  execSync(source: string): void;
  runSync(source: string, params: SQLiteBindValue[]): SQLiteRunResult;
  runSync(source: string): SQLiteRunResult;
}

/** An identifier as SQL: double-quoted, inner quotes doubled. Names come from the descriptor, never from an archive. */
export function q(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** A text value as an SQL string literal (single-quoted, inner quotes doubled). */
export function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

// ---------------------------------------------------------------------------------------------------------------
// Schema level (mirrors lift's migrationState() and Drizzle's own rule)

export interface SchemaState {
  /** Journal entries applied to this database. */
  applied: number;
  /** Journal entries still to apply. */
  pending: number;
  /** MAX(__drizzle_migrations.created_at), 0 when nothing was applied. */
  lastCreatedAt: number;
  /** Tag of the last applied entry, "" when nothing was applied. */
  lastTag: string;
}

/**
 * How far `journal` is applied to `db`. Drizzle records each migration's journal `when` as `created_at` (its `id`
 * is always NULL), so the level is the number of entries whose `when` is at most the newest `created_at`.
 */
export function schemaState(db: SqlReader, journal: Journal): SchemaState {
  const table = db.getFirstSync(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'"
  );
  const last = table
    ? db.getFirstSync<{ c: number | string | null }>(
        "SELECT MAX(created_at) AS c FROM __drizzle_migrations"
      )?.c
    : null;
  const lastCreatedAt = last == null ? 0 : Number(last);
  const applied = journal.entries.filter((e) => e.when <= lastCreatedAt).length;
  return {
    applied,
    pending: journal.entries.length - applied,
    lastCreatedAt,
    lastTag: applied ? journal.entries[applied - 1].tag : "",
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Introspection

export interface ColumnInfo {
  name: string;
  /** Declared type as written in CREATE TABLE ("" when none). */
  type: string;
  notnull: boolean;
  /** The DEFAULT expression as SQL text, or null. */
  defaultSql: string | null;
  /** 1-based position in the primary key, 0 when not part of it. */
  pk: number;
}

/** Column affinity (sqlite.org/datatype3.html §3.1), from a declared type. */
export type Affinity = "INTEGER" | "TEXT" | "BLOB" | "REAL" | "NUMERIC";

/** SQLite's affinity rules, in their order: INT, then CHAR/CLOB/TEXT, then BLOB or no type, then REAL/FLOA/DOUB. */
export function affinity(declaredType: string): Affinity {
  const type = declaredType.toUpperCase();
  if (type.includes("INT")) return "INTEGER";
  if (type.includes("CHAR") || type.includes("CLOB") || type.includes("TEXT")) return "TEXT";
  if (type.includes("BLOB") || type.trim() === "") return "BLOB";
  if (type.includes("REAL") || type.includes("FLOA") || type.includes("DOUB")) return "REAL";
  return "NUMERIC";
}

/** Whether `schema` (main, temp or an attached name) has a table `name`. */
export function tableExists(db: SqlReader, name: string, schema = "main"): boolean {
  return (
    db.getFirstSync(
      `SELECT 1 AS v FROM ${q(schema)}.sqlite_master WHERE type = 'table' AND name = ?`,
      [name]
    ) != null
  );
}

/** PRAGMA table_info of a table, in declaration order; [] when the table does not exist. */
export function tableColumns(db: SqlReader, table: string, schema = "main"): ColumnInfo[] {
  return db
    .getAllSync<{
      name: string;
      type: string | null;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>('SELECT "name", "type", "notnull", "dflt_value", "pk" FROM pragma_table_info(?, ?)', [
      table,
      schema,
    ])
    .map((c) => ({
      name: c.name,
      type: c.type ?? "",
      notnull: c.notnull === 1,
      defaultSql: c.dflt_value,
      pk: c.pk,
    }));
}

/** Column names of a table in PRAGMA table_info order; [] when the table does not exist. */
export function columnNames(db: SqlReader, table: string, schema = "main"): string[] {
  return tableColumns(db, table, schema).map((c) => c.name);
}

/** Whether a table has a rowid (not WITHOUT ROWID): row paging and the swap rely on it. */
export function isRowidTable(db: SqlReader, table: string, schema = "main"): boolean {
  return (
    db.getFirstSync<{ wr: number }>(
      'SELECT "wr" FROM pragma_table_list WHERE "schema" = ? AND "name" = ? AND "type" = \'table\'',
      [schema, table]
    )?.wr === 0
  );
}

/** Whether a table was declared with AUTOINCREMENT (its high-water mark lives in sqlite_sequence). */
export function isAutoincrement(db: SqlReader, table: string, schema = "main"): boolean {
  const row = db.getFirstSync<{ sql: string | null }>(
    `SELECT sql FROM ${q(schema)}.sqlite_master WHERE type = 'table' AND name = ?`,
    [table]
  );
  return /\bAUTOINCREMENT\b/i.test(row?.sql ?? "");
}

/**
 * The highest sqlite_sequence value the vault writes or archives: the largest integer expo-sqlite reads exactly (it
 * hands integers to JS as doubles). At a mark near 2^63 SQLite can allocate no further AUTOINCREMENT id.
 */
export const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER;

/** A high-water mark within [0, MAX_SEQUENCE] (whole; NaN → 0). */
export function boundedSequence(seq: number): number {
  return Math.min(MAX_SEQUENCE, Math.max(0, Math.trunc(seq) || 0));
}

/** sqlite_sequence.seq of a table: null when it has no row there (or no AUTOINCREMENT table exists at all). */
export function sequenceOf(db: SqlReader, table: string, schema = "main"): number | null {
  if (!tableExists(db, "sqlite_sequence", schema)) return null;
  const row = db.getFirstSync<{ seq: number | null }>(
    `SELECT seq FROM ${q(schema)}.sqlite_sequence WHERE name = ?`,
    [table]
  );
  return row?.seq ?? null;
}

// ---------------------------------------------------------------------------------------------------------------
// Validator helpers (descriptors' validate(); crash and invariant guards only, never business bounds)

/** Rows of `table` matching `condition` (an SQL expression; `params` bind its placeholders). */
export function countWhere(
  db: SqlReader,
  table: string,
  condition: string,
  params: SQLiteBindValue[] = []
): number {
  return (
    db.getFirstSync<{ v: number }>(
      `SELECT count(*) AS v FROM ${q(table)} WHERE ${condition}`,
      params
    )?.v ?? 0
  );
}

/** True for a value that is not a JSON object (invalid JSON included). */
export const jsonObject = (col: string) =>
  `(json_valid(${col}) = 0 OR json_type(${col}) <> 'object')`;

/** True for a value that is not a JSON array (invalid JSON included). */
export const jsonArray = (col: string) =>
  `(json_valid(${col}) = 0 OR json_type(${col}) <> 'array')`;

/** True for a value outside `values` (NULL is neither in nor out: guard it separately when the column allows it). */
export const notIn = (col: string, values: readonly string[]) =>
  `${col} NOT IN (${values.map((v) => `'${v.replaceAll("'", "''")}'`).join(",")})`;
