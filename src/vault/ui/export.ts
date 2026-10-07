// "Export data" in Settings (docs/vault.md, "Export"; spec §11.3, §11.5): a manual archive with photos and CSV copies,
// written to the cache folder (kept 24 h: Android hands the file to the target app after shareAsync resolves), then
// on iOS the share sheet (its "Save to Files" is the save), on Android Save to device (the system folder picker; many
// Android share sheets have no save target) or Share. The run lives in a module store, so leaving Settings and coming
// back shows it still running.
import { Directory, File, FileMode } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { useSyncExternalStore } from "react";
import { Platform } from "react-native";

import type { KitLanguage } from "@/vector";

import { vaultIdentity } from "../app";
import { ensureDir, exportDir, manualArchiveName, removeFile } from "../engine/paths";
import { toVaultError, VaultError, type VaultErrorCode } from "../errors";
import { useVaultText } from "../i18n";
import { runExport } from "../ops";
import type { Progress } from "../types";

import type { VaultErrorLike } from "./labels";

/** Input slice per JS tick for a manual export (the person waits for it). */
const CHUNK = 1024 * 1024;

export type ExportState = {
  /** Writing the file (the share sheet is not part of it). */
  busy: boolean;
  /** Throttled to step changes and every 10 %. */
  progress: Progress;
  /** The last failure, for errorText(v, error, "manual"); a cancellation is none. */
  error: VaultErrorLike | null;
  /** The file was written, but some records failed the export-time checks (spec §3.5.1). */
  warnings: boolean;
  /** Android: the finished file, offered for Save to device and Share. */
  ready: File | null;
  /** Android: copying the file to the folder the person picked. */
  saving: boolean;
  /** Android: the name of the folder the file was saved to. */
  savedTo: string | null;
};

const IDLE: ExportState = {
  busy: false,
  progress: { step: "snapshot" },
  error: null,
  warnings: false,
  ready: null,
  saving: false,
  savedTo: null,
};

let state: ExportState = IDLE;
const listeners = new Set<() => void>();

function update(patch: Partial<ExportState>): void {
  state = { ...state, ...patch };
  for (const listener of [...listeners]) listener();
}

const failure = (e: unknown, fallback: VaultErrorCode): VaultErrorLike | null => {
  const error = toVaultError(e, fallback);
  return error.code === "cancelled" ? null : { code: error.code, info: error.info };
};

const tenth = (p: Progress) => (p.total ? Math.floor(((p.done ?? 0) * 10) / p.total) : -1);

function progressed(p: Progress): void {
  const last = state.progress;
  if (p.step !== last.step || tenth(p) !== tenth(last)) update({ progress: p });
}

/** The export's state as last updated (the same object until it changed). */
export function exportState(): ExportState {
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

async function shareFile(file: File, dialogTitle: string): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) throw new VaultError("shareUnavailable");
  try {
    await Sharing.shareAsync(file.uri, {
      mimeType: vaultIdentity.mime,
      UTI: vaultIdentity.uti,
      dialogTitle,
    });
  } catch (e) {
    throw new VaultError("shareUnavailable", { cause: e });
  }
}

/**
 * Exports everything (runExport: the vault lock, ensureReady, exportArchive) and hands the file on: the share sheet on
 * iOS, the ready state on Android. A second call while one runs does nothing.
 */
export async function exportData(options: {
  language: KitLanguage;
  dialogTitle: string;
}): Promise<void> {
  if (state.busy || state.saving) return;
  update({ ...IDLE, busy: true });
  let file: File | null = null;
  try {
    const destination = new File(ensureDir(exportDir()), manualArchiveName(vaultIdentity));
    // An export of the same second: the earlier copy in the cache goes.
    removeFile(destination);
    const result = await runExport({
      kind: "manual",
      destination,
      embedMedia: true,
      csv: true,
      deflateLevel: 6,
      chunkBytes: CHUNK,
      language: options.language,
      onProgress: progressed,
    });
    if (!result.file) throw new VaultError("exportFailed", { detail: "noFile" });
    file = result.file;
    update({ busy: false, warnings: result.warnings.length > 0 });
  } catch (e) {
    update({ busy: false, error: failure(e, "exportFailed") });
    return;
  }
  if (Platform.OS !== "ios") {
    update({ ready: file });
    return;
  }
  try {
    // The sheet is the confirmation; it resolves the same way when the person cancels it.
    await shareFile(file, options.dialogTitle);
  } catch (e) {
    update({ error: failure(e, "shareUnavailable") });
  }
}

/** Android: copies the finished file into a folder the person picks (the Storage Access Framework). */
export async function saveExport(): Promise<void> {
  const file = state.ready;
  if (!file || state.saving) return;
  let folder: Directory;
  try {
    folder = await Directory.pickDirectoryAsync();
  } catch {
    // The picker was closed without a folder.
    return;
  }
  update({ saving: true, savedTo: null, error: null });
  try {
    const target = folder.createFile(file.name, vaultIdentity.mime);
    await copyStream(file, target);
    update({ saving: false, savedTo: folder.name });
  } catch (e) {
    update({ saving: false, error: failure(e, "exportFailed") });
  }
}

/** Android: the share sheet for the finished file. */
export async function shareExport(dialogTitle: string): Promise<void> {
  const file = state.ready;
  if (!file) return;
  update({ error: null });
  try {
    await shareFile(file, dialogTitle);
  } catch (e) {
    update({ error: failure(e, "shareUnavailable") });
  }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Copies `from` into `to` in 1 MiB pieces (a picked folder's file is a content:// URI that File.copy cannot reach). */
async function copyStream(from: File, to: File): Promise<void> {
  const input = from.open(FileMode.ReadOnly);
  try {
    const output = to.open(FileMode.WriteOnly);
    try {
      for (;;) {
        const bytes = input.readBytes(CHUNK);
        if (!bytes.length) break;
        output.writeBytes(bytes);
        await tick();
      }
    } finally {
      output.close();
    }
  } finally {
    input.close();
  }
}

/** The export row's state and actions: run(), and on Android saveToDevice() and share() once the file is ready. */
export function useExport() {
  const { language, v } = useVaultText();
  const current = useSyncExternalStore(subscribe, exportState);
  const dialogTitle = v("shareTitle");
  return {
    ...current,
    run: () => exportData({ language, dialogTitle }),
    saveToDevice: saveExport,
    share: () => shareExport(dialogTitle),
  };
}

export type Exporter = ReturnType<typeof useExport>;
