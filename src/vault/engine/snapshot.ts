// Consistent snapshot reads (docs/vault.md, "Export"): an export never reads the live database across awaits. One
// synchronous `VACUUM INTO` copies it — a consistent copy in WAL and rollback-journal mode alike — and every later
// read runs on that copy through a read-only connection of its own. On body, lift and macro the vault shares the
// app's only connection, so a transaction held across awaits would capture the app's own writes, and on body's
// rollback-journal database a second connection's read transaction would block the app's writers. `_vault_state`
// and `_vault_clock` live in the same file, so the copy also freezes the device id, library id, counters and lineage
// that describe exactly the copied rows: a write committed while the export is still hashing and zipping is neither
// in the archive nor claimed by its manifest.
import { File, Paths } from "expo-file-system";
import { openDatabaseSync, type SQLiteDatabase } from "expo-sqlite";

import { VaultError } from "../errors";
import type { ExportResult, SqlReader } from "../types";

import { tableExists } from "./db";
import { ensureDir, fsPath, removeFile } from "./paths";
import { readState } from "./state";

/** Free space a snapshot needs beyond the database's used pages: room for SQLite's own temporary files. */
const MARGIN = 16 * 1024 * 1024;
export const CLOCK_TABLE = "_vault_clock";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** SQLite refuses VACUUM while a statement of the same connection is still stepping (an open iterator). */
const inProgress = (e: unknown) => e instanceof Error && /statements in progress/i.test(e.message);

/**
 * Copies `live` into `dest` (a file in the operation's work folder; replaced when it exists) with one VACUUM INTO and
 * opens the copy read-only. Throws `busy` when the connection is inside a transaction (or still stepping a statement
 * after one retry) and `insufficientSpace` when the copy would not fit. The caller closes the snapshot and deletes it.
 */
export async function takeSnapshot(live: SQLiteDatabase, dest: File): Promise<SQLiteDatabase> {
  if (live.isInTransactionSync()) throw new VaultError("busy", { detail: "transaction" });
  const used =
    live.getFirstSync<{ used: number }>(
      "SELECT (page_count - freelist_count) * page_size AS used FROM pragma_page_count(), pragma_page_size(), pragma_freelist_count()"
    )?.used ?? 0;
  const need = used + MARGIN;
  if (Paths.availableDiskSpace < need) throw new VaultError("insufficientSpace", { bytes: need });
  ensureDir(dest.parentDirectory);
  const copy = () => {
    // VACUUM INTO refuses an existing non-empty file; an interrupted copy must not hold the space either.
    removeFile(dest);
    live.runSync("VACUUM INTO ?", [fsPath(dest)]);
  };
  try {
    try {
      copy();
    } catch (e) {
      if (!inProgress(e)) throw e;
      await tick();
      try {
        copy();
      } catch (again) {
        throw inProgress(again)
          ? new VaultError("busy", { detail: "statement", cause: again })
          : again;
      }
    }
    return openSnapshot(dest);
  } catch (e) {
    removeFile(dest);
    throw e;
  }
}

/** A read-only connection of its own on a snapshot file (an export's copy, or a restore's recovery snapshot). */
export function openSnapshot(file: File): SQLiteDatabase {
  const db = openDatabaseSync(file.name, { useNewConnection: true }, fsPath(file.parentDirectory));
  try {
    db.execSync("PRAGMA query_only = ON");
  } catch (e) {
    db.closeSync();
    throw e;
  }
  return db;
}

/** The change counters (M3, spec §9.3); 0 and 0 where the clock is not installed (M1, M2). */
export function readClock(db: SqlReader): { gen: number; seq: number } {
  if (!tableExists(db, CLOCK_TABLE)) return { gen: 0, seq: 0 };
  const row = db.getFirstSync<{ gen: number | null; seq: number | null }>(
    'SELECT "gen", "seq" FROM "_vault_clock" WHERE "id" = 1'
  );
  return { gen: Number(row?.gen ?? 0), seq: Number(row?.seq ?? 0) };
}

/** A JSON object of whole numbers from `_vault_state` (lineage.vector); anything else counts as empty. */
function vectorState(text: string | null): Record<string, number> {
  let value: unknown = null;
  try {
    value = text === null ? null : JSON.parse(text);
  } catch {
    // written only by the vault itself; an unreadable value is treated like a fresh install's
  }
  const vector: Record<string, number> = {};
  if (typeof value === "object" && value !== null && !Array.isArray(value))
    for (const [device, seq] of Object.entries(value))
      if (typeof seq === "number" && Number.isSafeInteger(seq)) vector[device] = seq;
  return vector;
}

/**
 * The version vector of the state in `db` (spec §9.5): what the last adopted or restored state contained, plus this
 * device's own changes since (its `seq` above `lineage.ownBase`). M1 and M2 have no clock, so it is that lineage alone.
 */
export function currentVector(
  db: SqlReader,
  deviceId: string,
  seq = readClock(db).seq
): Record<string, number> {
  const vector = vectorState(readState(db, "lineage.vector"));
  const ownBase = Number(readState(db, "lineage.ownBase") ?? 0);
  if (seq > ownBase) vector[deviceId] = Math.max(vector[deviceId] ?? 0, seq);
  return vector;
}

/**
 * Every identity and lineage value an archive or device manifest carries, read HERE, from the snapshot. ensureReady
 * writes the device and library ids before any export (every entry point runs it first), so a snapshot without them
 * is a wiring bug and must never produce a manifest without identity: exportFailed, detail "notReady".
 */
export function readCounters(snap: SqlReader): ExportResult["counters"] {
  const deviceId = readState(snap, "device.id");
  const libraryId = readState(snap, "library.id");
  if (!deviceId || !libraryId) throw new VaultError("exportFailed", { detail: "notReady" });
  const { gen, seq } = readClock(snap);
  return { deviceId, libraryId, gen, seq, vector: currentVector(snap, deviceId, seq) };
}
