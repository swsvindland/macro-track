// G12 and the legacy v1 import tests (synced, hash-checked; loaded by tests/vault.test.*): engine/legacy.ts reads a
// file that is not a ZIP — a v1 backup of this app goes to the descriptor's legacy adapter, another app's is
// wrongApp, anything else notArchive — and the restore pipeline writes the parsed backup through the adapter into a
// scratch database with the live shape (sync ids), replaces only the tables the adapter declares, rebuilds the
// Health links as the v1 restore did and merges them with this device's. In lift and macro the v1 files are made by
// the app's own code (createBackup() of src/lib/backup-data.ts, encryptBackupText() of src/lib/backup-crypto.ts);
// body and water have no v1 backups and run the sniffing tests only. Every test runs the vault's real TypeScript in
// a harness world against this repo's real descriptor, schema and fixture.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const fs = require("node:fs");

const vault = require("../vault-harness.cjs");

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RECOVERY_ID = /^\d{8}T\d{6}Z-[a-z0-9]{4}$/;
const PASSWORD = "correct horse battery staple";
/** The v1 formats each app wrote (spec §2.11): only Pendum Lift and Pendum Macros had JSON backups. */
const V1_FORMATS = {
  lift: ["lift-track-backup", "lift-track-encrypted-backup"],
  macro: ["macro-track-backup", "macro-track-encrypted-backup"],
};
/** How much of a file decides whether it can be a v1 backup at all. */
const SNIFF_BYTES = 64 * 1024;
/** Where each app's v1 code kept its pre-restore copies (`backupFolder()` of src/lib/backup-files.ts). */
const V1_FOLDERS = { lift: "LiftTrackBackups", macro: "MacroTrackBackups" };
/** The Health keys a restore always writes (§5.5), and the v1 overrides of lift and macro (§2.11). */
const HEALTH_OFF = { healthSyncEnabled: "false", healthSyncError: "", lastSync: "" };
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

/**
 * Captures console.warn for the rest of test `t`. Every entry point reports a failure once, for diagnostics only
 * (ops.ts: `[vault] <code> <detail>`), so a test that expects failures records each expected code with `expect` and
 * ends with `done()`: the warnings must be exactly those one-line diagnostics, in order. Anything else fails the test
 * (and shows in its diff) instead of being hidden.
 */
function diagnostics(t) {
  const warned = [];
  const expected = [];
  const warn = t.mock.method(console, "warn", (...args) => warned.push(args));
  return {
    /** `code`, once more expected as a diagnostic; returned as is. */
    expect(code) {
      expected.push(["[vault]", code]);
      return code;
    },
    done() {
      warn.mock.restore();
      assert.deepEqual(
        warned.map((args) => args.slice(0, 2)),
        expected
      );
    },
  };
}

/** A world closed after the test, with the modules the tests use. */
async function open(t, options) {
  const w = await vault.world(options);
  t.after(() => w.close());
  const vaultModule = (name) => w.require(`@/vault/${name}`);
  return {
    w,
    ...w.require("expo-file-system"),
    app: w.vaultApp,
    apps: vaultModule("apps.json"),
    paths: vaultModule("engine/paths"),
    state: vaultModule("engine/state"),
    lock: vaultModule("engine/lock"),
    inspect: vaultModule("engine/inspect"),
    ready: vaultModule("engine/ready"),
    recovery: vaultModule("engine/recovery"),
    ops: vaultModule("ops"),
  };
}

/** `work` under the vault lock with the vault's connection, after ensureReady (what every entry point does). */
async function locked(ctx, work = async () => {}) {
  return ctx.lock.exclusive(
    "recover",
    async () => {
      const env = ctx.paths.engineEnv();
      const db = await env.acquire();
      try {
        await ctx.ready.ensureReady(db);
      } finally {
        await env.release(db);
      }
      return work();
    },
    { wait: true }
  );
}

/** The world's live database seeded at the current level, then ready (device, library, sync ids). */
async function seeded(ctx) {
  const db = await ctx.w.live();
  ctx.w.seed(db);
  await locked(ctx);
  return { ...ctx, db };
}

/** The world's live database holding only what the app writes by itself (fixture `fresh`), then ready. */
async function fresh(ctx) {
  const db = await ctx.w.live();
  ctx.w.fresh(db);
  await locked(ctx);
  return { ...ctx, db };
}

/**
 * A world prepared by `prepare` (seeded or fresh) when the descriptor has a legacy adapter (lift, macro); otherwise
 * the test is skipped and this resolves null.
 */
async function withLegacy(t, prepare, options) {
  const ctx = await open(t, options);
  if (!ctx.app.legacy) {
    t.skip("no v1 backups in this app");
    return null;
  }
  return prepare(ctx);
}

/** `text` as Documents/out/<name>, as a File. */
function put(ctx, name, text) {
  fs.mkdirSync(ctx.w.file("out"), { recursive: true });
  fs.writeFileSync(ctx.w.file("out", name), text);
  return new ctx.File(ctx.w.uri("out", name));
}

/** runOpen + runRestore + close, as the import screen does. */
async function restoreFrom(ctx, file, options = {}) {
  const archive = await ctx.ops.runOpen(file, options);
  try {
    return await ctx.ops.runRestore(archive, { reason: "file" });
  } finally {
    archive.close();
  }
}

/** Nothing of a failed open is left: no live operation, no work folder. */
function assertClean(ctx, label) {
  assert.deepEqual(ctx.paths.liveOps(), [], label);
  const work = ctx.w.file("PendumVault", "work");
  assert.deepEqual(fs.existsSync(work) ? fs.readdirSync(work) : [], [], label);
}

/**
 * This app's own v1 backup code (lift, macro): createBackup() reads the world's live database through @/db, as the
 * v1 export did; the encrypted file is what the v1 "Save encrypted backup" wrote.
 */
function v1Backup(ctx) {
  const { createBackup } = ctx.w.require("@/lib/backup-data");
  const { encryptBackupText } = ctx.w.require("@/lib/backup-crypto");
  const backup = createBackup();
  const plain = JSON.stringify(backup);
  return {
    backup,
    plain,
    encrypted: () =>
      encryptBackupText(plain, PASSWORD, async (n) => new Uint8Array(randomBytes(n))),
  };
}

const columnsOf = (db, table) => db.getAllSync(`PRAGMA table_info(${q(table)})`).map((c) => c.name);

/** Every row of `table` without the vault-owned and device columns, in rowid order. */
function rowsOf(ctx, db, table) {
  const device = ctx.app.tables.find((x) => x.name === table)?.deviceColumns ?? [];
  const columns = columnsOf(db, table).filter((c) => c !== "sync_id" && !device.includes(c));
  return db.getAllSync(`SELECT ${columns.map(q).join(", ")} FROM ${q(table)} ORDER BY rowid`);
}

/** A key/value table as a Map. */
function keyStore(db, table) {
  const { keyColumn, valueColumn } = table.keys;
  return new Map(
    db
      .getAllSync(`SELECT ${q(keyColumn)} AS k, ${q(valueColumn)} AS v FROM ${q(table.name)}`)
      .map((r) => [r.k, r.v])
  );
}

const linksOf = (db) =>
  db
    .getAllSync(
      'SELECT "key", "local_kind", "local_id", "remote_id", "fingerprint", "origin" FROM "health_links" ORDER BY "key"'
    )
    .map((r) => ({ ...r }));

/** Removes the newest row of the first declared data table that has one: the live state now differs from the file. */
function change(ctx, db) {
  const declared = new Set(ctx.app.legacy.tables.map((x) => x.name));
  const table = ctx.app.tables.find(
    (x) =>
      x.role === "data" && declared.has(x.name) && db.getFirstSync(`SELECT 1 FROM ${q(x.name)}`)
  );
  const fk = db.getFirstSync("PRAGMA foreign_keys").foreign_keys;
  db.execSync("PRAGMA foreign_keys = OFF");
  db.runSync(
    `DELETE FROM ${q(table.name)} WHERE rowid = (SELECT max(rowid) FROM ${q(table.name)})`
  );
  db.execSync(`PRAGMA foreign_keys = ${fk ? "ON" : "OFF"}`);
  return table.name;
}

// ---------------------------------------------------------------------------------------------------------------
// G12 sniffing (every app)

test(
  "G12 sniffing: a file that is not a ZIP is notArchive unless it is a v1 backup; another app's v1 backup is wrongApp",
  { skip: vault.skip },
  async (t) => {
    const ctx = await seeded(await open(t));
    const { app, apps } = ctx;
    const warnings = diagnostics(t);
    // Through runOpen, before anything else loads engine/legacy: the entry points register the v1 reader.
    const code = async (name, text, options) =>
      warnings.expect(
        (await vaultError(() => ctx.ops.runOpen(put(ctx, name, text), options))).code
      );

    const cases = [
      ["binary", randomBytes(4096)],
      ["text", "hello, this is a note\n"],
      ["empty", ""],
      ["spaces", " \n\t\r\n "],
      ["array", '[{"format":"lift-track-backup","version":1}]'],
      ["other json", '{"format":"something-else","version":1,"data":{}}'],
      ["no format", '{"version":1,"data":{}}'],
      ["not json", "{ this is not JSON"],
      // A JSON object only after the first 64 KiB of white space is not looked at.
      ["deep", `${" ".repeat(SNIFF_BYTES)}{"format":"something-else"}`],
    ];
    for (const [label, text] of cases) {
      assert.equal(await code(`${label.replaceAll(" ", "-")}.json`, text), "notArchive", label);
      assertClean(ctx, label);
    }

    // Another app's v1 backup, plain, encrypted or cut short, names that app.
    for (const [id, formats] of Object.entries(V1_FORMATS)) {
      if (id === app.id) continue;
      for (const format of formats) {
        const whole = `\n  {"format":"${format}","version":1,"createdAt":"2026-01-01T00:00:00.000Z"}`;
        for (const [label, text] of [
          [format, whole],
          [`${format} (cut short)`, whole.slice(0, -12)],
        ]) {
          const error = await vaultError(() => ctx.ops.runOpen(put(ctx, `${id}.json`, text)));
          assert.equal(warnings.expect(error.code), "wrongApp", label);
          assert.equal(error.info.app, apps[id].name, label);
          assertClean(ctx, label);
        }
      }
    }

    // Without a legacy adapter even this app's own v1 formats are not backups it can read.
    const adapter = app.legacy;
    app.legacy = undefined;
    t.after(() => (app.legacy = adapter));
    for (const format of V1_FORMATS[app.id] ?? [])
      assert.equal(
        await code("own.json", `{"format":"${format}","version":1}`),
        "notArchive",
        format
      );
    assert.equal(await code("adapterless.json", '{"format":"vault-test-backup"}'), "notArchive");
    assertClean(ctx, "without an adapter");

    const legacy = ctx.w.require("@/vault/engine/legacy");
    assert.deepEqual([legacy.V1_FORMATS, legacy.SNIFF_BYTES], [V1_FORMATS, SNIFF_BYTES]);
    // This app's own formats, when it has v1 backups, are the ones its descriptor reads.
    if (adapter)
      assert.deepEqual(
        Object.values(adapter.formats).sort(),
        [...(V1_FORMATS[app.id] ?? [])].sort()
      );
    // Each refused file was reported once, and nothing else was.
    warnings.done();
  }
);

test(
  "G12 sniffing: this app's damaged v1 files are corrupt, an encrypted one needs its password, an oversized one is legacyTooLarge",
  { skip: vault.skip },
  async (t) => {
    const ctx = await withLegacy(t, seeded);
    if (!ctx) return;
    const { app } = ctx;
    const { plain, encrypted } = app.legacy.formats;
    const warnings = diagnostics(t);
    const code = async (name, text, options) =>
      warnings.expect(
        (await vaultError(() => ctx.ops.runOpen(put(ctx, name, text), options))).code
      );
    const cases = [
      // Cut short: the start still names this app's format.
      ["cut short", `{"format":"${plain}","version":1,"createdAt":"2026-0`, "corrupt"],
      ["version 2", `{"format":"${plain}","version":2,"data":{}}`, "corrupt"],
      ["rejected by the app", `{"format":"${plain}","version":1,"data":{}}`, "corrupt"],
      ["no password", `{"format":"${encrypted}","version":1}`, "legacyPasswordRequired"],
      ["encrypted, cut short", `{"format":"${encrypted}","version":1,"salt":"`, "corrupt"],
    ];
    for (const [label, text, expected] of cases) {
      assert.equal(await code("damaged.json", text), expected, label);
      assertClean(ctx, label);
    }
    // A password does not make a damaged envelope readable: the app's decrypt refuses it.
    assert.equal(
      await code("envelope.json", `{"format":"${encrypted}","version":1}`, { password: PASSWORD }),
      "legacyPasswordWrong"
    );
    // Over the adapter's limit: refused before the file is read.
    const adapter = app.legacy;
    app.legacy = { ...adapter, maxBytes: 64 };
    t.after(() => (app.legacy = adapter));
    const error = await vaultError(() =>
      ctx.ops.runOpen(
        put(ctx, "large.json", `{"format":"${plain}","version":1,"data":{"x":"${"y".repeat(64)}"}}`)
      )
    );
    assert.equal(warnings.expect(error.code), "legacyTooLarge");
    assert.ok(error.info.bytes > 64);
    assertClean(ctx, "too large");
    warnings.done();
  }
);

// ---------------------------------------------------------------------------------------------------------------
// G12 restoring v1 backups (lift, macro)

/** runExport into Documents/out/<name> (manual, photos embedded, no CSV). */
function exportTo(ctx, name) {
  fs.mkdirSync(ctx.w.file("out"), { recursive: true });
  return ctx.ops.runExport({
    kind: "manual",
    destination: new ctx.File(ctx.w.uri("out", name)),
    embedMedia: true,
    csv: false,
    deflateLevel: 6,
  });
}

/** Copies a file of one world into another's Documents/in/ (a file shared between devices). */
function carry(from, to, file, name) {
  fs.mkdirSync(to.w.file("in"), { recursive: true });
  fs.copyFileSync(from.paths.fsPath(file), to.w.file("in", name));
  return new to.File(to.w.uri("in", name));
}

/**
 * The descriptor tables as a v1 restore treats them: `whole` = replaced without a scope (user records, compared row
 * by row with the database the file was made from); `kept` = not declared by the adapter, kept as on device (the
 * key/value preferences are checked key by key: the overrides write some).
 */
function declared(app) {
  const scopes = new Map(app.legacy.tables.map((x) => [x.name, x.scope]));
  return {
    whole: app.tables
      .filter((x) => x.role === "data" && scopes.has(x.name) && !scopes.get(x.name))
      .map((x) => x.name),
    kept: app.tables.filter((x) => !scopes.has(x.name) && x.mode !== "keys").map((x) => x.name),
  };
}

const keysTable = (app) => app.tables.find((x) => x.mode === "keys" && x.keys);

/** The local calendar day before today, as the diary writes days. */
function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The preferences after a v1 restore (spec §2.11, §5.2): Health off; the live `installation` kept (v1 files carry
 * none); `healthInstallations` = the live lineage + "*"; the adapter's keys from the file; lift drops `restTimer` and
 * `travel`, macro settles yesterday again; every other key as it was.
 */
function assertPreferences(ctx, before, backup) {
  const { app, db } = ctx;
  const after = keyStore(db, keysTable(app));
  for (const [key, value] of Object.entries(HEALTH_OFF)) assert.equal(after.get(key), value, key);
  assert.equal(
    after.get("installation"),
    before.get("installation"),
    "the live installation stays"
  );
  const lineage = [
    ...new Set(
      [
        ...JSON.parse(before.get("healthInstallations") ?? "[]"),
        before.get("installation"),
        "*",
      ].filter(Boolean)
    ),
  ].sort();
  assert.deepEqual(JSON.parse(after.get("healthInstallations")), lineage);
  if ("activeGym" in backup.data)
    assert.equal(
      after.get("activeGym"),
      backup.data.activeGym === null ? undefined : String(backup.data.activeGym)
    );
  if (app.id === "lift")
    assert.deepEqual([after.get("restTimer"), after.get("travel")], [undefined, undefined]);
  if (app.id === "macro") assert.equal(after.get("settledDay"), yesterday());
  const touched = new Set([
    ...Object.keys(HEALTH_OFF),
    "installation",
    "healthInstallations",
    "restTimer",
    "travel",
    "settledDay",
    ...app.legacy.preferenceKeys,
  ]);
  for (const key of new Set([...before.keys(), ...after.keys()]))
    if (!touched.has(key)) assert.equal(after.get(key), before.get(key), `kept: ${key}`);
}

test(
  "G12 a plain v1 backup made by the app restores through the vault: declared tables replaced, the rest kept, sync ids filled, Health off",
  { skip: vault.skip },
  async (t) => {
    const ctx = await withLegacy(t, seeded);
    if (!ctx) return;
    const { db, app, state } = ctx;
    const { backup, plain } = v1Backup(ctx);
    const { whole, kept } = declared(app);
    const made = Object.fromEntries(whole.map((x) => [x, rowsOf(ctx, db, x)]));
    const file = put(ctx, "v1.json", plain);
    const changed = change(ctx, db);
    assert.notDeepEqual(rowsOf(ctx, db, changed), made[changed]);
    const keptRows = Object.fromEntries(kept.map((x) => [x, rowsOf(ctx, db, x)]));
    const prefs = keyStore(db, keysTable(app));
    const library = state.readState(db, "library.id");

    const archive = await ctx.ops.runOpen(file);
    assert.equal(archive.format, "legacy");
    assert.equal(archive.manifest, null);
    const { preview } = archive;
    assert.deepEqual(
      [preview.format, preview.kind, preview.createdAt, preview.device, preview.libraryId],
      ["legacy", "legacy", new Date(backup.createdAt).toISOString(), null, null]
    );
    assert.deepEqual(preview.incoming, app.legacy.counts(backup));
    assert.deepEqual(
      [preview.sameDevice, preview.crossPlatform, preview.olderSchema, preview.liveEmpty],
      [false, false, false, false]
    );
    const result = await ctx.ops.runRestore(archive, { reason: "file" });
    archive.close();

    assert.match(result.recoveryId, RECOVERY_ID, "the replaced library is kept as a recovery set");
    assert.equal(ctx.recovery.latestRecovery(db).id, result.recoveryId);
    assert.equal(result.libraryId, library, "a v1 file keeps the current library");
    assert.equal(state.readState(db, "library.id"), library);
    assert.deepEqual(
      [result.warning, result.mediaRestored, result.mediaSkipped, result.mediaKeptLive],
      [null, 0, 0, 0]
    );
    for (const table of whole) assert.deepEqual(rowsOf(ctx, db, table), made[table], table);
    for (const table of kept)
      assert.deepEqual(rowsOf(ctx, db, table), keptRows[table], `kept: ${table}`);
    // v1 files carry no sync ids: the scratch gets the live shape, every restored row a fresh id.
    for (const table of (app.syncIdTables ?? []).filter((x) => whole.includes(x))) {
      const ids = db.getAllSync(`SELECT sync_id FROM ${q(table)}`).map((r) => r.sync_id);
      assert.ok(
        ids.every((id) => UUID_V4.test(id)),
        `${table}: v4`
      );
      assert.equal(new Set(ids).size, ids.length, `${table}: unique`);
    }
    assertPreferences(ctx, prefs, backup);
    assert.deepEqual(db.getAllSync("PRAGMA foreign_key_check"), []);
    assertClean(ctx, "after the restore");
  }
);

test(
  "G12 an encrypted v1 backup made by the app: its password is asked, a wrong one refused, the right one restores it on another device",
  { skip: vault.skip },
  async (t) => {
    const source = await withLegacy(t, seeded);
    if (!source) return;
    const { backup, encrypted } = v1Backup(source);
    const { whole } = declared(source.app);
    const made = Object.fromEntries(whole.map((x) => [x, rowsOf(source, source.db, x)]));
    const text = await encrypted();
    assert.equal(JSON.parse(text).format, source.app.legacy.formats.encrypted);

    // Another device whose library holds only what the app writes by itself.
    const ctx = await fresh(await open(t));
    const { db, app } = ctx;
    const file = put(ctx, "v1-encrypted.json", text);
    const warnings = diagnostics(t);
    const failure = async (options) =>
      warnings.expect((await vaultError(() => ctx.ops.runOpen(file, options))).code);
    assert.equal(await failure(), "legacyPasswordRequired");
    assert.equal(await failure({ password: "not the password at all" }), "legacyPasswordWrong");
    assert.equal(await failure({ password: "short" }), "legacyPasswordWrong");
    assertClean(ctx, "refused");
    warnings.done();

    const prefs = keyStore(db, keysTable(app));
    const archive = await ctx.ops.runOpen(file, { password: PASSWORD });
    assert.equal(archive.format, "legacy");
    assert.deepEqual(archive.preview.incoming, app.legacy.counts(backup));
    assert.equal(archive.preview.liveEmpty, true);
    const result = await ctx.ops.runRestore(archive, { reason: "file" });
    archive.close();
    assert.equal(result.recoveryId, null, "an empty library leaves no recovery set");
    for (const table of whole) assert.deepEqual(rowsOf(ctx, db, table), made[table], table);
    assertPreferences(ctx, prefs, backup);
    assertClean(ctx, "after the restore");
  }
);

test(
  "G12 Health links of a v1 restore: rebuilt as the v1 restore did, merged with this device's (a live link the file reaches by remote id not carried, tombstones carried, parked links follow their record, links to deleted samples rewritten)",
  { skip: vault.skip },
  async (t) => {
    const ctx = await withLegacy(t, seeded);
    if (!ctx) return;
    const { db, app } = ctx;
    if (!app.health) {
      t.skip("no Health links in this app");
      return;
    }
    const { backup } = v1Backup(ctx);
    // In the file, the first weight this device typed is a scale reading the file's phone imported; this device
    // keeps its own exported link at that id. The file's row there is another record (§5.4 rule A).
    const scale = (backup.data.weights ?? []).find((w) => !w.healthId);
    if (scale) {
      scale.healthId = "VAULT-V1-SCALE";
      db.runSync(
        'INSERT INTO "health_links" ("key", "local_kind", "local_id", "remote_id", "fingerprint", "origin") VALUES (?, ?, ?, ?, ?, ?)',
        ["vault:own-v1", "weight", scale.id, "R-own-v1", "own", "local"]
      );
    }
    // Another typed weight of the file: this device's link to it was set aside by an earlier restore and the next
    // sync removed its sample (a tombstone parked at -1 under this device's installation). The file has no link at
    // that id, so the sync writes the record under exactly that key: the tombstone is carried and follows the
    // record (rules A and R, vault 1.0.2).
    const installation = keyStore(db, keysTable(app)).get("installation");
    const ownKey = (kind, id) => `${app.health.clientPrefix}:${installation}:${kind}:${id}`;
    const typed = (backup.data.weights ?? []).find((w) => !w.healthId && w !== scale);
    if (typed && installation) {
      db.runSync('DELETE FROM "health_links" WHERE "local_kind" = \'weight\' AND "local_id" = ?', [
        typed.id,
      ]);
      db.runSync(
        'INSERT INTO "health_links" ("key", "local_kind", "local_id", "remote_id", "fingerprint", "origin") VALUES (?, ?, ?, ?, ?, ?)',
        [ownKey("weight", typed.id), "weight", -1, "R-parked-v1", "deleted", "local"]
      );
    }
    // lift: a workout the file links by its sample id (a `restored:workout` link) whose sample this device removed
    // after an earlier restore set it aside: its link is a tombstone at -1 holding that id, which the swap hook does
    // not look at (another local id). The file's link must not be trusted (rule D).
    const saved = (backup.data.workouts ?? []).find((w) => w.healthId && w.endedAt);
    if (saved && app.health.rowTables.workout)
      db.runSync(
        'UPDATE "health_links" SET "local_id" = -1, "fingerprint" = \'deleted\' WHERE "origin" = \'local\' AND "local_kind" = \'workout\' AND "remote_id" = ? AND "key" NOT LIKE \'restored:%\'',
        [saved.healthId]
      );
    const plain = JSON.stringify(backup);
    // What the adapter writes: the links the v1 restore wrote (§2.11).
    const incoming = new Map();
    const add = (link) => incoming.has(link.key) || incoming.set(link.key, link);
    for (const w of backup.data.weights ?? [])
      if (w.healthId)
        add({
          key: `health:weight:${w.healthId}`,
          local_kind: "weight",
          local_id: w.id,
          remote_id: w.healthId,
          fingerprint: `${w.weightKg}:${w.measuredAt}`,
          origin: "health",
        });
    for (const w of backup.data.workouts ?? [])
      if (w.healthId && w.endedAt)
        add({
          key: `restored:workout:${w.id}`,
          local_kind: "workout",
          local_id: w.id,
          remote_id: w.healthId,
          fingerprint: `${w.startedAt}|${w.endedAt}|${w.name}`,
          origin: "local",
        });
    assert.ok(incoming.size > 0, "the fixture has Health links a v1 file carries");

    // The merge with this device's links (§5.4), within the adapter's scope.
    const scope = app.legacy.tables.find((x) => x.name === "health_links")?.scope;
    const live = linksOf(db);
    const inScope = new Set(
      db
        .getAllSync(`SELECT "key" FROM "health_links"${scope ? ` WHERE ${scope}` : ""}`)
        .map((r) => r.key)
    );
    const rowExists = (l) => {
      const table = app.health.rowTables[l.local_kind];
      return (
        !!table && !!db.getFirstSync(`SELECT 1 AS v FROM ${q(table)} WHERE id = ?`, [l.local_id])
      );
    };
    const expected = new Map(live.filter((l) => !inScope.has(l.key)).map((l) => [l.key, l]));
    for (const link of incoming.values()) {
      const mine = live.find((l) => l.key === link.key && l.origin === "local");
      // B: a key both sides know takes this device's state of its sample.
      expected.set(
        link.key,
        mine && link.origin === "local"
          ? { ...link, remote_id: mine.remote_id, fingerprint: mine.fingerprint }
          : link
      );
    }
    const remoteIds = new Set([...incoming.values()].map((l) => l.remote_id).filter(Boolean));
    for (const l of live.filter((x) => inScope.has(x.key))) {
      if (expected.has(l.key)) continue;
      if (l.origin === "local" && (l.fingerprint === "deleted" || !remoteIds.has(l.remote_id))) {
        // A: carried, tombstones included (whatever remote id the file holds); when the file links that record's id
        // under another key (an import's link included: the file's row there is another record), at -1.
        const covered = [...incoming.values()].some(
          (i) => i.local_kind === l.local_kind && i.local_id === l.local_id
        );
        expected.set(l.key, { ...l, local_id: covered ? -1 : l.local_id });
      } else if (l.origin === "health" && !rowExists(l))
        // C: an import whose row was deleted here stays deleted.
        expected.set(l.key, { ...l, local_id: -1 });
    }
    const sameRemote = live.filter(
      (l) =>
        inScope.has(l.key) &&
        l.origin === "local" &&
        l.fingerprint !== "deleted" &&
        !incoming.has(l.key) &&
        remoteIds.has(l.remote_id)
    );

    await restoreFrom(ctx, put(ctx, "v1.json", plain));
    const after = linksOf(db);
    // R and D, within the adapter's scope (§5.4).
    const scoped = (l) =>
      !scope ||
      !!db.getFirstSync(
        `SELECT 1 AS v FROM (SELECT ? AS "key", ? AS "local_kind", ? AS "local_id", ? AS "remote_id", ? AS "fingerprint", ? AS "origin") WHERE ${scope}`,
        [l.key, l.local_kind, l.local_id, l.remote_id, l.fingerprint, l.origin]
      );
    // R: a link parked under the live installation (a v1 file keeps it) whose key names an id no link holds takes
    // that id; one link per id.
    const moved = new Map();
    for (const l of expected.values()) {
      const named = new RegExp(`:${l.local_kind}:(\\d+)$`).exec(l.key);
      if (l.origin !== "local" || l.local_id !== -1 || !named || !scoped(l)) continue;
      if (!installation || !l.key.startsWith(`${app.health.clientPrefix}:${installation}:`))
        continue;
      const id = Number(named[1]);
      const held = [...expected.values()].some(
        (x) => x.local_kind === l.local_kind && x.local_id === id
      );
      if (held) continue;
      const record = `${l.local_kind}:${id}`;
      if (!moved.has(record) || l.key < moved.get(record).key)
        moved.set(record, { key: l.key, id });
    }
    for (const { key, id } of moved.values())
      expected.set(key, { ...expected.get(key), local_id: id });
    // D: a link still trusted whose remote id a local tombstone holds names a sample this store no longer has.
    const deleted = [...expected.values()].filter(
      (l) => l.origin === "local" && l.fingerprint === "deleted" && l.remote_id
    );
    for (const l of [...expected.values()])
      if (
        l.origin === "local" &&
        l.remote_id &&
        !["", "deleted"].includes(l.fingerprint) &&
        scoped(l) &&
        deleted.some((d) => d.local_kind === l.local_kind && d.remote_id === l.remote_id)
      )
        expected.set(l.key, { ...l, fingerprint: "" });
    assert.deepEqual(
      after,
      [...expected.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    );
    // A live link to a sample the file links by its remote id is not carried: the sample is written once (§5.8).
    for (const l of sameRemote) assert.ok(!after.some((x) => x.key === l.key), l.key);
    // This device's sample of the row the file replaced by an import is removed by the next sync, not orphaned.
    if (scale) assert.equal(after.find((l) => l.key === "vault:own-v1")?.local_id, -1);
    // The parked tombstone came along and now names the typed record: the next sync writes it under that key.
    if (typed && installation)
      assert.deepEqual(
        after.find((l) => l.key === ownKey("weight", typed.id)),
        {
          key: ownKey("weight", typed.id),
          local_kind: "weight",
          local_id: typed.id,
          remote_id: "R-parked-v1",
          fingerprint: "deleted",
          origin: "local",
        }
      );
    // The file's link to the workout sample this device deleted is written again, not trusted.
    if (saved && app.health.rowTables.workout)
      assert.equal(after.find((l) => l.key === `restored:workout:${saved.id}`)?.fingerprint, "");
    assert.deepEqual(db.getAllSync("PRAGMA foreign_key_check"), []);
  }
);

test(
  "G12 lift's restored:workout links through later v2 restores: same device unchanged, another iPhone keeps their remote ids, another platform drops them",
  { skip: vault.skip },
  async (t) => {
    const a = await withLegacy(t, seeded);
    if (!a) return;
    if (!a.app.health?.rowTables.workout) {
      t.skip("no Health workouts in this app");
      return;
    }
    const { backup, plain } = v1Backup(a);
    await restoreFrom(a, put(a, "v1.json", plain));
    const healthIds = new Map(
      backup.data.workouts.filter((w) => w.healthId && w.endedAt).map((w) => [w.id, w.healthId])
    );
    const restored = linksOf(a.db).filter((l) => l.key.startsWith("restored:"));
    assert.ok(restored.length > 0, "the fixture has workouts saved to Health");
    // Each one reaches its saved workout by remote id only: the key is not a sync id (§5.8 item 3).
    for (const l of restored) assert.equal(l.remote_id, healthIds.get(l.local_id), l.key);
    const links = linksOf(a.db);
    const exported = await exportTo(a, "after-v1.archive");

    // The same device: nothing to reset; the merge takes the live state of every key.
    await restoreFrom(a, exported.file);
    assert.deepEqual(linksOf(a.db), links);

    // Another iPhone: fingerprints reset, so the first sync removes each original by its remote id and writes it
    // once under its own key (§5.3); the remote ids stay.
    const b = await fresh(await open(t, { platform: a.w.platform }));
    await restoreFrom(b, carry(a, b, exported.file, "after-v1.archive"));
    const other = linksOf(b.db).filter((l) => l.key.startsWith("restored:"));
    assert.deepEqual(
      other.map((l) => [l.key, l.remote_id, l.fingerprint]),
      restored.map((l) => [l.key, l.remote_id, ""])
    );

    // Another platform: nothing could address the original sample there, so the links go (§5.3).
    const c = await fresh(await open(t, { platform: a.w.platform === "ios" ? "android" : "ios" }));
    await restoreFrom(c, carry(a, c, exported.file, "after-v1.archive"));
    const crossed = linksOf(c.db);
    assert.deepEqual(
      crossed.filter((l) => l.key.startsWith("restored:")),
      []
    );
    assert.ok(
      crossed
        .filter((l) => l.origin === "local")
        .every((l) => l.remote_id === "" && l.fingerprint === ""),
      "every other local link reset"
    );
  }
);

test(
  "G12 the v1 pre-restore copy: found by file name in the app's backup folder, opened through the v1 reader, kept until a v2 restore",
  { skip: vault.skip },
  async (t) => {
    const ctx = await withLegacy(t, seeded);
    if (!ctx) return;
    const { db, app, recovery } = ctx;
    const folder = V1_FOLDERS[app.id];
    if (!folder) {
      t.skip("no v1 backup folder known for this app");
      return;
    }
    const prefs = keysTable(app);
    const setUri = (uri) =>
      db.runSync(
        `INSERT INTO ${q(prefs.name)} (${q(prefs.keys.keyColumn)}, ${q(prefs.keys.valueColumn)}) VALUES ('recoveryBackupUri', ?) ` +
          `ON CONFLICT(${q(prefs.keys.keyColumn)}) DO UPDATE SET ${q(prefs.keys.valueColumn)} = excluded.${q(prefs.keys.valueColumn)}`,
        [uri]
      );
    const { encrypted } = v1Backup(ctx);
    const name = "before-restore-1788000000000.backup.json";
    fs.mkdirSync(ctx.w.file(folder), { recursive: true });
    fs.writeFileSync(ctx.w.file(folder, name), await encrypted());
    const mtime = new Date("2026-09-01T10:00:00.000Z");
    fs.utimesSync(ctx.w.file(folder, name), mtime, mtime);

    // Written by another installation: its container path is gone, the file name still finds the copy.
    const old = `file:///var/mobile/Containers/Data/Application/0A1B-OLD/Documents/${folder}/${name}`;
    setUri(old);
    assert.deepEqual(recovery.latestRecovery(db), {
      id: "legacy",
      createdAt: mtime.toISOString(),
      legacy: true,
    });
    assert.equal((await recovery.recoveryFile("legacy")).uri, ctx.w.uri(folder, name));
    // Names that leave the folder, or do not decode, find nothing.
    for (const uri of [
      `file:///x/${folder}/..%2F..%2Fsecret.json`,
      `file:///x/${folder}/%E0%A4%A`,
      `file:///x/${folder}/.hidden`,
      `file:///x/${folder}/before-restore-1.backup.json`,
      "",
    ]) {
      setUri(uri);
      assert.equal(recovery.latestRecovery(db), null, uri);
      assert.equal(await recovery.recoveryFile("legacy"), null, uri);
    }
    setUri(old);

    // Encrypted: its password first, as for any v1 file.
    const code = await locked(
      ctx,
      async () => (await vaultError(() => recovery.openRecovery("legacy"))).code
    );
    assert.equal(code, "legacyPasswordRequired");
    assertClean(ctx, "password asked");
    change(ctx, db);
    const archive = await ctx.ops.runOpen(await recovery.recoveryFile("legacy"), {
      password: PASSWORD,
    });
    const result = await ctx.ops.runRestore(archive, { reason: "legacyRecovery" });
    archive.close();
    // A v1 restore keeps the copy and its key; the v2 set it made is now the one offered.
    assert.ok(fs.existsSync(ctx.w.file(folder, name)));
    assert.equal(keyStore(db, prefs).get("recoveryBackupUri"), old);
    assert.equal(recovery.latestRecovery(db).id, result.recoveryId);

    // The next v2 restore supersedes the copy: the key and the file go (§3.9).
    const exported = await exportTo(ctx, "v2.archive");
    await restoreFrom(ctx, exported.file);
    assert.equal(keyStore(db, prefs).get("recoveryBackupUri"), undefined);
    assert.equal(fs.existsSync(ctx.w.file(folder, name)), false);
  }
);
