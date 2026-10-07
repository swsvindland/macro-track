// Recovery sets (docs/vault.md, "Recovery sets and the crash journal"; spec §3.9): before a restore replaces a
// non-empty library, the commit section copies the live database into PendumVault/recovery/<id>.partial/live.db and
// moves the photos the restore displaces into its media/ folder. After the commit that raw set is packaged as a
// `pre-restore` archive (data.<ext>, media not embedded) and renamed to recovery/<id>/: the rename is the completion
// marker. Only complete sets are offered ("Restore data from before {date}"), and only the newest two are kept.
// `_vault_state["recovery.latest"]` names the newest by its relative id, never by an absolute URI. Until a v2 set
// exists, lift's and macro's last v1 pre-restore copy stays reachable through the descriptor's legacy adapter.
import { Directory, File } from "expo-file-system";

import { vaultApp, vaultIdentity } from "../app";
import { checkAborted, toVaultError, VaultError } from "../errors";
import { vaultNative } from "../native";
import type { ManifestMedia, MediaSource, OpenedArchive, RecoveryInfo, SqlReader } from "../types";

import { exportArchive, MEDIA_NAME } from "./export";
import { openArchive, verifyArchive } from "./inspect";
import {
  buildManifest,
  MANIFEST_ENTRY,
  manifestText,
  MAX_MANIFEST,
  parseManifest,
} from "./manifest";
import type { MediaHash } from "./media";
import {
  endOp,
  engineEnv,
  ensureDir,
  fsPath,
  mediaDir,
  newOpId,
  newVaultId,
  recoveryArchiveFile,
  recoveryDir,
  recoveryPartialDir,
  recoveryRoot,
  removeDir,
  removeFile,
  VAULT_ID,
  workDir,
} from "./paths";
import { ArchiveReader } from "./zip-read";
import { ArchiveWriter } from "./zip-write";

/** Complete recovery sets kept after a restore (the one just made always among them). */
export const KEEP_RECOVERY_SETS = 2;
/** The id latestRecovery() gives the v1 pre-restore copy of lift and macro. */
export const LEGACY_RECOVERY = "legacy";

/** The raw set a commit section starts: recovery/<id>.partial/ with the snapshot path and the media folder. */
export interface NewRecovery {
  id: string;
  /** recovery/<id>.partial/live.db as SQLite takes it (VACUUM INTO). */
  snapshotPath: string;
  /** recovery/<id>.partial/media/: displaced files, by set. */
  media: Directory;
}

/** `<yyyyMMdd>T<HHmmss>Z-…` → epoch ms. */
function idTime(id: string): number {
  const [, y, mo, d, h, mi, s] = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(id) ?? [];
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
}

/**
 * Creates the folder of a new recovery set (synchronous: called inside the commit section). Its id sorts after every
 * set already there, so "newest" is always the id order: within one second the next id takes the next second.
 */
export function newRecoverySync(): NewRecovery {
  const root = recoveryRoot();
  const latest = root.exists
    ? root
        .list()
        .map((e) => /^(\d{8}T\d{6}Z-[a-z0-9]{4})(\.partial)?$/.exec(e.name)?.[1])
        .filter((id): id is string => !!id)
        .sort()
        .at(-1)
    : undefined;
  const now = Date.now();
  const id = newVaultId(new Date(latest ? Math.max(now, idTime(latest) + 1000) : now));
  const dir = ensureDir(recoveryPartialDir(id));
  return { id, snapshotPath: fsPath(new File(dir, "live.db")), media: new Directory(dir, "media") };
}

/** Whether `dir` holds at least one file, at any depth. */
function holdsFiles(dir: Directory): boolean {
  return dir.exists && dir.list().some((e) => !(e instanceof Directory) || holdsFiles(e));
}

/**
 * Deletes recovery/<id>.partial/ after a restore that did not commit. A set whose media/ folder still holds files is
 * kept (and reported false): those are live photos a rollback could not move back, and their only copy.
 */
export function removeRecoveryPartialSync(id: string): boolean {
  const dir = recoveryPartialDir(id);
  if (!dir.exists) return true;
  if (holdsFiles(new Directory(dir, "media"))) return false;
  dir.delete();
  return true;
}

/** Ids of .partial sets whose media/ folder holds files: cleanup never deletes those (see above). */
export function partialsHoldingMedia(): string[] {
  const root = recoveryRoot();
  if (!root.exists) return [];
  return root
    .list()
    .flatMap((e) => {
      const id = /^(.+)\.partial$/.exec(e.name)?.[1];
      return e instanceof Directory && id && holdsFiles(new Directory(e, "media")) ? [id] : [];
    })
    .sort();
}

/** Ids of the complete sets (recovery/<id>/data.<ext> present), newest first. */
export function completeRecoveryIds(): string[] {
  const root = recoveryRoot();
  if (!root.exists) return [];
  return root
    .list()
    .filter(
      (e) =>
        e instanceof Directory &&
        VAULT_ID.test(e.name) &&
        recoveryArchiveFile(e.name, vaultIdentity.extension).exists
    )
    .map((e) => e.name)
    .sort()
    .reverse();
}

/**
 * The newest complete recovery set, or — when there is none and `db` (the live connection) is given — the v1
 * pre-restore copy the descriptor's legacy adapter resolves (`id: "legacy"`). Partial sets are never offered.
 */
export function latestRecovery(db?: SqlReader): RecoveryInfo | null {
  const [id] = completeRecoveryIds();
  if (id) return { id, createdAt: new Date(idTime(id)).toISOString(), legacy: false };
  if (!db || !vaultApp.legacy) return null;
  let copy: { file: File; createdAt: string } | null = null;
  try {
    copy = vaultApp.legacy.recoveryCopy(db);
  } catch {
    // an unreadable copy is not offered
  }
  return copy ? { id: LEGACY_RECOVERY, createdAt: copy.createdAt, legacy: true } : null;
}

/** Deletes complete sets beyond the newest KEEP_RECOVERY_SETS; `keep` (the set just packaged) always stays. */
export function pruneRecoverySets(keep: string): void {
  const ids = completeRecoveryIds();
  const retained = new Set([keep, ...ids.slice(0, KEEP_RECOVERY_SETS)]);
  for (const id of ids) if (!retained.has(id)) removeDir(recoveryDir(id));
}

/**
 * Packages recovery/<id>.partial/ (crash roll-forward calls it again until it succeeds): live.db becomes the
 * `pre-restore` archive data.<ext>, the raw copy is deleted, the folder is renamed to recovery/<id>/ and older sets
 * are pruned. `known` has the hashes of the displaced files' originals (the media plan hashed them before the moves).
 */
export async function packageRecoverySet(
  id: string,
  known?: Map<string, MediaHash>
): Promise<void> {
  const partial = recoveryPartialDir(id);
  // Renamed already, or deleted with an erase: nothing is left to package.
  if (!partial.exists) return;
  const snapshot = new File(partial, "live.db");
  const archive = recoveryArchiveFile(id, vaultIdentity.extension, true);
  if (snapshot.exists) {
    // An earlier start may have stopped in the middle of writing it.
    removeFile(archive);
    await exportArchive({
      kind: "pre-restore",
      snapshotPath: snapshot.uri,
      destination: archive,
      embedMedia: false,
      csv: false,
      deflateLevel: 1,
      chunkBytes: 64 * 1024,
      knownMedia: known,
    });
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      removeFile(new File(partial, `live.db${suffix}`));
  } else if (!archive.exists) throw new VaultError("restoreFailed", { detail: "recoverySnapshot" });
  partial.rename(id);
  pruneRecoverySets(id);
}

/** Hashes of the files a restore displaced into recovery/<id>.partial/media/ (roll-forward packaging). */
export async function displacedHashes(id: string): Promise<Map<string, MediaHash>> {
  const known = new Map<string, MediaHash>();
  const media = new Directory(recoveryPartialDir(id), "media");
  if (!media.exists) return known;
  const native = vaultNative();
  for (const set of media.list())
    if (set instanceof Directory)
      for (const file of set.list())
        if (file instanceof File && MEDIA_NAME.test(file.name))
          known.set(`${set.name}/${file.name}`, {
            bytes: file.size,
            sha256: await native.hashFile(file.uri),
          });
  return known;
}

// ---------------------------------------------------------------------------------------------------------------
// Using a set

/**
 * The media of a complete set: files it displaced (recovery/<id>/media/), else the live file when its SHA-256 still
 * matches. Always a copy: the set must survive a failed restore of itself.
 */
export function recoveryMedia(id: string): MediaSource {
  return {
    async fetch(item: ManifestMedia, dest: File, signal?: AbortSignal) {
      checkAborted(signal);
      if (!MEDIA_NAME.test(item.name)) return false;
      const displaced = new File(recoveryDir(id), "media", item.set, item.name);
      if (displaced.exists) {
        await displaced.copy(dest);
        return true;
      }
      const set = vaultApp.media?.find((m) => m.set === item.set);
      const live = set ? new File(mediaDir(set.directory), item.name) : null;
      if (
        live?.exists &&
        live.size === item.bytes &&
        (await vaultNative().hashFile(live.uri)) === item.sha256
      ) {
        await live.copy(dest);
        return true;
      }
      return false;
    },
  };
}

/** The archive of a recovery set: recovery/<id>/data.<ext>, or the v1 copy for `legacy`; null when it is gone. */
export async function recoveryFile(id: string): Promise<File | null> {
  if (id !== LEGACY_RECOVERY) {
    const file = recoveryArchiveFile(id, vaultIdentity.extension);
    return file.exists ? file : null;
  }
  if (!vaultApp.legacy) return null;
  const env = engineEnv();
  const db = await env.acquire();
  try {
    return vaultApp.legacy.recoveryCopy(db)?.file ?? null;
  } finally {
    await env.release(db);
  }
}

const noMedia: MediaSource = { fetch: async () => false };

/**
 * Opens a recovery set for a restore (reason "recovery", or "legacyRecovery" for the v1 copy) with its media.
 * Callers hold the vault lock and ran ensureReady, as for openArchive.
 */
export async function openRecovery(
  id: string
): Promise<{ archive: OpenedArchive; media: MediaSource }> {
  const file = await recoveryFile(id);
  if (!file) throw new VaultError("restoreFailed", { detail: "recoveryMissing" });
  const archive = await openArchive(file);
  return { archive, media: id === LEGACY_RECOVERY ? noMedia : recoveryMedia(id) };
}

/**
 * "Export this copy": the set as a self-contained `manual` archive at `destination` (which must not exist), its
 * photos embedded from the set or from verified live files (others listed as missing), checked with verifyArchive
 * before it is returned. The v1 copy is copied as it is.
 */
export async function exportRecovery(
  id: string,
  destination: File,
  signal?: AbortSignal
): Promise<File> {
  const source = await recoveryFile(id);
  if (!source) throw new VaultError("exportFailed", { detail: "recoveryMissing" });
  if (id === LEGACY_RECOVERY) {
    await source.copy(destination);
    return destination;
  }
  const op = newOpId();
  const work = workDir(op);
  let reader: ArchiveReader | null = null;
  let writer: ArchiveWriter | null = null;
  try {
    ensureDir(work);
    const native = vaultNative();
    const archive = ArchiveReader.open(source);
    reader = archive;
    const manifest = parseManifest(
      await archive.readText(MANIFEST_ENTRY, MAX_MANIFEST),
      vaultApp.id
    );
    writer = new ArchiveWriter(destination, 6);
    const copyEntry = async (path: string, bytes: number, sha256: string) => {
      const temp = new File(work, "entry");
      await archive.extract(path, temp, bytes, signal);
      if ((await native.hashFile(temp.uri)) !== sha256)
        throw new VaultError("corrupt", { detail: `hash:${path}` });
      await writer?.addFile(path, temp, true, signal);
      temp.delete();
    };
    for (const t of manifest.tables) await copyEntry(t.file, t.bytes, t.sha256);
    for (const f of manifest.files) await copyEntry(f.path, f.bytes, f.sha256);
    const media: ManifestMedia[] = [];
    const missing = [...(manifest.missingMedia ?? [])];
    const photos = recoveryMedia(id);
    for (const item of manifest.media) {
      checkAborted(signal);
      const temp = new File(work, "media");
      removeFile(temp);
      const found =
        (await photos.fetch(item, temp, signal)) &&
        temp.size === item.bytes &&
        (await native.hashFile(temp.uri)) === item.sha256;
      if (found) {
        await writer.addFile(`media/${item.set}/${item.name}`, temp, false, signal);
        media.push({ ...item, embedded: true });
      } else missing.push({ set: item.set, name: item.name });
      removeFile(temp);
    }
    const { app } = manifest;
    const repacked = buildManifest({
      kind: "manual",
      createdAt: manifest.createdAt,
      app: {
        id: app.id,
        bundleId: app.bundleId,
        name: app.name,
        version: app.version,
        build: app.build,
        platform: app.platform,
        osVersion: app.osVersion,
      },
      schema: manifest.schema,
      device: manifest.device,
      library: manifest.library,
      vaultColumns: manifest.vaultColumns,
      tables: manifest.tables,
      media,
      missingMedia: missing.length ? missing : undefined,
      files: manifest.files,
      counts: manifest.counts,
      provenance: manifest.provenance,
      warnings: manifest.warnings,
    });
    writer.addText(MANIFEST_ENTRY, manifestText(repacked));
    writer.finish();
    const check = await verifyArchive(destination);
    if (!check.ok) throw new VaultError("exportFailed", { detail: "verify" });
    return destination;
  } catch (e) {
    try {
      // Deletes the destination only when this export created it.
      writer?.abort();
    } catch {
      // the original error is the one to report
    }
    throw toVaultError(e, "exportFailed");
  } finally {
    reader?.close();
    try {
      removeDir(work);
    } finally {
      endOp(op);
    }
  }
}
