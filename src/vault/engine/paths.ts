// Where the vault keeps its files and which connection it works on (docs/vault.md, "What the vault keeps on disk"):
//   <documents>/PendumVault/work/<op>/                 private files of one running operation (staged media too)
//   <documents>/PendumVault/recovery/<id>[.partial]/   recovery sets: data.<ext>, media/ (.partial until packaged)
//   <documents>/PendumVault/journal.json               the crash journal of a restore
//   <documents>/PendumVault/device.json                the device anchor (never deleted by cleanup)
//   <cache>/PendumVault/out/                           finished manual exports for the share sheet (kept 24 h)
// <documents> is Paths.document unless the engine environment replaces it (self-test, tests), and media sets live
// under it too. work/ is under Documents, not Caches: a crash roll-forward needs the staged files. The live-op
// registry names every operation of this JS runtime that owns files under work/ or a journal, so cleanup and crash
// recovery never touch a running one.
import { Directory, File, Paths } from "expo-file-system";
import type { SQLiteDatabase } from "expo-sqlite";

import { vaultApp } from "../app";
import type { AppIdentity } from "../types";

/** What the engine runs against: the app's descriptor and Paths.document unless replaced. */
export interface EngineEnv {
  /** The connection vault work runs on (the descriptor's database.acquire by default). */
  acquire(): Promise<SQLiteDatabase>;
  /** Gives the connection back (the descriptor's database.release by default). */
  release(db: SQLiteDatabase): Promise<void>;
  /** The documents folder: media sets and PendumVault live under it. */
  documentRoot: Directory;
}

let override: Partial<EngineEnv> | null = null;

/** Replaces parts of the environment (the self-test runs against a copy of the live DB); null restores the defaults. */
export function setEngineEnv(env: Partial<EngineEnv> | null): void {
  override = env;
}

/** The current environment. */
export function engineEnv(): EngineEnv {
  return {
    acquire: override?.acquire ?? (() => vaultApp.database.acquire()),
    release: override?.release ?? ((db) => vaultApp.database.release(db)),
    documentRoot: override?.documentRoot ?? Paths.document,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Layout

export const VAULT_FOLDER = "PendumVault";

/** Operation and recovery ids: `<yyyyMMdd>T<HHmmss>Z-<4 of [a-z0-9]>` (UTC). */
export const VAULT_ID = /^\d{8}T\d{6}Z-[a-z0-9]{4}$/;

function checkId(id: string): string {
  if (!VAULT_ID.test(id)) throw new Error(`vault: '${id}' is not an operation or recovery id`);
  return id;
}

/** <documents>/PendumVault/ */
export function vaultDir(): Directory {
  return new Directory(engineEnv().documentRoot, VAULT_FOLDER);
}

/** <documents>/PendumVault/work/ */
export function workRoot(): Directory {
  return new Directory(vaultDir(), "work");
}

/** <documents>/PendumVault/work/<op>/ */
export function workDir(op: string): Directory {
  return new Directory(workRoot(), checkId(op));
}

/** <documents>/PendumVault/recovery/ */
export function recoveryRoot(): Directory {
  return new Directory(vaultDir(), "recovery");
}

/** A complete recovery set: <documents>/PendumVault/recovery/<id>/ */
export function recoveryDir(id: string): Directory {
  return new Directory(recoveryRoot(), checkId(id));
}

/** A recovery set until it is packaged: <documents>/PendumVault/recovery/<id>.partial/ */
export function recoveryPartialDir(id: string): Directory {
  return new Directory(recoveryRoot(), `${checkId(id)}.partial`);
}

/** A recovery set's pre-restore archive: recovery/<id>/data.<ext> (recovery/<id>.partial/… while packaging). */
export function recoveryArchiveFile(id: string, extension: string, partial = false): File {
  return new File(partial ? recoveryPartialDir(id) : recoveryDir(id), `data.${extension}`);
}

/** <documents>/PendumVault/journal.json */
export function journalFile(): File {
  return new File(vaultDir(), "journal.json");
}

/** <documents>/PendumVault/device.json, the device anchor. */
export function anchorFile(): File {
  return new File(vaultDir(), "device.json");
}

/** <cache>/PendumVault/ (exports for the share sheet; never backed up by iOS). */
export function cacheDir(): Directory {
  return new Directory(Paths.cache, VAULT_FOLDER);
}

/** <cache>/PendumVault/out/ */
export function exportDir(): Directory {
  return new Directory(cacheDir(), "out");
}

/** A media set's live folder: <documents>/<directory>/ (descriptor `media[].directory`). */
export function mediaDir(directory: string): Directory {
  return new Directory(engineEnv().documentRoot, directory);
}

/** A file path as SQLite takes it (VACUUM INTO, ATTACH, openDatabaseSync's directory): the decoded file:// path. */
export function fsPath(target: File | Directory): string {
  return decodeURIComponent(target.uri.replace(/^file:\/\//, ""));
}

/** Creates `dir` and its parents when missing; returns it. */
export function ensureDir(dir: Directory): Directory {
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

/** Deletes `dir` with everything in it, when it exists. */
export function removeDir(dir: Directory): void {
  if (dir.exists) dir.delete();
}

/** Deletes `file` when it exists. */
export function removeFile(file: File): void {
  if (file.exists) file.delete();
}

// ---------------------------------------------------------------------------------------------------------------
// Ids and the live-op registry

const live = new Set<string>();

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** `<yyyyMMdd>T<HHmmss>Z` of `date` in UTC (recovery ids, operation ids, auto-backup names). */
export function utcStamp(date: Date): string {
  return (
    `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

/** A manual export's file name, in local time: `PendumLift-2026-10-04-153012.pendumlift`. */
export function manualArchiveName(
  app: Pick<AppIdentity, "fileStem" | "extension">,
  date = new Date()
): string {
  const day = `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${app.fileStem}-${day}-${time}.${app.extension}`;
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** `length` random characters of [a-z0-9] (name uniqueness, not secrecy). */
export function randomTag(length = 4): string {
  let tag = "";
  for (let i = 0; i < length; i++) tag += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return tag;
}

/** A new id `<yyyyMMdd>T<HHmmss>Z-<rand4>` that no live operation and no work or recovery folder uses yet. */
export function newVaultId(now = new Date()): string {
  for (;;) {
    const id = `${utcStamp(now)}-${randomTag()}`;
    if (
      !live.has(id) &&
      !workDir(id).exists &&
      !recoveryDir(id).exists &&
      !recoveryPartialDir(id).exists
    )
      return id;
  }
}

/** A new operation id, registered live until endOp(); its work folder is work/<op>/ (created by the caller). */
export function newOpId(now = new Date()): string {
  const op = newVaultId(now);
  live.add(op);
  return op;
}

/** Takes an operation out of the live registry (its work folder is the caller's to delete). */
export function endOp(op: string): void {
  live.delete(op);
}

/** Whether `op` belongs to an operation still running in this JS runtime. */
export function isLiveOp(op: string): boolean {
  return live.has(op);
}

/** The live operation ids. */
export function liveOps(): string[] {
  return [...live];
}

// ---------------------------------------------------------------------------------------------------------------
// Cleanup (the last step of crash recovery, under the vault lock)

/** How long a finished manual export stays in the cache for the share sheet and Android's Save to device. */
export const EXPORT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Deletes what earlier runs left behind: every work/<op> whose op is neither live nor in `keep.ops`, every
 * recovery/<id>.partial whose id is not in `keep.recoveries` (both: what the crash journal still names), and cached
 * exports older than 24 h. Complete recovery sets and the device anchor are never touched here.
 */
export function removeLeftovers(
  keep: { ops?: readonly string[]; recoveries?: readonly string[] } = {},
  now = Date.now()
): void {
  const work = workRoot();
  if (work.exists)
    for (const entry of work.list())
      if (
        !(entry instanceof Directory) ||
        (!live.has(entry.name) && !keep.ops?.includes(entry.name))
      )
        entry.delete();
  const recovery = recoveryRoot();
  if (recovery.exists)
    for (const entry of recovery.list()) {
      const partial = /^(.+)\.partial$/.exec(entry.name);
      if (entry instanceof Directory && partial && !keep.recoveries?.includes(partial[1]))
        entry.delete();
    }
  const out = exportDir();
  if (out.exists)
    for (const entry of out.list()) {
      const at = entry instanceof File ? entry.lastModified : null;
      if (at == null || now - at > EXPORT_TTL_MS) entry.delete();
    }
}
