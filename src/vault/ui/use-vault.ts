// Module stores behind the vault's UI (docs/vault.md, "Operations"; spec §7.7, §8.5): the status Settings shows and
// the import flow. Both live outside React — a running restore and its result survive the app going to the
// background and the screen being left and opened again — and useSyncExternalStore re-renders their readers.
//
// The status is read on the vault's connection only while no vault operation holds the lock (an export, a restore,
// the self-test, which points the engine at a copy of the database); a change meanwhile is read when the lock is
// freed. The import flow runs the reducer of ui/import-flow.ts and the work its events stand for: open the file
// (runOpen), try a password, restore (runRestore). The screen only renders it and asks.
import { File } from "expo-file-system";
import { useSyncExternalStore } from "react";
import { Platform } from "react-native";

import { vaultIdentity } from "../app";
import { healthSyncOn } from "../engine/export";
import { busyWith, subscribeLock } from "../engine/lock";
import { engineEnv } from "../engine/paths";
import { libraryEmpty } from "../engine/ready";
import { latestRecovery } from "../engine/recovery";
import { subscribeVaultState } from "../engine/state";
import { toVaultError } from "../errors";
import { subscribeIncoming, takePendingIncoming, type Pending } from "../incoming";
import { vaultSupported } from "../native";
import { runOpen, runRestore } from "../ops";
import type { OpenedArchive, ProviderStatus, RecoveryInfo, VaultStatus } from "../types";

import {
  importBusy,
  importFlow,
  initialImport,
  restoreReason,
  type ImportEvent,
  type ImportState,
} from "./import-flow";

// ---------------------------------------------------------------------------------------------------------------
// Status (useVaultStatus)

/** M1 has no cloud providers: both read as not configured until M2 (T2.6) fills them in. */
const NO_PROVIDER: ProviderStatus = {
  configured: false,
  enabled: false,
  availability: "unavailable",
  lastOkAt: null,
  lastUploadAt: null,
  lastConfirmedAt: null,
  lastError: null,
  lastWarning: null,
  uploadError: null,
  waitingForUpload: false,
  account: null,
};

let status: VaultStatus = {
  providers: { icloud: NO_PROVIDER, gdrive: NO_PROVIDER },
  running: busyWith() !== null,
  latestRecovery: null,
  libraryEmpty: false,
};
const statusListeners = new Set<() => void>();
let unwatch: (() => void) | null = null;
/** A change not read yet (it came while a vault operation held the lock). */
let stale = true;
let reading: Promise<void> | null = null;

const sameRecovery = (a: RecoveryInfo | null, b: RecoveryInfo | null) =>
  a === b || (!!a && !!b && a.id === b.id && a.createdAt === b.createdAt && a.legacy === b.legacy);

function updateStatus(patch: Partial<VaultStatus>): void {
  const next = { ...status, ...patch };
  if (
    next.providers === status.providers &&
    next.running === status.running &&
    next.libraryEmpty === status.libraryEmpty &&
    sameRecovery(next.latestRecovery, status.latestRecovery)
  )
    return;
  status = next;
  for (const listener of [...statusListeners]) listener();
}

async function readStatus(): Promise<void> {
  try {
    const env = engineEnv();
    const db = await env.acquire();
    try {
      updateStatus({ latestRecovery: latestRecovery(db), libraryEmpty: libraryEmpty(db) });
    } finally {
      await env.release(db);
    }
  } catch (e) {
    console.warn("[vault]", "status", e);
  }
}

/**
 * Re-reads the newest recovery set and whether the library is empty (after startVault, a restore, an erase, and
 * when Settings mounts). While a vault operation holds the lock the read waits until the lock is freed.
 */
export function refreshVaultStatus(): Promise<void> {
  if (!vaultSupported) return Promise.resolve();
  stale = true;
  // `finally` runs on a later tick, also when nothing was read (the lock was held); a call that came meanwhile
  // (the lock freed in between) is read then.
  reading ??= readWhileStale().finally(() => {
    reading = null;
    if (stale && busyWith() === null) void refreshVaultStatus();
  });
  return reading;
}

async function readWhileStale(): Promise<void> {
  while (stale && busyWith() === null) {
    stale = false;
    await readStatus();
  }
}

/** The status as last read (the same object until something changed). */
export function vaultStatus(): VaultStatus {
  return status;
}

function subscribeStatus(listener: () => void): () => void {
  statusListeners.add(listener);
  if (!unwatch) {
    const onLock = () => {
      const busy = busyWith() !== null;
      updateStatus({ running: busy });
      if (!busy && stale) void refreshVaultStatus();
    };
    const offLock = subscribeLock(onLock);
    // The vault's state changes with a restore, an erase and crash recovery.
    const offState = subscribeVaultState(() => void refreshVaultStatus());
    unwatch = () => {
      offLock();
      offState();
    };
    // Whatever changed while nobody watched.
    onLock();
  }
  return () => {
    statusListeners.delete(listener);
    if (!statusListeners.size && unwatch) {
      unwatch();
      unwatch = null;
    }
  };
}

/** What Settings shows: the newest recovery set, whether the library is empty, whether a vault operation runs. */
export function useVaultStatus(): VaultStatus {
  return useSyncExternalStore(subscribeStatus, vaultStatus);
}

// ---------------------------------------------------------------------------------------------------------------
// Import flow (useImportFlow)

let flow: ImportState = initialImport;
const flowListeners = new Set<() => void>();
/** The file the flow reads and how it came. */
let source: { file: File; pending: Pending } | null = null;
let archive: OpenedArchive | null = null;
/** Moves on whenever the flow takes another file or ends, so a slower open of an earlier file is discarded. */
let generation = 0;
/** Mounted import screens. Without one, a flow that waits for the person ends (and its archive is closed). */
let screens = 0;
const seen = new WeakSet<object>();

function dispatch(event: ImportEvent): ImportState {
  const next = importFlow(flow, event);
  if (next !== flow) {
    flow = next;
    for (const listener of [...flowListeners]) listener();
  }
  return flow;
}

function closeArchive(): void {
  const opened = archive;
  archive = null;
  opened?.close();
}

function endFlow(): void {
  generation += 1;
  closeArchive();
  source = null;
  dispatch({ e: "reset" });
}

/** Ends a flow that waits for the person once no import screen shows it; running work finishes first. */
function abandon(): void {
  if (!screens && !importBusy(flow)) endFlow();
}

/** This device's Health sync, read when a file opens: the confirm and done states say a restore turns it off. */
async function liveHealthOn(): Promise<boolean> {
  try {
    const env = engineEnv();
    const db = await env.acquire();
    try {
      return healthSyncOn(db);
    } finally {
      await env.release(db);
    }
  } catch {
    return false;
  }
}

async function open(gen: number, password?: string): Promise<void> {
  const from = source;
  if (!from) return;
  try {
    const opened = await runOpen(from.file, password === undefined ? undefined : { password });
    const healthOn = await liveHealthOn();
    if (gen !== generation) {
      opened.close();
      return;
    }
    archive = opened;
    dispatch({ e: "opened", preview: opened.preview, healthOn });
  } catch (e) {
    if (gen !== generation) return;
    const error = toVaultError(e, "unknown");
    if (error.code === "legacyPasswordRequired" && password === undefined)
      dispatch({ e: "needPassword" });
    else if (error.code === "legacyPasswordRequired" || error.code === "legacyPasswordWrong")
      dispatch({ e: "wrongPassword" });
    else dispatch({ e: "failed", code: error.code, info: error.info });
  }
  if (gen === generation) abandon();
}

/** Starts reading `pending` when `event` moves the flow to it (a running restore queues it instead). */
function begin(event: ImportEvent, pending: Pending, picked?: File): void {
  const before = flow;
  if (dispatch(event) === before || flow.s !== "reading") return;
  generation += 1;
  closeArchive();
  let file: File;
  try {
    file = picked ?? new File(pending.uri);
  } catch (e) {
    source = null;
    dispatch({ e: "failed", code: "notArchive", info: { detail: "uri", cause: e } });
    return;
  }
  source = { file, pending };
  void open(generation);
}

/** Takes a file handed over with setPendingIncoming (on mount and whenever one arrives). */
function takeIncoming(): void {
  const pending = takePendingIncoming();
  if (pending) begin({ e: flow.s === "start" ? "incoming" : "secondIncoming", pending }, pending);
}

/** The import screen's mount effect: takes the waiting file; the returned function runs on unmount. */
export function attachImportScreen(): () => void {
  screens += 1;
  takeIncoming();
  const unsubscribe = subscribeIncoming(takeIncoming);
  return () => {
    unsubscribe();
    screens -= 1;
    abandon();
  };
}

/** "Choose a file": the system picker, then the file is read. A cancelled picker changes nothing. */
export async function pickImportFile(): Promise<void> {
  if (importBusy(flow)) return;
  try {
    const picked = await File.pickFileAsync({
      mimeTypes:
        Platform.OS === "ios" ? [vaultIdentity.mime, "application/zip", "application/json"] : "*/*",
    });
    if (picked.canceled) return;
    begin({ e: "pick" }, { uri: picked.result.uri, origin: "file" }, picked.result);
  } catch (e) {
    console.warn("[vault]", "pickFileAsync", e);
  }
}

/** "Open backup": reads the legacy encrypted backup again with `password`. */
export function unlockImport(password: string): void {
  const before = flow;
  if (dispatch({ e: "unlock" }) !== before) void open(generation, password);
}

async function restore(): Promise<void> {
  const opened = archive;
  const from = source;
  if (!opened || !from) {
    dispatch({ e: "failed", code: "restoreFailed", info: { detail: "notOpen" } });
    return;
  }
  try {
    const result = await runRestore(opened, {
      reason: restoreReason(from.pending.origin, opened.preview),
      media: from.pending.media,
      onProgress: (p) => void dispatch({ e: "progress", p }),
    });
    dispatch({ e: "restored", result });
  } catch (e) {
    const error = toVaultError(e, "restoreFailed");
    dispatch({ e: "failed", code: error.code, info: error.info });
  } finally {
    if (archive === opened) archive = null;
    // The engine keeps the private copy until the restore has let go of it.
    opened.close();
    source = null;
    void refreshVaultStatus();
  }
}

/** "Restore backup": asks for confirmation, or restores at once when the library is empty. */
export function requestRestore(): void {
  const before = flow;
  if (dispatch({ e: "restore" }) !== before && flow.s === "restoring") void restore();
}

/** The confirmation's "Replace data". */
export function confirmRestore(): void {
  const before = flow;
  if (dispatch({ e: "confirmed" }) !== before) void restore();
}

/** The confirmation's Cancel (or the alert dismissed). */
export function cancelRestore(): void {
  dispatch({ e: "cancel" });
}

/** Opens the file that arrived while the last restore ran. */
export function openNextImport(): void {
  if ((flow.s === "done" || flow.s === "error") && flow.next)
    begin({ e: "incoming", pending: flow.next }, flow.next);
}

/** The import flow as last dispatched (the same object until it changed). */
export function importState(): ImportState {
  return flow;
}

function subscribeFlow(listener: () => void): () => void {
  flowListeners.add(listener);
  return () => {
    flowListeners.delete(listener);
  };
}

/** The import screen's state. */
export function useImportFlow(): ImportState {
  return useSyncExternalStore(subscribeFlow, importState);
}

/**
 * True the first time it sees `key` (a state or result object): the screen's one-off reactions — the confirmation
 * alert, the app's refresh after a restore — run once however often their effect re-runs.
 */
export function firstSight(key: object): boolean {
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
}
