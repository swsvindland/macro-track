import { Directory, File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { erasePersonalRecords, exportDiaryCsv, exportWeightCsv } from "./data-ownership";
import { withHealthPaused } from "./health";
import { configureHealthSchedule } from "./health-schedule";

export async function shareCsv(kind: "diary" | "weight") {
  if (!(await Sharing.isAvailableAsync()))
    throw new Error("File sharing is unavailable on this device.");
  const file = new File(Paths.cache, `macro-track-${kind}-${Date.now()}.csv`);
  file.write(kind === "diary" ? exportDiaryCsv() : exportWeightCsv());
  await Sharing.shareAsync(file.uri, {
    mimeType: "text/csv",
    UTI: "public.comma-separated-values-text",
    dialogTitle: "Export Macro Track data",
  });
}
export async function eraseLocalData() {
  await withHealthPaused(async () => {
    // Delete only app-owned personal files. Catalogs remain installed.
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
