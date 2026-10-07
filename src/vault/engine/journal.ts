// The crash journal of a restore (docs/vault.md, "Recovery sets and the crash journal"; spec §3.10):
// PendumVault/journal.json, written atomically at the start of the commit section and cleared once every step after
// the commit is done. The swap writes `_vault_state["restore.lastOp"] = op` in its own transaction, so at the next
// start the journal tells exactly what happened: the marker equals its op → the swap committed → roll forward (finish
// the media moves, package the recovery set, announceChange, afterRestore); otherwise → roll back (media back into
// place, the partial recovery set deleted). recoverJournal() runs only under the vault lock and never for an
// operation still running in this JS runtime, then removes what earlier runs left behind.
import { File } from "expo-file-system";
import type { SQLiteDatabase } from "expo-sqlite";

import { vaultApp } from "../app";
import type { Progress, RestoreContext } from "../types";

import { busyWith } from "./lock";
import {
  forwardMediaSync,
  placedAdds,
  rollbackMediaSync,
  type MediaHash,
  type MediaMove,
  type MediaMoves,
} from "./media";
import {
  ensureDir,
  isLiveOp,
  journalFile,
  recoveryPartialDir,
  removeFile,
  removeLeftovers,
  utcStamp,
  VAULT_ID,
  vaultDir,
} from "./paths";
import {
  displacedHashes,
  packageRecoverySet,
  partialsHoldingMedia,
  removeRecoveryPartialSync,
} from "./recovery";
import { readState } from "./state";

/** The steps after the commit, in their order; each is recorded in `done` once it succeeded. */
export type JournalStep = "package" | "legacyCopy" | "announce" | "afterRestore";

/** A RestoreContext as JSON (`now` as an ISO string): roll-forward hands it to afterRestore again. */
export type JournalContext = Omit<RestoreContext, "now"> & { now: string };

export interface RestoreJournal {
  /** The restore's operation id: work/<op>/ holds its staged media; `restore.lastOp` equals it once it committed. */
  op: string;
  type: "restore";
  phase: "applying";
  /** recovery/<id>.partial/ of this restore, or null (empty library). */
  recoveryId: string | null;
  plan: MediaMoves;
  /** Steps after the commit already done. */
  done: JournalStep[];
  /** Crash roll-forward attempts of announceChange and afterRestore (they get one, then they are skipped). */
  attempts: number;
  startedAt: string;
  context: JournalContext;
  /** A v1 pre-restore copy this restore supersedes (deleted once it committed), as a file:// URI. */
  legacyCopy: string | null;
}

const warn = (where: string, e: unknown) => console.warn("[vault]", where, e);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isMoves = (v: unknown): v is MediaMove[] =>
  Array.isArray(v) &&
  v.every((m) => isRecord(m) && typeof m.set === "string" && typeof m.name === "string");
const isId = (v: unknown): v is string => typeof v === "string" && VAULT_ID.test(v);

/** The journal, or null when there is none or it is not one this vault wrote. */
export function readJournal(): RestoreJournal | null {
  const file = journalFile();
  if (!file.exists) return null;
  let value: unknown;
  try {
    value = JSON.parse(file.textSync());
  } catch {
    return null;
  }
  if (!isRecord(value) || !isRecord(value.plan) || !isRecord(value.context)) return null;
  const valid =
    isId(value.op) &&
    value.type === "restore" &&
    (value.recoveryId === null || isId(value.recoveryId)) &&
    isMoves(value.plan.remove) &&
    isMoves(value.plan.add) &&
    Array.isArray(value.done) &&
    typeof value.attempts === "number" &&
    typeof value.context.now === "string" &&
    (value.legacyCopy === null || typeof value.legacyCopy === "string");
  return valid ? (value as unknown as RestoreJournal) : null;
}

/** Writes the journal atomically: a temporary file moved over the old one. Synchronous (commit section). */
export function journalWriteSync(journal: RestoreJournal): void {
  const temp = new File(ensureDir(vaultDir()), "journal.json.tmp");
  temp.create({ overwrite: true });
  temp.write(`${JSON.stringify(journal, null, 2)}\n`);
  temp.moveSync(journalFile(), { overwrite: true });
}

/** Deletes the journal (no-op when there is none). */
export function journalClearSync(): void {
  removeFile(journalFile());
}

export const journalContext = (ctx: RestoreContext): JournalContext => ({
  ...ctx,
  now: ctx.now.toISOString(),
});

const contextOf = (journal: RestoreJournal): RestoreContext => ({
  ...journal.context,
  now: new Date(journal.context.now),
});

/**
 * The steps after a committed swap (spec §3.5.3 step 9), each recorded in the journal when done: package the
 * recovery set, delete the superseded v1 copy, announceChange, afterRestore. The journal is cleared when the set is
 * packaged and the other steps ran; a failed step leaves it for recoverJournal. In the restore itself a failed
 * announceChange or afterRestore keeps the journal for one retry at the next start (`recovering`); after that retry
 * they are logged and skipped. Packaging is retried at every start until it succeeds (a full disk keeps the raw set
 * `.partial`, never offered). `failed` is the restore's `afterRestoreFailed` warning.
 */
export async function finishRestore(
  journal: RestoreJournal,
  options: {
    recovering: boolean;
    /** The media plan's hashes of the live files (the restore itself); roll-forward hashes the displaced ones. */
    known?: Map<string, MediaHash>;
    onProgress?: (p: Progress) => void;
  }
): Promise<{ recoveryId: string | null; failed: boolean }> {
  const done = new Set(journal.done);
  const save = () => {
    journal.done = [...done];
    journalWriteSync(journal);
  };
  let failed = false;
  if (journal.recoveryId && !done.has("package")) {
    options.onProgress?.({ step: "recovery" });
    try {
      const known = options.known ?? (await displacedHashes(journal.recoveryId));
      await packageRecoverySet(journal.recoveryId, known);
      done.add("package");
      save();
    } catch (e) {
      failed = true;
      warn("package", e);
    }
  }
  if (journal.legacyCopy && !done.has("legacyCopy")) {
    try {
      removeFile(new File(journal.legacyCopy));
    } catch (e) {
      warn("legacyCopy", e);
    }
    done.add("legacyCopy");
    save();
  }
  options.onProgress?.({ step: "finish" });
  const others = (["announce", "afterRestore"] as const).filter((step) => !done.has(step));
  let run = true;
  if (others.length && options.recovering) {
    if (journal.attempts >= 1) {
      run = false;
      warn("skipped", others);
    } else {
      journal.attempts += 1;
      save();
    }
  }
  if (run)
    for (const step of others)
      try {
        if (step === "announce") await vaultApp.database.announceChange?.();
        else await vaultApp.hooks.afterRestore(contextOf(journal));
        done.add(step);
        save();
      } catch (e) {
        failed = true;
        warn(step, e);
      }
  const packaged = !journal.recoveryId || done.has("package");
  const settled = options.recovering || (done.has("announce") && done.has("afterRestore"));
  if (packaged && settled) journalClearSync();
  else save();
  return {
    recoveryId: journal.recoveryId && done.has("package") ? journal.recoveryId : null,
    failed,
  };
}

/**
 * Crash recovery, the first step of ensureReady: rolls the journal of an interrupted restore forward or back, then
 * deletes leftovers — every work/<op> and recovery/<id>.partial that is neither live nor named by a journal, except a
 * partial set still holding displaced photos (their only copy), and cached exports older than 24 h. A raw set the
 * swap named `recovery.latest` whose journal is gone is packaged instead. Errors are logged, not thrown: an
 * unfinished journal stays and is retried at the next start (runRestore refuses to start meanwhile).
 */
export async function recoverJournal(db: SQLiteDatabase): Promise<void> {
  if (busyWith() === null) throw new Error("vault: recoverJournal runs only under the vault lock");
  const journal = readJournal();
  if (!journal && journalFile().exists) {
    // Not one this vault wrote completely: set it aside; partial sets holding photos are kept below.
    try {
      journalFile().moveSync(
        new File(vaultDir(), `journal-unreadable-${utcStamp(new Date())}.json`)
      );
    } catch (e) {
      warn("journal", e);
    }
  }
  if (journal && !isLiveOp(journal.op))
    try {
      if (readState(db, "restore.lastOp") === journal.op) {
        forwardMediaSync(journal.op, journal.plan, journal.recoveryId);
        await finishRestore(journal, { recovering: true });
      } else {
        // Only the live files that are provably this restore's go back to the stage (never the user's originals).
        const placed = await placedAdds(journal.op, journal.plan);
        rollbackMediaSync(journal.op, journal.plan, journal.recoveryId, placed);
        if (journal.recoveryId && !removeRecoveryPartialSync(journal.recoveryId))
          warn("rollback", `recovery/${journal.recoveryId}.partial still holds photos; kept`);
        journalClearSync();
      }
    } catch (e) {
      warn("recoverJournal", e);
    }

  const pending = readJournal();
  const keep = pending?.recoveryId ? [pending.recoveryId] : [];
  const latest = readState(db, "recovery.latest");
  if (latest && !keep.includes(latest) && recoveryPartialDir(latest).exists)
    try {
      await packageRecoverySet(latest, await displacedHashes(latest));
    } catch (e) {
      keep.push(latest);
      warn("package", e);
    }
  try {
    removeLeftovers({
      ops: pending ? [pending.op] : [],
      recoveries: [...keep, ...partialsHoldingMedia()],
    });
  } catch (e) {
    warn("cleanup", e);
  }
}
