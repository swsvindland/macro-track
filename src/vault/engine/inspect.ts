// Opening and verifying archives (docs/vault.md, "Restore"; spec §3.5.2, §3.5.4). openArchive copies the chosen file
// into a private work folder (a picker's or another app's grant can end; Android hands over content:// URIs), reads
// only the central directory and manifest.json, applies the compatibility rules in their order and builds the
// preview the import screen shows. No database is changed and nothing else is extracted; the private copy stays
// until close(). verifyArchive checks integrity only: every listed entry present, of the listed size and hash.
//
// A file that is not a ZIP may be a lift or macro v1 backup: engine/legacy.ts reads those and registers itself here
// (setLegacyOpener); without it, such a file is `notArchive`.
import { Directory, File, Paths } from "expo-file-system";

import { vaultApp } from "../app";
import { checkAborted, toVaultError, VaultError } from "../errors";
import { loadDeviceInfo, vaultNative } from "../native";
import type { Manifest, OpenedArchive, Preview, SummaryValues, VerifyResult } from "../types";

import { libraryEmpty } from "./device";
import { summarize } from "./export";
import {
  entryProblems,
  listedEntries,
  MANIFEST_ENTRY,
  MAX_MANIFEST,
  parseManifest,
  schemaLevel,
} from "./manifest";
import { endOp, engineEnv, ensureDir, newOpId, removeDir, removeFile, workDir } from "./paths";
import { readState } from "./state";
import { ArchiveReader } from "./zip-read";

/** Free space kept beyond the private copy of an opened archive. */
const MARGIN = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------------------------------------------
// Legacy v1 backups (engine/legacy.ts)

/** What engine/legacy.ts makes of a file that is not a ZIP: a lift or macro v1 backup, parsed. */
export interface LegacyOpen {
  /** The parsed backup; the restore hands it to the descriptor's legacy.write(). */
  parsed: unknown;
  /** ISO */
  createdAt: string;
  /** Preview counts (the adapter's counts(), descriptor summary keys). */
  counts: SummaryValues;
}

/**
 * Reads a file that is not a ZIP as a v1 backup. Throws VaultError: notArchive (not a v1 backup either), wrongApp,
 * legacyPasswordRequired, legacyPasswordWrong, legacyTooLarge or corrupt.
 */
export type LegacyOpener = (
  source: File,
  options: { password?: string; signal?: AbortSignal }
) => Promise<LegacyOpen>;

let legacyOpener: LegacyOpener | null = null;

/** engine/legacy.ts registers its reader here (null removes it). */
export function setLegacyOpener(opener: LegacyOpener | null): void {
  legacyOpener = opener;
}

// ---------------------------------------------------------------------------------------------------------------
// Opened archives

/** The engine's side of an opened archive: what a restore reads besides the public fields. */
export interface ArchiveContents {
  /** v2: the central directory of `source`, open until close(). */
  reader: ArchiveReader | null;
  /** legacy: the parsed v1 backup. */
  legacy: LegacyOpen | null;
  /** work/<op>/: the private copy is in/archive; a restore extracts and builds its scratch database beside it. */
  work: Directory;
  /** The archive's schema level: v2 manifest.schema.applied, legacy the current journal length. */
  applied: number;
}

class Opened implements OpenedArchive {
  readonly opId: string;
  readonly source: File;
  readonly format: "v2" | "legacy";
  readonly manifest: Manifest | null;
  readonly preview: Preview;
  readonly contents: ArchiveContents;
  private holds = 0;
  private closing = false;
  private closed = false;

  constructor(
    opId: string,
    source: File,
    manifest: Manifest | null,
    preview: Preview,
    contents: ArchiveContents
  ) {
    this.opId = opId;
    this.source = source;
    this.format = preview.format;
    this.manifest = manifest;
    this.preview = preview;
    this.contents = contents;
  }

  close(): void {
    this.closing = true;
    if (this.holds === 0) this.dispose();
  }

  hold(): () => void {
    if (this.closed) throw new Error("vault: the archive is closed");
    this.holds++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.holds === 0 && this.closing) this.dispose();
    };
  }

  private dispose() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.contents.reader?.close();
      removeDir(this.contents.work);
    } catch {
      // the next start removes the folder: its operation is no longer live
    } finally {
      endOp(this.opId);
    }
  }
}

function opened(archive: OpenedArchive): Opened {
  if (!(archive instanceof Opened)) throw new Error("vault: not an archive openArchive returned");
  return archive;
}

/** The reader, legacy payload, work folder and schema level of an archive openArchive returned. */
export function archiveContents(archive: OpenedArchive): ArchiveContents {
  return opened(archive).contents;
}

/**
 * Keeps the archive's private copy while a restore of it runs: close() meanwhile is deferred until the returned
 * release function has been called.
 */
export function holdArchive(archive: OpenedArchive): () => void {
  return opened(archive).hold();
}

// ---------------------------------------------------------------------------------------------------------------
// openArchive

/** The size of a file the user picked, when the platform reports one. */
function sizeOf(file: File): number | null {
  try {
    return file.size;
  } catch {
    return null;
  }
}

/** Whether `latest` (ISO, "YYYY-MM-DD" or epoch ms) is after `createdAt` (ISO): string order, null-safe. */
function after(latest: SummaryValues[string] | undefined, createdAt: string): boolean {
  if (latest === null || latest === undefined || latest === "") return false;
  if (typeof latest === "string") return latest > createdAt;
  const date = new Date(latest);
  return Number.isFinite(date.getTime()) && date.toISOString() > createdAt;
}

/** Every manifest table must be a descriptor table (rule 5) whose rows are in data/<name>.ndjson. */
function checkTables(manifest: Manifest): void {
  const names = new Set(vaultApp.tables.map((t) => t.name));
  for (const t of manifest.tables) {
    if (!names.has(t.name)) throw new VaultError("unknownSchema", { detail: `table:${t.name}` });
    if (t.file !== `data/${t.name}.ndjson`)
      throw new VaultError("corrupt", { detail: `manifest:tables.${t.name}.file` });
  }
}

/** The preview against the live database (read only). */
async function previewOf(
  manifest: Manifest | null,
  legacy: LegacyOpen | null,
  applied: number
): Promise<Preview> {
  const device = await loadDeviceInfo();
  const env = engineEnv();
  const db = await env.acquire();
  try {
    const current = summarize(db);
    const liveEmpty = libraryEmpty(db);
    if (!manifest) {
      const createdAt = legacy?.createdAt ?? "";
      return {
        format: "legacy",
        kind: "legacy",
        createdAt,
        appVersion: null,
        device: null,
        incoming: legacy?.counts ?? {},
        current,
        olderSchema: false,
        crossPlatform: false,
        sameDevice: false,
        liveEmpty,
        newerLocalChanges: after(current.latest, createdAt),
        sourceHealthSyncOn: false,
        media: { count: 0, bytes: 0, embedded: 0, missing: 0 },
        libraryId: null,
      };
    }
    const sameDevice = manifest.device.id === readState(db, "device.id");
    return {
      format: "v2",
      kind: manifest.kind,
      createdAt: manifest.createdAt,
      appVersion: manifest.app.version,
      device: {
        platform: manifest.device.platform,
        kind: manifest.device.kind,
        model: manifest.device.model,
      },
      incoming: manifest.counts,
      current,
      olderSchema: applied < vaultApp.migrations.journal.entries.length,
      crossPlatform: manifest.app.platform !== device.platform,
      sameDevice,
      liveEmpty,
      newerLocalChanges: after(current.latest, manifest.createdAt),
      sourceHealthSyncOn: manifest.provenance?.healthSyncOn === true && !sameDevice,
      media: {
        count: manifest.media.length,
        bytes: manifest.media.reduce((sum, m) => sum + m.bytes, 0),
        embedded: manifest.media.filter((m) => m.embedded).length,
        missing: manifest.missingMedia?.length ?? 0,
      },
      libraryId: manifest.library.id,
    };
  } finally {
    await env.release(db);
  }
}

/**
 * Opens `file` for a restore: a private copy, the compatibility rules (format → notArchive, reader version → newer,
 * app → wrongApp, schema level → newer or unknownSchema, tables → unknownSchema, listed entries → corrupt) and the
 * preview. The archive stays registered as a live operation until close(). Callers hold the vault lock and ran
 * ensureReady (runOpen), so `sameDevice` compares against a device id that exists.
 */
export async function openArchive(
  file: File,
  options: { password?: string; signal?: AbortSignal } = {}
): Promise<OpenedArchive> {
  const { signal } = options;
  const op = newOpId();
  const work = workDir(op);
  let reader: ArchiveReader | null = null;
  try {
    checkAborted(signal);
    const size = sizeOf(file);
    if (size !== null && Paths.availableDiskSpace < size + MARGIN)
      throw new VaultError("insufficientSpace", { bytes: size + MARGIN });
    const source = new File(ensureDir(new Directory(work, "in")), "archive");
    await file.copy(source);
    checkAborted(signal);

    const journal = vaultApp.migrations.journal;
    let manifest: Manifest | null = null;
    let legacy: LegacyOpen | null = null;
    let applied = journal.entries.length;
    try {
      reader = ArchiveReader.open(source);
    } catch (e) {
      if (!(e instanceof VaultError && e.code === "notArchive") || !legacyOpener) throw e;
      legacy = await legacyOpener(source, { password: options.password, signal });
    }
    if (reader) {
      manifest = parseManifest(await reader.readText(MANIFEST_ENTRY, MAX_MANIFEST), vaultApp.id);
      applied = schemaLevel(manifest, journal).applied;
      checkTables(manifest);
      const problems = entryProblems(manifest, reader.entries);
      if (problems.length)
        throw new VaultError("corrupt", { detail: `${problems[0].problem}:${problems[0].path}` });
    }
    checkAborted(signal);
    const preview = await previewOf(manifest, legacy, applied);
    return new Opened(op, source, manifest, preview, { reader, legacy, work, applied });
  } catch (e) {
    try {
      reader?.close();
      removeDir(work);
    } catch {
      // the next start removes the folder: its operation is no longer live
    }
    endOp(op);
    throw toVaultError(e, "unknown");
  }
}

// ---------------------------------------------------------------------------------------------------------------
// verifyArchive

/**
 * Integrity only, no database: the manifest parses (for this app), and every table, embedded media and file entry
 * it lists is in the central directory with the listed size and SHA-256. Each entry is extracted to a temporary
 * file, hashed natively and deleted. Returns every problem found rather than throwing on the first.
 */
export async function verifyArchive(file: File): Promise<VerifyResult> {
  const unreadable: VerifyResult = {
    ok: false,
    problems: [{ path: MANIFEST_ENTRY, problem: "manifest" }],
  };
  let reader: ArchiveReader;
  try {
    reader = ArchiveReader.open(file);
  } catch (e) {
    if (e instanceof VaultError) return unreadable;
    throw e;
  }
  const op = newOpId();
  const work = workDir(op);
  try {
    let manifest: Manifest;
    try {
      manifest = parseManifest(await reader.readText(MANIFEST_ENTRY, MAX_MANIFEST), vaultApp.id);
    } catch (e) {
      if (e instanceof VaultError) return unreadable;
      throw e;
    }
    const native = vaultNative();
    const problems: VerifyResult["problems"] = [];
    const temp = new File(ensureDir(work), "entry");
    for (const entry of listedEntries(manifest)) {
      const zipped = reader.entries.get(entry.path);
      if (!zipped) problems.push({ path: entry.path, problem: "missing" });
      else if (zipped.size !== entry.bytes) problems.push({ path: entry.path, problem: "size" });
      else
        try {
          await reader.extract(entry.path, temp, entry.bytes);
          if ((await native.hashFile(temp.uri)) !== entry.sha256)
            problems.push({ path: entry.path, problem: "hash" });
        } catch (e) {
          if (!(e instanceof VaultError && e.code === "corrupt")) throw e;
          problems.push({ path: entry.path, problem: e.info.detail === "size" ? "size" : "hash" });
        } finally {
          removeFile(temp);
        }
    }
    return { ok: problems.length === 0, problems };
  } finally {
    reader.close();
    try {
      removeDir(work);
    } finally {
      endOp(op);
    }
  }
}
