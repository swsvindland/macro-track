import { drizzle } from "drizzle-orm/expo-sqlite";
import { openDatabaseSync } from "expo-sqlite";
import journal from "../../drizzle/meta/_journal.json";
import * as schema from "./schema";
import { snapshotBeforeMigrations } from "./snapshot";

export const DATABASE_NAME = "macro_track.db";

export const expoDb = openDatabaseSync(DATABASE_NAME, {
  enableChangeListener: true,
});
// Commits append to a write-ahead log instead of syncing the whole file, and a background
// Health sync doesn't block Home's reads. Copies go through VACUUM INTO, which includes
// the log, so nothing reads the database file directly.
expoDb.execSync("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");

// Taken at import, before useMigrations runs, so a bad migration can't strand the diary.
export const migrationSnapshot = snapshotBeforeMigrations(expoDb, journal);

export const db = drizzle(expoDb, { schema });

export * from "./schema";
