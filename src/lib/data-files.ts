import { Directory, File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import journal from "../../drizzle/meta/_journal.json";
import { expoDb, migrationSnapshot } from "@/db";
import { migrationState, snapshotDatabase } from "@/db/snapshot";
import {
  erasePersonalRecords,
  exportDiaryCsv,
  exportTargetsCsv,
  exportWeightCsv,
} from "./data-ownership";
import { withHealthPaused } from "./health";
import { configureHealthSchedule } from "./health-schedule";

export async function shareCsv(kind: "diary" | "weight" | "targets") {
  if (!(await Sharing.isAvailableAsync()))
    throw new Error("File sharing is unavailable on this device.");
  const file = new File(Paths.cache, `macro-track-${kind}-${Date.now()}.csv`);
  file.write(
    kind === "diary" ? exportDiaryCsv() : kind === "weight" ? exportWeightCsv() : exportTargetsCsv()
  );
  await Sharing.shareAsync(file.uri, {
    mimeType: "text/csv",
    UTI: "public.comma-separated-values-text",
    dialogTitle: "Export Macro Track data",
  });
}
export async function shareDatabaseCopy() {
  if (!(await Sharing.isAvailableAsync()))
    throw new Error("File sharing is unavailable on this device.");
  // A failed migration rolls back, so a fresh copy is as good as the startup one.
  const file = migrationSnapshot?.exists
    ? migrationSnapshot
    : snapshotDatabase(expoDb, migrationState(expoDb, journal)?.applied ?? 0);
  await Sharing.shareAsync(file.uri, {
    mimeType: "application/vnd.sqlite3",
    UTI: "public.database",
    dialogTitle: "Save Macro Track database copy",
  });
}
export async function eraseLocalData() {
  await withHealthPaused(async () => {
    // Delete only app-owned personal files, including pre-migration copies. Catalogs remain installed.
    for (const name of ["MacroTrackBackups", "progress-photos"]) {
      const folder = new Directory(Paths.document, name);
      if (folder.exists) folder.delete();
    }
    for (const file of Paths.cache.list())
      if (file instanceof File && /^macro-track-.*\.(csv|backup\.json)$/.test(file.name))
        file.delete();
    erasePersonalRecords();
    await configureHealthSchedule().catch(() => {});
  });
}
