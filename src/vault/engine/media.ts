// Media of a restore (docs/vault.md, "Restore"; spec §3.8): which photos the restored rows reference, where each one
// comes from, and the file moves that put them in place. Every file a restore adds is first staged as a verified copy
// in work/<op>/stage/; the moves themselves happen inside the commit section, live files no restored row keeps go into
// the recovery set, and a failure moves everything back. The invariant: a live file is never moved away while a
// restored row references its name, unless a verified replacement is staged. Sources only ever copy (MediaSource), so
// a failed restore can never consume the only copy of a photo.
import { Directory, File } from "expo-file-system";

import { vaultApp } from "../app";
import { checkAborted, VaultError } from "../errors";
import { vaultNative } from "../native";
import type {
  Manifest,
  ManifestMedia,
  MediaSource,
  Progress,
  SqlReader,
  VaultMediaSet,
} from "../types";

import { MEDIA_NAME, referencedMedia } from "./export";
import { ensureDir, mediaDir, recoveryPartialDir, removeFile, workDir } from "./paths";
import type { ArchiveReader } from "./zip-read";

/** One file of a media set. */
export interface MediaMove {
  set: string;
  name: string;
}

/** Size and SHA-256 of a file. */
export type MediaHash = { bytes: number; sha256: string };

/**
 * A file a restore adds, with the size and SHA-256 of its staged copy: after a crash they tell whether the live file
 * of that name is the one the restore put there. Absent (a journal that does not record them): never known.
 */
export type MediaAdd = MediaMove & Partial<MediaHash>;

/** The file moves of one restore, as its crash journal records them. */
export interface MediaMoves {
  /** Live files no restored row keeps: live → recovery/<id>.partial/media/<set>/<name>, before the adds. */
  remove: MediaMove[];
  /** Verified copies staged in work/<op>/stage/<set>/<name>: stage → live. */
  add: MediaAdd[];
}

export interface MediaPlan extends MediaMoves {
  /** `${set}/${name}` → the live files the live rows reference (hashed once; the recovery packaging reuses them). */
  known: Map<string, MediaHash>;
  /** Files staged for the restored rows. */
  restored: number;
  /** Referenced names no source could supply and no live file has (rows kept, files missing). */
  skipped: number;
  /** Referenced names kept from the live folder although the archive could not supply them. */
  keptLive: number;
}

// ---------------------------------------------------------------------------------------------------------------
// Where a file of a move lives

/** The live folder of a media set, or null for a set the descriptor no longer declares. */
function liveFolder(set: string): Directory | null {
  const media = vaultApp.media?.find((m) => m.set === set);
  return media ? mediaDir(media.directory) : null;
}

/** A move the engine may perform: a declared set and a name of the media grammar (never a path). */
const valid = (move: MediaMove) => MEDIA_NAME.test(move.name) && liveFolder(move.set) !== null;

/** `<set>/<name>`: one file of the moves. */
export const moveKey = (move: MediaMove) => `${move.set}/${move.name}`;

function liveFile(move: MediaMove): File {
  const folder = liveFolder(move.set);
  if (!folder) throw new VaultError("restoreFailed", { detail: `mediaSet:${move.set}` });
  return new File(folder, move.name);
}

/** work/<op>/stage/: the verified copies a restore adds, by set. */
export const STAGE = "stage";

const stagedFile = (op: string, move: MediaMove) =>
  new File(workDir(op), STAGE, move.set, move.name);
const displacedFile = (recoveryId: string, move: MediaMove) =>
  new File(recoveryPartialDir(recoveryId), "media", move.set, move.name);

/** Moves `from` to `to` (parents created). Strict: a missing source or a taken destination is an error. */
function move(from: File, to: File): void {
  if (!from.exists) throw new VaultError("restoreFailed", { detail: `mediaMissing:${from.name}` });
  if (to.exists) throw new VaultError("restoreFailed", { detail: `mediaTaken:${to.name}` });
  ensureDir(to.parentDirectory);
  from.moveSync(to);
}

/** Moves `from` to `to` when `from` exists and `to` does not (crash recovery: every step may already be done). */
function moveIfPending(from: File, to: File): void {
  if (!from.exists || to.exists) return;
  ensureDir(to.parentDirectory);
  from.moveSync(to);
}

/** Runs every step, then throws the first failure: one stuck file must not keep the others from moving back. */
function everyStep(moves: readonly MediaMove[], step: (m: MediaMove) => void): void {
  let failure: unknown = null;
  for (const m of moves)
    try {
      if (valid(m)) step(m);
    } catch (e) {
      failure ??= e;
    }
  if (failure !== null) throw failure;
}

// ---------------------------------------------------------------------------------------------------------------
// Moves (synchronous: they run inside the commit section, and again from the crash journal)

/**
 * Applies the moves: REMOVE first (live → the recovery set), then ADD (stage → live), recording in `placed` (by
 * moveKey) every file an ADD put in place. A REMOVE whose live file is already gone is skipped; anything else
 * unexpected throws, and the caller rolls back.
 */
export function applyMediaSync(
  op: string,
  moves: MediaMoves,
  recoveryId: string | null,
  placed: Set<string>
): void {
  for (const m of moves.remove.filter(valid)) {
    if (!recoveryId) throw new Error("vault: displaced media need a recovery set");
    const from = liveFile(m);
    if (from.exists) move(from, displacedFile(recoveryId, m));
  }
  for (const m of moves.add.filter(valid)) {
    move(stagedFile(op, m), liveFile(m));
    placed.add(moveKey(m));
  }
}

/**
 * Undoes the moves of a restore that did not commit: ADD live → stage, then REMOVE back into place. An ADD is undone
 * only for a live file `placed` names (by moveKey) — the commit section's own record, or placedAdds() after a crash
 * — because a live file of that name can also be the user's original, which an ADD-undo would carry off into work/
 * and cleanup would delete. A live file whose identity is unknown stays where it is.
 */
export function rollbackMediaSync(
  op: string,
  moves: MediaMoves,
  recoveryId: string | null,
  placed: ReadonlySet<string>
): void {
  everyStep(moves.add, (m) => {
    if (placed.has(moveKey(m))) moveIfPending(liveFile(m), stagedFile(op, m));
  });
  if (recoveryId)
    everyStep(moves.remove, (m) => moveIfPending(displacedFile(recoveryId, m), liveFile(m)));
}

/**
 * The ADDs of an interrupted restore whose live file is the copy it staged (crash rollback, by moveKey): the staged
 * copy is no longer there and the live file has the size and SHA-256 the journal recorded for it. A staged copy still
 * there means the ADD never happened (or was undone); a live file that differs, or an ADD without a recorded hash, is
 * never counted.
 */
export async function placedAdds(op: string, moves: MediaMoves): Promise<Set<string>> {
  const native = vaultNative();
  const placed = new Set<string>();
  for (const m of moves.add.filter(valid)) {
    const live = liveFile(m);
    if (typeof m.sha256 !== "string" || stagedFile(op, m).exists || !live.exists) continue;
    if (live.size === m.bytes && (await native.hashFile(live.uri)) === m.sha256)
      placed.add(moveKey(m));
  }
  return placed;
}

/**
 * Finishes the moves of a restore that committed (crash roll-forward). The commit section completes them before it
 * commits, so this only matters after an interrupted write. A name that is both displaced and added is displaced
 * only while its staged copy still waits: once the add happened, the live file is the restored one.
 */
export function forwardMediaSync(op: string, moves: MediaMoves, recoveryId: string | null): void {
  const added = new Set(moves.add.map((m) => `${m.set}/${m.name}`));
  if (recoveryId)
    everyStep(moves.remove, (m) => {
      if (added.has(`${m.set}/${m.name}`) && !stagedFile(op, m).exists) return;
      moveIfPending(liveFile(m), displacedFile(recoveryId, m));
    });
  everyStep(moves.add, (m) => moveIfPending(stagedFile(op, m), liveFile(m)));
}

// ---------------------------------------------------------------------------------------------------------------
// The plan

export interface MediaPlanInput {
  /** The live connection: the rows the restore replaces, and their files. */
  live: SqlReader;
  /** The restore's operation id (its staging folder is work/<op>/stage/). */
  op: string;
  /** Media sets whose table the restore replaces (spec §2.10 rule 6). */
  sets: readonly VaultMediaSet[];
  /** Per set: the names the restored rows reference. */
  refs: ReadonlyMap<string, readonly unknown[]>;
  /** The archive's media items (v2); legacy restores have none. */
  manifest: Manifest | null;
  /** The archive's own entries (embedded media). */
  reader: ArchiveReader | null;
  /** More media after the archive's own: a recovery set, a cloud provider. */
  source?: MediaSource;
  /** handoff: an item no source can supply yet, with no live file, fails `peerNotReady` instead of being skipped. */
  requireAll: boolean;
  signal?: AbortSignal;
  onProgress?: (p: Progress) => void;
}

/**
 * Decides, per name the restored rows reference: KEEP (the live file equals the archive's), ADD (a verified copy is
 * staged; a live file of that name with other content is displaced), KEEP-LIVE (no source has it, the live file
 * stays) or skipped (nobody has it). REMOVE = the live rows' files that no restored row keeps, plus files an ADD
 * displaces. Orphan files (referenced by no live row) are never touched otherwise. Nothing changes here except the
 * staging folder.
 */
export async function planMedia(input: MediaPlanInput): Promise<MediaPlan> {
  const { live, op, signal } = input;
  const native = vaultNative();
  const plan: MediaPlan = {
    remove: [],
    add: [],
    known: new Map(),
    restored: 0,
    skipped: 0,
    keptLive: 0,
  };
  const hashOf = async (file: File): Promise<MediaHash | null> =>
    file.exists ? { bytes: file.size, sha256: await native.hashFile(file.uri) } : null;
  const total = input.sets.reduce((sum, s) => sum + (input.refs.get(s.set)?.length ?? 0), 0);
  let done = 0;

  /** Copies `item` into the staging folder from the first source that has it, verified; false when none has. */
  const stage = async (item: ManifestMedia, dest: File): Promise<boolean> => {
    const verified = async () =>
      dest.exists && dest.size === item.bytes && (await native.hashFile(dest.uri)) === item.sha256;
    ensureDir(dest.parentDirectory);
    removeFile(dest);
    const entry = `media/${item.set}/${item.name}`;
    if (item.embedded && input.reader?.has(entry)) {
      try {
        await input.reader.extract(entry, dest, item.bytes, signal);
        if (await verified()) return true;
      } catch (e) {
        // A damaged copy in the archive: another source may still have the file.
        if (!(e instanceof VaultError && e.code === "corrupt")) throw e;
      }
      removeFile(dest);
    }
    if (input.source) {
      if ((await input.source.fetch(item, dest, signal)) && (await verified())) return true;
      removeFile(dest);
    }
    return false;
  };

  for (const set of input.sets) {
    const folder = mediaDir(set.directory);
    // The live rows' files, hashed once.
    const current: string[] = [];
    for (const value of referencedMedia(live, set)) {
      if (typeof value !== "string" || !MEDIA_NAME.test(value)) continue;
      const hash = await hashOf(new File(folder, value));
      if (!hash) continue;
      current.push(value);
      plan.known.set(`${set.set}/${value}`, hash);
    }
    const items = new Map(
      (input.manifest?.media ?? []).filter((m) => m.set === set.set).map((m) => [m.name, m])
    );
    const kept = new Set<string>();
    const displaced = new Set<string>();
    for (const value of input.refs.get(set.set) ?? []) {
      checkAborted(signal);
      input.onProgress?.({ step: "media", done: done++, total });
      const name = String(value);
      // A name outside the media grammar is never looked up: it could name a path.
      if (typeof value !== "string" || !MEDIA_NAME.test(name)) {
        plan.skipped++;
        continue;
      }
      const item = items.get(name);
      const liveHash =
        plan.known.get(`${set.set}/${name}`) ?? (await hashOf(new File(folder, name)));
      if (item && liveHash?.bytes === item.bytes && liveHash.sha256 === item.sha256) {
        kept.add(name);
        continue;
      }
      if (item && (await stage(item, stagedFile(op, item)))) {
        plan.add.push({ set: set.set, name, bytes: item.bytes, sha256: item.sha256 });
        plan.restored++;
        if (liveHash) displaced.add(name);
        continue;
      }
      if (liveHash) {
        kept.add(name);
        plan.keptLive++;
        continue;
      }
      if (item && input.requireAll)
        throw new VaultError("peerNotReady", { detail: `${set.set}/${name}` });
      plan.skipped++;
    }
    for (const name of new Set([...current.filter((n) => !kept.has(n)), ...displaced]))
      plan.remove.push({ set: set.set, name });
  }
  if (total) input.onProgress?.({ step: "media", done: total, total });
  return plan;
}
