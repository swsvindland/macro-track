// ensureReady (docs/vault.md, "Operations"; spec §7.2): what every lock-taking entry point runs first, inside its own
// lock — startVault, runExport, runOpen, runRestore (ops.ts) and the automatic backup (cloud/backup.ts). After it, an
// interrupted restore is finished or undone, PendumVault is excluded from iOS device backup, the device and library
// ids exist and every syncIdTables row has its sync id. No UI or React imports: headless background runs share it.
import type { SQLiteDatabase } from "expo-sqlite";

import { loadDeviceInfo, vaultNative } from "../native";

import { ensureDevice, ensureLibrary } from "./device";
import { recoverJournal } from "./journal";
import { ensureDir, vaultDir } from "./paths";
import { ensureSyncIds } from "./sid";
import { refreshVaultState } from "./state";

// The vault's one emptiness test (descriptor emptySql), implemented next to the device identity it ships with.
export { libraryEmpty } from "./device";

/**
 * Brings the vault's state in `db` (the connection vault work runs on) up to date. Callers hold the vault lock:
 * crash recovery acts on files other operations own. Idempotent; when everything is in place it writes nothing.
 */
export async function ensureReady(db: SQLiteDatabase): Promise<void> {
  // Cached per process: free after startVault, and needed by headless and early UI callers.
  const info = await loadDeviceInfo();
  await recoverJournal(db);
  // Before the device anchor is first written: PendumVault never travels with an iOS device backup. A failure does
  // not stop the vault: clone detection also compares the device fingerprint (spec §9.1).
  try {
    vaultNative().setExcludedFromBackup(ensureDir(vaultDir()).uri, true);
  } catch (e) {
    console.warn("[vault]", "setExcludedFromBackup", e);
  }
  ensureDevice(db, info);
  ensureLibrary(db);
  ensureSyncIds(db);
  refreshVaultState(db);
}
