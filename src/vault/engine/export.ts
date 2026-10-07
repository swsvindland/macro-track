// Export (docs/vault.md, "Export"; spec §3.5.1): one archive from one consistent snapshot. Rows become one NDJSON file
// per descriptor table, media sets are walked through the rows that reference them (never the folder), and the
// same foreign-key check and descriptor validators a restore applies run as warnings, so a user never collects
// months of backups a restore would reject. The content hash is known before any DEFLATE work, so an automatic run
// whose content did not change stops there. The archive is written entry by entry with manifest.json last: it
// carries the sizes and SHA-256 hashes of everything before it.
//
// Lock-free: callers hold the vault lock and ran ensureReady first (runExport and runAutoBackup in ops.ts and
// cloud/backup.ts; a restore packaging its recovery set already holds it), so every snapshot carries a device id and
// a library id.
import { Directory, File } from "expo-file-system";
import type { SQLiteDatabase } from "expo-sqlite";

import { vaultApp, vaultIdentity } from "../app";
import { checkAborted, toVaultError, VaultError } from "../errors";
import { loadDeviceInfo, vaultNative } from "../native";
import type {
  ExportOptions,
  ExportResult,
  Manifest,
  ManifestFile,
  ManifestTable,
  MediaRef,
  SqlReader,
  SummaryValues,
  VaultIssue,
  VaultMediaSet,
  VaultSql,
  VaultTable,
} from "../types";

import { CSV_BOM } from "./csv";
import {
  boundedSequence,
  columnNames,
  isRowidTable,
  q,
  schemaState,
  sequenceOf,
  tableExists,
} from "./db";
import { buildManifest, MANIFEST_ENTRY, manifestText, README_ENTRY, readmeText } from "./manifest";
import { endOp, engineEnv, ensureDir, mediaDir, newOpId, removeDir, workDir } from "./paths";
import { keysFilter, writeRows } from "./rows";
import { VAULT_OWNED_COLUMNS } from "./sid";
import { CLOCK_TABLE, openSnapshot, readCounters, takeSnapshot } from "./snapshot";
import { readState } from "./state";
import { ArchiveWriter } from "./zip-write";

/** Media names the vault reads (app-generated `${Date.now()}-${random}.${ext}` and demo seeds match). */
export const MEDIA_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** CSV names a descriptor may return: a plain file name in csv/. */
const CSV_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\.csv$/;

const pad = (n: number) => String(n).padStart(2, "0");

/** A table's exported columns: PRAGMA table_info order without its device columns (`sync_id` included). */
export function exportedColumns(db: SqlReader, table: VaultTable): string[] {
  const device = new Set(table.deviceColumns ?? []);
  return columnNames(db, table.name).filter((c) => !device.has(c));
}

/**
 * A table's high-water mark as the manifest records it: within what every reader accepts (a live mark beyond 2^53 − 1
 * cannot come from the app; it is archived as the largest one a reader takes, never as a value that makes the
 * archive unreadable).
 */
function archivedSequence(db: SqlReader, table: string): number | null {
  const seq = sequenceOf(db, table);
  return seq === null ? null : boundedSequence(seq);
}

/** The rows a table exports: keys mode its key universe (bound), singleton mode its `where`, replace mode all. */
export function rowFilter(table: VaultTable): VaultSql | undefined {
  if (table.mode === "replace") return undefined;
  if (table.mode === "keys" && table.keys)
    return keysFilter(table.keys.keyColumn, table.keys.include);
  if (table.mode === "singleton" && table.singleton) return { sql: table.singleton.where };
  throw new VaultError("exportFailed", { detail: `descriptor:${table.name}` });
}

/**
 * The descriptor's summary on any connection (export snapshot, scratch, live): numbers and text as they are, anything
 * else (a missing row, a BLOB) null, so the values always fit the manifest's `counts`.
 */
export function summarize(db: SqlReader): SummaryValues {
  const values: SummaryValues = {};
  for (const [key, sql] of Object.entries(vaultApp.summary)) {
    const v = db.getFirstSync<{ v: unknown }>(sql)?.v;
    values[key] = (typeof v === "number" && Number.isFinite(v)) || typeof v === "string" ? v : null;
  }
  return values;
}

/** Whether the descriptor's Health sync is on in `db` (healthEnabledSql; false without one). */
export function healthSyncOn(db: SqlReader): boolean {
  const sql = vaultApp.healthEnabledSql;
  return sql ? !!db.getFirstSync<{ v: unknown }>(sql)?.v : false;
}

/**
 * The names the rows of one media set reference, in order of first reference (NULL is no reference). The same walk
 * runs on the export snapshot, the restore scratch and the live database.
 */
export function referencedMedia(db: SqlReader, set: VaultMediaSet): unknown[] {
  if (!tableExists(db, set.table) || !columnNames(db, set.table).includes(set.column)) return [];
  const column = q(set.column);
  return db
    .getAllSync<{ name: unknown }>(
      `SELECT ${column} AS name FROM ${q(set.table)} WHERE ${column} IS NOT NULL GROUP BY ${column} ORDER BY min(rowid)`
    )
    .map((row) => row.name);
}

/**
 * Export-time validation (never blocks the export): foreign-key violations of the exported tables, one warning per
 * table, then the descriptor's validators. A validator that throws is a warning too: a descriptor bug must not stop
 * every backup.
 */
function exportWarnings(snap: SqlReader, tables: readonly string[]): VaultIssue[] {
  const orphans = new Set(
    snap.getAllSync<{ table: string }>("PRAGMA foreign_key_check").map((r) => r.table)
  );
  const warnings: VaultIssue[] = tables
    .filter((t) => orphans.has(t))
    .map((table) => ({ table, fatal: true, message: "fk" }));
  try {
    warnings.push(...(vaultApp.validate?.(snap) ?? []));
  } catch {
    warnings.push({ table: "*", fatal: true, message: "validate:error" });
  }
  return warnings;
}

/** `lineage.adoptedFrom` of the snapshot (M3, written by the swap), when it holds an object. */
function adoptedFrom(snap: SqlReader): Manifest["library"]["adoptedFrom"] | undefined {
  try {
    const value: unknown = JSON.parse(readState(snap, "lineage.adoptedFrom") ?? "null");
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const { deviceId, seq, archive } = value as Record<string, unknown>;
      return {
        ...(typeof deviceId === "string" ? { deviceId } : {}),
        ...(typeof seq === "number" && Number.isSafeInteger(seq) ? { seq } : {}),
        ...(typeof archive === "string" ? { archive } : {}),
      };
    }
  } catch {
    // not written yet, or not ours
  }
  return undefined;
}

/** The local day and time the README names: "2026-10-04 15:30". */
function localTime(date: Date): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** `options.snapshotPath`: a file:// URI, or an absolute path as VACUUM INTO took it. */
function snapshotFile(path: string): File {
  return new File(
    path.startsWith("file:") ? path : `file://${path.split("/").map(encodeURIComponent).join("/")}`
  );
}

/**
 * Writes one archive to `options.destination` (which must not exist) and returns its manifest, content hash, media
 * and the identity counters read from the snapshot. With `beforeZip` returning false nothing is written and the
 * result says `unchanged`. Errors: a VaultError as thrown (`cancelled`, `busy`, `insufficientSpace`,
 * `migrationPending`, `exportFailed` with detail `notReady` for a snapshot without identity), anything else as
 * `exportFailed`. A failed export leaves no destination file and no work folder.
 */
export async function exportArchive(options: ExportOptions): Promise<ExportResult> {
  const { signal, onProgress } = options;
  const env = engineEnv();
  const op = newOpId();
  const work = workDir(op);
  let db: SQLiteDatabase | null = null;
  let snap: SQLiteDatabase | null = null;
  let writer: ArchiveWriter | null = null;
  try {
    checkAborted(signal);
    const native = vaultNative();
    const device = await loadDeviceInfo();
    db = await env.acquire();
    ensureDir(work);

    // 1–2. One consistent snapshot; everything below reads it, never the live database.
    const given = options.snapshotPath ? snapshotFile(options.snapshotPath) : null;
    if (!given) await vaultApp.hooks.beforeExport?.(db);
    checkAborted(signal);
    onProgress?.({ step: "snapshot" });
    const created = new Date();
    const snapshot = given
      ? openSnapshot(given)
      : await takeSnapshot(db, new File(work, "snapshot.db"));
    snap = snapshot;
    const journal = vaultApp.migrations.journal;
    const schema = schemaState(snapshot, journal);
    if (schema.pending > 0 || schema.applied < 1)
      throw new VaultError("migrationPending", {
        detail: `${schema.applied}/${journal.entries.length}`,
      });
    const counters = readCounters(snapshot);

    // 3. Rows: one NDJSON file per descriptor table that exists at this schema level.
    const present = vaultApp.tables.filter((t) => tableExists(snapshot, t.name));
    const tables: ManifestTable[] = [];
    const dataDir = ensureDir(new Directory(work, "data"));
    for (const [i, t] of present.entries()) {
      onProgress?.({ step: "data", done: i, total: present.length });
      if (!isRowidTable(snapshot, t.name))
        throw new VaultError("exportFailed", { detail: `withoutRowid:${t.name}` });
      const columns = exportedColumns(snapshot, t);
      const file = new File(dataDir, `${t.name}.ndjson`);
      const source = { table: t.name, columns, where: rowFilter(t) };
      const written = await writeRows(snapshot, source, file, { signal });
      tables.push({
        name: t.name,
        mode: t.mode,
        file: `data/${t.name}.ndjson`,
        rows: written.rows,
        columns,
        ...(t.mode === "keys" && t.keys ? { keys: [...t.keys.include] } : {}),
        sequence: archivedSequence(snapshot, t.name),
        sha256: await native.hashFile(file.uri),
        bytes: written.bytes,
      });
    }
    onProgress?.({ step: "data", done: present.length, total: present.length });

    // 4. Media: the names the rows reference; files are hashed natively (or taken from the restore's media plan).
    const media: MediaRef[] = [];
    const missing: { set: string; name: string }[] = [];
    // A pre-restore snapshot sits in recovery/<id>.partial/ next to media/, where the restore moved displaced files.
    const displaced = given ? new Directory(given.parentDirectory, "media") : null;
    const references = (vaultApp.media ?? []).flatMap((set) =>
      referencedMedia(snapshot, set).map((value) => ({ set, value }))
    );
    for (const [i, { set, value }] of references.entries()) {
      checkAborted(signal);
      onProgress?.({ step: "media", done: i, total: references.length });
      const name = String(value);
      if (typeof value !== "string" || !MEDIA_NAME.test(name)) {
        missing.push({ set: set.set, name });
        continue;
      }
      const live = new File(mediaDir(set.directory), name);
      const moved = displaced ? new File(displaced, set.set, name) : null;
      const source = live.exists ? live : moved?.exists ? moved : null;
      const known = options.knownMedia?.get(`${set.set}/${name}`);
      if (known) media.push({ set: set.set, name, ...known, uri: (source ?? live).uri });
      else if (source)
        media.push({
          set: set.set,
          name,
          bytes: source.size,
          sha256: await native.hashFile(source.uri),
          uri: source.uri,
        });
      else missing.push({ set: set.set, name });
    }

    // 5. Validation on the snapshot: warnings only.
    const warnings = exportWarnings(
      snapshot,
      tables.map((t) => t.name)
    );

    // 6. Content hash; an unchanged automatic run stops before any DEFLATE work.
    const contentHash = native.hashText(
      JSON.stringify([
        tables.map((t) => [t.name, t.sha256, t.rows]),
        media.map((m) => [m.set, m.name, m.sha256]),
      ])
    );
    if (options.beforeZip && !(await options.beforeZip(contentHash)))
      return {
        unchanged: true,
        file: null,
        manifest: null,
        contentHash,
        media,
        counters,
        warnings,
      };
    checkAborted(signal);

    // 7. Preview values, read from the snapshot.
    const counts = summarize(snapshot);
    const healthOn = healthSyncOn(snapshot);

    // 8. CSV copies (manual exports): informational, each with a BOM; then the README.
    const files: ManifestFile[] = [];
    const csv: { path: string; file: File }[] = [];
    if (options.csv && vaultApp.csv) {
      onProgress?.({ step: "csv" });
      const csvDir = ensureDir(new Directory(work, "csv"));
      const language = options.language ?? "en";
      for (const { name, text } of await vaultApp.csv(snapshot, { language })) {
        checkAborted(signal);
        const path = `csv/${name}`;
        if (!CSV_NAME.test(name) || csv.some((c) => c.path === path))
          throw new VaultError("exportFailed", { detail: `csv:${name}` });
        const file = new File(csvDir, name);
        file.create({ overwrite: true });
        file.write(`${CSV_BOM}${text}`);
        csv.push({ path, file });
        files.push({
          path,
          role: "csv",
          sha256: await native.hashFile(file.uri),
          bytes: file.size,
        });
      }
    }
    const about = readmeText(vaultIdentity.name, localTime(created));
    const readme = new TextEncoder().encode(about);
    files.push({
      path: README_ENTRY,
      role: "readme",
      sha256: native.hashText(about),
      bytes: readme.length,
    });

    const { gen, seq, vector } = counters;
    const adopted = adoptedFrom(snapshot);
    const manifest = buildManifest({
      kind: options.kind,
      createdAt: created.toISOString(),
      app: {
        id: vaultApp.id,
        bundleId: vaultIdentity.bundleId,
        name: vaultIdentity.name,
        version: device.appVersion,
        build: device.appBuild,
        platform: device.platform,
        osVersion: device.osVersion,
      },
      schema: {
        applied: schema.applied,
        lastCreatedAt: schema.lastCreatedAt,
        lastTag: schema.lastTag,
        journalLength: journal.entries.length,
      },
      device: {
        id: counters.deviceId,
        platform: device.platform,
        kind: device.kind,
        model: device.model.slice(0, 64),
      },
      library: {
        id: counters.libraryId,
        // M3 lineage, only where the change counters exist (spec §9.5).
        ...(tableExists(snapshot, CLOCK_TABLE) ? { gen, seq, vector } : {}),
        ...(adopted ? { adoptedFrom: adopted } : {}),
      },
      vaultColumns: VAULT_OWNED_COLUMNS.filter((c) => tables.some((t) => t.columns.includes(c))),
      tables,
      media: media.map((m) => ({
        set: m.set,
        name: m.name,
        bytes: m.bytes,
        sha256: m.sha256,
        embedded: options.embedMedia,
      })),
      missingMedia: missing.length ? missing : undefined,
      files,
      counts,
      provenance: { health: !!vaultApp.health, healthSyncOn: healthOn },
      warnings,
    });

    // 9. The archive: data, CSV, media (STORED), README, manifest last.
    const embedded = options.embedMedia ? media : [];
    const total =
      tables.reduce((sum, t) => sum + t.bytes, 0) +
      csv.reduce((sum, c) => sum + c.file.size, 0) +
      embedded.reduce((sum, m) => sum + m.bytes, 0);
    let fed = 0;
    let shown = -1;
    const zipped = (bytes: number) => {
      fed += bytes;
      const percent = total > 0 ? Math.min(100, Math.floor((fed * 100) / total)) : 100;
      if (percent === shown) return;
      shown = percent;
      onProgress?.({ step: "zip", done: percent, total: 100 });
    };
    zipped(0);
    writer = new ArchiveWriter(options.destination, options.deflateLevel, options.chunkBytes);
    for (const t of tables)
      await writer.addFile(t.file, new File(dataDir, `${t.name}.ndjson`), true, signal, zipped);
    for (const c of csv) await writer.addFile(c.path, c.file, true, signal, zipped);
    for (const m of embedded)
      await writer.addFile(`media/${m.set}/${m.name}`, new File(m.uri), false, signal, zipped);
    checkAborted(signal);
    writer.addBytes(README_ENTRY, readme, true);
    writer.addText(MANIFEST_ENTRY, manifestText(manifest));
    writer.finish();
    return {
      unchanged: false,
      file: options.destination,
      manifest,
      contentHash,
      media,
      counters,
      warnings,
    };
  } catch (e) {
    try {
      writer?.abort();
    } catch {
      // the original error is the one to report
    }
    throw toVaultError(e, "exportFailed");
  } finally {
    // 10. Close the snapshot and delete the work folder (a caller's snapshotPath file is the caller's to delete).
    try {
      snap?.closeSync();
    } catch {
      // already closed
    }
    try {
      removeDir(work);
    } catch {
      // the next start removes it: its operation is no longer live
    }
    endOp(op);
    if (db) await env.release(db);
  }
}
