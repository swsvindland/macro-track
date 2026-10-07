// G13, strings (synced, hash-checked; loaded by tests/vault.test.*): the vault string table in the kit's 11 languages
// (keys, placeholders, plurals, brand names, the apps' backup / restore / replace terms, typography, English copy
// voice), the label helpers (every Step and VaultErrorCode reaches a key) and the pure core of useVaultText(). The
// TypeScript runs through the repo's own typescript, as the repos' harnesses do; the canonical vault (no package.json)
// borrows a sibling repo's.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const path = require("node:path");
const vm = require("node:vm");

// tests/vault/ → the repo root (or the canonical vault).
const root = path.resolve(module.path, "..", "..");
const canonical = !existsSync(path.join(root, "package.json"));
const bases = canonical
  ? [
      root,
      ...["lift-track", "body-track", "macro-track", "water-track"].map((dir) =>
        path.join(root, "..", "..", dir)
      ),
    ]
  : [root];

function typescript() {
  for (const base of bases) {
    try {
      return createRequire(path.join(base, "package.json"))("typescript");
    } catch {}
  }
  return null;
}
const ts = typescript();
const skip = ts ? false : "typescript not found: run the repo's install first";

/** One TypeScript module as CommonJS; its imports come only from `modules` (anything else throws). */
function load(file, modules = {}) {
  const filename = path.join(root, file);
  const output = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
  }).outputText;
  const module = { exports: {} };
  const resolve = (name) => {
    if (Object.hasOwn(modules, name)) return modules[name];
    throw new Error(`strings test: no module for '${name}' imported from ${file}`);
  };
  vm.compileFunction(output, ["require", "module", "exports"], { filename })(
    resolve,
    module,
    module.exports
  );
  return module.exports;
}

const kitFile = canonical ? "../kit/src/vector/strings.ts" : "src/vector/strings.ts";
const typesText = readFileSync(path.join(root, "src", "vault", "types.ts"), "utf8");
/** The Step union of types.ts, read from its declaration so a new step is checked without editing this test. */
const steps = [.../export type Step =([^;]+);/.exec(typesText)[1].matchAll(/"(\w+)"/g)].map(
  (m) => m[1]
);
const apps = JSON.parse(readFileSync(path.join(root, "src", "vault", "apps.json"), "utf8"));

const modules = ts
  ? (() => {
      const kit = load(kitFile);
      const strings = load("src/vault/strings.ts");
      const errors = load("src/vault/errors.ts");
      const labels = load("src/vault/ui/labels.ts", { "../errors": errors });
      return { kit, strings, errors, labels };
    })()
  : {};

/** The kit formatter's members that vault text uses, on full ICU (the kit's own tests cover Hermes). */
function format(language) {
  const tag = { zh: "zh-Hans-CN", pt: "pt-BR" }[language] ?? language;
  return {
    number: (n) => new Intl.NumberFormat(tag, { maximumFractionDigits: 0 }).format(n),
    plural: (n) => new Intl.PluralRules(tag).select(n),
    date: (d) => d.toISOString().slice(0, 10),
    time: (d) => d.toISOString().slice(11, 16),
  };
}

/** src/vault/i18n.ts with its React, platform, kit and app imports replaced. */
function i18n({ platform = "ios", language = "en" } = {}) {
  return load("src/vault/i18n.ts", {
    react: { useMemo: (make) => make() },
    "react-native": { Platform: { OS: platform } },
    "@/vector": { useKit: () => ({ language, format: format(language) }) },
    "./app": { vaultIdentity: apps.lift },
    "./strings": modules.strings,
  });
}
const textFor = (language, platform = "ios") =>
  i18n({ platform }).vaultText({
    language,
    format: format(language),
    app: apps.lift.name,
    platform,
  });

/** A v() that records the keys it is asked for and returns the key (labels tests). */
function recorder() {
  const asked = [];
  const v = (key, values = {}) => {
    asked.push(key);
    return `${key}${Object.keys(values).length ? JSON.stringify(values) : ""}`;
  };
  return { v, asked };
}

const placeholders = (text) => [...new Set(text.match(/\{\w+\}/g) ?? [])].sort();
const words = (text) => text.trim().split(/\s+/).length;
const chars = (text) => [...text].length;

test(
  "G13: the kit's 11 languages, each with exactly the keys of en in the same order, none empty",
  { skip },
  () => {
    const { vaultStrings } = modules.strings;
    const keys = Object.keys(vaultStrings.en);
    assert.deepEqual(Object.keys(vaultStrings), [...modules.kit.kitLanguages]);
    for (const [language, table] of Object.entries(vaultStrings)) {
      assert.deepEqual(Object.keys(table), keys, language);
      for (const key of keys) assert.ok(table[key].trim(), `${language}.${key} is empty`);
    }
  }
);

test(
  "G13: every translation has exactly the placeholders of en, and no stray brace",
  { skip },
  () => {
    const { vaultStrings } = modules.strings;
    for (const [key, english] of Object.entries(vaultStrings.en)) {
      for (const [language, table] of Object.entries(vaultStrings)) {
        assert.deepEqual(placeholders(table[key]), placeholders(english), `${language}.${key}`);
        assert.doesNotMatch(table[key].replace(/\{\w+\}/g, ""), /[{}]/, `${language}.${key}`);
      }
    }
  }
);

test(
  "G13: plural keys come in _one/_other pairs and plural() picks _one only for 'one'",
  { skip },
  () => {
    const { vaultStrings } = modules.strings;
    const keys = Object.keys(vaultStrings.en);
    const bases = keys.filter((k) => k.endsWith("_one")).map((k) => k.slice(0, -4));
    assert.ok(bases.length >= 3, "previewMediaMissing, restoredMediaSkipped, restoredRepairs");
    for (const base of bases) assert.ok(keys.includes(`${base}_other`), `${base}_other`);
    for (const key of keys.filter((k) => k.endsWith("_other")))
      assert.ok(keys.includes(`${key.slice(0, -6)}_one`), key);
    const { plural } = i18n();
    for (const base of bases) {
      assert.equal(plural(base, "one"), `${base}_one`);
      for (const rule of ["zero", "two", "few", "many", "other"])
        assert.equal(plural(base, rule), `${base}_other`, rule);
    }
  }
);

test("G13: brand names are never translated", { skip }, () => {
  const { vaultStrings } = modules.strings;
  const brands = [
    "iCloud",
    "Google Drive",
    "Apple Health",
    "Health Connect",
    "iPhone",
    "iPad",
    "Android",
  ];
  for (const [key, english] of Object.entries(vaultStrings.en)) {
    for (const brand of brands.filter((b) => english.includes(b))) {
      for (const [language, table] of Object.entries(vaultStrings))
        assert.ok(table[key].includes(brand), `${language}.${key} lost "${brand}"`);
    }
  }
  for (const table of Object.values(vaultStrings)) {
    assert.equal(table.healthApple, "Apple Health");
    assert.equal(table.healthAndroid, "Health Connect");
    assert.equal(table.deviceIphone, "iPhone");
    assert.equal(table.deviceIpad, "iPad");
  }
});

test(
  "G13: backup, restore and replace use the apps' established terms (lift's locales)",
  { skip },
  () => {
    const { vaultStrings } = modules.strings;
    const terms = {
      en: [/backup/i, /restor/i, /replac/i],
      es: [/copia/i, /restaur/i, /reemplaz/i],
      fr: [/sauvegarde/i, /restaur/i, /remplac/i],
      de: [/sicherung/i, /wiederherstell/i, /ersetz/i],
      it: [/backup/i, /ripristin/i, /sostitu/i],
      pt: [/cópia/i, /restaur/i, /substitu/i],
      nl: [/back-up/i, /herstel/i, /vervang/i],
      sv: [/säkerhetskopi/i, /återställ/i, /ersätt/i],
      ja: [/バックアップ/, /復元/, /置き換/],
      ko: [/백업/, /복원/, /대체/],
      zh: [/备份/, /恢复/, /替换/],
    };
    assert.deepEqual(Object.keys(terms), Object.keys(vaultStrings));
    for (const [language, [backup, restore, replace]] of Object.entries(terms)) {
      const t = vaultStrings[language];
      for (const key of ["sectionTitle", "backupTitle", "passwordField"])
        assert.match(t[key], backup, `${language}.${key}`);
      for (const key of ["restoreButton", "handoffRestoreAction"]) {
        assert.match(t[key], backup, `${language}.${key}`);
        assert.match(t[key], restore, `${language}.${key}`);
      }
      for (const key of ["importTitle", "importRow", "cloudBackupsRow", "undoRestoreRow"])
        assert.match(t[key], restore, `${language}.${key}`);
      for (const key of ["confirmTitle", "confirmAction"])
        assert.match(t[key], replace, `${language}.${key}`);
      // The done state names the Settings row it points to, word for word.
      assert.ok(t.restoredUndo.includes(t.undoRestoreRow), `${language}.restoredUndo`);
    }
  }
);

test("G13: typography in every language", { skip }, () => {
  const { vaultStrings } = modules.strings;
  const progress = Object.keys(vaultStrings.en).filter((k) => vaultStrings.en[k].endsWith("…"));
  assert.ok(progress.length >= 20, "steps and the other progress labels");
  for (const [language, table] of Object.entries(vaultStrings)) {
    for (const [key, text] of Object.entries(table)) {
      const where = `${language}.${key}: ${text}`;
      assert.doesNotMatch(text, /['"]/, `straight quote in ${where}`);
      assert.doesNotMatch(text, /\.\.\./, `three dots in ${where}`);
      assert.doesNotMatch(text, /[!¡！]/, `exclamation mark in ${where}`);
      assert.doesNotMatch(text, /^\s|\s$|\s{2}/, `stray space in ${where}`);
    }
    for (const key of progress) assert.ok(table[key].endsWith("…"), `${language}.${key}`);
  }
  // French: a no-break space before ? : ; and inside « », never a breaking one.
  for (const [key, text] of Object.entries(vaultStrings.fr))
    assert.doesNotMatch(text, / [?:;»]|« /, `fr.${key}: ${text}`);
});

test("G13: English copy voice", { skip }, () => {
  const { en } = modules.strings.vaultStrings;
  const contraction = /n[’']t\b|[’'](re|ll|ve|d)\b|\b(it|what|there|that)[’']s\b/i;
  for (const [key, text] of Object.entries(en)) {
    assert.doesNotMatch(text, contraction, `en.${key}: ${text}`);
    assert.doesNotMatch(text, /\bplease\b/i, `en.${key}: ${text}`);
    // Sentence case: a lowercase start only for a brand written that way (iCloud, iPhone, iPad).
    assert.ok(!/^[a-z]/.test(text) || /^i[A-Z]/.test(text), `en.${key}: ${text}`);
  }
  for (const key of Object.keys(en).filter((k) => k.startsWith("step")))
    assert.ok(en[key].endsWith("…"), `en.${key}`);
  const buttons = [
    "backUpNow",
    "chooseFile",
    "restoreButton",
    "confirmAction",
    "unlock",
    "saveToDevice",
    "shareFile",
    "googleConnect",
    "googleReconnect",
    "googleDisconnect",
    "deleteCloudAction",
    "handoffUse",
    "handoffKeep",
    "handoffRestoreAction",
    "backToSettings",
    "recoveryRestore",
    "recoveryExport",
  ];
  for (const key of buttons) {
    assert.ok(chars(en[key]) <= 20, `en.${key} is over 20 characters: ${en[key]}`);
    // Design-system §9.3: every label is designed for +40%.
    for (const [language, table] of Object.entries(modules.strings.vaultStrings))
      assert.ok(chars(table[key]) <= 28, `${language}.${key} is over 28 characters: ${table[key]}`);
  }
  const statuses = Object.keys(en).filter((k) => k.startsWith("status"));
  assert.ok(statuses.length >= 10);
  for (const key of statuses) {
    assert.ok(words(en[key]) <= 3, `en.${key} is over three words: ${en[key]}`);
    // Status sets the word on one uppercase line: translations stay short too.
    for (const [language, table] of Object.entries(modules.strings.vaultStrings))
      assert.ok(chars(table[key]) <= 24, `${language}.${key} is over 24 characters: ${table[key]}`);
  }
  // Eyebrows are at most three words (design-system §9.3), in every language.
  for (const key of [
    "sectionTitle",
    "autoIcloud",
    "autoGoogle",
    "cloudThisDevice",
    "cloudOtherDevice",
    "cloudOldLibrary",
  ])
    for (const [language, table] of Object.entries(modules.strings.vaultStrings))
      assert.ok(words(table[key]) <= 3, `${language}.${key}: ${table[key]}`);
});

test("labels: every Step has a step key, and every step key belongs to a Step", { skip }, () => {
  const { en } = modules.strings.vaultStrings;
  const { stepKey } = modules.labels;
  assert.ok(steps.length >= 14, `Step union read from types.ts: ${steps}`);
  const used = steps.map((step) => stepKey(step));
  for (const [i, key] of used.entries()) {
    assert.ok(Object.hasOwn(en, key), `stepKey("${steps[i]}") = ${key}`);
    assert.match(key, /^step[A-Z]/);
  }
  assert.equal(new Set(used).size, steps.length, "one key per step");
  assert.deepEqual(
    Object.keys(en)
      .filter((k) => /^step[A-Z]/.test(k))
      .sort(),
    [...used].sort(),
    "no step key without a Step"
  );
});

test(
  "labels: every VaultErrorCode reaches an existing key, manual runs get their _manual wording",
  { skip },
  () => {
    const { en } = modules.strings.vaultStrings;
    const { VAULT_ERROR_CODES } = modules.errors;
    const { errorText } = modules.labels;
    const reached = new Set();
    for (const code of VAULT_ERROR_CODES) {
      assert.ok(Object.hasOwn(en, `error_${code}`), `error_${code} exists for parity`);
      for (const trigger of ["manual", "auto"]) {
        for (const error of [
          code,
          { code },
          { code, info: { bytes: 2_500_000, app: apps.body.name } },
        ]) {
          const { v, asked } = recorder();
          const text = errorText(v, error, trigger);
          if (code === "cancelled" || code === "googleCancelled") {
            assert.equal(text, "", `${code} renders nothing`);
            assert.deepEqual(asked, []);
            continue;
          }
          assert.ok(text, `${code} (${trigger})`);
          for (const key of asked) {
            assert.ok(
              Object.hasOwn(en, key),
              `${code} (${trigger}) asked for a missing key ${key}`
            );
            reached.add(key);
          }
        }
      }
    }
    for (const code of ["network", "provider", "googleRateLimited"]) {
      assert.equal(errorText(recorder().v, code, "manual"), `error_${code}_manual`);
      assert.equal(errorText(recorder().v, code, "auto"), `error_${code}`);
    }
    assert.equal(errorText(recorder().v, "corrupt", "manual"), "error_corrupt");
    // Every error key is shown by something; the two cancellations exist for parity only.
    const errorKeys = Object.keys(en).filter((k) => k.startsWith("error_"));
    assert.deepEqual(
      errorKeys.filter((k) => !reached.has(k)).sort(),
      ["error_cancelled", "error_googleCancelled"],
      "error keys errorText never shows"
    );
  }
);

test("labels: sizes, the other app's name and unknown codes", { skip }, () => {
  const { errorText, sizeText } = modules.labels;
  const en = textFor("en");
  assert.equal(
    errorText(en.v, { code: "insufficientSpace", info: { bytes: 1_500_000 } }, "manual"),
    "Not enough free storage. Free up about 2 MB and try again."
  );
  assert.equal(
    errorText(en.v, "insufficientSpace", "auto"),
    "Not enough free storage. Free up some space and try again."
  );
  assert.equal(sizeText(en.v, 1), "1 MB");
  assert.equal(sizeText(en.v, 1_234_000_001), "1,235 MB");
  assert.equal(sizeText(textFor("de").v, 1_234_000_001), "1.235 MB");
  assert.equal(sizeText(textFor("fr").v, 3_000_000), "3 Mo");
  assert.equal(
    errorText(en.v, { code: "wrongApp", info: { app: apps.water.name } }, "manual"),
    `This is a ${apps.water.name} backup. Open it in ${apps.water.name}.`
  );
  assert.equal(
    errorText(en.v, { code: "wrongApp", info: {} }, "manual"),
    `This file is not a ${apps.lift.name} backup.`
  );
  assert.equal(errorText(en.v, "somethingNewer", "manual"), en.v("error_unknown"));
  assert.equal(
    errorText(textFor("en", "android").v, "healthBusy", "manual"),
    "Health Connect sync is running. Try again when it finishes."
  );
});

test("labels: device nouns", { skip }, () => {
  const { deviceNoun } = modules.labels;
  const { v } = textFor("de");
  assert.equal(deviceNoun(v, { platform: "ios", kind: "phone" }), "iPhone");
  assert.equal(deviceNoun(v, { platform: "ios", kind: "tablet" }), "iPad");
  assert.equal(deviceNoun(v, { platform: "android", kind: "phone" }), "Telefon");
  assert.equal(deviceNoun(v, { platform: "android", kind: "tablet" }), "Tablet");
});

test(
  "i18n: v fills {app} and {health}, formats numbers, and screens can override",
  { skip },
  () => {
    const ios = textFor("en", "ios");
    const android = textFor("en", "android");
    assert.equal(ios.v("exportRowHint"), `One file with everything in ${apps.lift.name}`);
    assert.equal(ios.health, "Apple Health");
    assert.equal(android.health, "Health Connect");
    assert.equal(
      android.v("confirmHealthOff"),
      "Health Connect sync turns off. Turn it on again in Settings."
    );
    assert.equal(
      ios.v("previewHealthOtherDevice", { health: "Health Connect" }),
      "Health Connect sync was on where this backup was made. Use Health Connect sync on one device to avoid duplicates."
    );
    assert.equal(ios.v("sizeMegabytes", { n: 1234 }), "1,234 MB");
    assert.equal(textFor("sv").v("sizeMegabytes", { n: 1234 }), "1 234 MB");
    assert.equal(ios.v("savedTo", { folder: "$& Downloads" }), "Saved to $& Downloads.");
    // English fills in for a language the table lacks (a language the kit adds before the vault does).
    const fallback = i18n().vaultText({
      language: "xx",
      format: format("en"),
      app: "A",
      platform: "ios",
    });
    assert.equal(fallback.v("importTitle"), "Restore");
    const { interpolate } = i18n();
    assert.equal(interpolate("{count} of {missing}", { count: 2 }), "2 of {missing}");
  }
);

test("i18n: vp picks the plural form from the language's rules", { skip }, () => {
  const en = textFor("en");
  assert.equal(en.vp("restoredMediaSkipped", 1), "1 photo could not be restored.");
  assert.equal(en.vp("restoredMediaSkipped", 2), "2 photos could not be restored.");
  assert.equal(en.vp("restoredMediaSkipped", 1200), "1,200 photos could not be restored.");
  // French counts 0 as "one"; Spanish uses "many" for a million, which takes _other.
  assert.equal(textFor("fr").vp("restoredMediaSkipped", 0), "0 photo n’a pas pu être restaurée.");
  assert.equal(
    textFor("es").vp("restoredMediaSkipped", 1_000_000),
    "No se pudieron restaurar 1.000.000 fotos."
  );
  assert.equal(
    textFor("ja").vp("restoredRepairs", 1),
    textFor("ja").vp("restoredRepairs", 5).replace("5", "1")
  );
});

test("i18n: when() uses the dateTime template and survives a bad timestamp", { skip }, () => {
  const iso = "2026-10-04T15:30:12.345Z";
  assert.equal(textFor("en").when(iso), "2026-10-04, 15:30");
  assert.equal(textFor("fr").when(iso), "2026-10-04 à 15:30");
  assert.equal(textFor("sv").when(Date.parse(iso)), "2026-10-04 kl. 15:30");
  assert.equal(textFor("en").when("not a date"), "not a date");
});

test("i18n: every key renders in every language with nothing left unfilled", { skip }, () => {
  const { vaultStrings } = modules.strings;
  const values = {
    date: "D",
    time: "T",
    count: 3,
    n: 12,
    size: "12 MB",
    provider: "iCloud",
    other: apps.macro.name,
    email: "person@example.com",
    folder: "Downloads",
    version: "1.2.3",
  };
  for (const language of Object.keys(vaultStrings)) {
    const { v } = textFor(language);
    for (const key of Object.keys(vaultStrings.en)) {
      const text = v(key, values);
      assert.ok(text.trim(), `${language}.${key}`);
      assert.doesNotMatch(text, /[{}]/, `${language}.${key}: ${text}`);
    }
  }
});

test("i18n: useVaultText reads the kit's language and formatter", { skip }, () => {
  const { useVaultText } = i18n({ platform: "android", language: "nl" });
  const text = useVaultText();
  assert.equal(text.language, "nl");
  assert.equal(text.health, "Health Connect");
  assert.equal(
    text.v("handoffRestoreBody"),
    `Er is een back-up van ${apps.lift.name} van een ander apparaat beschikbaar.`
  );
});
