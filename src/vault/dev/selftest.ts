// The on-device self-test (docs/vault.md, "Tests"; spec §13.6): the restore pipeline's safety cases with the real
// native modules, run against a COPY of the live database (VACUUM INTO) and of up to five live photos, never against
// the live ones. Offered by a Settings row in development builds, or in any build made with the plugin option
// `selftest: true`.
//
// While it runs it holds the vault lock ("selftest"), points the engine environment at the copy and a private
// documents folder (photos, recovery sets, journal, a copy of the device anchor), and swaps the descriptor's hooks
// that reach outside the database — the Health pause, water's watch-queue flush, afterRestore, announceChange, the v1
// pre-restore copy — for neutral ones, so nothing outside the copy changes. Engine functions run directly (the lock
// is already held). Development tooling: its labels are English and not in the vault string table.
import { Directory, File, FileMode } from "expo-file-system";
import { openDatabaseSync, type SQLiteDatabase } from "expo-sqlite";

import { vaultApp, vaultIdentity } from "../app";
import { exportArchive, MEDIA_NAME, referencedMedia } from "../engine/export";
import { openArchive, verifyArchive } from "../engine/inspect";
import { readJournal, recoverJournal, type RestoreJournal } from "../engine/journal";
import { exclusive } from "../engine/lock";
import {
  anchorFile,
  endOp,
  engineEnv,
  ensureDir,
  fsPath,
  mediaDir,
  newOpId,
  recoveryDir,
  recoveryRoot,
  removeDir,
  removeFile,
  setEngineEnv,
  VAULT_FOLDER,
  workDir,
} from "../engine/paths";
import { ensureReady } from "../engine/ready";
import { latestRecovery } from "../engine/recovery";
import { restoreArchive } from "../engine/restore";
import { takeSnapshot } from "../engine/snapshot";
import { readState, refreshVaultState } from "../engine/state";
import { simulateCrash, SimulatedCrash, type CrashPoint } from "../engine/swap";
import { VaultError } from "../errors";
import { nativeConfig, vaultNative, vaultSupported } from "../native";
import type { Manifest, RestoreResult, VaultMediaSet } from "../types";

/** The Settings row and panel title (development tooling, English only). */
export const SELF_TEST_TITLE = "Vault self-test";

/** The hashFile check: 50 MiB where byte p is p mod 251 (a period that does not divide the 1 MiB reads). */
const HASH_BYTES = 50 * 1024 * 1024;
const PATTERN = 251;
const HASH_DIGEST = "3a7aef326b898081e6fb7b9599db2618b4f5e5301b64078f0f4e1f5382f634b9";
const MIB = 1024 * 1024;
const MAX_PHOTOS = 5;

export type SelfTestOutcome = "pass" | "fail" | "skip";

export type SelfTestResult = {
  id: string;
  label: string;
  outcome: SelfTestOutcome;
  ms: number;
  /** What passed (a count, a speed) or why it failed or was skipped. */
  detail: string;
};

export type SelfTestState = { running: boolean; results: readonly SelfTestResult[] };

/** Whether Settings offers the self-test: development builds, or the plugin option `selftest: true`. */
export function selfTestAvailable(): boolean {
  return vaultSupported && (__DEV__ || nativeConfig().selftest);
}

// ---------------------------------------------------------------------------------------------------------------
// The bench: a copy of the live database and photos, with the engine pointed at it

interface Bench {
  db: SQLiteDatabase;
  work: Directory;
  /** PRAGMA foreign_keys of the app's connection (lift opens with it on). */
  foreignKeys: boolean;
  /** The live photos copied into the bench's documents folder. */
  photos: { set: VaultMediaSet; name: string }[];
  /** G1's archive, restored again by the later cases. */
  first: Written | null;
}

type Written = { file: File; manifest: Manifest };

class Skip extends Error {}

function expect(ok: unknown, detail: string): asserts ok {
  if (!ok) throw new Error(detail);
}

function needFirst(bench: Bench): Written {
  if (!bench.first) throw new Skip("needs G1's archive");
  return bench.first;
}

async function exportTo(
  bench: Bench,
  name: string,
  options: { embedMedia: boolean; csv: boolean; deflateLevel: 1 | 6 }
): Promise<Written> {
  const destination = new File(bench.work, `${name}.${vaultIdentity.extension}`);
  removeFile(destination);
  const result = await exportArchive({ kind: "manual", destination, language: "en", ...options });
  if (!result.file || !result.manifest) throw new Error(`${name}: no file written`);
  return { file: result.file, manifest: result.manifest };
}

async function restoreFrom(file: File): Promise<RestoreResult> {
  const archive = await openArchive(file);
  try {
    return await restoreArchive(archive, { reason: "file" });
  } finally {
    archive.close();
  }
}

/** The first user-record table whose exported rows differ between two manifests, or null. */
function dataDiff(a: Manifest, b: Manifest): string | null {
  for (const table of vaultApp.tables) {
    if (table.role !== "data") continue;
    const x = a.tables.find((t) => t.name === table.name);
    const y = b.tables.find((t) => t.name === table.name);
    if (x?.sha256 !== y?.sha256 || x?.rows !== y?.rows) return table.name;
  }
  return null;
}

/** Exports the bench again (no photos, no CSV) and compares its user records with G1's archive. */
async function expectFirstData(bench: Bench, first: Written): Promise<void> {
  const again = await exportTo(bench, "again", { embedMedia: false, csv: false, deflateLevel: 1 });
  removeFile(again.file);
  const differs = dataDiff(first.manifest, again.manifest);
  expect(!differs, `table ${differs} differs from the archive`);
}

/** SHA-256 of a VACUUM INTO copy: equal ⇔ the database did not change. */
async function dbHash(bench: Bench): Promise<string> {
  const file = new File(bench.work, "compare.db");
  removeFile(file);
  bench.db.runSync("VACUUM INTO ?", [fsPath(file)]);
  try {
    return await vaultNative().hashFile(file.uri);
  } finally {
    removeFile(file);
  }
}

/** Every photo in the bench's media folders with its SHA-256, as one comparable text. */
async function mediaState(): Promise<string> {
  const native = vaultNative();
  const lines: string[] = [];
  for (const set of vaultApp.media ?? []) {
    const dir = mediaDir(set.directory);
    if (!dir.exists) continue;
    for (const entry of dir.list())
      if (entry instanceof File)
        lines.push(`${set.set}/${entry.name}:${await native.hashFile(entry.uri)}`);
  }
  return lines.sort().join("\n");
}

function partialSets(): string[] {
  const root = recoveryRoot();
  return root.exists
    ? root
        .list()
        .map((e) => e.name)
        .filter((name) => name.endsWith(".partial"))
    : [];
}

/** Restores `file` with a simulated process death at `point`, then forgets the restore as a new process would. */
async function crash(file: File, point: CrashPoint): Promise<RestoreJournal> {
  const archive = await openArchive(file);
  simulateCrash(point);
  try {
    await restoreArchive(archive, { reason: "file" });
  } catch (e) {
    if (!(e instanceof SimulatedCrash)) throw e;
  } finally {
    simulateCrash(null);
    archive.close();
  }
  const journal = readJournal();
  expect(journal, `no crash journal after a crash ${point}`);
  endOp(journal.op);
  return journal;
}

// ---------------------------------------------------------------------------------------------------------------
// Cases

/** native hashFile over a generated 50 MiB file with a known digest (and its speed). */
async function hashCase(bench: Bench): Promise<string> {
  const file = new File(bench.work, "pattern.bin");
  removeFile(file);
  file.create();
  const handle = file.open(FileMode.WriteOnly);
  try {
    const pattern = new Uint8Array(MIB + PATTERN);
    for (let i = 0; i < pattern.length; i++) pattern[i] = i % PATTERN;
    for (let offset = 0; offset < HASH_BYTES; offset += MIB) {
      const start = offset % PATTERN;
      handle.writeBytes(pattern.slice(start, start + MIB));
    }
  } finally {
    handle.close();
  }
  const started = Date.now();
  const digest = await vaultNative().hashFile(file.uri);
  const ms = Math.max(1, Date.now() - started);
  removeFile(file);
  expect(digest === HASH_DIGEST, `digest ${digest}`);
  return `${Math.round(HASH_BYTES / 1000 / ms)} MB/s`;
}

/** G1: a manual export restored over the same data leaves every user record and photo as it was. */
async function roundTrip(bench: Bench): Promise<string> {
  const photos = await mediaState();
  const first = await exportTo(bench, "first", { embedMedia: true, csv: true, deflateLevel: 6 });
  const verified = await verifyArchive(first.file);
  expect(
    verified.ok,
    `verify: ${verified.problems.map((p) => `${p.problem} ${p.path}`).join(", ")}`
  );
  const result = await restoreFrom(first.file);
  await expectFirstData(bench, first);
  expect((await mediaState()) === photos, "photos differ after the restore");
  bench.first = first;
  const rows = first.manifest.tables.reduce((sum, t) => sum + t.rows, 0);
  const kept = result.recoveryId ? "recovery set kept" : "library was empty";
  return `${rows} rows, ${first.manifest.media.length} photos, ${kept}`;
}

/** G6: a swap that fails (a device override that throws) changes nothing and leaves nothing behind. */
async function atomicity(bench: Bench): Promise<string> {
  const first = needFirst(bench);
  const before = await dbHash(bench);
  const photos = await mediaState();
  const overrides = vaultApp.deviceOverrides;
  vaultApp.deviceOverrides = (ctx) => [
    ...overrides.call(vaultApp, ctx),
    { sql: 'INSERT INTO "_vault_selftest_missing" DEFAULT VALUES' },
  ];
  let failed: unknown = null;
  try {
    await restoreFrom(first.file);
  } catch (e) {
    failed = e;
  } finally {
    vaultApp.deviceOverrides = overrides;
  }
  expect(failed instanceof VaultError, "the failing override did not stop the restore");
  expect((await dbHash(bench)) === before, "the database changed");
  expect((await mediaState()) === photos, "photos changed");
  expect(readJournal() === null, "the crash journal was left");
  expect(!partialSets().length, "a partial recovery set was left");
  return `failed with ${failed.code}, nothing changed`;
}

/** G7: a process death after the media moves (before the commit) is rolled back by the next start. */
async function crashBefore(bench: Bench): Promise<string> {
  const first = needFirst(bench);
  const before = await dbHash(bench);
  const photos = await mediaState();
  const journal = await crash(first.file, "afterMedia");
  expect(readState(bench.db, "restore.lastOp") !== journal.op, "the swap committed");
  await recoverJournal(bench.db);
  expect(readJournal() === null, "the crash journal was not cleared");
  expect((await dbHash(bench)) === before, "the database changed");
  expect((await mediaState()) === photos, "photos changed");
  expect(!partialSets().length, "a partial recovery set was left");
  return "rolled back";
}

/** G7: a process death after the commit is rolled forward by the next start (the recovery set packaged). */
async function crashAfter(bench: Bench): Promise<string> {
  const first = needFirst(bench);
  const journal = await crash(first.file, "afterCommit");
  expect(readState(bench.db, "restore.lastOp") === journal.op, "the swap did not commit");
  await recoverJournal(bench.db);
  expect(readJournal() === null, "the crash journal was not cleared");
  if (journal.recoveryId)
    expect(latestRecovery()?.id === journal.recoveryId, "the recovery set was not packaged");
  await expectFirstData(bench, first);
  return journal.recoveryId ? "rolled forward, recovery set packaged" : "rolled forward";
}

/** G8: with foreign keys on, replacing parents and children cascades nothing and leaves the setting on. */
async function foreignKeysOn(bench: Bench): Promise<string> {
  const first = needFirst(bench);
  bench.db.execSync("PRAGMA foreign_keys = ON");
  try {
    await restoreFrom(first.file);
    const on = bench.db.getFirstSync<{ foreign_keys: number }>("PRAGMA foreign_keys");
    expect(on?.foreign_keys === 1, "foreign keys were left off");
    const violations = bench.db.getAllSync("PRAGMA foreign_key_check");
    expect(!violations.length, `${violations.length} foreign key violations`);
    await expectFirstData(bench, first);
  } finally {
    bench.db.execSync(`PRAGMA foreign_keys = ${bench.foreignKeys ? "ON" : "OFF"}`);
  }
  return "no cascades";
}

/** Exports while one photo is away, so the archive lists it as missing (an archive made where it was absent). */
async function exportWithout(
  bench: Bench,
  photo: { set: VaultMediaSet; name: string }
): Promise<Written> {
  const aside = new File(bench.work, "aside");
  removeFile(aside);
  new File(mediaDir(photo.set.directory), photo.name).moveSync(aside);
  try {
    return await exportTo(bench, "without", { embedMedia: true, csv: false, deflateLevel: 1 });
  } finally {
    aside.moveSync(new File(mediaDir(photo.set.directory), photo.name));
  }
}

/** G16: a photo the archive lacks but this device has stays in place and out of the recovery set. */
async function keptLive(bench: Bench): Promise<string> {
  const photo = bench.photos[0];
  if (!photo)
    throw new Skip(
      vaultApp.media?.length ? "no photos on this device" : "this app keeps no photos"
    );
  const native = vaultNative();
  const live = () => new File(mediaDir(photo.set.directory), photo.name);
  const sha256 = await native.hashFile(live().uri);
  const archive = await exportWithout(bench, photo);
  expect(
    archive.manifest.missingMedia?.some((m) => m.set === photo.set.set && m.name === photo.name),
    "the archive does not list the photo as missing"
  );
  const result = await restoreFrom(archive.file);
  removeFile(archive.file);
  expect(live().exists && (await native.hashFile(live().uri)) === sha256, "the photo changed");
  expect(result.mediaKeptLive >= 1, "no photo was kept live");
  expect(
    !result.recoveryId ||
      !new File(recoveryDir(result.recoveryId), "media", photo.set.set, photo.name).exists,
    "the photo moved into the recovery set"
  );
  return `${result.mediaKeptLive} kept live`;
}

const CASES: { id: string; label: string; run: (bench: Bench) => Promise<string> }[] = [
  { id: "hash", label: "hashFile 50 MiB", run: hashCase },
  { id: "G1", label: "G1 export and restore", run: roundTrip },
  { id: "G6", label: "G6 failed swap", run: atomicity },
  { id: "G7a", label: "G7 crash before commit", run: crashBefore },
  { id: "G7b", label: "G7 crash after commit", run: crashAfter },
  { id: "G8", label: "G8 foreign keys on", run: foreignKeysOn },
  { id: "G16", label: "G16 photo kept live", run: keptLive },
];

const describeError = (e: unknown) =>
  e instanceof VaultError
    ? `${e.code}${e.info.detail ? ` (${e.info.detail})` : ""}`
    : e instanceof Error
      ? e.message
      : String(e);

async function runCase(c: (typeof CASES)[number], bench: Bench): Promise<SelfTestResult> {
  const started = Date.now();
  try {
    const detail = await c.run(bench);
    return { id: c.id, label: c.label, outcome: "pass", ms: Date.now() - started, detail };
  } catch (e) {
    const skipped = e instanceof Skip;
    if (!skipped) console.warn("[vault]", "selftest", c.id, e);
    return {
      id: c.id,
      label: c.label,
      outcome: skipped ? "skip" : "fail",
      ms: Date.now() - started,
      detail: describeError(e),
    };
  }
}

/** Swaps the descriptor's hooks that reach outside the database for neutral ones; returns the undo. */
function neutralHooks(): () => void {
  const { hooks, database, legacy } = vaultApp;
  vaultApp.hooks = {
    ...hooks,
    beforeExport: undefined,
    afterRestore: async () => {},
    pauseWhenIdle: (work) => work(),
  };
  vaultApp.database = { ...database, announceChange: undefined };
  if (legacy) vaultApp.legacy = { ...legacy, recoveryCopy: () => null };
  return () => {
    vaultApp.hooks = hooks;
    vaultApp.database = database;
    vaultApp.legacy = legacy;
  };
}

/** The vault state mirror read from the live database again (the bench's writes refreshed it from the copy). */
async function resyncState(): Promise<void> {
  try {
    const env = engineEnv();
    const db = await env.acquire();
    try {
      refreshVaultState(db);
    } finally {
      await env.release(db);
    }
  } catch (e) {
    console.warn("[vault]", "selftest", e);
  }
}

/** Builds the bench, runs every case on it, and puts the engine back. The caller holds the vault lock. */
async function runCases(onResult: (result: SelfTestResult) => void): Promise<SelfTestResult[]> {
  const op = newOpId();
  const work = ensureDir(workDir(op));
  const root = ensureDir(new Directory(work, "documents"));
  const results: SelfTestResult[] = [];
  let db: SQLiteDatabase | null = null;
  let undoHooks: (() => void) | null = null;
  try {
    // 1. Copies, read on the live database and folders (nothing is written there).
    const live = engineEnv();
    const liveDb = await live.acquire();
    let foreignKeys = false;
    const photos: Bench["photos"] = [];
    try {
      foreignKeys =
        liveDb.getFirstSync<{ foreign_keys: number }>("PRAGMA foreign_keys")?.foreign_keys === 1;
      (await takeSnapshot(liveDb, new File(work, "live.db"))).closeSync();
      for (const set of vaultApp.media ?? [])
        for (const name of referencedMedia(liveDb, set)) {
          if (photos.length >= MAX_PHOTOS) break;
          if (typeof name !== "string" || !MEDIA_NAME.test(name)) continue;
          const file = new File(mediaDir(set.directory), name);
          if (!file.exists) continue;
          await file.copy(new File(ensureDir(new Directory(root, set.directory)), name));
          photos.push({ set, name });
        }
    } finally {
      await live.release(liveDb);
    }
    // The same device as the live library, so the copy is not taken for an OS-backup clone.
    const anchor = anchorFile();
    if (anchor.exists)
      await anchor.copy(new File(ensureDir(new Directory(root, VAULT_FOLDER)), anchor.name));

    // 2. The engine on the copy.
    const copy = openDatabaseSync("live.db", { useNewConnection: true }, fsPath(work));
    db = copy;
    if (foreignKeys) copy.execSync("PRAGMA foreign_keys = ON");
    setEngineEnv({ acquire: async () => copy, release: async () => {}, documentRoot: root });
    undoHooks = neutralHooks();
    await ensureReady(copy);

    // 3. The cases, in order (G6–G8 restore G1's archive again).
    const bench: Bench = { db: copy, work, foreignKeys, photos, first: null };
    for (const c of CASES) {
      const result = await runCase(c, bench);
      results.push(result);
      onResult(result);
    }
    return results;
  } finally {
    simulateCrash(null);
    undoHooks?.();
    setEngineEnv(null);
    try {
      db?.closeSync();
    } catch (e) {
      console.warn("[vault]", "selftest", e);
    }
    try {
      removeDir(work);
    } catch (e) {
      // the next start removes it: its operation is no longer live
      console.warn("[vault]", "selftest", e);
    } finally {
      endOp(op);
    }
    await resyncState();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The panel's store

let state: SelfTestState = { running: false, results: [] };
const listeners = new Set<() => void>();

function update(next: SelfTestState): void {
  state = next;
  for (const listener of [...listeners]) listener();
}

/** The self-test as last updated (the same object until it changed). */
export function selfTestState(): SelfTestState {
  return state;
}

/** Calls `listener` after each case and when a run starts or ends; returns the unsubscriber. */
export function subscribeSelfTest(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Runs every case (waiting behind a running vault operation); a second call while one runs does nothing. */
export async function runSelfTest(): Promise<readonly SelfTestResult[]> {
  if (state.running) return state.results;
  update({ running: true, results: [] });
  try {
    await exclusive(
      "selftest",
      () => runCases((result) => update({ running: true, results: [...state.results, result] })),
      { wait: true }
    );
  } catch (e) {
    console.warn("[vault]", "selftest", e);
    const setup: SelfTestResult = {
      id: "setup",
      label: "Setup",
      outcome: "fail",
      ms: 0,
      detail: describeError(e),
    };
    update({ running: true, results: [...state.results, setup] });
  } finally {
    update({ running: false, results: state.results });
  }
  return state.results;
}
