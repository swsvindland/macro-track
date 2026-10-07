// The scratch database of a restore (docs/vault.md, "Restore"; spec §3.6): before anything touches the live database,
// the archive is replayed into a private SQLite file built from the app's own migrations — up to the archive's schema
// level, where its rows are inserted as they were written, then forward to the current level, so real migrations
// transform old data exactly as they did on devices. Then generic repairs (foreign-key orphans by their ON DELETE
// action, never business rules), integrity checks, the descriptor's provenance policy and validators. No foreign
// SQLite file is ever opened: every value comes from NDJSON lines checked against the manifest. The scratch is closed
// when buildScratch returns; the swap ATTACHes it.
import { drizzle } from "drizzle-orm/expo-sqlite";
import { migrate } from "drizzle-orm/expo-sqlite/migrator";
import { Directory, File } from "expo-file-system";
import { openDatabaseSync, type SQLiteDatabase } from "expo-sqlite";

import { vaultApp } from "../app";
import { checkAborted, VaultError } from "../errors";
import type {
  Manifest,
  Progress,
  RestoreContext,
  SqlReader,
  SummaryValues,
  VaultIssue,
} from "../types";

import {
  affinity,
  columnNames,
  q,
  schemaState,
  tableColumns,
  tableExists,
  type SqlHandle,
} from "./db";
import { referencedMedia, summarize } from "./export";
import { columnPlan, type ColumnPlan } from "./manifest";
import { fsPath, removeFile } from "./paths";
import type { PreferenceTable } from "./provenance";
import { MAX_LINE, readLines, rowDecoder } from "./rows";
import { ensureSyncIds, VAULT_OWNED_COLUMNS } from "./sid";

/** Rows per scratch transaction while inserting (the scratch is private: holding it across awaits is fine). */
const BATCH = 1000;
/** Foreign-key repair passes (a CASCADE can orphan grandchildren, repaired by the next pass). */
const REPAIR_PASSES = 10;

/** What the scratch is built from. */
export type ScratchSource =
  | {
      format: "v2";
      manifest: Manifest;
      /** The archive's schema level (manifest.schema.applied, checked by openArchive). */
      applied: number;
      /** table → its extracted, verified NDJSON file */
      data: ReadonlyMap<string, File>;
    }
  | { format: "legacy"; parsed: unknown };

export interface ScratchOptions {
  /** The restore's work folder: scratch.db is created in it. */
  work: Directory;
  source: ScratchSource;
  /** The restore context without `incoming`, which is read from the scratch before prepareScratch (§5.2). */
  context: Omit<RestoreContext, "incoming">;
  signal?: AbortSignal;
  onProgress?: (p: Progress) => void;
}

export interface ScratchResult {
  /** The scratch file, closed. */
  file: File;
  /** Descriptor tables the swap replaces (spec §2.10 rule 6), descriptor order. */
  replaced: string[];
  /** Descriptor tables kept as on device: v2 tables that existed at the archive's level but are not in it. */
  kept: string[];
  /** Columns of each replaced table in the migrated scratch (the swap's column lists). */
  columns: Map<string, string[]>;
  /** keys-mode tables: the keys the scratch holds. */
  keys: Map<string, string[]>;
  context: RestoreContext;
  /** Foreign-key repairs (one per row) and non-fatal validator issues. */
  repairs: VaultIssue[];
  /** The descriptor summary of the restored data. */
  counts: SummaryValues;
  /** media set → the names the restored rows reference (only sets whose table is replaced). */
  refs: Map<string, unknown[]>;
}

// ---------------------------------------------------------------------------------------------------------------
// Health provenance values (installation, healthInstallations) of a database: live, scratch, before an erase

/** The key/value table holding the Health installation keys (body, lift, macro: `preferences`), or null (water). */
export function installationPreferences(): PreferenceTable | null {
  const table = vaultApp.tables.find(
    (t) => t.mode === "keys" && t.keys?.include.includes("installation")
  );
  return table?.keys
    ? { table: table.name, keyColumn: table.keys.keyColumn, valueColumn: table.keys.valueColumn }
    : null;
}

/** `installation` and `healthInstallations` (a JSON array; anything else counts as empty) of a database. */
export function provenanceOf(db: SqlReader): RestoreContext["live"] {
  const prefs = installationPreferences();
  if (!prefs || !tableExists(db, prefs.table))
    return { installation: null, healthInstallations: [] };
  const read = (key: string) =>
    db.getFirstSync<{ v: unknown }>(
      `SELECT ${q(prefs.valueColumn)} AS v FROM ${q(prefs.table)} WHERE ${q(prefs.keyColumn)} = ?`,
      [key]
    )?.v;
  let list: unknown = [];
  try {
    list = JSON.parse(String(read("healthInstallations") ?? "[]"));
  } catch {
    // the app wrote something else: no lineage
  }
  const installation = read("installation");
  return {
    installation: typeof installation === "string" && installation ? installation : null,
    healthInstallations: Array.isArray(list)
      ? list.filter((id): id is string => typeof id === "string" && id !== "")
      : [],
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Repairs

/** A foreign-key violation row of PRAGMA foreign_key_check. */
type Violation = { table: string; rowid: number | null; parent: string; fkid: number };

/**
 * Generic foreign-key repair (spec §3.6.2 step 8), never business rules: each violating row gets what its foreign
 * key's ON DELETE action would have done — CASCADE deletes it, SET NULL nulls the referencing columns, SET DEFAULT
 * gives them their defaults; NO ACTION / RESTRICT cannot be repaired → `invalidData`. Up to 10 passes (a deleted
 * row can orphan its own children). Violations whose parent is in `skip` (tables the restore keeps as on device,
 * empty in the scratch) are left for the swap's final check against the live parents. One issue per repaired row.
 */
export function repairForeignKeys(
  db: SqlHandle,
  skip: ReadonlySet<string> = new Set()
): VaultIssue[] {
  const repairs: VaultIssue[] = [];
  for (let pass = 0; pass < REPAIR_PASSES; pass++) {
    const violations = db
      .getAllSync<Violation>("PRAGMA foreign_key_check")
      .filter((v) => !skip.has(v.parent));
    if (!violations.length) return repairs;
    const deleted = new Set<string>();
    for (const v of violations) {
      // A row with two broken keys is repaired (and counted) once when the first deletes it.
      if (deleted.has(`${v.table}:${v.rowid}`)) continue;
      const keys = db
        .getAllSync<{ id: number; from: string; on_delete: string }>(
          'SELECT "id", "from", "on_delete" FROM pragma_foreign_key_list(?)',
          [v.table]
        )
        .filter((k) => k.id === v.fkid);
      const action = (keys[0]?.on_delete ?? "NO ACTION").toUpperCase();
      if (
        v.rowid === null ||
        !keys.length ||
        !["CASCADE", "SET NULL", "SET DEFAULT"].includes(action)
      )
        throw new VaultError("invalidData", { detail: v.table });
      if (action === "CASCADE") {
        db.runSync(`DELETE FROM ${q(v.table)} WHERE rowid = ?`, [v.rowid]);
        deleted.add(`${v.table}:${v.rowid}`);
      } else {
        const defaults = new Map(tableColumns(db, v.table).map((c) => [c.name, c.defaultSql]));
        const set = keys.map((k) => {
          const value = action === "SET DEFAULT" ? (defaults.get(k.from) ?? null) : null;
          return `${q(k.from)} = ${value === null ? "NULL" : `(${value})`}`;
        });
        db.runSync(`UPDATE ${q(v.table)} SET ${set.join(", ")} WHERE rowid = ?`, [v.rowid]);
      }
      repairs.push({ table: v.table, fatal: false, message: `fk:${action.toLowerCase()}` });
    }
  }
  const left = db
    .getAllSync<Violation>("PRAGMA foreign_key_check")
    .filter((v) => !skip.has(v.parent));
  if (left.length) throw new VaultError("invalidData", { detail: left[0].table });
  return repairs;
}

// ---------------------------------------------------------------------------------------------------------------
// Building

/** Inserts every manifest table's NDJSON rows (spec §3.6.2 step 4), 1,000 rows per transaction. */
async function insertRows(
  scratch: SQLiteDatabase,
  manifest: Manifest,
  plans: ColumnPlan[],
  data: ReadonlyMap<string, File>,
  options: Pick<ScratchOptions, "signal" | "onProgress">
): Promise<void> {
  const total = manifest.tables.reduce((sum, t) => sum + t.rows, 0);
  let inserted = 0;
  let shown = -1;
  const progress = () => {
    const percent = total ? Math.floor((inserted * 100) / total) : 100;
    if (percent === shown) return;
    shown = percent;
    options.onProgress?.({ step: "scratch", done: percent, total: 100 });
  };
  progress();
  for (const plan of plans) {
    const table = manifest.tables.find((t) => t.name === plan.table);
    const file = data.get(plan.table);
    if (!table || !file) throw new VaultError("corrupt", { detail: `missing:${plan.table}` });
    if (!plan.insert.length) continue;
    const types = new Map(tableColumns(scratch, plan.table).map((c) => [c.name, c.type]));
    const decode = rowDecoder(
      plan.columns,
      plan.columns.map((c) => (plan.dropped.includes(c) ? null : affinity(types.get(c) ?? "")))
    );
    const statement = scratch.prepareSync(
      `INSERT INTO ${q(plan.table)} (${plan.insert.map(q).join(", ")}) ` +
        `VALUES (${plan.insert.map(() => "?").join(", ")})`
    );
    let rows = 0;
    try {
      scratch.execSync("BEGIN");
      rows = await readLines(file, { maxLine: MAX_LINE, signal: options.signal }, (line) => {
        statement.executeSync(decode(line));
        inserted++;
        if (++rows % BATCH === 0) {
          scratch.execSync("COMMIT");
          progress();
          scratch.execSync("BEGIN");
        }
      });
      scratch.execSync("COMMIT");
    } catch (e) {
      if (scratch.isInTransactionSync()) scratch.execSync("ROLLBACK");
      throw e;
    } finally {
      statement.finalizeSync();
    }
    if (rows !== table.rows) throw new VaultError("corrupt", { detail: `rows:${plan.table}` });
    progress();
  }
}

/**
 * Builds and checks the scratch database (spec §3.6.2): replay the migrations to the archive's level N, add the
 * vault-owned columns, insert the rows, restore sqlite_sequence, migrate forward, backfill sync ids, repair foreign
 * keys, integrity checks, prepareScratch, validators. Legacy v1 files: the adapter writes the parsed backup into a
 * scratch at the current level instead (in its own transaction). Errors: `unknownSchema` (another lineage, a column
 * this reader cannot place), `corrupt` (a damaged line or count), `invalidData` (an orphan without a repair, a fatal
 * validator issue, a constraint), `cancelled`.
 */
export async function buildScratch(options: ScratchOptions): Promise<ScratchResult> {
  const { source, signal } = options;
  const journal = vaultApp.migrations.journal;
  const file = new File(options.work, "scratch.db");
  for (const suffix of ["", "-journal"]) removeFile(new File(options.work, `scratch.db${suffix}`));
  const scratch = openDatabaseSync(file.name, { useNewConnection: true }, fsPath(options.work));
  let open = true;
  try {
    // Explicit: never rely on a connection default (expo-sqlite opens with foreign keys off, node:sqlite with on).
    scratch.execSync(
      "PRAGMA journal_mode = DELETE; PRAGMA synchronous = OFF; PRAGMA foreign_keys = OFF;"
    );
    const orm = drizzle(scratch);

    // 1–2. The app's own migrations up to the archive's level (a truncated journal replays exactly those).
    const level = source.format === "v2" ? source.applied : journal.entries.length;
    await migrate(orm, {
      journal: { ...journal, entries: journal.entries.slice(0, level) },
      migrations: vaultApp.migrations.migrations,
    });
    const replayed = schemaState(scratch, journal);
    if (
      replayed.applied !== level ||
      (source.format === "v2" && replayed.lastCreatedAt !== source.manifest.schema.lastCreatedAt)
    )
      throw new VaultError("unknownSchema", { detail: "replay" });
    const names = vaultApp.tables.map((t) => t.name);
    const atLevel = new Set(names.filter((t) => tableExists(scratch, t)));

    // Rule 6: a v2 restore replaces the tables the archive lists and those created after its level; a legacy
    // restore the tables its adapter declares (within their scope).
    let replaced: string[];
    if (source.format === "v2") {
      const listed = new Set(source.manifest.tables.map((t) => t.name));
      replaced = names.filter((t) => listed.has(t) || !atLevel.has(t));
    } else {
      const legacy = vaultApp.legacy;
      if (!legacy) throw new VaultError("notArchive", { detail: "legacy" });
      const declared = new Set(legacy.tables.map((t) => t.name));
      replaced = names.filter((t) => declared.has(t));
    }
    const kept = names.filter((t) => !replaced.includes(t));

    if (source.format === "v2") {
      // 3–4. Vault-owned columns at level N, then the rows exactly as archived.
      const { manifest } = source;
      const plans = columnPlan(manifest, {
        tables: names,
        owned: VAULT_OWNED_COLUMNS,
        columnsAt: (t) => (atLevel.has(t) ? columnNames(scratch, t) : null),
      });
      ensureSyncIds(scratch, {
        tables: plans.filter((p) => p.owned.length).map((p) => p.table),
        backfill: false,
      });
      await insertRows(scratch, manifest, plans, source.data, options);

      // 5. The archive's high-water marks (informational: the swap takes the manifest's, §3.7).
      if (tableExists(scratch, "sqlite_sequence"))
        for (const t of manifest.tables) {
          if (typeof t.sequence !== "number") continue;
          const { changes } = scratch.runSync(
            'UPDATE sqlite_sequence SET "seq" = max(ifnull("seq", 0), ?) WHERE "name" = ?',
            [t.sequence, t.name]
          );
          if (!changes)
            scratch.runSync('INSERT INTO sqlite_sequence ("name", "seq") VALUES (?, ?)', [
              t.name,
              t.sequence,
            ]);
        }

      // 6. Forward to the current level: the app's real migrations transform the old data.
      checkAborted(signal);
      options.onProgress?.({ step: "migrate" });
      await migrate(orm, vaultApp.migrations);
      if (schemaState(scratch, journal).pending)
        throw new VaultError("unknownSchema", { detail: "migrate" });
    } else {
      options.onProgress?.({ step: "scratch", done: 0, total: 100 });
      vaultApp.legacy?.write(scratch, source.parsed);
      if (scratch.isInTransactionSync()) {
        scratch.execSync("ROLLBACK");
        throw new VaultError("restoreFailed", { detail: "legacyTransaction" });
      }
      options.onProgress?.({ step: "scratch", done: 100, total: 100 });
    }

    // 7. Sync ids: heals a column a historical rebuild dropped, gives rows of older archives fresh ids.
    ensureSyncIds(scratch, {
      tables: vaultApp.syncIdTables ?? [],
      backfill: true,
      triggers: false,
    });

    // 8–9. Generic repairs, then integrity.
    checkAborted(signal);
    options.onProgress?.({ step: "validate" });
    const repairs = repairForeignKeys(scratch, new Set(kept));
    const integrity = scratch.getAllSync<{ integrity_check: string }>("PRAGMA integrity_check");
    if (integrity.length !== 1 || integrity[0].integrity_check !== "ok")
      throw new VaultError("invalidData", { detail: "integrity" });

    // 10. The descriptor's repairs and provenance policy (§5.3), with the archive's provenance values.
    const context: RestoreContext = { ...options.context, incoming: provenanceOf(scratch) };
    for (const s of vaultApp.prepareScratch?.(context) ?? [])
      scratch.runSync(s.sql, s.params ?? []);

    // 11. Validators: crash guards only; a fatal issue stops the restore before anything changed.
    const issues = vaultApp.validate?.(scratch) ?? [];
    const fatal = issues.find((i) => i.fatal);
    if (fatal) throw new VaultError("invalidData", { detail: fatal.table });
    repairs.push(...issues);

    // 12. What the swap and the media plan need.
    const columns = new Map(replaced.map((t) => [t, columnNames(scratch, t)]));
    const keys = new Map<string, string[]>();
    for (const t of vaultApp.tables)
      if (t.mode === "keys" && t.keys && replaced.includes(t.name))
        keys.set(
          t.name,
          scratch
            .getAllSync<{ k: unknown }>(
              `SELECT DISTINCT ${q(t.keys.keyColumn)} AS k FROM ${q(t.name)}`
            )
            .map((r) => String(r.k))
        );
    const refs = new Map<string, unknown[]>();
    for (const set of vaultApp.media ?? [])
      if (replaced.includes(set.table)) refs.set(set.set, referencedMedia(scratch, set));
    const counts = summarize(scratch);

    // 13. Closed: the swap ATTACHes the file, and no handle may hold a lock on it.
    scratch.closeSync();
    open = false;
    return { file, replaced, kept, columns, keys, context, repairs, counts, refs };
  } finally {
    if (open) scratch.closeSync();
  }
}
