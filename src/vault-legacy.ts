// Pendum Macros' v1 backups (docs/vault.md §4.9; spec §2.11, §3.9): password-encrypted or plain JSON files from the
// Backup and restore panel the vault replaced. They still import, through the vault's restore pipeline: this adapter
// decrypts and parses them with the v1 code and writes their rows into the vault's scratch copy of the database. It
// loads in Node like the descriptor: the v1 modules it imports reach no native code beyond the database and files.
import { drizzle } from "drizzle-orm/expo-sqlite";
import { File, Paths } from "expo-file-system";

import type { RestoreContext, SqlReader, VaultLegacy, VaultSql } from "@/vault/types";
import { decryptBackupText, MAX_ENCRYPTED_SIZE } from "@/lib/backup-crypto";
import { parseBackup, writeBackupRows, type Backup } from "@/lib/backup-data";
import { localDay } from "@/lib/metrics";
import { shiftDay } from "@/lib/nutrition";

/** A file name the v1 code wrote (`before-restore-<ms>.backup.json`): no folders, nothing hidden. */
const BACKUP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const upsert = (key: string, value: string): VaultSql => ({
  sql: "INSERT INTO preferences (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  params: [key, value],
});

/**
 * What every restore, v2 or v1, sets on this device: Health sync off, and yesterday settled, so the diary never counts
 * it as logged on its own from restored entries (the v1 restore did the same).
 */
export function healthOff(ctx: RestoreContext): VaultSql[] {
  return [
    upsert("healthSyncEnabled", "false"),
    upsert("healthSyncError", ""),
    upsert("lastSync", ""),
    upsert("settledDay", shiftDay(localDay(ctx.now), -1)),
  ];
}

/**
 * The v1 pre-restore copy. `recoveryBackupUri` names it by an absolute URI whose container path can change across
 * reinstalls, so only its file name counts, looked up in the folder the v1 code wrote it to (`backupFolder()` of
 * src/lib/backup-files.ts, not imported: that module reaches Health and the document picker).
 */
function recoveryCopy(db: SqlReader): { file: File; createdAt: string } | null {
  const uri =
    db.getFirstSync<{ value: string }>(
      "SELECT value FROM preferences WHERE key = 'recoveryBackupUri'"
    )?.value ?? "";
  let name: string;
  try {
    name = decodeURIComponent(uri.slice(uri.lastIndexOf("/") + 1));
  } catch {
    return null; // A malformed URI names no file.
  }
  if (!BACKUP_NAME.test(name)) return null;
  const file = new File(Paths.document, "MacroTrackBackups", name);
  if (!file.exists) return null;
  return { file, createdAt: new Date(file.lastModified ?? Date.now()).toISOString() };
}

export const macroLegacy: VaultLegacy<Backup> = {
  formats: { plain: "macro-track-backup", encrypted: "macro-track-encrypted-backup" },
  maxBytes: MAX_ENCRYPTED_SIZE,
  decrypt: decryptBackupText,
  parse: parseBackup,
  createdAt: (backup) => backup.createdAt,
  counts: ({ data }) => {
    const days = data.entries.map((e) => e.day).sort();
    return {
      entries: data.entries.length,
      days: new Set(days).size,
      weights: data.weights.length,
      recipes: data.recipes.length,
      savedMeals: data.savedMeals.length,
      first: days[0] ?? null,
    };
  },
  // What the v1 restore replaced; measurements, photos, preferences and the other Health links stay as they are.
  tables: [
    { name: "weight_entries" },
    { name: "food_entries" },
    { name: "custom_foods" },
    { name: "saved_foods" },
    { name: "diary_days" },
    { name: "nutrition_targets" },
    { name: "saved_meals" },
    { name: "recipes" },
    { name: "coaching_goals" },
    { name: "check_ins" },
    { name: "health_links", scope: "local_kind = 'weight'" },
  ],
  preferenceKeys: [],
  // The scratch copy is at the current schema level, so the v1 restore's own inserts apply unchanged.
  write(scratch, { data }) {
    drizzle(scratch).transaction((tx) => writeBackupRows(tx, data));
  },
  // The vault keeps the live `installation` and adds "*" to `healthInstallations` (spec §5.2); `weightSyncEpoch` and
  // `recoveryBackupUri` stay (preferences are not replaced).
  overrides: healthOff,
  recoveryCopy,
};
