// The vault UI's logic (synced, hash-checked; loaded by tests/vault.test.*): the import screen's reducer
// (src/vault/ui/import-flow.ts) transition by transition, then the module stores behind the screens — the import
// flow and status of ui/use-vault.ts, the export of ui/export.ts, the recovery row of ui/recovery.ts, navigation —
// and the on-device self-test of src/vault/dev/selftest.ts, all against this repo's real descriptor, schema and
// fixture in a harness world. No component renders: the stores' actions run as the screens call them, and React
// is loaded only for the modules that import it.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const path = require("node:path");

const vault = require("../vault-harness.cjs");

const RECOVERY_ID = /^\d{8}T\d{6}Z-[a-z0-9]{4}$/;
const PASSWORD = "correct horse battery staple";

/** The modules a UI store imports that the harness does not stub: React itself, and the kit (never rendered). */
const uiStubs = () => ({
  react: createRequire(path.join(vault.root, "package.json"))("react"),
  "@/vector": {
    useKit() {
      throw new Error("ui-flow test: no component renders here");
    },
  },
});

/** A world closed after the test, with the modules the tests use. */
async function open(t, options = {}) {
  const w = await vault.world({ ...options, stubs: { ...uiStubs(), ...options.stubs } });
  t.after(() => w.close());
  const vaultModule = (name) => w.require(`@/vault/${name}`);
  return {
    w,
    ...w.require("expo-file-system"),
    app: w.vaultApp,
    apps: vaultModule("apps.json"),
    paths: vaultModule("engine/paths"),
    lock: vaultModule("engine/lock"),
    state: vaultModule("engine/state"),
    ops: vaultModule("ops"),
    incoming: vaultModule("incoming"),
    flow: vaultModule("ui/import-flow"),
    store: vaultModule("ui/use-vault"),
    recovery: vaultModule("ui/recovery"),
    nav: vaultModule("ui/nav"),
  };
}

/** A world whose live database is seeded (unless `fresh`) and started as <VaultRoot /> starts it. */
async function started(t, { fresh = false, ...options } = {}) {
  const ctx = await open(t, options);
  const db = await ctx.w.live();
  if (fresh) ctx.w.fresh(db);
  else ctx.w.seed(db);
  await ctx.ops.startVault();
  return { ...ctx, db };
}

/** A manual export of the world's live library into Documents/out/<name>. */
async function exported(ctx, name = "export.archive") {
  fs.mkdirSync(ctx.w.file("out"), { recursive: true });
  const result = await ctx.ops.runExport({
    kind: "manual",
    destination: new ctx.File(ctx.w.uri("out", name)),
    embedMedia: true,
    csv: false,
    deflateLevel: 6,
  });
  return result.file;
}

/** Copies a file of one world into another's Documents/in/ (a file carried between devices). */
function carry(from, to, file, name) {
  fs.mkdirSync(to.w.file("in"), { recursive: true });
  fs.copyFileSync(from.paths.fsPath(file), to.w.file("in", name));
  return to.w.uri("in", name);
}

/** Waits until `check()` holds (the stores' work runs on promises). */
async function until(check, label, ms = 20_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

const flowIs = (ctx, s) => () => ctx.store.importState().s === s;

// ---------------------------------------------------------------------------------------------------------------
// The reducer (pure)

/** A Preview as openArchive builds it, with `changes` applied. */
function preview(changes = {}) {
  return {
    format: "v2",
    kind: "manual",
    createdAt: "2026-10-04T15:30:12.345Z",
    appVersion: "1.0.0",
    device: { platform: "ios", kind: "phone", model: "iPhone" },
    incoming: { latest: "2026-10-04" },
    current: { latest: "2026-10-03" },
    olderSchema: false,
    crossPlatform: false,
    sameDevice: true,
    liveEmpty: false,
    newerLocalChanges: false,
    sourceHealthSyncOn: false,
    media: { count: 0, bytes: 0, embedded: 0, missing: 0 },
    libraryId: "library",
    ...changes,
  };
}

const RESULT = {
  recoveryId: "20261004T153012Z-ab12",
  mediaRestored: 0,
  mediaSkipped: 0,
  mediaKeptLive: 0,
  healthWasOn: false,
  libraryId: "library",
  repairs: [],
  warning: null,
};

/** Runs `events` through the reducer from `from` and returns every state. */
function walk(flow, events, from = flow.initialImport) {
  const states = [from];
  for (const event of events) states.push(flow.importFlow(states.at(-1), event));
  return states;
}

test(
  "import flow: pick, open, confirm (cancel and confirm), restore with throttled progress, done",
  { skip: vault.skip },
  async (t) => {
    const { flow } = await open(t);
    const p = preview();
    const states = walk(flow, [
      { e: "pick" },
      { e: "opened", preview: p, healthOn: true },
      { e: "restore" },
      { e: "cancel" },
      { e: "restore" },
      { e: "confirmed" },
    ]);
    assert.deepEqual(
      states.map((s) => s.s),
      ["start", "reading", "preview", "confirm", "preview", "confirm", "restoring"]
    );
    assert.deepEqual(states[1], { s: "reading", origin: "file" });
    assert.deepEqual(states[2], { s: "preview", origin: "file", preview: p, healthOn: true });
    const restoring = states.at(-1);
    assert.deepEqual(restoring, {
      s: "restoring",
      origin: "file",
      preview: p,
      step: "verify",
      percent: null,
      next: null,
    });
    assert.equal(flow.importBusy(restoring), true);

    // Step changes and every 10 % re-render; anything else returns the same object.
    const scratch = flow.importFlow(restoring, {
      e: "progress",
      p: { step: "scratch", done: 3, total: 100 },
    });
    assert.deepEqual([scratch.step, scratch.percent], ["scratch", 3]);
    assert.equal(
      flow.importFlow(scratch, { e: "progress", p: { step: "scratch", done: 9, total: 100 } }),
      scratch
    );
    const tenth = flow.importFlow(scratch, {
      e: "progress",
      p: { step: "scratch", done: 10, total: 100 },
    });
    assert.equal(tenth.percent, 10);
    const counted = flow.importFlow(tenth, {
      e: "progress",
      p: { step: "media", done: 1, total: 3 },
    });
    assert.deepEqual([counted.step, counted.percent], ["media", 33]);
    const swap = flow.importFlow(counted, { e: "progress", p: { step: "swap" } });
    assert.deepEqual([swap.step, swap.percent], ["swap", null]);
    assert.equal(flow.importFlow(swap, { e: "progress", p: { step: "swap" } }), swap);

    const done = flow.importFlow(swap, { e: "restored", result: RESULT });
    assert.deepEqual(done, { s: "done", origin: "file", preview: p, result: RESULT, next: null });
    assert.equal(flow.importBusy(done), false);
    assert.deepEqual(flow.importFlow(done, { e: "reset" }), { s: "start" });
  }
);

test(
  "import flow: an empty library restores without a confirmation; a legacy file starts at its scratch step",
  { skip: vault.skip },
  async (t) => {
    const { flow } = await open(t);
    const empty = walk(flow, [
      { e: "incoming", pending: { uri: "file:///a", origin: "file" } },
      { e: "opened", preview: preview({ liveEmpty: true }) },
      { e: "restore" },
    ]);
    assert.deepEqual(
      empty.map((s) => s.s),
      ["start", "reading", "preview", "restoring"]
    );
    assert.equal(empty[2].healthOn, false);
    const legacy = walk(flow, [
      { e: "incoming", pending: { uri: "file:///b", origin: "recovery", recoveryId: "legacy" } },
      { e: "opened", preview: preview({ format: "legacy", kind: "legacy", liveEmpty: true }) },
      { e: "restore" },
    ]).at(-1);
    assert.deepEqual([legacy.s, legacy.origin, legacy.step], ["restoring", "recovery", "scratch"]);
  }
);

test(
  "import flow: a legacy password is asked for, a wrong one keeps the form with an error, the right one opens",
  { skip: vault.skip },
  async (t) => {
    const { flow } = await open(t);
    const states = walk(flow, [
      { e: "incoming", pending: { uri: "file:///v1.json", origin: "file" } },
      { e: "needPassword" },
      { e: "unlock" },
      { e: "wrongPassword" },
      { e: "unlock" },
      { e: "opened", preview: preview({ format: "legacy", kind: "legacy" }) },
    ]);
    assert.deepEqual(states.slice(2, 6), [
      { s: "password", origin: "file", error: false, unlocking: false },
      { s: "password", origin: "file", error: false, unlocking: true },
      { s: "password", origin: "file", error: true, unlocking: false },
      { s: "password", origin: "file", error: false, unlocking: true },
    ]);
    assert.equal(flow.importBusy(states[3]), true, "a password being tried is work in progress");
    assert.equal(flow.importBusy(states[2]), false);
    assert.equal(states.at(-1).s, "preview");
    // A second unlock while one runs, and stale events, change nothing.
    assert.equal(flow.importFlow(states[3], { e: "unlock" }), states[3]);
    assert.equal(flow.importFlow(states.at(-1), { e: "wrongPassword" }), states.at(-1));
    assert.equal(
      flow.importFlow(flow.initialImport, { e: "opened", preview: preview() }).s,
      "start"
    );
  }
);

test(
  "import flow: a second file during a restore is queued and offered when it ends; at other times it replaces the flow",
  { skip: vault.skip },
  async (t) => {
    const { flow } = await open(t);
    const first = { uri: "file:///first", origin: "file" };
    const second = { uri: "file:///second", origin: "file" };
    const third = { uri: "file:///third", origin: "cloud" };
    const restoring = walk(flow, [
      { e: "incoming", pending: first },
      { e: "opened", preview: preview({ liveEmpty: true }) },
      { e: "restore" },
    ]).at(-1);
    const queued = flow.importFlow(restoring, { e: "secondIncoming", pending: second });
    assert.deepEqual([queued.s, queued.next], ["restoring", second]);
    const newest = flow.importFlow(queued, { e: "incoming", pending: third });
    assert.equal(newest.next, third, "the newest file waits");
    const done = flow.importFlow(newest, {
      e: "restored",
      result: { ...RESULT, warning: "afterRestoreFailed" },
    });
    assert.deepEqual(
      [done.s, done.result.warning, done.next],
      ["done", "afterRestoreFailed", third]
    );
    assert.deepEqual(flow.importFlow(done, { e: "incoming", pending: third }), {
      s: "reading",
      origin: "cloud",
    });
    const failed = flow.importFlow(queued, { e: "failed", code: "invalidData" });
    assert.deepEqual(failed, {
      s: "error",
      origin: "file",
      code: "invalidData",
      info: {},
      next: second,
    });

    // Not restoring: the new file replaces whatever the flow showed.
    const shown = walk(flow, [
      { e: "incoming", pending: first },
      { e: "opened", preview: preview() },
    ]).at(-1);
    assert.deepEqual(flow.importFlow(shown, { e: "secondIncoming", pending: third }), {
      s: "reading",
      origin: "cloud",
    });
    // A pick while work runs does nothing.
    assert.equal(flow.importFlow(restoring, { e: "pick" }), restoring);
  }
);

test(
  "import flow: failures keep their info for the error text; a cancellation is no error",
  { skip: vault.skip },
  async (t) => {
    const { flow } = await open(t);
    const reading = flow.importFlow(flow.initialImport, { e: "pick" });
    assert.deepEqual(
      flow.importFlow(reading, { e: "failed", code: "insufficientSpace", info: { bytes: 2e6 } }),
      { s: "error", origin: "file", code: "insufficientSpace", info: { bytes: 2e6 }, next: null }
    );
    assert.deepEqual(flow.importFlow(reading, { e: "failed", code: "cancelled" }), { s: "start" });
    assert.deepEqual(flow.importFlow(flow.initialImport, { e: "failed", code: "unsupported" }), {
      s: "error",
      origin: null,
      code: "unsupported",
      info: {},
      next: null,
    });
    const error = flow.importFlow(reading, { e: "failed", code: "corrupt" });
    assert.equal(flow.importFlow(error, { e: "pick" }).s, "reading", "Choose a file again");
  }
);

test(
  "import flow helpers: restore reasons, the repairs the done state counts, summary dates",
  { skip: vault.skip },
  async (t) => {
    const { flow } = await open(t);
    assert.equal(flow.restoreReason("file", preview()), "file");
    assert.equal(flow.restoreReason("cloud", preview()), "cloud");
    assert.equal(flow.restoreReason("handoff", preview()), "handoff");
    assert.equal(flow.restoreReason("recovery", preview()), "recovery");
    assert.equal(flow.restoreReason("recovery", preview({ format: "legacy" })), "legacyRecovery");
    const repairs = [
      { table: "sets", fatal: false, message: "fk:cascade" },
      { table: "sets", fatal: false, message: "fk:set null" },
      { table: "preferences", fatal: false, message: "two open workouts" },
    ];
    assert.equal(flow.repairCount({ ...RESULT, repairs }), 2);
    const noon = flow.summaryDate("2026-03-29");
    assert.deepEqual(
      [noon.getFullYear(), noon.getMonth(), noon.getDate(), noon.getHours()],
      [2026, 2, 29, 12]
    );
    assert.equal(
      flow.summaryDate("2026-10-04T15:30:12.345Z").toISOString(),
      "2026-10-04T15:30:12.345Z"
    );
    assert.equal(flow.summaryDate(0).getTime(), 0);
    assert.equal(flow.progressPercent({ step: "zip", done: 1, total: 0 }), null);
    assert.equal(flow.progressPercent({ step: "zip", done: 150, total: 100 }), 100);
  }
);

// ---------------------------------------------------------------------------------------------------------------
// Navigation and the recovery row

test(
  "nav: vault routes go through goVault; leaving without history goes home",
  { skip: vault.skip },
  async (t) => {
    const ctx = await open(t);
    ctx.nav.goVault("import");
    ctx.nav.goVault("import", "replace");
    ctx.nav.leaveVault();
    assert.deepEqual(
      ctx.w.called("expo-router").map((c) => [c.name, ...c.args]),
      [["push", "/vault/import"], ["replace", "/vault/import"], ["canGoBack"], ["replace", "/"]]
    );
  }
);

test(
  "recovery row: shown while a set exists (M1); ids give their creation time",
  { skip: vault.skip },
  async (t) => {
    const { recovery } = await open(t);
    const set = {
      id: "20261004T153012Z-ab12",
      createdAt: "2026-10-04T15:30:12.000Z",
      legacy: false,
    };
    assert.equal(recovery.visibleRecovery({ latestRecovery: set }, Date.parse("2027-01-01")), set);
    assert.equal(recovery.visibleRecovery({ latestRecovery: null }, Date.now()), null);
    assert.equal(recovery.recoveryCreatedAt(set.id), set.createdAt);
    assert.equal(recovery.recoveryCreatedAt("legacy"), null);
  }
);

// ---------------------------------------------------------------------------------------------------------------
// The import flow's store, end to end

test(
  "import store: a handed-over file opens, asks, restores; Settings then offers the recovery set, which restores the same way",
  { skip: vault.skip },
  async (t) => {
    const ctx = await started(t);
    const file = await exported(ctx);
    const { store, incoming } = ctx;

    incoming.setPendingIncoming({ uri: file.uri, origin: "file" });
    const detach = store.attachImportScreen();
    assert.equal(store.importState().s, "reading");
    await until(flowIs(ctx, "preview"), "the preview");
    const shown = store.importState();
    assert.equal(shown.origin, "file");
    assert.equal(shown.preview.format, "v2");
    assert.equal(shown.preview.liveEmpty, false);
    assert.equal(shown.preview.sameDevice, true);
    assert.equal(typeof shown.healthOn, "boolean");
    assert.equal(ctx.paths.liveOps().length, 1, "the opened archive is a live operation");

    store.requestRestore();
    assert.equal(store.importState().s, "confirm");
    assert.equal(store.firstSight(store.importState()), true);
    assert.equal(store.firstSight(store.importState()), false, "the alert shows once per confirm");
    store.cancelRestore();
    assert.equal(store.importState().s, "preview");
    store.requestRestore();
    store.confirmRestore();
    assert.equal(store.importState().s, "restoring");
    store.confirmRestore();
    await until(flowIs(ctx, "done"), "the done state");
    const { result } = store.importState();
    assert.match(result.recoveryId, RECOVERY_ID);
    assert.equal(result.warning, null);
    assert.deepEqual(ctx.paths.liveOps(), [], "the archive was closed after the restore");

    await store.refreshVaultStatus();
    const status = store.vaultStatus();
    assert.equal(status.latestRecovery.id, result.recoveryId);
    assert.equal(status.libraryEmpty, false);
    assert.equal(status.running, false);
    assert.equal(ctx.recovery.visibleRecovery(status, Date.now()), status.latestRecovery);

    // Back to Settings: leaving the screen ends the flow.
    detach();
    assert.deepEqual(store.importState(), { s: "start" });

    // "Restore data from before {date}": the set goes to the import screen like any file.
    assert.equal(await ctx.recovery.openRecoveryFlow(result.recoveryId), true);
    assert.deepEqual(ctx.w.called("expo-router", "push").at(-1).args, ["/vault/import"]);
    const again = store.attachImportScreen();
    t.after(again);
    assert.equal(store.importState().origin, "recovery");
    await until(flowIs(ctx, "preview"), "the recovery set's preview");
    store.requestRestore();
    store.confirmRestore();
    await until(flowIs(ctx, "done"), "the undo");
    const undo = store.importState().result;
    assert.match(undo.recoveryId, RECOVERY_ID, "undoing a restore keeps a set of its own");
    assert.notEqual(undo.recoveryId, result.recoveryId);
    assert.equal(
      await ctx.recovery.openRecoveryFlow("20200101T000000Z-zzzz"),
      false,
      "a set that is gone"
    );
    // The undo and the gone set each started a status read on the vault's connection; it finishes before the world
    // closes that connection (refreshVaultStatus returns the read in flight).
    await store.refreshVaultStatus();
  }
);

test(
  "import store: an empty library restores without asking and keeps no recovery set",
  { skip: vault.skip },
  async (t) => {
    const source = await started(t);
    const file = await exported(source);
    const ctx = await started(t, { fresh: true });
    ctx.incoming.setPendingIncoming({
      uri: carry(source, ctx, file, "carried.archive"),
      origin: "file",
    });
    const detach = ctx.store.attachImportScreen();
    t.after(detach);
    await until(flowIs(ctx, "preview"), "the preview");
    assert.equal(ctx.store.importState().preview.liveEmpty, true);
    assert.equal(ctx.store.importState().preview.sameDevice, false);
    ctx.store.requestRestore();
    assert.equal(ctx.store.importState().s, "restoring", "no confirmation");
    await until(flowIs(ctx, "done"), "the done state");
    assert.equal(ctx.store.importState().result.recoveryId, null);
    await ctx.store.refreshVaultStatus();
    assert.equal(ctx.store.vaultStatus().latestRecovery, null);
    assert.equal(ctx.store.vaultStatus().libraryEmpty, false);
  }
);

test(
  "import store: a file that is not a backup fails with its code; a picked file starts the flow; leaving ends it",
  { skip: vault.skip },
  async (t) => {
    const ctx = await started(t);
    fs.mkdirSync(ctx.w.file("in"), { recursive: true });
    fs.writeFileSync(ctx.w.file("in", "notes.txt"), "not a backup");
    ctx.w.picked.file = ctx.w.file("in", "notes.txt");
    const detach = ctx.store.attachImportScreen();
    assert.deepEqual(ctx.store.importState(), { s: "start" });
    // The failed open is reported once for diagnostics (ops.ts); nothing else may be.
    const warned = [];
    const warn = t.mock.method(console, "warn", (...args) => warned.push(args));
    await ctx.store.pickImportFile();
    assert.deepEqual(ctx.store.importState(), { s: "reading", origin: "file" });
    await until(flowIs(ctx, "error"), "the error");
    assert.equal(ctx.store.importState().code, "notArchive");
    assert.deepEqual(ctx.paths.liveOps(), []);
    warn.mock.restore();
    assert.deepEqual(
      warned.map((args) => args.slice(0, 2)),
      [["[vault]", "notArchive"]]
    );

    // A cancelled picker changes nothing.
    ctx.w.picked.file = null;
    await ctx.store.pickImportFile();
    assert.equal(ctx.store.importState().s, "error");
    detach();
    assert.deepEqual(ctx.store.importState(), { s: "start" });

    // A file handed over with no screen open waits for the next one.
    const file = await exported(ctx);
    ctx.incoming.setPendingIncoming({ uri: file.uri, origin: "file" });
    assert.deepEqual(ctx.store.importState(), { s: "start" });
    const again = ctx.store.attachImportScreen();
    await until(flowIs(ctx, "preview"), "the preview");
    // Leaving the preview closes the archive.
    again();
    assert.deepEqual(ctx.store.importState(), { s: "start" });
    assert.deepEqual(ctx.paths.liveOps(), []);
  }
);

test(
  "import store: a v1 encrypted backup asks for its password, keeps asking after a wrong one, opens with the right one",
  { skip: vault.skip },
  async (t) => {
    const ctx = await started(t);
    if (!ctx.app.legacy) {
      t.skip("this app had no v1 backups");
      return;
    }
    const { createBackup } = ctx.w.require("@/lib/backup-data");
    const { encryptBackupText } = ctx.w.require("@/lib/backup-crypto");
    const text = await encryptBackupText(
      JSON.stringify(createBackup()),
      PASSWORD,
      async (n) => new Uint8Array(randomBytes(n))
    );
    fs.mkdirSync(ctx.w.file("in"), { recursive: true });
    fs.writeFileSync(ctx.w.file("in", "backup.json"), text);
    // The two refused opens are reported once each for diagnostics (ops.ts); nothing else may be.
    const warned = [];
    const warn = t.mock.method(console, "warn", (...args) => warned.push(args));
    ctx.incoming.setPendingIncoming({ uri: ctx.w.uri("in", "backup.json"), origin: "file" });
    const detach = ctx.store.attachImportScreen();
    t.after(detach);
    await until(flowIs(ctx, "password"), "the password form");
    assert.deepEqual(ctx.store.importState(), {
      s: "password",
      origin: "file",
      error: false,
      unlocking: false,
    });
    ctx.store.unlockImport("wrong password");
    assert.equal(ctx.store.importState().unlocking, true);
    await until(() => !ctx.store.importState().unlocking, "the wrong password");
    assert.deepEqual(ctx.store.importState(), {
      s: "password",
      origin: "file",
      error: true,
      unlocking: false,
    });
    ctx.store.unlockImport(PASSWORD);
    await until(flowIs(ctx, "preview"), "the preview");
    assert.equal(ctx.store.importState().preview.format, "legacy");
    warn.mock.restore();
    assert.deepEqual(
      warned.map((args) => args.slice(0, 2)),
      [
        ["[vault]", "legacyPasswordRequired"],
        ["[vault]", "legacyPasswordWrong"],
      ]
    );
  }
);

test(
  "status: read only while no vault operation holds the lock (the self-test's copy is never shown)",
  { skip: vault.skip },
  async (t) => {
    const ctx = await started(t, { fresh: true });
    assert.equal(ctx.store.vaultStatus().libraryEmpty, false, "not read yet");
    let release;
    const held = ctx.lock.exclusive("selftest", () => new Promise((r) => (release = r)), {
      wait: true,
    });
    await ctx.store.refreshVaultStatus();
    assert.equal(ctx.store.vaultStatus().libraryEmpty, false, "deferred while the lock is held");
    release();
    await held;
    await ctx.store.refreshVaultStatus();
    assert.equal(ctx.store.vaultStatus().libraryEmpty, true);
    assert.equal(ctx.store.vaultStatus().latestRecovery, null);
    const before = ctx.store.vaultStatus();
    await ctx.store.refreshVaultStatus();
    assert.equal(ctx.store.vaultStatus(), before, "the same object while nothing changed");
  }
);

// ---------------------------------------------------------------------------------------------------------------
// Export

test(
  "export: iOS writes the file into the cache and opens the share sheet with the app's type",
  { skip: vault.skip },
  async (t) => {
    const ctx = await started(t, { platform: "ios" });
    const exporter = ctx.w.require("@/vault/ui/export");
    const steps = [];
    const stop = setInterval(() => steps.push(exporter.exportState().progress.step), 0);
    await exporter.exportData({ language: "en", dialogTitle: "Save the data" });
    clearInterval(stop);
    const state = exporter.exportState();
    assert.equal(state.busy, false);
    assert.equal(state.error, null);
    assert.equal(state.ready, null);
    const [share] = ctx.w.called("expo-sharing", "shareAsync");
    const identity = ctx.apps[ctx.app.id];
    assert.deepEqual(share.args[1], {
      mimeType: identity.mime,
      UTI: identity.uti,
      dialogTitle: "Save the data",
    });
    const uri = share.args[0];
    assert.ok(uri.includes("/Caches/PendumVault/out/"), uri);
    assert.ok(uri.endsWith(`.${identity.extension}`), uri);
    assert.ok(fs.existsSync(ctx.paths.fsPath(new ctx.File(uri))));
    assert.ok(steps.length > 0);
  }
);

test(
  "export: Android offers Save to device (a streamed copy into the picked folder) and Share",
  { skip: vault.skip },
  async (t) => {
    const ctx = await started(t, { platform: "android" });
    const exporter = ctx.w.require("@/vault/ui/export");
    await exporter.exportData({ language: "en", dialogTitle: "Save the data" });
    const { ready } = exporter.exportState();
    assert.ok(ready, "the file waits for Save to device or Share");
    assert.deepEqual(ctx.w.called("expo-sharing", "shareAsync"), []);

    const picked = path.join(ctx.w.dir, "Picked", "Downloads");
    ctx.w.picked.directory = picked;
    await exporter.saveExport();
    assert.equal(exporter.exportState().savedTo, "Downloads");
    assert.equal(exporter.exportState().error, null);
    assert.deepEqual(
      fs.readFileSync(path.join(picked, ready.name)),
      fs.readFileSync(ctx.paths.fsPath(ready))
    );

    await exporter.shareExport("Share the data");
    const [share] = ctx.w.called("expo-sharing", "shareAsync");
    assert.equal(share.args[0], ready.uri);
  }
);

test(
  "export: no share sheet is shareUnavailable; a second run while one runs does nothing",
  { skip: vault.skip },
  async (t) => {
    const ctx = await started(t, {
      platform: "ios",
      stubs: {
        "expo-sharing": (w) =>
          w.record("expo-sharing", {
            isAvailableAsync: async () => false,
            shareAsync: async () => {},
          }),
      },
    });
    const exporter = ctx.w.require("@/vault/ui/export");
    const first = exporter.exportData({ language: "en", dialogTitle: "Save" });
    assert.equal(exporter.exportState().busy, true);
    await exporter.exportData({ language: "en", dialogTitle: "Save" });
    await first;
    assert.deepEqual(exporter.exportState().error.code, "shareUnavailable");
    assert.deepEqual(ctx.w.called("expo-sharing", "shareAsync"), []);
    assert.equal(fs.readdirSync(ctx.w.file("..", "Caches", "PendumVault", "out")).length, 1);
  }
);

// ---------------------------------------------------------------------------------------------------------------
// The on-device self-test

/** Every file under a folder with its bytes, for before/after comparisons (empty when missing). */
function tree(dir) {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true }))
    if (entry.isFile()) {
      const file = path.join(entry.parentPath ?? entry.path, entry.name);
      out[path.relative(dir, file)] = fs.readFileSync(file).toString("base64");
    }
  return out;
}

test(
  "self-test: every case passes (or is skipped where the app has no photos) on a copy; the live library is untouched",
  { skip: vault.skip },
  async (t) => {
    const ctx = await started(t);
    const selftest = ctx.w.require("@/vault/dev/selftest");
    assert.equal(selftest.selfTestAvailable(), true, "development builds offer it");
    // A restore first, so the live vault has a recovery set and state worth protecting.
    const file = await exported(ctx);
    const archive = await ctx.ops.runOpen(file);
    await ctx.ops.runRestore(archive, { reason: "file" });
    archive.close();

    const copy = (name) => {
      const target = path.join(ctx.w.dir, name);
      ctx.db.runSync("VACUUM INTO ?", [target]);
      return fs.readFileSync(target).toString("base64");
    };
    const before = copy("before.db");
    const media = Object.fromEntries(
      (ctx.app.media ?? []).map((m) => [m.set, tree(ctx.w.file(m.directory))])
    );
    const vaultFiles = tree(ctx.w.file("PendumVault", "recovery"));
    const anchor = fs.readFileSync(ctx.w.file("PendumVault", "device.json"), "utf8");
    const mirror = ctx.state.vaultState();
    const calls = ctx.w.calls.length;

    const seen = [];
    const off = selftest.subscribeSelfTest(() => seen.push(selftest.selfTestState()));
    const results = await selftest.runSelfTest();
    off();
    assert.deepEqual(
      results.map((r) => r.id),
      ["hash", "G1", "G6", "G7a", "G7b", "G8", "G16"]
    );
    for (const r of results) {
      // lift and water keep no photos.
      if (r.id === "G16" && !ctx.app.media?.length) assert.equal(r.outcome, "skip", r.detail);
      else assert.equal(r.outcome, "pass", `${r.id}: ${r.detail}`);
    }
    assert.equal(selftest.selfTestState().running, false);
    assert.ok(seen.length >= results.length + 2, "the panel saw every case");

    // Nothing live changed: database, photos, recovery sets, anchor, the state mirror; no hooks ran.
    assert.equal(copy("after.db"), before);
    for (const m of ctx.app.media ?? [])
      assert.deepEqual(tree(ctx.w.file(m.directory)), media[m.set]);
    assert.deepEqual(tree(ctx.w.file("PendumVault", "recovery")), vaultFiles);
    assert.equal(fs.readFileSync(ctx.w.file("PendumVault", "device.json"), "utf8"), anchor);
    assert.deepEqual(ctx.state.vaultState(), mirror);
    assert.deepEqual(
      ctx.w.calls.slice(calls).filter((c) => !c.module.startsWith("expo-")),
      [],
      "no app hook ran"
    );
    // The engine is back on the live library, nothing of the bench is left, and the lock is free.
    assert.equal(ctx.paths.engineEnv().documentRoot.uri, ctx.Paths.document.uri);
    assert.deepEqual(ctx.paths.liveOps(), []);
    assert.deepEqual(fs.readdirSync(ctx.w.file("PendumVault", "work")), []);
    assert.equal(ctx.lock.busyWith(), null);
  }
);

test(
  "self-test: offered only in development builds or with the selftest build flag",
  { skip: vault.skip },
  async (t) => {
    const release = await open(t, { dev: false });
    assert.equal(release.w.require("@/vault/dev/selftest").selfTestAvailable(), false);
    const flagged = await open(t, { dev: false, config: { selftest: true } });
    assert.equal(flagged.w.require("@/vault/dev/selftest").selfTestAvailable(), true);
  }
);
