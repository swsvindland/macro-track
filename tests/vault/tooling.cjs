// G15, tooling (synced, hash-checked; loaded by tests/vault.test.*): vault-kit's drift check on this tree, then its
// check, sync, bump and siblings rules on throwaway fixture trees in the OS temp folder — a canonical vault and
// lift-shaped repos built from this tree's own tool, never a real repo.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// tests/vault/ → the repo root (or the canonical vault).
const root = path.resolve(module.path, "..", "..");
const read = (...parts) => readFileSync(path.join(root, ...parts));
const peers = JSON.parse(read("src", "vault", "manifest.json")).peers;
const baseline = JSON.parse(read("src", "vault", "apps.json")).lift.syncIdBaseline;

const vaultKit = (dir, ...args) =>
  spawnSync(process.execPath, [path.join(dir, "scripts", "vault-kit.mjs"), ...args], {
    cwd: dir,
    encoding: "utf8",
  });
const report = (r) => `${r.stdout}\n${r.stderr}`;
const passes = (r) => assert.equal(r.status, 0, report(r));
function fails(r, pattern) {
  assert.equal(r.status, 1, report(r));
  assert.match(r.stderr, pattern, report(r));
}

const DESCRIPTOR = `import type { VaultApp } from "@/vault/types";

const SYNC_IDS = ["gyms", "workouts"] as const;

export const vaultApp: VaultApp = {
  id: "lift",
  database: { name: "lift_track.db", acquire: async () => open(), release: async () => {} },
  tables: [
    { name: "gyms", mode: "replace", role: "data" },
    { name: "workouts", mode: "replace", role: "data" },
    {
      name: "preferences",
      mode: "keys",
      role: "settings",
      keys: { keyColumn: "key", valueColumn: "value", include: ["units", "theme"] },
    },
  ],
  summary: { latest: "SELECT NULL AS v" },
  describe: (values, ctx) => [ctx.number(Number(values.workouts ?? 0))],
  syncIdTables: SYNC_IDS,
  excludedTables: ["counter_logs"],
};
`;

/** A canonical vault at <tmp>/vector-design/vault and a prepared lift repo at <tmp>/lift-track (siblings, as on disk). */
function fixture() {
  const base = mkdtempSync(path.join(os.tmpdir(), "vault-g15-"));
  const canonical = path.join(base, "vector-design", "vault");
  const repo = path.join(base, "lift-track");
  const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
  const put = (dir, file, text) => {
    const full = path.join(dir, ...file.split("/"));
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, text);
  };
  // The canonical vault: this tree's tool, versions and app table, one leaf and both entry variants.
  put(canonical, "scripts/vault-kit.mjs", read("scripts", "vault-kit.mjs"));
  put(canonical, "src/vault/version.ts", read("src", "vault", "version.ts"));
  put(canonical, "src/vault/apps.json", read("src", "vault", "apps.json"));
  put(canonical, "src/vault/errors.ts", "export const leaf = true;\n");
  put(canonical, "tests/vault.test.cjs", "// entry\n");
  put(canonical, "tests/vault.test.mjs", "// entry\n");
  // A lift repo with every prerequisite of a first sync.
  const dependencies = Object.fromEntries(
    Object.entries(peers).map(([dep, range]) => [dep, range === "*" ? "^1.0.0" : range])
  );
  put(
    repo,
    "package.json",
    json({
      name: "lift-track",
      scripts: {
        lint: "eslint . && node scripts/vault-kit.mjs check",
        test: "node --test tests/*.test.cjs",
      },
      dependencies,
    })
  );
  for (const [dep, range] of Object.entries(dependencies))
    put(
      repo,
      `node_modules/${dep}/package.json`,
      json({ name: dep, version: /\d+\.\d+\.\d+/.exec(range)[0] })
    );
  put(repo, "src/vector/manifest.json", json({ kit: "vector", version: "1.3.1" }));
  put(
    repo,
    "app.json",
    json({ expo: { plugins: ["expo-router", ["./plugins/with-vector-vault", { app: "lift" }]] } })
  );
  put(repo, "src/vault-app.ts", DESCRIPTOR);
  put(repo, "src/vault-app-ui.ts", "export function useVaultRefresh() {\n  return () => {};\n}\n");
  put(repo, "tests/vault-fixture.cjs", "module.exports = { seed() {}, levels: [], stubs: {} };\n");
  put(
    repo,
    "src/db/schema.ts",
    ["gyms", "workouts", "preferences", "counter_logs"]
      .map((t) => `export const ${t} = sqliteTable(\n  "${t}",\n  {}\n);\n`)
      .join("")
  );
  // Released migrations up to the baseline; the one at the baseline rebuilds a sync-id table, as lift's 0004 does.
  const tags = Array.from(
    { length: baseline + 1 },
    (_, idx) => `${String(idx).padStart(4, "0")}_released`
  );
  for (const tag of tags) put(repo, `drizzle/${tag}.sql`, "SELECT 1;\n");
  put(
    repo,
    `drizzle/${tags[baseline]}.sql`,
    "CREATE TABLE `__new_gyms` (`id` integer PRIMARY KEY);\n"
  );
  const journal = (extra) =>
    json({
      version: "7",
      dialect: "sqlite",
      entries: [...tags, ...extra].map((tag, idx) => ({
        idx,
        version: "6",
        when: 1790000000000 + idx,
        tag,
        breakpoints: true,
      })),
    });
  put(repo, "drizzle/meta/_journal.json", journal([]));
  const f = {
    base,
    canonical,
    repo,
    put,
    /** The first migration after the baseline, with this SQL. */
    migrate(sql) {
      const tag = `${String(baseline + 1).padStart(4, "0")}_next`;
      put(repo, `drizzle/${tag}.sql`, sql);
      put(repo, "drizzle/meta/_journal.json", journal([tag]));
    },
    gen: () => vaultKit(canonical, "gen"),
    sync: (...flags) => vaultKit(canonical, "sync", repo, ...flags),
    check: (dir = repo) => vaultKit(dir, "check"),
    ready() {
      passes(f.gen());
      passes(f.sync());
    },
  };
  return f;
}

/** A test body run against a fresh fixture, removed afterwards. */
const withFixture = (body) => () => {
  const f = fixture();
  try {
    body(f);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
};

void test("vault-kit check --drift: this tree matches its manifest", () => {
  passes(vaultKit(root, "check", "--drift"));
});

void test(
  "vault-kit: gen, sync into a prepared repo and check pass; the released rebuild at the baseline is allowed",
  withFixture((f) => {
    f.ready();
    passes(f.check(f.canonical));
    const r = f.check();
    passes(r);
    assert.doesNotMatch(r.stderr, /migration/);
    assert.equal(
      readFileSync(path.join(f.repo, "src", "vault", "version.ts"), "utf8"),
      readFileSync(path.join(f.canonical, "src", "vault", "version.ts"), "utf8")
    );
    // lift runs .cjs tests: it gets that entry only.
    assert.ok(existsSync(path.join(f.repo, "tests", "vault.test.cjs")));
    assert.ok(!existsSync(path.join(f.repo, "tests", "vault.test.mjs")));
    // A table the descriptor does not mention is a warning (never backed up), not a failure.
    f.put(f.repo, "src/db/schema.ts", 'export const links = sqliteTable("health_links", {});\n');
    const warned = f.check();
    passes(warned);
    assert.match(
      warned.stderr,
      /declares health_links, in neither the descriptor's tables nor excludedTables/
    );
  })
);

void test(
  "vault-kit: reads the descriptor's literals through real-world syntax (regex and template literals, generics, methods)",
  withFixture((f) => {
    f.ready();
    const descriptor = [
      'import type { VaultApp, VaultSql } from "@/vault/types";',
      'import { interpolate, translate } from "@/lib/translations";',
      "",
      '// tables: [{ name: "commented_out" }]',
      'const KEYS = ["units", "theme"] as const;',
      "const quote = (s: string) => s.replace(/'/g, \"''\");",
      "const placeholder = /\\{(\\w+)\\}/g;",
      "",
      "export const vaultApp: VaultApp = {",
      '  id: "lift",',
      "  database: {",
      '    acquire: async () => (await import("@/db")).expoDb,',
      '    name: "lift_track.db",',
      "    release: async () => {},",
      "  },",
      "  tables: [",
      '    { name: "gyms", mode: "replace", role: "data" },',
      "    {",
      '      name: "preferences",',
      '      mode: "keys",',
      '      role: "settings",',
      '      keys: { keyColumn: "key", valueColumn: "value", include: KEYS },',
      "    },",
      '    { name: "workouts", mode: "replace", role: "data" }, // trailing comment, trailing comma',
      "  ],",
      "  summary: {",
      '    latest: `SELECT MAX("started_at") AS v FROM "workouts" WHERE "name" != \'}]\'`,',
      "  },",
      "  describe(values, ctx) {",
      "    const n = Number(values.workouts ?? 0);",
      '    return [interpolate(translate(ctx.language, "workouts"), { count: ctx.number(n) })];',
      "  },",
      "  deviceOverrides: (ctx): VaultSql[] => [",
      '    { sql: `UPDATE "preferences" SET "value" = \'${quote(ctx.platform)}\'`, params: [] },',
      "  ],",
      "  hooks: {",
      "    pauseWhenIdle: <T,>(work: () => Promise<T>, timeoutMs: number) => work(),",
      "    afterRestore: async () => {},",
      "  },",
      "  backgroundIntervalMinutes: 1440,",
      '  syncIdTables: ["gyms", "workouts"],',
      "  excludedTables: [] as string[],",
      "};",
      "export const unused = placeholder;",
      "",
    ].join("\n");
    f.put(f.repo, "src/vault-app.ts", descriptor);
    f.put(
      f.repo,
      "src/db/schema.ts",
      ["gyms", "preferences", "workouts", "counter_logs"]
        .map((t) => `export const ${t} = sqliteTable("${t}", {});\n`)
        .join("")
    );
    const r = f.check();
    passes(r);
    // Only counter_logs is unlisted: the commented-out table and the `as string[]` list were read correctly.
    assert.match(r.stderr, /declares counter_logs, in neither/);
    // syncIdTables came through too: a rebuild of workouts after the baseline fails.
    f.migrate("CREATE TABLE `__new_workouts` (`id` integer PRIMARY KEY);\n");
    fails(f.check(), /rebuilds workouts/);
  })
);

void test(
  "vault-kit: build output of the local module is never hashed, synced or unknown",
  withFixture((f) => {
    f.put(f.canonical, "modules/vector-vault/index.ts", "export {};\n");
    f.put(f.canonical, "modules/vector-vault/android/build/intermediates/x.class", "x");
    f.put(f.canonical, "modules/vector-vault/ios/build/y.o", "y");
    f.put(f.canonical, "src/vault/.DS_Store", "z");
    f.ready();
    const manifest = JSON.parse(
      readFileSync(path.join(f.canonical, "src", "vault", "manifest.json"), "utf8")
    );
    const files = Object.keys(manifest.files);
    assert.ok(files.includes("modules/vector-vault/index.ts"));
    assert.deepEqual(
      files.filter((p) => /\/build\/|\.DS_Store/.test(p)),
      []
    );
    assert.ok(!existsSync(path.join(f.repo, "modules", "vector-vault", "android", "build")));
    // A Gradle build in the repo is not an unknown file; anything else in a vault folder is.
    f.put(f.repo, "modules/vector-vault/android/build/outputs/z.aar", "z");
    passes(f.check());
    f.put(f.repo, "modules/vector-vault/android/extra.kt", "class Extra\n");
    fails(f.check(), /unknown\s+modules\/vector-vault\/android\/extra\.kt/);
  })
);

void test(
  "vault-kit: leaf modules never reach app code, transitively, lazily or through @/vault",
  withFixture((f) => {
    f.put(
      f.canonical,
      "src/vault/app.ts",
      'import { vaultApp } from "@/vault-app";\nexport { vaultApp };\n'
    );
    f.put(f.canonical, "src/vault/types.ts", "export type VaultIssue = { table: string };\n");
    f.put(
      f.canonical,
      "src/vault/engine/helper.ts",
      'import { vaultApp } from "../app";\nexport const id = vaultApp.id;\n'
    );
    f.put(
      f.canonical,
      "src/vault/engine/db.ts",
      [
        '// The descriptor ("@/vault-app") is never imported here.',
        'import type { VaultIssue } from "@/vault/types";',
        'export { id } from "./helper";',
        "export type Issue = VaultIssue;",
        "",
      ].join("\n")
    );
    passes(f.gen());
    fails(
      f.check(f.canonical),
      /leaf\s+src\/vault\/engine\/db\.ts → src\/vault\/engine\/helper\.ts → src\/vault\/app\.ts/
    );
    // Leaves may use other leaves and the types; a comment naming the descriptor is not an import.
    f.put(
      f.canonical,
      "src/vault/engine/helper.ts",
      'import { leaf } from "@/vault/errors";\nexport const id = leaf;\n'
    );
    passes(f.gen());
    passes(f.check(f.canonical));
    // A lazy import of the descriptor, and a re-export from the UI barrel.
    f.put(
      f.canonical,
      "src/vault/engine/csv.ts",
      'export async function rows() {\n  return (await import("@/vault-app")).vaultApp;\n}\n'
    );
    f.put(f.canonical, "src/vault/incoming.ts", 'export { VaultSection } from "@/vault";\n');
    f.put(f.canonical, "src/vault/index.ts", "export const VaultSection = null;\n");
    passes(f.gen());
    const r = f.check(f.canonical);
    fails(r, /leaf\s+src\/vault\/engine\/csv\.ts → @\/vault-app/);
    assert.match(r.stderr, /leaf\s+src\/vault\/incoming\.ts → src\/vault\/index\.ts/);
  })
);

void test(
  "vault-kit: the plugin entry exists, names this app and comes after plugins that would override its keys",
  withFixture((f) => {
    f.ready();
    const plugins = (list) =>
      f.put(f.repo, "app.json", JSON.stringify({ expo: { plugins: list } }));
    const vault = ["./plugins/with-vector-vault", { app: "lift" }];
    plugins(["expo-document-picker", vault]);
    fails(f.check(), /plugin\s+app\.json lists expo-document-picker before/);
    f.put(
      f.repo,
      "plugins/with-files.js",
      "module.exports = (config) => {\n  config.ios.infoPlist.UIFileSharingEnabled = true;\n  return config;\n};\n"
    );
    plugins(["./plugins/with-files", vault]);
    fails(
      f.check(),
      /plugin\s+app\.json lists \.\/plugins\/with-files \(it sets UIFileSharingEnabled\) before/
    );
    plugins(["expo-router", vault, "./plugins/with-files", "expo-document-picker"]);
    passes(f.check());
    plugins([["./plugins/with-vector-vault", { app: "body" }]]);
    fails(f.check(), /plugin\s+app\.json \.\/plugins\/with-vector-vault option "app" is "body"/);
    plugins(["expo-router"]);
    fails(f.check(), /plugin\s+app\.json expo\.plugins lacks/);
  })
);

void test(
  "vault-kit: after the sync-id baseline, no rebuild of a sync-id table, no sync_id column, no _vault_ index",
  withFixture((f) => {
    f.ready();
    f.migrate("CREATE TABLE `__new_gyms` (`id` integer PRIMARY KEY);\n");
    fails(f.check(), /migration\s+drizzle\/\d{4}_next\.sql rebuilds gyms/);
    // preferences is a descriptor table without sync ids: a rebuild keeps nothing the vault owns.
    f.migrate("CREATE TABLE `__new_preferences` (`key` text PRIMARY KEY);\n");
    passes(f.check());
    f.migrate("ALTER TABLE `gyms` ADD `sync_id` text;\n");
    fails(f.check(), /migration\s+drizzle\/\d{4}_next\.sql adds a sync_id column/);
    f.migrate('CREATE UNIQUE INDEX IF NOT EXISTS "_vault_sid_gyms" ON "gyms" ("sync_id");\n');
    fails(f.check(), /migration\s+drizzle\/\d{4}_next\.sql creates the index _vault_sid_gyms/);
  })
);

void test(
  "vault-kit: DROP COLUMN on a descriptor table after the baseline needs its three _vault_c triggers dropped first",
  withFixture((f) => {
    f.ready();
    const drop = "ALTER TABLE `gyms` DROP COLUMN `plates`;\n";
    const triggers = (ops) =>
      ops.map((op) => `DROP TRIGGER IF EXISTS "_vault_c_gyms_${op}";\n`).join("");
    f.migrate(drop);
    fails(
      f.check(),
      /drops gyms\.plates without first running DROP TRIGGER IF EXISTS "_vault_c_gyms_i"; .*"_vault_c_gyms_u"; .*"_vault_c_gyms_d";/
    );
    f.migrate(triggers(["i", "u"]) + drop);
    fails(
      f.check(),
      /drops gyms\.plates without first running DROP TRIGGER IF EXISTS "_vault_c_gyms_d";$/m
    );
    f.migrate(drop + triggers(["i", "u", "d"]));
    fails(f.check(), /drops gyms\.plates/);
    f.migrate(`${triggers(["i", "u", "d"])}--> statement-breakpoint\n${drop}`);
    passes(f.check());
    // counter_logs is excluded, not a descriptor table: no vault triggers name its columns.
    f.migrate("ALTER TABLE `counter_logs` DROP COLUMN `value`;\n");
    passes(f.check());
  })
);

void test(
  "vault-kit: vault code never names the Node-only AbortSignal members, not even in comments",
  withFixture((f) => {
    const file = "src/vault/engine/export.ts";
    const scenario = (text) => {
      f.put(f.canonical, file, text);
      passes(f.gen());
      return f.check(f.canonical);
    };
    fails(
      scenario("export function run(signal: AbortSignal) {\n  signal.throwIfAborted();\n}\n"),
      /runtime\s+src\/vault\/engine\/export\.ts:2 uses \.throwIfAborted/
    );
    fails(
      scenario("export const why = (signal?: AbortSignal) => signal?.reason;\n"),
      /runtime\s+src\/vault\/engine\/export\.ts:1 uses signal\?\.reason/
    );
    fails(
      scenario("// never read signal.reason here\nexport {};\n"),
      /export\.ts:1 uses signal\.reason/
    );
    passes(scenario('import { leaf } from "../errors";\nexport const run = () => leaf;\n'));
    // The same guard runs in repos, over the synced routes too.
    f.put(
      f.canonical,
      "src/app/vault/import.tsx",
      "export default function Screen() {\n  return null; // controller.signal.throwIfAborted()\n}\n"
    );
    f.ready();
    fails(f.check(), /runtime\s+src\/app\/vault\/import\.tsx:2 uses \.throwIfAborted/);
  })
);

void test(
  "vault-kit: every appDelegateSubscribers name is declared by a Swift class of the module",
  withFixture((f) => {
    f.put(
      f.canonical,
      "modules/vector-vault/expo-module.config.json",
      JSON.stringify({
        platforms: ["apple", "android"],
        apple: {
          modules: ["VectorVaultModule"],
          appDelegateSubscribers: ["VaultIncomingSubscriber"],
        },
      })
    );
    f.put(
      f.canonical,
      "modules/vector-vault/ios/VectorVaultModule.swift",
      "import ExpoModulesCore\n// class VaultIncomingSubscriber arrives later\npublic class VectorVaultModule: Module {}\n"
    );
    passes(f.gen());
    fails(
      f.check(f.canonical),
      /subscriber\s+modules\/vector-vault\/expo-module\.config\.json lists VaultIncomingSubscriber/
    );
    f.put(
      f.canonical,
      "modules/vector-vault/ios/VaultIncoming.swift",
      "import ExpoModulesCore\n\npublic final class VaultIncomingSubscriber: ExpoAppDelegateSubscriber {}\n"
    );
    passes(f.gen());
    passes(f.check(f.canonical));
  })
);

void test(
  "vault-kit sync: refuses a stale canonical vault, and a repo without its prerequisites unless --force",
  withFixture((f) => {
    passes(f.gen());
    f.put(f.canonical, "src/vault/errors.ts", "export const leaf = 1;\n");
    fails(f.sync(), /the canonical vault is not current/);
    passes(f.gen());
    const bare = path.join(f.base, "water-track");
    f.put(
      bare,
      "package.json",
      JSON.stringify({
        scripts: { test: "node --test tests/*.test.mjs" },
        dependencies: { fflate: "^0.8.3" },
      })
    );
    f.put(bare, "app.json", JSON.stringify({ expo: { plugins: [] } }));
    let r = vaultKit(f.canonical, "sync", bare);
    fails(r, /prereq\s+fflate is not installed/);
    assert.match(r.stderr, /prereq\s+expo-sqlite is not in package\.json dependencies/);
    assert.match(r.stderr, /prereq\s+src\/vault-app\.ts is missing/);
    assert.match(r.stderr, /prereq\s+src\/vault-app-ui\.ts is missing/);
    assert.match(r.stderr, /prereq\s+tests\/vault-fixture\.cjs is missing/);
    assert.match(
      r.stderr,
      /prereq\s+app\.json expo\.plugins has no \.\/plugins\/with-vector-vault entry/
    );
    assert.equal(existsSync(path.join(bare, "src")), false);
    r = vaultKit(f.canonical, "sync", bare, "--force");
    passes(r);
    // water's test script runs .mjs files: it gets the ESM entry only.
    assert.ok(existsSync(path.join(bare, "tests", "vault.test.mjs")));
    assert.ok(!existsSync(path.join(bare, "tests", "vault.test.cjs")));
  })
);

void test(
  "vault-kit sync: refuses app files at vault paths and local edits unless --force; deletes only what it shipped",
  withFixture((f) => {
    // An app file where the vault ships one, before the first sync.
    f.put(f.repo, "src/vault/apps.json", "{}\n");
    passes(f.gen());
    let r = f.sync();
    fails(r, /app file\s+src\/vault\/apps\.json/);
    assert.equal(readFileSync(path.join(f.repo, "src", "vault", "apps.json"), "utf8"), "{}\n");
    assert.equal(existsSync(path.join(f.repo, "src", "vault", "manifest.json")), false);
    r = f.sync("--force");
    passes(r);
    assert.match(r.stderr, /replaced\s+src\/vault\/apps\.json/);
    passes(f.check());
    // A local edit to a synced file.
    f.put(f.repo, "src/vault/errors.ts", "export const leaf = false;\n");
    fails(f.sync(), /modified\s+src\/vault\/errors\.ts/);
    fails(f.check(), /modified\s+src\/vault\/errors\.ts/);
    passes(f.sync("--force"));
    passes(f.check());
    // The canonical vault stops shipping a file: sync deletes it. An app's own file in a vault folder is unknown:
    // sync stops on it, and with --force keeps it.
    rmSync(path.join(f.canonical, "src", "vault", "errors.ts"));
    passes(f.gen());
    f.put(f.repo, "src/vault/notes.md", "mine\n");
    fails(f.sync(), /unknown\s+src\/vault\/notes\.md/);
    passes(f.sync("--force"));
    assert.equal(existsSync(path.join(f.repo, "src", "vault", "errors.ts")), false);
    assert.equal(readFileSync(path.join(f.repo, "src", "vault", "notes.md"), "utf8"), "mine\n");
    fails(f.check(), /unknown\s+src\/vault\/notes\.md/);
  })
);

void test(
  "vault-kit check: kit version, vector.allow.json and the repo's own wiring",
  withFixture((f) => {
    f.ready();
    f.put(f.repo, "src/vector/manifest.json", JSON.stringify({ version: "1.2.2" }));
    fails(f.check(), /kit\s+Vector kit 1\.2\.2 does not satisfy >=1\.3\.1/);
    f.put(f.repo, "src/vector/manifest.json", JSON.stringify({ version: "1.3.1" }));
    f.put(
      f.repo,
      "vector.allow.json",
      JSON.stringify({
        rules: { alert: { "src/vault/ui/section.tsx": 1 } },
        eslintFiles: ["src/app/vault/import.tsx", "src/app/home.tsx"],
      })
    );
    let r = f.check();
    fails(r, /allow\s+vector\.allow\.json rules\.alert lists src\/vault\/ui\/section\.tsx/);
    assert.match(
      r.stderr,
      /allow\s+vector\.allow\.json eslintFiles lists src\/app\/vault\/import\.tsx/
    );
    assert.doesNotMatch(r.stderr, /home\.tsx/);
    rmSync(path.join(f.repo, "vector.allow.json"));
    f.put(f.repo, "src/vault-app.ts", DESCRIPTOR.replace('"lift_track.db"', '"lift.db"'));
    fails(
      f.check(),
      /wiring\s+src\/vault-app\.ts: database\.name is "lift\.db"; src\/vault\/apps\.json says "lift_track\.db"/
    );
    f.put(f.repo, "src/vault-app.ts", DESCRIPTOR);
    const pkg = JSON.parse(readFileSync(path.join(f.repo, "package.json"), "utf8"));
    f.put(
      f.repo,
      "package.json",
      JSON.stringify({
        ...pkg,
        scripts: { ...pkg.scripts, lint: "eslint ." },
        dependencies: { ...pkg.dependencies, fflate: undefined },
      })
    );
    r = f.check();
    fails(r, /wiring\s+package\.json "lint" does not run `node scripts\/vault-kit\.mjs check`/);
    assert.match(r.stderr, /wiring\s+package\.json dependencies lack fflate/);
    rmSync(path.join(f.repo, "tests", "vault-fixture.cjs"));
    fails(f.check(), /wiring\s+tests\/vault-fixture\.cjs missing/);
  })
);

void test(
  "vault-kit bump: VAULT_VERSION, the module's package.json and a changelog stub, then gen; never FORMAT_VERSION",
  withFixture((f) => {
    const version = (file) => readFileSync(path.join(f.canonical, ...file.split("/")), "utf8");
    const [major, minor] = /VAULT_VERSION = "(\d+)\.(\d+)\.\d+"/
      .exec(version("src/vault/version.ts"))
      .slice(1);
    const next = `${major}.${Number(minor) + 1}.0`;
    f.put(
      f.canonical,
      "modules/vector-vault/package.json",
      JSON.stringify(
        { name: "vector-vault", version: "0.0.0", private: true, main: "index.ts" },
        null,
        2
      )
    );
    f.put(f.canonical, "CHANGELOG.md", "# Vector Vault changelog\n\n## 0.0.0\n\n- First.\n");
    const format = /FORMAT_VERSION = \d+/.exec(version("src/vault/version.ts"))[0];
    passes(vaultKit(f.canonical, "bump", "minor"));
    assert.match(version("src/vault/version.ts"), new RegExp(`VAULT_VERSION = "${next}"`));
    assert.match(version("src/vault/version.ts"), new RegExp(format));
    assert.equal(JSON.parse(version("modules/vector-vault/package.json")).version, next);
    assert.match(
      version("CHANGELOG.md"),
      new RegExp(`^# Vector Vault changelog\\n\\n## ${next}\\n[\\s\\S]*## 0\\.0\\.0`)
    );
    assert.equal(JSON.parse(version("src/vault/manifest.json")).version, next);
    passes(f.check(f.canonical));
  })
);

void test(
  "vault-kit siblings: one version and one hash per file across the canonical vault and synced repos",
  withFixture((f) => {
    f.ready();
    let r = vaultKit(f.canonical, "siblings");
    passes(r);
    assert.match(r.stdout, /one version \(\d+\.\d+\.\d+\), one hash per file/);
    f.put(f.repo, "src/vault/errors.ts", "export const leaf = 2;\n");
    r = vaultKit(f.canonical, "siblings");
    assert.equal(r.status, 1, report(r));
    assert.match(r.stdout, /MISMATCH/);
  })
);
