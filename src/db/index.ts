import { drizzle } from "drizzle-orm/expo-sqlite";
import { openDatabaseSync } from "expo-sqlite";
import journal from "../../drizzle/meta/_journal.json";
import * as schema from "./schema";
import { snapshotBeforeMigrations } from "./snapshot";

export const DATABASE_NAME = "macro_track.db";

export const expoDb = openDatabaseSync(DATABASE_NAME, {
  enableChangeListener: true,
});

// Taken at import, before useMigrations runs, so a bad migration can't strand the diary.
export const migrationSnapshot = snapshotBeforeMigrations(expoDb, journal);

export const db = drizzle(expoDb, { schema });

export * from "./schema";
