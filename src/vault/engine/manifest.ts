// manifest.json (docs/vault.md, "manifest.json" and "Compatibility rules"): building it for the writer, and for the
// reader the schema checks of format 2 (no zod) plus the compatibility rules in their order — format, reader
// version, app, schema level, tables and columns. Readers ignore properties they do not know. Also the README.txt
// every archive carries.
import { VaultError } from "../errors";
import type {
  AppId,
  Journal,
  Manifest,
  ManifestFile,
  ManifestMedia,
  ManifestTable,
} from "../types";
import { FORMAT_VERSION, MIN_READER_VERSION, READER_VERSION, VAULT_VERSION } from "../version";

import { isEntryName, type ZipEntry } from "./zip-read";

export const ARCHIVE_FORMAT = "pendum.archive";
export const MANIFEST_ENTRY = "manifest.json";
export const README_ENTRY = "README.txt";
/** manifest.json is read into memory: anything larger is not ours. */
export const MAX_MANIFEST = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------------------------------------------
// Writing

/** What the exporter knows; buildManifest adds the format fields and the writer's vault version. */
export type ManifestInput = Omit<
  Manifest,
  "format" | "formatVersion" | "minReaderVersion" | "app"
> & { app: Omit<Manifest["app"], "vault"> };

/** The manifest in the schema's property order (format fields first, optional fields only when present). */
export function buildManifest(input: ManifestInput): Manifest {
  const ifSet = <K extends keyof Manifest>(key: K, value: Manifest[K] | undefined) =>
    value === undefined ? {} : { [key]: value };
  return {
    format: ARCHIVE_FORMAT,
    formatVersion: FORMAT_VERSION,
    minReaderVersion: MIN_READER_VERSION,
    kind: input.kind,
    createdAt: input.createdAt,
    app: { ...input.app, vault: VAULT_VERSION },
    schema: input.schema,
    device: input.device,
    library: input.library,
    ...ifSet("vaultColumns", input.vaultColumns),
    tables: input.tables,
    media: input.media,
    ...ifSet("missingMedia", input.missingMedia),
    files: input.files,
    counts: input.counts,
    ...ifSet("provenance", input.provenance),
    ...ifSet("warnings", input.warnings),
  };
}

/** manifest.json as written: 2-space indent, trailing newline. */
export function manifestText(manifest: Manifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

const README = `This file is a {app} backup made on {date}.
It is a ZIP archive. Rename it to .zip to look inside:
  manifest.json      what is inside, with sizes and SHA-256 hashes
  data/*.ndjson      one file per table, one JSON object per line (machine format used for restoring)
  csv/*.csv          the same records as spreadsheets
  media/             your photos, unchanged
The file is not encrypted. Keep it somewhere private.
To restore, open this file with {app} on iPhone or Android.
`;

/** README.txt (English, like the format itself): `app` is the brand name, `date` the day the backup was made. */
export function readmeText(app: string, date: string): string {
  return README.replaceAll("{app}", app).replaceAll("{date}", date);
}

// ---------------------------------------------------------------------------------------------------------------
// Reading: schema checks

type Json = Record<string, unknown>;

const corrupt = (path: string) => new VaultError("corrupt", { detail: `manifest:${path}` });
const isRecord = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);
// Every integer of a manifest fits in 2^53 − 1: the writer read it through expo-sqlite, which hands integers to JS as
// doubles. A larger one (1e300, 2^63) is hostile; a high-water mark that size would stop a table's inserts for good.
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);
const SHA256 = /^[0-9a-f]{64}$/;
const ID = /^[0-9a-f-]{36}$/;
const TABLE = /^[a-z_][a-z0-9_]{0,62}$/;
const MEDIA_SET = /^[a-z][a-z0-9-]{0,31}$/;
const MEDIA_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Small checkers: each throws `corrupt` naming the property path. */
function object(v: unknown, path: string): Json {
  if (!isRecord(v)) throw corrupt(path);
  return v;
}
function array(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) throw corrupt(path);
  return v;
}
function string(v: unknown, path: string, pattern?: RegExp): string {
  if (typeof v !== "string" || (pattern && !pattern.test(v))) throw corrupt(path);
  return v;
}
function integer(v: unknown, path: string, minimum?: number): number {
  if (!isInt(v) || (minimum !== undefined && v < minimum)) throw corrupt(path);
  return v;
}
function oneOf<T extends string>(v: unknown, values: readonly T[], path: string): T {
  if (typeof v !== "string" || !(values as readonly string[]).includes(v)) throw corrupt(path);
  return v as T;
}
function optional(v: unknown, check: (v: unknown) => unknown) {
  if (v !== undefined) check(v);
}
function unique(values: string[], path: string) {
  if (new Set(values).size !== values.length) throw corrupt(path);
}

function checkTable(v: unknown, path: string): ManifestTable {
  const t = object(v, path);
  string(t.name, `${path}.name`, TABLE);
  oneOf(t.mode, ["replace", "keys", "singleton"], `${path}.mode`);
  if (!isEntryName(string(t.file, `${path}.file`))) throw corrupt(`${path}.file`);
  integer(t.rows, `${path}.rows`, 0);
  const columns = array(t.columns, `${path}.columns`).map((c, i) =>
    string(c, `${path}.columns[${i}]`)
  );
  unique(columns, `${path}.columns`);
  optional(t.keys, (keys) =>
    array(keys, `${path}.keys`).forEach((k, i) => string(k, `${path}.keys[${i}]`))
  );
  if (t.sequence !== undefined && t.sequence !== null) integer(t.sequence, `${path}.sequence`, 0);
  string(t.sha256, `${path}.sha256`, SHA256);
  integer(t.bytes, `${path}.bytes`, 0);
  return t as unknown as ManifestTable;
}

function checkMedia(v: unknown, path: string): ManifestMedia {
  const m = object(v, path);
  string(m.set, `${path}.set`, MEDIA_SET);
  string(m.name, `${path}.name`, MEDIA_NAME);
  integer(m.bytes, `${path}.bytes`, 0);
  string(m.sha256, `${path}.sha256`, SHA256);
  if (typeof m.embedded !== "boolean") throw corrupt(`${path}.embedded`);
  return m as unknown as ManifestMedia;
}

function checkFile(v: unknown, path: string): ManifestFile {
  const f = object(v, path);
  if (!isEntryName(string(f.path, `${path}.path`))) throw corrupt(`${path}.path`);
  oneOf(f.role, ["csv", "readme"], `${path}.role`);
  string(f.sha256, `${path}.sha256`);
  integer(f.bytes, `${path}.bytes`, 0);
  return f as unknown as ManifestFile;
}

/** Every check of the format 2 schema (spec §2.4), plus unique table, column, media and file names. */
function checkSchema(m: Json): void {
  integer(m.formatVersion, "formatVersion", 2);
  integer(m.minReaderVersion, "minReaderVersion", 2);
  oneOf(m.kind, ["manual", "auto", "pre-restore"], "kind");
  if (!Number.isFinite(Date.parse(string(m.createdAt, "createdAt")))) throw corrupt("createdAt");

  const app = object(m.app, "app");
  oneOf(app.id, ["body", "lift", "macro", "water"], "app.id");
  for (const key of ["bundleId", "name", "version", "build", "osVersion", "vault"])
    string(app[key], `app.${key}`);
  oneOf(app.platform, ["ios", "android"], "app.platform");

  const schema = object(m.schema, "schema");
  integer(schema.applied, "schema.applied", 1);
  integer(schema.lastCreatedAt, "schema.lastCreatedAt");
  string(schema.lastTag, "schema.lastTag");
  integer(schema.journalLength, "schema.journalLength");

  const device = object(m.device, "device");
  string(device.id, "device.id", ID);
  oneOf(device.platform, ["ios", "android"], "device.platform");
  oneOf(device.kind, ["phone", "tablet"], "device.kind");
  if (string(device.model, "device.model").length > 64) throw corrupt("device.model");

  const library = object(m.library, "library");
  string(library.id, "library.id", ID);
  optional(library.gen, (v) => integer(v, "library.gen"));
  optional(library.seq, (v) => integer(v, "library.seq"));
  optional(library.vector, (v) =>
    Object.entries(object(v, "library.vector")).forEach(([k, n]) =>
      integer(n, `library.vector.${k}`)
    )
  );
  optional(library.adoptedFrom, (v) => {
    const from = object(v, "library.adoptedFrom");
    optional(from.deviceId, (s) => string(s, "library.adoptedFrom.deviceId"));
    optional(from.seq, (n) => integer(n, "library.adoptedFrom.seq"));
    optional(from.archive, (s) => string(s, "library.adoptedFrom.archive"));
  });

  const tables = array(m.tables, "tables").map((t, i) => checkTable(t, `tables[${i}]`));
  unique(
    tables.map((t) => t.name),
    "tables"
  );
  const media = array(m.media, "media").map((x, i) => checkMedia(x, `media[${i}]`));
  unique(
    media.map((x) => `${x.set}/${x.name}`),
    "media"
  );
  optional(m.missingMedia, (v) =>
    array(v, "missingMedia").forEach((x, i) => object(x, `missingMedia[${i}]`))
  );
  optional(m.vaultColumns, (v) =>
    array(v, "vaultColumns").forEach((c, i) => string(c, `vaultColumns[${i}]`))
  );
  optional(m.warnings, (v) =>
    array(v, "warnings").forEach((x, i) => {
      const w = object(x, `warnings[${i}]`);
      optional(w.table, (s) => string(s, `warnings[${i}].table`));
      if (w.fatal !== undefined && typeof w.fatal !== "boolean")
        throw corrupt(`warnings[${i}].fatal`);
      optional(w.message, (s) => string(s, `warnings[${i}].message`));
    })
  );
  const files = array(m.files, "files").map((f, i) => checkFile(f, `files[${i}]`));
  unique(
    files.map((f) => f.path),
    "files"
  );
  for (const [key, value] of Object.entries(object(m.counts, "counts")))
    if (value !== null && typeof value !== "number" && typeof value !== "string")
      throw corrupt(`counts.${key}`);
  optional(m.provenance, (v) => {
    const p = object(v, "provenance");
    for (const key of ["health", "healthSyncOn"])
      if (p[key] !== undefined && typeof p[key] !== "boolean") throw corrupt(`provenance.${key}`);
  });
}

/**
 * Parses manifest.json and applies, in this order: rule 1 (`format` → notArchive), rule 2 (`minReaderVersion` above
 * this reader → newer, before anything else of a newer format is judged), rule 3 (another app → wrongApp, with the
 * manifest's brand name in `info.app`), then the format 2 schema (→ corrupt). Unknown properties are ignored.
 */
export function parseManifest(text: string, app: AppId): Manifest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new VaultError("corrupt", { detail: "manifest:json", cause: e });
  }
  const m = object(value, "root");
  if (m.format !== ARCHIVE_FORMAT) throw new VaultError("notArchive", { detail: "format" });
  if (integer(m.minReaderVersion, "minReaderVersion") > READER_VERSION)
    throw new VaultError("newer", { detail: "minReaderVersion" });
  const id = isRecord(m.app) ? m.app.id : undefined;
  if (typeof id === "string" && id !== app) {
    const name = isRecord(m.app) ? m.app.name : undefined;
    throw new VaultError("wrongApp", {
      detail: id.slice(0, 32),
      app: typeof name === "string" && name.length <= 64 ? name : undefined,
    });
  }
  checkSchema(m);
  return m as unknown as Manifest;
}

// ---------------------------------------------------------------------------------------------------------------
// Reading: compatibility with this app

/**
 * Rule 4: the archive's schema level against this app's journal. Made by a newer app (more entries applied) →
 * newer; another migration lineage (the tag or time of its last entry differ) → unknownSchema. An older level is
 * accepted: the restore replays it and migrates forward.
 */
export function schemaLevel(
  manifest: Manifest,
  journal: Journal
): { applied: number; olderSchema: boolean } {
  const applied = manifest.schema.applied;
  const entries = journal.entries;
  if (applied > entries.length) throw new VaultError("newer", { detail: "schema" });
  const last = entries[applied - 1];
  if (last.when !== manifest.schema.lastCreatedAt || last.tag !== manifest.schema.lastTag)
    throw new VaultError("unknownSchema", { detail: "lineage" });
  return { applied, olderSchema: applied < entries.length };
}

/** How the scratch inserts one manifest table (rule 5). */
export interface ColumnPlan {
  table: string;
  /** Every manifest column: the keys of each NDJSON line, in order. */
  columns: string[];
  /** Columns inserted (manifest order); the vault-owned ones among them are added to the scratch table first. */
  insert: string[];
  /** Vault-owned columns this reader owns that the table lacks at the archive's level (added before inserting). */
  owned: string[];
  /** Future vault-owned columns this reader does not own: their keys are dropped from every line. */
  dropped: string[];
}

/**
 * Rule 5: every manifest table must be a descriptor table that exists at the archive's level, and every manifest
 * column must exist there, or be a vault-owned column this reader owns (`owned`, today ["sync_id"]), or be listed in
 * the manifest's `vaultColumns` without being owned here (dropped). Anything else → unknownSchema.
 * `columnsAt(table)` returns the table's columns at the archive's level in the scratch DB, or null when it does not
 * exist there.
 */
export function columnPlan(
  manifest: Manifest,
  scratch: {
    tables: readonly string[];
    owned: readonly string[];
    columnsAt: (table: string) => readonly string[] | null;
  }
): ColumnPlan[] {
  const listed = new Set(manifest.vaultColumns ?? []);
  return manifest.tables.map((t) => {
    if (!scratch.tables.includes(t.name))
      throw new VaultError("unknownSchema", { detail: `table:${t.name}` });
    const have = scratch.columnsAt(t.name);
    if (!have) throw new VaultError("unknownSchema", { detail: `table:${t.name}` });
    const plan: ColumnPlan = {
      table: t.name,
      columns: [...t.columns],
      insert: [],
      owned: [],
      dropped: [],
    };
    for (const column of t.columns) {
      if (have.includes(column)) plan.insert.push(column);
      else if (scratch.owned.includes(column)) {
        plan.insert.push(column);
        plan.owned.push(column);
      } else if (listed.has(column)) plan.dropped.push(column);
      else throw new VaultError("unknownSchema", { detail: `column:${t.name}.${column}` });
    }
    return plan;
  });
}

/** One entry the manifest lists, with what extraction must find. */
export interface ListedEntry {
  path: string;
  bytes: number;
  sha256: string;
  role: "data" | "media" | "csv" | "readme";
}

/** Every entry the manifest lists: table files, embedded media, CSV and README. Unlisted entries are ignored. */
export function listedEntries(manifest: Manifest): ListedEntry[] {
  return [
    ...manifest.tables.map((t) => ({
      path: t.file,
      bytes: t.bytes,
      sha256: t.sha256,
      role: "data" as const,
    })),
    ...manifest.media
      .filter((m) => m.embedded)
      .map((m) => ({
        path: `media/${m.set}/${m.name}`,
        bytes: m.bytes,
        sha256: m.sha256,
        role: "media" as const,
      })),
    ...manifest.files.map((f) => ({
      path: f.path,
      bytes: f.bytes,
      sha256: f.sha256,
      role: f.role,
    })),
  ];
}

/** Sum of the uncompressed bytes the manifest lists (the extraction size the disk check needs). */
export function listedBytes(manifest: Manifest): number {
  return listedEntries(manifest).reduce((sum, e) => sum + e.bytes, 0);
}

/**
 * Listed entries the central directory lacks (`missing`) or holds with another uncompressed size (`size`). The
 * restore treats any as corrupt; verifyArchive reports them.
 */
export function entryProblems(
  manifest: Manifest,
  entries: ReadonlyMap<string, ZipEntry>
): { path: string; problem: "missing" | "size" }[] {
  const problems: { path: string; problem: "missing" | "size" }[] = [];
  for (const listed of listedEntries(manifest)) {
    const entry = entries.get(listed.path);
    if (!entry) problems.push({ path: listed.path, problem: "missing" });
    else if (entry.size !== listed.bytes) problems.push({ path: listed.path, problem: "size" });
  }
  return problems;
}
