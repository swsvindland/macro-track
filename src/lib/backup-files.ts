import { Directory, File, Paths } from "expo-file-system";
import * as DocumentPicker from "expo-document-picker";
import * as Sharing from "expo-sharing";
import { getRandomBytesAsync } from "expo-crypto";
import { eq } from "drizzle-orm";
import { db, preferences } from "@/db";
import {
  createBackup,
  parseBackup,
  restoreBackup,
  validateBackup,
  type Backup,
} from "./backup-data";
import { decryptBackupText, encryptBackupText, MAX_ENCRYPTED_SIZE } from "./backup-crypto";
import { withHealthPaused } from "./health";
import { configureHealthSchedule } from "./health-schedule";

const recoveryKey = "recoveryBackupUri";
const directory = () => new Directory(Paths.document, "MacroTrackBackups");
export function recoveryBackupUri() {
  return db.select().from(preferences).where(eq(preferences.key, recoveryKey)).get()?.value ?? null;
}
export async function shareBackupFile(uri: string) {
  if (!(await Sharing.isAvailableAsync()))
    throw new Error("File sharing is unavailable on this device.");
  await Sharing.shareAsync(uri, {
    mimeType: "application/json",
    UTI: "public.json",
    dialogTitle: "Save encrypted Pendum Macros backup",
  });
}
export async function exportBackup(password: string) {
  const encrypted = await encryptBackupText(
    JSON.stringify(createBackup()),
    password,
    getRandomBytesAsync
  );
  const file = new File(Paths.cache, `macro-track-${Date.now()}.backup.json`);
  file.write(encrypted);
  // A receiving app may still be reading after the Android chooser closes.
  // Leave the encrypted file in OS-managed cache rather than revoke it early.
  await shareBackupFile(file.uri);
}
export async function importBackup(password: string): Promise<Backup | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: ["application/json", "application/octet-stream"],
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled) return null;
  const file = new File(result.assets[0].uri);
  try {
    if (file.size > MAX_ENCRYPTED_SIZE) throw new Error("This backup is too large.");
    return parseBackup(await decryptBackupText(await file.text(), password));
  } finally {
    if (file.uri.startsWith(`${Paths.cache.uri.replace(/\/$/, "")}/`) && file.exists) file.delete();
  }
}
export async function restoreWithRecovery(backup: Backup, password: string) {
  const validated = validateBackup(backup);
  await withHealthPaused(async () => {
    const encrypted = await encryptBackupText(
      JSON.stringify(createBackup()),
      password,
      getRandomBytesAsync
    );
    const folder = directory();
    folder.create({ idempotent: true, intermediates: true });
    const recovery = new File(folder, `before-restore-${Date.now()}.backup.json`);
    recovery.write(encrypted);
    try {
      // Read back and authenticate the recovery copy before replacing anything.
      parseBackup(await decryptBackupText(await recovery.text(), password));
      restoreBackup(validated, recovery.uri);
    } catch (error) {
      if (recovery.exists) recovery.delete();
      throw error;
    }
    // The persisted opt-out is authoritative even if background unregistration fails.
    await configureHealthSchedule().catch(() => {});
  });
}
