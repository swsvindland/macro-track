#!/usr/bin/env node
// Vector Vault tool (docs/vault.md, "Tooling"): gen · bump · sync · check · siblings · try. Byte-identical in every
// repo. Plain Node ESM with no dependencies, mirroring vector-design/kit/scripts/vector-kit.mjs: paths derive from this
// file, never from a bare __dirname; only `try` borrows git, rsync and pnpm from the machine.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// App repos always have a package.json; the canonical vault (vector-design/vault) never does.
const CANONICAL = !fs.existsSync(path.join(ROOT, "package.json"));
// The repos the vault ships to, as siblings of vector-design. Never fitness-native.
const REPOS = [
  { name: "body", dir: "body-track" },
  { name: "lift", dir: "lift-track" },
  { name: "macro", dir: "macro-track" },
  { name: "water", dir: "water-track" },
];
const SIBLINGS = CANONICAL ? path.resolve(ROOT, "../..") : path.resolve(ROOT, "..");

const MANIFEST = "src/vault/manifest.json";
const VERSION_TS = "src/vault/version.ts";
const APPS_JSON = "src/vault/apps.json";
/** The test entry: one manifest key, two variants; each repo gets the one its `test` script runs (.mjs: water). */
const ENTRY = "tests/vault.test.cjs|tests/vault.test.mjs";
/** Vault-owned folders, walked recursively: every file under them is a synced file, or `unknown`. */
const SYNCED_ROOTS = ["src/vault", "src/app/vault", "modules/vector-vault", "tests/vault"];
/** Never walked, hashed, synced or deleted: Gradle/Xcode output of the local module, and dot-entries. */
const WALK_SKIP = [/^modules\/vector-vault\/(android|ios)\/build(\/|$)/, /(^|\/)\./];
const FIXED = [
  "scripts/vault-kit.mjs",
  "docs/vault.md",
  "plugins/with-vector-vault.js",
  "tests/vault-harness.cjs",
  ENTRY,
];
/** Files that never leave vector-design/vault. */
const CANONICAL_ONLY = ["README.md", "CHANGELOG.md", "dev/"];
/** Leaf modules: app lib code and descriptors import them, so they must never reach app code. */
const LEAVES = [
  "src/vault/engine/db.ts",
  "src/vault/engine/csv.ts",
  "src/vault/engine/provenance.ts",
  "src/vault/engine/source.ts",
  "src/vault/incoming.ts",
  "src/vault/errors.ts",
];
/** What the leaf closure must never reach: the app-code bridges and the UI barrel. */
const LEAF_TARGETS = ["src/vault/app.ts", "src/vault/app-ui.ts", "src/vault/index.ts"];
const LEAF_SPECIFIERS = ["@/vault-app", "@/vault-app-ui"];
const PRETTIER_LINES = [
  "src/vault/",
  "src/app/vault/",
  "modules/vector-vault/",
  "plugins/with-vector-vault.js",
  "scripts/vault-kit.mjs",
  "docs/vault.md",
  "tests/vault.test.*",
  "tests/vault-harness.cjs",
  "tests/vault/",
];
const PRETTIER_HEADER =
  "# Vector Vault: synced from vector-design/vault and hash-checked (vault-kit check).";
const GITIGNORE_LINES = ["modules/*/android/build/", "modules/*/ios/build/"];
const GITIGNORE_HEADER = "# Local Expo modules: Gradle and Xcode output";
const REQUIRED_DEPS = {
  fflate: "^0.8.3",
  "expo-file-system": "~57.0.6",
  "expo-sharing": "~57.0.22",
  "expo-constants": "*",
  "expo-background-task": "*",
  "expo-task-manager": "*",
  "expo-sqlite": "*",
  "drizzle-orm": "*",
  "expo-router": "*",
};
/** The kit version vault UI is written against. */
const REQUIRES_VECTOR = ">=1.3.1";
const KIT_MANIFEST = "src/vector/manifest.json";
const ALLOW = "vector.allow.json";
const PLUGIN = "./plugins/with-vector-vault";
const LINT_STEP = "node scripts/vault-kit.mjs check";
/** App-owned files every repo has before its first sync. */
const DESCRIPTOR = "src/vault-app.ts";
const UI_HOOK = "src/vault-app-ui.ts";
const FIXTURE = "tests/vault-fixture.cjs";
const DRAFTS = [
  [DESCRIPTOR, "vault-app.ts"],
  [UI_HOOK, "vault-app-ui.ts"],
  [FIXTURE, "vault-fixture.cjs"],
];
const JOURNAL = "drizzle/meta/_journal.json";
const SCHEMA = "src/db/schema.ts";
const MODULE_CONFIG = "modules/vector-vault/expo-module.config.json";
const MODULE_PACKAGE = "modules/vector-vault/package.json";
const SWIFT_DIR = "modules/vector-vault/ios";
/** React Native's AbortSignal (abort-controller@3) has neither member; comments count too. */
const NODE_ONLY_ABORT = /\.throwIfAborted\b|\bsignal\??\.reason\b/;
/** What `try` lints: every synced path plus the app-owned descriptor files. */
const LINT_TARGETS = [
  "src/vault",
  "src/app/vault",
  "src/vault-app.ts",
  "src/vault-app-ui.ts",
  "plugins/with-vector-vault.js",
  "scripts/vault-kit.mjs",
  ...ENTRY.split("|"),
  "tests/vault-harness.cjs",
  "tests/vault",
  "modules/vector-vault",
];
/** `try` never copies these: build products, store artwork, generated native projects, stale typed routes. */
const TRY_SKIP = /\.(?:ipa|apk|aab)$|^(?:store-assets|ios|android|\.expo)\//;
const STAGES = ["types", "lint", "tests"];

// ---------------------------------------------------------------------------------------------------------------
// small helpers

const abs = (root, rel) => path.join(root, ...rel.split("/"));
const exists = (root, rel) => fs.existsSync(abs(root, rel));
const readText = (root, rel) => fs.readFileSync(abs(root, rel), "utf8");
const readJson = (root, rel) => JSON.parse(readText(root, rel));
const sha = (root, rel) =>
  `sha256-${createHash("sha256")
    .update(fs.readFileSync(abs(root, rel)))
    .digest("hex")}`;
const short = (hash) => (hash ? hash.slice(7, 15) : "—");
const shown = (to) => path.relative(process.cwd(), to) || ".";
const byPath = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const variants = (key) => key.split("|");
const skipped = (file) => WALK_SKIP.some((re) => re.test(file));
const isCanonical = (root) => !fs.existsSync(path.join(root, "package.json"));
const errorText = (e) => (e instanceof Error ? e.message : String(e));
/** A report line: label column, then the detail (the kit's layout). */
const row = (label, detail) => `${label.padEnd(10)} ${detail}`;
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function readJsonOr(root, rel, fallback) {
  try {
    return readJson(root, rel);
  } catch {
    return fallback;
  }
}

function writeIfChanged(root, file, text) {
  const target = abs(root, file);
  if (fs.existsSync(target) && fs.readFileSync(target, "utf8") === text) return false;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
  return true;
}

/** Files under a repo-relative folder, sorted, as repo-relative paths. WALK_SKIP entries are never entered. */
function walk(root, rel) {
  const dir = abs(root, rel);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = `${rel}/${entry.name}`;
    if (skipped(file)) continue;
    if (entry.isDirectory()) out.push(...walk(root, file));
    else out.push(file);
  }
  return out.sort(byPath);
}

/** Every file under SYNCED_ROOTS except the manifest itself. */
const vaultFiles = (root) =>
  SYNCED_ROOTS.flatMap((r) => walk(root, r))
    .filter((f) => f !== MANIFEST)
    .sort(byPath);

/** A vault path: a file under SYNCED_ROOTS or a FIXED file. */
const isVaultPath = (file) =>
  SYNCED_ROOTS.some((r) => file === r || file.startsWith(`${r}/`)) ||
  FIXED.flatMap(variants).includes(file);

/** Whether sync may write or delete this path: a vault path, never a skipped or canonical-only one. */
const inScope = (file) =>
  !skipped(file) &&
  !CANONICAL_ONLY.some((c) => (c.endsWith("/") ? file.startsWith(c) : file === c)) &&
  isVaultPath(file);

function requireCanonical(command) {
  if (CANONICAL) return;
  console.error(
    `vault-kit ${command}: canonical only. Edit vector-design/vault, then sync (an app never edits a vault file).`
  );
  process.exit(1);
}

/** VAULT_VERSION and FORMAT_VERSION as declared in src/vault/version.ts. */
function versions(root) {
  const text = exists(root, VERSION_TS) ? readText(root, VERSION_TS) : "";
  return {
    version: /^export const VAULT_VERSION = "(\d+\.\d+\.\d+)";/m.exec(text)?.[1] ?? null,
    format: Number(/^export const FORMAT_VERSION = (\d+);/m.exec(text)?.[1] ?? Number.NaN),
  };
}

/** Which test entry a repo runs: its `test` script picks .test.mjs (water) or .test.cjs (the kit's rule). */
function testVariant(repo) {
  const test = readJsonOr(repo, "package.json", {}).scripts?.test ?? "";
  return /\.test\.mjs/.test(test) ? "tests/vault.test.mjs" : "tests/vault.test.cjs";
}

// ---------------------------------------------------------------------------------------------------------------
// versions and ranges (the subset the vault's peers use: *, ^, ~, comparators)

function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v ?? "");
  return m ? [+m[1], +m[2], +m[3]] : null;
}
function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}
function satisfies(version, range) {
  const v = parseVersion(version);
  if (!v) return false;
  const r = range.trim();
  if (r === "*" || r === "") return true;
  const base = parseVersion(r.replace(/^[\^~]/, ""));
  if ((r.startsWith("^") || r.startsWith("~")) && base) {
    const upper = r.startsWith("~")
      ? [base[0], base[1] + 1, 0]
      : base[0] > 0
        ? [base[0] + 1, 0, 0]
        : base[1] > 0
          ? [0, base[1] + 1, 0]
          : [0, 0, base[2] + 1];
    return compareVersions(v, base) >= 0 && compareVersions(v, upper) < 0;
  }
  return r.split(/\s+/).every((part) => {
    const m = /^(>=|<=|>|<|=)?(.+)$/.exec(part);
    const target = parseVersion(m[2]);
    if (!target) return false;
    const c = compareVersions(v, target);
    return { ">=": c >= 0, "<=": c <= 0, ">": c > 0, "<": c < 0, "=": c === 0 }[m[1] ?? "="];
  });
}
/** The lowest version a declared range admits ("~57.0.7" → "57.0.7"); null for "*" or a tag. */
const minVersion = (range) => /(\d+\.\d+\.\d+)/.exec(range ?? "")?.[1] ?? null;

function installedVersion(root, name) {
  try {
    const dir = fs.realpathSync(path.join(root, "node_modules", ...name.split("/")));
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// source scanning without a parser: comments out, strings and regex literals kept whole

/** If text[i] opens a string, template or regex literal, the index just past it; else -1. */
function literalEnd(text, i, prev) {
  const c = text[i];
  if (c === '"' || c === "'" || c === "`") {
    let j = i + 1;
    for (; j < text.length && text[j] !== c; j++) if (text[j] === "\\") j++;
    return j + 1;
  }
  // A slash after an operator or an opening bracket starts a regex literal; after a value it divides.
  if (c === "/" && text[i + 1] !== "/" && text[i + 1] !== "*" && /^$|[(,=:[!&|?{};>]/.test(prev)) {
    let inClass = false;
    for (let j = i + 1; j < text.length && text[j] !== "\n"; j++) {
      if (text[j] === "\\") j++;
      else if (text[j] === "[") inClass = true;
      else if (text[j] === "]") inClass = false;
      else if (text[j] === "/" && !inClass) {
        j++;
        while (/[a-z]/i.test(text[j] ?? "")) j++;
        return j;
      }
    }
  }
  return -1;
}

/** Source (JS, TS, Swift) without comments. Line breaks are kept, so line numbers stay put. */
function stripComments(text) {
  let out = "";
  let prev = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") {
      while (i + 1 < text.length && text[i + 1] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop - 1;
      continue;
    }
    const end = literalEnd(text, i, prev);
    if (end > 0) {
      out += text.slice(i, end);
      i = end - 1;
      prev = "a";
      continue;
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
  }
  return out;
}

/** Walks comment-free source, calling visit(char, index, depth) outside literals; returns the first value a visit
 *  returns other than undefined, else -1. */
function scan(text, from, visit) {
  let depth = 0;
  let prev = "";
  for (let i = from; i < text.length; i++) {
    const end = literalEnd(text, i, prev);
    if (end > 0) {
      i = end - 1;
      prev = "a";
      continue;
    }
    const c = text[i];
    if ("([{".includes(c)) depth++;
    const stop = visit(c, i, depth);
    if (stop !== undefined) return stop;
    if (")]}".includes(c)) depth--;
    if (!/\s/.test(c)) prev = c;
  }
  return -1;
}

/** The index just past the bracket group opening at text[at]; -1 when it never closes. */
const groupEnd = (text, at) =>
  scan(text, at, (c, i, depth) => (")]}".includes(c) && depth === 1 ? i + 1 : undefined));

/** The comma-separated items of a bracket group's inner text, at its own level. */
function items(groupText) {
  const inner = groupText.slice(1, -1);
  const parts = [];
  let start = 0;
  scan(inner, 0, (c, i, depth) => {
    if (c === "," && depth === 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  });
  parts.push(inner.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** The `key: value` pairs of an object literal (values as source text); methods and spreads are skipped. */
function properties(objectText) {
  const map = new Map();
  for (const part of items(objectText)) {
    const m = /^(?:([A-Za-z_$][\w$]*)|"([^"]+)"|'([^']+)')\s*:\s*([\s\S]*)$/.exec(part);
    if (m) map.set(m[1] ?? m[2] ?? m[3], m[4].trim());
  }
  return map;
}

/**
 * A value's literal source: a bracket group or string as written (a trailing `as …` / `satisfies …` dropped), or the
 * initializer of the `const` it names in the same file. null for anything computed.
 */
function literal(text, value) {
  const v = value?.trim();
  if (!v) return null;
  // What may follow a literal: nothing, or a type assertion.
  const plain = (end) =>
    end > 0 && /^(?:\s+(?:as|satisfies)\s[\s\S]*)?$/.test(v.slice(end)) ? v.slice(0, end) : null;
  if ("[{".includes(v[0])) return plain(groupEnd(v, 0));
  if ("\"'".includes(v[0])) return plain(literalEnd(v, 0, ""));
  const name = /^([A-Za-z_$][\w$]*)(?:\s+(?:as|satisfies)\s[\s\S]*)?$/.exec(v)?.[1];
  if (!name) return null;
  const decl = new RegExp(`\\bconst\\s+${escapeRegExp(name)}\\b[^=;]*=\\s*`).exec(text);
  if (!decl) return null;
  const at = decl.index + decl[0].length;
  if (!"[{".includes(text[at])) return null;
  const end = groupEnd(text, at);
  return end < 0 ? null : text.slice(at, end);
}
/** The text of a plain string literal value (no escapes, no concatenation); null otherwise. */
function stringValue(value) {
  const v = literal("", value);
  return v && /^"[^"\\]*"$|^'[^'\\]*'$/.test(v) ? v.slice(1, -1) : null;
}
function stringList(v) {
  if (!v?.startsWith("[")) return null;
  const list = items(v).map(stringValue);
  return list.every((s) => s !== null) ? list : null;
}
function tableNames(v) {
  if (!v?.startsWith("[")) return null;
  const names = items(v).map((item) =>
    item.startsWith("{") ? stringValue(properties(item).get("name")) : null
  );
  return names.every((s) => s !== null) ? names : null;
}

/**
 * What vault-kit reads from src/vault-app.ts without running it: `id`, `database.name`, the `tables` names,
 * `syncIdTables` and `excludedTables`, written as literals (or as a `const` of the same file). null when absent.
 */
function descriptorFacts(root) {
  if (!exists(root, DESCRIPTOR)) return null;
  const text = stripComments(readText(root, DESCRIPTOR));
  const decl = /\bexport\s+const\s+vaultApp\b[^=;]*=\s*/.exec(text);
  const at = decl ? text.indexOf("{", decl.index + decl[0].length) : -1;
  const end = at < 0 ? -1 : groupEnd(text, at);
  const top = end < 0 ? new Map() : properties(text.slice(at, end));
  const database = literal(text, top.get("database"));
  return {
    exported: !!decl,
    id: stringValue(top.get("id")),
    database: database?.startsWith("{") ? stringValue(properties(database).get("name")) : null,
    tables: tableNames(literal(text, top.get("tables"))),
    // Absent means no table carries sync ids (water).
    syncIdTables: top.has("syncIdTables") ? stringList(literal(text, top.get("syncIdTables"))) : [],
    excludedTables: stringList(literal(text, top.get("excludedTables"))),
  };
}

const IMPORTS =
  /\b(?:import|export)\s+(?:type\s+)?(?:[^;"'`]*?\s+from\s+)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
/** Module specifiers a source file imports, re-exports, imports lazily or requires (comments ignored). */
const specifiers = (text) =>
  [...stripComments(text).matchAll(IMPORTS)].map((m) => m[1] ?? m[2] ?? m[3]);

/** A relative or `@/vault…` specifier as a repo-relative file; null for packages and other app aliases. */
function resolveImport(root, from, spec) {
  let base;
  if (spec === "@/vault" || spec.startsWith("@/vault/")) base = `src/${spec.slice(2)}`;
  else if (spec.startsWith(".")) base = path.posix.join(path.posix.dirname(from), spec);
  else return null;
  const candidates = ["", ".ts", ".tsx", ".js", ".json", "/index.ts", "/index.tsx"].map(
    (x) => base + x
  );
  return candidates.find((c) => exists(root, c) && fs.statSync(abs(root, c)).isFile()) ?? null;
}

// ---------------------------------------------------------------------------------------------------------------
// manifest

/** Manifest keys of the canonical vault: every file under SYNCED_ROOTS, then the FIXED files it has. */
const vaultKeys = (root) => [
  ...vaultFiles(root),
  ...FIXED.filter((key) => variants(key).every((v) => exists(root, v))),
];
/** FIXED files the canonical vault does not have yet: not hashed, so not synced. */
const missingFixed = (root) => FIXED.filter((key) => !variants(key).every((v) => exists(root, v)));

function buildManifest(root) {
  const { version, format } = versions(root);
  if (!version || !Number.isInteger(format))
    throw new Error(
      `gen: ${VERSION_TS} must declare VAULT_VERSION = "x.y.z" and FORMAT_VERSION = n`
    );
  const files = {};
  for (const key of vaultKeys(root))
    files[key] = variants(key)
      .map((v) => sha(root, v))
      .join("|");
  return {
    kit: "vault",
    version,
    format,
    files,
    requires: { vector: REQUIRES_VECTOR },
    peers: REQUIRED_DEPS,
  };
}

/** JSON.stringify(…, 2), with arrays of strings on one line when they fit in 100 columns (Prettier's JSON style). */
const manifestText = (m) =>
  JSON.stringify(m, null, 2).replace(
    /^( *)("[^"\n]*": )\[\n((?: *"[^"\n]*",?\n)+) *\]/gm,
    (whole, indent, key, body) => {
      const inline = `${indent}${key}[${body
        .trim()
        .split(/,?\n\s*/)
        .join(", ")}]`;
      return inline.length <= 100 ? inline : whole;
    }
  ) + "\n";

// ---------------------------------------------------------------------------------------------------------------
// gen

function gen() {
  requireCanonical("gen");
  const m = buildManifest(ROOT);
  const wrote = writeIfChanged(ROOT, MANIFEST, manifestText(m));
  const later = missingFixed(ROOT);
  if (later.length)
    console.warn(
      `vault-kit warn: not in the canonical vault yet (not hashed, not synced): ${later.join(", ")}`
    );
  console.log(
    `vault-kit ${m.version} gen · ${Object.keys(m.files).length} files hashed · ${wrote ? `wrote ${MANIFEST}` : "no changes"}`
  );
  return 0;
}

// ---------------------------------------------------------------------------------------------------------------
// check: drift

function versionReport(root, m) {
  const v = versions(root);
  const problems = [];
  if (v.version !== m.version)
    problems.push(row("version", `manifest ${m.version} ≠ ${VERSION_TS} ${v.version ?? "?"}`));
  if (v.format !== m.format)
    problems.push(row("version", `manifest format ${m.format} ≠ FORMAT_VERSION ${v.format}`));
  return problems;
}

/** Files whose bytes differ from the manifest, missing files, and files under SYNCED_ROOTS it does not list. */
function driftReport(root, m) {
  const problems = [];
  const canonical = isCanonical(root);
  for (const [key, hashes] of Object.entries(m.files)) {
    const names = variants(key);
    const expected = hashes.split("|");
    const present = names.filter((v) => exists(root, v));
    // A repo has the one entry variant it runs; the canonical vault has both.
    const absent = canonical
      ? names.filter((v) => !present.includes(v))
      : present.length
        ? []
        : names;
    if (absent.length) problems.push(row("missing", absent.join(" or ")));
    for (const v of present)
      if (sha(root, v) !== expected[names.indexOf(v)]) problems.push(row("modified", v));
  }
  const known = new Set(Object.keys(m.files).flatMap(variants));
  for (const file of vaultFiles(root))
    if (!known.has(file)) problems.push(row("unknown", `${file} (vault-owned folder)`));
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------
// check: rules that hold in the canonical vault and in every repo

function appsReport(root) {
  const apps = readJsonOr(root, APPS_JSON, null);
  if (!apps) return [row("apps", `${APPS_JSON} is missing or not JSON`)];
  const strings = [
    "name",
    "bundleId",
    "extension",
    "uti",
    "mime",
    "typeName",
    "fileStem",
    "database",
    "journal",
  ];
  const problems = [];
  for (const { name } of REPOS) {
    const a = apps[name];
    const bad = !a
      ? ["the whole row"]
      : [
          ...strings.filter((k) => typeof a[k] !== "string" || !a[k]),
          ...(Array.isArray(a.mediaDirs) ? [] : ["mediaDirs"]),
          ...(Number.isInteger(a.syncIdBaseline) ? [] : ["syncIdBaseline"]),
        ];
    if (bad.length) problems.push(row("apps", `${APPS_JSON} "${name}": ${bad.join(", ")}`));
  }
  return problems;
}

function kitReport(root, m) {
  const range = m.requires?.vector ?? REQUIRES_VECTOR;
  // The canonical vault has no kit of its own; it is checked against the canonical kit beside it.
  const file = isCanonical(root)
    ? path.join(root, "..", "kit", ...KIT_MANIFEST.split("/"))
    : abs(root, KIT_MANIFEST);
  if (!fs.existsSync(file))
    return isCanonical(root)
      ? []
      : [row("kit", `${KIT_MANIFEST} not found: vault UI needs the Vector kit ${range}`)];
  const version = JSON.parse(fs.readFileSync(file, "utf8")).version;
  return satisfies(version, range)
    ? []
    : [row("kit", `Vector kit ${version} does not satisfy ${range}: sync the kit first`)];
}

/** vector.allow.json must never baseline a vault path: vault code is written to have zero kit-rule hits. */
function allowReport(root) {
  if (!exists(root, ALLOW)) return [];
  const allow = readJsonOr(root, ALLOW, {});
  const listed = [
    ...Object.entries(allow.rules ?? {}).flatMap(([rule, files]) =>
      Object.keys(files ?? {}).map((f) => [f, `rules.${rule}`])
    ),
    ...(allow.eslintFiles ?? []).map((f) => [f, "eslintFiles"]),
  ];
  return listed
    .filter(([f]) => isVaultPath(f))
    .map(([f, where]) => row("allow", `${ALLOW} ${where} lists ${f}; fix the vault code instead`));
}

/** The leaf closure: relative and `@/vault…` imports from a leaf never reach app code or the UI barrel. */
function leafReport(root) {
  const problems = new Set();
  for (const leaf of LEAVES.filter((f) => exists(root, f))) {
    const parent = new Map([[leaf, null]]);
    const queue = [leaf];
    const chain = (file) => {
      const out = [];
      for (let f = file; f; f = parent.get(f)) out.unshift(f);
      return out;
    };
    while (queue.length) {
      const file = queue.shift();
      for (const spec of specifiers(readText(root, file))) {
        const target = LEAF_SPECIFIERS.includes(spec) ? spec : resolveImport(root, file, spec);
        if (!target) continue;
        if (LEAF_SPECIFIERS.includes(target) || LEAF_TARGETS.includes(target))
          problems.add(
            row(
              "leaf",
              `${[...chain(file), target].join(" → ")} (a leaf module must never reach app code)`
            )
          );
        else if (!parent.has(target) && /\.[cm]?[jt]sx?$/.test(target)) {
          parent.set(target, file);
          queue.push(target);
        }
      }
    }
  }
  return [...problems];
}

/** Every iOS app-delegate subscriber the module config lists is declared by a Swift class (else iOS cannot build). */
function subscriberReport(root) {
  if (!exists(root, MODULE_CONFIG)) return [];
  let config;
  try {
    config = readJson(root, MODULE_CONFIG);
  } catch (e) {
    return [row("subscriber", `${MODULE_CONFIG}: ${errorText(e)}`)];
  }
  const names = [
    ...(config.apple?.appDelegateSubscribers ?? []),
    ...(config.ios?.appDelegateSubscribers ?? []),
  ];
  const swift = exists(root, SWIFT_DIR)
    ? fs
        .readdirSync(abs(root, SWIFT_DIR))
        .filter((f) => f.endsWith(".swift"))
        .map((f) => stripComments(readText(root, `${SWIFT_DIR}/${f}`)))
    : [];
  return names
    .filter(
      (name) =>
        !swift.some((s) => new RegExp(`\\bclass\\s+${escapeRegExp(String(name))}\\b`).test(s))
    )
    .map((name) =>
      row(
        "subscriber",
        `${MODULE_CONFIG} lists ${name}, but no ${SWIFT_DIR}/*.swift declares \`class ${name}\`: every iOS build would fail`
      )
    );
}

/** Node-only AbortSignal members in vault code (comments included): they do not exist on a device. */
function runtimeReport(root) {
  const problems = [];
  for (const file of [...walk(root, "src/vault"), ...walk(root, "src/app/vault")]) {
    const lines = readText(root, file).split("\n");
    lines.forEach((text, i) => {
      if (NODE_ONLY_ABORT.test(text))
        problems.push(
          row(
            "runtime",
            `${file}:${i + 1} uses ${NODE_ONLY_ABORT.exec(text)[0]}: React Native's AbortSignal has only \`aborted\`; call checkAborted(signal) from src/vault/errors.ts`
          )
        );
    });
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------
// check: repo wiring and migration guards

const pluginName = (entry) => (Array.isArray(entry) ? entry[0] : entry);

/** expo.plugins of app.json, or null when the repo has no readable app.json. */
function plugins(root) {
  const app = readJsonOr(root, "app.json", null);
  return app ? (app.expo?.plugins ?? []) : null;
}

/** Whether a local config plugin (a path listed in expo.plugins) touches UIFileSharingEnabled. */
function setsFileSharing(root, name) {
  const base = path.posix.normalize(name);
  const file = ["", ".js", ".cjs", ".mjs", ".ts", "/index.js"]
    .map((x) => base + x)
    .find((f) => exists(root, f) && fs.statSync(abs(root, f)).isFile());
  return !!file && /UIFileSharingEnabled/.test(readText(root, file));
}

function pluginReport(root, appId) {
  const list = plugins(root);
  if (!list) return [row("plugin", "app.json not found or not JSON")];
  const at = list.findIndex((p) => pluginName(p) === PLUGIN);
  if (at < 0)
    return [
      row(
        "plugin",
        `app.json expo.plugins lacks ["${PLUGIN}", { "app": "${appId ?? "<id>"}" }]; append it as the last entry`
      ),
    ];
  const problems = [];
  const option = Array.isArray(list[at]) ? list[at][1]?.app : undefined;
  if (appId && option !== appId)
    problems.push(
      row(
        "plugin",
        `app.json ${PLUGIN} option "app" is ${JSON.stringify(option)}; the descriptor's id is "${appId}"`
      )
    );
  // Plugins listed earlier run their mods later, so they could strip or override the vault's Info.plist keys.
  for (const entry of list.slice(0, at)) {
    const name = pluginName(entry);
    if (name === "expo-document-picker")
      problems.push(
        row(
          "plugin",
          `app.json lists expo-document-picker before ${PLUGIN}; list the vault after it`
        )
      );
    else if (typeof name === "string" && name.startsWith(".") && setsFileSharing(root, name))
      problems.push(
        row(
          "plugin",
          `app.json lists ${name} (it sets UIFileSharingEnabled) before ${PLUGIN}; list the vault after it`
        )
      );
  }
  return problems;
}

function wiringReport(root, apps, facts, warnings) {
  const problems = [];
  const fail = (detail) => problems.push(row("wiring", detail));
  if (!facts) fail(`${DESCRIPTOR} missing: the app's descriptor (docs/vault.md)`);
  else if (!facts.exported) fail(`${DESCRIPTOR} does not \`export const vaultApp\``);
  if (!exists(root, UI_HOOK)) fail(`${UI_HOOK} missing: the app's refresh hook (docs/vault.md)`);
  else if (!/\bexport\s+function\s+useVaultRefresh\b/.test(readText(root, UI_HOOK)))
    fail(`${UI_HOOK} does not \`export function useVaultRefresh\``);
  if (!exists(root, FIXTURE)) fail(`${FIXTURE} missing: the app's test fixture (docs/vault.md)`);
  if (facts?.exported) {
    if (!facts.id || !apps?.[facts.id])
      fail(
        `${DESCRIPTOR}: write \`id\` as one of "${REPOS.map((r) => r.name).join('", "')}" (a literal)`
      );
    else if (facts.database !== apps[facts.id].database)
      fail(
        `${DESCRIPTOR}: database.name is ${JSON.stringify(facts.database)}; ${APPS_JSON} says "${apps[facts.id].database}" (write it as a literal)`
      );
  }
  const pkg = readJsonOr(root, "package.json", {});
  if (!(pkg.scripts?.lint ?? "").includes(LINT_STEP))
    fail(`package.json "lint" does not run \`${LINT_STEP}\`: append " && ${LINT_STEP}"`);
  for (const [dep, range] of Object.entries(REQUIRED_DEPS)) {
    const declared = pkg.dependencies?.[dep];
    if (!declared) {
      fail(
        `package.json dependencies lack ${dep} (pnpm add ${dep}${range === "*" ? "" : `@${range}`})`
      );
      continue;
    }
    const version = installedVersion(root, dep);
    if (!version) warnings.push(`${dep} is not installed (pnpm install)`);
    else if (!satisfies(version, range)) warnings.push(`${dep} ${version} outside ${range}`);
    else if (minVersion(declared) && !satisfies(minVersion(declared), range))
      warnings.push(`package.json declares ${dep}@${declared}; the vault expects ${range}`);
  }
  problems.push(...pluginReport(root, facts?.id ?? null));
  return problems;
}

const REBUILD = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"[]?__new_(\w+)/gi;
const ADD_SYNC_ID = /\bADD\s+(?:COLUMN\s+)?[`"[]?sync_id\b/i;
const VAULT_INDEX = /\bINDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"[]?(_vault_\w*)/i;
const DROP_COLUMN = /\bALTER\s+TABLE\s+[`"[]?(\w+)[`"\]]?\s+DROP\s+(?:COLUMN\s+)?[`"[]?(\w+)/gi;
const dropTrigger = (table, op) =>
  new RegExp(
    `\\bDROP\\s+TRIGGER\\s+IF\\s+EXISTS\\s+[\`"[]?_vault_c_${escapeRegExp(table)}_${op}\\b`,
    "i"
  );

/**
 * Migrations after apps.json syncIdBaseline: no rebuild of a sync-id table (it would drop the runtime-owned column),
 * no `sync_id` column or `_vault_*` index (both are vault-owned), and no DROP COLUMN on a descriptor table unless the
 * same file first drops its three change-counter triggers (SQLite refuses DROP COLUMN while a trigger names it).
 */
function migrationReport(root, apps, facts, warnings) {
  const id = facts?.id;
  if (!id || !apps?.[id] || !exists(root, JOURNAL)) return [];
  const baseline = apps[id].syncIdBaseline;
  const tables = facts.tables;
  const syncIds = facts.syncIdTables ?? tables;
  if (!tables)
    warnings.push(
      `${DESCRIPTOR}: tables are not literal; the migration guards apply to every table`
    );
  const problems = [];
  const fail = (detail) => problems.push(row("migration", detail));
  for (const entry of readJsonOr(root, JOURNAL, {}).entries ?? []) {
    if (!(entry.idx > baseline)) continue;
    const file = `drizzle/${entry.tag}.sql`;
    if (!exists(root, file)) continue;
    const sql = readText(root, file);
    for (const m of sql.matchAll(REBUILD))
      if (!syncIds || syncIds.includes(m[1]))
        fail(
          `${file} rebuilds ${m[1]} (\`__new_${m[1]}\`): a rebuild drops its runtime-owned sync_id; migrate additively`
        );
    if (ADD_SYNC_ID.test(sql))
      fail(`${file} adds a sync_id column: sync_id is vault-owned (docs/vault.md)`);
    const index = VAULT_INDEX.exec(sql);
    if (index) fail(`${file} creates the index ${index[1]}: _vault_* objects are vault-owned`);
    for (const m of sql.matchAll(DROP_COLUMN)) {
      const [, table, column] = m;
      if (tables && !tables.includes(table)) continue;
      const before = sql.slice(0, m.index);
      const missing = ["i", "u", "d"].filter((op) => !dropTrigger(table, op).test(before));
      if (missing.length)
        fail(
          `${file} drops ${table}.${column} without first running ${missing.map((op) => `DROP TRIGGER IF EXISTS "_vault_c_${table}_${op}";`).join(" ")}`
        );
    }
  }
  return problems;
}

/** Warnings only: Prettier and git ignore lines, and schema tables the descriptor does not mention. */
function repoWarnings(root, facts) {
  const warnings = [];
  const pkg = readJsonOr(root, "package.json", {});
  const usesPrettier =
    fs
      .readdirSync(root)
      .some((f) => f.startsWith(".prettierrc") || f.startsWith("prettier.config.")) ||
    !!(pkg.devDependencies?.prettier ?? pkg.dependencies?.prettier ?? pkg.prettier);
  const lines = (file) =>
    exists(root, file)
      ? readText(root, file)
          .split(/\r?\n/)
          .map((l) => l.trim())
      : [];
  const prettier = lines(".prettierignore");
  const unformatted = PRETTIER_LINES.filter((l) => !prettier.includes(l));
  if (usesPrettier && unformatted.length)
    warnings.push(
      `.prettierignore lacks ${unformatted.join(" ")} (\`pnpm format\` would rewrite vault files)`
    );
  const git = lines(".gitignore");
  const untracked = GITIGNORE_LINES.filter((l) => !git.includes(l));
  if (untracked.length)
    warnings.push(`.gitignore lacks ${untracked.join(" ")} (Gradle/Xcode output of local modules)`);
  if (facts?.exported && exists(root, SCHEMA)) {
    if (!facts.tables || !facts.excludedTables)
      warnings.push(
        `${DESCRIPTOR}: tables or excludedTables are not literal; schema coverage not checked`
      );
    else {
      const listed = new Set([...facts.tables, ...facts.excludedTables]);
      const unlisted = [...readText(root, SCHEMA).matchAll(/sqliteTable\(\s*["'`](\w+)/g)]
        .map((m) => m[1])
        .filter((t) => !listed.has(t));
      if (unlisted.length)
        warnings.push(
          `${SCHEMA} declares ${unlisted.join(", ")}, in neither the descriptor's tables nor excludedTables (never backed up)`
        );
    }
  }
  return warnings;
}

// ---------------------------------------------------------------------------------------------------------------
// check

/** `check`: drift, then (unless --drift) the kit version, allow list, leaf closure, runtime and subscriber guards,
 *  and in repos the wiring and migration guards. */
function check({ driftOnly }) {
  if (!exists(ROOT, MANIFEST)) {
    console.error(
      `vault-kit check: ${MANIFEST} not found (${CANONICAL ? "run gen" : "sync the vault first"})`
    );
    return 1;
  }
  const m = readJson(ROOT, MANIFEST);
  const failures = [...versionReport(ROOT, m), ...driftReport(ROOT, m)];
  const drift = failures.length;
  const warnings = [];
  if (!driftOnly) {
    const apps = readJsonOr(ROOT, APPS_JSON, null);
    failures.push(
      ...appsReport(ROOT),
      ...kitReport(ROOT, m),
      ...allowReport(ROOT),
      ...leafReport(ROOT),
      ...subscriberReport(ROOT),
      ...runtimeReport(ROOT)
    );
    if (CANONICAL) {
      const later = missingFixed(ROOT);
      if (later.length) warnings.push(`not in the canonical vault yet: ${later.join(", ")}`);
    } else {
      const facts = descriptorFacts(ROOT);
      failures.push(
        ...wiringReport(ROOT, apps, facts, warnings),
        ...migrationReport(ROOT, apps, facts, warnings)
      );
      warnings.push(...repoWarnings(ROOT, facts));
    }
  }
  for (const w of warnings) console.warn(`vault-kit warn: ${w}`);
  const scope = driftOnly ? " (rules not checked: --drift)" : "";
  if (failures.length) {
    for (const f of failures) console.error(`  ${f}`);
    console.error(
      `vault-kit ${m.version} FAILED · ${drift} drift · ${failures.length - drift} rule failures${scope}`
    );
    if (drift)
      console.error(
        CANONICAL
          ? "Run `node scripts/vault-kit.mjs gen` after editing vault files."
          : "Vault files are read-only in app repos: change vector-design/vault, then `vault-kit sync`."
      );
    return 1;
  }
  console.log(`vault-kit ${m.version} ok · 0 drift · ${Object.keys(m.files).length} files${scope}`);
  return 0;
}

// ---------------------------------------------------------------------------------------------------------------
// sync (canonical → repos)

/** What a repo needs before its first sync: synced routes and tests would otherwise break Metro, tsc and tests. */
function prerequisites(repo) {
  const missing = [];
  const pkg = readJsonOr(repo, "package.json", {});
  for (const dep of Object.keys(REQUIRED_DEPS)) {
    if (!pkg.dependencies?.[dep])
      missing.push(`${dep} is not in package.json dependencies (pnpm add ${dep})`);
    else if (!exists(repo, `node_modules/${dep}/package.json`))
      missing.push(`${dep} is not installed (pnpm install)`);
  }
  for (const file of [DESCRIPTOR, UI_HOOK, FIXTURE])
    if (!exists(repo, file))
      missing.push(`${file} is missing (app-owned; start from vector-design/vault/dev/<app>/)`);
  if (!(plugins(repo) ?? []).some((p) => pluginName(p) === PLUGIN))
    missing.push(`app.json expo.plugins has no ${PLUGIN} entry`);
  return missing;
}

/** Removes now-empty folders from `file`'s folder up to (not including) its synced root. */
function pruneEmptyDirs(repo, file) {
  const top = SYNCED_ROOTS.find((r) => file.startsWith(`${r}/`));
  for (
    let dir = path.posix.dirname(file);
    top && dir.startsWith(`${top}/`);
    dir = path.posix.dirname(dir)
  ) {
    if (fs.readdirSync(abs(repo, dir)).length) break;
    fs.rmdirSync(abs(repo, dir));
  }
}

function syncRepo(repo, m, { force, quiet = false }) {
  const log = quiet ? () => {} : console.log;
  if (!fs.existsSync(path.join(repo, "package.json"))) {
    console.error(`vault-kit sync: ${shown(repo)} is not an app repo (no package.json)`);
    return 1;
  }
  if (!force) {
    const missing = prerequisites(repo);
    if (missing.length) {
      for (const p of missing) console.error(`  ${row("prereq", p)}`);
      console.error(
        `vault-kit sync: ${shown(repo)} lacks ${missing.length} prerequisites (docs/vault.md, "Wiring a repo"); the synced routes and tests would break it. --force only for throwaway copies.`
      );
      return 1;
    }
  }
  const repoManifest = exists(repo, MANIFEST) ? readJsonOr(repo, MANIFEST, { files: {} }) : null;
  if (repoManifest && !force) {
    const edited = driftReport(repo, repoManifest).filter((p) => !p.startsWith("missing"));
    if (edited.length) {
      for (const p of edited) console.error(`  ${p}`);
      console.error(
        `vault-kit sync: ${shown(repo)} has local edits in vault files; move them into vector-design/vault, or pass --force.`
      );
      return 1;
    }
  }
  const variant = testVariant(repo);
  const files = [...Object.keys(m.files).map((key) => (key === ENTRY ? variant : key)), MANIFEST];
  // Only the files the repo's own manifest lists are vault-owned there; anything else at a vault path is the app's.
  const owned = new Set([...Object.keys(repoManifest?.files ?? {}).flatMap(variants), MANIFEST]);
  const differs = (file) =>
    exists(repo, file) &&
    !fs.readFileSync(abs(repo, file)).equals(fs.readFileSync(abs(ROOT, file)));
  const foreign = files.filter((file) => !owned.has(file) && differs(file));
  if (foreign.length && !force) {
    for (const f of foreign) console.error(`  ${row("app file", f)}`);
    console.error(
      `vault-kit sync: ${shown(repo)} has ${foreign.length} app-owned files at vault paths; review them, then pass --force to replace them.`
    );
    return 1;
  }
  let changed = 0;
  for (const file of files) {
    if (!inScope(file))
      throw new Error(`sync: refusing to write ${file}, outside the vault's paths`);
    if (exists(repo, file) && !differs(file)) continue;
    fs.mkdirSync(path.dirname(abs(repo, file)), { recursive: true });
    fs.copyFileSync(abs(ROOT, file), abs(repo, file));
    changed++;
  }
  // Delete only what an earlier sync shipped and the canonical vault no longer does.
  const keep = new Set(files);
  let removed = 0;
  for (const file of owned) {
    if (keep.has(file) || !inScope(file) || !exists(repo, file)) continue;
    fs.rmSync(abs(repo, file));
    pruneEmptyDirs(repo, file);
    removed++;
  }
  log(
    `synced vector-vault ${m.version} → ${shown(repo)} (${files.length} files, ${changed} changed${removed ? `, ${removed} removed` : ""}, ${path.basename(variant)})`
  );
  if (foreign.length && !quiet) {
    console.warn(
      `vault-kit sync: --force replaced ${foreign.length} app-owned files (review with git diff):`
    );
    for (const f of foreign) console.warn(`  replaced  ${f}`);
  }
  for (const f of vaultFiles(repo).filter((file) => !keep.has(file)))
    if (!quiet)
      console.warn(
        `vault-kit sync: kept ${f} (not a vault file; vault folders are vault-owned, move it out)`
      );
  const todo = repoWarnings(repo, descriptorFacts(repo));
  if (todo.length && !quiet) {
    console.warn(`vault-kit sync: app-owned wiring for ${shown(repo)}:`);
    for (const t of todo) console.warn(`  todo      ${t}`);
  }
  return 0;
}

/** The canonical manifest, refusing when the canonical files no longer match it (gen not run). */
function currentManifest(command) {
  if (!exists(ROOT, MANIFEST)) {
    console.error(
      `vault-kit ${command}: ${MANIFEST} not found; run \`node scripts/vault-kit.mjs gen\` first.`
    );
    return null;
  }
  const m = readJson(ROOT, MANIFEST);
  const drift = [...versionReport(ROOT, m), ...driftReport(ROOT, m)];
  if (drift.length) {
    for (const p of drift) console.error(`  ${p}`);
    console.error(
      `vault-kit ${command}: the canonical vault is not current; run \`node scripts/vault-kit.mjs gen\` first.`
    );
    return null;
  }
  return m;
}

function sync(repos, { force }) {
  requireCanonical("sync");
  if (!repos.length) {
    console.error("usage: vault-kit sync <repo…> [--force]");
    return 1;
  }
  const m = currentManifest("sync");
  if (!m) return 1;
  let status = 0;
  for (const arg of repos) if (syncRepo(path.resolve(arg), m, { force }) !== 0) status = 1;
  return status;
}

// ---------------------------------------------------------------------------------------------------------------
// siblings (version + hash matrix across the canonical vault and the repos)

function siblings() {
  if (!exists(ROOT, MANIFEST)) {
    console.error(`vault-kit siblings: ${MANIFEST} not found`);
    return 1;
  }
  const columns = [];
  if (CANONICAL) columns.push({ name: "vault", dir: ROOT });
  for (const repo of REPOS) {
    const dir = path.join(SIBLINGS, repo.dir);
    if (fs.existsSync(dir)) columns.push({ name: repo.name, dir });
  }
  // The vault reaches each repo with that repo's own unit of work: a repo that has not synced yet is listed, not compared.
  const synced = columns.map((c) => exists(c.dir, MANIFEST));
  const reference = readJson(ROOT, MANIFEST);
  const versionsRow = columns.map((c, i) => (synced[i] ? readJson(c.dir, MANIFEST).version : "—"));
  let mismatch = new Set(versionsRow.filter((v, i) => synced[i])).size > 1;
  const rows = [["version", ...versionsRow]];
  for (const key of Object.keys(reference.files)) {
    columns.forEach((c, i) => {
      if (synced[i] && !variants(key).some((v) => exists(c.dir, v))) mismatch = true;
    });
    for (const variant of variants(key)) {
      const cells = columns.map((c, i) =>
        synced[i] && exists(c.dir, variant) ? sha(c.dir, variant) : null
      );
      if (new Set(cells.filter(Boolean)).size > 1) mismatch = true;
      rows.push([variant, ...cells.map(short)]);
    }
  }
  const header = ["file", ...columns.map((c) => c.name)];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (r) => r.map((cell, i) => String(cell).padEnd(widths[i])).join("  ");
  console.log(line(header));
  for (const r of rows) console.log(line(r));
  const pending = columns.filter((c, i) => !synced[i]).map((c) => c.name);
  console.log(
    mismatch
      ? "vault-kit siblings: MISMATCH"
      : `vault-kit siblings: one version (${versionsRow.find((v, i) => synced[i]) ?? "—"}), one hash per file${pending.length ? ` (not synced yet: ${pending.join(", ")})` : ""}`
  );
  return mismatch ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------------------------
// bump

function bump(level) {
  requireCanonical("bump");
  if (!["patch", "minor", "major"].includes(level)) {
    console.error("usage: vault-kit bump <patch|minor|major>");
    return 1;
  }
  const text = readText(ROOT, VERSION_TS);
  const current = /^export const VAULT_VERSION = "(\d+)\.(\d+)\.(\d+)";/m.exec(text);
  if (!current) throw new Error(`${VERSION_TS} has no VAULT_VERSION`);
  const [maj, min, pat] = current.slice(1).map(Number);
  const next =
    level === "major"
      ? `${maj + 1}.0.0`
      : level === "minor"
        ? `${maj}.${min + 1}.0`
        : `${maj}.${min}.${pat + 1}`;
  writeIfChanged(
    ROOT,
    VERSION_TS,
    text.replace(current[0], `export const VAULT_VERSION = "${next}";`)
  );
  // FORMAT_VERSION is never bumped here: a format change is a deliberate code edit with its own changelog entry.
  if (exists(ROOT, MODULE_PACKAGE))
    writeIfChanged(
      ROOT,
      MODULE_PACKAGE,
      readText(ROOT, MODULE_PACKAGE).replace(/"version":\s*"[^"]*"/, `"version": "${next}"`)
    );
  else console.warn(`vault-kit bump: ${MODULE_PACKAGE} not found; nothing to rewrite there`);
  const log = exists(ROOT, "CHANGELOG.md")
    ? readText(ROOT, "CHANGELOG.md")
    : "# Vector Vault changelog\n";
  const stub = `## ${next}\n\n- (${level}) Describe the change: files, contract or format touched, and why.\n\n`;
  const at = log.search(/^## /m);
  writeIfChanged(
    ROOT,
    "CHANGELOG.md",
    at < 0 ? `${log.trimEnd()}\n\n${stub}` : log.slice(0, at) + stub + log.slice(at)
  );
  console.log(
    `vault-kit bump ${level}: ${current.slice(1).join(".")} → ${next} (fill in the CHANGELOG.md stub)`
  );
  return gen();
}

// ---------------------------------------------------------------------------------------------------------------
// try: type-check, lint and test the canonical vault inside a throwaway copy of a repo (never the repo itself)

const MAX_OUTPUT = 256 * 1024 * 1024;

function runStep(label, command, args, cwd) {
  const started = Date.now();
  const r = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: MAX_OUTPUT });
  const ok = r.status === 0;
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`  ${ok ? "ok    " : "FAILED"}  ${label} (${seconds} s)`);
  if (!ok) {
    const out =
      `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? `\n${errorText(r.error)}` : ""}`.trimEnd();
    const lines = out.split("\n");
    for (const l of lines.slice(-120)) console.log(`          ${l}`);
    if (lines.length > 120)
      console.log(`          … ${lines.length - 120} earlier lines (rerun with --keep)`);
  }
  return ok;
}

function copyRepo(repo, copy) {
  const listed = execFileSync("git", ["-C", repo, "ls-files", "-co", "--exclude-standard", "-z"], {
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT,
  })
    .split("\0")
    .filter(Boolean);
  // Generated type files the repo's tsconfig includes but git ignores (expo-env.d.ts, uniwind-types.d.ts).
  const typings = fs.readdirSync(repo).filter((f) => f.endsWith(".d.ts"));
  const files = [...new Set([...listed, ...typings])].filter((f) => {
    if (TRY_SKIP.test(f)) return false;
    try {
      const stat = fs.lstatSync(path.join(repo, f));
      return stat.isFile() || stat.isSymbolicLink();
    } catch {
      return false; // tracked, deleted in the working tree
    }
  });
  const list = `${copy}.files`;
  fs.writeFileSync(list, `${files.join("\0")}\0`);
  try {
    execFileSync("rsync", ["-a", "--from0", `--files-from=${list}`, `${repo}/`, `${copy}/`], {
      stdio: "pipe",
    });
  } finally {
    fs.rmSync(list, { force: true });
  }
  return files.length;
}

/** A real node_modules in the copy: pnpm hard-links from its store; nothing is written to the original repo. */
function installModules(repo, copy) {
  const install = spawnSync("pnpm", ["install", "--offline", "--frozen-lockfile"], {
    cwd: copy,
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT,
  });
  const missing = Object.keys(REQUIRED_DEPS).filter(
    (d) => !readJson(copy, "package.json").dependencies?.[d]
  );
  if (install.status === 0) {
    if (missing.length) {
      const add = spawnSync("pnpm", ["add", "--offline", ...missing], {
        cwd: copy,
        encoding: "utf8",
        maxBuffer: MAX_OUTPUT,
      });
      if (add.status !== 0)
        console.warn(`vault-kit try: pnpm add --offline ${missing.join(" ")} failed in the copy`);
    }
    return `pnpm install --offline${missing.length ? ` + pnpm add ${missing.join(" ")}` : ""}`;
  }
  // Offline resolution failed: clone the repo's own node_modules (APFS clone; a plain copy elsewhere).
  const tail = `${install.stdout ?? ""}${install.stderr ?? ""}`
    .trim()
    .split("\n")
    .slice(-5)
    .join(" | ");
  console.warn(
    `vault-kit try: pnpm install --offline failed (${tail}); cloning the repo's node_modules`
  );
  const target = path.join(copy, "node_modules");
  // The failed install leaves a partial node_modules behind, and `cp -R` into an existing folder would nest the clone
  // at node_modules/node_modules: start from an empty slot.
  fs.rmSync(target, { recursive: true, force: true });
  const clone = spawnSync("cp", ["-c", "-R", path.join(repo, "node_modules"), target]);
  if (clone.status !== 0) {
    fs.rmSync(target, { recursive: true, force: true });
    execFileSync("cp", ["-R", path.join(repo, "node_modules"), target]);
  }
  const unresolved = Object.keys(REQUIRED_DEPS).filter(
    (d) => !exists(copy, `node_modules/${d}/package.json`)
  );
  if (unresolved.length)
    console.warn(`vault-kit try: not resolvable in the copy: ${unresolved.join(", ")}`);
  return "cloned node_modules";
}

function appendLines(root, file, header, lines) {
  const text = exists(root, file) ? readText(root, file) : "";
  const have = text.split(/\r?\n/).map((l) => l.trim());
  const add = lines.filter((l) => !have.includes(l));
  if (!add.length) return false;
  fs.writeFileSync(
    abs(root, file),
    `${text.replace(/\n*$/, "\n")}\n${header}\n${add.join("\n")}\n`
  );
  return true;
}

/** The app-owned wiring a unit adds before its first sync, added here to the copy only. */
function wireCopy(copy, app) {
  const done = [];
  const appJson = readJson(copy, "app.json");
  appJson.expo.plugins ??= [];
  if (!appJson.expo.plugins.some((p) => pluginName(p) === PLUGIN)) {
    appJson.expo.plugins.push([
      PLUGIN,
      { app: app.name, icloud: false, google: { iosClientId: null, android: false } },
    ]);
    fs.writeFileSync(abs(copy, "app.json"), `${JSON.stringify(appJson, null, 2)}\n`);
    done.push("plugin entry");
  }
  const pkg = readJson(copy, "package.json");
  pkg.scripts ??= {};
  if (!(pkg.scripts.lint ?? "").includes(LINT_STEP)) {
    pkg.scripts.lint = pkg.scripts.lint ? `${pkg.scripts.lint} && ${LINT_STEP}` : LINT_STEP;
    fs.writeFileSync(abs(copy, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
    done.push("lint step");
  }
  if (appendLines(copy, ".prettierignore", PRETTIER_HEADER, PRETTIER_LINES))
    done.push(".prettierignore");
  if (appendLines(copy, ".gitignore", GITIGNORE_HEADER, GITIGNORE_LINES)) done.push(".gitignore");
  for (const [target, draft] of DRAFTS) {
    if (exists(copy, target)) continue;
    const source = `dev/${app.name}/${draft}`;
    if (!exists(ROOT, source)) {
      console.warn(`vault-kit try: no ${source} draft; ${target} stays missing`);
      continue;
    }
    fs.mkdirSync(path.dirname(abs(copy, target)), { recursive: true });
    fs.copyFileSync(abs(ROOT, source), abs(copy, target));
    done.push(`${target} from ${source}`);
  }
  return done;
}

/** The repo's own test command, restricted to the vault entry (water keeps its TZ and --experimental-strip-types). */
function testCommand(copy) {
  const variant = testVariant(copy);
  const script = readJsonOr(copy, "package.json", {}).scripts?.test ?? "";
  const restricted = script.replace(/tests\/\*\.test\.[cm]js/, variant);
  return restricted !== script ? restricted : `node --test ${variant}`;
}

function runStage(stage, copy) {
  if (stage === "types")
    return [runStep("tsc --noEmit", "pnpm", ["exec", "tsc", "--noEmit"], copy)];
  if (stage === "lint") {
    const targets = LINT_TARGETS.filter((t) => exists(copy, t));
    return [
      runStep(
        `eslint --max-warnings 0 (${targets.length} vault paths)`,
        "pnpm",
        ["exec", "eslint", "--max-warnings", "0", ...targets],
        copy
      ),
      runStep("vector-kit check", "node", ["scripts/vector-kit.mjs", "check"], copy),
      runStep("vault-kit check", "node", ["scripts/vault-kit.mjs", "check"], copy),
    ];
  }
  const command = testCommand(copy);
  return [runStep(command, "sh", ["-c", command], copy)];
}

function tryRepo(arg, { keep, only }) {
  requireCanonical("try");
  const repo = path.resolve(arg ?? "");
  const app = REPOS.find((r) => r.dir === path.basename(repo));
  if (!arg || !app || !fs.existsSync(path.join(repo, "package.json"))) {
    console.error(
      `usage: vault-kit try <repo-dir> [--keep] [--only ${STAGES.join("|")}] (one of ${REPOS.map((r) => r.dir).join(", ")})`
    );
    return 1;
  }
  if (only !== undefined && !STAGES.includes(only)) {
    console.error(`vault-kit try: --only takes ${STAGES.join(" | ")}`);
    return 1;
  }
  const m = currentManifest("try");
  if (!m) return 1;
  const scratch = process.env.VAULT_SCRATCH || os.tmpdir();
  fs.mkdirSync(scratch, { recursive: true });
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  const copy = fs.mkdtempSync(path.join(scratch, `vault-try-${app.name}-${stamp}-`));
  const results = [];
  try {
    const count = copyRepo(repo, copy);
    const modules = installModules(repo, copy);
    console.log(
      `vault-kit try ${app.name}: ${count} files of ${shown(repo)} → ${copy} (${modules})`
    );
    if (syncRepo(copy, m, { force: true, quiet: true }) !== 0) return 1;
    const wired = wireCopy(copy, app);
    console.log(
      `  synced vector-vault ${m.version}${wired.length ? `; wired ${wired.join(", ")}` : ""}`
    );
    for (const stage of only ? [only] : STAGES)
      results.push([stage, runStage(stage, copy).every(Boolean)]);
  } finally {
    if (keep) console.log(`vault-kit try: kept ${copy}`);
    else fs.rmSync(copy, { recursive: true, force: true });
  }
  const failed = results.filter(([, ok]) => !ok);
  console.log(
    `vault-kit try ${app.name}: ${results.map(([stage, ok]) => `${stage} ${ok ? "ok" : "FAILED"}`).join(" · ")}`
  );
  return failed.length ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------------------------
// CLI

const USAGE = `vault-kit — Vector Vault package tool (docs/vault.md, "Tooling")
  gen                          canonical: hash the vault into ${MANIFEST}
  bump <patch|minor|major>     canonical: bump VAULT_VERSION and the module's package.json, changelog stub, gen
  sync <repo…> [--force]       canonical: copy the vault into repos; refuses a repo without its prerequisites, with
                               local edits to vault files or with app files at vault paths, unless --force
  check                        drift, kit version, allow list, leaf closure, runtime and subscriber guards; in a repo
                               also its wiring and the migration guards
  check --drift                version and hashes only (the test entry runs it)
  siblings                     version + hash matrix across the canonical vault and ../{body,lift,macro,water}-track
  try <repo-dir> [--keep] [--only types|lint|tests]
                               canonical: tsc, eslint, both checks and the vault tests in a throwaway copy of a repo`;

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const flag = (name) => rest.includes(name);
  const valueOf = (name) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : undefined);
  const positional = rest.filter((a, i) => !a.startsWith("--") && rest[i - 1] !== "--only");
  switch (command) {
    case "gen":
      return gen();
    case "bump":
      return bump(positional[0]);
    case "sync":
      return sync(positional, { force: flag("--force") });
    case "check":
      return check({ driftOnly: flag("--drift") });
    case "siblings":
      return siblings();
    case "try":
      return tryRepo(positional[0], { keep: flag("--keep"), only: valueOf("--only") });
    default:
      console.log(USAGE);
      return command && command !== "help" && command !== "--help" ? 1 : 0;
  }
}

try {
  process.exitCode = main() ?? 0;
} catch (e) {
  console.error(`vault-kit: ${e?.stack ?? e}`);
  process.exitCode = 1;
}
