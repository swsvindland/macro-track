// The commit section of a restore (docs/vault.md, "Restore"; spec §3.7): ONE synchronous block on the live connection,
// with nothing awaited, so no app write on the same connection can fall between its steps — write the crash journal,
// copy the live database into the recovery set (VACUUM INTO), move the media, then one transaction that replaces the
// rows from the attached scratch database and writes every vault state change of the restore. A commit by another
// connection (water's other connections) after the marks were read changes `PRAGMA data_version`, which the
// transaction checks once it holds the write lock: the whole block is undone and repeated, up to 3 times, then `busy`.
// Foreign keys are switched off around the transaction (lift's connection runs with them on: deleting `workouts` must
// not cascade) and `synchronous = FULL` makes this commit durable; both settings are restored whatever happens.
import type { SQLiteDatabase } from "expo-sqlite";

import { toVaultError, VaultError } from "../errors";
import type { VaultSql } from "../types";

import { boundedSequence, MAX_SEQUENCE, q, tableExists } from "./db";
import { libraryEmpty } from "./device";
import { journalClearSync, journalWriteSync, type RestoreJournal } from "./journal";
import { applyMediaSync, rollbackMediaSync, type MediaMoves } from "./media";
import { newRecoverySync, removeRecoveryPartialSync } from "./recovery";
import { CLOCK_TABLE } from "./snapshot";
import { setStateSync } from "./state";

/** One table the swap replaces (spec §2.10 rule 6), with explicit column lists (never `SELECT *`). */
export type SwapTable =
  | {
      mode: "replace";
      name: string;
      /** (main ∩ incoming) − device columns, in the live table's order. */
      columns: string[];
      /** Legacy only: SQL condition limiting the replace (macro: `local_kind = 'weight'`). */
      scope?: string;
      autoincrement: boolean;
      /** The archive's sqlite_sequence value (manifest); legacy: null → the scratch's own. */
      sequence: number | null;
    }
  | { mode: "keys"; name: string; keyColumn: string; valueColumn: string; keys: string[] }
  | { mode: "singleton"; name: string; idColumn: string; where: string; columns: string[] };

export interface SwapPlan {
  /** Replaced tables, descriptor order (parents first). */
  tables: SwapTable[];
  /** Provenance merge and descriptor swap hooks, around the delete and insert steps. */
  before: VaultSql[];
  after: VaultSql[];
  /** deviceOverrides (or the legacy adapter's) and the installation rule. */
  overrides: VaultSql[];
  /** Every _vault_state write of this restore (a string is stored as is; a VaultSql's value is queried). */
  state: Record<string, string | VaultSql>;
  /** The restore's operation id (journal, staged media, `restore.lastOp`). */
  opId: string;
  media: MediaMoves;
  /** Tables a v2 restore keeps as on device: a foreign-key failure involving one is `unknownSchema`. */
  kept: readonly string[];
  /** The journal of every attempt, without the recovery id and the media moves the attempt fills in. */
  journal: Omit<RestoreJournal, "recoveryId" | "plan">;
}

type Marks = { dataVersion: number; changes: number };

/** Another connection committed after the marks were read: the commit section is undone and repeated. */
class Retry extends Error {}

const ATTEMPTS = 3;

// ---------------------------------------------------------------------------------------------------------------
// Test seam (G7 and the on-device self-test): a simulated process death at a named point of a restore. It leaves
// everything as a killed process would — no rollback, no journal cleared, no cleanup — for recoverJournal to handle.

export type CrashPoint = "afterMedia" | "afterCommit";

export class SimulatedCrash extends Error {
  constructor(readonly point: CrashPoint) {
    super(`vault: simulated crash ${point}`);
    this.name = "SimulatedCrash";
  }
}

let armed: CrashPoint | null = null;

/** Arms one simulated crash (null disarms). */
export function simulateCrash(point: CrashPoint | null): void {
  armed = point;
}

/** Throws the armed SimulatedCrash at `point` (once). */
export function crashPoint(point: CrashPoint): void {
  if (armed !== point) return;
  armed = null;
  throw new SimulatedCrash(point);
}

// ---------------------------------------------------------------------------------------------------------------

/** `PRAGMA data_version` (moves when another connection commits) and this connection's total_changes(). */
export function readMarks(db: SQLiteDatabase): Marks {
  return {
    dataVersion:
      db.getFirstSync<{ data_version: number }>("PRAGMA data_version")?.data_version ?? 0,
    changes: db.getFirstSync<{ c: number }>("SELECT total_changes() AS c")?.c ?? 0,
  };
}

/**
 * A failure before the commit as the restore reports it: a VaultError as thrown, a SQLite constraint as the data's
 * fault (`invalidData`), an app statement still stepping on the shared connection as `busy`, anything else as
 * `restoreFailed` (an AbortError as `cancelled`).
 */
export function restoreError(e: unknown): VaultError {
  if (e instanceof VaultError) return e;
  const detail = e instanceof Error ? e.message : String(e);
  if (/statements in progress/i.test(detail))
    return new VaultError("busy", { detail: "statement", cause: e });
  // water: another connection held the write lock for longer than busy_timeout.
  if (/database (table )?is locked/i.test(detail))
    return new VaultError("busy", { detail: "locked", cause: e });
  if (/constraint/i.test(detail)) return new VaultError("invalidData", { detail, cause: e });
  return toVaultError(e, "restoreFailed");
}

/**
 * Runs the commit section (spec §3.5.3 step 8) and returns the recovery set's id, or null when the live library was
 * empty (no recovery set; one is still made when an add displaces a same-name file, so nothing is ever lost). Before
 * the COMMIT any error undoes the media moves, deletes the partial set and clears the journal, so nothing changed.
 * `scratchPath` is the closed scratch database (ATTACHed as `incoming`).
 */
export function commitRestore(
  live: SQLiteDatabase,
  scratchPath: string,
  plan: SwapPlan
): string | null {
  if (live.isInTransactionSync()) throw new VaultError("busy", { detail: "transaction" });
  for (let attempt = 1; ; attempt++) {
    // Re-evaluated on every attempt: another connection may have written into a library that was empty.
    const recovery =
      libraryEmpty(live) && plan.media.remove.length === 0 ? null : newRecoverySync();
    const recoveryId = recovery?.id ?? null;
    // The files this attempt's ADDs put in place: only those are moved back to the stage.
    const placed = new Set<string>();
    try {
      journalWriteSync({ ...plan.journal, recoveryId, plan: plan.media });
      // Read before the copy: a commit by another connection after this point is either in the copy or detected.
      const marks = readMarks(live);
      if (recovery) live.runSync("VACUUM INTO ?", [recovery.snapshotPath]);
      applyMediaSync(plan.opId, plan.media, recoveryId, placed);
      crashPoint("afterMedia");
      swapIntoLive(live, scratchPath, plan, recoveryId, marks);
      return recoveryId;
    } catch (e) {
      if (e instanceof SimulatedCrash) throw e;
      let undone = true;
      try {
        rollbackMediaSync(plan.opId, plan.media, recoveryId, placed);
        if (recoveryId) removeRecoveryPartialSync(recoveryId);
        journalClearSync();
      } catch (rollback) {
        // The journal stays (and, with it, the staged copies: restoreArchive keeps them while the journal names the
        // restore): recoverJournal finishes the rollback at the next start. The error reported is the original one.
        undone = false;
        console.warn("[vault]", "rollback", rollback);
      }
      if (e instanceof Retry && undone && attempt < ATTEMPTS) continue;
      throw e instanceof Retry ? new VaultError("busy", { detail: "writer" }) : restoreError(e);
    }
  }
}

/**
 * The swap transaction (spec §3.7). foreign_keys goes off before BEGIN (inside a transaction the pragma does
 * nothing) and comes back in the outer `finally`, also when ATTACH throws, so lift never stays without foreign keys.
 * Children are deleted before parents and inserted after them; `PRAGMA main.foreign_key_check` proves the result.
 */
export function swapIntoLive(
  live: SQLiteDatabase,
  scratchPath: string,
  plan: SwapPlan,
  recoveryId: string | null,
  marks: Marks
): void {
  const fk = live.getFirstSync<{ foreign_keys: number }>("PRAGMA foreign_keys")?.foreign_keys ?? 0;
  const sync = live.getFirstSync<{ synchronous: number }>("PRAGMA synchronous")?.synchronous ?? 2;
  let attached = false;
  try {
    live.execSync("PRAGMA foreign_keys = OFF");
    // WAL + synchronous NORMAL (lift, macro) syncs only at checkpoints: this commit must reach the disk.
    live.execSync("PRAGMA synchronous = FULL");
    live.runSync("ATTACH DATABASE ? AS incoming", [scratchPath]);
    attached = true;
    live.execSync("BEGIN IMMEDIATE");
    try {
      const now = readMarks(live);
      if (now.dataVersion !== marks.dataVersion || now.changes !== marks.changes) throw new Retry();
      const clock = tableExists(live, CLOCK_TABLE);
      // M3: the triggers stay quiet during the swap; the counters move once, below.
      if (clock) live.execSync('UPDATE main."_vault_clock" SET "paused" = 1 WHERE "id" = 1');
      for (const s of plan.before) live.runSync(s.sql, s.params ?? []);
      for (const t of [...plan.tables].reverse()) deleteStep(live, t);
      for (const t of plan.tables) insertStep(live, t);
      for (const t of plan.tables)
        if (t.mode === "replace" && t.autoincrement) raiseSequence(live, t.name, t.sequence);
      for (const s of plan.after) live.runSync(s.sql, s.params ?? []);
      for (const s of plan.overrides) live.runSync(s.sql, s.params ?? []);
      if (clock)
        live.execSync(
          'UPDATE main."_vault_clock" SET "gen" = "gen" + 1, "seq" = "seq" + 1, "paused" = 0, "source" = NULL WHERE "id" = 1'
        );
      // After the counter bump: lineage.ownBase reads the bumped seq.
      for (const [key, value] of Object.entries(plan.state)) setStateSync(live, key, value);
      if (recoveryId) setStateSync(live, "recovery.latest", recoveryId);
      live.execSync(
        "DROP TABLE IF EXISTS temp._vault_live_links; DROP TABLE IF EXISTS temp._vault_carry"
      );
      const orphans = live.getAllSync<{ table: string; parent: string }>(
        "PRAGMA main.foreign_key_check"
      );
      if (orphans.length) {
        const kept = orphans.find(
          (o) => plan.kept.includes(o.table) || plan.kept.includes(o.parent)
        );
        throw new VaultError(kept ? "unknownSchema" : "invalidData", {
          detail: `fk:${(kept ?? orphans[0]).table}`,
        });
      }
      live.execSync("COMMIT");
    } catch (e) {
      try {
        if (live.isInTransactionSync()) live.execSync("ROLLBACK");
      } catch {
        // SQLite already rolled back (a full disk); the original error is the one to report
      }
      throw e;
    }
  } finally {
    // Each step on its own and never thrown: after a COMMIT nothing may undo the media moves the rows now need, and
    // a failed DETACH must not keep foreign keys off.
    const restore = [
      () => attached && live.execSync("DETACH DATABASE incoming"),
      () => live.execSync(`PRAGMA synchronous = ${Number(sync)}`),
      () => live.execSync(`PRAGMA foreign_keys = ${fk ? "ON" : "OFF"}`),
    ];
    for (const step of restore)
      try {
        step();
      } catch (e) {
        console.warn("[vault]", "swap", e);
      }
  }
}

const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(", ");

function deleteStep(live: SQLiteDatabase, t: SwapTable): void {
  if (t.mode === "replace")
    live.runSync(`DELETE FROM main.${q(t.name)}${t.scope ? ` WHERE ${t.scope}` : ""}`);
  else if (t.mode === "keys" && t.keys.length)
    live.runSync(
      `DELETE FROM main.${q(t.name)} WHERE ${q(t.keyColumn)} IN (${placeholders(t.keys.length)})`,
      t.keys
    );
}

function insertStep(live: SQLiteDatabase, t: SwapTable): void {
  if (t.mode === "replace") {
    const columns = t.columns.map(q).join(", ");
    live.runSync(
      `INSERT INTO main.${q(t.name)} (${columns}) SELECT ${columns} FROM incoming.${q(t.name)}` +
        (t.scope ? ` WHERE ${t.scope}` : "")
    );
  } else if (t.mode === "keys") {
    if (!t.keys.length) return;
    const pair = `${q(t.keyColumn)}, ${q(t.valueColumn)}`;
    live.runSync(
      `INSERT INTO main.${q(t.name)} (${pair}) SELECT ${pair} FROM incoming.${q(t.name)} ` +
        `WHERE ${q(t.keyColumn)} IN (${placeholders(t.keys.length)})`,
      t.keys
    );
  } else {
    const columns = [t.idColumn, ...t.columns].map(q).join(", ");
    // The WHERE before ON CONFLICT is what SQLite's upsert grammar needs after INSERT … SELECT.
    const update = t.columns.length
      ? `DO UPDATE SET ${t.columns.map((c) => `${q(c)} = excluded.${q(c)}`).join(", ")}`
      : "DO NOTHING";
    live.runSync(
      `INSERT INTO main.${q(t.name)} (${columns}) SELECT ${columns} FROM incoming.${q(t.name)} ` +
        `WHERE ${t.where} ON CONFLICT(${q(t.idColumn)}) ${update}`
    );
  }
}

/**
 * sqlite_sequence never decreases: max(the live high-water mark, the archive's, the largest restored id), so no new
 * row ever reuses an id a Health link of either device still names — also when a forward migration rebuilt the table
 * in the scratch (a rebuild resets its sequence to max(id), so the archive's value comes from the manifest). It never
 * exceeds MAX_SEQUENCE either: a mark near 2^63 stops every insert into the table, and as no later restore lowers a
 * mark, one that got there would be for good. A mark already above it (never the app's) comes back to MAX_SEQUENCE.
 */
function raiseSequence(live: SQLiteDatabase, table: string, sequence: number | null): void {
  const archived =
    sequence === null
      ? 'ifnull((SELECT "seq" FROM incoming.sqlite_sequence WHERE "name" = ?), 0)'
      : "?";
  const params = sequence === null ? [table] : [boundedSequence(sequence)];
  const high = `max(${archived}, ifnull((SELECT max(rowid) FROM main.${q(table)}), 0))`;
  const { changes } = live.runSync(
    `UPDATE main.sqlite_sequence SET "seq" = min(max(ifnull("seq", 0), ${high}), ${MAX_SEQUENCE}) WHERE "name" = ?`,
    [...params, table]
  );
  if (!changes)
    live.runSync(
      `INSERT INTO main.sqlite_sequence ("name", "seq") VALUES (?, min(${high}, ${MAX_SEQUENCE}))`,
      [table, ...params]
    );
}
