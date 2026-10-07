// The vault contract (docs/vault.md): app identity, the descriptor every app provides in src/vault-app.ts, the archive
// manifest, the engine's public API types, the native and cloud surfaces and the status the UI shows. Types only.
// Append-only after T1.1: a later task may add members or types, each marked `// added by <task>` with a line in
// vector-design/vault/CHANGELOG.md, and never changes or removes an existing one.
import type { File } from "expo-file-system";
import type { SQLiteBindValue, SQLiteDatabase } from "expo-sqlite";

import type { KitLanguage } from "@/vector";

import type { VaultErrorCode } from "./errors";

// ---------------------------------------------------------------------------------------------------------------
// App identity (src/vault/apps.json)

export type AppId = "body" | "lift" | "macro" | "water";
export type DevicePlatform = "ios" | "android";
export type DeviceKind = "phone" | "tablet";

/** One row of src/vault/apps.json, read by TypeScript (resolveJsonModule) and by the config plugin (require). */
export interface AppIdentity {
  /** Brand name, never translated: "Pendum Lift". */
  name: string;
  bundleId: string;
  /** Archive extension without the dot: "pendumlift". */
  extension: string;
  /** Exported UTI: conforms to public.data and public.content, not public.zip-archive. */
  uti: string;
  /** RFC 6839 `+zip` MIME type. */
  mime: string;
  /** The Files "Kind" column, English in every language. */
  typeName: string;
  /** Manual export names: `<fileStem>-<YYYY>-<MM>-<DD>-<HHmmss>.<extension>`. */
  fileStem: string;
  /** File name in expo-sqlite's default directory; equals the descriptor's `database.name` (vault-kit check). */
  database: string;
  /** SQLite journal mode: "delete" (body) or "wal". */
  journal: string;
  /** Folders under Paths.document that hold media (Android backup rules). */
  mediaDirs: string[];
  /** The last Drizzle journal idx shipped before the vault: migration guards apply to later migrations only. */
  syncIdBaseline: number;
}

// ---------------------------------------------------------------------------------------------------------------
// Database access

export interface VaultDatabaseAccess {
  /** File name in expo-sqlite's default directory, e.g. "body_track.db". Must equal apps.json[id].database (vault-kit check). */
  name: string;
  /**
   * The connection vault work (snapshot, swap, triggers, state) runs on.
   *  body/lift/macro: the app's module-level `expoDb`, imported lazily (`(await import("@/db")).expoDb`) — the same connection
   *    the app writes on, so the commit section never waits for a lock and never races an app write: JS is single-threaded
   *    and every vault write block is synchronous.
   *  water: a NEW connection: openDatabaseAsync("water-track.db", { useNewConnection: true, enableChangeListener: false })
   *    followed by the app's initializeDatabase() and `PRAGMA busy_timeout = 5000`. No change listener, so a restore of
   *    5,000 drinks does not fire 5,000 useLiveQuery re-queries. Writers on other connections are detected by the swap
   *    (`PRAGMA data_version`).
   */
  acquire(): Promise<SQLiteDatabase>;
  /** body/lift/macro: no-op. water: closeAsync(). */
  release(db: SQLiteDatabase): Promise<void>;
  /** Called once after a swap commits. water: nudge useLiveQuery; others: omit. */
  announceChange?(): Promise<void>;
}

// ---------------------------------------------------------------------------------------------------------------
// Descriptor contract (src/vault-app.ts, app-owned)

export type Journal = {
  version: string;
  dialect: string;
  entries: { idx: number; when: number; tag: string; breakpoints: boolean }[];
};
/** The default export of drizzle/migrations.js. */
export type DrizzleMigrations = { journal: Journal; migrations: Record<string, string> };
export type VaultSql = { sql: string; params?: SQLiteBindValue[] };
export type SummaryValues = Record<string, number | string | null>;

/**
 * Read-only SQL on any connection (live, snapshot, scratch). Two overloads rather than one optional `params`, so an
 * expo-sqlite SQLiteDatabase (whose getters are overloaded the same way) satisfies it.
 */
export interface SqlReader {
  getFirstSync<T>(sql: string, params: SQLiteBindValue[]): T | null;
  getFirstSync<T>(sql: string): T | null;
  getAllSync<T>(sql: string, params: SQLiteBindValue[]): T[];
  getAllSync<T>(sql: string): T[];
}

export type RestoreReason = "file" | "cloud" | "recovery" | "handoff" | "legacyRecovery";

export interface RestoreContext {
  reason: RestoreReason;
  legacy: boolean;
  /** Archive platform !== this platform. */
  crossPlatform: boolean;
  /** Archive device id === this device id. */
  sameDevice: boolean;
  healthWasOn: boolean;
  platform: DevicePlatform;
  now: Date;
  /** Provenance values read in JS at restore step 1 (live) and from the scratch (incoming). */
  live: { installation: string | null; healthInstallations: string[] };
  incoming: { installation: string | null; healthInstallations: string[] };
  /** A new installation id minted by the vault for this restore (`${Date.now()}-${rand36}`), used when !sameDevice. */
  freshInstallation: string;
}

export interface DescribeContext {
  language: KitLanguage;
  /** useKitFormat().plural */
  plural(n: number): Intl.LDMLPluralRule;
  /** useKitFormat().number */
  number(n: number): string;
  /** ISO / "YYYY-MM-DD" (local noon) / epoch ms → kit "medium" date. */
  date(value: string | number): string;
}

export interface VaultIssue {
  table: string;
  fatal: boolean;
  message: string;
}

export interface VaultTable {
  name: string;
  mode: "replace" | "keys" | "singleton";
  /** data: user records; settings: user preferences; provenance: health bookkeeping (exported; never counted in seq). */
  role: "data" | "settings" | "provenance";
  /** Never exported; on restore keep the live value (singleton) or take the column DEFAULT (replace). */
  deviceColumns?: readonly string[];
  /** mode "keys": key/value table filtered to `include`; `provenance` ⊆ include are health keys (not counted in seq). */
  keys?: {
    keyColumn: string;
    valueColumn: string;
    include: readonly string[];
    provenance?: readonly string[];
  };
  /** mode "singleton": one row. */
  singleton?: { idColumn: string; where: string };
}

export interface VaultMediaSet {
  set: string;
  /** Under Paths.document. */
  directory: string;
  table: string;
  column: string;
}

/** body/lift/macro: drives the generic provenance merge and installation rules. water: absent. */
export interface VaultHealth {
  /** client-id namespace written by the app: "body-track" | "lift-track" | "macro-track" */
  clientPrefix: string;
  /** local_kind → table holding the local row (`main.<table>.id = health_links.local_id`) */
  rowTables: Readonly<Record<string, string>>;
}

export interface VaultLegacy<P> {
  formats: { plain: string; encrypted: string };
  maxBytes: number;
  /** Any throw → legacyPasswordWrong. */
  decrypt(text: string, password: string): Promise<string>;
  /** Any throw → corrupt. */
  parse(text: string): P;
  createdAt(parsed: P): string;
  counts(parsed: P): SummaryValues;
  /** Replaced tables; scope = SQL WHERE limiting the replace. */
  tables: readonly { name: string; scope?: string }[];
  /** keys-mode keys replaced. */
  preferenceKeys: readonly string[];
  /** Synchronous; scratch is migrated to the current level. */
  write(scratch: SQLiteDatabase, parsed: P): void;
  /** Used instead of deviceOverrides for legacy restores. */
  overrides(ctx: RestoreContext): VaultSql[];
  /** The newest v1 pre-restore copy still on disk, resolved by basename under the app's backup folder. */
  recoveryCopy(db: SqlReader): { file: File; createdAt: string } | null;
}

export interface VaultApp {
  id: AppId;
  database: VaultDatabaseAccess;
  migrations: DrizzleMigrations;
  /** Parents before children (FK order). */
  tables: readonly VaultTable[];
  media?: readonly VaultMediaSet[];
  /** key → SQL returning one row with column `v`; run on snapshot (export), scratch (confirm) and live (current).
   *  Must include `latest` (newest user-record timestamp as an ISO string or YYYY-MM-DD) for `newerLocalChanges`. */
  summary: Readonly<Record<string, string>>;
  /**
   * Localised count phrases for <Meta items>. A plain function (not a hook): uses the app's own `translate(language, key)`
   * and `interpolate(text, values)` (body/lift/macro `@/lib/translations`, water `@/lib/i18n`), picks the `…One` key when
   * `ctx.plural(n) === "one"`, and passes the placeholder name that app's keys use.
   */
  describe(values: SummaryValues, ctx: DescribeContext): string[];
  /**
   * SQL returning one row with column `v` truthy when the library holds no user records — a fresh install, an erased
   * library, or only rows the app writes by itself (water's `counters` row and drink tombstones; lift's default gym).
   * Default (absent): every `role: "data"` table is empty. `libraryEmpty(db)` (`engine/ready.ts`) evaluates it on the live
   * DB and is the only emptiness test anywhere.
   */
  emptySql?: string;
  /** Manual exports only. Lazily imports the app's CSV builders. */
  csv?(
    snapshot: SQLiteDatabase,
    ctx: { language: KitLanguage }
  ): Promise<{ name: string; text: string }[]>;
  /** Crash/corruption guards only. Runs on the export snapshot (warnings) and the migrated scratch DB (fatal). */
  validate?(db: SqlReader): VaultIssue[];
  /** Statements run on the scratch DB after FK repair and integrity checks: preference repairs + provenance policy. */
  prepareScratch?(ctx: RestoreContext): VaultSql[];
  /**
   * Statements run inside the swap transaction around the delete/insert steps (legacy restores too), `after` after the
   * generic provenance merge. Both may read `temp._vault_live_links` (this device's links before the delete step); it
   * exists only when `health_links` is replaced, so a hook that reads it creates it with IF NOT EXISTS in `before`.
   */
  swap?(ctx: RestoreContext): { before?: VaultSql[]; after?: VaultSql[] };
  /** Statements run inside the swap transaction on the live DB (device-state scrub). */
  deviceOverrides(ctx: RestoreContext): VaultSql[];
  /** Returns column `v` truthy when the app's health sync is on (live DB and export snapshot). */
  healthEnabledSql?: string;
  health?: VaultHealth;
  /** lift and macro: the v1 import adapter (src/vault-legacy.ts); `any` because each app parses its own v1 shape. */
  legacy?: VaultLegacy<any>;
  hooks: {
    /**
     * Wait (≤ timeoutMs) until the app's health sync is idle and, in the same synchronous tick, hold it off while `work`
     * runs. Throws (any error) when it cannot acquire; the vault maps that to `healthBusy`.
     */
    pauseWhenIdle<T>(work: () => Promise<T>, timeoutMs: number): Promise<T>;
    /** Runs on the vault connection before a snapshot or restore (water: flush the watch/reminder queue). */
    beforeExport?(db: SQLiteDatabase): Promise<void> | void;
    /** Non-React follow-up after a committed restore (also run by crash roll-forward; must be idempotent). */
    afterRestore(ctx: RestoreContext): Promise<void>;
    /** M3: false while auto-presenting the handoff sheet would interrupt the user (lift: open workout or rest timer).
     *  Receives the vault's live connection, so it can stay plain SQL. Default: true. */
    canInterrupt?(db: SqlReader): boolean;
  };
  /** The minimumInterval the app's other expo-background-task registrations use (last registration wins globally). */
  backgroundIntervalMinutes: number;
  /** Integer-PK tables that carry a runtime-owned sync_id column. */
  syncIdTables?: readonly string[];
  /** Tables deliberately not exported (documentation + vault-kit check warning). */
  excludedTables: readonly string[];
}

// ---------------------------------------------------------------------------------------------------------------
// Archive manifest (manifest.json inside every archive; parsed and validated by engine/manifest.ts)

export interface ManifestTable {
  name: string;
  mode: "replace" | "keys" | "singleton";
  /** data/<name>.ndjson */
  file: string;
  rows: number;
  /** Exported columns in PRAGMA table_info order. */
  columns: string[];
  /** mode keys only: the key universe in scope. */
  keys?: string[];
  /** sqlite_sequence.seq for AUTOINCREMENT tables. */
  sequence?: number | null;
  /** Of the uncompressed NDJSON bytes. */
  sha256: string;
  /** Uncompressed size. */
  bytes: number;
}

export interface ManifestMedia {
  set: string;
  name: string;
  bytes: number;
  sha256: string;
  /** true: file at media/<set>/<name>; false: resolved by a MediaSource. */
  embedded: boolean;
}

export interface ManifestFile {
  path: string;
  role: "csv" | "readme";
  sha256: string;
  bytes: number;
}

export interface Manifest {
  format: "pendum.archive";
  formatVersion: number;
  minReaderVersion: number;
  kind: ArchiveKind;
  /** ISO-8601 UTC with ms, e.g. 2026-10-04T15:30:12.345Z */
  createdAt: string;
  app: {
    id: AppId;
    bundleId: string;
    /** Brand name at export time, e.g. Pendum Body. */
    name: string;
    /** CFBundleShortVersionString / versionName */
    version: string;
    /** CFBundleVersion / versionCode */
    build: string;
    platform: DevicePlatform;
    osVersion: string;
    /** VAULT_VERSION of the writer. */
    vault: string;
  };
  schema: {
    /** Applied Drizzle journal entries. */
    applied: number;
    /** MAX(__drizzle_migrations.created_at) = journal[applied-1].when */
    lastCreatedAt: number;
    /** journal[applied-1].tag */
    lastTag: string;
    /** Entries in the writer app's journal (informational). */
    journalLength: number;
  };
  device: { id: string; platform: DevicePlatform; kind: DeviceKind; model: string };
  library: {
    id: string;
    /** M3: writer's gen at snapshot time (read from the snapshot). */
    gen?: number;
    /** M3: writer's own seq at snapshot time (read from the snapshot). */
    seq?: number;
    /** M3: version vector {deviceId: seq} of the state in this archive. */
    vector?: Record<string, number>;
    adoptedFrom?: { deviceId?: string; seq?: number; archive?: string };
  };
  tables: ManifestTable[];
  media: ManifestMedia[];
  /** Rows referenced files that were absent on the writer (rows are still exported). */
  missingMedia?: { set: string; name: string }[];
  /** Vault-owned columns present in the data (today ["sync_id"]); a reader that does not own one ignores it. */
  vaultColumns?: string[];
  /** Export-time FK/validator findings; informational. */
  warnings?: VaultIssue[];
  files: ManifestFile[];
  /** Descriptor summary values for the preview; display only, never trusted. */
  counts: SummaryValues;
  /** health: health_links + installation keys are included; healthSyncOn: the writer's Health sync was on. */
  provenance?: { health?: boolean; healthSyncOn?: boolean };
}

// ---------------------------------------------------------------------------------------------------------------
// Engine API (src/vault/engine/*, re-exported for UI and cloud code)

export type ArchiveKind = "manual" | "auto" | "pre-restore";
export type Step =
  | "snapshot"
  | "data"
  | "media"
  | "csv"
  | "zip"
  | "upload"
  | "download"
  | "verify"
  | "scratch"
  | "migrate"
  | "validate"
  | "recovery"
  | "swap"
  | "finish";
/** done/total are percent (0–100) for byte-based steps and counts for table/photo steps; UI throttles. */
export type Progress = { step: Step; done?: number; total?: number };

export interface ExportOptions {
  kind: ArchiveKind;
  /** Must not exist; parent directory must exist. */
  destination: File;
  /** manual: true; auto, pre-restore: false */
  embedMedia: boolean;
  /** manual: true; others: false */
  csv: boolean;
  /** manual: 6; auto, pre-restore: 1 */
  deflateLevel: 1 | 6;
  /** Input slice per JS tick: 1 MiB for manual exports (user waits), 64 KiB for auto runs (keeps the UI responsive). */
  chunkBytes?: number;
  /** pre-restore only: package this existing VACUUM INTO copy instead of taking a new snapshot. */
  snapshotPath?: string;
  /**
   * Called after the data and media hashes are known and before any DEFLATE work. Returning false stops the export and
   * resolves with `{ unchanged: true }` — the auto-backup "nothing changed" path never zips.
   */
  beforeZip?: (contentHash: string) => Promise<boolean>;
  signal?: AbortSignal;
  onProgress?: (p: Progress) => void;
  /** internal: `${set}/${name}` → { bytes, sha256 } already computed by the restore's media plan (photos hashed once) */
  knownMedia?: Map<string, { bytes: number; sha256: string }>;
  // added by T1.4
  /** manual exports: the language of the CSV copies (descriptor `csv(snapshot, { language })`); default "en". */
  language?: KitLanguage;
}

export interface MediaRef {
  set: string;
  name: string;
  bytes: number;
  sha256: string;
  /** The live file. */
  uri: string;
}

export interface ExportResult {
  /** true only when beforeZip returned false (no file written) */
  unchanged: boolean;
  file: File | null;
  manifest: Manifest | null;
  /** sha256 over the canonical JSON of [[table, sha256, rows]…] + [[set, name, sha256]…]; equal ⇔ same content. */
  contentHash: string;
  media: MediaRef[];
  /** Read from the snapshot connection, never from the live DB. M1/M2: seq = gen = 0, vector = {}. */
  counters: {
    deviceId: string;
    libraryId: string;
    gen: number;
    seq: number;
    vector: Record<string, number>;
  };
  /** Export-time validation: the same FK check and descriptor validators a restore applies. */
  warnings: VaultIssue[];
}

export interface Preview {
  format: "v2" | "legacy";
  kind: ArchiveKind | "legacy";
  /** ISO */
  createdAt: string;
  appVersion: string | null;
  device: { platform: DevicePlatform; kind: DeviceKind; model: string } | null;
  /** Descriptor summary keys. */
  incoming: SummaryValues;
  /** Same keys on the live DB. */
  current: SummaryValues;
  /** N < journal length */
  olderSchema: boolean;
  /** manifest.app.platform !== Platform.OS */
  crossPlatform: boolean;
  /** manifest.device.id === this device id */
  sameDevice: boolean;
  /** libraryEmpty(live): no recovery set, no confirm. */
  liveEmpty: boolean;
  /** current.latest > incoming createdAt (descriptor summary key `latest`) */
  newerLocalChanges: boolean;
  /** manifest.provenance.healthSyncOn && !sameDevice */
  sourceHealthSyncOn: boolean;
  media: { count: number; bytes: number; embedded: number; missing: number };
  libraryId: string | null;
}

export interface OpenedArchive {
  /** Registered in the live-op registry until close(). */
  readonly opId: string;
  /** Private copy under work/<op>/in/ */
  readonly source: File;
  readonly format: "v2" | "legacy";
  readonly manifest: Manifest | null;
  readonly preview: Preview;
  /** Deletes the private work copy. Deferred while a restore of this archive is running. */
  close(): void;
}

export interface MediaSource {
  /**
   * COPY (or hard-link) the file for `item` to `dest` (which does not exist). Never moves or deletes the source: sources
   * include recovery sets and live files, whose only copy must survive a failed restore. Return false when this source
   * cannot supply it.
   */
  fetch(item: ManifestMedia, dest: File, signal?: AbortSignal): Promise<boolean>;
}

export interface RestoreOptions {
  reason: RestoreReason;
  /** Added after the archive's own embedded media. */
  media?: MediaSource;
  /**
   * handoff: a referenced name that HAS a manifest media item which no source can supply yet (the peer listed the photo
   * but its blob is not uploaded) and that has no live file aborts with `peerNotReady` instead of being skipped. Names
   * without a manifest item (in `missingMedia`, or absent) are skipped and counted in `mediaSkipped` as in every restore
   * — the peer itself lacks those files, so waiting would never help.
   */
  requireAllMedia?: boolean;
  /** Honoured until the commit section starts; never after. */
  signal?: AbortSignal;
  onProgress?: (p: Progress) => void;
}

export interface RestoreResult {
  /** null when the live library was empty (no recovery set) */
  recoveryId: string | null;
  mediaRestored: number;
  /** Incoming media no source could supply (rows kept, files missing). */
  mediaSkipped: number;
  /** Referenced names kept from the live folder although the archive lacked them. */
  mediaKeptLive: number;
  /** Sync was on before; UI shows the re-enable note. */
  healthWasOn: boolean;
  libraryId: string;
  /** FK/preference repairs applied to the scratch (shown in the done state). */
  repairs: VaultIssue[];
  /** Set when the swap committed but a post-commit step (afterRestore, announceChange, packaging) failed. */
  warning: "afterRestoreFailed" | null;
}

export interface VerifyResult {
  ok: boolean;
  problems: { path: string; problem: "missing" | "size" | "hash" | "manifest" }[];
}

/** latestRecovery(): only complete sets (recovery/<id>/data.<ext>); `legacy` = a v1 pre-restore copy. */
export type RecoveryInfo = { id: string; createdAt: string; legacy: boolean };

/** captureBeforeErase() → onLocalDataErased(token), around lift/macro eraseLocalData(). */
export type EraseToken = { healthInstallations: string[] };

// ---------------------------------------------------------------------------------------------------------------
// Native surface (modules/vector-vault through src/vault/native.ts)

export type DeviceInfo = {
  platform: DevicePlatform;
  /** iOS: UIDevice.userInterfaceIdiom == .pad; Android: smallestScreenWidthDp >= 600 */
  kind: DeviceKind;
  /** iOS: UIDevice.current.model ("iPhone"/"iPad"); Android: Build.MODEL */
  model: string;
  /** UIDevice.systemVersion / Build.VERSION.RELEASE */
  osVersion: string;
  /** CFBundleShortVersionString / PackageInfo versionName */
  appVersion: string;
  /** CFBundleVersion / PackageInfo longVersionCode */
  appBuild: string;
  /** sha256(bundleId + ":" + identifierForVendor) / sha256(packageName + ":" + ANDROID_ID), hex, first 32 chars.
   *  null when the platform id is unavailable (IDFV is nil before first unlock after a reboot and in some background
   *  launches; ANDROID_ID can be null). A null fingerprint never triggers clone handling. */
  fingerprint: string | null;
};

/** Build flags fixed at prebuild (Info.plist / AndroidManifest meta-data); JS never reads them from `extra`. */
export type VaultNativeConfig = {
  icloud: boolean;
  googleIos: boolean;
  googleAndroid: boolean;
  selftest: boolean;
};

/** An item of the iCloud ubiquity container (VaultICloud.swift). */
export type CloudItem = {
  path: string;
  size: number | null;
  modifiedAt: number | null;
  downloaded: boolean;
  uploaded: boolean;
  uploading: boolean;
  uploadErrorCode: number | null;
  conflicted: boolean;
};

// ---------------------------------------------------------------------------------------------------------------
// Cloud providers (implemented in src/vault/cloud/*)

/** "dropbox" reserved. */
export type ProviderId = "icloud" | "gdrive";

export type Availability =
  /** label: "iCloud" or the Google email */
  | { state: "available"; account?: { label: string } }
  /** Drive: never connected on this device */
  | { state: "needsConnect" }
  /** Drive: consent revoked / Android restore / iOS token gone */
  | { state: "needsReconnect" }
  | { state: "unavailable"; reason: "notConfigured" | "noAccount" | "driveOff" | "unsupported" };

export interface RemoteEntry {
  /** Logical path below the provider root, e.g. "pendum-lift/v2/devices/<id>.json". */
  path: string;
  /** Last path segment. */
  name: string;
  size: number | null;
  /** ms */
  modifiedAt: number | null;
  /** Provider handle: iCloud = path, Drive = fileId. */
  ref: string;
  /** iCloud: NSMetadataUbiquitousItemIsUploadedKey */
  uploaded?: boolean;
  /** iCloud upload error 4354 / 4355 / other */
  uploadError?: "quota" | "server" | "other" | null;
  /** iCloud: false while only metadata is local */
  downloaded?: boolean;
}

export interface VaultProvider {
  readonly id: ProviderId;
  availability(): Promise<Availability>;
  /** Interactive (Drive); throws VaultError("googleCancelled") on cancel. */
  connect?(): Promise<void>;
  disconnect?(): Promise<void>;
  /** Non-recursive listing of one logical directory; [] when it does not exist. */
  list(dir: string): Promise<RemoteEntry[]>;
  /** Upload `local` to `path`. move=true lets iCloud take ownership of a staging file (setUbiquitous). */
  put(
    local: File,
    path: string,
    options: { overwrite: boolean; move: boolean; contentType: string; signal?: AbortSignal }
  ): Promise<RemoteEntry>;
  get(
    entry: RemoteEntry,
    dest: File,
    options?: { signal?: AbortSignal; onProgress?(done: number, total: number): void }
  ): Promise<void>;
  remove(entry: RemoteEntry): Promise<void>;
  /** iCloud only: drop the local copy of an uploaded item (frees disk). */
  evict?(entry: RemoteEntry): Promise<void>;
}

// ---------------------------------------------------------------------------------------------------------------
// Status shown in the UI (useVaultStatus() in src/vault/ui/use-vault.ts)

export type ProviderStatus = {
  /** native.config() flag / client id present */
  configured: boolean;
  enabled: boolean;
  availability: Availability["state"] | "checking";
  lastOkAt: string | null;
  lastUploadAt: string | null;
  /** Provider confirmed the newest snapshot (Drive 200/201; iCloud uploaded == true). */
  lastConfirmedAt: string | null;
  lastError: VaultErrorCode | null;
  lastWarning: "invalidData" | null;
  /** iCloud only. */
  uploadError: "quota" | "server" | "other" | null;
  /** iCloud: newest own snapshot uploaded === false and no uploadError. */
  waitingForUpload: boolean;
  /** Drive email. */
  account: string | null;
};

/** M2 adds `anyReadable` (a provider lists a readable backup) and M3 `handoff`, appended by their tasks. */
export interface VaultStatus {
  providers: Record<ProviderId, ProviderStatus>;
  /** A vault operation holds the lock. */
  running: boolean;
  latestRecovery: RecoveryInfo | null;
  /** libraryEmpty(db) of the live DB, refreshed after ensureReady, every restore and erase. */
  libraryEmpty: boolean;
}
