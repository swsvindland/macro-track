// Stable row ids (docs/vault.md, "`sync_id` ownership"; spec §9.4): every integer-keyed table of the descriptor's
// `syncIdTables` carries a `sync_id` TEXT column holding a random version 4 UUID, so rows that move between devices
// through archives keep one identity that a later merge sync can match. The vault owns the column at runtime and
// Drizzle never maps it: app code that copies rows (repeating a workout, copying a food day) can never copy an id
// into a new row. Everything here is additive and idempotent — ADD COLUMN, a backfill, a unique index and a fill
// trigger, each only when missing — so it never rebuilds a table (lift's foreign_keys = ON connection would cascade a
// rebuilt parent's children away) and it heals a column a historical rebuild dropped.
import { vaultApp } from "../app";

import { columnNames, q, tableExists, type SqlHandle } from "./db";

/** The column every syncIdTables table carries. */
export const SYNC_ID = "sync_id";

/**
 * Columns the vault adds at runtime (spec §2.10): exported like any other column and listed in the manifest's
 * `vaultColumns`; a reader adds the ones it owns to its scratch tables before inserting archived rows.
 */
export const VAULT_OWNED_COLUMNS: readonly string[] = [SYNC_ID];

/** A random RFC 4122 version 4 UUID in SQL: 8-4-4-4-12 lowercase hex, version nibble 4, variant 8, 9, a or b. */
const UUID_V4 =
  "lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || " +
  "substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (random() & 3), 1) || " +
  "substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))";

export const syncIdIndex = (table: string) => `_vault_sid_${table}`;
export const syncIdTrigger = (table: string) => `_vault_sid_${table}_i`;

/**
 * Runs `work` in one write transaction (BEGIN IMMEDIATE … COMMIT) on a connection that is not in one already;
 * rolls back and rethrows on any error. Synchronous, so no app write on a shared connection can interleave.
 */
export function transactionSync(db: SqlHandle, work: () => void): void {
  db.execSync("BEGIN IMMEDIATE");
  try {
    work();
    db.execSync("COMMIT");
  } catch (e) {
    try {
      db.execSync("ROLLBACK");
    } catch {
      // SQLite already rolled back; the original error is the one to report
    }
    throw e;
  }
}

export interface SyncIdOptions {
  /** Default: the descriptor's syncIdTables. Tables that do not exist (yet, at an older schema level) are skipped. */
  tables?: readonly string[];
  /** Give rows without an id a fresh one, then create the unique index. Default true. */
  backfill?: boolean;
  /** Create the fill trigger that gives every inserted row an id (live database only). Default: as `backfill`. */
  triggers?: boolean;
}

export interface SyncIdResult {
  /** Tables that gained the column. */
  added: string[];
  /** Rows that got a fresh id. */
  filled: number;
}

const exists = (db: SqlHandle, type: "index" | "trigger", name: string) =>
  db.getFirstSync("SELECT 1 AS v FROM sqlite_master WHERE type = ? AND name = ?", [type, name]) !=
  null;

/**
 * Makes sure each table has its `sync_id` column and, with `backfill`, an id on every row and the unique index
 * `_vault_sid_<t>`, and with `triggers` the fill trigger `_vault_sid_<t>_i`. Every step that is already done is
 * skipped; when nothing is missing no transaction is opened. Uses:
 *   live (ensureReady, every start)          ensureSyncIds(db)
 *   scratch, before archived rows go in      { tables: manifest tables with a vault-owned column, backfill: false }
 *   scratch, after the forward migration     { tables: syncIdTables, backfill: true, triggers: false }
 * Updating `sync_id` changes no key column, so foreign keys (on or off) never touch a child row.
 */
export function ensureSyncIds(db: SqlHandle, options: SyncIdOptions = {}): SyncIdResult {
  const backfill = options.backfill ?? true;
  const triggers = options.triggers ?? backfill;
  const tables = (options.tables ?? vaultApp.syncIdTables ?? []).filter((t) => tableExists(db, t));
  const missing = (t: string) =>
    !columnNames(db, t).includes(SYNC_ID) ||
    (backfill &&
      (!exists(db, "index", syncIdIndex(t)) ||
        db.getFirstSync(`SELECT 1 AS v FROM ${q(t)} WHERE ${q(SYNC_ID)} IS NULL LIMIT 1`) !=
          null)) ||
    (triggers && !exists(db, "trigger", syncIdTrigger(t)));
  const result: SyncIdResult = { added: [], filled: 0 };
  if (!tables.some(missing)) return result;
  transactionSync(db, () => {
    for (const t of tables) {
      const table = q(t);
      const column = q(SYNC_ID);
      if (!columnNames(db, t).includes(SYNC_ID)) {
        db.execSync(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
        result.added.push(t);
      }
      if (backfill) {
        result.filled += db.runSync(
          `UPDATE ${table} SET ${column} = ${UUID_V4} WHERE ${column} IS NULL`
        ).changes;
        db.execSync(
          `CREATE UNIQUE INDEX IF NOT EXISTS ${q(syncIdIndex(t))} ON ${table} (${column})`
        );
      }
      if (triggers)
        db.execSync(
          `CREATE TRIGGER IF NOT EXISTS ${q(syncIdTrigger(t))} AFTER INSERT ON ${table} ` +
            `WHEN NEW.${column} IS NULL BEGIN ` +
            `UPDATE ${table} SET ${column} = ${UUID_V4} WHERE rowid = NEW.rowid; END`
        );
    }
  });
  return result;
}
