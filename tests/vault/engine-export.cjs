// G18 (export part), G21, G22 and the export, snapshot, identity and inspect tests (synced, hash-checked; loaded by
// tests/vault.test.*): a manifest that describes exactly the snapshot it was made from (rows, identity, counters),
// export-time warnings, the beforeZip early return, media listing, CSV copies, runtime-owned sync ids, the device
// anchor and clone handling, and openArchive/verifyArchive. Every test runs the vault's real TypeScript in a harness
// world against this repo's real descriptor, schema and fixture.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Buffer } = require("node:buffer");
const fs = require("node:fs");
const path = require("node:path");

const vault = require("../vault-harness.cjs");

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const q = (name) => `"${name.replaceAll('"', '""')}"`;

/** The VaultError `fn` throws or rejects with (assertion error when it succeeds). */
async function vaultError(fn) {
  try {
    await fn();
  } catch (e) {
    if (e && e.name === "VaultError") return e;
    throw e;
  }
  assert.fail("expected a VaultError");
}

/** A world closed after the test, with the modules the tests use. */
async function open(t, options) {
  const w = await vault.world(options);
  t.after(() => w.close());
  const fsModule = w.require("expo-file-system");
  return {
    w,
    ...fsModule,
    app: w.vaultApp,
    paths: w.require("@/vault/engine/paths"),
    state: w.require("@/vault/engine/state"),
    device: w.require("@/vault/engine/device"),
    sid: w.require("@/vault/engine/sid"),
    snapshot: w.require("@/vault/engine/snapshot"),
    exporter: w.require("@/vault/engine/export"),
    inspect: w.require("@/vault/engine/inspect"),
  };
}

/** The identity ensureReady sets up before any export: device and library ids, sync ids. */
function identify(ctx, db) {
  ctx.device.ensureDevice(db, ctx.w.device);
  ctx.device.ensureLibrary(db);
  ctx.sid.ensureSyncIds(db);
}

/** A world with the app's live database, seeded at the current level and identified. */
async function seeded(t, options) {
  const ctx = await open(t, options);
  const db = await ctx.w.live();
  ctx.w.seed(db);
  identify(ctx, db);
  return { ...ctx, db };
}

/** exportArchive into Documents/out/<name> (manual defaults). */
function exportTo(ctx, name, options = {}) {
  fs.mkdirSync(ctx.w.file("out"), { recursive: true });
  return ctx.exporter.exportArchive({
    kind: "manual",
    destination: new ctx.File(ctx.w.uri("out", name)),
    embedMedia: true,
    csv: true,
    deflateLevel: 6,
    ...options,
  });
}

/** Every entry of an archive (fflate's own central-directory reader), as Buffers, plus their order. */
function unzip(ctx, file) {
  const { unzipSync } = ctx.w.require("fflate");
  const local = ctx.paths.fsPath(file);
  const entries = unzipSync(new Uint8Array(fs.readFileSync(local)));
  const { ArchiveReader } = ctx.w.require("@/vault/engine/zip-read");
  const reader = ArchiveReader.open(file);
  const order = [...reader.entries.keys()];
  const methods = Object.fromEntries([...reader.entries].map(([n, e]) => [n, e.method]));
  reader.close();
  return {
    order,
    methods,
    get: (name) => (entries[name] ? Buffer.from(entries[name]) : null),
  };
}

const sha256 = (bytes) => require("node:crypto").createHash("sha256").update(bytes).digest("hex");

/** Lines of an NDJSON entry, parsed. */
function ndjson(bytes) {
  const text = bytes.toString("utf8");
  assert.ok(text === "" || text.endsWith("\n"), "every line ends with \\n");
  return text === ""
    ? []
    : text
        .slice(0, -1)
        .split("\n")
        .map((line) => JSON.parse(line));
}

/** The rows a descriptor table exports, read from `db` (keys mode filtered, singleton filtered). */
function liveRows(db, table, columns) {
  let where = "";
  let params = [];
  if (table.mode === "keys") {
    where = ` WHERE ${q(table.keys.keyColumn)} IN (${table.keys.include.map(() => "?").join(", ")})`;
    params = [...table.keys.include];
  } else if (table.mode === "singleton") where = ` WHERE ${table.singleton.where}`;
  return db.getAllSync(
    `SELECT ${columns.map(q).join(", ")} FROM ${q(table.name)}${where} ORDER BY rowid`,
    params
  );
}

/** What is left under PendumVault/work (nothing after a finished operation). */
const workLeft = (ctx) =>
  fs.existsSync(ctx.w.file("PendumVault", "work"))
    ? fs.readdirSync(ctx.w.file("PendumVault", "work"))
    : [];

// ---------------------------------------------------------------------------------------------------------------
// Export: the manifest describes the snapshot

test(
  "export: a manual archive holds every exported row, its identity, CSV and README, manifest last",
  { skip: vault.skip },
  async (t) => {
    const ctx = await seeded(t);
    const { w, app, db, state, exporter, inspect } = ctx;
    const steps = [];
    const before = Date.now();
    const result = await exportTo(ctx, "manual.archive", { onProgress: (p) => steps.push(p) });
    const { manifest } = result;
    assert.equal(result.unchanged, false);
    assert.equal(result.file.uri, w.uri("out", "manual.archive"));

    // Identity: from the snapshot, which equals the live state here.
    const { vaultIdentity } = w.require("@/vault/app");
    assert.deepEqual(result.counters, {
      deviceId: state.readState(db, "device.id"),
      libraryId: state.readState(db, "library.id"),
      gen: 0,
      seq: 0,
      vector: {},
    });
    assert.equal(manifest.format, "pendum.archive");
    assert.equal(manifest.formatVersion, 2);
    assert.equal(manifest.minReaderVersion, 2);
    assert.equal(manifest.kind, "manual");
    assert.ok(
      Date.parse(manifest.createdAt) >= before - 1000 &&
        Date.parse(manifest.createdAt) <= Date.now()
    );
    assert.deepEqual(manifest.app, {
      id: app.id,
      bundleId: vaultIdentity.bundleId,
      name: vaultIdentity.name,
      version: w.device.appVersion,
      build: w.device.appBuild,
      platform: w.platform,
      osVersion: w.device.osVersion,
      vault: w.require("@/vault/version").VAULT_VERSION,
    });
    const journal = app.migrations.journal.entries;
    assert.deepEqual(manifest.schema, {
      applied: journal.length,
      lastCreatedAt: journal[journal.length - 1].when,
      lastTag: journal[journal.length - 1].tag,
      journalLength: journal.length,
    });
    assert.deepEqual(manifest.device, {
      id: result.counters.deviceId,
      platform: w.platform,
      kind: w.device.kind,
      model: w.device.model,
    });
    assert.deepEqual(
      manifest.library,
      { id: result.counters.libraryId },
      "no M3 fields without a clock"
    );

    // Rows: every descriptor table, in descriptor order, exactly the live rows of its exported columns.
    const zip = unzip(ctx, result.file);
    assert.deepEqual(
      manifest.tables.map((x) => x.name),
      app.tables.map((x) => x.name)
    );
    for (const entry of manifest.tables) {
      const table = app.tables.find((x) => x.name === entry.name);
      assert.equal(entry.mode, table.mode);
      assert.equal(entry.file, `data/${table.name}.ndjson`);
      const all = db
        .getAllSync(`SELECT name FROM pragma_table_info(?)`, [table.name])
        .map((c) => c.name);
      assert.deepEqual(
        entry.columns,
        all.filter((c) => !(table.deviceColumns ?? []).includes(c)),
        `${table.name}: PRAGMA order without device columns`
      );
      const bytes = zip.get(entry.file);
      assert.ok(bytes, entry.file);
      assert.equal(zip.methods[entry.file], 8, `${entry.file} is deflated`);
      assert.equal(entry.bytes, bytes.length);
      assert.equal(entry.sha256, sha256(bytes));
      const lines = ndjson(bytes);
      assert.equal(entry.rows, lines.length);
      for (const line of lines) assert.deepEqual(Object.keys(line), entry.columns, entry.name);
      assert.deepEqual(lines, liveRows(db, table, entry.columns), `${table.name} rows`);
      const sequences = db.getFirstSync(
        "SELECT 1 AS v FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'"
      );
      const seq =
        sequences &&
        db.getFirstSync("SELECT seq FROM sqlite_sequence WHERE name = ?", [table.name]);
      assert.equal(entry.sequence, seq ? seq.seq : null, `${table.name} sequence`);
      if (table.mode === "keys") assert.deepEqual(entry.keys, [...table.keys.include]);
      else assert.equal(entry.keys, undefined);
    }
    const prefs = app.tables.find((x) => x.mode === "keys");
    if (prefs) {
      const keys = ndjson(zip.get(`data/${prefs.name}.ndjson`)).map((r) => r[prefs.keys.keyColumn]);
      assert.ok(
        keys.length > 0 && keys.every((k) => prefs.keys.include.includes(k)),
        "key universe only"
      );
    }

    // Summary, provenance, warnings and sync ids.
    assert.deepEqual(manifest.counts, exporter.summarize(db));
    assert.deepEqual(Object.keys(manifest.counts), Object.keys(app.summary));
    assert.deepEqual(manifest.provenance, {
      health: !!app.health,
      healthSyncOn: exporter.healthSyncOn(db),
    });
    assert.deepEqual(manifest.warnings, result.warnings);
    assert.deepEqual(manifest.vaultColumns, app.syncIdTables?.length ? ["sync_id"] : []);

    // Files: CSV (with a BOM) when the descriptor has builders, README always; manifest.json last.
    const csv = manifest.files.filter((f) => f.role === "csv");
    assert.equal(csv.length > 0, !!app.csv);
    for (const f of manifest.files) {
      const bytes = zip.get(f.path);
      assert.ok(bytes, f.path);
      assert.equal(f.bytes, bytes.length);
      assert.equal(f.sha256, sha256(bytes));
      if (f.role === "csv")
        assert.ok(bytes.subarray(0, 3).equals(BOM), `${f.path} starts with a BOM`);
    }
    const readme = zip.get("README.txt").toString("utf8");
    assert.match(
      readme,
      new RegExp(
        `^This file is a ${vaultIdentity.name} backup made on \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}\\.`
      )
    );
    assert.deepEqual(
      manifest.files.filter((f) => f.role === "readme").map((f) => f.path),
      ["README.txt"]
    );
    assert.deepEqual(zip.order.slice(-2), ["README.txt", "manifest.json"]);
    assert.equal(
      zip.get("manifest.json").toString("utf8"),
      `${JSON.stringify(manifest, null, 2)}\n`
    );
    const { parseManifest } = w.require("@/vault/engine/manifest");
    assert.deepEqual(parseManifest(zip.get("manifest.json").toString("utf8"), app.id), manifest);
    const listed = new Set([
      ...manifest.tables.map((x) => x.file),
      ...manifest.media.map((m) => `media/${m.set}/${m.name}`),
      ...manifest.files.map((f) => f.path),
      "manifest.json",
    ]);
    assert.deepEqual([...zip.order].sort(), [...listed].sort(), "every entry is listed");

    // Integrity, progress and cleanup.
    assert.deepEqual(await inspect.verifyArchive(result.file), { ok: true, problems: [] });
    const kinds = [...new Set(steps.map((s) => s.step))];
    assert.deepEqual(
      kinds.filter((k) => k !== "media" && k !== "csv"),
      ["snapshot", "data", "zip"]
    );
    assert.deepEqual(steps.filter((s) => s.step === "zip").at(-1), {
      step: "zip",
      done: 100,
      total: 100,
    });
    assert.deepEqual(workLeft(ctx), []);
    assert.deepEqual(ctx.paths.liveOps(), []);
    if (app.id === "water")
      assert.equal(w.called("@/lib/watch", "saveQueuedDrinks").length, 1, "beforeExport ran");
  }
);

test(
  "export: the manifest carries the snapshot's identity and counters, never later live values",
  { skip: vault.skip },
  async (t) => {
    const ctx = await seeded(t);
    const { db, state, snapshot } = ctx;
    // An M3-shaped clock and lineage, so gen, seq and the vector are visible.
    db.execSync(
      'CREATE TABLE "_vault_clock" ("id" INTEGER PRIMARY KEY CHECK ("id" = 1), "gen" INTEGER NOT NULL DEFAULT 0, "seq" INTEGER NOT NULL DEFAULT 0, "paused" INTEGER NOT NULL DEFAULT 0, "source" TEXT); INSERT INTO "_vault_clock" ("id", "gen", "seq") VALUES (1, 7, 5)'
    );
    state.updateState(db, {
      "lineage.vector": JSON.stringify({ "peer-device": 3, bad: "x" }),
      "lineage.ownBase": "2",
      "lineage.adoptedFrom": JSON.stringify({ deviceId: "peer-device", seq: 3, archive: "a.zip" }),
    });
    const deviceId = state.readState(db, "device.id");
    const libraryId = state.readState(db, "library.id");
    const expected = {
      deviceId,
      libraryId,
      gen: 7,
      seq: 5,
      vector: { "peer-device": 3, [deviceId]: 5 },
    };
    assert.deepEqual(snapshot.readCounters(db), expected);

    let hash = null;
    const result = await exportTo(ctx, "counters.archive", {
      kind: "auto",
      embedMedia: false,
      csv: false,
      deflateLevel: 1,
      chunkBytes: 64 * 1024,
      // Runs after the snapshot: these live writes must not reach the manifest.
      beforeZip: async (contentHash) => {
        hash = contentHash;
        db.execSync('UPDATE "_vault_clock" SET "gen" = 99, "seq" = 98 WHERE "id" = 1');
        state.updateState(db, { "library.id": "00000000-0000-4000-8000-000000000000" });
        return true;
      },
    });
    assert.equal(result.contentHash, hash);
    assert.deepEqual(result.counters, expected);
    assert.deepEqual(result.manifest.library, {
      id: libraryId,
      gen: 7,
      seq: 5,
      vector: expected.vector,
      adoptedFrom: { deviceId: "peer-device", seq: 3, archive: "a.zip" },
    });
    assert.equal(result.manifest.device.id, deviceId);
    assert.equal(result.manifest.kind, "auto");
    assert.deepEqual(
      result.manifest.files.map((f) => f.role),
      ["readme"],
      "no CSV in automatic archives"
    );
    // Level 1 and the auto kind produce a valid archive too.
    assert.deepEqual(await ctx.inspect.verifyArchive(result.file), { ok: true, problems: [] });
  }
);

test(
  "export: a snapshot without a device or library id fails exportFailed (notReady) and leaves nothing",
  { skip: vault.skip },
  async (t) => {
    const ctx = await open(t);
    const db = await ctx.w.live();
    ctx.w.seed(db);
    const error = await vaultError(() => ctx.snapshot.readCounters(db));
    assert.deepEqual([error.code, error.info.detail], ["exportFailed", "notReady"]);
    const failed = await vaultError(() => exportTo(ctx, "not-ready.archive"));
    assert.deepEqual([failed.code, failed.info.detail], ["exportFailed", "notReady"]);
    ctx.device.ensureDevice(db, ctx.w.device);
    const library = await vaultError(() => exportTo(ctx, "not-ready.archive"));
    assert.deepEqual([library.code, library.info.detail], ["exportFailed", "notReady"]);
    assert.equal(fs.existsSync(ctx.w.file("out", "not-ready.archive")), false);
    assert.deepEqual(workLeft(ctx), []);
    assert.deepEqual(ctx.paths.liveOps(), []);
    ctx.device.ensureLibrary(db);
    const done = await exportTo(ctx, "ready.archive");
    assert.equal(done.unchanged, false);
  }
);

test(
  "export: beforeZip returning false stops before any archive work; the content hash follows the data",
  { skip: vault.skip },
  async (t) => {
    const ctx = await seeded(t);
    const { w, db, app } = ctx;
    const hashes = [];
    const auto = { kind: "auto", embedMedia: false, csv: false, deflateLevel: 1 };
    const skip = (contentHash) => {
      hashes.push(contentHash);
      return Promise.resolve(false);
    };
    const first = await exportTo(ctx, "unchanged.archive", { ...auto, beforeZip: skip });
    assert.equal(first.unchanged, true);
    assert.equal(first.file, null);
    assert.equal(first.manifest, null);
    assert.equal(fs.existsSync(w.file("out", "unchanged.archive")), false);
    assert.match(first.contentHash, /^[0-9a-f]{64}$/);
    assert.equal(first.contentHash, hashes[0]);
    assert.equal(first.counters.deviceId, ctx.state.readState(db, "device.id"));
    assert.deepEqual(workLeft(ctx), []);
    // Unchanged data, same hash; a changed row, another hash; the archive's hash is the same function.
    const again = await exportTo(ctx, "unchanged.archive", { ...auto, beforeZip: skip });
    assert.equal(again.contentHash, first.contentHash);
    const table = app.tables.find((x) => x.role === "data");
    const column = ctx.exporter
      .exportedColumns(db, table)
      .find((c) => /^(updated_at|consumed_at|measured_at|name|day)$/.test(c));
    assert.ok(column, `${table.name} has a column to touch`);
    const type = db.getFirstSync(
      `SELECT typeof(${q(column)}) AS t FROM ${q(table.name)} LIMIT 1`
    ).t;
    db.runSync(
      `UPDATE ${q(table.name)} SET ${q(column)} = ${type === "text" ? `${q(column)} || 'x'` : `${q(column)} + 1`} WHERE rowid = (SELECT min(rowid) FROM ${q(table.name)})`
    );
    const changed = await exportTo(ctx, "changed.archive", auto);
    assert.notEqual(changed.contentHash, first.contentHash);
    const repeat = await exportTo(ctx, "repeat.archive", { ...auto, beforeZip: skip });
    assert.equal(repeat.contentHash, changed.contentHash);
  }
);

// ---------------------------------------------------------------------------------------------------------------
// Snapshot

test(
  "snapshot: one consistent read-only copy; busy in a transaction; insufficientSpace; isolation from live writes",
  { skip: vault.skip },
  async (t) => {
    const ctx = await seeded(t);
    const { w, db, File, snapshot, app, paths } = ctx;
    const dest = new File(w.uri("snapshots", "copy.db"));
    fs.mkdirSync(w.file("snapshots"), { recursive: true });
    fs.writeFileSync(w.file("snapshots", "copy.db"), "stale");
    const snap = await snapshot.takeSnapshot(db, dest);
    const table = app.tables.find((x) => x.role === "data").name;
    const count = (conn) => conn.getFirstSync(`SELECT count(*) AS n FROM ${q(table)}`).n;
    const rows = count(db);
    assert.ok(rows > 0);
    assert.equal(count(snap), rows);
    // Read-only, and isolated: a live write after the copy is not in it.
    assert.throws(() => snap.runSync(`DELETE FROM ${q(table)}`), /readonly|query_only|read-only/i);
    db.runSync(`DELETE FROM ${q(table)} WHERE rowid = (SELECT min(rowid) FROM ${q(table)})`);
    assert.equal(count(db), rows - 1);
    assert.equal(count(snap), rows);
    assert.equal(snapshot.readCounters(snap).deviceId, ctx.state.readState(db, "device.id"));
    snap.closeSync();

    // A statement of the app still stepping on the shared connection: one retry after a tick, then busy.
    const stepping = (failures) => {
      let attempts = 0;
      return {
        attempts: () => attempts,
        isInTransactionSync: () => db.isInTransactionSync(),
        getFirstSync: (...args) => db.getFirstSync(...args),
        runSync: (sql, params) => {
          if (/^VACUUM INTO/.test(sql) && attempts++ < failures)
            throw new Error("Error code 1: cannot VACUUM - SQL statements in progress");
          return db.runSync(sql, params);
        },
      };
    };
    const once = stepping(1);
    const retried = await snapshot.takeSnapshot(once, new File(w.uri("snapshots", "retry.db")));
    assert.equal(once.attempts(), 2);
    assert.equal(count(retried), rows - 1);
    retried.closeSync();
    const twice = stepping(2);
    const stuck = await vaultError(() =>
      snapshot.takeSnapshot(twice, new File(w.uri("snapshots", "stuck.db")))
    );
    assert.deepEqual([stuck.code, stuck.info.detail, twice.attempts()], ["busy", "statement", 2]);
    assert.equal(fs.existsSync(w.file("snapshots", "stuck.db")), false);

    db.execSync("BEGIN");
    const busy = await vaultError(() =>
      snapshot.takeSnapshot(db, new File(w.uri("snapshots", "b.db")))
    );
    db.execSync("ROLLBACK");
    assert.equal(busy.code, "busy");
    w.disk.available = 1024;
    const full = await vaultError(() =>
      snapshot.takeSnapshot(db, new File(w.uri("snapshots", "c.db")))
    );
    assert.equal(full.code, "insufficientSpace");
    assert.ok(full.info.bytes > 16 * 1024 * 1024);
    assert.equal(fs.existsSync(w.file("snapshots", "c.db")), false);
    const failed = await vaultError(() => exportTo(ctx, "full.archive"));
    assert.equal(failed.code, "insufficientSpace");
    assert.equal(fs.existsSync(w.file("out", "full.archive")), false);
    assert.deepEqual(workLeft(ctx), []);
    assert.deepEqual(paths.liveOps(), []);
  }
);

test(
  "export: an existing destination, a pending migration and cancellation fail typed and leave nothing",
  { skip: vault.skip },
  async (t) => {
    const ctx = await seeded(t);
    const { w, File, paths } = ctx;
    fs.mkdirSync(w.file("out"), { recursive: true });
    fs.writeFileSync(w.file("out", "taken.archive"), "keep me");
    assert.equal((await vaultError(() => exportTo(ctx, "taken.archive"))).code, "exportFailed");
    assert.equal(fs.readFileSync(w.file("out", "taken.archive"), "utf8"), "keep me");

    // Cancellation with React Native's AbortSignal: before the start, and in the middle of the archive.
    const early = new AbortController();
    early.abort();
    assert.equal(
      (await vaultError(() => exportTo(ctx, "early.archive", { signal: early.signal }))).code,
      "cancelled"
    );
    const late = new AbortController();
    const cancelled = await vaultError(() =>
      exportTo(ctx, "late.archive", {
        signal: late.signal,
        onProgress: (p) => {
          if (p.step === "zip") late.abort();
        },
      })
    );
    assert.equal(cancelled.code, "cancelled");
    assert.equal(fs.existsSync(w.file("out", "late.archive")), false);
    const never = new AbortController();
    assert.equal((await exportTo(ctx, "never.archive", { signal: never.signal })).unchanged, false);
    assert.equal(typeof never.signal.throwIfAborted, "undefined", "the device-shaped signal");
    assert.deepEqual(workLeft(ctx), []);
    assert.deepEqual(paths.liveOps(), []);

    // A database one migration behind: migrationPending (the engine never exports a half-migrated library).
    const older = w.open("older.db", { useNewConnection: true });
    await w.migrate(older, vault.level - 1);
    identify(ctx, older);
    paths.setEngineEnv({ acquire: async () => older, release: async () => {} });
    t.after(() => paths.setEngineEnv(null));
    const pending = await vaultError(() => exportTo(ctx, "older.archive"));
    assert.equal(pending.code, "migrationPending");
    assert.equal(fs.existsSync(w.file("out", "older.archive")), false);
    assert.deepEqual(workLeft(ctx), []);
    assert.ok(new File(w.uri("out", "never.archive")).exists);
  }
);

// ---------------------------------------------------------------------------------------------------------------
// G18 (export part): FK orphans and validator issues are warnings

/** Data a validator of each app reports as fatal (the descriptor's own rules, spec §4.2–§4.5). */
const INVALID = {
  body: {
    table: "measurements",
    sql: "UPDATE measurements SET kind = 'weird' WHERE id = (SELECT min(id) FROM measurements)",
  },
  lift: {
    table: "gyms",
    sql: "UPDATE gyms SET unit = 'stone' WHERE id = (SELECT min(id) FROM gyms)",
  },
  macro: {
    table: "food_entries",
    sql: "UPDATE food_entries SET meal = 'Brunch' WHERE id = (SELECT min(id) FROM food_entries)",
  },
  water: {
    table: "drinks",
    sql: "UPDATE drinks SET kind = 'lava' WHERE rowid = (SELECT min(rowid) FROM drinks)",
  },
};

test(
  "G18 export: an FK orphan and a fatal validator issue still export, as warnings",
  { skip: vault.skip },
  async (t) => {
    const ctx = await seeded(t);
    const { db, app } = ctx;
    // An orphan in the first exported table that declares a foreign key with rows (lift; the others have none).
    const child = app.tables
      .map((x) => ({
        table: x.name,
        fk: db.getAllSync("SELECT * FROM pragma_foreign_key_list(?)", [x.name])[0],
      }))
      .find(
        (x) =>
          x.fk &&
          db.getFirstSync(
            `SELECT 1 AS v FROM ${q(x.table)} WHERE ${q(x.fk.from)} IS NOT NULL LIMIT 1`
          )
      );
    const fkOn = db.getFirstSync("PRAGMA foreign_keys").foreign_keys;
    if (child) {
      db.execSync("PRAGMA foreign_keys = OFF");
      db.runSync(
        `UPDATE ${q(child.table)} SET ${q(child.fk.from)} = -424242 WHERE rowid = (SELECT min(rowid) FROM ${q(child.table)} WHERE ${q(child.fk.from)} IS NOT NULL)`
      );
      db.execSync(`PRAGMA foreign_keys = ${fkOn ? "ON" : "OFF"}`);
    }
    const invalid = INVALID[app.id];
    if (invalid) db.execSync(invalid.sql);

    const result = await exportTo(ctx, "warnings.archive");
    assert.equal(result.unchanged, false);
    assert.deepEqual(result.manifest.warnings, result.warnings);
    const fk = result.warnings.filter((x) => x.message === "fk");
    assert.deepEqual(fk, child ? [{ table: child.table, fatal: true, message: "fk" }] : []);
    if (invalid && app.validate)
      assert.ok(
        result.warnings.some((x) => x.table === invalid.table && x.fatal),
        JSON.stringify(result.warnings)
      );
    assert.deepEqual(await ctx.inspect.verifyArchive(result.file), { ok: true, problems: [] });

    // A validator that throws is a warning too: a descriptor bug never stops every backup.
    app.validate = () => {
      throw new Error("validator bug");
    };
    const second = await exportTo(ctx, "validator.archive");
    assert.ok(
      second.warnings.some((x) => x.table === "*" && x.fatal && x.message === "validate:error")
    );
  }
);

// ---------------------------------------------------------------------------------------------------------------
// Media

test(
  "export: media come from the rows (embedded STORED, listed, missing, orphans left out)",
  { skip: vault.skip },
  async (t) => {
    const ctx = await seeded(t);
    const { w, db, app, File } = ctx;
    const sets = app.media ?? [];
    if (!sets.length) {
      const result = await exportTo(ctx, "no-media.archive");
      assert.deepEqual(result.manifest.media, []);
      assert.equal(result.manifest.missingMedia, undefined);
      assert.deepEqual(result.media, []);
      return;
    }
    const set = sets[0];
    const names = ctx.exporter.referencedMedia(db, set);
    assert.ok(names.length > 0, "the fixture references media");
    const folder = w.file(set.directory);
    const fileOf = (name) => fs.readFileSync(path.join(folder, name));

    // Automatic archives list media (embedded: false) without packing them; known hashes are not recomputed.
    const known = new Map([[`${set.set}/${names[0]}`, { bytes: 1, sha256: "f".repeat(64) }]]);
    const auto = await exportTo(ctx, "media-auto.archive", {
      kind: "auto",
      embedMedia: false,
      csv: false,
      deflateLevel: 1,
      knownMedia: known,
    });
    assert.deepEqual(
      auto.manifest.media.map((m) => ({ ...m })),
      names.map((name, i) => ({
        set: set.set,
        name,
        bytes: i ? fileOf(name).length : 1,
        sha256: i ? sha256(fileOf(name)) : "f".repeat(64),
        embedded: false,
      }))
    );
    assert.ok(!unzip(ctx, auto.file).order.some((e) => e.startsWith("media/")));

    // Manual archives embed every referenced file, STORED, byte for byte.
    const manual = await exportTo(ctx, "media.archive");
    const zip = unzip(ctx, manual.file);
    assert.deepEqual(
      manual.manifest.media.map((m) => m.name),
      names
    );
    for (const m of manual.manifest.media) {
      const bytes = fileOf(m.name);
      assert.deepEqual(
        { ...m },
        { set: set.set, name: m.name, bytes: bytes.length, sha256: sha256(bytes), embedded: true }
      );
      const entry = `media/${set.set}/${m.name}`;
      assert.equal(zip.methods[entry], 0, `${entry} is STORED`);
      assert.ok(zip.get(entry).equals(bytes), entry);
    }
    assert.deepEqual(
      manual.media.map((m) => m.uri),
      names.map((n) => new File(w.uri(set.directory, n)).uri)
    );
    assert.equal(manual.manifest.missingMedia, undefined);

    // A referenced file that is gone and a row naming an invalid file are listed as missing; an orphan file in the
    // folder is not referenced by any row and stays out.
    const [gone, renamed] = names;
    fs.rmSync(path.join(folder, gone));
    fs.writeFileSync(path.join(folder, "orphan.png"), "not referenced");
    if (renamed !== undefined)
      db.runSync(`UPDATE ${q(set.table)} SET ${q(set.column)} = ? WHERE ${q(set.column)} = ?`, [
        "../escape.png",
        renamed,
      ]);
    const damaged = await exportTo(ctx, "media-missing.archive");
    assert.deepEqual(
      damaged.manifest.media.map((m) => m.name),
      names.filter((n) => n !== gone && n !== renamed)
    );
    assert.deepEqual(damaged.manifest.missingMedia, [
      { set: set.set, name: gone },
      ...(renamed === undefined ? [] : [{ set: set.set, name: "../escape.png" }]),
    ]);
    assert.ok(!unzip(ctx, damaged.file).order.some((e) => /orphan|escape/.test(e)));
    assert.deepEqual(await ctx.inspect.verifyArchive(damaged.file), { ok: true, problems: [] });
  }
);

test(
  "export: pre-restore packaging reads the given snapshot (and its displaced media) and leaves it in place",
  { skip: vault.skip },
  async (t) => {
    const ctx = await seeded(t);
    const { w, db, app, paths, state } = ctx;
    const id = paths.newVaultId();
    const partial = paths.ensureDir(paths.recoveryPartialDir(id));
    const live = new ctx.File(partial, "live.db");
    db.runSync("VACUUM INTO ?", [paths.fsPath(live)]);
    const libraryId = state.readState(db, "library.id");
    state.updateState(db, { "library.id": "00000000-0000-4000-8000-00000000000a" });
    const set = app.media?.[0];
    let moved = null;
    if (set) {
      moved = ctx.exporter.referencedMedia(db, set)[0];
      const to = path.join(paths.fsPath(partial), "media", set.set);
      fs.mkdirSync(to, { recursive: true });
      fs.renameSync(w.file(set.directory, moved), path.join(to, moved));
    }
    const calls = w.calls.length;
    const result = await ctx.exporter.exportArchive({
      kind: "pre-restore",
      snapshotPath: paths.fsPath(live),
      destination: paths.recoveryArchiveFile(
        id,
        w.require("@/vault/app").vaultIdentity.extension,
        true
      ),
      embedMedia: false,
      csv: false,
      deflateLevel: 1,
      chunkBytes: 64 * 1024,
    });
    assert.equal(result.manifest.kind, "pre-restore");
    assert.equal(result.manifest.library.id, libraryId, "read from the snapshot");
    assert.ok(live.exists, "the caller's snapshot stays");
    assert.equal(
      w.calls.slice(calls).filter((c) => c.name === "saveQueuedDrinks").length,
      0,
      "no beforeExport for a given snapshot"
    );
    if (set) {
      const item = result.manifest.media.find((m) => m.name === moved);
      const bytes = fs.readFileSync(path.join(paths.fsPath(partial), "media", set.set, moved));
      assert.deepEqual([item.sha256, item.embedded], [sha256(bytes), false]);
      assert.equal(result.manifest.missingMedia, undefined);
    }
    assert.deepEqual(await ctx.inspect.verifyArchive(result.file), { ok: true, problems: [] });
    // The same with the snapshot given as a file:// URI.
    const again = await ctx.exporter.exportArchive({
      kind: "pre-restore",
      snapshotPath: live.uri,
      destination: new ctx.File(partial, "again.zip"),
      embedMedia: false,
      csv: false,
      deflateLevel: 1,
    });
    assert.equal(again.contentHash, result.contentHash);
  }
);

// ---------------------------------------------------------------------------------------------------------------
// CSV

test(
  "export: CSV copies get a BOM, the requested language and safe names",
  { skip: vault.skip },
  async (t) => {
    const ctx = await seeded(t);
    const { app } = ctx;
    const languages = [];
    app.csv = async (snap, { language }) => {
      languages.push(language);
      assert.ok(snap.getFirstSync("SELECT 1 AS v"), "runs on the snapshot connection");
      return [
        { name: "one.csv", text: '"a","b"\r\n"=1+2","2"\r\n' },
        { name: "two.csv", text: "" },
      ];
    };
    const result = await exportTo(ctx, "csv.archive", { language: "de" });
    assert.deepEqual(languages, ["de"]);
    const zip = unzip(ctx, result.file);
    assert.deepEqual(
      result.manifest.files.map((f) => [f.path, f.role, f.bytes]),
      [
        ["csv/one.csv", "csv", 3 + Buffer.byteLength('"a","b"\r\n"=1+2","2"\r\n')],
        ["csv/two.csv", "csv", 3],
        ["README.txt", "readme", zip.get("README.txt").length],
      ]
    );
    assert.equal(zip.get("csv/one.csv").toString("utf8"), '﻿"a","b"\r\n"=1+2","2"\r\n');
    await exportTo(ctx, "csv-en.archive");
    assert.deepEqual(languages, ["de", "en"], "English unless the caller says otherwise");
    assert.deepEqual(
      (await exportTo(ctx, "no-csv.archive", { csv: false })).manifest.files.map((f) => f.path),
      ["README.txt"]
    );
    for (const bad of [
      [{ name: "../escape.csv", text: "" }],
      [{ name: "a/b.csv", text: "" }],
      [{ name: "notes.txt", text: "" }],
      [
        { name: "same.csv", text: "" },
        { name: "same.csv", text: "" },
      ],
    ]) {
      app.csv = async () => bad;
      const error = await vaultError(() => exportTo(ctx, "bad-csv.archive"));
      assert.equal(error.code, "exportFailed", JSON.stringify(bad));
      assert.match(error.info.detail, /^csv:/);
      assert.equal(fs.existsSync(ctx.w.file("out", "bad-csv.archive")), false);
    }
    assert.deepEqual(workLeft(ctx), []);
  }
);

// ---------------------------------------------------------------------------------------------------------------
// G21 sync ids

test(
  "G21 sync ids: added, backfilled (v4, unique), indexed and filled on insert; idempotent; no child row changes",
  { skip: vault.skip },
  async (t) => {
    const ctx = await open(t);
    const { w, sid } = ctx;
    const db = w.open("sid.db", { useNewConnection: true });
    db.execSync(`PRAGMA foreign_keys = ON;
      CREATE TABLE parent (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
      CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id) ON DELETE CASCADE ON UPDATE CASCADE, note TEXT);`);
    db.withTransactionSync(() => {
      for (let i = 1; i <= 300; i++) db.runSync("INSERT INTO parent (name) VALUES (?)", [`p${i}`]);
      for (let i = 1; i <= 900; i++)
        db.runSync("INSERT INTO child (parent_id, note) VALUES (?, ?)", [(i % 300) + 1, `c${i}`]);
    });
    const children = () => db.getAllSync("SELECT id, parent_id, note FROM child ORDER BY id");
    const before = children();

    const result = sid.ensureSyncIds(db, { tables: ["parent", "child", "absent"] });
    assert.deepEqual(result, { added: ["parent", "child"], filled: 1200 });
    for (const table of ["parent", "child"]) {
      const columns = db
        .getAllSync("SELECT name FROM pragma_table_info(?)", [table])
        .map((c) => c.name);
      assert.equal(columns.at(-1), "sync_id", `${table}: appended last`);
      const ids = db.getAllSync(`SELECT sync_id FROM ${table}`).map((r) => r.sync_id);
      assert.ok(
        ids.every((id) => UUID_V4.test(id)),
        `${table}: v4-shaped`
      );
      assert.equal(new Set(ids).size, ids.length, `${table}: unique`);
      const index = db.getFirstSync(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
        [`_vault_sid_${table}`]
      );
      assert.match(index.sql, /CREATE UNIQUE INDEX/);
      assert.ok(
        db.getFirstSync("SELECT 1 AS v FROM sqlite_master WHERE type = 'trigger' AND name = ?", [
          `_vault_sid_${table}_i`,
        ])
      );
    }
    // foreign_keys = ON: no child row changed, no cascade, no violation.
    assert.equal(db.getFirstSync("PRAGMA foreign_keys").foreign_keys, 1);
    assert.deepEqual(children(), before);
    assert.deepEqual(db.getAllSync("PRAGMA foreign_key_check"), []);

    // Idempotent: nothing to do, no transaction at all.
    let begins = 0;
    const stop = w.onBeforeBegin(() => begins++);
    assert.deepEqual(sid.ensureSyncIds(db, { tables: ["parent", "child"] }), {
      added: [],
      filled: 0,
    });
    stop();
    assert.equal(begins, 0);

    // The fill trigger: every writer, every connection; an explicit id is kept; duplicates are refused.
    const other = w.open("sid.db", { useNewConnection: true });
    other.runSync("INSERT INTO parent (name) VALUES ('from another connection')");
    other.closeSync();
    const added = db.getFirstSync(
      "SELECT sync_id FROM parent WHERE name = 'from another connection'"
    );
    assert.match(added.sync_id, UUID_V4);
    db.runSync(
      "INSERT INTO parent (name, sync_id) VALUES ('kept', '0b3f6a52-7c1e-4d8a-9f20-1a2b3c4d5e01')"
    );
    assert.equal(
      db.getFirstSync("SELECT sync_id FROM parent WHERE name = 'kept'").sync_id,
      "0b3f6a52-7c1e-4d8a-9f20-1a2b3c4d5e01"
    );
    assert.throws(
      () =>
        db.runSync(
          "INSERT INTO parent (name, sync_id) VALUES ('twin', '0b3f6a52-7c1e-4d8a-9f20-1a2b3c4d5e01')"
        ),
      /UNIQUE/
    );

    // Self-healing after a drizzle-kit style rebuild dropped the column, its index and trigger.
    db.execSync(`PRAGMA foreign_keys = OFF;
      CREATE TABLE __new_child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id) ON DELETE CASCADE, note TEXT);
      INSERT INTO __new_child (id, parent_id, note) SELECT id, parent_id, note FROM child;
      DROP TABLE child; ALTER TABLE __new_child RENAME TO child; PRAGMA foreign_keys = ON;`);
    assert.deepEqual(sid.ensureSyncIds(db, { tables: ["parent", "child"] }), {
      added: ["child"],
      filled: 900,
    });
    assert.ok(db.getAllSync("SELECT sync_id FROM child").every((r) => UUID_V4.test(r.sync_id)));
    assert.deepEqual(children(), before);

    // The scratch variants: column only (archived ids go in as they are), then backfill without a trigger.
    db.execSync(
      "CREATE TABLE scratch (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO scratch (v) VALUES ('a'), ('b')"
    );
    assert.deepEqual(sid.ensureSyncIds(db, { tables: ["scratch"], backfill: false }), {
      added: ["scratch"],
      filled: 0,
    });
    assert.equal(db.getFirstSync("SELECT count(*) AS n FROM scratch WHERE sync_id IS NULL").n, 2);
    const objects = () =>
      db
        .getAllSync(
          "SELECT type, name FROM sqlite_master WHERE name LIKE '_vault_sid_scratch%' ORDER BY name"
        )
        .map((r) => `${r.type}:${r.name}`);
    assert.deepEqual(objects(), []);
    assert.deepEqual(sid.ensureSyncIds(db, { tables: ["scratch"], backfill: false }), {
      added: [],
      filled: 0,
    });
    assert.deepEqual(
      sid.ensureSyncIds(db, { tables: ["scratch"], backfill: true, triggers: false }),
      { added: [], filled: 2 }
    );
    assert.deepEqual(objects(), ["index:_vault_sid_scratch"]);
    assert.deepEqual(sid.VAULT_OWNED_COLUMNS, ["sync_id"]);
  }
);

test(
  "G21 sync ids on the app's tables: every syncIdTables row gets an id, other rows untouched, exported as is",
  { skip: vault.skip },
  async (t) => {
    const ctx = await open(t);
    const { w, app, sid } = ctx;
    const db = await w.live();
    w.seed(db);
    const tables = app.syncIdTables ?? [];
    const dump = () =>
      Object.fromEntries(
        app.tables.map((x) => [x.name, db.getAllSync(`SELECT * FROM ${q(x.name)} ORDER BY rowid`)])
      );
    const before = dump();
    const result = sid.ensureSyncIds(db);
    assert.deepEqual(
      result.added,
      tables.filter((x) => db.getFirstSync("SELECT 1 AS v FROM sqlite_master WHERE name = ?", [x]))
    );
    const after = dump();
    for (const table of app.tables) {
      const strip = (rows) =>
        rows.map((row) => {
          const copy = { ...row };
          delete copy.sync_id;
          return copy;
        });
      assert.deepEqual(
        strip(after[table.name]),
        before[table.name],
        `${table.name}: only sync_id added`
      );
      if (tables.includes(table.name)) {
        const ids = after[table.name].map((r) => r.sync_id);
        assert.ok(
          ids.every((id) => UUID_V4.test(id)),
          table.name
        );
        assert.equal(new Set(ids).size, ids.length, table.name);
      } else
        assert.ok(
          after[table.name].every((r) => !("sync_id" in r)),
          table.name
        );
    }
    assert.deepEqual(sid.ensureSyncIds(db), { added: [], filled: 0 });

    ctx.device.ensureDevice(db, w.device);
    ctx.device.ensureLibrary(db);
    const exported = await exportTo(ctx, "sid.archive", { csv: false });
    assert.deepEqual(exported.manifest.vaultColumns, tables.length ? ["sync_id"] : []);
    const zip = unzip(ctx, exported.file);
    for (const table of tables) {
      const entry = exported.manifest.tables.find((x) => x.name === table);
      assert.equal(entry.columns.at(-1), "sync_id");
      assert.deepEqual(
        ndjson(zip.get(entry.file)).map((r) => r.sync_id),
        after[table].map((r) => r.sync_id)
      );
    }
  }
);

// ---------------------------------------------------------------------------------------------------------------
// G22 device anchor, clones, library id

const anchorOf = (ctx) =>
  JSON.parse(fs.readFileSync(ctx.w.file("PendumVault", "device.json"), "utf8"));

test(
  "G22 device anchor: created, confirmed, fingerprints adopted or kept",
  { skip: vault.skip },
  async (t) => {
    const ctx = await open(t);
    const { w, device, state } = ctx;
    const db = await w.live();
    const now = new Date("2026-10-04T15:30:12.345Z");
    const first = device.ensureDevice(
      db,
      { platform: w.platform, fingerprint: "a".repeat(32) },
      now
    );
    assert.equal(first.outcome, "created");
    assert.equal(first.supersedes, null);
    assert.match(first.deviceId, UUID_V4);
    assert.deepEqual(state.readStates(db, "device."), {
      "device.createdAt": now.toISOString(),
      "device.fingerprint": "a".repeat(32),
      "device.id": first.deviceId,
    });
    assert.deepEqual(anchorOf(ctx), { deviceId: first.deviceId, createdAt: now.toISOString() });
    assert.deepEqual(device.readAnchor(), anchorOf(ctx));
    assert.equal(state.vaultState()["device.id"], first.deviceId, "the mirror is refreshed");
    assert.ok(!fs.existsSync(w.file("PendumVault", "device.json.tmp")));

    // Same device; a nil IDFV (fingerprint null) never retires the id.
    assert.deepEqual(
      device.ensureDevice(db, { platform: w.platform, fingerprint: "a".repeat(32) }),
      {
        deviceId: first.deviceId,
        outcome: "same",
        supersedes: null,
      }
    );
    assert.equal(
      device.ensureDevice(db, { platform: w.platform, fingerprint: null }).outcome,
      "same"
    );
    assert.equal(state.readState(db, "device.fingerprint"), "a".repeat(32));
    // A stored empty fingerprint (unavailable at creation) adopts the current one.
    state.updateState(db, { "device.fingerprint": "" });
    assert.equal(
      device.ensureDevice(db, { platform: w.platform, fingerprint: "b".repeat(32) }).outcome,
      "same"
    );
    assert.equal(state.readState(db, "device.fingerprint"), "b".repeat(32));
    assert.equal(state.readState(db, "device.id"), first.deviceId);

    // No id in the database but an anchor of an earlier database: a new id, not a clone.
    state.updateState(db, { "device.id": null });
    const fresh = device.ensureDevice(db, { platform: w.platform, fingerprint: null });
    assert.equal(fresh.outcome, "created");
    assert.notEqual(fresh.deviceId, first.deviceId);
    assert.equal(anchorOf(ctx).deviceId, fresh.deviceId);
    assert.equal(state.readState(db, "device.supersedes"), null);
    assert.equal(state.readState(db, "device.fingerprint"), "");

    // Library id: created once.
    const library = device.ensureLibrary(db);
    assert.match(library, UUID_V4);
    assert.equal(device.ensureLibrary(db), library);
    assert.equal(state.readState(db, "library.id"), library);
  }
);

/** The installation keys of a keys-mode preferences table (body, lift, macro). */
function installationsOf(db, app) {
  const prefs = app.tables.find(
    (x) => x.mode === "keys" && x.keys.include.includes("installation")
  );
  if (!prefs) return null;
  const read = (key) =>
    db.getFirstSync(
      `SELECT ${q(prefs.keys.valueColumn)} AS v FROM ${q(prefs.name)} WHERE ${q(prefs.keys.keyColumn)} = ?`,
      [key]
    )?.v ?? null;
  return {
    installation: read("installation"),
    list: JSON.parse(read("healthInstallations") ?? "[]"),
  };
}

for (const platform of ["ios", "android"])
  test(
    `G22 clone (${platform}): a missing or foreign anchor or a changed fingerprint gives a new id, clears cloud state and rotates Health`,
    { skip: vault.skip },
    async (t) => {
      const ctx = await seeded(t, { platform });
      const { w, db, app, device, state } = ctx;
      const original = state.readState(db, "device.id");
      const libraryId = state.readState(db, "library.id");
      const cloud = {
        "cloud.icloud.lastOkAt": "2026-10-01T00:00:00.000Z",
        "cloud.icloud.lastContentHash": "c".repeat(64),
        "cloud.icloud.latest": "lift-20261001T000000Z-auto-abcd.pendumlift",
        "cloud.gdrive.lastUploadAt": "2026-10-01T00:00:00.000Z",
        "cloud.gdrive.index": "{}",
        "cloud.gdrive.lastGen": "4",
        "icloud.identity": "identity",
        "icloud.enabled": "1",
        "gdrive.connected": "1",
        "gdrive.email": "someone@example.com",
      };
      state.updateState(db, cloud);
      const links = () =>
        app.health
          ? db.getAllSync(
              "SELECT key, fingerprint, remote_id, origin FROM health_links ORDER BY key"
            )
          : [];
      const beforeLinks = links();
      const beforeInstallations = installationsOf(db, app);

      // The anchor is gone (an OS backup restore, a device transfer, an Auto Backup reinstall).
      fs.rmSync(w.file("PendumVault", "device.json"));
      const clone = device.ensureDevice(db, { platform, fingerprint: w.device.fingerprint });
      assert.equal(clone.outcome, "clone");
      assert.equal(clone.supersedes, original);
      assert.notEqual(clone.deviceId, original);
      assert.match(clone.deviceId, UUID_V4);
      assert.equal(state.readState(db, "device.id"), clone.deviceId);
      assert.equal(state.readState(db, "device.supersedes"), original);
      assert.equal(anchorOf(ctx).deviceId, clone.deviceId);
      assert.equal(state.readState(db, "library.id"), libraryId, "the library stays");
      assert.equal(state.readState(db, "lineage.vector"), "{}");
      assert.equal(state.readState(db, "lineage.ownBase"), "0");
      assert.deepEqual(state.readStates(db, "cloud."), {}, "own remote state cleared");
      for (const key of ["icloud.identity", "icloud.enabled", "gdrive.connected", "gdrive.email"])
        assert.equal(state.readState(db, key), cloud[key], `${key} kept`);

      // Health (body, lift, macro): a fresh installation; the old one joins the lineage list.
      const after = installationsOf(db, app);
      if (app.health && beforeInstallations?.installation) {
        assert.notEqual(after.installation, beforeInstallations.installation);
        assert.match(after.installation, /^\d+-[a-z0-9]+$/);
        assert.deepEqual(
          after.list,
          [...new Set([...beforeInstallations.list, beforeInstallations.installation])].sort()
        );
      } else assert.deepEqual(after, beforeInstallations);
      // Android: Health Connect stays on the old phone, so local links are re-sent; iOS: links untouched.
      const afterLinks = links();
      if (app.health && platform === "android") {
        assert.ok(
          afterLinks.some(
            (l, i) =>
              l.origin === "local" && l.fingerprint === "" && beforeLinks[i].fingerprint !== ""
          ),
          "local links reset for an upsert"
        );
        for (const [i, l] of afterLinks.entries())
          if (beforeLinks[i].fingerprint === "deleted" || l.origin !== "local")
            assert.deepEqual(l, beforeLinks[i]);
      } else assert.deepEqual(afterLinks, beforeLinks);

      // The next start confirms it.
      assert.equal(
        device.ensureDevice(db, { platform, fingerprint: w.device.fingerprint }).outcome,
        "same"
      );
      // An anchor naming another id, an unreadable anchor, and a changed fingerprint with the anchor present: clones.
      fs.writeFileSync(
        w.file("PendumVault", "device.json"),
        JSON.stringify({ deviceId: original, createdAt: "x" })
      );
      assert.equal(
        device.ensureDevice(db, { platform, fingerprint: w.device.fingerprint }).outcome,
        "clone"
      );
      fs.writeFileSync(w.file("PendumVault", "device.json"), "{not json");
      assert.equal(
        device.ensureDevice(db, { platform, fingerprint: w.device.fingerprint }).outcome,
        "clone"
      );
      const changed = device.ensureDevice(db, { platform, fingerprint: "e".repeat(32) });
      assert.equal(changed.outcome, "clone");
      assert.equal(state.readState(db, "device.fingerprint"), "e".repeat(32));
      // Exports carry the new id.
      const exported = await exportTo(ctx, "clone.archive", { csv: false });
      assert.equal(exported.manifest.device.id, changed.deviceId);
    }
  );

test(
  "libraryEmpty: true on a fresh install, false with user records",
  { skip: vault.skip },
  async (t) => {
    const ctx = await open(t);
    const { w, device, app } = ctx;
    // A fresh install: only what the app writes by itself (water's counters row, lift's default gym).
    const fresh = await w.live();
    w.fresh(fresh);
    assert.equal(device.libraryEmpty(fresh), true);
    const db = await w.migrate(w.open("seeded.db", { useNewConnection: true }));
    w.seed(db);
    assert.equal(device.libraryEmpty(db), false);
    // Without emptySql: every role "data" table empty.
    const other = await w.migrate(w.open("default-empty.db", { useNewConnection: true }));
    delete app.emptySql;
    assert.equal(device.libraryEmpty(other), true);
    assert.equal(device.libraryEmpty(db), false);
  }
);

// ---------------------------------------------------------------------------------------------------------------
// openArchive and verifyArchive

/** Rewrites an archive with `edit(entries, manifest)` applied (fflate's zipSync; the manifest re-serialized). */
function rezip(ctx, from, name, edit) {
  const { unzipSync, zipSync } = ctx.w.require("fflate");
  const entries = unzipSync(new Uint8Array(fs.readFileSync(ctx.paths.fsPath(from))));
  const manifest = JSON.parse(Buffer.from(entries["manifest.json"]).toString("utf8"));
  if (edit(entries, manifest) !== "drop manifest")
    entries["manifest.json"] = new Uint8Array(Buffer.from(JSON.stringify(manifest)));
  else delete entries["manifest.json"];
  fs.writeFileSync(ctx.w.file("out", name), zipSync(entries));
  return new ctx.File(ctx.w.uri("out", name));
}

test("openArchive: private copy, preview, close and hold", { skip: vault.skip }, async (t) => {
  const ctx = await seeded(t);
  const { w, db, app, inspect, paths, exporter, state } = ctx;
  const result = await exportTo(ctx, "open.archive");
  const original = fs.readFileSync(w.file("out", "open.archive"));
  const archive = await inspect.openArchive(result.file);
  assert.equal(archive.format, "v2");
  assert.deepEqual(archive.manifest, result.manifest);
  assert.ok(archive.source.uri.startsWith(paths.workDir(archive.opId).uri), "a private copy");
  assert.ok(Buffer.from(fs.readFileSync(paths.fsPath(archive.source))).equals(original));
  assert.ok(paths.isLiveOp(archive.opId));
  const m = result.manifest;
  assert.deepEqual(archive.preview, {
    format: "v2",
    kind: "manual",
    createdAt: m.createdAt,
    appVersion: m.app.version,
    device: { platform: w.platform, kind: w.device.kind, model: w.device.model },
    incoming: m.counts,
    current: exporter.summarize(db),
    olderSchema: false,
    crossPlatform: false,
    sameDevice: true,
    liveEmpty: false,
    newerLocalChanges: archive.preview.newerLocalChanges,
    sourceHealthSyncOn: false,
    media: {
      count: m.media.length,
      bytes: m.media.reduce((sum, x) => sum + x.bytes, 0),
      embedded: m.media.length,
      missing: 0,
    },
    libraryId: m.library.id,
  });
  assert.equal(typeof archive.preview.newerLocalChanges, "boolean");
  const contents = inspect.archiveContents(archive);
  assert.equal(contents.applied, app.migrations.journal.entries.length);
  assert.equal(contents.legacy, null);
  assert.ok(contents.reader.has("manifest.json"));

  // close() while a restore holds the archive waits for the release.
  const release = inspect.holdArchive(archive);
  archive.close();
  assert.ok(fs.existsSync(paths.fsPath(paths.workDir(archive.opId))));
  release();
  release();
  assert.ok(!fs.existsSync(paths.fsPath(paths.workDir(archive.opId))));
  assert.equal(paths.isLiveOp(archive.opId), false);
  archive.close();
  assert.throws(() => inspect.holdArchive(archive));
  assert.throws(() => inspect.archiveContents({ ...archive }));
  assert.ok(fs.existsSync(w.file("out", "open.archive")), "the chosen file is untouched");

  // Another device's archive, newer local changes, and the source's Health sync.
  state.updateState(db, { "device.id": "00000000-0000-4000-8000-0000000000aa" });
  const summary = app.summary;
  app.summary = { ...summary, latest: "SELECT '2999-01-01T00:00:00.000Z' AS v" };
  const foreign = await inspect.openArchive(result.file);
  assert.equal(foreign.preview.sameDevice, false);
  assert.equal(foreign.preview.newerLocalChanges, true);
  assert.equal(foreign.preview.sourceHealthSyncOn, m.provenance.healthSyncOn === true);
  foreign.close();
  app.summary = { ...summary, latest: "SELECT NULL AS v" };
  const none = await inspect.openArchive(result.file);
  assert.equal(none.preview.newerLocalChanges, false);
  none.close();
  assert.deepEqual(paths.liveOps(), []);
  assert.deepEqual(workLeft(ctx), []);
});

test(
  "openArchive: another platform's archive is crossPlatform; an empty live library is liveEmpty",
  { skip: vault.skip },
  async (t) => {
    const android = await seeded(t, { platform: "android" });
    const made = await exportTo(android, "android.archive", { csv: false });
    const ctx = await open(t, { platform: "ios" });
    const db = await ctx.w.live();
    ctx.w.fresh(db);
    identify(ctx, db);
    fs.mkdirSync(ctx.w.file("in"), { recursive: true });
    fs.copyFileSync(android.paths.fsPath(made.file), ctx.w.file("in", "android.archive"));
    const archive = await ctx.inspect.openArchive(new ctx.File(ctx.w.uri("in", "android.archive")));
    t.after(() => archive.close());
    assert.equal(archive.preview.crossPlatform, true);
    assert.equal(archive.preview.sameDevice, false);
    assert.equal(archive.preview.liveEmpty, true);
    assert.deepEqual(archive.preview.device, {
      platform: "android",
      kind: "phone",
      model: android.w.device.model,
    });
  }
);

test(
  "openArchive: compatibility rules and damaged archives fail typed and leave nothing",
  { skip: vault.skip },
  async (t) => {
    const ctx = await seeded(t);
    const { w, app, inspect, paths } = ctx;
    const good = (await exportTo(ctx, "good.archive", { csv: false })).file;
    const journal = app.migrations.journal.entries;
    const other = ["body", "lift", "macro", "water"].find((id) => id !== app.id);
    const cases = [
      [
        "wrong format",
        (e, m) => {
          m.format = "other";
        },
        "notArchive",
      ],
      [
        "newer reader",
        (e, m) => {
          m.minReaderVersion = 3;
        },
        "newer",
      ],
      [
        "another app",
        (e, m) => {
          m.app.id = other;
          m.app.name = "Pendum Other";
        },
        "wrongApp",
      ],
      [
        "newer schema",
        (e, m) => {
          m.schema.applied = journal.length + 1;
        },
        "newer",
      ],
      [
        "another lineage",
        (e, m) => {
          m.schema.lastTag = "0000_elsewhere";
        },
        "unknownSchema",
      ],
      [
        "unknown table",
        (e, m) => {
          e["data/strangers.ndjson"] = e[m.tables[0].file];
          m.tables.push({ ...m.tables[0], name: "strangers", file: "data/strangers.ndjson" });
        },
        "unknownSchema",
      ],
      [
        "a table in another file",
        (e, m) => {
          m.tables[0].file = "data/elsewhere.ndjson";
        },
        "corrupt",
      ],
      [
        "a listed entry missing",
        (e, m) => {
          delete e[m.tables[0].file];
        },
        "corrupt",
      ],
      [
        "a listed size differs",
        (e, m) => {
          m.tables[0].bytes += 1;
        },
        "corrupt",
      ],
      ["no manifest", () => "drop manifest", "corrupt"],
      [
        "schema violation",
        (e, m) => {
          m.device.id = "not-a-uuid";
        },
        "corrupt",
      ],
    ];
    for (const [label, edit, code] of cases) {
      const file = rezip(ctx, good, `${label.replaceAll(" ", "-")}.archive`, edit);
      const error = await vaultError(() => inspect.openArchive(file));
      assert.equal(error.code, code, label);
      if (code === "wrongApp") assert.equal(error.info.app, "Pendum Other");
      assert.deepEqual(paths.liveOps(), [], label);
      assert.deepEqual(workLeft(ctx), [], label);
    }
    // Not a ZIP at all: notArchive without a legacy reader; with one, a legacy preview.
    fs.writeFileSync(w.file("out", "v1.json"), '{"format":"lift-track-backup","version":1}');
    const v1 = new ctx.File(w.uri("out", "v1.json"));
    assert.equal((await vaultError(() => inspect.openArchive(v1))).code, "notArchive");
    const seen = [];
    inspect.setLegacyOpener(async (source, options) => {
      seen.push([source.uri.startsWith(paths.workRoot().uri), options.password]);
      if (!options.password)
        throw new (w.require("@/vault/errors").VaultError)("legacyPasswordRequired");
      return { parsed: { rows: 1 }, createdAt: "2026-09-01T10:00:00.000Z", counts: { weights: 2 } };
    });
    t.after(() => inspect.setLegacyOpener(null));
    assert.equal((await vaultError(() => inspect.openArchive(v1))).code, "legacyPasswordRequired");
    const legacy = await inspect.openArchive(v1, { password: "secret" });
    assert.deepEqual(seen, [
      [true, undefined],
      [true, "secret"],
    ]);
    assert.equal(legacy.format, "legacy");
    assert.equal(legacy.manifest, null);
    assert.deepEqual(
      [
        legacy.preview.kind,
        legacy.preview.createdAt,
        legacy.preview.incoming,
        legacy.preview.device,
        legacy.preview.libraryId,
      ],
      ["legacy", "2026-09-01T10:00:00.000Z", { weights: 2 }, null, null]
    );
    assert.deepEqual(inspect.archiveContents(legacy).legacy.parsed, { rows: 1 });
    legacy.close();
    // A ZIP is never handed to the legacy reader.
    const zipped = await inspect.openArchive(good);
    assert.equal(zipped.format, "v2");
    zipped.close();
    // Too little space for the private copy.
    w.disk.available = 10;
    assert.equal((await vaultError(() => inspect.openArchive(good))).code, "insufficientSpace");
    // Cancelled before anything happens.
    const controller = new AbortController();
    controller.abort();
    w.disk.available = 64 * 2 ** 30;
    assert.equal(
      (await vaultError(() => inspect.openArchive(good, { signal: controller.signal }))).code,
      "cancelled"
    );
  }
);

test(
  "verifyArchive: every listed entry present, sized and hashed; all problems reported",
  { skip: vault.skip },
  async (t) => {
    const ctx = await seeded(t);
    const { w, inspect, paths } = ctx;
    const good = await exportTo(ctx, "verify.archive");
    assert.deepEqual(await inspect.verifyArchive(good.file), { ok: true, problems: [] });
    const [first, second, third] = good.manifest.tables.filter((x) => x.bytes > 0);
    const damaged = rezip(ctx, good.file, "damaged.archive", (e) => {
      const flipped = new Uint8Array(e[first.file]);
      flipped[0] ^= 1;
      e[first.file] = flipped;
      delete e[second.file];
      e[third.file] = new Uint8Array([...e[third.file], 10]);
    });
    const result = await inspect.verifyArchive(damaged);
    assert.equal(result.ok, false);
    assert.deepEqual(result.problems, [
      { path: first.file, problem: "hash" },
      { path: second.file, problem: "missing" },
      { path: third.file, problem: "size" },
    ]);
    fs.writeFileSync(w.file("out", "garbage.archive"), "not a zip");
    assert.deepEqual(await inspect.verifyArchive(new ctx.File(w.uri("out", "garbage.archive"))), {
      ok: false,
      problems: [{ path: "manifest.json", problem: "manifest" }],
    });
    const noManifest = rezip(ctx, good.file, "bad-manifest.archive", (e, m) => (m.format = "x"));
    assert.deepEqual((await inspect.verifyArchive(noManifest)).problems, [
      { path: "manifest.json", problem: "manifest" },
    ]);
    assert.deepEqual(paths.liveOps(), []);
    assert.deepEqual(workLeft(ctx), []);
  }
);
