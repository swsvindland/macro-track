// G1, G5, G5b, G6–G11, G16, G18 (restore part), G19, G20, G21b, G23, G24, G25 and the ops, recovery-set and erase
// tests (synced, hash-checked; loaded by tests/vault.test.*): restoreArchive end to end through the entry points of
// ops.ts — scratch replay and forward migration, the commit section's atomicity, crash journal, foreign keys,
// sequences, device state, recovery sets, media, table presence, a concurrent writer, sync ids, the Health provenance
// merge, the empty-library rule and cancellation. Every test runs the vault's real TypeScript in a harness world
// against this repo's real descriptor, schema and fixture.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Buffer } = require("node:buffer");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const vault = require("../vault-harness.cjs");

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RECOVERY_ID = /^\d{8}T\d{6}Z-[a-z0-9]{4}$/;
const q = (name) => `"${name.replaceAll('"', '""')}"`;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

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

/** Whatever `fn` throws or rejects with. */
async function thrown(fn) {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  assert.fail("expected a failure");
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
    paths: vaultModule("engine/paths"),
    state: vaultModule("engine/state"),
    lock: vaultModule("engine/lock"),
    device: vaultModule("engine/device"),
    exporter: vaultModule("engine/export"),
    inspect: vaultModule("engine/inspect"),
    ready: vaultModule("engine/ready"),
    journal: vaultModule("engine/journal"),
    recovery: vaultModule("engine/recovery"),
    restore: vaultModule("engine/restore"),
    swap: vaultModule("engine/swap"),
    scratch: vaultModule("engine/scratch"),
    erase: vaultModule("engine/erase"),
    ops: vaultModule("ops"),
  };
}

/** `work` under the vault lock with the vault's connection, after ensureReady (what every entry point does). */
async function locked(ctx, work = async () => {}, kind = "recover") {
  return ctx.lock.exclusive(
    kind,
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

/** A world with the app's live database, seeded at the current level and ready (device, library, sync ids). */
async function seeded(t, options) {
  const ctx = await open(t, options);
  const db = await ctx.w.live();
  ctx.w.seed(db);
  await locked(ctx);
  return { ...ctx, db };
}

/** runExport into Documents/out/<name> (manual, photos embedded, no CSV). */
function exportTo(ctx, name, options = {}) {
  fs.mkdirSync(ctx.w.file("out"), { recursive: true });
  return ctx.ops.runExport({
    kind: "manual",
    destination: new ctx.File(ctx.w.uri("out", name)),
    embedMedia: true,
    csv: false,
    deflateLevel: 6,
    ...options,
  });
}

/** runOpen + runRestore + close, as the import screen does. */
async function restoreFrom(ctx, file, options = {}) {
  const archive = await ctx.ops.runOpen(file);
  try {
    return await ctx.ops.runRestore(archive, { reason: "file", ...options });
  } finally {
    archive.close();
  }
}

/** Copies an archive file of one world into another's Documents/in/ (a file shared between devices). */
function carry(from, to, file, name) {
  fs.mkdirSync(to.w.file("in"), { recursive: true });
  fs.copyFileSync(from.paths.fsPath(file), to.w.file("in", name));
  return new to.File(to.w.uri("in", name));
}

/**
 * Makes `to` (a world whose live database the vault has not touched yet) the same device as `from`: its device id
 * in the database and the anchor, and its fingerprint, as a second database on one phone would be.
 */
async function asSameDevice(from, to) {
  const id = from.state.readState(from.db, "device.id");
  to.w.device.fingerprint = from.w.device.fingerprint;
  fs.mkdirSync(to.w.file("PendumVault"), { recursive: true });
  fs.writeFileSync(
    to.w.file("PendumVault", "device.json"),
    JSON.stringify({ deviceId: id, createdAt: "2026-10-01T00:00:00.000Z" })
  );
  const db = await to.w.live();
  to.state.updateState(db, { "device.id": id, "device.fingerprint": from.w.device.fingerprint });
  return db;
}

const tableExists = (db, name) =>
  db.getFirstSync("SELECT 1 AS v FROM sqlite_master WHERE type = 'table' AND name = ?", [name]) !=
  null;
const columnsOf = (db, table) =>
  db.getAllSync("SELECT name FROM pragma_table_info(?)", [table]).map((c) => c.name);

/**
 * Every exported row of every descriptor table, by table: exported columns (minus `without`), keys tables limited to
 * their universe (minus `skipKeys`) in key order, singleton tables to their row, others in rowid order.
 */
function dump(ctx, db, { without = [], skipKeys = [], tables } = {}) {
  const out = {};
  for (const t of ctx.app.tables) {
    if ((tables && !tables.includes(t.name)) || !tableExists(db, t.name)) continue;
    const skip = new Set([...(t.deviceColumns ?? []), ...without]);
    const columns = columnsOf(db, t.name).filter((c) => !skip.has(c));
    let tail = " ORDER BY rowid";
    let params = [];
    if (t.mode === "keys") {
      const keys = t.keys.include.filter((k) => !skipKeys.includes(k));
      tail = ` WHERE ${q(t.keys.keyColumn)} IN (${keys.map(() => "?").join(", ")}) ORDER BY ${q(t.keys.keyColumn)}`;
      params = keys;
    } else if (t.mode === "singleton") tail = ` WHERE ${t.singleton.where}`;
    out[t.name] = db.getAllSync(
      `SELECT ${columns.map(q).join(", ")} FROM ${q(t.name)}${tail}`,
      params
    );
  }
  return out;
}

/** sqlite_sequence as { table: seq }. */
const sequences = (db) =>
  tableExists(db, "sqlite_sequence")
    ? Object.fromEntries(
        db.getAllSync("SELECT name, seq FROM sqlite_sequence").map((r) => [r.name, r.seq])
      )
    : {};

let copies = 0;
/** SHA-256 of a VACUUM INTO copy: equal ⇔ the database did not change. */
function liveHash(ctx, db) {
  const file = path.join(ctx.w.dir, `hash-${++copies}.db`);
  db.runSync("VACUUM INTO ?", [file]);
  try {
    return sha256(fs.readFileSync(file));
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/** Every file under a folder, by relative path → SHA-256 (empty when the folder is missing). */
function tree(dir) {
  const out = {};
  const walk = (at, prefix) => {
    for (const e of fs
      .readdirSync(at, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : 1)))
      if (e.isDirectory()) walk(path.join(at, e.name), `${prefix}${e.name}/`);
      else out[`${prefix}${e.name}`] = sha256(fs.readFileSync(path.join(at, e.name)));
  };
  if (fs.existsSync(dir)) walk(dir, "");
  return out;
}

/** The live media folders: set → { name: sha256 }. */
const mediaState = (ctx) =>
  Object.fromEntries((ctx.app.media ?? []).map((m) => [m.set, tree(ctx.w.file(m.directory))]));

/** What a finished operation must not leave behind (`open`: work folders of archives still open). */
function leftovers(ctx, open = []) {
  const list = (...segments) =>
    fs.existsSync(ctx.w.file(...segments)) ? fs.readdirSync(ctx.w.file(...segments)).sort() : [];
  return {
    work: list("PendumVault", "work").filter((e) => !open.includes(e)),
    partial: list("PendumVault", "recovery").filter((e) => e.endsWith(".partial")),
    journal: fs.existsSync(ctx.w.file("PendumVault", "journal.json")),
  };
}
const CLEAN = { work: [], partial: [], journal: false };

/** Complete recovery sets on disk, oldest first. */
const recoverySets = (ctx) =>
  fs.existsSync(ctx.w.file("PendumVault", "recovery"))
    ? fs
        .readdirSync(ctx.w.file("PendumVault", "recovery"))
        .filter((e) => RECOVERY_ID.test(e))
        .sort()
    : [];

/** The first replace-mode data table that has rows and holds no media (the one tests change). */
const dataTable = (ctx, db) =>
  ctx.app.tables.find(
    (x) =>
      x.role === "data" &&
      x.mode === "replace" &&
      !(ctx.app.media ?? []).some((m) => m.table === x.name) &&
      db.getFirstSync(`SELECT 1 AS v FROM ${q(x.name)} LIMIT 1`)
  );

/** A small PNG-like file (the vault never decodes media). */
const photoBytes = (label) => Buffer.from(`\x89PNG\r\n\x1a\nvault test photo ${label}`, "latin1");

/** A new row of a media set's table (a copy of its first row) referencing `name`, and the file. */
function addPhoto(ctx, db, set, name, label) {
  const copy = columnsOf(db, set.table).filter(
    (c) => c !== "id" && c !== "sync_id" && c !== set.column
  );
  db.runSync(
    `INSERT INTO ${q(set.table)} (${[set.column, ...copy].map(q).join(", ")}) SELECT ?, ${copy.map(q).join(", ")} FROM ${q(set.table)} LIMIT 1`,
    [name]
  );
  fs.writeFileSync(ctx.w.file(set.directory, name), photoBytes(label));
}

/**
 * Makes the live library differ from an archive taken just before: the last row of the first data table is
 * deleted, and with photos: a new photo (row + file) the archive lacks, and a referenced photo's file removed (its
 * row stays). Returns the names involved.
 */
function change(ctx, db) {
  const table = dataTable(ctx, db);
  db.runSync(
    `DELETE FROM ${q(table.name)} WHERE rowid = (SELECT max(rowid) FROM ${q(table.name)})`
  );
  const set = ctx.app.media?.[0];
  if (!set) return { table: table.name, added: null, removed: null };
  const [removed] = ctx.exporter.referencedMedia(db, set);
  fs.rmSync(ctx.w.file(set.directory, removed));
  const added = "1795000000000-vault01.png";
  addPhoto(ctx, db, set, added, "added");
  return { table: table.name, added, removed };
}

/** Silences console.warn for the test (expected failures are logged once for diagnostics); returns the calls. */
function quiet(t) {
  const calls = [];
  t.mock.method(console, "warn", (...args) => calls.push(args));
  return calls;
}

/** recoverJournal under the lock, as ensureReady runs it at the next start. */
const recover = (ctx, db) =>
  ctx.lock.exclusive("recover", () => ctx.journal.recoverJournal(db), { wait: true });

/** Wraps the descriptor's afterRestore to record its contexts. */
function recordAfterRestore(ctx) {
  const calls = [];
  const original = ctx.app.hooks.afterRestore;
  ctx.app.hooks.afterRestore = async (c) => {
    calls.push(c);
    return original(c);
  };
  return calls;
}

// ---------------------------------------------------------------------------------------------------------------
// G1 round trip

test(
  "G1 restore: an export restored into a fresh database of the same device is identical (rows, ids, sync ids, sequences, photos)",
  { skip: vault.skip },
  async (t) => {
    const source = await seeded(t);
    const before = dump(source, source.db);
    const exported = await exportTo(source, "g1.archive");
    const { manifest } = exported;
    assert.deepEqual(manifest.counts, source.exporter.summarize(source.db));
    assert.equal(manifest.device.id, source.state.readState(source.db, "device.id"));
    assert.equal(manifest.library.id, source.state.readState(source.db, "library.id"));

    const target = await open(t);
    const db = await asSameDevice(source, target);
    const afterRestore = recordAfterRestore(target);
    const archive = await target.ops.runOpen(carry(source, target, exported.file, "g1.archive"));
    assert.equal(archive.preview.sameDevice, true);
    assert.equal(archive.preview.liveEmpty, true);
    const steps = [];
    const result = await target.ops.runRestore(archive, {
      reason: "file",
      onProgress: (p) => {
        if (steps.at(-1) !== p.step) steps.push(p.step);
      },
    });
    archive.close();

    assert.deepEqual(dump(target, db), before);
    const was = sequences(source.db);
    const now = sequences(db);
    for (const t of target.app.tables)
      if (was[t.name] !== undefined) assert.ok(now[t.name] >= was[t.name], `${t.name} sequence`);
    assert.deepEqual(mediaState(target), mediaState(source));
    assert.deepEqual(result, {
      recoveryId: null,
      mediaRestored: manifest.media.length,
      mediaSkipped: 0,
      mediaKeptLive: 0,
      healthWasOn: false,
      libraryId: manifest.library.id,
      repairs: result.repairs.filter((r) => !r.message.startsWith("fk:")),
      warning: null,
    });
    assert.ok(result.repairs.every((r) => !r.fatal));
    assert.equal(target.state.readState(db, "library.id"), manifest.library.id);
    assert.equal(target.state.readState(db, "recovery.latest"), null);
    assert.match(target.state.readState(db, "restore.lastOp"), RECOVERY_ID);
    assert.deepEqual(
      steps.filter((s) => s !== "media"),
      ["verify", "scratch", "migrate", "validate", "swap", "finish"]
    );
    assert.equal(afterRestore.length, 1);
    assert.equal(afterRestore[0].sameDevice, true);
    assert.equal(afterRestore[0].reason, "file");
    assert.deepEqual(leftovers(target), CLEAN);
    assert.deepEqual(target.paths.liveOps(), []);
    assert.deepEqual(recoverySets(target), []);
  }
);

// ---------------------------------------------------------------------------------------------------------------
// G7 crash journal

test(
  "G7 crash journal: a crash after the media moves rolls back; recoverJournal leaves a live op alone and needs the lock",
  { skip: vault.skip },
  async (t) => {
    const ctx = await seeded(t);
    const { db } = ctx;
    const exported = await exportTo(ctx, "g7a.archive");
    change(ctx, db);
    const hash = liveHash(ctx, db);
    const files = mediaState(ctx);
    const archive = await ctx.ops.runOpen(exported.file);
    t.after(() => archive.close());
    ctx.swap.simulateCrash("afterMedia");
    const crash = await thrown(() =>
      ctx.lock.exclusive("restore", () => ctx.restore.restoreArchive(archive, { reason: "file" }), {
        wait: true,
      })
    );
    assert.equal(crash.name, "SimulatedCrash");
    const journal = ctx.journal.readJournal();
    assert.ok(journal, "the journal stays");
    assert.equal(journal.phase, "applying");
    assert.match(journal.recoveryId, RECOVERY_ID);
    assert.ok(
      fs.existsSync(
        ctx.w.file("PendumVault", "recovery", `${journal.recoveryId}.partial`, "live.db")
      )
    );
    if (ctx.app.media?.length) assert.notDeepEqual(mediaState(ctx), files, "media moved");
    assert.equal(liveHash(ctx, db), hash, "the swap never ran");

    await assert.rejects(() => ctx.journal.recoverJournal(db), /under the vault lock/);
    // The operation is still live in this runtime: recovery leaves it alone.
    await recover(ctx, db);
    assert.deepEqual(ctx.journal.readJournal(), journal);
    // A new process: the operation is no longer live.
    ctx.paths.endOp(journal.op);
    await recover(ctx, db);
    assert.equal(liveHash(ctx, db), hash);
    assert.deepEqual(mediaState(ctx), files);
    assert.deepEqual(leftovers(ctx, [archive.opId]), CLEAN);
    await recover(ctx, db);
    assert.equal(liveHash(ctx, db), hash, "idempotent");
    assert.deepEqual(mediaState(ctx), files);
    assert.deepEqual(recoverySets(ctx), []);
  }
);

test(
  "G7 crash journal: a crash after the commit rolls forward (set packaged, state and lineage already committed)",
  { skip: vault.skip },
  async (t) => {
    const ctx = await seeded(t);
    const { db, app } = ctx;
    const exported = await exportTo(ctx, "g7b.archive");
    const archiveRows = dump(ctx, db);
    const archiveMedia = mediaState(ctx);
    const changed = change(ctx, db);
    // An M3-shaped clock: the swap pauses it, bumps it once and writes lineage in the same transaction.
    db.execSync(
      'CREATE TABLE "_vault_clock" ("id" INTEGER PRIMARY KEY CHECK ("id" = 1), "gen" INTEGER NOT NULL DEFAULT 0, "seq" INTEGER NOT NULL DEFAULT 0, "paused" INTEGER NOT NULL DEFAULT 0, "source" TEXT); INSERT INTO "_vault_clock" ("id", "gen", "seq") VALUES (1, 7, 5)'
    );
    const afterRestore = recordAfterRestore(ctx);
    const archive = await ctx.ops.runOpen(exported.file);
    t.after(() => archive.close());
    ctx.swap.simulateCrash("afterCommit");
    const crash = await thrown(() =>
      ctx.lock.exclusive("restore", () => ctx.restore.restoreArchive(archive, { reason: "file" }), {
        wait: true,
      })
    );
    assert.equal(crash.name, "SimulatedCrash");
    const journal = ctx.journal.readJournal();
    assert.ok(journal);
    // Committed together with the rows: the marker, the library, the recovery pointer, lineage, the counters.
    assert.equal(ctx.state.readState(db, "restore.lastOp"), journal.op);
    assert.equal(ctx.state.readState(db, "library.id"), exported.manifest.library.id);
    assert.equal(ctx.state.readState(db, "recovery.latest"), journal.recoveryId);
    assert.equal(ctx.state.readState(db, "lineage.vector"), "{}");
    assert.equal(ctx.state.readState(db, "lineage.ownBase"), "6");
    assert.deepEqual(JSON.parse(ctx.state.readState(db, "lineage.adoptedFrom")), {
      deviceId: exported.manifest.device.id,
    });
    assert.equal(ctx.state.readState(db, "handoff.emptyOffered"), "0");
    assert.deepEqual(db.getFirstSync('SELECT "gen", "seq", "paused" FROM "_vault_clock"'), {
      gen: 8,
      seq: 6,
      paused: 0,
    });
    assert.deepEqual(dump(ctx, db), archiveRows);
    assert.equal(afterRestore.length, 0, "the process died before afterRestore");
    assert.equal(ctx.recovery.latestRecovery(), null, "a partial set is not offered");

    ctx.paths.endOp(journal.op);
    await recover(ctx, db);
    assert.equal(ctx.journal.readJournal(), null);
    assert.deepEqual(recoverySets(ctx), [journal.recoveryId]);
    assert.deepEqual(ctx.recovery.latestRecovery(), {
      id: journal.recoveryId,
      createdAt: ctx.recovery.latestRecovery().createdAt,
      legacy: false,
    });
    assert.equal(afterRestore.length, 1, "roll-forward ran afterRestore");
    assert.equal(afterRestore[0].now instanceof Date, true);
    assert.deepEqual(leftovers(ctx, [archive.opId]), CLEAN);
    assert.deepEqual(mediaState(ctx), archiveMedia);
    const set = app.media?.[0];
    if (set)
      assert.deepEqual(
        Object.keys(tree(ctx.w.file("PendumVault", "recovery", journal.recoveryId, "media"))),
        [`${set.set}/${changed.added}`],
        "the displaced photo is in the set"
      );
    await recover(ctx, db);
    assert.deepEqual(recoverySets(ctx), [journal.recoveryId], "idempotent");
    assert.equal(afterRestore.length, 1);
  }
);

/**
 * G7's same-name case, ready to restore: two live photos get other content under names the archive has (the
 * restore displaces both and adds the archive's copies), and the swap fails (an override names a missing table).
 * Null for an app without media.
 */
async function sameNameRestore(t, ctx) {
  const { db, app, w } = ctx;
  const set = app.media?.[0];
  if (!set) return null;
  const present = () =>
    ctx.exporter.referencedMedia(db, set).filter((n) => fs.existsSync(w.file(set.directory, n)));
  if (present().length < 2) addPhoto(ctx, db, set, "1795000000002-vault02.png", "second");
  const [first, second] = present();
  const exported = await exportTo(ctx, "same-name.archive");
  fs.writeFileSync(w.file(set.directory, first), photoBytes("first, edited on this device"));
  fs.writeFileSync(w.file(set.directory, second), photoBytes("second, edited on this device"));
  const overrides = app.deviceOverrides;
  app.deviceOverrides = (c) => [
    ...overrides(c),
    { sql: "INSERT INTO vault_g7_missing (v) VALUES (1)" },
  ];
  t.after(() => {
    app.deviceOverrides = overrides;
  });
  const archive = await ctx.ops.runOpen(exported.file);
  t.after(() => archive.close());
  return { set, first, second, archive, files: mediaState(ctx), hash: liveHash(ctx, db) };
}

/** Makes File.moveSync throw an I/O error once, for the first move whose source path `when` accepts. */
function failMoveOnce(t, ctx, when) {
  const failed = [];
  const { moveSync } = ctx.File.prototype;
  t.mock.method(ctx.File.prototype, "moveSync", function (destination, options) {
    const from = ctx.paths.fsPath(this);
    if (!failed.length && when(from)) {
      failed.push(from);
      throw new Error(`EIO: i/o error, rename '${from}'`);
    }
    return moveSync.call(this, destination, options);
  });
  return failed;
}

/** A move out of a partial recovery set's media folder (a rollback putting a displaced photo back). */
const fromPartialSet = (name) => (from) =>
  from.includes(".partial/media/") && path.basename(from) === name;

test(
  "G7 crash journal: a rollback that fails in the commit section keeps its staged copies; the next start puts every displaced photo back",
  { skip: vault.skip },
  async (t) => {
    quiet(t);
    const ctx = await seeded(t);
    const { db, w } = ctx;
    const setup = await sameNameRestore(t, ctx);
    if (!setup) {
      t.skip("no media moves in this app");
      return;
    }
    const { set, first, second, archive, files, hash } = setup;
    // The rollback cannot move the second photo back out of the recovery set (an I/O error, once).
    const failed = failMoveOnce(t, ctx, fromPartialSet(second));
    const error = await vaultError(() => ctx.ops.runRestore(archive, { reason: "file" }));
    assert.equal(error.code, "restoreFailed");
    assert.match(error.info.detail, /vault_g7_missing/);
    assert.equal(failed.length, 1);
    const journal = ctx.journal.readJournal();
    assert.ok(journal, "the rollback did not finish: the journal stays");
    assert.deepEqual(ctx.paths.liveOps(), [archive.opId], "the restore's operation ended");
    assert.equal(liveHash(ctx, db), hash, "the swap never committed");
    const live = mediaState(ctx)[set.set];
    assert.equal(live[first], files[set.set][first], "the first photo is back");
    assert.equal(live[second], undefined, "the second is still in the recovery set");
    const stage = w.file("PendumVault", "work", journal.op, "stage", set.set);
    assert.deepEqual(
      fs.existsSync(stage) ? fs.readdirSync(stage).sort() : [],
      [first, second].sort(),
      "the staged copies stay while the journal names the restore"
    );

    // The next start finishes the rollback: the second photo returns, the first (the original) stays in place.
    await recover(ctx, db);
    assert.equal(ctx.journal.readJournal(), null);
    assert.deepEqual(mediaState(ctx), files);
    assert.equal(liveHash(ctx, db), hash);
    assert.deepEqual(leftovers(ctx, [archive.opId]), CLEAN);
    assert.deepEqual(recoverySets(ctx), []);
  }
);

test(
  "G7 crash journal: a commit section that cannot clear its journal after the rollback reports the original error; the next start loses nothing",
  { skip: vault.skip },
  async (t) => {
    quiet(t);
    const ctx = await seeded(t);
    const { db } = ctx;
    const setup = await sameNameRestore(t, ctx);
    if (!setup) {
      t.skip("no media moves in this app");
      return;
    }
    const { archive, files, hash } = setup;
    const refused = [];
    const { delete: remove } = ctx.File.prototype;
    t.mock.method(ctx.File.prototype, "delete", function () {
      if (!refused.length && this.name === "journal.json") {
        refused.push(this.name);
        throw new Error("EIO: i/o error, unlink 'journal.json'");
      }
      return remove.call(this);
    });
    const error = await vaultError(() => ctx.ops.runRestore(archive, { reason: "file" }));
    assert.equal(error.code, "restoreFailed");
    assert.match(error.info.detail, /vault_g7_missing/, "the swap's error, not the cleanup's");
    assert.equal(refused.length, 1);
    assert.ok(ctx.journal.readJournal(), "the journal stays");
    assert.deepEqual(mediaState(ctx), files, "the rollback itself finished");

    await recover(ctx, db);
    assert.equal(ctx.journal.readJournal(), null);
    assert.deepEqual(mediaState(ctx), files);
    assert.equal(liveHash(ctx, db), hash);
    assert.deepEqual(leftovers(ctx, [archive.opId]), CLEAN);
  }
);

test(
  "G7 crash journal: without its staged copies, a rollback never moves a live file that is not what the restore added",
  { skip: vault.skip },
  async (t) => {
    quiet(t);
    const ctx = await seeded(t);
    const { db, w } = ctx;
    const setup = await sameNameRestore(t, ctx);
    if (!setup) {
      t.skip("no media moves in this app");
      return;
    }
    const { second, archive, files, hash } = setup;
    failMoveOnce(t, ctx, fromPartialSet(second));
    await vaultError(() => ctx.ops.runRestore(archive, { reason: "file" }));
    const journal = ctx.journal.readJournal();
    assert.ok(journal);
    // The staged copies are lost (an earlier version deleted them with work/<op>): the first photo in place is the
    // original, whose content differs from what the restore added under its name.
    fs.rmSync(w.file("PendumVault", "work", journal.op), { recursive: true, force: true });
    await recover(ctx, db);
    assert.equal(ctx.journal.readJournal(), null);
    assert.deepEqual(mediaState(ctx), files, "the original stays, the displaced photo returns");
    assert.equal(liveHash(ctx, db), hash);
    assert.deepEqual(leftovers(ctx, [archive.opId]), CLEAN);
  }
);

test(
  "G7 crash journal: after a crash without the staged copies, the live files the restore added go (their hashes match); unknown ones stay",
  { skip: vault.skip },
  async (t) => {
    quiet(t);
    /** A crash after the media moves of the same-name restore, its staged copies lost. */
    const crashed = async () => {
      const ctx = await seeded(t);
      const setup = await sameNameRestore(t, ctx);
      if (!setup) return null;
      ctx.swap.simulateCrash("afterMedia");
      const crash = await thrown(() =>
        ctx.lock.exclusive(
          "restore",
          () => ctx.restore.restoreArchive(setup.archive, { reason: "file" }),
          { wait: true }
        )
      );
      assert.equal(crash.name, "SimulatedCrash");
      const journal = ctx.journal.readJournal();
      ctx.paths.endOp(journal.op);
      fs.rmSync(ctx.w.file("PendumVault", "work", journal.op), { recursive: true, force: true });
      return { ctx, ...setup, journal };
    };

    const known = await crashed();
    if (!known) {
      t.skip("no media moves in this app");
      return;
    }
    assert.ok(
      known.journal.plan.add.length === 2 &&
        known.journal.plan.add.every(
          (m) => Number.isSafeInteger(m.bytes) && /^[0-9a-f]{64}$/.test(m.sha256)
        ),
      "the journal records what each add put in place"
    );
    await recover(known.ctx, known.ctx.db);
    assert.equal(known.ctx.journal.readJournal(), null);
    assert.deepEqual(mediaState(known.ctx), known.files);
    assert.equal(liveHash(known.ctx, known.ctx.db), known.hash);
    assert.deepEqual(leftovers(known.ctx, [known.archive.opId]), CLEAN);

    // A journal that does not say what its adds were: the live files stay as they are, and the originals stay in
    // their partial set (kept by every cleanup), so nothing is lost.
    const unknown = await crashed();
    const { ctx, set, first, second, files, journal } = unknown;
    const raw = JSON.parse(fs.readFileSync(ctx.w.file("PendumVault", "journal.json"), "utf8"));
    raw.plan.add = raw.plan.add.map(({ set: s, name }) => ({ set: s, name }));
    fs.writeFileSync(ctx.w.file("PendumVault", "journal.json"), JSON.stringify(raw));
    const live = mediaState(ctx);
    await recover(ctx, ctx.db);
    assert.equal(ctx.journal.readJournal(), null);
    assert.deepEqual(mediaState(ctx), live, "nothing live moved");
    assert.deepEqual(
      tree(ctx.w.file("PendumVault", "recovery", `${journal.recoveryId}.partial`, "media")),
      {
        [`${set.set}/${first}`]: files[set.set][first],
        [`${set.set}/${second}`]: files[set.set][second],
      }
    );
  }
);

// ---------------------------------------------------------------------------------------------------------------
// G6 atomicity

test(
  "G6 atomicity: a failing override leaves the database byte-identical, media in place, no recovery set or journal; sources are only copied",
  { skip: vault.skip },
  async (t) => {
    const warnings = quiet(t);
    const ctx = await seeded(t);
    const { db, app } = ctx;
    const exported = await exportTo(ctx, "g6.archive");
    change(ctx, db);
    const hash = liveHash(ctx, db);
    const files = mediaState(ctx);
    const overrides = app.deviceOverrides;
    const failing = (c) => [
      ...overrides(c),
      { sql: "INSERT INTO vault_g6_missing (v) VALUES (1)" },
    ];
    app.deviceOverrides = failing;
    const archive = await ctx.ops.runOpen(exported.file);
    t.after(() => archive.close());
    const error = await vaultError(() => ctx.ops.runRestore(archive, { reason: "file" }));
    assert.equal(error.code, "restoreFailed");
    assert.match(error.info.detail, /vault_g6_missing/);
    assert.deepEqual(
      warnings.map((w) => w.slice(0, 2)),
      [["[vault]", "restoreFailed"]],
      "reported once"
    );
    assert.equal(liveHash(ctx, db), hash, "byte-identical");
    assert.deepEqual(mediaState(ctx), files, "media moved back");
    assert.deepEqual(leftovers(ctx, [archive.opId]), CLEAN);
    assert.deepEqual(recoverySets(ctx), []);
    assert.deepEqual(ctx.paths.liveOps(), [archive.opId]);

    // The same archive restores once the override is fixed: a recovery set of the changed state is made.
    app.deviceOverrides = overrides;
    const done = await ctx.ops.runRestore(archive, { reason: "file" });
    assert.match(done.recoveryId, RECOVERY_ID);
    const setDir = ctx.w.file("PendumVault", "recovery", done.recoveryId);
    const set = tree(setDir);
    const restored = liveHash(ctx, db);
    const restoredFiles = mediaState(ctx);

    // Restoring that set with the failing override: the set itself (its archive and displaced photos, the media
    // source of this restore) is byte-identical afterwards, and so is everything live.
    app.deviceOverrides = failing;
    const { archive: undo, media } = await ctx.lock.exclusive(
      "inspect",
      () => ctx.recovery.openRecovery(done.recoveryId),
      { wait: true }
    );
    t.after(() => undo.close());
    const again = await vaultError(() => ctx.ops.runRestore(undo, { reason: "recovery", media }));
    assert.equal(again.code, "restoreFailed");
    assert.deepEqual(tree(setDir), set);
    assert.equal(liveHash(ctx, db), restored);
    assert.deepEqual(mediaState(ctx), restoredFiles);
    assert.deepEqual(leftovers(ctx, [archive.opId, undo.opId]), CLEAN);
    assert.deepEqual(recoverySets(ctx), [done.recoveryId]);
  }
);

// ---------------------------------------------------------------------------------------------------------------
// G8 foreign keys

/** A descriptor table with rows whose foreign key cascades from another replaced descriptor table (lift). */
function cascadingChild(ctx, db) {
  const names = ctx.app.tables.map((x) => x.name);
  for (const t of [...ctx.app.tables].reverse()) {
    const fk = db
      .getAllSync("SELECT * FROM pragma_foreign_key_list(?)", [t.name])
      .find((k) => names.includes(k.table) && k.on_delete.toUpperCase() === "CASCADE");
    if (fk && db.getFirstSync(`SELECT 1 AS v FROM ${q(t.name)} LIMIT 1`))
      return { table: t.name, parent: fk.table };
  }
  return null;
}

/** Rewrites an archive with `edit(entries, manifest)` applied (fflate's zipSync; the manifest re-serialized). */
function rezip(ctx, from, name, edit) {
  const { unzipSync, zipSync } = ctx.w.require("fflate");
  const entries = unzipSync(new Uint8Array(fs.readFileSync(ctx.paths.fsPath(from))));
  const manifest = JSON.parse(Buffer.from(entries["manifest.json"]).toString("utf8"));
  edit(entries, manifest);
  entries["manifest.json"] = new Uint8Array(Buffer.from(JSON.stringify(manifest)));
  fs.mkdirSync(ctx.w.file("out"), { recursive: true });
  fs.writeFileSync(ctx.w.file("out", name), zipSync(entries));
  return new ctx.File(ctx.w.uri("out", name));
}

/** Drops a table from an archive (an app version whose descriptor did not list it yet). */
const withoutTable = (ctx, from, name, table) =>
  rezip(ctx, from, name, (entries, manifest) => {
    delete entries[`data/${table}.ndjson`];
    manifest.tables = manifest.tables.filter((x) => x.name !== table);
  });

test(
  "G8 foreign keys: with foreign_keys = ON nothing cascades, the check is clean and the setting comes back, also when ATTACH fails",
  { skip: vault.skip },
  async (t) => {
    quiet(t);
    const ctx = await seeded(t);
    const { db } = ctx;
    const fkOn = () => db.getFirstSync("PRAGMA foreign_keys").foreign_keys;
    // lift opens its connection with foreign keys on; the others get them on for this test.
    db.execSync("PRAGMA foreign_keys = ON");
    const exported = await exportTo(ctx, "g8.archive");
    const rows = dump(ctx, db);
    change(ctx, db);
    await restoreFrom(ctx, exported.file);
    assert.equal(fkOn(), 1);
    assert.deepEqual(db.getAllSync("PRAGMA foreign_key_check"), []);
    assert.deepEqual(dump(ctx, db), rows);

    // A child table the archive lacks is kept as on device while its parent is replaced: deleting the parent's
    // rows must not cascade into it.
    const child = cascadingChild(ctx, db);
    if (child) {
      const kept = db.getAllSync(`SELECT * FROM ${q(child.table)} ORDER BY rowid`);
      assert.ok(kept.length > 0);
      const partial = withoutTable(ctx, exported.file, "g8-child.archive", child.table);
      await restoreFrom(ctx, partial);
      assert.deepEqual(db.getAllSync(`SELECT * FROM ${q(child.table)} ORDER BY rowid`), kept);
      assert.equal(fkOn(), 1);
      assert.deepEqual(db.getAllSync("PRAGMA foreign_key_check"), []);
    }

    // ATTACH fails: nothing changes and foreign keys are on again.
    const env = ctx.paths.engineEnv();
    ctx.paths.setEngineEnv({
      acquire: async () => {
        const live = await env.acquire();
        return new Proxy(live, {
          get(target, key) {
            const value = Reflect.get(target, key);
            if (key === "runSync")
              return (sql, ...params) => {
                if (/^ATTACH/i.test(sql)) throw new Error("unable to open database file");
                return value.call(target, sql, ...params);
              };
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
      release: (proxy) => env.release(proxy),
    });
    t.after(() => ctx.paths.setEngineEnv(null));
    change(ctx, db);
    const changed = liveHash(ctx, db);
    const changedFiles = mediaState(ctx);
    const error = await vaultError(() => restoreFrom(ctx, exported.file));
    assert.equal(error.code, "restoreFailed");
    assert.equal(fkOn(), 1);
    assert.equal(liveHash(ctx, db), changed);
    assert.deepEqual(mediaState(ctx), changedFiles);
    assert.deepEqual(leftovers(ctx), CLEAN);
  }
);

// ---------------------------------------------------------------------------------------------------------------
// G9 sequences

const isAutoincrement = (db, table) =>
  /\bAUTOINCREMENT\b/i.test(
    db.getFirstSync("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", [table])
      ?.sql ?? ""
  );

/** The id the next insert into `table` gets (inserted in a transaction that is rolled back). */
function nextId(db, table) {
  const copy = columnsOf(db, table).filter((c) => c !== "id" && c !== "sync_id");
  db.execSync("BEGIN");
  try {
    return db.runSync(
      `INSERT INTO ${q(table)} (${copy.map(q).join(", ")}) SELECT ${copy.map(q).join(", ")} FROM ${q(table)} LIMIT 1`
    ).lastInsertRowId;
  } finally {
    db.execSync("ROLLBACK");
  }
}

test(
  "G9 sequences: sqlite_sequence never decreases and takes the archive's high-water mark",
  { skip: vault.skip },
  async (t) => {
    const ctx = await seeded(t);
    const { db, app } = ctx;
    const table = app.tables.find(
      (x) =>
        x.mode === "replace" &&
        isAutoincrement(db, x.name) &&
        db.getFirstSync(`SELECT 1 AS v FROM ${q(x.name)} LIMIT 1`)
    );
    if (!table) {
      t.skip("no AUTOINCREMENT table in this app");
      return;
    }
    const setSequence = (n) =>
      db.runSync("UPDATE sqlite_sequence SET seq = ? WHERE name = ?", [n, table.name]);
    const sequence = () => sequences(db)[table.name];
    assert.ok(db.getFirstSync(`SELECT max(rowid) AS m FROM ${q(table.name)}`).m < 400);
    setSequence(500);
    const low = await exportTo(ctx, "g9-low.archive");
    assert.equal(low.manifest.tables.find((x) => x.name === table.name).sequence, 500);
    setSequence(900);
    await restoreFrom(ctx, low.file);
    assert.equal(sequence(), 900, "never lowered");
    assert.equal(nextId(db, table.name), 901);
    setSequence(950);
    const high = await exportTo(ctx, "g9-high.archive");
    setSequence(900);
    await restoreFrom(ctx, high.file);
    assert.equal(sequence(), 950, "the archive's high-water mark");
    assert.equal(nextId(db, table.name), 951);
    // A sequence row the live database lost is written again.
    db.runSync("DELETE FROM sqlite_sequence WHERE name = ?", [table.name]);
    await restoreFrom(ctx, high.file);
    assert.equal(sequence(), 950);
  }
);

test(
  "G9 sequences: a high-water mark beyond 2^53 − 1 is corrupt; one already live comes back into range and inserts work again",
  { skip: vault.skip },
  async (t) => {
    quiet(t);
    const ctx = await seeded(t);
    const { db, app } = ctx;
    const table = app.tables.find(
      (x) =>
        x.mode === "replace" &&
        isAutoincrement(db, x.name) &&
        db.getFirstSync(`SELECT 1 AS v FROM ${q(x.name)} LIMIT 1`)
    );
    if (!table) {
      t.skip("no AUTOINCREMENT table in this app");
      return;
    }
    const sequence = () => sequences(db)[table.name];
    const good = await exportTo(ctx, "g9-good.archive");
    const index = good.manifest.tables.findIndex((x) => x.name === table.name);
    const before = sequence();
    // An archive whose data hashes are intact and whose manifest claims an unreadable high-water mark.
    for (const [label, value] of [
      ["1e300", 1e300],
      ["int64", 2 ** 63],
    ]) {
      const hostile = rezip(ctx, good.file, `g9-${label}.archive`, (entries, manifest) => {
        manifest.tables[index].sequence = value;
      });
      const error = await vaultError(() => ctx.ops.runOpen(hostile));
      assert.deepEqual(
        [error.code, error.info.detail],
        ["corrupt", `manifest:tables[${index}].sequence`],
        label
      );
    }
    assert.equal(sequence(), before);
    assert.ok(nextId(db, table.name) > 0);

    // A live high-water mark out of range (no restore writes one any more) stops every insert…
    db.runSync("UPDATE sqlite_sequence SET seq = ? WHERE name = ?", [1e300, table.name]);
    assert.throws(() => nextId(db, table.name), /full/i);
    // …its export (and the recovery set of the next restore) writes the largest mark a reader takes…
    const exported = await exportTo(ctx, "g9-out-of-range.archive");
    assert.equal(
      exported.manifest.tables.find((x) => x.name === table.name).sequence,
      Number.MAX_SAFE_INTEGER
    );
    // …and a restore brings the table back into range.
    const result = await restoreFrom(ctx, good.file);
    assert.equal(sequence(), Number.MAX_SAFE_INTEGER);
    assert.equal(nextId(db, table.name), 2 ** 53);
    const { archive: undo } = await ctx.lock.exclusive(
      "inspect",
      () => ctx.recovery.openRecovery(result.recoveryId),
      { wait: true }
    );
    undo.close();
  }
);

// ---------------------------------------------------------------------------------------------------------------
// G10 device state

/** Reads and writes a keys-mode preference table. */
function keyStore(db, table) {
  const { keyColumn: k, valueColumn: v } = table.keys;
  return {
    get: (key) =>
      db.getFirstSync(`SELECT ${q(v)} AS v FROM ${q(table.name)} WHERE ${q(k)} = ?`, [key])?.v ??
      null,
    set: (key, value) =>
      value === null
        ? db.runSync(`DELETE FROM ${q(table.name)} WHERE ${q(k)} = ?`, [key])
        : db.runSync(
            `INSERT INTO ${q(table.name)} (${q(k)}, ${q(v)}) VALUES (?, ?) ON CONFLICT(${q(k)}) DO UPDATE SET ${q(v)} = excluded.${q(v)}`,
            [key, value]
          ),
  };
}

test(
  "G10 device state: key-universe keys replaced, other keys and device columns kept, overrides applied, Health off",
  { skip: vault.skip },
  async (t) => {
    const ctx = await seeded(t);
    const { db, app } = ctx;
    const keysTable = app.tables.find((x) => x.mode === "keys");
    const single = app.tables.find((x) => x.mode === "singleton");
    if (keysTable) {
      const prefs = keyStore(db, keysTable);
      const universe = keysTable.keys.include.find(
        (k) => !(keysTable.keys.provenance ?? []).includes(k) && prefs.get(k) !== null
      );
      const archived = prefs.get(universe);
      const exported = await exportTo(ctx, "g10.archive");
      prefs.set(universe, "g10-live");
      prefs.set("vaultG10Device", "kept");
      await restoreFrom(ctx, exported.file);
      assert.equal(
        prefs.get(universe),
        archived,
        "a key of the universe takes the archive's value"
      );
      assert.equal(prefs.get("vaultG10Device"), "kept", "a key outside it is untouched");
    }
    if (single) {
      const { idColumn, where } = single.singleton;
      const exported = await exportTo(ctx, "g10.archive");
      const columns = ctx.exporter.exportedColumns(db, single).filter((c) => c !== idColumn);
      const row = () => db.getFirstSync(`SELECT * FROM ${q(single.name)} WHERE ${where}`);
      const archived = row();
      // Device columns get live values that differ from the archive's; one exported column changes too.
      const device = {};
      for (const c of single.deviceColumns ?? [])
        device[c] = typeof archived[c] === "number" ? archived[c] + 1 : 1;
      const changed = columns.find((c) => typeof archived[c] === "number");
      db.runSync(
        `UPDATE ${q(single.name)} SET ${[...Object.keys(device), changed].map((c) => `${q(c)} = ?`).join(", ")} WHERE ${where}`,
        [...Object.values(device), archived[changed] + 1]
      );
      const live = row();
      await restoreFrom(ctx, exported.file);
      const after = row();
      for (const c of columns) assert.deepEqual(after[c], archived[c], `${c}: the archive's`);
      // A device column keeps the live value unless the descriptor's overrides set it.
      const overridden = new Set(
        app
          .deviceOverrides({ now: new Date() })
          .flatMap((s) => [...s.sql.matchAll(/(\w+) = /g)].map((m) => m[1]))
      );
      for (const c of single.deviceColumns ?? [])
        if (!overridden.has(c)) assert.deepEqual(after[c], live[c], `${c}: this device's`);
    }
    assert.equal(ctx.exporter.healthSyncOn(db), false, "Health sync is off after every restore");
    // Replace-mode device columns take their default on restored rows (water's synced_revision).
    for (const table of app.tables.filter((x) => x.mode === "replace" && x.deviceColumns?.length))
      for (const c of table.deviceColumns) {
        const dflt = db
          .getAllSync("SELECT name, dflt_value FROM pragma_table_info(?)", [table.name])
          .find((x) => x.name === c).dflt_value;
        const values = db
          .getAllSync(`SELECT DISTINCT ${q(c)} AS v FROM ${q(table.name)}`)
          .map((r) => String(r.v));
        assert.deepEqual(values, [String(dflt)], `${table.name}.${c}`);
      }
  }
);

test(
  "G10 installation rule: same device keeps the live one when the archive has none; another device gets a fresh one; lineage is the union",
  { skip: vault.skip },
  async (t) => {
    const ctx = await seeded(t);
    const { db, app } = ctx;
    const keysTable = app.tables.find(
      (x) => x.mode === "keys" && x.keys.include.includes("installation")
    );
    if (!app.health || !keysTable) {
      t.skip("no Health installation in this app");
      return;
    }
    const prefs = keyStore(db, keysTable);
    const archivedList = JSON.parse(prefs.get("healthInstallations"));
    prefs.set("installation", null);
    const exported = await exportTo(ctx, "g10-installation.archive");
    prefs.set("installation", "1790000000000-liveinst");
    prefs.set("healthInstallations", JSON.stringify(["1780000000000-liveold"]));
    await restoreFrom(ctx, exported.file);
    assert.equal(prefs.get("installation"), "1790000000000-liveinst", "kept: the archive has none");
    assert.deepEqual(
      JSON.parse(prefs.get("healthInstallations")),
      [...new Set([...archivedList, "1780000000000-liveold", "1790000000000-liveinst"])].sort()
    );

    const other = await open(t);
    const otherDb = await other.w.live();
    const otherPrefs = keyStore(otherDb, keysTable);
    otherPrefs.set("installation", "1791000000000-otherinst");
    otherPrefs.set("healthInstallations", JSON.stringify(["1781000000000-otherold"]));
    const withInstallation = await exportTo(ctx, "g10-with.archive");
    const archivedInstallation = prefs.get("installation");
    const result = await restoreFrom(
      other,
      carry(ctx, other, withInstallation.file, "g10.archive")
    );
    const fresh = otherPrefs.get("installation");
    assert.match(fresh, /^\d+-[a-z0-9]+$/);
    assert.ok(
      ![archivedInstallation, "1791000000000-otherinst"].includes(fresh),
      "a fresh installation for records created from now on"
    );
    assert.deepEqual(
      JSON.parse(otherPrefs.get("healthInstallations")),
      [
        ...new Set([
          ...JSON.parse(prefs.get("healthInstallations")),
          archivedInstallation,
          "1781000000000-otherold",
          "1791000000000-otherinst",
        ]),
      ].sort()
    );
    assert.equal(result.libraryId, withInstallation.manifest.library.id);
  }
);

// ---------------------------------------------------------------------------------------------------------------
// G11 recovery sets

test(
  "G11 recovery sets: two kept, recovery.latest is an id, partial sets ignored, the latest brings back the state before",
  { skip: vault.skip },
  async (t) => {
    const ctx = await seeded(t);
    const { db, app, w } = ctx;
    const exported = await exportTo(ctx, "g11.archive");
    const ids = [];
    for (let i = 0; i < 2; i++) {
      change(ctx, db);
      ids.push((await restoreFrom(ctx, exported.file)).recoveryId);
    }
    const changed = change(ctx, db);
    const before = dump(ctx, db);
    const files = mediaState(ctx);
    ids.push((await restoreFrom(ctx, exported.file)).recoveryId);
    assert.ok(ids.every((id) => RECOVERY_ID.test(id)));
    assert.deepEqual([...ids].sort(), ids, "ids follow creation order");
    assert.equal(new Set(ids).size, 3);
    assert.deepEqual(recoverySets(ctx), ids.slice(1), "the newest two");
    assert.equal(ctx.state.readState(db, "recovery.latest"), ids[2]);
    // A partial set (newer than all) is never offered and never counted by retention.
    fs.mkdirSync(w.file("PendumVault", "recovery", "29991231T235959Z-zzzz.partial"), {
      recursive: true,
    });
    assert.equal(ctx.recovery.latestRecovery().id, ids[2]);
    ctx.recovery.pruneRecoverySets(ids[2]);
    assert.deepEqual(recoverySets(ctx), ids.slice(1));
    assert.ok(fs.existsSync(w.file("PendumVault", "recovery", "29991231T235959Z-zzzz.partial")));

    // "Export this copy": a self-contained manual archive.
    fs.mkdirSync(w.file("out"), { recursive: true });
    const copy = await ctx.recovery.exportRecovery(
      ids[2],
      new ctx.File(w.uri("out", "copy.archive"))
    );
    assert.deepEqual(await ctx.inspect.verifyArchive(copy), { ok: true, problems: [] });

    // Undo: the latest set brings back the rows of before the third restore and the photo it displaced.
    const { archive, media } = await ctx.lock.exclusive(
      "inspect",
      () => ctx.recovery.openRecovery(ids[2]),
      { wait: true }
    );
    assert.equal(archive.preview.kind, "pre-restore");
    const undo = await ctx.ops.runRestore(archive, { reason: "recovery", media });
    archive.close();
    const after = dump(ctx, db);
    if (app.id === "water") {
      // water's swap carry (spec §4.5) keeps every drink the set lacks, tombstones included, as a hidden tombstone, so
      // the reconnect backfill can delete its Health samples (the drink `change` removed came back with the archive).
      const kept = new Set(before.drinks.map((r) => r.id));
      const carried = after.drinks.filter((r) => !kept.has(r.id));
      assert.ok(
        carried.every((r) => r.deleted === 1),
        "the set's rows, plus hidden tombstones at most"
      );
      after.drinks = after.drinks.filter((r) => kept.has(r.id));
    }
    assert.deepEqual(after, before);
    const now = mediaState(ctx);
    for (const [set, names] of Object.entries(files))
      for (const [name, hash] of Object.entries(names)) assert.equal(now[set][name], hash, name);
    if (changed.added)
      assert.equal(now[app.media[0].set][changed.added], files[app.media[0].set][changed.added]);
    // Undoing made a set of its own (undo of the undo), and retention kept two.
    assert.deepEqual(recoverySets(ctx), [ids[2], undo.recoveryId]);
    assert.deepEqual(leftovers(ctx), CLEAN);
    const listed = await ctx.inspect.openArchive(copy);
    assert.equal(listed.manifest.kind, "manual");
    assert.ok(listed.manifest.media.every((m) => m.embedded));
    listed.close();
  }
);

test(
  "G11 empty library: no recovery set, no undo, preview.liveEmpty (water counters + tombstone, lift default gym)",
  { skip: vault.skip },
  async (t) => {
    const source = await seeded(t);
    const exported = await exportTo(source, "g11-empty.archive");
    const ctx = await open(t);
    const db = await ctx.w.live();
    ctx.w.fresh(db);
    if (ctx.app.id === "water")
      db.runSync(
        "INSERT INTO drinks (id, kind, volume_ml, consumed_at, updated_at, deleted) VALUES ('tombstoned', 'water', 250, 0, 0, 1)"
      );
    const archive = await ctx.ops.runOpen(carry(source, ctx, exported.file, "g11.archive"));
    assert.equal(archive.preview.liveEmpty, true);
    const result = await ctx.ops.runRestore(archive, { reason: "file" });
    archive.close();
    assert.equal(result.recoveryId, null);
    assert.deepEqual(recoverySets(ctx), []);
    assert.equal(ctx.state.readState(db, "recovery.latest"), null);
    assert.equal(ctx.recovery.latestRecovery(db), null);
    assert.deepEqual(leftovers(ctx), CLEAN);
    assert.equal(ctx.ready.libraryEmpty(db), false);
  }
);

// ---------------------------------------------------------------------------------------------------------------
// G16 media

test(
  "G16 media: a live photo the archive lacks is kept while restored rows name it; peerNotReady only for items no source has",
  { skip: vault.skip },
  async (t) => {
    quiet(t);
    const ctx = await seeded(t);
    const { db, app, w } = ctx;
    const set = app.media?.[0];
    if (!set) {
      t.skip("no media in this app");
      return;
    }
    const [name] = ctx.exporter.referencedMedia(db, set);
    const file = w.file(set.directory, name);
    const bytes = fs.readFileSync(file);
    // The writer lacked the file (a phone restored from Android cloud Auto Backup): listed in missingMedia.
    fs.rmSync(file);
    const missing = await exportTo(ctx, "g16-missing.archive");
    fs.writeFileSync(file, bytes);
    assert.deepEqual(missing.manifest.missingMedia, [{ set: set.set, name }]);
    const kept = await restoreFrom(ctx, missing.file);
    assert.equal(kept.mediaKeptLive, 1);
    assert.ok(fs.readFileSync(file).equals(bytes), "kept in place");
    assert.ok(
      !fs.existsSync(w.file("PendumVault", "recovery", kept.recoveryId, "media", set.set, name)),
      "not moved into the recovery set"
    );
    // Absent from the manifest altogether: the same.
    const absent = rezip(ctx, missing.file, "g16-absent.archive", (entries, manifest) => {
      delete manifest.missingMedia;
    });
    assert.equal((await restoreFrom(ctx, absent)).mediaKeptLive, 1);
    assert.ok(fs.readFileSync(file).equals(bytes));
    // requireAllMedia without a live file: a name in missingMedia is skipped and counted (waiting cannot help)…
    fs.rmSync(file);
    const skipped = await restoreFrom(ctx, missing.file, { requireAllMedia: true });
    assert.equal(skipped.mediaSkipped, 1);
    assert.equal(fs.existsSync(file), false);
    // …but a manifest item no source can supply yet fails peerNotReady before anything changes.
    fs.writeFileSync(file, bytes);
    const auto = await exportTo(ctx, "g16-auto.archive", {
      kind: "auto",
      embedMedia: false,
      deflateLevel: 1,
    });
    fs.rmSync(file);
    const hash = liveHash(ctx, db);
    const files = mediaState(ctx);
    const error = await vaultError(() => restoreFrom(ctx, auto.file, { requireAllMedia: true }));
    assert.equal(error.code, "peerNotReady");
    assert.equal(liveHash(ctx, db), hash);
    assert.deepEqual(mediaState(ctx), files);
    assert.deepEqual(leftovers(ctx), CLEAN);
    // Without requireAllMedia the photo is skipped; a MediaSource that has it supplies a verified copy.
    assert.equal((await restoreFrom(ctx, auto.file)).mediaSkipped, 1);
    const fetched = [];
    const source = {
      fetch: async (item, dest) => {
        fetched.push(item.name);
        if (item.name !== name) return false;
        fs.writeFileSync(ctx.paths.fsPath(dest), bytes);
        return true;
      },
    };
    const supplied = await restoreFrom(ctx, auto.file, { media: source, requireAllMedia: true });
    assert.deepEqual([supplied.mediaRestored, supplied.mediaSkipped], [1, 0]);
    assert.deepEqual(fetched, [name]);
    assert.ok(fs.readFileSync(file).equals(bytes));
    // A source whose copy does not match the manifest's hash supplies nothing.
    fs.rmSync(file);
    const wrong = {
      fetch: async (item, dest) => {
        fs.writeFileSync(ctx.paths.fsPath(dest), "not the photo");
        return true;
      },
    };
    assert.equal((await restoreFrom(ctx, auto.file, { media: wrong })).mediaSkipped, 1);
    assert.equal(fs.existsSync(file), false);
  }
);

// ---------------------------------------------------------------------------------------------------------------
// G18 repairs and validators on restore

test(
  "G18 repair: CASCADE deletes, SET NULL nulls, SET DEFAULT defaults, NO ACTION fails invalidData; kept parents wait for the swap",
  { skip: vault.skip },
  async (t) => {
    const ctx = await open(t);
    const db = ctx.w.open("g18.db", { useNewConnection: true });
    db.execSync(`CREATE TABLE p (id INTEGER PRIMARY KEY);
      CREATE TABLE c1 (id INTEGER PRIMARY KEY, p INTEGER REFERENCES p(id) ON DELETE CASCADE);
      CREATE TABLE g1 (id INTEGER PRIMARY KEY, c INTEGER REFERENCES c1(id) ON DELETE CASCADE);
      CREATE TABLE c2 (id INTEGER PRIMARY KEY, p INTEGER REFERENCES p(id) ON DELETE SET NULL);
      CREATE TABLE c3 (id INTEGER PRIMARY KEY, p INTEGER DEFAULT 1 REFERENCES p(id) ON DELETE SET DEFAULT);
      CREATE TABLE c4 (id INTEGER PRIMARY KEY, p INTEGER REFERENCES p(id));
      INSERT INTO p VALUES (1);
      INSERT INTO c1 VALUES (1, 1), (2, 99);
      INSERT INTO g1 VALUES (1, 2), (2, 1);
      INSERT INTO c2 VALUES (1, 98), (2, 1);
      INSERT INTO c3 VALUES (1, 97);`);
    const repairs = ctx.scratch.repairForeignKeys(db);
    assert.deepEqual(repairs.map((r) => `${r.table} ${r.message} ${r.fatal}`).sort(), [
      "c1 fk:cascade false",
      "c2 fk:set null false",
      "c3 fk:set default false",
      "g1 fk:cascade false",
    ]);
    assert.deepEqual(db.getAllSync("SELECT id FROM c1"), [{ id: 1 }]);
    assert.deepEqual(db.getAllSync("SELECT id FROM g1"), [{ id: 2 }], "the grandchild, next pass");
    assert.deepEqual(db.getAllSync("SELECT id, p FROM c2 ORDER BY id"), [
      { id: 1, p: null },
      { id: 2, p: 1 },
    ]);
    assert.deepEqual(db.getAllSync("SELECT p FROM c3"), [{ p: 1 }]);
    assert.deepEqual(db.getAllSync("PRAGMA foreign_key_check"), []);
    db.execSync("INSERT INTO c4 VALUES (1, 96)");
    const error = await vaultError(() => ctx.scratch.repairForeignKeys(db));
    assert.deepEqual([error.code, error.info.detail], ["invalidData", "c4"]);
    // A parent the restore keeps as on device is empty in the scratch: its orphans wait for the final check.
    assert.deepEqual(ctx.scratch.repairForeignKeys(db, new Set(["p"])), []);
    assert.equal(db.getFirstSync("SELECT count(*) AS n FROM c4").n, 1);
  }
);

/** Data each app's validators report as fatal (the descriptor's own rules, spec §4.2–§4.5). */
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
  "G18 restore: orphans in an archive are repaired and reported; a fatal validator issue fails invalidData and changes nothing",
  { skip: vault.skip },
  async (t) => {
    quiet(t);
    const ctx = await seeded(t);
    const { db, app } = ctx;
    const names = app.tables.map((x) => x.name);
    // Orphans of each repairable kind in the archive (apps whose tables declare foreign keys: lift).
    const orphans = [];
    for (const action of ["CASCADE", "SET NULL"])
      for (const x of app.tables) {
        const fk = db
          .getAllSync("SELECT * FROM pragma_foreign_key_list(?)", [x.name])
          .find((k) => names.includes(k.table) && k.on_delete.toUpperCase() === action);
        const row = fk
          ? db.getFirstSync(
              `SELECT rowid AS r FROM ${q(x.name)} WHERE ${q(fk.from)} IS NOT NULL ORDER BY rowid DESC LIMIT 1`
            )
          : null;
        if (!row || orphans.some((o) => o.table === x.name)) continue;
        orphans.push({ table: x.name, column: fk.from, rowid: row.r, action });
        break;
      }
    const fkOn = db.getFirstSync("PRAGMA foreign_keys").foreign_keys;
    db.execSync("PRAGMA foreign_keys = OFF");
    for (const o of orphans)
      db.runSync(`UPDATE ${q(o.table)} SET ${q(o.column)} = -424242 WHERE rowid = ?`, [o.rowid]);
    db.execSync(`PRAGMA foreign_keys = ${fkOn ? "ON" : "OFF"}`);
    const orphaned = await exportTo(ctx, "g18-orphans.archive");
    assert.equal(orphaned.warnings.filter((x) => x.message === "fk").length, orphans.length);
    const result = await restoreFrom(ctx, orphaned.file);
    for (const o of orphans) {
      const row = db.getFirstSync(`SELECT ${q(o.column)} AS v FROM ${q(o.table)} WHERE rowid = ?`, [
        o.rowid,
      ]);
      if (o.action === "CASCADE") assert.equal(row, null, `${o.table}: deleted`);
      else assert.equal(row.v, null, `${o.table}: cleared`);
      assert.ok(
        result.repairs.some(
          (r) => r.table === o.table && r.message === `fk:${o.action.toLowerCase()}` && !r.fatal
        ),
        JSON.stringify(result.repairs)
      );
    }
    assert.deepEqual(db.getAllSync("PRAGMA foreign_key_check"), []);

    // A fatal validator issue in the archive: invalidData, nothing changed.
    const invalid = INVALID[app.id];
    if (!invalid || !app.validate) return;
    db.execSync(invalid.sql);
    const bad = await exportTo(ctx, "g18-invalid.archive");
    assert.ok(bad.warnings.some((x) => x.table === invalid.table && x.fatal));
    change(ctx, db);
    const hash = liveHash(ctx, db);
    const files = mediaState(ctx);
    const error = await vaultError(() => restoreFrom(ctx, bad.file));
    assert.deepEqual([error.code, error.info.detail], ["invalidData", invalid.table]);
    assert.equal(liveHash(ctx, db), hash);
    assert.deepEqual(mediaState(ctx), files);
    assert.deepEqual(leftovers(ctx), CLEAN);
  }
);

// ---------------------------------------------------------------------------------------------------------------
// G19 table presence

test(
  "G19 table presence: a table the archive lacks keeps its live rows (and its photos); one created after the archive is emptied",
  { skip: vault.skip },
  async (t) => {
    const ctx = await seeded(t);
    const { db, app, w } = ctx;
    const exported = await exportTo(ctx, "g19.archive");
    const archived = dump(ctx, db);
    // A table nothing references: the media table where there is one, else the last plain replace table.
    const referenced = new Set(
      app.tables.flatMap((x) =>
        db.getAllSync("SELECT * FROM pragma_foreign_key_list(?)", [x.name]).map((k) => k.table)
      )
    );
    const leaf =
      app.media?.[0]?.table ??
      [...app.tables]
        .reverse()
        .find(
          (x) =>
            x.mode === "replace" &&
            x.role !== "provenance" &&
            !x.deviceColumns?.length &&
            !referenced.has(x.name)
        ).name;
    const partial = withoutTable(ctx, exported.file, "g19-partial.archive", leaf);
    change(ctx, db);
    // The live rows of that table differ from the archive's: a number changed, else a row deleted.
    const number = db
      .getAllSync("SELECT name, type, pk FROM pragma_table_info(?)", [leaf])
      .find((c) => !c.pk && /INT|REAL/i.test(c.type) && c.name !== "sync_id");
    const first = `rowid = (SELECT min(rowid) FROM ${q(leaf)})`;
    if (number)
      db.runSync(`UPDATE ${q(leaf)} SET ${q(number.name)} = ${q(number.name)} + 1 WHERE ${first}`);
    else db.runSync(`DELETE FROM ${q(leaf)} WHERE ${first}`);
    const kept = db.getAllSync(`SELECT * FROM ${q(leaf)} ORDER BY rowid`);
    assert.notDeepEqual(kept, archived[leaf]);
    const files = mediaState(ctx);
    const result = await restoreFrom(ctx, partial);
    assert.deepEqual(
      db.getAllSync(`SELECT * FROM ${q(leaf)} ORDER BY rowid`),
      kept,
      "kept as on device"
    );
    const others = app.tables.map((x) => x.name).filter((n) => n !== leaf);
    assert.deepEqual(
      dump(ctx, db, { tables: others }),
      Object.fromEntries(others.map((n) => [n, archived[n]])),
      "every other table is the archive's"
    );
    // No media plan for a table the restore keeps: live photos stay, nothing staged or displaced.
    assert.deepEqual(mediaState(ctx), files);
    assert.deepEqual([result.mediaRestored, result.mediaSkipped, result.mediaKeptLive], [0, 0, 0]);

    // A table the archive's schema level did not have yet (a later migration created it) is replaced: emptied.
    const journal = app.migrations.journal;
    const last = journal.entries.at(-1);
    const next = journal.entries.length;
    app.migrations = {
      journal: {
        ...journal,
        entries: [
          ...journal.entries,
          { idx: next, when: last.when + 1000, tag: `${next}_vault_g19`, breakpoints: true },
        ],
      },
      migrations: {
        ...app.migrations.migrations,
        [`m${String(next).padStart(4, "0")}`]:
          "CREATE TABLE `vault_g19` (`id` integer PRIMARY KEY NOT NULL, `note` text NOT NULL);",
      },
    };
    app.tables = [...app.tables, { name: "vault_g19", mode: "replace", role: "data" }];
    const { drizzle } = w.require("drizzle-orm/expo-sqlite");
    const { migrate } = w.require("drizzle-orm/expo-sqlite/migrator");
    await migrate(drizzle(db), app.migrations);
    db.runSync("INSERT INTO vault_g19 (id, note) VALUES (1, 'made after the archive')");
    await restoreFrom(ctx, exported.file);
    assert.deepEqual(db.getAllSync("SELECT * FROM vault_g19"), []);
  }
);

test(
  "G19 table presence: a kept parent whose rows the restored children need fails unknownSchema and changes nothing",
  { skip: vault.skip },
  async (t) => {
    quiet(t);
    const ctx = await seeded(t);
    const { db } = ctx;
    const child = cascadingChild(ctx, db);
    if (!child) {
      t.skip("no foreign keys between this app's tables");
      return;
    }
    const exported = await exportTo(ctx, "g19-parent.archive");
    const partial = withoutTable(ctx, exported.file, "g19-no-parent.archive", child.parent);
    // Kept as on device, and the device lacks a row the archive's children reference.
    const referenced = db.getFirstSync(
      `SELECT ${q(db.getAllSync("SELECT * FROM pragma_foreign_key_list(?)", [child.table]).find((k) => k.table === child.parent).from)} AS v FROM ${q(child.table)} LIMIT 1`
    ).v;
    const fkOn = db.getFirstSync("PRAGMA foreign_keys").foreign_keys;
    db.execSync("PRAGMA foreign_keys = OFF");
    db.runSync(`DELETE FROM ${q(child.parent)} WHERE "id" = ?`, [referenced]);
    db.execSync(`PRAGMA foreign_keys = ${fkOn ? "ON" : "OFF"}`);
    const hash = liveHash(ctx, db);
    const error = await vaultError(() => restoreFrom(ctx, partial));
    assert.equal(error.code, "unknownSchema");
    assert.equal(liveHash(ctx, db), hash);
    assert.deepEqual(leftovers(ctx), CLEAN);
  }
);

// ---------------------------------------------------------------------------------------------------------------
// G20 another connection writes during the commit section (water's other connections)

/** A write another connection makes to an exported value: a keys-mode key of the universe, or the singleton row. */
function probeWriter(ctx) {
  const keysTable = ctx.app.tables.find((x) => x.mode === "keys");
  if (keysTable) {
    const key = keysTable.keys.include.find((k) => !(keysTable.keys.provenance ?? []).includes(k));
    return {
      table: keysTable.name,
      write: (conn, value) => keyStore(conn, keysTable).set(key, value),
      find: (rows) =>
        rows.find((r) => r[keysTable.keys.keyColumn] === key)?.[keysTable.keys.valueColumn],
    };
  }
  const single = ctx.app.tables.find((x) => x.mode === "singleton");
  const db = ctx.db;
  const column = ctx.exporter.exportedColumns(db, single).find(
    (c) =>
      c !== single.singleton.idColumn &&
      db
        .getAllSync("SELECT name, type FROM pragma_table_info(?)", [single.name])
        .find((x) => x.name === c)
        .type.toUpperCase() === "TEXT"
  );
  return {
    table: single.name,
    write: (conn, value) =>
      conn.runSync(
        `UPDATE ${q(single.name)} SET ${q(column)} = ? WHERE ${single.singleton.where}`,
        [value]
      ),
    find: (rows) => rows[0]?.[column],
  };
}

/** Runs `write` on another connection before the swap's BEGIN IMMEDIATE (the vault connection has `incoming`). */
function beforeSwap(ctx, write) {
  const other = ctx.w.open(ctx.app.database.name, { useNewConnection: true });
  let attempts = 0;
  const stop = ctx.w.onBeforeBegin((conn, sql) => {
    if (!/^\s*BEGIN IMMEDIATE/i.test(sql)) return;
    if (!conn.getAllSync("PRAGMA database_list").some((d) => d.name === "incoming")) return;
    attempts++;
    write(other, attempts);
  });
  return {
    attempts: () => attempts,
    stop: () => {
      stop();
      other.closeSync();
    },
  };
}

test(
  "G20 concurrent writer: a commit by another connection after the recovery snapshot retries the commit section; three times → busy",
  { skip: vault.skip },
  async (t) => {
    const warnings = quiet(t);
    const ctx = await seeded(t);
    const { db, w } = ctx;
    const exported = await exportTo(ctx, "g20.archive");
    const probe = probeWriter(ctx);
    change(ctx, db);
    const once = beforeSwap(ctx, (other, attempt) => {
      if (attempt === 1) probe.write(other, "g20-written-meanwhile");
    });
    const result = await restoreFrom(ctx, exported.file);
    once.stop();
    assert.equal(once.attempts(), 2, "retried once");
    assert.match(result.recoveryId, RECOVERY_ID);
    // The write made between the snapshot and the transaction is in the recovery set (the retry's snapshot).
    const { unzipSync } = w.require("fflate");
    const set = unzipSync(
      new Uint8Array(
        fs.readFileSync(
          w.file(
            "PendumVault",
            "recovery",
            result.recoveryId,
            `data.${w.require("@/vault/app").vaultIdentity.extension}`
          )
        )
      )
    );
    const lines = Buffer.from(set[`data/${probe.table}.ndjson`])
      .toString("utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(probe.find(lines), "g20-written-meanwhile");
    assert.deepEqual(leftovers(ctx), CLEAN);
    assert.deepEqual(recoverySets(ctx), [result.recoveryId]);

    // A writer that never stops: three attempts, then busy; every attempt undone.
    change(ctx, db);
    const files = mediaState(ctx);
    const rows = dump(ctx, db, {
      tables: ctx.app.tables.map((x) => x.name).filter((n) => n !== probe.table),
    });
    const always = beforeSwap(ctx, (other, attempt) => probe.write(other, `g20-${attempt}`));
    const error = await vaultError(() => restoreFrom(ctx, exported.file));
    always.stop();
    assert.deepEqual([error.code, error.info.detail], ["busy", "writer"]);
    assert.equal(always.attempts(), 3);
    assert.deepEqual(dump(ctx, db, { tables: Object.keys(rows) }), rows);
    assert.deepEqual(mediaState(ctx), files);
    assert.deepEqual(leftovers(ctx), CLEAN);
    assert.deepEqual(recoverySets(ctx), [result.recoveryId], "no set of the failed attempts");
    assert.ok(warnings.some((x) => x[1] === "busy"));
  }
);

// ---------------------------------------------------------------------------------------------------------------
// G21b sync ids through a restore

test(
  "G21b sync ids: an archive without them gets fresh ones; a legacy restore fills them",
  { skip: vault.skip },
  async (t) => {
    const ctx = await seeded(t);
    const { db, app, w } = ctx;
    const tables = app.syncIdTables ?? [];
    const ids = (conn, table) =>
      conn.getAllSync(`SELECT sync_id FROM ${q(table)} ORDER BY rowid`).map((r) => r.sync_id);
    const before = Object.fromEntries(tables.map((x) => [x, ids(db, x)]));
    const exported = await exportTo(ctx, "g21b.archive");
    // Written by a vault without sync ids: no column, no vaultColumns.
    const bare = rezip(ctx, exported.file, "g21b-bare.archive", (entries, manifest) => {
      for (const table of manifest.tables) {
        const at = table.columns.indexOf("sync_id");
        if (at < 0) continue;
        table.columns.splice(at, 1);
        const text = Buffer.from(entries[table.file])
          .toString("utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const row = JSON.parse(line);
            delete row.sync_id;
            return `${JSON.stringify(row)}\n`;
          })
          .join("");
        entries[table.file] = new Uint8Array(Buffer.from(text, "utf8"));
        table.bytes = entries[table.file].length;
        table.sha256 = sha256(entries[table.file]);
      }
      delete manifest.vaultColumns;
    });
    await restoreFrom(ctx, bare);
    for (const table of tables) {
      const now = ids(db, table);
      assert.equal(now.length, before[table].length, table);
      assert.ok(
        now.every((id) => UUID_V4.test(id)),
        `${table}: v4`
      );
      assert.equal(new Set(now).size, now.length, `${table}: unique`);
      assert.ok(
        now.every((id) => !before[table].includes(id)),
        `${table}: fresh`
      );
    }
    // Restoring the archive with sync ids brings the archived ones back.
    await restoreFrom(ctx, exported.file);
    for (const table of tables) assert.deepEqual(ids(db, table), before[table], table);

    // A legacy v1 file: the adapter writes into a scratch at the current level, and the scratch gets the same
    // sync_id columns as the live tables (the swap's column lists would otherwise name a missing column).
    const table = app.tables.find((x) => x.mode === "replace" && x.role === "data");
    const replaced = table.name;
    const columns = columnsOf(db, replaced).filter(
      (c) => c !== "sync_id" && !(table.deviceColumns ?? []).includes(c)
    );
    const rows = db.getAllSync(
      `SELECT ${columns.map(q).join(", ")} FROM ${q(replaced)} ORDER BY rowid LIMIT 2`
    );
    app.legacy = {
      formats: { plain: "vault-test-backup", encrypted: "vault-test-encrypted-backup" },
      maxBytes: 1024 * 1024,
      decrypt: async (text) => text,
      parse: (text) => JSON.parse(text),
      createdAt: (parsed) => parsed.createdAt,
      counts: () => ({}),
      tables: [{ name: replaced }],
      preferenceKeys: [],
      write(scratch, parsed) {
        scratch.withTransactionSync(() => {
          for (const row of parsed.rows)
            scratch.runSync(
              `INSERT INTO ${q(replaced)} (${columns.map(q).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
              columns.map((c) => row[c])
            );
        });
      },
      overrides: () => [],
      recoveryCopy: () => null,
    };
    ctx.inspect.setLegacyOpener(async (source) => {
      const parsed = JSON.parse(fs.readFileSync(ctx.paths.fsPath(source), "utf8"));
      return { parsed, createdAt: parsed.createdAt, counts: {} };
    });
    t.after(() => ctx.inspect.setLegacyOpener(null));
    fs.writeFileSync(
      w.file("out", "legacy.json"),
      JSON.stringify({ format: "vault-test-backup", createdAt: "2026-09-01T00:00:00.000Z", rows })
    );
    // The made-up v1 file holds one table; the app's validators expect a whole library.
    app.validate = undefined;
    const archive = await ctx.ops.runOpen(new ctx.File(w.uri("out", "legacy.json")));
    assert.equal(archive.format, "legacy");
    const result = await ctx.ops.runRestore(archive, { reason: "file" });
    archive.close();
    assert.equal(result.libraryId, ctx.state.readState(db, "library.id"), "the library stays");
    const restored = db.getAllSync(
      `SELECT ${columns.map(q).join(", ")} FROM ${q(replaced)} ORDER BY rowid`
    );
    // (water's swap hook adds a tombstone for every drink the file lacks)
    assert.deepEqual(
      restored.filter((r) => rows.some((x) => x[columns[0]] === r[columns[0]])),
      rows
    );
    if (tables.includes(replaced)) assert.ok(ids(db, replaced).every((id) => UUID_V4.test(id)));
  }
);

// ---------------------------------------------------------------------------------------------------------------
// G23 Health provenance

/** health_links rows by key, without the key. */
const linksOf = (db) =>
  Object.fromEntries(
    db
      .getAllSync(
        'SELECT "key", "local_kind", "local_id", "remote_id", "fingerprint", "origin" FROM health_links ORDER BY "key"'
      )
      .map(({ key, ...link }) => [key, link])
  );

const link = (db, key, kind, localId, remoteId, fingerprint, origin) =>
  db.runSync(
    'INSERT INTO health_links ("key", "local_kind", "local_id", "remote_id", "fingerprint", "origin") VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT("key") DO UPDATE SET "local_kind" = excluded."local_kind", "local_id" = excluded."local_id", "remote_id" = excluded."remote_id", "fingerprint" = excluded."fingerprint", "origin" = excluded."origin"',
    [key, kind, localId, remoteId, fingerprint, origin]
  );

test(
  "G23 provenance merge: keys both sides know take the live state (B), live-only links are carried (A), import tombstones stay (C)",
  { skip: vault.skip },
  async (t) => {
    const ctx = await seeded(t);
    const { db, app } = ctx;
    if (!app.health) {
      t.skip("no Health links in this app");
      return;
    }
    const [kind, table] = Object.entries(app.health.rowTables)[0];
    const [first, second] = db
      .getAllSync(`SELECT "id" FROM ${q(table)} ORDER BY "id" LIMIT 2`)
      .map((r) => r.id);
    // The archive's links.
    link(db, "vault:both", kind, first, "R-arch-both", "arch", "local");
    link(db, "vault:arch-empty", kind, 9001, "", "", "local");
    link(db, "vault:covered", kind, second, "R-arch-covered", "arch", "local");
    link(db, "vault:arch-wins", kind, first, "R-aw", "aw", "local");
    const exported = await exportTo(ctx, "g23.archive");
    const archived = linksOf(db);
    // This device's links since.
    db.runSync(
      "DELETE FROM health_links WHERE key IN ('vault:arch-empty', 'vault:covered', 'vault:arch-wins')"
    );
    link(db, "vault:both", kind, first, "R-live-both", "live", "local");
    link(db, "vault:live-verbatim", kind, 8001, "R-lv", "lv", "local");
    link(db, "vault:live-covered", kind, second, "R-lc", "lc", "local");
    link(db, "vault:live-same-remote", kind, 8002, "R-arch-covered", "lsr", "local");
    link(db, "vault:live-empty-remote", kind, 8003, "", "", "local");
    link(db, "vault:live-deleted", kind, 8006, "R-ld", "deleted", "local");
    link(db, "vault:live-tombstone", kind, 8004, "R-lt", "lt", "health");
    link(db, "vault:arch-wins", kind, 8005, "R-aw-live", "aw-live", "health");
    link(db, "vault:live-import", kind, first, "R-li", "li", "health");
    await restoreFrom(ctx, exported.file);
    const after = linksOf(db);
    const local = (localId, remoteId, fingerprint, origin = "local") => ({
      local_kind: kind,
      local_id: localId,
      remote_id: remoteId,
      fingerprint,
      origin,
    });
    // B: a key both sides know takes this store's remote id and fingerprint.
    assert.deepEqual(after["vault:both"], local(first, "R-live-both", "live"));
    // A: live-only local links — verbatim; covered by an archive link of the same record → local_id -1; never
    // when an archive link holds the same remote id; an empty remote id never blocks; local tombstones are carried
    // by the same rule (vault 1.0.2).
    assert.deepEqual(after["vault:live-verbatim"], local(8001, "R-lv", "lv"));
    assert.deepEqual(after["vault:live-covered"], local(-1, "R-lc", "lc"));
    assert.equal(after["vault:live-same-remote"], undefined);
    assert.deepEqual(after["vault:live-empty-remote"], local(8003, "", ""));
    assert.deepEqual(after["vault:live-deleted"], local(8006, "R-ld", "deleted"));
    // C: an import whose row is gone stays deleted (-1); an import whose row exists is imported again later.
    assert.deepEqual(after["vault:live-tombstone"], local(-1, "R-lt", "lt", "health"));
    assert.equal(after["vault:live-import"], undefined);
    // The archive's own links, the key the archive has over a live import tombstone included.
    for (const key of ["vault:arch-empty", "vault:covered", "vault:arch-wins"])
      assert.deepEqual(after[key], archived[key], key);
    for (const [key, value] of Object.entries(archived))
      if (!key.startsWith("vault:")) assert.deepEqual(after[key], value, key);
  }
);

test(
  "G23 provenance merge: an archive import at an id where this device has its own exported row covers that row (A, any origin), on every kind of restore",
  { skip: vault.skip },
  async (t) => {
    const source = await seeded(t, { platform: "ios" });
    if (!source.app.health) {
      t.skip("no Health links in this app");
      return;
    }
    const [kind, table] = Object.entries(source.app.health.rowTables)[0];
    const [first, second] = source.db
      .getAllSync(`SELECT "id" FROM ${q(table)} ORDER BY "id" LIMIT 2`)
      .map((r) => r.id);
    const unlink = (db, id) =>
      db.runSync('DELETE FROM health_links WHERE "local_kind" = ? AND "local_id" = ?', [kind, id]);
    // The archive: row `first` is a Health import (a scale reading, never exported), row `second` has no link.
    unlink(source.db, first);
    unlink(source.db, second);
    link(
      source.db,
      "health:vault-scale",
      kind,
      first,
      "R-scale",
      "90:2026-09-01T06:00:00.000Z",
      "health"
    );
    const exported = await exportTo(source, "g23-import.archive");
    const archivedImport = linksOf(source.db)["health:vault-scale"];

    /** This device's own rows at both ids, typed here and exported to its Health store. */
    const own = (db) => {
      link(db, "vault:own-first", kind, first, "R-own-first", "own-first", "local");
      link(db, "vault:own-second", kind, second, "R-own-second", "own-second", "local");
    };
    const ownLink = (localId, name) => ({
      local_kind: kind,
      local_id: localId,
      remote_id: `R-${name}`,
      fingerprint: name,
      origin: "local",
    });
    const check = (db, label) => {
      const after = linksOf(db);
      // The restored row `first` is the import, which no sync exports: this device's sample of its own row there
      // has no record left, so the next sync removes it (-1). Before, it kept local_id `first` and stayed in Health.
      assert.deepEqual(after["vault:own-first"], ownLink(-1, "own-first"), label);
      // No archive link at `second`: the restored row is upserted into this device's sample.
      assert.deepEqual(after["vault:own-second"], ownLink(second, "own-second"), label);
      assert.deepEqual(after["health:vault-scale"], archivedImport, label);
    };

    // The same device, its own older archive: the import was deleted since (its link stays as a tombstone) and the
    // user's next reading took its id.
    own(source.db);
    await restoreFrom(source, exported.file);
    check(source.db, "same device");

    // A new phone of the same platform, and one of the other platform (which keeps the archive's imports, §5.3).
    for (const platform of ["ios", "android"]) {
      const target = await seeded(t, { platform });
      unlink(target.db, first);
      unlink(target.db, second);
      own(target.db);
      await restoreFrom(target, carry(source, target, exported.file, "g23-import.archive"));
      check(target.db, platform === "ios" ? "another device" : "another platform");
    }
  }
);

test(
  "G23 provenance merge: this device's tombstones survive later restores, so a file that still links a sample this device deleted has it written again (B by key, D by remote id)",
  { skip: vault.skip },
  async (t) => {
    const a = await seeded(t, { platform: "ios" });
    if (!a.app.health) {
      t.skip("no Health links in this app");
      return;
    }
    const [kind, table] = Object.entries(a.app.health.rowTables)[0];
    const [row, other] = a.db
      .getAllSync(`SELECT "id" FROM ${q(table)} ORDER BY "id" LIMIT 2`)
      .map((r) => r.id);
    const prefs = a.app.tables.find((x) => x.mode === "keys");
    const own = `${a.app.health.clientPrefix}:${keyStore(a.db, prefs).get("installation")}:${kind}:${row}`;
    const at = (db, id) =>
      db.runSync('DELETE FROM health_links WHERE "local_kind" = ? AND "local_id" = ?', [kind, id]);
    const local = (localId, remoteId, fingerprint) => ({
      local_kind: kind,
      local_id: localId,
      remote_id: remoteId,
      fingerprint,
      origin: "local",
    });
    // X, this device's own archive: its record `row` is in Health under this device's key.
    at(a.db, row);
    at(a.db, other);
    link(a.db, own, kind, row, "R-own", "own", "local");
    link(a.db, "vault:x-other", kind, other, "R-other", "other", "local");
    const x = await exportTo(a, "g23-x.archive");

    // Y, another phone's archive, has a record of its own at `row`.
    const b = await seeded(t, { platform: "ios" });
    b.db.runSync("DELETE FROM health_links");
    link(b.db, "vault:y", kind, row, "R-y", "y", "local");
    const y = carry(b, a, (await exportTo(b, "g23-y.archive")).file, "g23-y.archive");

    // Y restored: this device's sample of its own record is set aside (-1); the next sync removes it, leaving a
    // tombstone (what every app's removal loop writes).
    await restoreFrom(a, y);
    assert.deepEqual(linksOf(a.db)[own], local(-1, "R-own", "own"));
    a.db.runSync(`UPDATE health_links SET fingerprint = 'deleted' WHERE "key" = ?`, [own]);
    // Y restored again: the tombstone is carried (before vault 1.0.2 it was dropped here).
    await restoreFrom(a, y);
    assert.deepEqual(linksOf(a.db)[own], local(-1, "R-own", "deleted"));
    // Meanwhile the sample `vault:x-other` names was deleted here too, under another key (a lift `restored:` link
    // reaches its sample by remote id only): this device's tombstone holds that remote id.
    link(a.db, "vault:a-other", kind, -1, "R-other", "deleted", "local");

    // X restored: its links name samples this store no longer has. The key this device knows takes the live
    // tombstone (B), the other link loses its fingerprint (D): the next sync writes both records again instead of
    // trusting a sample that is gone. Y's record at `row` is set aside (its fingerprint was reset when Y, another
    // device's archive, was restored), the tombstones stay.
    await restoreFrom(a, x.file);
    const after = linksOf(a.db);
    assert.deepEqual(after[own], local(row, "R-own", "deleted"));
    assert.deepEqual(after["vault:x-other"], local(other, "R-other", ""));
    assert.deepEqual(after["vault:a-other"], local(-1, "R-other", "deleted"));
    assert.deepEqual(after["vault:y"], local(-1, "R-y", ""));
  }
);

test(
  "G23 provenance merge: a link parked at -1 under the installation the restore keeps follows the id its key names when no link holds it (R)",
  { skip: vault.skip },
  async (t) => {
    const a = await seeded(t, { platform: "ios" });
    if (!a.app.health) {
      t.skip("no Health links in this app");
      return;
    }
    const [kind, table] = Object.entries(a.app.health.rowTables)[0];
    const rows = a.db
      .getAllSync(`SELECT "id" FROM ${q(table)} ORDER BY "id" LIMIT 3`)
      .map((r) => r.id);
    assert.equal(rows.length, 3, "the fixture seeds three records of the first Health kind");
    const prefs = a.app.tables.find((x) => x.mode === "keys");
    const installation = keyStore(a.db, prefs).get("installation");
    const key = (inst, id) => `${a.app.health.clientPrefix}:${inst}:${kind}:${id}`;
    const parked = (remoteId, fingerprint, localId = -1) => ({
      local_kind: kind,
      local_id: localId,
      remote_id: remoteId,
      fingerprint,
      origin: "local",
    });
    // X, this device's own archive (same installation): rows[0] linked, rows[1] and rows[2] typed but not synced.
    for (const id of rows)
      a.db.runSync('DELETE FROM health_links WHERE "local_kind" = ? AND "local_id" = ?', [
        kind,
        id,
      ]);
    link(a.db, "vault:x-0", kind, rows[0], "R-x0", "x0", "local");
    const x = await exportTo(a, "g23-parked.archive");

    // Since then, another restore set this device's samples of those records aside (-1) and Health stayed off, or a
    // sync removed one of them (a tombstone at -1). The sync writes an unlinked record under exactly that key, and
    // body's and macro's export loops never move a link's local id: left at -1, the link would remove the sample the
    // write just made, every other sync.
    const gone = 1_000_000;
    link(a.db, key(installation, rows[0]), kind, -1, "R-p0", "p0", "local");
    link(a.db, key(installation, rows[1]), kind, -1, "R-p1", "deleted", "local");
    link(a.db, key(installation, rows[2]), kind, -1, "R-p2", "p2", "local");
    link(a.db, key(installation, gone), kind, -1, "R-pg", "deleted", "local");
    link(a.db, key("another-installation", rows[2]), kind, -1, "R-o2", "o2", "local");
    await restoreFrom(a, x.file);
    const after = linksOf(a.db);
    // The record X links keeps its link; this device's parked one stays parked.
    assert.deepEqual(after["vault:x-0"], parked("R-x0", "x0", rows[0]));
    assert.deepEqual(after[key(installation, rows[0])], parked("R-p0", "p0"));
    // Unlinked records take the parked link their key names: the tombstone (carried since vault 1.0.2) makes the
    // next sync write the record again, the other one is compared and replaced in place.
    assert.deepEqual(after[key(installation, rows[1])], parked("R-p1", "deleted", rows[1]));
    assert.deepEqual(after[key(installation, rows[2])], parked("R-p2", "p2", rows[2]));
    // An id no record has: the link names it as a tombstone of a deleted record would (nothing to write or remove).
    assert.deepEqual(after[key(installation, gone)], parked("R-pg", "deleted", gone));
    // Another installation's key is not the one the sync writes: removed as before.
    assert.deepEqual(after[key("another-installation", rows[2])], parked("R-o2", "o2"));
  }
);

test(
  'G23 installation rule: an archive that names no installation adds "*" to the lineage on another device, never on the device that made it',
  { skip: vault.skip },
  async (t) => {
    const source = await seeded(t, { platform: "ios" });
    const keysTable = source.app.tables.find(
      (x) => x.mode === "keys" && x.keys.include.includes("installation")
    );
    if (!source.app.health || !keysTable) {
      t.skip("no Health installation in this app");
      return;
    }
    const prefs = keyStore(source.db, keysTable);
    const lineageOf = (store) => JSON.parse(store.get("healthInstallations"));
    /** restoreFrom, returning whether the import screen saw the archive as this device's own. */
    const restoreSeen = async (ctx, file) => {
      const archive = await ctx.ops.runOpen(file);
      try {
        await ctx.ops.runRestore(archive, { reason: "file" });
        return archive.preview.sameDevice;
      } finally {
        archive.close();
      }
    };
    // The archive is made before this phone ever synced with Health: no installation, no lineage.
    prefs.set("installation", null);
    prefs.set("healthInstallations", null);
    const exported = await exportTo(source, "g23-prehealth.archive");
    // Health turned on afterwards: the phone's records reach its Health store under an installation the archive
    // never names.
    const later = "1792000000000-later";
    prefs.set("installation", later);
    prefs.set("healthInstallations", JSON.stringify([later]));

    // Another device id on a store that may hold those samples (a second iPhone of the Apple Account, this iPhone
    // after a reinstall, the other platform's phone): the archive's own-app lineage is unknown, as a v1 file's, so
    // no sample of this app may come back as an outside reading. The fresh installation still names new records.
    for (const platform of ["ios", "android"]) {
      const other = await open(t, { platform });
      const otherPrefs = keyStore(await other.w.live(), keysTable);
      otherPrefs.set("installation", "1791000000000-otherinst");
      otherPrefs.set("healthInstallations", JSON.stringify(["1781000000000-otherold"]));
      const file = carry(source, other, exported.file, "g23-prehealth.archive");
      assert.equal(await restoreSeen(other, file), false, platform);
      const fresh = otherPrefs.get("installation");
      assert.match(fresh, /^\d+-[a-z0-9]+$/, platform);
      assert.ok(![later, "1791000000000-otherinst"].includes(fresh), platform);
      assert.deepEqual(
        lineageOf(otherPrefs),
        ["*", "1781000000000-otherold", "1791000000000-otherinst"],
        platform
      );
    }

    // The device that made it: every installation it ever synced under is the live one or in the live list.
    assert.equal(await restoreSeen(source, exported.file), true);
    assert.equal(prefs.get("installation"), later, "kept: the archive has none");
    assert.deepEqual(lineageOf(prefs), [later], 'no "*" on the device that made the archive');
  }
);

test(
  "G23 provenance policy: another device resets local fingerprints; another platform resets remote ids too and drops what nothing could address",
  { skip: vault.skip },
  async (t) => {
    const source = await seeded(t, { platform: "ios" });
    if (!source.app.health) {
      t.skip("no Health links in this app");
      return;
    }
    const exported = await exportTo(source, "g23-policy.archive");
    const archived = linksOf(source.db);
    const pad = (n) => String(n).padStart(2, "0");
    const day = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const recentFood = new Set(
      source.app.health.rowTables.food
        ? source.db
            .getAllSync("SELECT id FROM food_entries WHERE day >= ?", [
              day(new Date(Date.now() - 30 * 86400000)),
            ])
            .map((r) => r.id)
        : []
    );
    const oldFood = (l) => l.local_kind === "food" && !recentFood.has(l.local_id);
    const prefs = source.app.tables.find((x) => x.mode === "keys");
    const prefValue = (db, key) => keyStore(db, prefs).get(key);

    // Another device, same platform: an empty fingerprint makes the next sync upsert each record once.
    const ios = await open(t, { platform: "ios" });
    const iosDb = await ios.w.live();
    await restoreFrom(ios, carry(source, ios, exported.file, "policy.archive"));
    const same = linksOf(iosDb);
    for (const [key, l] of Object.entries(archived)) {
      if (l.origin !== "local" || l.fingerprint === "deleted" || oldFood(l))
        assert.deepEqual(same[key], l, key);
      else assert.deepEqual(same[key], { ...l, fingerprint: "" }, key);
    }

    // Another platform: the other store's remote ids mean nothing here.
    const android = await open(t, { platform: "android" });
    const androidDb = await android.w.live();
    await restoreFrom(android, carry(source, android, exported.file, "policy.archive"));
    const cross = linksOf(androidDb);
    for (const [key, l] of Object.entries(archived)) {
      if (l.origin !== "local") assert.deepEqual(cross[key], l, key);
      else if (key.startsWith("restored:") || oldFood(l))
        assert.equal(cross[key], undefined, `${key}: dropped`);
      else assert.deepEqual(cross[key], { ...l, remote_id: "", fingerprint: "" }, key);
    }
    if (source.app.health.rowTables.food) {
      assert.equal(prefValue(androidDb, "healthFoodSince"), null, "the food window restarts");
      assert.equal(
        prefValue(androidDb, "weightSyncEpoch"),
        prefValue(source.db, "weightSyncEpoch"),
        "restored weights keep their keys"
      );
    }
  }
);

// ---------------------------------------------------------------------------------------------------------------
// G24 empty library

test(
  "G24 empty library: libraryEmpty is true for what the app writes by itself and false after a seed",
  { skip: vault.skip },
  async (t) => {
    const ctx = await open(t);
    await ctx.w.live();
    // The vault's own connection (water: a new one through initializeDatabase, which writes the counters row).
    const env = ctx.paths.engineEnv();
    const db = await env.acquire();
    try {
      ctx.w.fresh(db);
      if (ctx.app.id === "water")
        db.runSync(
          "INSERT INTO drinks (id, kind, volume_ml, consumed_at, updated_at, deleted) VALUES ('tombstoned', 'water', 250, 0, 0, 1)"
        );
      assert.equal(ctx.ready.libraryEmpty(db), true);
    } finally {
      await env.release(db);
    }
    const seededDb = await ctx.w.migrate(ctx.w.open("g24.db", { useNewConnection: true }));
    ctx.w.seed(seededDb);
    assert.equal(ctx.ready.libraryEmpty(seededDb), false);
  }
);

// ---------------------------------------------------------------------------------------------------------------
// G25 cancellation with React Native's AbortSignal

test(
  "G25 cancellation: a restore aborted before the commit section rejects cancelled and changes nothing; after it, nothing stops it",
  { skip: vault.skip },
  async (t) => {
    const ctx = await seeded(t);
    const { db, app } = ctx;
    const exported = await exportTo(ctx, "g25.archive");
    change(ctx, db);
    const hash = liveHash(ctx, db);
    const files = mediaState(ctx);
    const steps = [
      "verify",
      "scratch",
      "migrate",
      "validate",
      ...(app.media?.length ? ["media"] : []),
    ];
    for (const step of [null, ...steps]) {
      const controller = new AbortController();
      if (step === null) controller.abort();
      assert.equal(
        typeof controller.signal.throwIfAborted,
        "undefined",
        "the device-shaped signal"
      );
      const error = await vaultError(() =>
        restoreFrom(ctx, exported.file, {
          signal: controller.signal,
          onProgress: (p) => {
            if (p.step === step) controller.abort();
          },
        })
      );
      assert.equal(error.code, "cancelled", String(step));
      assert.equal(liveHash(ctx, db), hash, String(step));
      assert.deepEqual(mediaState(ctx), files, String(step));
      assert.deepEqual(leftovers(ctx), CLEAN, String(step));
      assert.deepEqual(ctx.paths.liveOps(), []);
    }
    // Honoured until the commit section starts, never after.
    const late = new AbortController();
    const result = await restoreFrom(ctx, exported.file, {
      signal: late.signal,
      onProgress: (p) => {
        if (p.step === "swap") late.abort();
      },
    });
    assert.equal(result.warning, null);
    assert.equal(late.signal.aborted, true);
    assert.notEqual(liveHash(ctx, db), hash);
  }
);

// ---------------------------------------------------------------------------------------------------------------
// G5 / G5b schema skew

/** Appends journal entries (with their SQL) to the descriptor's migrations: a later app version. */
function appendMigrations(app, statements) {
  const { journal, migrations } = app.migrations;
  const entries = [...journal.entries];
  const files = { ...migrations };
  for (const [i, sql] of statements.entries()) {
    const idx = entries.length;
    entries.push({
      idx,
      when: entries[entries.length - 1].when + 1000,
      tag: `${String(idx).padStart(4, "0")}_vault_test_${i}`,
      breakpoints: true,
    });
    files[`m${String(idx).padStart(4, "0")}`] = sql;
  }
  app.migrations = { journal: { ...journal, entries }, migrations: files };
}

/** Drizzle's migrator over the descriptor's (possibly extended) migrations. */
async function migrateTo(ctx, db) {
  const { drizzle } = ctx.w.require("drizzle-orm/expo-sqlite");
  const { migrate } = ctx.w.require("drizzle-orm/expo-sqlite/migrator");
  await migrate(drizzle(db), ctx.app.migrations);
}

test(
  "G5b schema skew (future): an added column and a drizzle-kit rebuild with children after the archive's level keep every row; no cascade; sequence kept",
  { skip: vault.skip },
  async (t) => {
    const source = await seeded(t);
    const { app } = source;
    const sdb = source.db;
    const added = dataTable(source, sdb).name;
    const children = (name) =>
      app.tables.filter((x) =>
        sdb
          .getAllSync("SELECT * FROM pragma_foreign_key_list(?)", [x.name])
          .some((k) => k.table === name)
      ).length;
    const rebuilt = app.tables
      .filter(
        (x) =>
          x.mode === "replace" &&
          x.name !== added &&
          sdb.getFirstSync(`SELECT 1 AS v FROM ${q(x.name)} LIMIT 1`)
      )
      .sort(
        (a, b) =>
          Number(isAutoincrement(sdb, b.name)) - Number(isAutoincrement(sdb, a.name)) ||
          children(b.name) - children(a.name)
      )[0].name;
    const autoincrement = isAutoincrement(sdb, rebuilt);
    if (autoincrement)
      sdb.runSync("UPDATE sqlite_sequence SET seq = 900 WHERE name = ?", [rebuilt]);
    const exported = await exportTo(source, "g5b.archive");
    const before = dump(source, sdb);

    // A later app version on the same device: its database has both migrations.
    const target = await open(t);
    const db = await asSameDevice(source, target);
    const create = db.getFirstSync(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
      [rebuilt]
    ).sql;
    const indexes = db
      .getAllSync(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL",
        [rebuilt]
      )
      .map((r) => r.sql);
    const columns = columnsOf(db, rebuilt)
      .map((c) => `\`${c}\``)
      .join(", ");
    appendMigrations(target.app, [
      `ALTER TABLE \`${added}\` ADD \`vault_g5b\` integer DEFAULT 7 NOT NULL;`,
      [
        "PRAGMA foreign_keys=OFF;",
        // drizzle-kit names the new table in the constraints too (water: CHECK("counters"."id" = 1)).
        create
          .replace(/^CREATE TABLE\s+[`"']?\w+[`"']?/i, `CREATE TABLE \`__new_${rebuilt}\``)
          .replaceAll(`"${rebuilt}".`, `"__new_${rebuilt}".`) + ";",
        `INSERT INTO \`__new_${rebuilt}\`(${columns}) SELECT ${columns} FROM \`${rebuilt}\`;`,
        `DROP TABLE \`${rebuilt}\`;`,
        `ALTER TABLE \`__new_${rebuilt}\` RENAME TO \`${rebuilt}\`;`,
        ...indexes.map((sql) => `${sql};`),
        "PRAGMA foreign_keys=ON;",
      ].join("--> statement-breakpoint\n"),
    ]);
    await migrateTo(target, db);
    const archive = await target.ops.runOpen(carry(source, target, exported.file, "g5b.archive"));
    assert.equal(archive.preview.olderSchema, true);
    await target.ops.runRestore(archive, { reason: "file" });
    archive.close();

    const others = app.tables.map((x) => x.name).filter((n) => n !== rebuilt && n !== added);
    assert.deepEqual(
      dump(target, db, { tables: others }),
      Object.fromEntries(others.map((n) => [n, before[n]]))
    );
    assert.deepEqual(dump(target, db, { tables: [added], without: ["vault_g5b"] }), {
      [added]: before[added],
    });
    assert.deepEqual(
      db.getAllSync(`SELECT DISTINCT vault_g5b AS v FROM ${q(added)}`),
      before[added].length ? [{ v: 7 }] : []
    );
    // The rebuild dropped the runtime-owned column in the scratch: rows intact, sync ids fresh.
    assert.deepEqual(dump(target, db, { tables: [rebuilt], without: ["sync_id"] }), {
      [rebuilt]: before[rebuilt].map(({ sync_id, ...row }) => row),
    });
    if ((app.syncIdTables ?? []).includes(rebuilt))
      assert.ok(
        db.getAllSync(`SELECT sync_id FROM ${q(rebuilt)}`).every((r) => UUID_V4.test(r.sync_id))
      );
    assert.deepEqual(db.getAllSync("PRAGMA foreign_key_check"), []);
    if (autoincrement) {
      assert.ok(
        sequences(db)[rebuilt] >= 900,
        "the manifest's sequence, not the rebuilt scratch's"
      );
      assert.equal(nextId(db, rebuilt), 901);
    }
  }
);

test(
  "G5 schema skew (historical): an archive of every earlier level replays there and migrates forward exactly like the app's own migrations",
  { skip: vault.skip },
  async (t) => {
    // An empty live library: what the restore writes is the archive's, migrated forward, and nothing else (a seeded
    // one would add water's tombstones for the drinks the archive lacks, which the reference cannot have).
    const ctx = await open(t);
    const { app, w } = ctx;
    const db = await w.live();
    await locked(ctx);
    const full = app.migrations;
    const current = full.journal.entries.length;
    const fixture = vault.fixture();
    const { ensureSyncIds } = w.require("@/vault/engine/sid");
    const deviceId = ctx.state.readState(db, "device.id");
    const validate = app.validate;
    for (let level = 1; level < current; level++) {
      const seededLevel = fixture.levels.includes(level);
      // The older app's database at that level (seeded where the fixture supports it).
      const older = w.open(`g5-${level}.db`, { useNewConnection: true });
      await w.migrate(older, level);
      if (seededLevel) {
        w.seed(older, { level });
        ensureSyncIds(older);
      }
      ctx.state.updateState(older, {
        "device.id": deviceId,
        "library.id": "00000000-0000-4000-8000-0000000000g5".replace(
          "g5",
          String(level).padStart(2, "0")
        ),
      });
      // Exported by that version: its journal ends at `level` (its summary and Health SQL are not this one's).
      const { summary, healthEnabledSql } = app;
      app.migrations = {
        ...full,
        journal: { ...full.journal, entries: full.journal.entries.slice(0, level) },
      };
      app.summary = {};
      app.healthEnabledSql = undefined;
      ctx.paths.setEngineEnv({ acquire: async () => older, release: async () => {} });
      let exported;
      try {
        fs.mkdirSync(w.file("out"), { recursive: true });
        exported = await ctx.exporter.exportArchive({
          kind: "manual",
          destination: new ctx.File(w.uri("out", `g5-${level}.archive`)),
          embedMedia: true,
          csv: false,
          deflateLevel: 1,
        });
      } finally {
        app.migrations = full;
        app.summary = summary;
        app.healthEnabledSql = healthEnabledSql;
        ctx.paths.setEngineEnv(null);
      }
      assert.equal(exported.manifest.schema.applied, level);

      // The reference: the same database migrated forward by the app's own migrations.
      const copy = path.join(w.dir, `g5-${level}-reference.db`);
      older.runSync("VACUUM INTO ?", [copy]);
      older.closeSync();
      const reference = w.open(path.basename(copy), { useNewConnection: true }, w.dir);
      await w.migrate(reference);

      // An unseeded level is an empty library: no singleton row the app's validators expect.
      app.validate = seededLevel ? validate : undefined;
      const archive = await ctx.ops.runOpen(exported.file);
      assert.equal(archive.preview.olderSchema, true, `level ${level}`);
      await ctx.ops.runRestore(archive, { reason: "file" });
      archive.close();
      app.validate = validate;

      for (const table of app.tables) {
        if (table.role === "provenance") continue;
        // An unseeded level is an empty library: what the app writes for itself on every open (water's counters
        // and preferences rows, through initializeDatabase) is not the archive's.
        if (
          !seededLevel &&
          (table.mode === "singleton" || (table.mode === "replace" && table.role === "settings"))
        )
          continue;
        const device = new Set(table.deviceColumns ?? []);
        const columns = columnsOf(reference, table.name).filter(
          (c) => !device.has(c) && columnsOf(db, table.name).includes(c)
        );
        let tail = " ORDER BY rowid";
        let params = [];
        if (table.mode === "keys") {
          const keys = table.keys.include.filter((k) => !(table.keys.provenance ?? []).includes(k));
          tail = ` WHERE ${q(table.keys.keyColumn)} IN (${keys.map(() => "?").join(", ")}) ORDER BY ${q(table.keys.keyColumn)}`;
          params = keys;
        } else if (table.mode === "singleton") tail = ` WHERE ${table.singleton.where}`;
        const read = (conn) =>
          conn.getAllSync(
            `SELECT ${columns.map(q).join(", ")} FROM ${q(table.name)}${tail}`,
            params
          );
        assert.deepEqual(read(db), read(reference), `level ${level}: ${table.name}`);
      }
      reference.closeSync();
    }
  }
);

// ---------------------------------------------------------------------------------------------------------------
// Entry points (ops.ts)

test(
  "ops: runExport on a database without a device id runs ensureReady first; startVault prepares the vault and never throws",
  { skip: vault.skip },
  async (t) => {
    const warnings = quiet(t);
    const ctx = await open(t);
    const db = await ctx.w.live();
    ctx.w.seed(db);
    assert.equal(ctx.state.readState(db, "device.id"), null);
    const exported = await exportTo(ctx, "ops.archive");
    const deviceId = ctx.state.readState(db, "device.id");
    assert.match(deviceId, UUID_V4);
    assert.equal(exported.manifest.device.id, deviceId);
    assert.equal(exported.manifest.library.id, ctx.state.readState(db, "library.id"));
    for (const table of ctx.app.syncIdTables ?? [])
      assert.ok(
        db.getAllSync(`SELECT sync_id FROM ${q(table)}`).every((r) => UUID_V4.test(r.sync_id)),
        table
      );
    assert.equal(
      ctx.w.excluded.get(ctx.paths.vaultDir().uri),
      true,
      "PendumVault excluded from backup"
    );
    assert.equal(ctx.state.vaultState()["device.id"], deviceId, "the state mirror is fresh");

    const other = await open(t);
    const otherDb = await other.w.live();
    await other.ops.startVault();
    assert.match(other.state.readState(otherDb, "device.id"), UUID_V4);
    assert.match(other.state.readState(otherDb, "library.id"), UUID_V4);
    assert.ok(fs.existsSync(other.w.file("PendumVault", "device.json")));
    assert.equal(other.lock.busyWith(), null);
    // A failure is logged, not thrown; the next entry point retries.
    other.paths.setEngineEnv({
      acquire: async () => {
        throw new Error("database unavailable");
      },
    });
    t.after(() => other.paths.setEngineEnv(null));
    const before = warnings.length;
    await other.ops.startVault();
    assert.equal(warnings.length, before + 1);
    assert.equal(other.lock.busyWith(), null);
  }
);

test(
  "ops: a restore waits while an earlier one is unfinished: insufficientSpace while its recovery set cannot be packaged",
  { skip: vault.skip },
  async (t) => {
    quiet(t);
    const ctx = await seeded(t);
    const { db, w } = ctx;
    const exported = await exportTo(ctx, "pending.archive");
    change(ctx, db);
    const archive = await ctx.ops.runOpen(exported.file);
    t.after(() => archive.close());
    ctx.swap.simulateCrash("afterCommit");
    await thrown(() =>
      ctx.lock.exclusive("restore", () => ctx.restore.restoreArchive(archive, { reason: "file" }), {
        wait: true,
      })
    );
    const journal = ctx.journal.readJournal();
    ctx.paths.endOp(journal.op);
    // The raw set cannot be packaged (its snapshot is unreadable here; a full disk on a device).
    const partial = w.file("PendumVault", "recovery", `${journal.recoveryId}.partial`);
    fs.renameSync(path.join(partial, "live.db"), path.join(w.dir, "live.db.aside"));
    const error = await vaultError(() => ctx.ops.runRestore(archive, { reason: "file" }));
    assert.deepEqual([error.code, error.info.detail], ["insufficientSpace", "pendingRecovery"]);
    assert.equal(ctx.journal.readJournal().op, journal.op, "the journal is kept");
    assert.ok(fs.existsSync(partial), "and so is its set");
    // Once packaging can succeed, the next entry point finishes it, and restores run again.
    fs.renameSync(path.join(w.dir, "live.db.aside"), path.join(partial, "live.db"));
    const result = await ctx.ops.runRestore(archive, { reason: "file" });
    assert.deepEqual(recoverySets(ctx), [journal.recoveryId, result.recoveryId]);
    assert.deepEqual(leftovers(ctx, [archive.opId]), CLEAN);
  }
);

test(
  "ops: a restore waits while an earlier one could not be rolled back (restoreFailed); the journal is kept",
  { skip: vault.skip },
  async (t) => {
    quiet(t);
    const ctx = await seeded(t);
    const { db, app, w } = ctx;
    const set = app.media?.[0];
    if (!set) {
      t.skip("no media moves in this app");
      return;
    }
    const exported = await exportTo(ctx, "rollback.archive");
    const changed = change(ctx, db);
    const archive = await ctx.ops.runOpen(exported.file);
    t.after(() => archive.close());
    ctx.swap.simulateCrash("afterMedia");
    await thrown(() =>
      ctx.lock.exclusive("restore", () => ctx.restore.restoreArchive(archive, { reason: "file" }), {
        wait: true,
      })
    );
    const journal = ctx.journal.readJournal();
    ctx.paths.endOp(journal.op);
    // The displaced photo cannot go back: its place is taken by a folder.
    fs.mkdirSync(w.file(set.directory, changed.added));
    const error = await vaultError(() => ctx.ops.runRestore(archive, { reason: "file" }));
    assert.deepEqual([error.code, error.info.detail], ["restoreFailed", "pendingRollback"]);
    assert.equal(ctx.journal.readJournal().op, journal.op);
    assert.ok(
      fs.existsSync(
        w.file(
          "PendumVault",
          "recovery",
          `${journal.recoveryId}.partial`,
          "media",
          set.set,
          changed.added
        )
      ),
      "the photo's only copy is kept"
    );
    fs.rmdirSync(w.file(set.directory, changed.added));
    await ctx.ops.runRestore(archive, { reason: "file" });
    assert.ok(fs.existsSync(w.file("PendumVault", "recovery")));
    assert.equal(ctx.journal.readJournal(), null);
  }
);

// ---------------------------------------------------------------------------------------------------------------
// After the commit; preconditions

test(
  "after the commit: a failing afterRestore is a warning, never a failed restore, and is retried once at the next start",
  { skip: vault.skip },
  async (t) => {
    quiet(t);
    const ctx = await seeded(t);
    const { db, app } = ctx;
    const exported = await exportTo(ctx, "after.archive");
    const archived = dump(ctx, db);
    change(ctx, db);
    let calls = 0;
    app.hooks.afterRestore = async () => {
      calls++;
      throw new Error("afterRestore bug");
    };
    const result = await restoreFrom(ctx, exported.file);
    assert.equal(result.warning, "afterRestoreFailed");
    assert.match(result.recoveryId, RECOVERY_ID, "the recovery set was packaged");
    assert.deepEqual(dump(ctx, db), archived, "committed");
    assert.deepEqual(ctx.journal.readJournal().done.includes("package"), true);
    await locked(ctx);
    assert.equal(calls, 2, "retried once");
    assert.equal(ctx.journal.readJournal(), null, "then given up");
    await locked(ctx);
    assert.equal(calls, 2);
  }
);

test(
  "preconditions: a Health sync that does not go idle is healthBusy; too little space is insufficientSpace; a pending migration is migrationPending",
  { skip: vault.skip },
  async (t) => {
    quiet(t);
    const ctx = await seeded(t);
    const { db, app, w } = ctx;
    const exported = await exportTo(ctx, "pre.archive");
    change(ctx, db);
    const hash = liveHash(ctx, db);
    const pause = app.hooks.pauseWhenIdle;
    app.hooks.pauseWhenIdle = async () => {
      throw new Error("Wait for Health sync to finish");
    };
    assert.equal((await vaultError(() => restoreFrom(ctx, exported.file))).code, "healthBusy");
    app.hooks.pauseWhenIdle = pause;
    // Errors of the work pass through; a result the work produced survives the pause's own failure.
    const { VaultError } = w.require("@/vault/errors");
    assert.equal(
      (
        await vaultError(() =>
          ctx.restore.pauseHealth(async () => {
            throw new VaultError("corrupt");
          })
        )
      ).code,
      "corrupt"
    );
    app.hooks.pauseWhenIdle = async (work) => {
      await work();
      throw new Error("release failed");
    };
    assert.equal(await ctx.restore.pauseHealth(async () => "done"), "done");
    app.hooks.pauseWhenIdle = pause;

    const archive = await ctx.ops.runOpen(exported.file);
    t.after(() => archive.close());
    w.disk.available = 1024;
    const full = await vaultError(() => ctx.ops.runRestore(archive, { reason: "file" }));
    assert.equal(full.code, "insufficientSpace");
    assert.ok(full.info.bytes > 64 * 1024 * 1024);
    w.disk.available = 64 * 2 ** 30;
    appendMigrations(app, ["CREATE TABLE `vault_pending` (`id` integer PRIMARY KEY NOT NULL);"]);
    assert.equal(
      (await vaultError(() => ctx.ops.runRestore(archive, { reason: "file" }))).code,
      "migrationPending"
    );
    assert.equal(liveHash(ctx, db), hash);
    assert.deepEqual(leftovers(ctx, [archive.opId]), CLEAN);
  }
);

test(
  "recovery: lift's and macro's v1 pre-restore copy is offered until a v2 restore commits, which deletes it",
  { skip: vault.skip },
  async (t) => {
    const ctx = await seeded(t);
    const { db, app, w } = ctx;
    fs.mkdirSync(w.file("LegacyBackups"), { recursive: true });
    const copy = w.file("LegacyBackups", "app-recovery-1787000000000.backup.json");
    fs.writeFileSync(copy, '{"format":"vault-test-backup"}');
    app.legacy = {
      recoveryCopy: () =>
        fs.existsSync(copy)
          ? {
              file: new ctx.File(w.uri("LegacyBackups", path.basename(copy))),
              createdAt: "2026-09-01T10:00:00.000Z",
            }
          : null,
    };
    assert.deepEqual(ctx.recovery.latestRecovery(db), {
      id: "legacy",
      createdAt: "2026-09-01T10:00:00.000Z",
      legacy: true,
    });
    assert.equal(ctx.recovery.latestRecovery(), null, "only with the live connection");
    assert.equal(
      (await ctx.recovery.recoveryFile("legacy")).uri,
      w.uri("LegacyBackups", path.basename(copy))
    );
    const exported = await exportTo(ctx, "legacy-copy.archive");
    change(ctx, db);
    const result = await restoreFrom(ctx, exported.file);
    assert.equal(fs.existsSync(copy), false, "superseded by the new recovery set");
    assert.equal(ctx.recovery.latestRecovery(db).id, result.recoveryId);
  }
);

// ---------------------------------------------------------------------------------------------------------------
// Erase (lift and macro data panels)

test(
  "erase: the Health lineage survives, recovery sets and work files go, a new library starts, automatic backup turns off",
  { skip: vault.skip },
  async (t) => {
    const ctx = await seeded(t);
    const { db, app, w, state } = ctx;
    const exported = await exportTo(ctx, "erase.archive");
    change(ctx, db);
    await restoreFrom(ctx, exported.file);
    assert.equal(recoverySets(ctx).length, 1);
    fs.mkdirSync(w.file("..", "Caches", "PendumVault", "out"), { recursive: true });
    fs.writeFileSync(w.file("..", "Caches", "PendumVault", "out", "old.archive"), "x");
    state.updateState(db, {
      "cloud.icloud.lastOkAt": "2026-10-01T00:00:00.000Z",
      "cloud.gdrive.index": "{}",
      "icloud.enabled": "1",
      "gdrive.enabled": "1",
      "gdrive.connected": "1",
      "gdrive.email": "someone@example.com",
      "handoff.candidate": '{"deviceId":"x"}',
      "handoff.ack": '{"x":3}',
      "handoff.emptyOffered": "1",
    });
    const deviceId = state.readState(db, "device.id");
    const library = state.readState(db, "library.id");
    const prefs = app.tables.find(
      (x) => x.mode === "keys" && x.keys.include.includes("installation")
    );
    const lineage = prefs
      ? [
          ...new Set([
            ...JSON.parse(keyStore(db, prefs).get("healthInstallations") ?? "[]"),
            keyStore(db, prefs).get("installation"),
          ]),
        ]
          .filter(Boolean)
          .sort()
      : [];
    const token = await ctx.erase.captureBeforeErase();
    assert.deepEqual(token, { healthInstallations: lineage });
    // The app's erase: every record and every preference.
    const fkOn = db.getFirstSync("PRAGMA foreign_keys").foreign_keys;
    db.execSync("PRAGMA foreign_keys = OFF");
    for (const x of [...app.tables].reverse()) db.runSync(`DELETE FROM ${q(x.name)}`);
    db.execSync(`PRAGMA foreign_keys = ${fkOn ? "ON" : "OFF"}`);
    await ctx.erase.onLocalDataErased(token);

    assert.deepEqual(recoverySets(ctx), []);
    assert.equal(fs.existsSync(w.file("PendumVault", "recovery")), false);
    assert.equal(fs.existsSync(w.file("..", "Caches", "PendumVault")), false);
    assert.ok(fs.existsSync(w.file("PendumVault", "device.json")), "the anchor stays");
    assert.equal(state.readState(db, "device.id"), deviceId);
    const next = state.readState(db, "library.id");
    assert.match(next, UUID_V4);
    assert.notEqual(next, library);
    assert.deepEqual(JSON.parse(state.readState(db, "library.erased")), [library]);
    assert.equal(state.readState(db, "recovery.latest"), null);
    assert.deepEqual(
      [
        state.readState(db, "lineage.vector"),
        state.readState(db, "lineage.ownBase"),
        state.readState(db, "icloud.enabled"),
        state.readState(db, "gdrive.enabled"),
        state.readState(db, "gdrive.connected"),
        state.readState(db, "gdrive.email"),
        state.readState(db, "handoff.ack"),
        state.readState(db, "handoff.candidate"),
        state.readState(db, "handoff.emptyOffered"),
      ],
      ["{}", "0", "0", "0", "1", "someone@example.com", "{}", null, "0"]
    );
    assert.deepEqual(state.readStates(db, "cloud."), {});
    if (prefs)
      assert.deepEqual(JSON.parse(keyStore(db, prefs).get("healthInstallations")), lineage);
    assert.equal(ctx.recovery.latestRecovery(db), null);
    assert.equal(state.vaultState()["library.id"], next);
    // A second erase remembers both libraries.
    await ctx.erase.onLocalDataErased({ healthInstallations: [] });
    assert.deepEqual(JSON.parse(state.readState(db, "library.erased")), [library, next]);
  }
);

test(
  "erase without the native module (Expo Go, a build from before the vault's prebuild): nothing fails after the app's erase, the lineage is written back, the next start mints the library",
  { skip: vault.skip },
  async (t) => {
    const ctx = await open(t, {
      stubs: {
        expo: () => ({
          requireOptionalNativeModule: () => null,
          requireNativeModule(name) {
            throw new Error(`Cannot find native module '${name}' (vault harness)`);
          },
        }),
      },
    });
    assert.equal(ctx.w.require("@/vault/native").vaultSupported, false);
    const { app, w, state } = ctx;
    const db = w.seed(await w.live());
    // What a build with the module left behind: a library, a recovery set, automatic backup on.
    state.updateState(db, {
      "library.id": "library-before",
      "recovery.latest": "20261001T000000Z-ab12",
      "icloud.enabled": "1",
    });
    fs.mkdirSync(w.file("PendumVault", "recovery", "20261001T000000Z-ab12"), { recursive: true });
    const prefs = app.tables.find(
      (x) => x.mode === "keys" && x.keys.include.includes("installation")
    );
    const token = await ctx.erase.captureBeforeErase();
    // The app's erase: every record and every preference.
    const fkOn = db.getFirstSync("PRAGMA foreign_keys").foreign_keys;
    db.execSync("PRAGMA foreign_keys = OFF");
    for (const x of [...app.tables].reverse()) db.runSync(`DELETE FROM ${q(x.name)}`);
    db.execSync(`PRAGMA foreign_keys = ${fkOn ? "ON" : "OFF"}`);
    // Threw VaultError("unsupported") from inside the transaction, losing the lineage write-back.
    await ctx.erase.onLocalDataErased(token);

    if (prefs) {
      assert.ok(token.healthInstallations.length > 0, "the fixture has a Health lineage");
      assert.deepEqual(
        JSON.parse(keyStore(db, prefs).get("healthInstallations")),
        token.healthInstallations
      );
    }
    assert.equal(fs.existsSync(w.file("PendumVault", "recovery")), false);
    assert.equal(
      state.readState(db, "library.id"),
      null,
      "ensureLibrary mints it at the next start"
    );
    assert.deepEqual(JSON.parse(state.readState(db, "library.erased")), ["library-before"]);
    assert.equal(state.readState(db, "recovery.latest"), null);
    assert.equal(state.readState(db, "icloud.enabled"), "0");
    assert.equal(ctx.lock.busyWith(), null);
  }
);
