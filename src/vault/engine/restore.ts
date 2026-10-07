// restoreArchive() (docs/vault.md, "Restore"; spec §3.5.3): the whole pipeline, with the app's Health sync held off.
// Everything that can fail runs before the commit section and changes nothing live: extract and verify the data,
// build and check the scratch database, plan the swap, stage the media. The commit section (swap.ts) then changes
// rows, media and vault state together or not at all. A failure after the commit is never reported as a failed
// restore ("nothing was changed" would be false): it becomes the `afterRestoreFailed` warning, and the crash journal
// retries what is left at the next start.
//
// Lock-free: callers hold exclusive("restore") and ran ensureReady (runRestore in ops.ts), so the live database has a
// device id and a library id and no earlier restore is half done.
import { Directory, File, Paths } from "expo-file-system";
import type { SQLiteDatabase } from "expo-sqlite";

import { vaultApp } from "../app";
import { checkAborted, VaultError } from "../errors";
import { loadDeviceInfo, vaultNative } from "../native";
import type {
  Manifest,
  OpenedArchive,
  RestoreContext,
  RestoreOptions,
  RestoreResult,
  SqlReader,
  VaultSql,
} from "../types";

import { columnNames, isAutoincrement, schemaState, tableExists } from "./db";
import { freshInstallation } from "./device";
import { healthSyncOn, MEDIA_NAME } from "./export";
import { archiveContents, holdArchive, type ArchiveContents } from "./inspect";
import { finishRestore, journalContext, readJournal, type RestoreJournal } from "./journal";
import { planMedia, STAGE } from "./media";
import {
  endOp,
  engineEnv,
  ensureDir,
  fsPath,
  mediaDir,
  newOpId,
  removeDir,
  workDir,
} from "./paths";
import { installationOverrides, provenanceSwap } from "./provenance";
import {
  buildScratch,
  installationPreferences,
  provenanceOf,
  type ScratchResult,
  type ScratchSource,
} from "./scratch";
import { CLOCK_TABLE } from "./snapshot";
import { readState, refreshVaultState } from "./state";
import {
  commitRestore,
  crashPoint,
  restoreError,
  SimulatedCrash,
  type SwapPlan,
  type SwapTable,
} from "./swap";

/** How long a restore waits for a running Health sync to finish. */
const HEALTH_PAUSE_MS = 120_000;
/** Free space kept beyond what a restore writes. */
const MARGIN = 64 * 1024 * 1024;

/**
 * Runs `work` while the app's Health sync is held off (spec §3.11): any error while acquiring the pause (a sync that
 * does not go idle in time, the app's own "wait for Health sync" error) is `healthBusy`; errors of `work` pass
 * through; a result `work` produced is never lost to an error of the pause's own cleanup.
 */
export async function pauseHealth<T>(work: () => Promise<T>): Promise<T> {
  const run: { started: boolean; done: boolean; value?: T } = { started: false, done: false };
  try {
    await vaultApp.hooks.pauseWhenIdle(async () => {
      run.started = true;
      const value = await work();
      run.done = true;
      run.value = value;
      return value;
    }, HEALTH_PAUSE_MS);
  } catch (e) {
    if (!run.started) throw new VaultError("healthBusy", { cause: e });
    if (!run.done) throw e;
    console.warn("[vault]", "pauseWhenIdle", e);
  }
  if (!run.done) throw new VaultError("healthBusy", { detail: "notRun" });
  return run.value as T;
}

/** The v1 pre-restore copy a v2 restore supersedes (spec §3.9), as a file:// URI. */
function legacyCopyOf(db: SqlReader): string | null {
  try {
    return vaultApp.legacy?.recoveryCopy(db)?.file.uri ?? null;
  } catch {
    return null;
  }
}

/** Bytes of incoming media that are not already live with the same size (staged copies need room). */
function mediaToAdd(manifest: Manifest): number {
  let bytes = 0;
  for (const item of manifest.media) {
    const set = vaultApp.media?.find((m) => m.set === item.set);
    if (!set || !MEDIA_NAME.test(item.name)) continue;
    const live = new File(mediaDir(set.directory), item.name);
    if (!live.exists || live.size !== item.bytes) bytes += item.bytes;
  }
  return bytes;
}

/**
 * Step 2: extracted data + the scratch (about the same again) + the recovery snapshot (the live database's used
 * pages) + staged media + a margin.
 */
function checkSpace(db: SQLiteDatabase, archive: OpenedArchive): void {
  const used =
    db.getFirstSync<{ used: number }>(
      "SELECT (page_count - freelist_count) * page_size AS used FROM pragma_page_count(), pragma_page_size(), pragma_freelist_count()"
    )?.used ?? 0;
  const { manifest } = archive;
  const data = manifest
    ? manifest.tables.reduce((sum, t) => sum + t.bytes, 0)
    : archive.source.exists
      ? archive.source.size
      : 0;
  const need = data * 2 + used + (manifest ? mediaToAdd(manifest) : 0) + MARGIN;
  if (Paths.availableDiskSpace < need) throw new VaultError("insufficientSpace", { bytes: need });
}

/** Steps 3–4: every table file extracted (bounded) and checked against the manifest's size and SHA-256. */
async function extractData(
  manifest: Manifest,
  contents: ArchiveContents,
  work: Directory,
  options: RestoreOptions
): Promise<Map<string, File>> {
  const { reader } = contents;
  if (!reader) throw new VaultError("corrupt", { detail: "reader" });
  const native = vaultNative();
  const dir = ensureDir(new Directory(work, "data"));
  const data = new Map<string, File>();
  for (const [i, t] of manifest.tables.entries()) {
    checkAborted(options.signal);
    options.onProgress?.({ step: "verify", done: i, total: manifest.tables.length });
    const file = new File(dir, `${t.name}.ndjson`);
    const bytes = await reader.extract(t.file, file, t.bytes, options.signal);
    if (bytes !== t.bytes || (await native.hashFile(file.uri)) !== t.sha256)
      throw new VaultError("corrupt", { detail: `hash:${t.file}` });
    data.set(t.name, file);
  }
  options.onProgress?.({
    step: "verify",
    done: manifest.tables.length,
    total: manifest.tables.length,
  });
  return data;
}

/**
 * The swap's tables (spec §3.7): replaced tables in descriptor order with explicit column lists = the live columns
 * minus device columns, every one of which the scratch must have (a missing one is a pipeline bug, never silently
 * dropped: `unknownSchema`). keys mode: the archive's key universe ∩ the descriptor's (legacy: the adapter's keys),
 * so a key introduced after the archive was written keeps this device's value; a table created after the archive's
 * level is empty in it, so its whole universe is replaced.
 */
function swapTables(
  live: SQLiteDatabase,
  scratch: ScratchResult,
  manifest: Manifest | null
): SwapTable[] {
  const scopes = new Map((vaultApp.legacy?.tables ?? []).map((t) => [t.name, t.scope]));
  return vaultApp.tables
    .filter((t) => scratch.replaced.includes(t.name))
    .map((t): SwapTable => {
      const incoming = scratch.columns.get(t.name) ?? [];
      const device = new Set(t.deviceColumns ?? []);
      const columns = columnNames(live, t.name).filter((c) => !device.has(c));
      const missing = columns.find((c) => !incoming.includes(c));
      if (missing) throw new VaultError("unknownSchema", { detail: `column:${t.name}.${missing}` });
      const entry = manifest?.tables.find((m) => m.name === t.name);
      if (t.mode === "keys") {
        if (!t.keys) throw new VaultError("restoreFailed", { detail: `descriptor:${t.name}` });
        const universe = !manifest
          ? (vaultApp.legacy?.preferenceKeys ?? [])
          : entry
            ? (entry.keys ?? scratch.keys.get(t.name) ?? [])
            : t.keys.include;
        const include = t.keys.include;
        return {
          mode: "keys",
          name: t.name,
          keyColumn: t.keys.keyColumn,
          valueColumn: t.keys.valueColumn,
          keys: [...new Set(universe)].filter((k) => include.includes(k)),
        };
      }
      if (t.mode === "singleton") {
        if (!t.singleton) throw new VaultError("restoreFailed", { detail: `descriptor:${t.name}` });
        const { idColumn, where } = t.singleton;
        return {
          mode: "singleton",
          name: t.name,
          idColumn,
          where,
          columns: columns.filter((c) => c !== idColumn),
        };
      }
      return {
        mode: "replace",
        name: t.name,
        columns,
        scope: manifest ? undefined : scopes.get(t.name),
        autoincrement: isAutoincrement(live, t.name),
        sequence: manifest ? (entry?.sequence ?? 0) : null,
      };
    });
}

/** Everything the commit section writes, decided before it starts. */
function swapPlan(
  live: SQLiteDatabase,
  op: string,
  scratch: ScratchResult,
  manifest: Manifest | null,
  media: SwapPlan["media"],
  legacyCopy: string | null
): SwapPlan {
  const ctx = scratch.context;
  const scope = manifest
    ? undefined
    : vaultApp.legacy?.tables.find((t) => t.name === "health_links")?.scope;
  const merge =
    vaultApp.health && scratch.replaced.includes("health_links")
      ? provenanceSwap(vaultApp.health, ctx, scope)
      : { before: [], after: [] };
  const hook = vaultApp.swap?.(ctx) ?? {};
  const prefs = installationPreferences();
  const overrides = [
    ...(ctx.legacy ? (vaultApp.legacy?.overrides(ctx) ?? []) : vaultApp.deviceOverrides(ctx)),
    ...(vaultApp.health && prefs ? installationOverrides(ctx, prefs) : []),
  ];
  // Legacy files and archives without one keep the current library; every other restore joins the archive's.
  const libraryId = manifest?.library.id ?? readState(live, "library.id");
  if (!libraryId) throw new VaultError("restoreFailed", { detail: "notReady" });
  const state: Record<string, string | VaultSql> = {
    "restore.lastOp": op,
    "library.id": libraryId,
  };
  if (tableExists(live, CLOCK_TABLE)) {
    // M3 lineage (spec §9.5), committed with the rows; ownBase is read after the swap's counter bump.
    state["lineage.vector"] = JSON.stringify(manifest?.library.vector ?? {});
    if (manifest)
      state["lineage.adoptedFrom"] = JSON.stringify({
        deviceId: manifest.device.id,
        ...(manifest.library.seq === undefined ? {} : { seq: manifest.library.seq }),
      });
    state["lineage.ownBase"] = { sql: 'SELECT "seq" FROM "_vault_clock" WHERE "id" = 1' };
    state["handoff.emptyOffered"] = "0";
  }
  const journal: Omit<RestoreJournal, "recoveryId" | "plan"> = {
    op,
    type: "restore",
    phase: "applying",
    done: [],
    attempts: 0,
    startedAt: ctx.now.toISOString(),
    context: journalContext(ctx),
    legacyCopy,
  };
  return {
    tables: swapTables(live, scratch, manifest),
    before: [...merge.before, ...(hook.before ?? [])],
    after: [...merge.after, ...(hook.after ?? [])],
    overrides,
    state,
    opId: op,
    media,
    kept: manifest ? scratch.kept : [],
    journal,
  };
}

/**
 * Step 10: deletes the restore's work folder. While the crash journal still names this restore (a rollback in the
 * commit section, or a step after the commit, could not finish) its staged copies stay: they are how recoverJournal
 * tells a photo the restore put in place from the user's original of the same name. The extracted data and the
 * scratch go either way; the next start's cleanup removes the rest once the journal is done.
 */
function removeWork(op: string, work: Directory): void {
  if (readJournal()?.op !== op) removeDir(work);
  else if (work.exists) for (const entry of work.list()) if (entry.name !== STAGE) entry.delete();
}

/** The pipeline on the vault's connection (steps 1–9). */
async function restoreOn(
  db: SQLiteDatabase,
  archive: OpenedArchive,
  contents: ArchiveContents,
  op: string,
  work: Directory,
  options: RestoreOptions
): Promise<RestoreResult> {
  const { signal, onProgress } = options;
  const { manifest } = archive;

  // 1. The live state the restore starts from.
  const state = schemaState(db, vaultApp.migrations.journal);
  if (state.pending > 0 || state.applied < 1)
    throw new VaultError("migrationPending", {
      detail: `${state.applied}/${vaultApp.migrations.journal.entries.length}`,
    });
  const device = await loadDeviceInfo();
  const healthWasOn = healthSyncOn(db);
  await vaultApp.hooks.beforeExport?.(db);
  const now = new Date();
  const deviceId = readState(db, "device.id");
  const context: Omit<RestoreContext, "incoming"> = {
    reason: options.reason,
    legacy: archive.format === "legacy",
    crossPlatform: !!manifest && manifest.app.platform !== device.platform,
    sameDevice: !!manifest && !!deviceId && manifest.device.id === deviceId,
    healthWasOn,
    platform: device.platform,
    now,
    live: provenanceOf(db),
    freshInstallation: freshInstallation(now),
  };
  const legacyCopy = manifest ? legacyCopyOf(db) : null;
  ensureDir(work);

  // 2–4. Room, then the archive's data, verified.
  checkSpace(db, archive);
  let source: ScratchSource;
  if (manifest)
    source = {
      format: "v2",
      manifest,
      applied: contents.applied,
      data: await extractData(manifest, contents, work, options),
    };
  else if (contents.legacy) source = { format: "legacy", parsed: contents.legacy.parsed };
  else throw new VaultError("corrupt", { detail: "legacy" });

  // 5. The scratch database: replayed, migrated, repaired, checked, closed.
  const scratch = await buildScratch({ work, source, context, signal, onProgress });

  // 6. Media: staged and verified copies; nothing live moves yet.
  const media = await planMedia({
    live: db,
    op,
    sets: (vaultApp.media ?? []).filter((m) => scratch.replaced.includes(m.table)),
    refs: scratch.refs,
    manifest,
    reader: contents.reader,
    source: options.media,
    requireAll: options.requireAllMedia === true,
    signal,
    onProgress,
  });
  const plan = swapPlan(
    db,
    op,
    scratch,
    manifest,
    { remove: media.remove, add: media.add },
    legacyCopy
  );

  // 7. The last cancellation point.
  checkAborted(signal);

  // 8. The commit section.
  onProgress?.({ step: "swap" });
  const recoveryId = commitRestore(db, fsPath(scratch.file), plan);

  // 9. Committed: from here on nothing is reported as a failed restore.
  crashPoint("afterCommit");
  let failed = false;
  let recovery: string | null = null;
  try {
    refreshVaultState(db);
    const finished = await finishRestore(
      { ...plan.journal, recoveryId, plan: plan.media },
      { recovering: false, known: media.known, onProgress }
    );
    recovery = finished.recoveryId;
    failed = finished.failed;
  } catch (e) {
    failed = true;
    console.warn("[vault]", "afterRestore", e);
  }
  return {
    recoveryId: recovery,
    mediaRestored: media.restored,
    mediaSkipped: media.skipped,
    mediaKeptLive: media.keptLive,
    healthWasOn,
    libraryId: String(plan.state["library.id"]),
    repairs: scratch.repairs,
    warning: failed ? "afterRestoreFailed" : null,
  };
}

/**
 * Restores an archive openArchive returned (spec §3.5.3). The archive's private copy is held until the restore ends,
 * even if the UI closes it meanwhile. `signal` is honoured until the commit section starts, never after. Errors (before
 * the commit; nothing changed): a VaultError as thrown (`healthBusy`, `migrationPending`, `insufficientSpace`,
 * `corrupt`, `unknownSchema`, `invalidData`, `peerNotReady`, `busy`, `cancelled`), anything else as `restoreFailed`.
 */
export async function restoreArchive(
  archive: OpenedArchive,
  options: RestoreOptions
): Promise<RestoreResult> {
  const op = newOpId();
  const work = workDir(op);
  let release: (() => void) | null = null;
  let crashed = false;
  try {
    const contents = archiveContents(archive);
    release = holdArchive(archive);
    checkAborted(options.signal);
    return await pauseHealth(async () => {
      const env = engineEnv();
      const db = await env.acquire();
      try {
        return await restoreOn(db, archive, contents, op, work, options);
      } finally {
        try {
          await env.release(db);
        } catch (e) {
          // Never turns a committed restore into a failed one.
          console.warn("[vault]", "release", e);
        }
      }
    });
  } catch (e) {
    if (e instanceof SimulatedCrash) {
      crashed = true;
      throw e;
    }
    throw restoreError(e);
  } finally {
    release?.();
    // A simulated crash leaves its files and its live operation as a killed process would.
    if (!crashed) {
      try {
        removeWork(op, work);
      } catch {
        // the next start removes it: its operation is no longer live
      }
      endOp(op);
    }
  }
}
