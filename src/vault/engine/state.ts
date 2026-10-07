// The vault's key-value state in the app's own database (docs/vault.md, "What the vault keeps in the database"):
// device and library ids, the recovery pointer, the crash marker, lineage and (M2) cloud status. Runtime-owned and
// never exported. Writes are single statements, so a caller can put several of them in its own synchronous
// transaction (the restore swap writes all of its state that way). An in-memory mirror and a listener set let UI
// code re-render with useSyncExternalStore; it changes only through refreshVaultState(), after a write committed.
import type { SqlReader, VaultSql } from "../types";

import { tableExists, type SqlHandle } from "./db";

export const STATE_TABLE = "_vault_state";

const CREATE =
  'CREATE TABLE IF NOT EXISTS "_vault_state" ("key" TEXT PRIMARY KEY NOT NULL, "value" TEXT NOT NULL) WITHOUT ROWID';
const ON_CONFLICT = 'ON CONFLICT("key") DO UPDATE SET "value" = excluded."value"';

/** Creates the state table when missing (idempotent; also safe inside a transaction). */
export function ensureStateTable(db: SqlHandle): void {
  db.execSync(CREATE);
}

/** One value, or null when the key (or the whole table) is absent. Works on live, snapshot and scratch connections. */
export function readState(db: SqlReader, key: string): string | null {
  if (!tableExists(db, STATE_TABLE)) return null;
  return (
    db.getFirstSync<{ value: string }>('SELECT "value" FROM "_vault_state" WHERE "key" = ?', [key])
      ?.value ?? null
  );
}

/** Every key starting with `prefix` (all keys for ""), as a plain object. */
export function readStates(db: SqlReader, prefix = ""): Record<string, string> {
  if (!tableExists(db, STATE_TABLE)) return {};
  const rows = db.getAllSync<{ key: string; value: string }>(
    'SELECT "key", "value" FROM "_vault_state" WHERE substr("key", 1, length(?)) = ? ORDER BY "key"',
    [prefix, prefix]
  );
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/**
 * Sets one key. A string is stored as given; a VaultSql is a query whose single value is stored (evaluated by the
 * same statement, e.g. `lineage.ownBase` = the clock's seq after the swap's bump). Runs no transaction of its own.
 */
export function setStateSync(db: SqlHandle, key: string, value: string | VaultSql): void {
  ensureStateTable(db);
  if (typeof value === "string")
    db.runSync(`INSERT INTO "_vault_state" ("key", "value") VALUES (?, ?) ${ON_CONFLICT}`, [
      key,
      value,
    ]);
  else
    db.runSync(
      `INSERT INTO "_vault_state" ("key", "value") VALUES (?, (${value.sql})) ${ON_CONFLICT}`,
      [key, ...(value.params ?? [])]
    );
}

/** Removes one key (no-op when absent). */
export function deleteStateSync(db: SqlHandle, key: string): void {
  if (tableExists(db, STATE_TABLE)) db.runSync('DELETE FROM "_vault_state" WHERE "key" = ?', [key]);
}

/** Removes every key starting with `prefix` (e.g. "cloud.icloud."). */
export function deleteStatePrefixSync(db: SqlHandle, prefix: string): void {
  if (!prefix) throw new Error("deleteStatePrefixSync needs a prefix");
  if (tableExists(db, STATE_TABLE))
    db.runSync('DELETE FROM "_vault_state" WHERE substr("key", 1, length(?)) = ?', [
      prefix,
      prefix,
    ]);
}

/**
 * Sets (string) and removes (null) several keys in one transaction of its own, then refreshes the mirror. For
 * writes outside a restore swap; never call it while the connection is already in a transaction.
 */
export function updateState(db: SqlHandle, values: Record<string, string | null>): void {
  ensureStateTable(db);
  // Outside the try: when BEGIN itself fails (a caller's transaction is open), there is nothing of ours to roll back.
  db.execSync("BEGIN IMMEDIATE");
  try {
    for (const [key, value] of Object.entries(values))
      if (value === null) deleteStateSync(db, key);
      else setStateSync(db, key, value);
    db.execSync("COMMIT");
  } catch (e) {
    try {
      db.execSync("ROLLBACK");
    } catch {
      // SQLite already rolled back (a full disk, for instance); the original error is the one to report
    }
    throw e;
  }
  refreshVaultState(db);
}

// ---------------------------------------------------------------------------------------------------------------
// In-memory mirror for UI code (useSyncExternalStore: the snapshot object changes only when a value changed)

let mirror: Readonly<Record<string, string>> = Object.freeze({});
const listeners = new Set<() => void>();

/** The last values refreshVaultState() read (the same object until something changed). */
export function vaultState(): Readonly<Record<string, string>> {
  return mirror;
}

/** Calls `listener` after the mirror changed; returns the unsubscriber. */
export function subscribeVaultState(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Re-reads every key from `db` into the mirror; listeners run only when a value was added, changed or removed. */
export function refreshVaultState(db: SqlReader): void {
  const next = readStates(db);
  const keys = Object.keys(next);
  if (keys.length === Object.keys(mirror).length && keys.every((k) => mirror[k] === next[k]))
    return;
  mirror = Object.freeze(next);
  for (const listener of [...listeners]) listener();
}
