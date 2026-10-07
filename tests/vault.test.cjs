// Vector Vault test entry (synced, hash-checked; body, lift and macro run it through `node --test tests/*.test.cjs`).
// The test bodies live in tests/vault/<area>.cjs, one file per owning area (tooling, engine-io, engine-export, …);
// each registers its node:test cases when required. Those files and tests/vault-harness.cjs do not match the
// repos' test globs, so they run only through this entry (or its ESM twin, vault.test.mjs).
const { readdirSync } = require("node:fs");
const path = require("node:path");

const areas = path.join(module.path, "vault");
for (const file of readdirSync(areas)
  .filter((f) => f.endsWith(".cjs"))
  .sort())
  require(path.join(areas, file));
