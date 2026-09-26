import { Directory, File, Paths } from "expo-file-system";
import type { SQLiteDatabase } from "expo-sqlite";

type Database = Pick<SQLiteDatabase, "getFirstSync" | "runSync">;
type Journal = { entries: { when: number }[] };

const keep = 2;
const margin = 16 * 1024 * 1024;
const snapshotName = /^pre-migration-(\d+)\.db$/;
export const snapshotFolder = () => new Directory(Paths.document, "MacroTrackBackups");

/** Mirrors Drizzle's rule: a journal entry is pending when it is newer than the last applied row. */
export function migrationState(database: Database, journal: Journal) {
  const table = database.getFirstSync(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'"
  );
  if (!table) return null;
  const last = database.getFirstSync<{ created_at: number }>(
    "SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1"
  );
  // A fresh install has nothing worth copying.
  if (!last) return null;
  const applied = journal.entries.filter((entry) => entry.when <= Number(last.created_at)).length;
  return { applied, pending: journal.entries.length - applied };
}

/** Free space a copy needs while still leaving a migration room for its journal and growth. */
export function snapshotSpace(database: Database) {
  const { size, used } = database.getFirstSync<{ size: number; used: number }>(
    "SELECT page_count * page_size AS size, (page_count - freelist_count) * page_size AS used FROM pragma_page_count(), pragma_page_size(), pragma_freelist_count()"
  )!;
  return used + size + margin;
}

/** Writes a consistent copy named after its schema version, keeping the newest two. */
export function snapshotDatabase(database: Database, version: number, folder = snapshotFolder()) {
  folder.create({ idempotent: true, intermediates: true });
  const partial = new File(folder, "pre-migration.partial");
  const leftovers = [partial, new File(folder, "pre-migration.partial-journal")];
  const clean = () => leftovers.forEach((file) => file.exists && file.delete());
  // An interrupted copy must not keep holding the space checked below.
  clean();
  if (Paths.availableDiskSpace < snapshotSpace(database))
    throw new Error("Not enough free storage to copy the database.");
  const snapshot = new File(folder, `pre-migration-${version}.db`);
  try {
    database.runSync("VACUUM INTO ?", decodeURIComponent(partial.uri.replace(/^file:\/\//, "")));
    partial.moveSync(snapshot, { overwrite: true });
  } catch (error) {
    clean();
    throw error;
  }
  folder
    .list()
    .flatMap((file) => {
      const match = file instanceof File && snapshotName.exec(file.name);
      return match ? [{ file, version: Number(match[1]) }] : [];
    })
    .sort((a, b) => b.version - a.version)
    .slice(keep)
    .forEach(({ file }) => file.delete());
  return snapshot;
}

export function snapshotBeforeMigrations(database: Database, journal: Journal, folder?: Directory) {
  try {
    const state = migrationState(database, journal);
    return state?.pending ? snapshotDatabase(database, state.applied, folder) : null;
  } catch (error) {
    // The copy is a safety net; low storage must not stop the migration itself.
    console.warn("Could not copy the database before migrating", error);
    return null;
  }
}
