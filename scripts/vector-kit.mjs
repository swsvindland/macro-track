#!/usr/bin/env node
// Vector Kit tool (KIT.md §3): gen · check · sync · siblings · bump. Byte-identical in every repo.
// Plain Node ESM with no dependencies: typescript, eslint and the Uniwind toolchain are borrowed from the repo's own
// node_modules only by the commands that need them. Paths derive from this file, never from a bare __dirname.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import Module, { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// App repos always have a package.json; the canonical kit (vector-design/kit) never does.
const CANONICAL = !fs.existsSync(path.join(ROOT, "package.json"));
const APPS = ["body", "lift", "macro", "water"];
const SIBLINGS = CANONICAL ? path.resolve(ROOT, "../..") : path.resolve(ROOT, "..");

const TOKENS_JSON = "src/vector/tokens.json";
const TOKENS_CSS = "src/vector/tokens.css";
const TOKENS_TS = "src/vector/tokens.ts";
const SWIFT = "targets/_shared/VectorTheme.swift";
const MANIFEST = "src/vector/manifest.json";
const TESTS = "tests/vector.test.cjs|tests/vector.test.mjs";
const GALLERY_ROUTE = "src/app/vector-gallery.tsx";
const FIXED = [
  "docs/design-system.md",
  "scripts/vector-kit.mjs",
  "eslint.vector.cjs",
  "assets/fonts/Inter.ttf",
  "assets/fonts/IBMPlexMono-Regular.ttf",
  "assets/fonts/Inter-OFL.txt",
  "assets/fonts/IBMPlexMono-OFL.txt",
  SWIFT,
  TESTS,
];
const OPTIONAL = [SWIFT, GALLERY_ROUTE];
const SHIMS = ["src/components/system.tsx", "src/components/ui.tsx"];
const ALLOW = "vector.allow.json";

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

function writeIfChanged(root, file, text) {
  const target = abs(root, file);
  if (fs.existsSync(target) && fs.readFileSync(target, "utf8") === text) return false;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
  return true;
}

function walk(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out.sort();
}

function requireCanonical(command) {
  if (CANONICAL) return;
  console.error(
    `vector-kit ${command}: canonical only. Edit vector-design/kit, then sync (an app never edits a kit file).`
  );
  process.exit(1);
}

/** Resolves a package from the repo's node_modules (typescript, eslint, …). null when not installed. */
function repoRequire(root, name) {
  try {
    return createRequire(path.join(root, "package.json"))(name);
  } catch {
    return null;
  }
}

function installedVersion(root, name) {
  try {
    const dir = fs.realpathSync(path.join(root, "node_modules", ...name.split("/")));
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// token generation (tokens.json → tokens.css block, tokens.ts, VectorTheme.swift block)

const HEX = /^#[0-9A-F]{6}$/i;
const lower = (v) => (HEX.test(v) ? v.toLowerCase() : v);

function resolveColor(T, mode, name, seen = new Set()) {
  const tok = T.color[name];
  if (!tok) throw new Error(`tokens.json: unknown token @${name}`);
  const v = tok[mode];
  if (typeof v === "string" && v.startsWith("@")) {
    const ref = v.slice(1);
    if (seen.has(ref)) throw new Error(`tokens.json: reference cycle at @${ref}`);
    seen.add(ref);
    return resolveColor(T, mode, ref, seen);
  }
  return v;
}

// Increase Contrast value: explicit hc*, else follow the reference chain in HC mode (surface-foreground follows
// foreground's HC value).
function hcValue(T, mode, name) {
  const tok = T.color[name];
  const key = mode === "light" ? "hcLight" : "hcDark";
  if (tok[key]) return tok[key];
  const base = tok[mode];
  if (typeof base === "string" && base.startsWith("@")) return hcValue(T, mode, base.slice(1));
  return base;
}
const hcResolved = (T, mode, name) => {
  const hc = hcValue(T, mode, name);
  return typeof hc === "string" && hc.startsWith("@") ? resolveColor(T, mode, hc.slice(1)) : hc;
};

function cssBlock(T) {
  const L = [];
  L.push(
    `/* TOKENS:BEGIN — generated from src/vector/tokens.json by scripts/vector-kit.mjs gen (kit ${T.version}). Do not edit. */`
  );
  L.push("@theme {");
  L.push(
    "  /* Families: only the bundled faces (useFonts aliases). Tailwind font-medium/semibold/bold therefore"
  );
  L.push(
    "     select a family, not a weight; weights are explicit numbers in kit components and the COMPONENTS block. */"
  );
  for (const [k, v] of Object.entries(T.fonts.families)) L.push(`  --font-${k}: "${v}";`);
  L.push("");
  for (const [k, [size, lh]] of Object.entries(T.text)) {
    L.push(`  --text-${k}: ${size}px;`);
    L.push(`  --text-${k}--line-height: ${lh}px;`);
  }
  for (const [k, v] of Object.entries(T.tracking)) L.push(`  --tracking-${k}: ${v};`);
  L.push("");
  L.push(
    "  /* One control/panel radius (4) and one mark radius (2). Monotonic; 3xl=4 means HeroUI can never draw a pill. */"
  );
  for (const [k, v] of Object.entries(T.radius)) L.push(`  --${k}: ${v}px;`);
  L.push("");
  for (const [k, v] of Object.entries(T.static)) L.push(`  --${k}: ${v};`);
  L.push("}");
  L.push("");
  // `static`, like HeroUI's own `@theme inline static`: without it Uniwind's runtime registry has no --color-tint,
  // so useThemeColor('tint') / useCSSVariable('--color-tint') would return undefined (utilities work either way).
  L.push("@theme inline static {");
  for (const k of T.twInline) L.push(`  --color-${k}: var(--${k});`);
  L.push("  --color-field-border-focus: var(--focus);");
  for (const [k, tok] of Object.entries(T.color))
    if (tok.tw) L.push(`  --color-${k}: var(--${k});`);
  for (const [k, v] of Object.entries(T.twDerived ?? {}))
    if (!k.startsWith("$")) L.push(`  --color-${k}: ${v};`);
  L.push("}");
  L.push("");
  L.push("@layer theme {");
  L.push("  :root {");
  for (const mode of ["light", "dark"]) {
    L.push(`    @variant ${mode} {`);
    for (const [k, tok] of Object.entries(T.color)) {
      const v = tok[mode];
      const out = typeof v === "string" && v.startsWith("@") ? `var(--${v.slice(1)})` : lower(v);
      L.push(`      --${k}: ${out};`);
    }
    L.push("    }");
  }
  L.push("  }");
  L.push("}");
  L.push("/* TOKENS:END */");
  return L.join("\n");
}

// Generated files are written in the repos' Prettier style (printWidth 100, unquoted keys), so `prettier --check`
// passes on them even where .prettierignore misses the kit.
const tsKey = (k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k));
const tsValue = (v) =>
  v && typeof v === "object"
    ? `{ ${Object.entries(v)
        .map(([k, x]) => `${tsKey(k)}: ${tsValue(x)}`)
        .join(", ")} }`
    : JSON.stringify(v);
const tsConst = (name, obj) => [
  `export const ${name} = {`,
  ...Object.entries(obj).map(([k, v]) => `  ${tsKey(k)}: ${tsValue(v)},`),
  "} as const;",
];

function tsFile(T) {
  const names = Object.keys(T.color);
  const camel = (s) => s.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
  const L = [];
  L.push(
    `// GENERATED from src/vector/tokens.json by scripts/vector-kit.mjs gen (kit ${T.version}). Do not edit.`
  );
  L.push(`export const KIT_VERSION = "${T.version}";`);
  for (const mode of ["light", "dark"]) {
    L.push(`export const ${mode} = {`);
    for (const n of names) L.push(`  ${camel(n)}: ${JSON.stringify(resolveColor(T, mode, n))},`);
    L.push("} as const;");
  }
  L.push("/** Increase Contrast overrides (only tokens that change). */");
  L.push("export const highContrast = {");
  for (const mode of ["light", "dark"]) {
    L.push(`  ${mode}: {`);
    for (const n of names) {
      // References (surface-foreground → foreground) follow their target through var(); only literals are swapped.
      if (String(T.color[n][mode]).startsWith("@")) continue;
      const hc = hcResolved(T, mode, n);
      if (hc !== resolveColor(T, mode, n)) L.push(`    "--${n}": ${JSON.stringify(hc)},`);
    }
    L.push("  },");
  }
  L.push("} as const;");
  L.push(...tsConst("fonts", T.fonts.families));
  L.push(
    `export const radius = { mark: ${T.radius["radius-mark"]}, control: ${T.radius["radius-control"]}, panel: ${T.radius["radius-panel"]} } as const;`
  );
  const native = {
    accent: T.native.accent,
    widgetBackground: T.native.widgetBackground,
    singleHexCyan: T.native.singleHexCyan,
    androidPrimary: T.native.androidPrimary,
  };
  L.push(...tsConst("native", native));
  L.push("export type TokenName = keyof typeof light;");
  return L.join("\n") + "\n";
}

function swiftBlock(T) {
  const hx = (v) => {
    if (!HEX.test(v)) throw new Error(`tokens.json: a Swift token must be hex: ${v}`);
    return "0x" + v.slice(1).toUpperCase();
  };
  const L = [];
  L.push(
    `// TOKENS:BEGIN — generated from src/vector/tokens.json by scripts/vector-kit.mjs gen (kit ${T.version}). Do not edit.`
  );
  L.push("enum VectorTokens {");
  L.push(`    static let version = "${T.version}"`);
  for (const [n, tok] of Object.entries(T.color)) {
    if (!tok.swift) continue;
    const l = resolveColor(T, "light", n);
    const d = resolveColor(T, "dark", n);
    L.push(
      `    static let ${tok.swift} = VectorRGB(light: ${hx(l)}, dark: ${hx(d)}, hcLight: ${hx(hcResolved(T, "light", n))}, hcDark: ${hx(hcResolved(T, "dark", n))})`
    );
  }
  L.push(`    static let markRadius: CGFloat = ${T.radius["radius-mark"]}`);
  L.push(`    static let controlRadius: CGFloat = ${T.radius["radius-control"]}`);
  L.push("}");
  L.push("// TOKENS:END");
  return L.join("\n");
}

function splice(file, text, block, begin, end) {
  const a = text.indexOf(begin);
  const b = text.indexOf(end);
  if (a < 0 || b < 0) throw new Error(`${file}: TOKENS markers not found`);
  const lineStart = text.lastIndexOf("\n", a) + 1;
  const lineEnd = text.indexOf("\n", b);
  return text.slice(0, lineStart) + block + text.slice(lineEnd < 0 ? text.length : lineEnd);
}

/** What `gen` would write, computed in memory from this root's tokens.json. */
function generated(root) {
  const T = readJson(root, TOKENS_JSON);
  const out = {
    [TOKENS_CSS]: splice(
      TOKENS_CSS,
      readText(root, TOKENS_CSS),
      cssBlock(T),
      "/* TOKENS:BEGIN",
      "/* TOKENS:END */"
    ),
    [TOKENS_TS]: tsFile(T),
  };
  if (exists(root, SWIFT))
    out[SWIFT] = splice(
      SWIFT,
      readText(root, SWIFT),
      swiftBlock(T),
      "// TOKENS:BEGIN",
      "// TOKENS:END"
    );
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// manifest

/** Manifest keys, from the canonical copy: everything under src/vector plus the fixed kit files. */
function kitKeys(root) {
  const vector = walk(abs(root, "src/vector"))
    .map((f) => `src/vector/${f}`)
    .filter((f) => f !== MANIFEST);
  const keys = ["src/global.css", ...vector, ...FIXED];
  if (exists(root, GALLERY_ROUTE)) keys.push(GALLERY_ROUTE);
  return keys;
}

function buildManifest(root) {
  const T = readJson(root, TOKENS_JSON);
  const files = {};
  for (const key of kitKeys(root)) {
    const variants = key.split("|");
    const missing = variants.filter((v) => !exists(root, v));
    if (missing.length) throw new Error(`gen: canonical kit is missing ${missing.join(", ")}`);
    files[key] = variants.map((v) => sha(root, v)).join("|");
  }
  const peers = Object.fromEntries(Object.entries(T.peers).filter(([k]) => !k.startsWith("$")));
  return { kit: "vector", version: T.version, files, optional: OPTIONAL, peers };
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
  const changed = [];
  for (const [file, text] of Object.entries(generated(ROOT)))
    if (writeIfChanged(ROOT, file, text)) changed.push(file);
  const m = buildManifest(ROOT);
  if (writeIfChanged(ROOT, MANIFEST, manifestText(m))) changed.push(MANIFEST);
  console.log(
    `vector-kit ${m.version} gen · ${Object.keys(m.files).length} files hashed · ${changed.length ? `wrote ${changed.join(", ")}` : "no changes"}`
  );
}

// ---------------------------------------------------------------------------------------------------------------
// check: drift

function hasTargets(root) {
  return fs.existsSync(abs(root, "targets")) && fs.statSync(abs(root, "targets")).isDirectory();
}

/** Kit files whose bytes differ from the manifest, missing required files, and unknown files in src/vector. */
function driftReport(root, m) {
  const problems = [];
  const optional = new Set(m.optional ?? []);
  for (const [key, hashes] of Object.entries(m.files)) {
    const variants = key.split("|");
    const expected = hashes.split("|");
    const present = variants.filter((v) => exists(root, v));
    const required = key === SWIFT ? hasTargets(root) : !optional.has(key);
    if (!present.length) {
      if (required) problems.push(`missing   ${variants.join(" or ")}`);
      continue;
    }
    for (const v of present) {
      if (sha(root, v) !== expected[variants.indexOf(v)]) problems.push(`modified  ${v}`);
    }
  }
  const known = new Set(Object.keys(m.files).flatMap((k) => k.split("|")));
  for (const f of walk(abs(root, "src/vector"))) {
    const file = `src/vector/${f}`;
    if (file !== MANIFEST && !known.has(file))
      problems.push(`unknown   ${file} (src/vector is kit-owned)`);
  }
  return problems;
}

function generatedReport(root) {
  const problems = [];
  try {
    for (const [file, text] of Object.entries(generated(root))) {
      if (!exists(root, file) || readText(root, file) !== text)
        problems.push(`stale     ${file} (tokens.json changed without gen)`);
    }
  } catch (e) {
    problems.push(`generate  ${e.message}`);
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------
// check: peers (warn only)

function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([\w.]+))?/.exec(v);
  if (!m) return null;
  return { nums: [+m[1], +m[2], +m[3]], pre: m[4] ? m[4].split(".") : [] };
}
function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a.nums[i] !== b.nums[i]) return a.nums[i] - b.nums[i];
  if (!a.pre.length || !b.pre.length) return b.pre.length - a.pre.length;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny && +x !== +y) return +x - +y;
    if (nx !== ny) return nx ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
function satisfies(version, range) {
  const v = parseVersion(version);
  if (!v) return false;
  return range.split(/\s+/).every((part) => {
    const m = /^(>=|<=|>|<|=)?(.+)$/.exec(part);
    const target = parseVersion(m[2]);
    if (!target) return false;
    const c = compareVersions(v, target);
    return { ">=": c >= 0, "<=": c <= 0, ">": c > 0, "<": c < 0, "=": c === 0 }[m[1] ?? "="];
  });
}

function peerWarnings(root, m) {
  if (CANONICAL) return [];
  const warnings = [];
  for (const [name, range] of Object.entries(m.peers ?? {})) {
    if (name === "@bacons/apple-targets" && !hasTargets(root)) continue;
    const v = installedVersion(root, name);
    if (!v) warnings.push(`${name} not installed (kit expects ${range})`);
    else if (!satisfies(v, range)) warnings.push(`${name} ${v} outside ${range}`);
  }
  warnings.push(...prettierWarnings(root, m));
  return warnings;
}

/** The .prettierignore lines MIGRATION S1 adds: kit files are hash-checked, so `pnpm format` must never touch them. */
const PRETTIER_LINES = [
  "src/vector/",
  "src/global.css",
  "src/app/vector-gallery.tsx",
  "docs/design-system.md",
  "scripts/vector-kit.mjs",
  "eslint.vector.cjs",
  "tests/vector.test.*",
];

/** gitignore-style match (the subset .prettierignore files use: *, **, ?, a leading or trailing /, no negation). */
function ignoredBy(lines, file) {
  return lines.some((raw) => {
    let p = raw.trim();
    if (!p || p.startsWith("#") || p.startsWith("!")) return false;
    const dir = p.endsWith("/");
    p = p.replace(/\/$/, "");
    const anchored = p.startsWith("/") || p.includes("/");
    p = p.replace(/^\//, "");
    const glob = p
      .split("**")
      .map((part) =>
        part
          .split(/([*?])/)
          .map((t) =>
            t === "*" ? "[^/]*" : t === "?" ? "[^/]" : t.replace(/[.+^${}()|[\]\\]/g, "\\$&")
          )
          .join("")
      )
      .join(".*");
    // A name matches the file itself or any parent directory; a trailing / only a directory.
    return new RegExp(`${anchored ? "^" : "(?:^|/)"}${glob}${dir ? "/" : "(?:/|$)"}`).test(file);
  });
}

/** Warns when Prettier would reformat a synced kit file: a missing .prettierignore, or one that misses kit paths. */
function prettierWarnings(root, m) {
  let pkg = {};
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  } catch {}
  const usesPrettier =
    fs.readdirSync(root).some((f) => /^\.prettierrc/.test(f) || /^prettier\.config\./.test(f)) ||
    !!(pkg.devDependencies?.prettier ?? pkg.dependencies?.prettier ?? pkg.prettier);
  if (!usesPrettier) return [];
  const ignore = path.join(root, ".prettierignore");
  const lines = fs.existsSync(ignore) ? fs.readFileSync(ignore, "utf8").split(/\r?\n/) : [];
  const kitFiles = Object.keys(m.files)
    .flatMap((k) => k.split("|"))
    .concat(MANIFEST)
    .filter((f) => exists(root, f) && /\.(?:[cm]?[jt]sx?|json|css|md)$/.test(f));
  const missed = kitFiles.filter((f) => !ignoredBy(lines, f));
  if (!missed.length) return [];
  return [
    `${fs.existsSync(ignore) ? ".prettierignore does not skip" : "no .prettierignore:"} ${missed.length} kit files (${missed.slice(0, 3).join(", ")}${missed.length > 3 ? ", …" : ""}); \`pnpm format\` would rewrite them (hash drift). Add: ${PRETTIER_LINES.join(" ")}`,
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// check: app-code rules (KIT.md §3.3), counted per file against vector.allow.json

const NO_BASELINE = new Set(["removed-token", "accent", "accent-alias", "raw-heroui-tabs"]);
// Rules added after 1.0.0, with the kit version that added each. A repo whose vector.allow.json predates that
// version (no `kit` field counts as 1.0.0) gets warnings for it until its next `check --baseline`, so syncing a
// newer kit never fails `pnpm lint` on code that was already there.
const RULE_SINCE = { lines: "1.2.0", "accent-alias": "1.2.1" };
const RULE_HELP = {
  hex: "hex or rgb() colour literal: use a token",
  "rn-text": "Text / TextInput from react-native: use Text / Field from @/vector",
  physical: "physical direction: use ms/me/ps/pe/start/end, border-s/e, rounded-s/e",
  "text-end": "text-start / text-end: use text-left / text-right on Text (start / end)",
  case: "uppercase / tracking-* / .toUpperCase() in JSX: the kit applies case per script",
  weight: "font-medium/semibold/bold select a family, not a weight: use Text variant",
  radius: "rounded-* other than mark / control / panel / none",
  shadow: "shadow-*: content never casts a shadow",
  accent: "cyan as text, stroke or glyph (1.81:1): use tint, or a kit signal component",
  "accent-alias":
    "the accent rule for the signal under another name (bg-segment, bg-accent-hover, fill-accent…): use SignalCell, ChipRow multiple or Meter",
  scale: "allowFontScaling={false}",
  alert: "Alert.alert without `// vector: irreversible` on the line above: use undo",
  "raw-heroui": "raw HeroUI control: use the kit component",
  "raw-heroui-tabs": "HeroUI Tabs (1.00:1 selected label in dark mode): use Choices",
  concat: "' · ' joined in a template: use a translated template or Meta",
  "removed-token": "class names a token that no longer exists (emits nothing)",
  lines:
    "numberOfLines on content text (§3.5): let it wrap; a genuinely fixed slot is baselined with a reason",
};

// Class-token rules run on class strings only (className props, twMerge/cn/tv arguments, *Class/*ClassName
// bindings, and strings that look like a class list) so prose in translation files never counts.
const CLASS_RULES = {
  physical: [
    /(?<![\w-])-?(?:ml|mr|pl|pr|left|right)-[\w[\]./%-]+/g,
    /(?<![\w-])(?:border|rounded)-[lr](?=$|[\s"'`-])/g,
    /(?<![\w-])rounded-[tb][lr](?=$|[\s"'`-])/g,
  ],
  "text-end": [/(?<![\w-])text-(?:start|end)(?![\w-])/g],
  case: [/(?<![\w-])(?:uppercase|tracking-[\w[\].-]+)(?![\w-])/g],
  weight: [/(?<![\w-])font-(?:medium|semibold|bold)(?![\w-])/g],
  // A side or corner prefix is fine on an allowed size (rounded-s-mark, rounded-t-control); physical l/r
  // corners are the `physical` rule's to count, not this one's.
  radius: [
    /(?<![\w-])rounded(?:-(?!(?:(?:[setblr]|ss|se|es|ee|tl|tr|bl|br)-)?(?:mark|control|panel|none)(?![\w-]))[\w[\]./%-]+)?(?![\w-])/g,
  ],
  shadow: [/(?<![\w-])shadow(?:-[\w[\]./%-]+)?(?![\w-])/g],
  accent: [/(?<![\w-])(?:bg|text|border)-accent(?![\w-])/g],
  // The same #22D3EE under another name (since 1.2.1): Pro Segment's alias, the pressed signal, and the other
  // colour utilities (SVG fill / stroke, outline / ring, Uniwind's accent-* colour props). Content ink
  // (text-segment-foreground, bg-accent-foreground) is not signal paint.
  "accent-alias": [
    /(?<![\w-])(?:bg|text|border|fill|stroke|outline|ring|accent)-(?:segment|accent-hover)(?![\w-])/g,
    /(?<![\w-])(?:fill|stroke|outline|ring|accent)-accent(?![\w-])/g,
  ],
  "removed-token": [
    /(?<![\w-])(?:bg|text|border|fill|stroke)-(?:chart-(?:calories|protein|fat|carbs)|effort-[\w-]+|favorite-[\w-]+)/g,
  ],
};
const HEX_IN_STRING = [
  /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g,
  /\brgba?\(/g,
];
const PHYSICAL_KEYS = new Set([
  "left",
  "right",
  "marginLeft",
  "marginRight",
  "paddingLeft",
  "paddingRight",
]);
const RAW_HEROUI = new Set([
  "Button",
  "Card",
  "Switch",
  "Tabs",
  "RadioGroup",
  "Input",
  "TextField",
  "TextArea",
  "SearchField",
  "InputOTP",
]);
const CLASS_FN = /^(?:twMerge|twJoin|cn|clsx|cx|tv|cva|classNames)$/;
const CLASS_NAME = /class(?:Name)?(?:es|s)?$/i;
const CLASSY = /^\s*[!-]?[a-z0-9][a-z0-9:[\]()./%#!_\s-]*$/;
const CLASSY_TOKEN = /(?:^|\s)[!-]?[a-z0-9:]+-[\w[\]./%-]/;

const count = (text, patterns) => patterns.reduce((n, re) => n + (text.match(re)?.length ?? 0), 0);

/** App code the rules scan: everything under src except kit files (src/vector, the gallery route) and the shims. */
function appFiles(root) {
  return walk(abs(root, "src"))
    .map((f) => `src/${f}`)
    .filter(
      (f) =>
        /\.tsx?$/.test(f) &&
        !f.endsWith(".d.ts") &&
        !f.startsWith("src/vector/") &&
        f !== GALLERY_ROUTE &&
        !SHIMS.includes(f)
    );
}

function scanFile(ts, file, text) {
  const hits = {};
  const add = (rule, n = 1) => {
    if (n) hits[rule] = (hits[rule] ?? 0) + n;
  };
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const nameOf = (n) => (n && (ts.isIdentifier(n) || ts.isStringLiteral(n)) ? n.text : "");
  const lines = text.split("\n");

  const inClassContext = (node) => {
    for (let n = node.parent; n && !ts.isSourceFile(n); n = n.parent) {
      if (ts.isJsxAttribute(n)) return CLASS_NAME.test(n.name.getText(sf));
      if (ts.isCallExpression(n)) {
        const callee = n.expression;
        const name = ts.isIdentifier(callee)
          ? callee.text
          : ts.isPropertyAccessExpression(callee)
            ? callee.name.text
            : "";
        if (CLASS_FN.test(name)) return true;
      }
      if (
        ts.isVariableDeclaration(n) ||
        ts.isFunctionDeclaration(n) ||
        ts.isPropertyAssignment(n) ||
        ts.isMethodDeclaration(n)
      ) {
        if (CLASS_NAME.test(nameOf(n.name))) return true;
        if (ts.isVariableDeclaration(n) || ts.isFunctionDeclaration(n)) return false;
      }
    }
    return false;
  };
  const insideJsx = (node) => {
    for (let n = node.parent; n && !ts.isSourceFile(n); n = n.parent) {
      if (ts.isJsxExpression(n) || ts.isJsxAttribute(n)) return true;
    }
    return false;
  };
  // Touch slop and inset props are edge distances, not layout direction (HeroUI positions `insets` RTL-aware).
  const inHitSlop = (node) => {
    for (let n = node.parent; n && !ts.isSourceFile(n); n = n.parent) {
      if (ts.isJsxAttribute(n))
        return /^(?:hitSlop|pressRetentionOffset|hitRect|insets|contentInsets?|scrollIndicatorInsets)$/.test(
          n.name.getText(sf)
        );
      if (ts.isVariableDeclaration(n)) return /hitSlop|inset/i.test(nameOf(n.name));
    }
    return false;
  };
  // `{ left: 16, right: 16 }` (or margin/padding pairs) is symmetric, so it reads the same in RTL.
  const symmetric = (object, key) => {
    const pair = {
      left: "right",
      right: "left",
      marginLeft: "marginRight",
      marginRight: "marginLeft",
      paddingLeft: "paddingRight",
      paddingRight: "paddingLeft",
    }[key];
    const value = (k) =>
      object.properties
        .find((p) => ts.isPropertyAssignment(p) && nameOf(p.name) === k)
        ?.initializer.getText(sf);
    const mine = value(key);
    return mine !== undefined && mine === value(pair);
  };
  // `{ left: 0 }` anywhere, or any value inside style={…} / StyleSheet.create / useAnimatedStyle; data objects such
  // as `{ rest, left }` (seconds left) do not count.
  const isLiteralLength = (e) =>
    ts.isNumericLiteral(e) ||
    ts.isStringLiteral(e) ||
    (ts.isPrefixUnaryExpression(e) && ts.isNumericLiteral(e.operand));
  const inStyleContext = (node) => {
    for (let n = node.parent; n && !ts.isSourceFile(n); n = n.parent) {
      if (ts.isJsxAttribute(n)) return /style$/i.test(n.name.getText(sf));
      if (
        ts.isCallExpression(n) &&
        /(?:StyleSheet\.create|useAnimatedStyle)$/.test(n.expression.getText(sf))
      )
        return true;
    }
    return false;
  };
  const isModuleSpecifier = (node) => {
    const p = node.parent;
    if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isExternalModuleReference(p))
      return true;
    if (ts.isLiteralTypeNode(p)) return true;
    if (
      ts.isCallExpression(p) &&
      (p.expression.kind === ts.SyntaxKind.ImportKeyword || nameOf(p.expression) === "require")
    )
      return true;
    return false;
  };

  const noLimit = (e) =>
    !e ||
    (ts.isNumericLiteral(e) && Number(e.text) === 0) ||
    (ts.isIdentifier(e) && e.text === "undefined");
  const isLabel = (element) => {
    if (/(?:^|\.)(?:System)?Label$/.test(element.tagName.getText(sf))) return true;
    return element.attributes.properties.some(
      (a) =>
        ts.isJsxAttribute(a) &&
        a.name.getText(sf) === "variant" &&
        a.initializer &&
        ts.isStringLiteral(a.initializer) &&
        a.initializer.text === "label"
    );
  };

  // Which import rules a module specifier feeds: react-native (rn-text), heroui-native and its component
  // subpaths ("heroui-native/tabs" exports Tabs). heroui-native-pro is a different package and is not matched.
  const moduleRules = (from) =>
    from === "react-native"
      ? "react-native"
      : from === "heroui-native" || from.startsWith("heroui-native/")
        ? "heroui-native"
        : null;
  const memberHit = (mod, name) => {
    if (mod === "react-native" && (name === "Text" || name === "TextInput")) add("rn-text");
    if (mod === "heroui-native" && RAW_HEROUI.has(name))
      add(name === "Tabs" ? "raw-heroui-tabs" : "raw-heroui");
  };
  const namespaces = new Map();
  const seenMembers = new Set();

  const visit = (node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      const s = node.text;
      const holder =
        ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)
          ? node.parent
          : node;
      if (!isModuleSpecifier(holder)) {
        add("hex", count(s, HEX_IN_STRING));
        if (inClassContext(holder) || (CLASSY.test(s) && CLASSY_TOKEN.test(s))) {
          for (const [rule, patterns] of Object.entries(CLASS_RULES)) add(rule, count(s, patterns));
        }
      }
    }
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      !(ts.isImportDeclaration(node) ? node.importClause?.isTypeOnly : node.isTypeOnly)
    ) {
      const from = node.moduleSpecifier.text;
      const mod = moduleRules(from);
      const named = ts.isImportDeclaration(node)
        ? node.importClause?.namedBindings
        : node.exportClause;
      if (mod && named && (ts.isNamedImports(named) || ts.isNamedExports(named))) {
        for (const spec of named.elements) {
          if (!spec.isTypeOnly) memberHit(mod, (spec.propertyName ?? spec.name).text);
        }
      }
      // `import * as Hero from "heroui-native"`: Hero.Tabs counts like a named import (below).
      if (mod && named && ts.isNamespaceImport(named)) namespaces.set(named.name.text, mod);
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      namespaces.has(node.expression.text)
    ) {
      const key = `${node.expression.text}.${node.name.text}`;
      // One hit per member per file, the same weight as one named import (a JSX tag appears twice).
      if (!seenMembers.has(key)) {
        seenMembers.add(key);
        memberHit(namespaces.get(node.expression.text), node.name.text);
      }
    }
    if (
      ts.isPropertyAssignment(node) &&
      PHYSICAL_KEYS.has(nameOf(node.name)) &&
      ts.isObjectLiteralExpression(node.parent)
    ) {
      if (
        !inHitSlop(node.parent) &&
        !symmetric(node.parent, nameOf(node.name)) &&
        (isLiteralLength(node.initializer) || inStyleContext(node))
      )
        add("physical");
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      if ((method === "toUpperCase" || method === "toLocaleUpperCase") && insideJsx(node))
        add("case");
    }
    if (kind === ts.ScriptKind.TSX && ts.isTemplateExpression(node)) {
      const parts = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)];
      if (parts.some((p) => p.includes("·"))) add("concat");
    }
    // numberOfLines clips translated text at large sizes (§3.5). 0 lifts the limit, and Label (the eyebrow,
    // one line by design) may set it; props objects spread into Text (`fitted = { numberOfLines: 1, … }`) count.
    if (ts.isJsxAttribute(node) && node.name.getText(sf) === "numberOfLines") {
      const value =
        node.initializer && ts.isJsxExpression(node.initializer)
          ? node.initializer.expression
          : node.initializer;
      if (!noLimit(value) && !isLabel(node.parent.parent)) add("lines");
    }
    if (
      ts.isPropertyAssignment(node) &&
      nameOf(node.name) === "numberOfLines" &&
      ts.isObjectLiteralExpression(node.parent) &&
      !noLimit(node.initializer)
    )
      add("lines");
    if (ts.isJsxAttribute(node) && node.name.getText(sf) === "allowFontScaling") {
      const init = node.initializer;
      if (init && ts.isJsxExpression(init) && init.expression?.kind === ts.SyntaxKind.FalseKeyword)
        add("scale");
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const fn = ts.isIdentifier(callee) ? callee.text : "";
      const first = node.arguments[0];
      const literals = !first
        ? []
        : ts.isArrayLiteralExpression(first)
          ? first.elements.filter(ts.isStringLiteralLike).map((e) => e.text)
          : ts.isStringLiteralLike(first)
            ? [first.text]
            : [];
      if (fn === "useThemeColor" && literals.includes("accent")) add("accent");
      if (
        fn === "useCSSVariable" &&
        literals.some((l) => l === "--accent" || l === "--color-accent")
      )
        add("accent");
      if (fn === "useThemeColor")
        add("accent-alias", literals.filter((l) => l === "segment" || l === "accent-hover").length);
      if (fn === "useCSSVariable")
        add(
          "accent-alias",
          literals.filter((l) => /^--(?:color-)?(?:segment|accent-hover)$/.test(l)).length
        );
      if (
        ts.isPropertyAccessExpression(callee) &&
        nameOf(callee.expression) === "Alert" &&
        callee.name.text === "alert"
      ) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
        if (!/\/\/\s*vector:\s*irreversible/.test(lines[line - 1] ?? "")) add("alert");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  return hits;
}

function scanRules(root) {
  const files = appFiles(root);
  const counts = {};
  let shimImports = 0;
  if (!files.length) return { counts, shimImports, files: 0 };
  const ts = repoRequire(root, "typescript");
  if (!ts)
    throw new Error(
      "typescript is not installed in this repo (pnpm install): app-code rules need it"
    );
  for (const file of files) {
    const text = readText(root, file);
    shimImports += text.match(/from\s+["']@\/components\/(?:system|ui)["']/g)?.length ?? 0;
    for (const [rule, n] of Object.entries(scanFile(ts, file, text)))
      (counts[rule] ??= {})[file] = n;
  }
  return { counts, shimImports, files: files.length };
}

function readAllow(root) {
  if (!exists(root, ALLOW)) return { kit: null, rules: {}, eslintFiles: [], reasons: {} };
  const a = readJson(root, ALLOW);
  return {
    // The kit version that wrote the baseline; files from before 1.2.0 carry none.
    kit: a.kit ?? "1.0.0",
    rules: a.rules ?? {},
    eslintFiles: a.eslintFiles ?? [],
    reasons: a.reasons ?? {},
  };
}

/** A rule added after this repo's baseline was written: reported, not failed, until the next baseline. */
function pendingRule(rule, allow) {
  const since = RULE_SINCE[rule];
  if (!since || !allow.kit) return false;
  const a = parseVersion(allow.kit);
  const b = parseVersion(since);
  return !!a && !!b && compareVersions(a, b) < 0;
}

function compareRules(counts, allow) {
  const over = [];
  const under = [];
  const pending = [];
  let baselined = 0;
  let below = 0;
  for (const [rule, byFile] of Object.entries(counts)) {
    for (const [file, n] of Object.entries(byFile)) {
      const allowed = NO_BASELINE.has(rule) ? 0 : (allow.rules[rule]?.[file] ?? 0);
      if (n > allowed) (pendingRule(rule, allow) ? pending : over).push({ rule, file, n, allowed });
    }
  }
  for (const [rule, byFile] of Object.entries(allow.rules)) {
    for (const [file, allowed] of Object.entries(byFile)) {
      const n = counts[rule]?.[file] ?? 0;
      baselined += Math.min(n, allowed);
      if (n < allowed) {
        under.push({ rule, file, n, allowed });
        below += allowed - n;
      }
    }
  }
  return { over, under, pending, baselined, below };
}

// ---------------------------------------------------------------------------------------------------------------
// check

/**
 * `check`: drift + generated parity + app-code rules. `check --drift` skips the rules: the gate for MIGRATION S1
 * (the kit is synced but vector.allow.json does not exist until S10) and for the test wrapper (lint owns rules).
 */
function check({ verbose, rules: withRules = true }) {
  const failures = [];
  if (!exists(ROOT, MANIFEST)) {
    console.error(`vector-kit check: ${MANIFEST} not found (sync the kit first)`);
    return 1;
  }
  const m = readJson(ROOT, MANIFEST);
  const version = exists(ROOT, TOKENS_JSON) ? readJson(ROOT, TOKENS_JSON).version : "?";
  if (version !== m.version)
    failures.push(`version   manifest ${m.version} ≠ tokens.json ${version}`);
  failures.push(...driftReport(ROOT, m));
  failures.push(...generatedReport(ROOT));
  const drift = failures.length;
  if (!withRules) {
    for (const w of peerWarnings(ROOT, m)) console.warn(`vector-kit warn: ${w}`);
    if (drift) {
      for (const f of failures) console.error(`  ${f}`);
      console.error(`vector-kit ${m.version} FAILED · ${drift} drift (rules not checked: --drift)`);
      console.error(
        CANONICAL
          ? "Run `node scripts/vector-kit.mjs gen` after editing kit files."
          : "Kit files are read-only in app repos: change vector-design/kit, then `vector-kit sync`."
      );
      return 1;
    }
    console.log(`vector-kit ${m.version} ok · 0 drift (rules not checked: --drift)`);
    return 0;
  }

  const { counts, shimImports, files } = scanRules(ROOT);
  const allow = readAllow(ROOT);
  const rules = compareRules(counts, allow);
  for (const o of rules.over) {
    const why = NO_BASELINE.has(o.rule) ? "no baseline allowed" : `baseline ${o.allowed}`;
    failures.push(`rule      ${o.rule}  ${o.file}  ${o.n} (${why}): ${RULE_HELP[o.rule]}`);
  }

  for (const w of peerWarnings(ROOT, m)) console.warn(`vector-kit warn: ${w}`);
  if (rules.pending.length) {
    const hits = rules.pending.reduce((n, p) => n + p.n, 0);
    const names = [...new Set(rules.pending.map((p) => p.rule))];
    console.warn(
      `vector-kit warn: ${hits} ${hits === 1 ? "hit" : "hits"} of ${names.join(", ")} (a rule newer than this repo's vector.allow.json) in ${rules.pending.length} files; not failing until \`check --baseline\` records them.`
    );
    if (verbose)
      for (const p of rules.pending)
        console.warn(`  ${p.rule}  ${p.file}  ${p.n}: ${RULE_HELP[p.rule]}`);
  }
  if (rules.under.length) {
    console.log(
      `vector-kit: ${rules.below} hits below baseline in ${rules.under.length} entries; run check --baseline to ratchet.`
    );
    if (verbose)
      for (const u of rules.under) console.log(`  ${u.rule}  ${u.file}  ${u.n} < ${u.allowed}`);
  }
  const summary = `rules: ${rules.baselined} baselined (${rules.below ? `−${rules.below} below baseline` : "none below baseline"}) · ${files} app files · shim imports: ${shimImports}`;
  if (failures.length) {
    for (const f of failures) console.error(`  ${f}`);
    console.error(
      `vector-kit ${m.version} FAILED · ${drift} drift · ${rules.over.length} rule failures · ${summary}`
    );
    if (drift && !CANONICAL)
      console.error(
        "Kit files are read-only in app repos: change vector-design/kit, then `vector-kit sync`."
      );
    if (drift && CANONICAL)
      console.error("Run `node scripts/vector-kit.mjs gen` after editing kit files.");
    return 1;
  }
  console.log(`vector-kit ${m.version} ok · 0 drift · ${summary}`);
  return 0;
}

// ---------------------------------------------------------------------------------------------------------------
// check --baseline (writes vector.allow.json; the only command that edits an app-owned file)

async function baseline() {
  if (CANONICAL) {
    console.error("vector-kit check --baseline: run it in an app repo");
    return 1;
  }
  const { counts } = scanRules(ROOT);
  const previous = readAllow(ROOT);
  const reasons = {};
  const rules = {};
  const blocked = [];
  for (const [rule, byFile] of Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))) {
    for (const [file, n] of Object.entries(byFile).sort(([a], [b]) => a.localeCompare(b))) {
      if (NO_BASELINE.has(rule)) {
        blocked.push(`${rule}  ${file}  ${n}: ${RULE_HELP[rule]}`);
        continue;
      }
      (rules[rule] ??= {})[file] = n;
      const key = `${file}#${rule}`;
      reasons[key] =
        previous.reasons[key] ?? "baselined at kit adoption; burn down in Phase 1 or Later";
    }
  }

  const eslintFiles = [];
  const ESLintModule = repoRequire(ROOT, "eslint");
  if (ESLintModule?.ESLint) {
    process.env.VECTOR_KIT_BASELINE = "1";
    const eslint = new ESLintModule.ESLint({ cwd: ROOT });
    const results = await eslint.lintFiles(["src"]);
    const vectorRule = (msg) =>
      msg.ruleId === "react/jsx-no-literals" ||
      ((msg.ruleId === "no-restricted-syntax" || msg.ruleId === "no-restricted-imports") &&
        msg.message.includes("[vector]"));
    for (const r of results) {
      const file = path.relative(ROOT, r.filePath).split(path.sep).join("/");
      if (file.startsWith("src/vector/")) continue;
      if (r.messages.some(vectorRule)) eslintFiles.push(file);
    }
    eslintFiles.sort();
    for (const file of eslintFiles) {
      const key = `${file}#eslint`;
      reasons[key] = previous.reasons[key] ?? "L4 long-tail strings (file not edited in Phase 1)";
    }
  } else {
    console.warn("vector-kit warn: eslint not installed; eslintFiles left empty");
  }

  // `kit` dates the baseline, so a rule added by a later kit warns instead of failing until the next baseline.
  const allow = { kit: readJson(ROOT, TOKENS_JSON).version, rules, eslintFiles, reasons };
  writeIfChanged(ROOT, ALLOW, JSON.stringify(allow, null, 2) + "\n");
  const total = Object.values(rules).reduce(
    (n, byFile) => n + Object.values(byFile).reduce((a, b) => a + b, 0),
    0
  );
  console.log(
    `vector-kit baseline · ${total} rule hits in ${Object.keys(reasons).length - eslintFiles.length} entries · ${eslintFiles.length} eslintFiles → ${ALLOW}`
  );
  if (blocked.length) {
    for (const b of blocked) console.error(`  rule      ${b}`);
    console.error(
      `vector-kit baseline: ${blocked.length} hits in rules that allow no baseline; fix them (MIGRATION S2, S3, S13).`
    );
    return 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------------------------------------------
// check --swift

function targetSettings(root, target) {
  const config = path.join(root, "targets", target, "expo-target.config.js");
  const src = fs.existsSync(config) ? fs.readFileSync(config, "utf8") : "";
  const type = /\btype:\s*["']([\w-]+)["']/.exec(src)?.[1] ?? "widget";
  const deployment = /\bdeploymentTarget:\s*["']([\d.]+)["']/.exec(src)?.[1];
  return { type, deployment };
}

function runSwift(label, args) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("xcrun", ["swiftc", "-typecheck", ...args], { cwd: ROOT });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("close", (code) =>
      resolve({ label, code, output, seconds: (Date.now() - started) / 1000 })
    );
    child.on("error", (e) => resolve({ label, code: 1, output: String(e), seconds: 0 }));
  });
}

async function checkSwift() {
  if (!hasTargets(ROOT)) {
    console.log("vector-kit check --swift: skipped (no targets/ in this repo)");
    return 0;
  }
  if (spawnSync("xcrun", ["--version"], { stdio: "ignore" }).status !== 0) {
    console.log("vector-kit check --swift: skipped (xcrun is not on PATH)");
    return 0;
  }
  const sdk = (name) =>
    execFileSync("xcrun", ["--sdk", name, "--show-sdk-path"], { encoding: "utf8" }).trim();
  const ios = sdk("iphoneos");
  const wos = sdk("watchos");
  const sharedAll = walk(abs(ROOT, "targets/_shared"))
    .filter((f) => f.endsWith(".swift"))
    .map((f) => `targets/_shared/${f}`);
  const shared = sharedAll.filter((f) => /^Vector.*\.swift$/.test(path.basename(f)));
  if (!shared.length) {
    console.error(`vector-kit check --swift: ${SWIFT} missing`);
    return 1;
  }
  const swiftArgs = (sdk, target, appex) => [
    "-sdk",
    sdk,
    "-target",
    target,
    ...(appex ? ["-application-extension"] : []),
  ];
  // The kit's shared file alone, in every context it compiles into: @bacons/apple-targets 5.0.0 compiles
  // targets/_shared into the main app (ios16.4) and every target (lift activity, macro widget, both watches).
  const contexts = [
    ["ios16.4 (app)", ios, "arm64-apple-ios16.4", false],
    ["ios16.4 appex", ios, "arm64-apple-ios16.4", true],
    ["ios17.0 appex", ios, "arm64-apple-ios17.0", true],
    ["watchos10.0", wos, "arm64_32-apple-watchos10.0", false],
    ["watchos11.0", wos, "arm64_32-apple-watchos11.0", false],
  ];
  const jobs = contexts.map(([label, sdk, target, appex]) => [
    `_shared · ${label}`,
    ["-parse-as-library", ...swiftArgs(sdk, target, appex), ...shared],
  ]);
  // Then each target with all of _shared, at its own SDK and deployment target (from expo-target.config.js).
  for (const entry of fs.readdirSync(abs(ROOT, "targets"), { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "_shared" || entry.name.startsWith(".")) continue;
    const sources = walk(abs(ROOT, `targets/${entry.name}`))
      .filter((f) => f.endsWith(".swift"))
      .map((f) => `targets/${entry.name}/${f}`);
    if (!sources.length) continue;
    const { type, deployment } = targetSettings(ROOT, entry.name);
    const watch = type === "watch";
    const target = watch
      ? `arm64_32-apple-watchos${deployment ?? "10.0"}`
      : `arm64-apple-ios${deployment ?? "16.4"}`;
    const label = `targets/${entry.name} · ${target.replace(/^arm64(?:_32)?-apple-/, "")}${watch ? "" : " appex"}`;
    jobs.push([label, [...swiftArgs(watch ? wos : ios, target, !watch), ...sources, ...sharedAll]]);
  }
  const results = await Promise.all(jobs.map(([label, args]) => runSwift(label, args)));
  let failed = 0;
  for (const r of results) {
    const warnings = (r.output.match(/: warning: /g) ?? []).length;
    if (r.code === 0)
      console.log(
        `  ok    ${r.label} (${r.seconds.toFixed(1)}s${warnings ? `, ${warnings} warnings` : ""})`
      );
    else {
      failed++;
      console.error(
        `  FAIL  ${r.label}\n${r.output
          .split("\n")
          .slice(0, 40)
          .map((l) => `        ${l}`)
          .join("\n")}`
      );
    }
  }
  console.log(
    `vector-kit check --swift: ${results.length - failed}/${results.length} contexts type-check`
  );
  return failed ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------------------------
// check --css: offline Uniwind + Tailwind compile of global.css against the installed versions (tmpdir only)

const CSS_PROBE =
  "rounded-mark rounded-control rounded-panel bg-tint text-tint text-foreground-secondary border-border-strong bg-cat-1 bg-cat-2 bg-cat-3 tracking-label ms-4 border-s-2 text-5xl bg-segment bg-accent-hover accent-tint border-field-border outline-focus border-focus";

async function checkCssWith(nodeModules) {
  const D = fs.mkdtempSync(path.join(os.tmpdir(), "vector-css-"));
  const cwd = process.cwd();
  const failures = [];
  const expect = (ok, what) => {
    console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) failures.push(what);
  };
  try {
    fs.mkdirSync(path.join(D, "src/vector"), { recursive: true });
    fs.copyFileSync(abs(ROOT, "src/global.css"), path.join(D, "src/global.css"));
    fs.copyFileSync(abs(ROOT, TOKENS_CSS), path.join(D, "src/vector/tokens.css"));
    fs.symlinkSync(fs.realpathSync(nodeModules), path.join(D, "node_modules"), "dir");

    const uwPkg = fs.realpathSync(path.join(D, "node_modules/uniwind/package.json"));
    const uwDir = path.dirname(uwPkg);
    const uwReq = createRequire(uwPkg);
    const sharedDir = path.join(uwDir, "dist/shared");
    const shared = uwReq(
      path.join(sharedDir, fs.readdirSync(sharedDir).filter((f) => f.endsWith(".cjs"))[0])
    );
    // Uniwind does not export its native ProcessorBuilder: evaluate the bundled transformer with one extra export.
    const tfile = path.join(uwDir, "dist/metro/transformer.cjs");
    const tsrc =
      fs.readFileSync(tfile, "utf8") + "\nmodule.exports.__ProcessorBuilder = ProcessorBuilder;";
    const tmod = new Module(tfile);
    tmod.filename = tfile;
    tmod.paths = Module._nodeModulePaths(path.dirname(tfile));
    tmod._compile(tsrc, tfile);
    const ProcessorBuilder = tmod.exports.__ProcessorBuilder;
    const { compile } = uwReq("@tailwindcss/node");
    const { Scanner } = uwReq("@tailwindcss/oxide");
    const version = (name) => installedVersion(D, name) ?? "?";
    let twNode = "?";
    try {
      twNode = JSON.parse(
        fs.readFileSync(path.join(uwDir, "../@tailwindcss/node/package.json"), "utf8")
      ).version;
    } catch {}

    process.chdir(D);
    console.log(
      `vector css check · heroui-native ${version("heroui-native")} · uniwind ${version("uniwind")} · @tailwindcss/node ${twNode}`
    );
    const artifact = path.join(D, "uniwind.gen.css");
    const cfg = new shared.UniwindBundlerConfig(
      { cssEntryFile: "./src/global.css", dtsFile: path.join(D, "uniwind-types.gen.d.ts") },
      "ios"
    );
    await cfg.generateArtifacts(artifact);
    const entry = path.join(D, "src/global.css");
    const testCss =
      fs
        .readFileSync(entry, "utf8")
        .replace('@import "uniwind";', '@import "../uniwind.gen.css";') +
      `\n@source inline("${CSS_PROBE}");\n`;
    const testEntry = path.join(D, "src/global.test.css");
    fs.writeFileSync(testEntry, testCss);
    const compiler = await compile(testCss, {
      base: path.dirname(testEntry),
      onDependency: () => {},
    });
    const scanner = new Scanner({ sources: [...compiler.sources] });
    const css = compiler.build(scanner.scan());
    const P = new ProcessorBuilder(cfg);
    P.transform(css);
    const st = P.stylesheets || {};
    const vars = P.vars || {};
    const sv = P.scopedVars || {};
    const META = new Set([
      "minWidth",
      "maxWidth",
      "platform",
      "rtl",
      "important",
      "colorScheme",
      "orientation",
      "theme",
      "active",
      "focus",
      "disabled",
      "dataAttributes",
      "importantProperties",
      "index",
      "className",
      "inlineVariables",
      "complexity",
    ]);
    // Uniwind's native resolveStyles: className tokens in order, later declarations win (base entries only).
    const resolve = (className) => {
      const out = {};
      for (const cn of className.split(" ")) {
        for (const s of st[cn] || []) {
          if (
            s.theme ||
            s.platform ||
            s.rtl != null ||
            s.active != null ||
            s.focus != null ||
            s.disabled != null ||
            s.dataAttributes != null
          )
            continue;
          for (const [p, g] of Object.entries(s)) if (!META.has(p)) out[p] = g;
        }
      }
      return out;
    };
    const lit = (g) =>
      g === undefined ? "undefined" : typeof g === "string" ? g : JSON.stringify(g);
    const rad = (o) => {
      const v = o["border-radius"];
      if (v && typeof v === "object") {
        const xs = Object.values(v);
        return xs.every((x) => x === xs[0]) ? xs[0] : NaN;
      }
      return v;
    };

    const light = sv["__uniwind-theme-light"] || {};
    const dark = sv["__uniwind-theme-dark"] || {};
    const lk = Object.keys(light).sort().join();
    expect(
      lk.length > 0 && lk === Object.keys(dark).sort().join(),
      `light and dark carry the same variables (${Object.keys(light).length} each)`
    );
    for (const n of ["--tint", "--border-strong", "--cat-2", "--segment-foreground"])
      expect(n in light && n in dark, `themed var ${n}`);
    for (const n of [
      "--color-tint",
      "--color-tint-foreground",
      "--color-foreground-secondary",
      "--color-border-strong",
      "--color-cat-1",
      "--color-cat-2",
      "--color-cat-3",
      "--color-field-border-focus",
    ]) {
      expect(vars[n] !== undefined, `runtime var ${n} registered`);
    }
    expect(
      /black|0,\s*0,\s*0|#000/.test(String(vars["--color-warning-hover"])),
      "--color-warning-hover is the kit override"
    );
    expect(
      /surface-secondary/.test(String(vars["--color-field-hover"])),
      "--color-field-hover → --surface-secondary"
    );
    for (const n of ["--radius-lg", "--radius-xl", "--radius-2xl", "--radius-3xl", "--radius-4xl"])
      expect(String(vars[n]) === "4", `${n} = 4 (${vars[n]})`);
    expect(String(vars["--radius-mark"]) === "2", `--radius-mark = 2 (${vars["--radius-mark"]})`);
    expect(Math.abs(Number(vars["--opacity-disabled"]) - 0.4) < 1e-6, "--opacity-disabled = 0.4");
    for (const c of CSS_PROBE.split(" ")) expect(st[c] !== undefined, `utility .${c}`);
    expect(resolve("button__label")["font-weight"] === 500, "button__label weight 500");
    for (const size of ["md", "lg"]) {
      const o = resolve(`button__label button__label--variant-primary button__label--size-${size}`);
      expect(
        o["font-size"] === 15 && o["line-height"] === 20 && o["font-weight"] === 500,
        `button label size-${size} → 15/20 weight 500 (got ${lit(o["font-size"])}/${lit(o["line-height"])} ${lit(o["font-weight"])})`
      );
    }
    expect(rad(resolve("switch__root")) === 4, "switch__root radius 4");
    expect(rad(resolve("switch__thumb")) === 2, "switch__thumb radius 2");
    for (const c of ["slider__track", "slider__thumb-knob", "checkbox__root"])
      expect(rad(resolve(c)) === 2, `${c} radius 2`);
    expect(rad(resolve("segment__item segment__item--size-lg")) === 4, "Pro segment lg radius 4");
    for (const c of ["menu__item", "select__item"])
      expect(resolve(c)["min-height"] === 44, `${c} min-height 44`);
    const ring = lit(
      resolve("timeline__marker timeline__marker--size-md timeline__marker--status-current")[
        "border-color"
      ]
    );
    expect(/--tint/.test(ring), "timeline current ring → --tint");
    expect(
      /--tint/.test(
        lit(resolve("tabs__indicator tabs__indicator--variant-secondary")["border-color"])
      ),
      "tabs secondary underline → --tint"
    );
    expect(
      /--border-strong/.test(
        lit(resolve("timeline__marker timeline__marker--status-default")["border-color"])
      ),
      "timeline default marker → --border-strong"
    );
  } catch (e) {
    failures.push(String(e?.stack ?? e));
    console.error(`  FAIL ${e?.stack ?? e}`);
  } finally {
    process.chdir(cwd);
    fs.rmSync(D, { recursive: true, force: true });
  }
  console.log(
    failures.length ? `vector css check FAILED (${failures.length})` : "vector css check ok"
  );
  return failures.length ? 1 : 0;
}

async function checkCss(modulesArg) {
  if (modulesArg) return checkCssWith(path.resolve(modulesArg));
  if (!CANONICAL) {
    const nm = path.join(ROOT, "node_modules");
    if (!fs.existsSync(path.join(nm, "uniwind"))) {
      console.error("vector-kit check --css: node_modules/uniwind missing (pnpm install)");
      return 1;
    }
    return checkCssWith(nm);
  }
  // Canonical: compile the kit's CSS against every sibling's installed toolchain, each in its own process.
  let failed = 0;
  let ran = 0;
  for (const app of APPS) {
    const nm = path.join(SIBLINGS, `${app}-track`, "node_modules");
    if (!fs.existsSync(path.join(nm, "uniwind"))) continue;
    ran++;
    console.log(`[${app}-track node_modules]`);
    const r = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), "check", "--css", "--modules", nm],
      { stdio: "inherit" }
    );
    if (r.status !== 0) failed++;
  }
  if (!ran) console.log("vector-kit check --css: skipped (no sibling repo with node_modules)");
  return failed ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------------------------
// sync (canonical → repos)

function testVariant(repo) {
  try {
    const test =
      JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")).scripts?.test ?? "";
    return /\.test\.mjs/.test(test) ? "tests/vector.test.mjs" : "tests/vector.test.cjs";
  } catch {
    return "tests/vector.test.cjs";
  }
}

function sync(repos, { force, include }) {
  requireCanonical("sync");
  if (!repos.length) {
    console.error("usage: vector-kit sync <repo…> [--force] [--include <path>]");
    return 1;
  }
  const m = readJson(ROOT, MANIFEST);
  const canonicalDrift = [...driftReport(ROOT, m), ...generatedReport(ROOT)];
  if (canonicalDrift.length) {
    for (const p of canonicalDrift) console.error(`  ${p}`);
    console.error(
      "vector-kit sync: the canonical kit is not current; run `node scripts/vector-kit.mjs gen` first."
    );
    return 1;
  }
  let status = 0;
  for (const arg of repos) {
    const repo = path.resolve(arg);
    if (!fs.existsSync(path.join(repo, "package.json"))) {
      console.error(`vector-kit sync: ${shown(repo)} is not an app repo (no package.json)`);
      status = 1;
      continue;
    }
    if (exists(repo, MANIFEST) && !force) {
      const local = driftReport(repo, readJson(repo, MANIFEST));
      const edited = local.filter((p) => !p.startsWith("missing"));
      if (edited.length) {
        for (const p of edited) console.error(`  ${p}`);
        console.error(
          `vector-kit sync: ${shown(repo)} has local edits to kit files; move them into the kit, or pass --force.`
        );
        status = 1;
        continue;
      }
    }
    const variant = testVariant(repo);
    const targets = hasTargets(repo);
    const files = [];
    for (const key of Object.keys(m.files)) {
      if (key === TESTS) files.push(variant);
      else if (key === SWIFT) {
        if (targets) files.push(key);
      } else if ((m.optional ?? []).includes(key)) {
        if (exists(repo, key) || include.includes(key)) files.push(key);
      } else files.push(key);
    }
    files.push(MANIFEST);
    // Only the files the repo's own manifest lists are kit-owned there. Anything else at a kit path (the app's
    // global.css before the first sync, or an app file where a newer kit starts shipping one) is app-owned:
    // sync lists it and stops, and replaces it only with --force after the owner has looked.
    const adopting = !exists(repo, MANIFEST);
    const owned = new Set(
      adopting ? [] : Object.keys(readJson(repo, MANIFEST).files ?? {}).flatMap((k) => k.split("|"))
    );
    owned.add(MANIFEST);
    const differs = (file) =>
      exists(repo, file) &&
      !fs.readFileSync(abs(repo, file)).equals(fs.readFileSync(abs(ROOT, file)));
    const foreign = files.filter((file) => !owned.has(file) && differs(file));
    if (foreign.length && !force) {
      for (const f of foreign) console.error(`  app file  ${f}`);
      console.error(
        `vector-kit sync: ${shown(repo)} has ${foreign.length} app-owned files at kit paths; review them (MIGRATION S1), then pass --force to replace them.`
      );
      status = 1;
      continue;
    }
    let changed = 0;
    for (const file of files) {
      if (!differs(file) && exists(repo, file)) continue;
      fs.mkdirSync(path.dirname(abs(repo, file)), { recursive: true });
      fs.copyFileSync(abs(ROOT, file), abs(repo, file));
      changed++;
    }
    // Deletes only what an earlier sync shipped and the kit no longer does; an app file in src/vector stays
    // (check reports it as unknown).
    const keep = new Set(files);
    let removed = 0;
    const strays = [];
    for (const f of walk(abs(repo, "src/vector"))) {
      const file = `src/vector/${f}`;
      if (keep.has(file)) continue;
      if (owned.has(file)) {
        fs.rmSync(abs(repo, file));
        removed++;
      } else strays.push(file);
    }
    console.log(
      `synced vector-kit ${m.version} → ${shown(repo)} (${files.length} files, ${changed} changed${removed ? `, ${removed} removed` : ""}${targets ? "" : ", no targets/: Swift skipped"}, ${path.basename(variant)})`
    );
    if (foreign.length) {
      console.warn(
        `vector-kit sync: --force replaced ${foreign.length} app-owned files (review with git diff):`
      );
      for (const f of foreign) console.warn(`  replaced  ${f}`);
      if (foreign.includes("src/global.css"))
        console.warn(
          "  src/global.css is now the kit file: MIGRATION S2 (Tabs → Choices) and S3 (removed tokens) belong in this change."
        );
    }
    for (const f of strays)
      console.warn(
        `vector-kit sync: kept ${f} (not a kit file; src/vector is kit-owned, move it out)`
      );
  }
  return status;
}

// ---------------------------------------------------------------------------------------------------------------
// siblings (version + hash matrix across the four repos)

function siblings() {
  const columns = [];
  if (CANONICAL) columns.push(["kit", ROOT]);
  for (const app of APPS) columns.push([app, path.join(SIBLINGS, `${app}-track`)]);
  const reference = readJson(ROOT, MANIFEST);
  let mismatch = false;
  const rows = [];
  const versions = columns.map(([, dir]) =>
    exists(dir, MANIFEST) ? readJson(dir, MANIFEST).version : "—"
  );
  if (new Set(versions).size > 1 || versions.includes("—")) mismatch = true;
  rows.push(["version", ...versions]);
  for (const key of Object.keys(reference.files)) {
    for (const variant of key.split("|")) {
      const cells = columns.map(([, dir]) => (exists(dir, variant) ? sha(dir, variant) : null));
      const present = cells.filter(Boolean);
      const optional = key === SWIFT || key === TESTS || (reference.optional ?? []).includes(key);
      if (new Set(present).size > 1 || (!optional && present.length < cells.length))
        mismatch = true;
      if (key === SWIFT) {
        columns.forEach(([, dir], i) => {
          if (hasTargets(dir) && !cells[i]) mismatch = true;
        });
      }
      rows.push([variant, ...cells.map(short)]);
    }
  }
  const header = ["file", ...columns.map(([name]) => name)];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (r) => r.map((c, i) => String(c).padEnd(widths[i])).join("  ");
  console.log(line(header));
  for (const r of rows) console.log(line(r));
  console.log(
    mismatch
      ? "vector-kit siblings: MISMATCH"
      : `vector-kit siblings: one version (${versions[0]}), one hash per file`
  );
  return mismatch ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------------------------
// bump

function bump(level) {
  requireCanonical("bump");
  if (!["patch", "minor", "major"].includes(level)) {
    console.error("usage: vector-kit bump <patch|minor|major>");
    return 1;
  }
  const json = readText(ROOT, TOKENS_JSON);
  const current = /"version":\s*"(\d+)\.(\d+)\.(\d+)"/.exec(json);
  if (!current) throw new Error("tokens.json has no version");
  const [maj, min, pat] = current.slice(1).map(Number);
  const next =
    level === "major"
      ? `${maj + 1}.0.0`
      : level === "minor"
        ? `${maj}.${min + 1}.0`
        : `${maj}.${min}.${pat + 1}`;
  writeIfChanged(ROOT, TOKENS_JSON, json.replace(current[0], `"version": "${next}"`));
  const css = readText(ROOT, TOKENS_CSS);
  writeIfChanged(ROOT, TOKENS_CSS, css.replace(/Vector Kit \d+\.\d+\.\d+/, `Vector Kit ${next}`));
  let doc = readText(ROOT, "docs/design-system.md").replace(
    /\*\*Kit \d+\.\d+\.\d+ ·/,
    `**Kit ${next} ·`
  );
  const heading = "## Changelog\n\n";
  const at = doc.indexOf(heading);
  const stub = `- **${next}.** (${level}) Describe the change: tokens, components or flags touched, and why.\n`;
  doc =
    at < 0
      ? `${doc.trimEnd()}\n\n${heading}${stub}`
      : doc.slice(0, at + heading.length) + stub + doc.slice(at + heading.length);
  writeIfChanged(ROOT, "docs/design-system.md", doc);
  console.log(
    `vector-kit bump ${level}: ${current.slice(1).join(".")} → ${next} (edit the changelog stub in docs/design-system.md)`
  );
  gen();
  return 0;
}

// ---------------------------------------------------------------------------------------------------------------
// CLI

const USAGE = `vector-kit — Vector design system kit tool (KIT.md §3)
  gen                         canonical: regenerate token outputs from tokens.json, then manifest.json
  check [--verbose]           drift, generated parity, app-code rules vs vector.allow.json; warns on peers
  check --drift               drift and generated parity only (MIGRATION S1 gate, test wrapper)
  check --baseline            write vector.allow.json (rule counts + eslintFiles) in an app repo
  check --swift               swiftc -typecheck of targets/_shared and each target (skips without targets/ or xcrun)
  check --css [--modules d]   offline Uniwind/Tailwind compile of global.css against installed versions
  sync <repo…> [--force] [--include <path>]   canonical: copy the kit into repos (app files at kit paths need --force)
  siblings                    version + hash matrix across ../{body,lift,macro,water}-track
  bump <patch|minor|major>    canonical: bump version, gen, changelog stub`;

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const flag = (name) => rest.includes(name);
  const value = (name) => {
    const values = [];
    rest.forEach((a, i) => a === name && rest[i + 1] && values.push(rest[i + 1]));
    return values;
  };
  const positional = rest.filter(
    (a, i) => !a.startsWith("--") && !["--modules", "--include"].includes(rest[i - 1])
  );
  switch (command) {
    case "gen":
      gen();
      return 0;
    case "check":
      if (flag("--baseline")) return baseline();
      if (flag("--swift")) return checkSwift();
      if (flag("--css")) return checkCss(value("--modules")[0]);
      return check({ verbose: flag("--verbose"), rules: !flag("--drift") });
    case "sync":
      return sync(positional, { force: flag("--force"), include: value("--include") });
    case "siblings":
      return siblings();
    case "bump":
      return bump(positional[0]);
    default:
      console.log(USAGE);
      return command && command !== "help" && command !== "--help" ? 1 : 0;
  }
}

main().then(
  (code) => {
    process.exitCode = code ?? 0;
  },
  (e) => {
    console.error(`vector-kit: ${e?.stack ?? e}`);
    process.exitCode = 1;
  }
);
