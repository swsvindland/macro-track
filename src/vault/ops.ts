// The vault's entry points for UI code (docs/vault.md, "Operations"; spec §7.2). Each takes the process-wide vault lock
// and runs ensureReady first, so crash recovery has run before anything new starts and no manifest is ever written
// without a device and a library id — whether or not startVault() has finished. No React here: ui/root.tsx, the
// export hook and the screens import it; headless code (cloud/backup.ts) uses engine/ready.ts directly.
import type { File } from "expo-file-system";

import { exportArchive } from "./engine/export";
import { openArchive } from "./engine/inspect";
import { readJournal } from "./engine/journal";
// Registers the v1 reader with openArchive, so lift's and macro's JSON backups open through runOpen.
import "./engine/legacy";
import { exclusive, type OpKind } from "./engine/lock";
import { engineEnv, isLiveOp } from "./engine/paths";
import { ensureReady } from "./engine/ready";
import { restoreArchive } from "./engine/restore";
import { readState } from "./engine/state";
import { toVaultError, VaultError, type VaultErrorCode } from "./errors";
import { loadDeviceInfo, vaultSupported } from "./native";
import type {
  ExportOptions,
  ExportResult,
  OpenedArchive,
  RestoreOptions,
  RestoreResult,
} from "./types";

/**
 * Runs `work` under the vault lock (waiting behind a running operation) and reports a failure once, for
 * diagnostics only (no telemetry); a cancellation is not a failure.
 */
function locked<T>(kind: OpKind, fallback: VaultErrorCode, work: () => Promise<T>): Promise<T> {
  return exclusive(
    kind,
    async () => {
      try {
        return await work();
      } catch (e) {
        const error = toVaultError(e, fallback);
        if (error.code !== "cancelled")
          console.warn("[vault]", error.code, error.info.cause ?? error.info.detail ?? "");
        throw error;
      }
    },
    { wait: true }
  );
}

/**
 * ensureReady on the vault's connection (released before the operation acquires its own). Returns whether a
 * restore's journal is still unfinished afterwards, and whether that restore committed.
 */
async function prepare(): Promise<{ unfinished: boolean; committed: boolean }> {
  const env = engineEnv();
  const db = await env.acquire();
  try {
    await ensureReady(db);
    const journal = readJournal();
    return {
      unfinished: !!journal && !isLiveOp(journal.op),
      committed: !!journal && readState(db, "restore.lastOp") === journal.op,
    };
  } finally {
    await env.release(db);
  }
}

/**
 * Called by <VaultRoot /> after the database is migrated: device facts (cached for the process), then, under the
 * lock, crash recovery and the vault's identity (ensureReady). Never throws: a failure is logged, and every entry
 * point runs ensureReady again. Without the native module (Expo Go, web) the vault stays off. M2 adds the
 * automatic-backup task, the app-state subscriptions and the launch run.
 */
export async function startVault(): Promise<void> {
  if (!vaultSupported) return;
  try {
    await loadDeviceInfo();
    await locked("recover", "unknown", prepare);
  } catch {
    // logged by locked(); the next entry point retries
  }
}

/** A manual export (lock "export"). */
export function runExport(options: ExportOptions): Promise<ExportResult> {
  return locked("export", "exportFailed", async () => {
    await prepare();
    return exportArchive(options);
  });
}

/** Opens a file for a restore and builds its preview (lock "inspect"). The caller closes the archive. */
export function runOpen(
  file: File,
  options?: { password?: string; signal?: AbortSignal }
): Promise<OpenedArchive> {
  return locked("inspect", "unknown", async () => {
    await prepare();
    return openArchive(file, options);
  });
}

/**
 * Restores an opened archive (lock "restore"). Refused while an earlier restore is still unfinished after crash
 * recovery, so its pending recovery set is never overwritten: `insufficientSpace` while that set cannot be packaged
 * (in practice a full disk), `restoreFailed` while its rollback cannot complete. The journal is kept either way.
 */
export function runRestore(
  archive: OpenedArchive,
  options: RestoreOptions
): Promise<RestoreResult> {
  return locked("restore", "restoreFailed", async () => {
    const { unfinished, committed } = await prepare();
    if (unfinished)
      throw committed
        ? new VaultError("insufficientSpace", { detail: "pendingRecovery" })
        : new VaultError("restoreFailed", { detail: "pendingRollback" });
    return restoreArchive(archive, options);
  });
}
