// Vector Kit test wrapper (synced, hash-checked; body, lift and macro run it through `node --test tests/*.test.cjs`,
// fitness-native through `node --test tests/vector.test.cjs` beside jest: Jest 29's default testMatch skips .cjs,
// Jest 30 needs it in testPathIgnorePatterns).
// It runs the drift check and the offline CSS compile, then unit-tests the kit's pure modules (format, strings,
// script, sheets, chart helpers, the provider's platform guards) by transpiling them with the repo's own
// typescript, the same pattern as tests/harness.cjs.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} = require("node:fs");
const { createRequire } = require("node:module");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

// `node --test` runs from the repo root; the canonical kit (no package.json) borrows a sibling repo's typescript.
const root = process.cwd();
const canonical = !existsSync(path.join(root, "package.json"));
const tool = path.join(root, "scripts", "vector-kit.mjs");
const kitLanguages = ["en", "es", "fr", "de", "it", "pt", "nl", "sv", "ja", "ko", "zh"];

const bases = canonical
  ? [
      root,
      ...["lift-track", "body-track", "macro-track", "water-track", "fitness-native"].map((dir) =>
        path.join(root, "..", "..", dir)
      ),
    ]
  : [root];
// The app's languages: vector.config.json `locales` (fitness-native ships English only), else the 11 kit languages.
const appLocales = (() => {
  try {
    const config = JSON.parse(readFileSync(path.join(root, "vector.config.json"), "utf8"));
    return Array.isArray(config.locales) && config.locales.length ? config.locales : kitLanguages;
  } catch {
    return kitLanguages;
  }
})();

function typescript() {
  for (const base of bases) {
    try {
      return createRequire(path.join(base, "package.json"))("typescript");
    } catch {}
  }
  throw new Error("typescript not found: run the repo's install first");
}

/** A file under the repo's node_modules (the canonical kit borrows a sibling's); null when not installed. */
function moduleFile(file) {
  for (const base of bases) {
    const full = path.join(base, "node_modules", ...file.split("/"));
    if (existsSync(full)) return full;
  }
  return null;
}

/** Transpiles a kit module to CommonJS and evaluates it; `globals` shadow globals such as Intl. */
function load(file, modules = {}, globals = {}) {
  const ts = typescript();
  const source = readFileSync(path.join(root, "src", "vector", file), "utf8");
  // fileName + jsx let .tsx kit modules (chart) load too; their React imports come from the module map.
  const { outputText } = ts.transpileModule(source, {
    fileName: file,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  });
  const module = { exports: {} };
  const names = Object.keys(globals);
  const run = vm.compileFunction(outputText, ["require", "module", "exports", ...names], {
    filename: file,
  });
  run(
    (name) => {
      if (name in modules) return modules[name];
      throw new Error(`kit module ${file} imports ${name}; add it to the test's module map`);
    },
    module,
    module.exports,
    ...names.map((n) => globals[n])
  );
  return module.exports;
}

const run = (...args) =>
  spawnSync(process.execPath, [tool, ...args], { cwd: root, encoding: "utf8" });
const report = (r) => `${r.stdout}\n${r.stderr}`;

// Drift only: the app-code rules run in `pnpm lint` (vector-kit check), so a repo that has synced the kit but has
// no vector.allow.json yet (MIGRATION S1–S9) still tests green on kit integrity.
void test("vector-kit check --drift: no drift, generated tokens current", () => {
  const r = run("check", "--drift");
  assert.equal(r.status, 0, report(r));
});

void test("vector-kit check --css: kit CSS compiles with the installed HeroUI / Uniwind / Tailwind", () => {
  const r = run("check", "--css");
  assert.equal(r.status, 0, report(r));
});

void test("localeTag keeps the device region and pins Simplified Chinese", () => {
  const { localeTag } = load("format.ts");
  assert.equal(localeTag("en", [{ languageCode: "en", regionCode: "GB" }]), "en-GB");
  assert.equal(localeTag("en"), "en-US");
  assert.equal(localeTag("zh", [{ languageCode: "zh", regionCode: "TW" }]), "zh-Hans-CN");
  assert.equal(localeTag("pt", [{ languageCode: "es", regionCode: "MX" }]), "pt-BR");
});

void test("isMonoSafe admits locale numbers and rejects ideographs", () => {
  const { createFormat, isMonoSafe } = load("format.ts");
  const fr = createFormat("fr-FR").number(1234.5, 1);
  assert.ok(isMonoSafe(fr), JSON.stringify(fr));
  assert.ok(isMonoSafe("1 234,5"));
  assert.ok(isMonoSafe(createFormat("de-DE").number(-3, 0)));
  assert.equal(isMonoSafe("3月12日"), false);
  assert.equal(isMonoSafe("٧٢٫٥"), false);
});

void test("every kit language has all 24 kit strings", () => {
  const { kitStrings } = load("strings.ts");
  const keys = Object.keys(kitStrings.en).sort();
  assert.equal(keys.length, 24);
  assert.deepEqual(Object.keys(kitStrings), kitLanguages);
  for (const language of kitLanguages) {
    assert.deepEqual(Object.keys(kitStrings[language]).sort(), keys, language);
    for (const key of keys) assert.ok(kitStrings[language][key].trim(), `${language}.${key}`);
  }
});

void test("scriptOf classifies by language, never by string content", () => {
  const strings = load("strings.ts");
  const { scriptOf, isKitLanguage } = load("script.ts", { "./strings": strings });
  assert.equal(scriptOf("en"), "cased");
  assert.equal(scriptOf("ja"), "cjk");
  assert.equal(scriptOf("zh-Hant"), "cjk");
  assert.equal(scriptOf("ar"), "arabic");
  assert.equal(scriptOf("he"), "hebrew");
  assert.ok(isKitLanguage("sv"));
  assert.equal(isKitLanguage("ar"), false);
});

// chart.tsx renders through React; only its pure scale and range helpers run here, so its imports are stubs.
const loadChart = () =>
  load(
    "chart.tsx",
    Object.fromEntries(
      [
        "react",
        "react/jsx-runtime",
        "react-native",
        "react-native-svg",
        "tailwind-merge",
        "uniwind",
        "./form",
        "./icon",
        "./provider",
        "./text",
      ].map((name) => [name, {}])
    )
  );

void test("rangeStart stays between the first day with data and today", () => {
  const { rangeStart, daysBetween } = loadChart();
  assert.equal(rangeStart("1W", "2026-09-29", "2026-01-01"), "2026-09-23");
  assert.equal(rangeStart("1M", "2026-09-29", "2026-01-01"), "2026-08-31");
  assert.equal(rangeStart("All", "2026-09-29", "2026-01-01"), "2026-01-01");
  assert.equal(rangeStart("1Y", "2026-09-29", "2026-09-01"), "2026-09-01");
  assert.equal(rangeStart("3M", "2026-09-29", "2026-10-02"), "2026-09-29");
  assert.equal(daysBetween("2026-09-01", "2026-09-29"), 28);
  assert.equal(daysBetween("2026-09-29T10:00:00Z", "2026-09-29T16:00:00Z"), 0.25);
});

void test("chart scale and ticks: 3 to 5 round grid values, a minimum span, and a zero floor", () => {
  const { chartScale, chartTicks } = loadChart();
  for (const values of [
    [80.2, 83.9],
    [2310, 2590],
    [0.1, 0.3],
    [0, 0.052],
    [72, 72],
    [-3, 4],
  ]) {
    const scale = chartScale(values);
    const ticks = chartTicks(scale);
    const what = `${values.join(", ")}: ${ticks.join(", ")}`;
    assert.ok(ticks.length >= 3 && ticks.length <= 5, what);
    for (const t of ticks) assert.ok(t >= scale.min && t <= scale.max, what);
    for (const t of ticks) assert.ok(!Object.is(t, -0) && String(t).length < 8, what);
  }
  const flat = chartScale([80, 80.4], 2);
  assert.ok(flat.max - flat.min >= 2);
  assert.equal(chartScale([0.01, 0.05], 0, true).min, 0);
  assert.equal(chartScale([120, 180], 0, true).min, 0);
});

void test("parseDecimal reads locale decimals, grouping and Arabic-Indic digits", () => {
  const { parseDecimal } = load("format.ts");
  assert.equal(parseDecimal("72,5", "de-DE"), 72.5);
  assert.equal(parseDecimal("1.234,5", "de-DE"), 1234.5);
  assert.equal(parseDecimal("٧٢٫٥", "ar-EG"), 72.5);
  assert.equal(parseDecimal("1.2.3", "en-US"), null);
  assert.equal(parseDecimal("72.5", "fr-FR"), 72.5);
  assert.equal(parseDecimal("−3", "en-US"), -3);
  assert.equal(parseDecimal("abc", "en-US"), null);
  assert.equal(parseDecimal("", "en-US"), null);
  // Repeated locale decimals are not grouping; the locale's own grouping mark before three digits is.
  assert.equal(parseDecimal("1.234.567", "en-US"), null);
  assert.equal(parseDecimal("1,234,567", "en-US"), 1234567);
  assert.equal(parseDecimal("1.234.567", "de-DE"), 1234567);
  assert.equal(parseDecimal("1,234,5", "de-DE"), null);
  assert.equal(parseDecimal("2,200", "en-US"), 2200);
  assert.equal(parseDecimal("2.200", "de-DE"), 2200);
  assert.equal(parseDecimal("0,250", "en-US"), 0.25);
  assert.equal(parseDecimal("1,5", "en-US"), 1.5);
  assert.equal(parseDecimal("1,234.5", "en-US"), 1234.5);
  assert.equal(parseDecimal("1.2,3", "de-DE"), null);
});

void test("unitParts keeps the locale's order and value-unit spacing", () => {
  const { createFormat } = load("format.ts");
  assert.equal(createFormat("ko-KR").unitParts(72.5, "milliliter", 1).space, "");
  assert.equal(createFormat("zh-Hans-CN").unitParts(2, "liter").space, "");
  const de = createFormat("de-DE").unitParts(72.5, "kilogram", 1);
  assert.deepEqual([de.value, de.unit, de.unitFirst], ["72,5", "kg", false]);
  assert.ok(/^\s$/u.test(de.space), JSON.stringify(de.space));
  assert.equal(createFormat("en-US").unitParts(-3, "kilogram").value, "\u22123");
});

void test("Android Hermes unit parts preserve values when returned as one unsplit part", () => {
  const full = load("format.ts");
  for (const partType of ["literal", "integer"]) {
    function AndroidNumberFormat(tag, options = {}) {
      const f = new Intl.NumberFormat(tag, options);
      return {
        format: (n) => f.format(n),
        formatToParts: (n) => options.style === "unit"
          ? [{ type: partType, value: f.format(n) }]
          : f.formatToParts(n),
        resolvedOptions: () => f.resolvedOptions(),
      };
    }
    AndroidNumberFormat.prototype.formatToParts = Intl.NumberFormat.prototype.formatToParts;
    const android = load("format.ts", {}, {
      Intl: Object.assign(Object.create(Intl), { NumberFormat: AndroidNumberFormat }),
    });
    assert.equal(android.intlSupport.parts, true);
    assert.equal(android.intlSupport.unitStyle, true);
    for (const tag of ["en-US", "fr-FR", "de-DE", "ko-KR", "zh-Hans-CN", "ar-EG"]) {
      for (const unit of ["kilogram", "centimeter", "milliliter", "milligram"]) {
        for (const n of [0, -3, 79.4, 2500]) {
          assert.deepEqual(android.createFormat(tag).unitParts(n, unit, 1),
            full.createFormat(tag).unitParts(n, unit, 1), `${partType} ${tag} ${unit} ${n}`);
        }
      }
    }
    assert.equal(android.createFormat("en-US").unit(125, "milligram"), "125 mg");
    assert.deepEqual(android.createFormat("en-US").percentParts(.18),
      full.createFormat("en-US").percentParts(.18));
  }
});

void test("an engine whose unit output is converted or uses # for pounds falls back to number + abbreviation", () => {
  // Hermes on iOS formats units through NSMeasurementFormatter, which may rescale: 38 h came out as "136,800s".
  const toSeconds = { hour: 3600, minute: 60 };
  function ConvertingNumberFormat(tag, options = {}) {
    const f = new Intl.NumberFormat(tag, options);
    const factor = options.style === "unit" ? toSeconds[options.unit] : undefined;
    const plain = new Intl.NumberFormat(tag);
    const pound = options.style === "unit" && options.unit === "pound";
    return {
      format: (n) =>
        factor ? `${plain.format(n * factor)}s` : pound ? `${plain.format(n)}#` : f.format(n),
      resolvedOptions: () => f.resolvedOptions(),
    };
  }
  const kit = load("format.ts", {}, {
    Intl: Object.assign(Object.create(Intl), { NumberFormat: ConvertingNumberFormat }),
  });
  // The load-time probe catches the engine, so every unit takes the fallback, not just the converted ones.
  assert.equal(kit.intlSupport.unitStyle, false);
  const fmt = kit.createFormat("en-US");
  assert.equal(fmt.unit(293, "pound"), "293 lb");
  assert.equal(fmt.unit(38, "hour"), "38 h");
  assert.equal(fmt.unit(6, "minute"), "6 min");
  assert.deepEqual(fmt.unitParts(6, "minute"), { value: "6", unit: "min", unitFirst: false, space: "\u00A0" });
  assert.equal(fmt.unit(72.5, "kilogram", 1), "72.5 kg");
});

void test("unitParts and parseDecimal work without formatToParts (Hermes on iOS)", () => {
  // Hermes' NumberFormat has format but no formatToParts; the kit must not call it there.
  function HermesNumberFormat(tag, options) {
    const f = new Intl.NumberFormat(tag, options);
    return { format: (n) => f.format(n), resolvedOptions: () => f.resolvedOptions() };
  }
  const hermesIntl = Object.assign(Object.create(Intl), { NumberFormat: HermesNumberFormat });
  const hermes = load("format.ts", {}, { Intl: hermesIntl });
  const full = load("format.ts");
  assert.equal(hermes.intlSupport.parts, false);
  const units = ["kilogram", "milliliter", "liter", "fluid-ounce", "centimeter"];
  for (const tag of ["en-US", "fr-FR", "de-DE", "sv-SE", "ja-JP", "ko-KR", "zh-Hans-CN", "ar-EG"]) {
    for (const unit of units) {
      assert.deepEqual(
        hermes.createFormat(tag).unitParts(72.5, unit, 1),
        full.createFormat(tag).unitParts(72.5, unit, 1),
        `${tag} ${unit}`
      );
    }
    assert.equal(hermes.decimalSeparator(tag), full.decimalSeparator(tag), tag);
    for (const typed of ["72,5", "72.5", "1.234,5", "1,234.5", "2,200", "٧٢٫٥"]) {
      assert.equal(hermes.parseDecimal(typed, tag), full.parseDecimal(typed, tag), `${tag} ${typed}`);
    }
  }
});

void test("createFormat signs deltas", () => {
  const { createFormat } = load("format.ts");
  assert.equal(createFormat("en-US").number(3, 0, true), "+3");
  assert.equal(createFormat("en-US").number(0, 0, true), "0");
  assert.equal(createFormat("en-US").duration(92), "1:32");
  assert.equal(createFormat("en-US").duration(3725), "1:02:05");
});

void test("createFormat still returns strings without ListFormat, PluralRules or RelativeTimeFormat", () => {
  const sandbox = {};
  for (const key of Object.getOwnPropertyNames(Intl)) {
    if (!["ListFormat", "PluralRules", "RelativeTimeFormat"].includes(key))
      sandbox[key] = Intl[key];
  }
  const { createFormat, intlSupport } = load("format.ts", {}, { Intl: sandbox });
  assert.equal(intlSupport.list, false);
  assert.equal(intlSupport.plural, false);
  assert.equal(intlSupport.relative, false);
  const f = createFormat("de-DE");
  assert.equal(typeof f.list(["a", "b"]), "string");
  assert.equal(f.plural(1), "one");
  assert.equal(f.plural(2), "other");
  assert.equal(f.relativeDays(-1), null);
  assert.equal(typeof f.number(1.5, 1), "string");
  assert.equal(typeof f.unit(72.5, "kilogram", 1), "string");
  assert.equal(typeof f.date(new Date(0)), "string");
});

// Hermes on iOS as the simulator review found it: NumberFormat without formatToParts, units through
// NSMeasurementFormatter (hours and minutes converted, pounds as "#"), no ListFormat, PluralRules or
// RelativeTimeFormat, and no DateTimeFormat.formatRange.
function hermesIntl() {
  const toSeconds = { hour: 3600, minute: 60 };
  function NumberFormat(tag, options = {}) {
    const f = new Intl.NumberFormat(tag, options);
    const plain = new Intl.NumberFormat(tag);
    const factor = options.style === "unit" ? toSeconds[options.unit] : undefined;
    const pound = options.style === "unit" && options.unit === "pound";
    return {
      format: (n) =>
        factor ? `${plain.format(n * factor)}s` : pound ? `${plain.format(n)}#` : f.format(n),
      resolvedOptions: () => f.resolvedOptions(),
    };
  }
  function DateTimeFormat(tag, options) {
    const f = new Intl.DateTimeFormat(tag, options);
    return { format: (d) => f.format(d), resolvedOptions: () => f.resolvedOptions() };
  }
  const sandbox = { NumberFormat, DateTimeFormat };
  for (const key of Object.getOwnPropertyNames(Intl)) {
    if (!(key in sandbox) && !["ListFormat", "PluralRules", "RelativeTimeFormat"].includes(key))
      sandbox[key] = Intl[key];
  }
  return sandbox;
}
const defaultTags = [
  ["en", "en-US"],
  ["es", "es-ES"],
  ["fr", "fr-FR"],
  ["de", "de-DE"],
  ["it", "it-IT"],
  ["pt", "pt-BR"],
  ["nl", "nl-NL"],
  ["sv", "sv-SE"],
  ["ja", "ja-JP"],
  ["ko", "ko-KR"],
  ["zh", "zh-Hans-CN"],
];

void test("number, percent and unit styles: fixed decimals, ungrouped Field text, signed deltas", () => {
  const { createFormat, parseDecimal } = load("format.ts");
  const en = createFormat("en-US");
  assert.equal(en.number(80, 1), "80.0");
  assert.equal(en.number(80, 1, { fixed: false }), "80");
  assert.equal(en.number(2000), "2,000");
  assert.equal(en.number(2000, 0, { grouping: false }), "2000");
  assert.equal(en.unit(80, "kilogram", 1), "80 kg");
  assert.equal(en.unit(80, "kilogram", 1, { fixed: true }), "80.0 kg");
  assert.equal(createFormat("de-DE").unitParts(80, "kilogram", 1, { fixed: true }).value, "80,0");
  assert.equal(en.unit(0.4, "kilogram", 1, { signed: true }), "+0.4 kg");
  assert.equal(en.percent(0.0005, 3), "0.05%");
  assert.equal(en.percent(0.0005, 3, { fixed: true }), "0.050%");
  assert.equal(en.percent(0.05, 0, true), "+5%");
  // A seeded Field never holds grouping, so what a person edits reads back as what they see.
  for (const [tag, n] of [
    ["en-US", 2000],
    ["de-DE", 2000],
    ["fr-FR", 1234.5],
    ["sv-SE", 2500],
  ]) {
    const text = createFormat(tag).editable(n);
    assert.equal(parseDecimal(text, tag), n, `${tag} ${text}`);
    assert.equal(parseDecimal(text.slice(0, -1), tag), Number(String(n).slice(0, -1)), tag);
  }
  assert.equal(en.editable(72.456), "72.46");
  assert.equal(en.editable(72.456, 1), "72.5");
});

void test("typographic minus (U+2212) in every display format; Field text keeps the typed hyphen-minus", () => {
  const { createFormat, parseDecimal, isMonoSafe } = load("format.ts");
  const en = createFormat("en-US");
  assert.equal(en.number(-2), "−2");
  assert.equal(en.number(-2, 0, true), "−2");
  assert.equal(en.number(3, 0, true), "+3");
  // A delta that rounds to zero is zero, never "−0.0".
  assert.equal(en.number(-0.04, 1, true), "0.0");
  assert.equal(en.number(-0.3), "0");
  assert.equal(en.percent(-0.125, 1), "−12.5%");
  assert.equal(en.unit(-0.4, "kilogram", 1), "−0.4 kg");
  assert.equal(en.unitParts(-3, "kilogram").value, "−3");
  assert.equal(en.range(-3, 4), "−3 – 4");
  // A hyphen that separates two numbers (es ranges) is not a minus.
  assert.equal(createFormat("es-ES").range(-3, 4), "−3 - 4");
  // sv already writes U+2212.
  assert.equal(createFormat("sv-SE").number(-2), "−2");
  assert.equal(en.editable(-2.5), "-2.5");
  // Field text holds the keyboard's hyphen-minus in sv too; he and ar keep the bidi mark before it.
  assert.equal(createFormat("sv-SE").editable(-5.5), "-5,5");
  assert.equal(createFormat("he-IL").editable(-5.5), "\u200e-5.5");
  assert.equal(parseDecimal(createFormat("sv-SE").editable(-5.5), "sv-SE"), -5.5);
  assert.equal(parseDecimal(en.number(-2.5, 1), "en-US"), -2.5);
  assert.equal(parseDecimal(createFormat("ar-EG").editable(-2.5), "ar-EG"), -2.5);
  assert.ok(isMonoSafe(en.number(-1234.5, 1)));
});

void test("percentParts: the locale's sign, order and spacing, identical without formatToParts", () => {
  const full = load("format.ts");
  const hermes = load("format.ts", {}, { Intl: hermesIntl() });
  assert.equal(hermes.intlSupport.parts, false);
  assert.deepEqual(full.createFormat("en-US").percentParts(0.5), {
    value: "50",
    unit: "%",
    unitFirst: false,
    space: "",
  });
  const fr = full.createFormat("fr-FR").percentParts(0.125, 1);
  assert.deepEqual([fr.value, fr.unit, fr.unitFirst], ["12,5", "%", false]);
  assert.ok(/^\s$/u.test(fr.space), JSON.stringify(fr.space));
  // `.unit` alone is a Field suffix.
  assert.equal(full.createFormat("de-DE").percentParts(0).unit, "%");
  assert.equal(full.createFormat("en-US").percentParts(-0.05, 0, true).value, "−5");
  const cases = [
    [0.5, 0, false],
    [0.125, 1, false],
    [-0.125, 1, true],
    [12.3456, 0, false],
    [0.0005, 3, { fixed: true }],
    [-3.2, 1, { grouping: false }],
  ];
  for (const tag of [...defaultTags.map(([, t]) => t), "ar-EG"]) {
    for (const [n, digits, style] of cases) {
      const f = full.createFormat(tag);
      const h = hermes.createFormat(tag);
      const what = `${tag} ${JSON.stringify(n)} ${JSON.stringify(style)}`;
      assert.deepEqual(h.percentParts(n, digits, style), f.percentParts(n, digits, style), what);
      assert.equal(h.percent(n, digits, style), f.percent(n, digits, style), what);
      assert.equal(h.number(n * 100, digits, style), f.number(n * 100, digits, style), what);
      assert.equal(h.editable(n * 1000), f.editable(n * 1000), what);
    }
  }
});

void test("gram through Intl; milligram through the kit's translated symbol in the gram's spacing", () => {
  const { createFormat } = load("format.ts");
  const { kitStrings } = load("strings.ts");
  const en = createFormat("en-US", { strings: kitStrings.en });
  assert.equal(en.unit(150, "gram"), "150 g");
  assert.deepEqual(en.unitParts(95, "milligram"), {
    value: "95",
    unit: "mg",
    unitFirst: false,
    space: " ",
  });
  assert.equal(en.unit(95, "milligram"), "95 mg");
  assert.equal(createFormat("ko-KR", { strings: kitStrings.ko }).unit(95, "milligram"), "95mg");
  // A CJK symbol attaches to its number, as Intl's own CJK units do ("2升").
  const zh = createFormat("zh-Hans-CN", { strings: { unitMilligram: "毫克" } });
  assert.equal(zh.unit(95, "milligram"), "95毫克");
  // A direct createFormat caller (no kit strings) still gets a symbol.
  assert.equal(createFormat("de-DE").unit(1.5, "milligram", 1), "1,5 mg");
  // Units untrusted (Hermes on iOS): the number, then the symbol, the kit's translated gram included.
  const hermes = load("format.ts", {}, { Intl: hermesIntl() });
  assert.equal(hermes.createFormat("en-US").unit(12, "gram"), "12 g");
  assert.equal(hermes.createFormat("zh-Hans-CN", { strings: { unitGram: "克" } }).unit(12, "gram"), "12 克");
  assert.deepEqual(hermes.createFormat("en-US").unitParts(95, "milligram"), {
    value: "95",
    unit: "mg",
    unitFirst: false,
    space: " ",
  });
  assert.equal(hermes.createFormat("en-US").unit(80, "kilogram", 1, { fixed: true }), "80.0 kg");
  assert.equal(hermes.createFormat("en-US").unit(-0.4, "kilogram", 1), "−0.4 kg");
  // An engine that rejects one unit outright (RangeError) falls back instead of throwing during render.
  function RejectingNumberFormat(tag, options = {}) {
    if (options.style === "unit" && options.unit === "stone") throw new RangeError("stone");
    return new Intl.NumberFormat(tag, options);
  }
  RejectingNumberFormat.prototype = Intl.NumberFormat.prototype;
  const rejecting = load("format.ts", {}, {
    Intl: Object.assign(Object.create(Intl), { NumberFormat: RejectingNumberFormat }),
  });
  assert.equal(rejecting.intlSupport.unitStyle, true);
  assert.equal(rejecting.createFormat("en-GB").unit(11, "stone"), "11 st");
  assert.equal(rejecting.createFormat("en-GB").unitParts(11, "stone").unit, "st");
});

void test("date styles: month-day, month-year, year, weekdays, and ranges with a year, with and without formatRange", () => {
  const full = load("format.ts");
  const hermes = load("format.ts", {}, { Intl: hermesIntl() });
  const start = new Date(2026, 8, 22, 12);
  const day = new Date(2026, 8, 29, 12);
  const en = full.createFormat("en-US");
  assert.equal(en.monthDay(day), "Sep 29");
  assert.equal(en.monthYear(day), "September 2026");
  assert.equal(en.monthYear(day, "short"), "Sep 2026");
  assert.equal(en.year(day), "2026");
  assert.equal(en.weekdayLong(day), "Tuesday");
  assert.equal(en.weekdayNarrow(day), "T");
  assert.equal(en.date(day, "long"), "September 29, 2026");
  assert.equal(en.monthDay(day.getTime()), "Sep 29");
  assert.equal(full.createFormat("ja-JP").monthYear(day), "2026年9月");
  assert.equal(full.createFormat("de-DE").weekdayLong(day), "Dienstag");
  assert.equal(en.dateRange(start, day), "Sep 22 – 29");
  assert.equal(en.dateRange(start, day, { year: true }), "Sep 22 – 29, 2026");
  // Without formatRange (Hermes): the year once, on the end date, unless the range spans two years.
  assert.equal(hermes.intlSupport.dateRange, false);
  const h = hermes.createFormat("en-US");
  assert.equal(h.dateRange(start, day), "Sep 22 – Sep 29");
  assert.equal(h.dateRange(start, day, { year: true }), "Sep 22 – Sep 29, 2026");
  assert.equal(
    h.dateRange(new Date(2025, 11, 29, 12), new Date(2026, 0, 4, 12), { year: true }),
    "Dec 29, 2025 – Jan 4, 2026"
  );
  // ja, ko and zh write the year first, so it goes on the start date.
  const end = new Date(2026, 8, 28, 12);
  for (const [tag, text] of [
    ["ja-JP", "2026年9月22日 – 9月28日"],
    ["ko-KR", "2026년 9월 22일 – 9월 28일"],
    ["zh-Hans-CN", "2026年9月22日 – 9月28日"],
    ["de-DE", "22. Sept. – 28. Sept. 2026"],
  ])
    assert.equal(hermes.createFormat(tag).dateRange(start, end, { year: true }), text, tag);
  for (const fn of ["monthDay", "monthYear", "year", "weekdayLong", "weekdayNarrow"])
    assert.equal(h[fn](day), en[fn](day), fn);
});

void test("list: conjunction, disjunction and unit; the kit's templates stand in for Intl.ListFormat", () => {
  const full = load("format.ts");
  const bare = load("format.ts", {}, { Intl: hermesIntl() });
  const { kitStrings } = load("strings.ts");
  const en = full.createFormat("en-US");
  assert.equal(en.list(["a", "b", "c"]), "a, b, and c");
  assert.equal(en.list(["a", "b", "c"], { type: "disjunction" }), "a, b, or c");
  assert.equal(en.list(["1 hr", "5 min"], { type: "unit", style: "narrow" }), "1 hr 5 min");
  assert.equal(bare.intlSupport.list, false);
  for (const [language, tag] of defaultTags) {
    const intl = full.createFormat(tag);
    const kit = bare.createFormat(tag, { strings: kitStrings[language] });
    for (const type of ["conjunction", "disjunction"]) {
      assert.equal(kit.list(["a", "b"], { type }), intl.list(["a", "b"], { type }), `${tag} ${type}`);
      // Three or more match too, except en's serial comma and ja's "、または" (one template covers the last pair).
      if (language !== "en" && !(language === "ja" && type === "disjunction")) {
        const three = ["a", "b", "c"];
        assert.equal(kit.list(three, { type }), intl.list(three, { type }), `${tag} ${type} 3`);
      }
    }
    assert.equal(kit.list(["x"]), "x");
  }
  // A direct createFormat caller has no templates: a neutral join, never an English word.
  const de = bare.createFormat("de-DE");
  assert.equal(de.list(["a", "b"]), "a, b");
  assert.equal(de.list(["a", "b"], { type: "disjunction" }), "a / b");
  assert.equal(de.list(["1 h", "5 min"], { type: "unit", style: "narrow" }), "1 h 5 min");
  assert.equal(de.list(["1 h", "5 min"], { type: "unit", style: "short" }), "1 h, 5 min");
  // Items are inserted as text: "$&" and "{1}" survive.
  assert.equal(bare.createFormat("en-US", { strings: kitStrings.en }).list(["$&", "{1}"]), "$& and {1}");
});

void test("icon registry: the glyphs the apps needed, and milk and coffee differ in every renderer", () => {
  const { icons, resolveIcon } = load("icons.ts");
  for (const [name, spec] of Object.entries(icons)) assert.ok(spec.sf && spec.md && spec.ion, name);
  for (const renderer of ["sf", "md", "ion"])
    assert.notEqual(icons.milk[renderer], icons.coffee[renderer], renderer);
  // The Ionicons names the migration shims pass now resolve to semantic keys.
  const needed = {
    "swap-horizontal": "swap",
    "link-outline": "link",
    "flame-outline": "warmUp",
    "arrow-up": "moveUp",
    "arrow-down": "moveDown",
    "arrow-redo-outline": "move",
    repeat: "repeat",
    "construct-outline": "tools",
    "document-text-outline": "document",
    "airplane-outline": "travel",
    "stop-circle-outline": "stop",
    "mic-outline": "mic",
    "copy-outline": "copy",
    "bookmark-outline": "bookmark",
    "today-outline": "today",
    "flag-outline": "flag",
    "options-outline": "options",
    refresh: "refresh",
    "download-outline": "download",
    "camera-reverse-outline": "retake",
    "images-outline": "photoLibrary",
    "ellipse-outline": "unselected",
    "scale-outline": "scale",
    "help-circle-outline": "help",
    "scan-outline": "scanText",
    "cafe-outline": "coffee",
    "pint-outline": "milk",
  };
  for (const [ion, key] of Object.entries(needed)) assert.equal(resolveIcon(ion), key, ion);
  // Every Ionicons name is in the installed font's glyph map (tsc checks the type, this the font).
  const map = moduleFile(
    "@expo/vector-icons/build/vendor/react-native-vector-icons/glyphmaps/Ionicons.json"
  );
  if (map) {
    const glyphs = JSON.parse(readFileSync(map, "utf8"));
    for (const [name, spec] of Object.entries(icons)) assert.ok(spec.ion in glyphs, `${name}: ${spec.ion}`);
  }
});

void test("vector-kit check counts numberOfLines on content text; a pre-1.2 baseline warns until re-baselined", () => {
  const modules = moduleFile("typescript/package.json");
  assert.ok(modules, "typescript not found: run the repo's install first");
  const dir = mkdtempSync(path.join(os.tmpdir(), "vector-lines-"));
  try {
    mkdirSync(path.join(dir, "scripts"));
    mkdirSync(path.join(dir, "src", "vector"), { recursive: true });
    mkdirSync(path.join(dir, "src", "app"), { recursive: true });
    writeFileSync(path.join(dir, "package.json"), "{}\n");
    writeFileSync(path.join(dir, "scripts", "vector-kit.mjs"), readFileSync(tool));
    for (const file of ["manifest.json", "tokens.json"])
      writeFileSync(path.join(dir, "src", "vector", file), readFileSync(path.join(root, "src", "vector", file)));
    symlinkSync(path.resolve(modules, "..", ".."), path.join(dir, "node_modules"), "dir");
    writeFileSync(
      path.join(dir, "src", "app", "screen.tsx"),
      [
        'import { Label, Text } from "@/vector";',
        "const fitted = { numberOfLines: 1, adjustsFontSizeToFit: true };",
        "export const Screen = () => (",
        "  <>",
        "    <Text numberOfLines={2}>clipped</Text>",
        "    <Text numberOfLines={0}>wraps</Text>",
        "    <Label numberOfLines={1}>eyebrow</Label>",
        '    <Text variant="label" numberOfLines={1}>eyebrow</Text>',
        "    <Text {...fitted}>fixed slot</Text>",
        "  </>",
        ");",
        "",
      ].join("\n")
    );
    const check = () =>
      spawnSync(process.execPath, [path.join(dir, "scripts", "vector-kit.mjs"), "check"], {
        cwd: dir,
        encoding: "utf8",
      });
    const allow = (json) => writeFileSync(path.join(dir, "vector.allow.json"), JSON.stringify(json));
    // No baseline: the two clipping sites fail (the copied kit has no other files, so drift fails too).
    let r = check();
    assert.match(r.stderr, /rule {6}lines {2}src\/app\/screen\.tsx {2}2 /, report(r));
    // A baseline written before the rule existed (no `kit` field): a warning, not a failure.
    allow({ rules: {} });
    r = check();
    assert.doesNotMatch(r.stderr, /rule {6}lines/, report(r));
    assert.match(r.stderr, /2 hits of lines/, report(r));
    // Re-baselined with the rule: counted against the baseline like any other.
    allow({ kit: "1.2.0", rules: { lines: { "src/app/screen.tsx": 2 } } });
    r = check();
    assert.doesNotMatch(r.stderr, /rule {6}lines|hits of lines/, report(r));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("vector-kit check counts the signal under another name as accent paint, with no baseline", () => {
  const modules = moduleFile("typescript/package.json");
  assert.ok(modules, "typescript not found: run the repo's install first");
  const dir = mkdtempSync(path.join(os.tmpdir(), "vector-alias-"));
  try {
    mkdirSync(path.join(dir, "scripts"));
    mkdirSync(path.join(dir, "src", "vector"), { recursive: true });
    mkdirSync(path.join(dir, "src", "app"), { recursive: true });
    writeFileSync(path.join(dir, "package.json"), "{}\n");
    writeFileSync(path.join(dir, "scripts", "vector-kit.mjs"), readFileSync(tool));
    for (const file of ["manifest.json", "tokens.json"])
      writeFileSync(path.join(dir, "src", "vector", file), readFileSync(path.join(root, "src", "vector", file)));
    symlinkSync(path.resolve(modules, "..", ".."), path.join(dir, "node_modules"), "dir");
    writeFileSync(
      path.join(dir, "src", "app", "screen.tsx"),
      [
        'import { View } from "react-native";',
        'import { useThemeColor } from "heroui-native";',
        'import { SignalCell, Text } from "@/vector";',
        "export function Screen({ done }: { done: boolean }) {",
        '  const [signal, ink] = useThemeColor(["segment", "segment-foreground"]);',
        "  return (",
        "    <>",
        '      <View className={done ? "bg-segment" : "bg-surface"} />',
        '      <View className="border-segment active:bg-accent-hover" />',
        '      <View className="fill-accent" />',
        '      <Text className="text-segment-foreground">ink is not signal paint</Text>',
        '      <View className="bg-accent-foreground bg-accent-soft" />',
        '      <View className="bg-accent" />',
        '      <SignalCell selected={done} accessibilityLabel="Done" />',
        "    </>",
        "  );",
        "}",
        "",
      ].join("\n")
    );
    const check = () =>
      spawnSync(process.execPath, [path.join(dir, "scripts", "vector-kit.mjs"), "check"], {
        cwd: dir,
        encoding: "utf8",
      });
    const allow = (json) => writeFileSync(path.join(dir, "vector.allow.json"), JSON.stringify(json));
    // bg-segment, border-segment, active:bg-accent-hover, fill-accent and useThemeColor("segment"): 5.
    let r = check();
    assert.match(r.stderr, /rule {6}accent-alias {2}src\/app\/screen\.tsx {2}5 \(no baseline allowed\)/, report(r));
    assert.match(r.stderr, /rule {6}accent {2}src\/app\/screen\.tsx {2}1 /, report(r));
    // A baseline from before 1.2.1 (no `kit` field): the alias warns until the next baseline; accent still fails.
    allow({ rules: {} });
    r = check();
    assert.doesNotMatch(r.stderr, /rule {6}accent-alias/, report(r));
    assert.match(r.stderr, /5 hits of accent-alias/, report(r));
    assert.match(r.stderr, /rule {6}accent {2}/, report(r));
    // Like accent, it allows no baseline: a 1.2.1 allow file that lists the hits still fails.
    allow({ kit: "1.2.1", rules: { "accent-alias": { "src/app/screen.tsx": 5 } } });
    r = check();
    assert.match(r.stderr, /rule {6}accent-alias {2}src\/app\/screen\.tsx {2}5 \(no baseline allowed\)/, report(r));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("vector-kit sync never replaces or deletes an app's own files without --force", { skip: !canonical }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vector-sync-"));
  const file = (...p) => path.join(dir, ...p);
  const own = "/* the app's own theme */\n";
  try {
    writeFileSync(file("package.json"), "{}\n");
    mkdirSync(file("src"));
    writeFileSync(file("src", "global.css"), own);
    writeFileSync(file("src", "vector-adapter.tsx"), "export {};\n");
    // First sync: the app's global.css sits at a kit path, so nothing is written.
    let r = run("sync", dir);
    assert.equal(r.status, 1, report(r));
    assert.match(r.stderr, /app file {2}src\/global\.css/);
    assert.equal(readFileSync(file("src", "global.css"), "utf8"), own);
    assert.equal(existsSync(file("src", "vector", "manifest.json")), false);
    // --force adopts the kit; app-owned paths stay untouched.
    r = run("sync", dir, "--force");
    assert.equal(r.status, 0, report(r));
    assert.equal(
      readFileSync(file("src", "global.css"), "utf8"),
      readFileSync(path.join(root, "src", "global.css"), "utf8")
    );
    assert.equal(readFileSync(file("src", "vector-adapter.tsx"), "utf8"), "export {};\n");
    // A file an earlier kit shipped (in the repo's manifest) and this one does not is removed; an app file in
    // src/vector is kept and reported.
    const manifestPath = file("src", "vector", "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const body = "export {};\n";
    writeFileSync(file("src", "vector", "retired.ts"), body);
    manifest.files["src/vector/retired.ts"] = `sha256-${createHash("sha256").update(body).digest("hex")}`;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    writeFileSync(file("src", "vector", "mine.ts"), body);
    r = run("sync", dir);
    assert.equal(r.status, 1, report(r)); // mine.ts is unknown in a kit folder: the local-edit guard
    r = run("sync", dir, "--force");
    assert.equal(r.status, 0, report(r));
    assert.equal(existsSync(file("src", "vector", "retired.ts")), false);
    assert.equal(existsSync(file("src", "vector", "mine.ts")), true);
    assert.match(r.stderr, /kept src\/vector\/mine\.ts/);
    // An app file where the repo's manifest lists nothing (a path a newer kit starts shipping) is guarded too.
    rmSync(file("src", "vector", "mine.ts"));
    const current = JSON.parse(readFileSync(manifestPath, "utf8"));
    delete current.files["docs/design-system.md"];
    writeFileSync(manifestPath, JSON.stringify(current));
    writeFileSync(file("docs", "design-system.md"), "# app notes\n");
    r = run("sync", dir);
    assert.equal(r.status, 1, report(r));
    assert.match(r.stderr, /app file {2}docs\/design-system\.md/);
    assert.equal(readFileSync(file("docs", "design-system.md"), "utf8"), "# app notes\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("vector-kit sync: a generated oxlint.vector.json is kit-owned only while it carries the generator's header", { skip: !canonical }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vector-fragment-"));
  const file = (...p) => path.join(dir, ...p);
  const mine = '{ "rules": {} }\n';
  try {
    writeFileSync(file("package.json"), "{}\n");
    mkdirSync(file("src"));
    writeFileSync(file("src", "global.css"), readFileSync(path.join(root, "src", "global.css")));
    let r = run("sync", dir);
    assert.equal(r.status, 0, report(r));
    // An eslint-node repo's own file of that name: the manifest lists the fragment under `generated` for every
    // repo, and a later sync must not take that as an earlier sync's output and delete it.
    writeFileSync(file("oxlint.vector.json"), mine);
    r = run("sync", dir);
    assert.equal(r.status, 0, report(r));
    assert.equal(readFileSync(file("oxlint.vector.json"), "utf8"), mine);
    // Switching to the oxlint profile: the app's file sits where the fragment goes, so sync stops until --force.
    writeFileSync(file("vector.config.json"), JSON.stringify({ profile: "oxlint-jest", locales: ["en"] }));
    r = run("sync", dir);
    assert.equal(r.status, 1, report(r));
    assert.match(r.stderr, /app file {2}oxlint\.vector\.json/);
    r = run("sync", dir, "--force");
    assert.equal(r.status, 0, report(r));
    assert.match(readFileSync(file("oxlint.vector.json"), "utf8"), /^\/\/ Generated by scripts\/vector-kit\.mjs/);
    // Back to eslint-node: the generated fragment (header and all) is the kit's, and goes.
    rmSync(file("vector.config.json"));
    r = run("sync", dir);
    assert.equal(r.status, 0, report(r));
    assert.equal(existsSync(file("oxlint.vector.json")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("web colour pins: HeroUI's color-mix() colours as hex, mixed in OKLab, in the web variant only", () => {
  const css = readFileSync(path.join(root, "src", "vector", "tokens.css"), "utf8");
  const at = css.indexOf("@variant web {");
  assert.ok(at > 0, "tokens.css has no web block (run gen)");
  const block = css.slice(at, css.indexOf("/* TOKENS:END */"));
  const light = block.slice(block.indexOf("@variant light"), block.indexOf("@variant dark"));
  const dark = block.slice(block.indexOf("@variant dark"));
  const pin = (part, name) => new RegExp(`--color-${name}: (#[0-9a-f]{6,8});`).exec(part)?.[1];
  // What a browser computes for color-mix(in oklab, …) from tokens.json (the same values as culori's OKLab).
  assert.equal(pin(light, "accent-hover"), "#22bdd6");
  assert.equal(pin(light, "default-hover"), "#e7ebee");
  assert.equal(pin(dark, "default-hover"), "#1c2a33");
  // The kit's own override (90% warning + black), not HeroUI's formula.
  assert.equal(pin(light, "warning-hover"), "#77540e");
  // With transparent: the colour at that alpha (premultiplied); 88% + 10% scales the alpha to 0.98.
  assert.equal(pin(light, "default-soft"), "#f1f5f780");
  assert.equal(pin(light, "field-border-hover")?.slice(7), "fa");
  // A plain var() override resolves in the browser already: no pin.
  for (const name of ["accent-soft", "field-hover", "field-border-focus", "danger-soft-foreground"])
    assert.equal(pin(light, name), undefined, name);
  // Nothing before the web variant pins a HeroUI-derived colour.
  assert.equal(css.slice(0, at).includes("--color-accent-hover"), false);
});

// provider.tsx needs React only for contexts at module scope; its platform guards are plain functions.
function loadProvider(os, info) {
  const react = {
    createContext: (value) => ({ Provider: "Provider", value }),
    useContext: () => null,
    useEffect() {},
    useMemo: (read) => read(),
    useRef: (current) => ({ current }),
    useState: (value) => [value, () => {}],
  };
  const jsx = (type, props) => ({ type, props });
  const strings = load("strings.ts");
  return load("provider.tsx", {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "react-native": {
      AccessibilityInfo: info,
      I18nManager: { isRTL: false },
      Platform: { OS: os },
      Text: "Text",
      View: "View",
      useWindowDimensions: () => ({ fontScale: 1 }),
    },
    "expo-localization": {},
    uniwind: {},
    "./flags": load("flags.ts"),
    "./format": load("format.ts"),
    "./script": load("script.ts", { "./strings": strings }),
    "./strings": strings,
    "./tokens": load("tokens.ts"),
  });
}

void test("provider on react-native-web: missing accessibility reads are skipped, announce and aria props are web-only", async () => {
  // react-native-web 0.21: no isBoldTextEnabled / isDarkerSystemColorsEnabled, isScreenReaderEnabled always true,
  // announceForAccessibility a no-op, and addEventListener returns undefined for reduceMotionChanged without
  // matchMedia (server rendering).
  const heard = [];
  const rnw = {
    isScreenReaderEnabled: async () => true,
    isReduceMotionEnabled: async () => true,
    addEventListener: (event) => (event === "reduceMotionChanged" ? undefined : { remove() {} }),
    announceForAccessibility: (message) => heard.push(message),
  };
  const web = loadProvider("web", rnw);
  const seen = {};
  const watch = (kit, info) =>
    kit.watchAccessibility(info, {
      boldText: (v) => (seen.bold = v),
      reduceMotion: (v) => (seen.motion = v),
      highContrast: (v) => (seen.contrast = v),
    });
  const stop = watch(web, rnw);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(seen, { motion: true });
  stop();
  // Web speaks through VectorProvider's polite live region, never through the no-op.
  web.announce("Weight saved");
  assert.deepEqual(heard, []);
  assert.deepEqual(web.webA11y({ selected: true, disabled: false }, { now: 40, text: "40%" }), {
    "aria-current": "true",
    "aria-disabled": false,
    "aria-valuenow": 40,
    "aria-valuetext": "40%",
  });
  // `selected` in the attribute the role honours: ARIA ignores aria-selected on buttons, radios and plain elements.
  assert.deepEqual(web.webA11y({ selected: false }), {});
  assert.deepEqual(web.webA11y({ selected: false }, null, "pressed"), { "aria-pressed": false });
  assert.deepEqual(web.webA11y({ selected: true }, null, "selected"), { "aria-selected": true });
  assert.deepEqual(web.webA11y({ selected: true }, null, "checked"), { "aria-checked": true });
  assert.deepEqual(web.webA11y({ checked: false, selected: false }, null, "checked"), { "aria-checked": false });
  assert.deepEqual({ ...web.webHidden }, { "aria-hidden": true });
  // Headings carry their level (react-native-web renders a bare header as h1).
  assert.deepEqual({ ...web.webHeading(2) }, { "aria-level": 2 });
  assert.deepEqual({ ...web.webHeading(undefined) }, {});
  // Keys for a control react-native-web cannot operate: a tab stop, and only used keys stop the default.
  const pressed = [];
  const keys = web.webKeys((key) => {
    pressed.push(key);
    return key === "ArrowRight";
  });
  assert.equal(keys.tabIndex, 0);
  let prevented = 0;
  keys.onKeyDown({ key: "ArrowRight", preventDefault: () => prevented++ });
  keys.onKeyDown({ key: "Tab", preventDefault: () => prevented++ });
  assert.deepEqual(pressed, ["ArrowRight", "Tab"]);
  assert.equal(prevented, 1);
  // iOS: every read runs, announce goes to VoiceOver, and no aria prop is added next to accessibility*.
  const ios = { ...rnw, isBoldTextEnabled: async () => true, isDarkerSystemColorsEnabled: async () => false };
  const native = loadProvider("ios", ios);
  const stopNative = watch(native, ios);
  await new Promise((resolve) => setTimeout(resolve, 0));
  stopNative();
  assert.deepEqual(seen, { motion: true, bold: true, contrast: false });
  native.announce("Weight saved");
  assert.deepEqual(heard, ["Weight saved"]);
  assert.deepEqual({ ...native.webA11y({ selected: true }, { now: 1 }) }, {});
  assert.deepEqual({ ...native.webA11y({ selected: true }, null, "pressed") }, {});
  assert.deepEqual({ ...native.webHidden }, {});
  assert.deepEqual({ ...native.webHeading(2) }, {});
  assert.deepEqual({ ...native.webKeys(() => true) }, {});
});

void test("chart periods: ticks sit on the aggregates' own days, and periodLabel names a scrubbed period", () => {
  const { chartDayTicks, periodLabel } = loadChart();
  const { createFormat } = load("format.ts");
  const en = createFormat("en-US");
  assert.deepEqual(chartDayTicks("2026-09-01", "2026-09-29"), [
    "2026-09-01",
    "2026-09-10",
    "2026-09-20",
    "2026-09-29",
  ]);
  const years = ["2023-01-01", "2024-01-01", "2025-01-01", "2026-01-01", "2022-01-01"];
  assert.deepEqual(chartDayTicks("2022-01-01", "2026-01-01", years), [
    "2022-01-01",
    "2023-01-01",
    "2025-01-01",
    "2026-01-01",
  ]);
  assert.deepEqual(chartDayTicks("2026-09-29", "2026-09-29"), ["2026-09-29"]);
  assert.equal(periodLabel(en, "2026-09-29"), "Sep 29, 2026");
  // Seven days from the period's first day, with the year (ICU's own spacing around the dash).
  assert.equal(
    periodLabel(en, "2026-09-22", "week"),
    en.dateRange(new Date(2026, 8, 22, 12), new Date(2026, 8, 28, 12), { year: true })
  );
  assert.match(periodLabel(en, "2026-09-22", "week"), /^Sep 22\s–\s28, 2026$/u);
  assert.equal(periodLabel(en, "2026-09-01", "month"), "September 2026");
  assert.equal(periodLabel(en, "2026-01-01", "year"), "2026");
});

void test("chart periods: a period that overlaps the range's start is kept, and the domain starts at its first day", () => {
  const { chartDomainStart } = loadChart();
  const months = ["2025-09-01", "2025-10-01", "2025-11-01"];
  // September (keyed Sep 1) overlaps a range from Sep 29, so the domain reaches back to Sep 1 instead of dropping it.
  assert.equal(chartDomainStart("2025-09-29", months, "month"), "2025-09-01");
  // August ends before Sep 1; a range that starts on a period's first day stays where it is.
  assert.equal(chartDomainStart("2025-09-01", ["2025-08-01", ...months], "month"), "2025-09-01");
  assert.equal(chartDomainStart("2025-12-31", ["2025-12-01", "2026-01-01"], "month"), "2025-12-01");
  assert.equal(chartDomainStart("2021-09-29", ["2021-01-01", "2022-01-01"], "year"), "2021-01-01");
  assert.equal(chartDomainStart("2026-09-24", ["2026-09-15", "2026-09-22"], "week"), "2026-09-22");
  // The week of Sep 22 ends on the 28th: a range from the 29th does not reach it.
  assert.equal(chartDomainStart("2026-09-29", ["2026-09-22"], "week"), "2026-09-29");
  // Daily readings keep today's filter.
  assert.equal(chartDomainStart("2026-09-29", ["2026-09-01"], "day"), "2026-09-29");
  assert.equal(chartDomainStart("2026-09-29", ["2026-09-01"]), "2026-09-29");
});

void test("web date and time inputs: only whole days within min…max reach the app, and typed minutes snap to the grid", () => {
  const { dayInRange, onMinuteGrid } = load("field-parts.tsx", {
    "react/jsx-runtime": { jsx: () => null, jsxs: () => null },
    "react-native": { View: "View" },
    "./provider": { webHidden: {} },
    "./text": { Text: "Text" },
  });
  // A year typed digit by digit reports 0002, 0020, 0203, then 2031 (after max): none reaches onChange.
  for (const day of ["0002-09-29", "0020-09-29", "0203-09-29", "2031-09-29", "", "19999-01-01", "1899-12-31"])
    assert.equal(dayInRange(day, "1900-01-01", "2026-09-29"), false, day);
  assert.equal(dayInRange("2025-09-29", "1900-01-01", "2026-09-29"), true);
  assert.equal(dayInRange("2026-09-29", "1900-01-01", "2026-09-29"), true);
  // The native wheel offers only minuteInterval slots: a typed minute rounds to the nearest one within the hour.
  assert.deepEqual(onMinuteGrid("07:33", 5), { hours: 7, minutes: 35 });
  assert.deepEqual(onMinuteGrid("07:32", 5), { hours: 7, minutes: 30 });
  assert.deepEqual(onMinuteGrid("23:58", 5), { hours: 23, minutes: 55 });
  assert.deepEqual(onMinuteGrid("07:33"), { hours: 7, minutes: 33 });
  assert.deepEqual(onMinuteGrid("07:33:00", 1), { hours: 7, minutes: 33 });
  for (const clock of ["", "7:3", "24:00", "07:60"]) assert.equal(onMinuteGrid(clock, 5), null, clock);
});

void test("vector-kit check: label-prop literals count only for a multi-language app; shims, removed tokens and the rem polyfill come from the repo", () => {
  const modules = moduleFile("typescript/package.json");
  assert.ok(modules, "typescript not found: run the repo's install first");
  const dir = mkdtempSync(path.join(os.tmpdir(), "vector-profile-"));
  const file = (...p) => path.join(dir, ...p);
  try {
    mkdirSync(file("scripts"));
    mkdirSync(file("src", "vector"), { recursive: true });
    mkdirSync(file("src", "app"), { recursive: true });
    mkdirSync(file("src", "components", "ui"), { recursive: true });
    writeFileSync(file("package.json"), "{}\n");
    writeFileSync(file("scripts", "vector-kit.mjs"), readFileSync(tool));
    for (const name of ["manifest.json", "tokens.json"])
      writeFileSync(file("src", "vector", name), readFileSync(path.join(root, "src", "vector", name)));
    symlinkSync(path.resolve(modules, "..", ".."), file("node_modules"), "dir");
    writeFileSync(
      file("src", "app", "screen.tsx"),
      [
        'import { View } from "react-native";',
        'import { Field } from "@/vector";',
        'import { Text } from "@/components/ui/text";',
        'import { Kit } from "@/components/uikit";',
        "export const Screen = () => (",
        "  <>",
        '    <Field label="Weight" value="" onChange={() => {}} />',
        '    <Field label={"Height"} value="" onChange={() => {}} />',
        "    {/* eslint-disable-next-line no-restricted-syntax -- a brand name */}",
        '    <Field label="OmegaFyt" value="" onChange={() => {}} />',
        '    <Field label="Beta" value="" onChange={() => {}} /> {/* eslint-disable-line */}',
        '    <View className="text-muted-foreground" />',
        "  </>",
        ");",
        "",
      ].join("\n")
    );
    writeFileSync(file("src", "components", "ui", "text.tsx"), 'export { Text } from "react-native";\n');
    // What ESLint's label rule read besides app code: the shims, and .jsx files.
    writeFileSync(
      file("src", "components", "ui", "button.tsx"),
      'export const Save = () => <Button label="Save" />;\n'
    );
    writeFileSync(file("src", "app", "legacy.jsx"), 'export const Old = () => <Field title="Old" />;\n');
    writeFileSync(
      file("metro.config.js"),
      'module.exports = withUniwindConfig(config, { cssEntryFile: "./src/global.css", polyfills: { rem: 14 } });\n'
    );
    const config = (locales) =>
      writeFileSync(
        file("vector.config.json"),
        JSON.stringify({
          profile: "oxlint-jest",
          locales,
          shims: ["src/components/ui/**"],
          removedTokens: ["muted-foreground"],
        })
      );
    const check = () =>
      spawnSync(process.execPath, [file("scripts", "vector-kit.mjs"), "check"], { cwd: dir, encoding: "utf8" });
    // English only: no label rule; the shim folder is not app code; the dead token fails (no baseline).
    config(["en"]);
    let r = check();
    assert.doesNotMatch(r.stderr, /label-literal/, report(r));
    assert.doesNotMatch(r.stderr, /rn-text/, report(r));
    // Shim imports: anything under the folder shim, never a module that only shares its prefix (@/components/uikit).
    assert.match(r.stderr, /shim imports: 1\b/, report(r));
    assert.match(r.stderr, /rule {6}removed-token {2}src\/app\/screen\.tsx {2}1 \(no baseline allowed\)/, report(r));
    assert.match(r.stderr, /rem polyfill to 14/, report(r));
    assert.match(r.stderr, /missing {3}oxlint\.vector\.json/, report(r));
    // A second language: the unbraced literal counts (the ESLint selector's JSXAttribute > Literal), per file; the
    // lines ESLint's disable comments exempted stay exempt, and the shims and .jsx files count as they did in ESLint.
    config(["en", "de"]);
    r = check();
    assert.match(r.stderr, /rule {6}label-literal {2}src\/app\/screen\.tsx {2}1 \(not in eslintFiles\)/, report(r));
    assert.match(r.stderr, /rule {6}label-literal {2}src\/components\/ui\/button\.tsx {2}1 /, report(r));
    assert.match(r.stderr, /rule {6}label-literal {2}src\/app\/legacy\.jsx {2}1 /, report(r));
    // Only the label rule reads them: the shim's other rules and the .jsx file stay out of the app-file count.
    assert.match(r.stderr, / 1 app files /, report(r));
    writeFileSync(
      file("vector.allow.json"),
      JSON.stringify({
        kit: "1.3.0",
        rules: {},
        eslintFiles: ["src/app/legacy.jsx", "src/app/screen.tsx", "src/components/ui/button.tsx"],
      })
    );
    r = check();
    assert.doesNotMatch(r.stderr, /rule {6}label-literal/, report(r));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("vector-kit check: an oxlint + jest repo is warned when Jest 30's default testMatch would collect the node:test wrapper", () => {
  const modules = moduleFile("typescript/package.json");
  assert.ok(modules, "typescript not found: run the repo's install first");
  const dir = mkdtempSync(path.join(os.tmpdir(), "vector-jest-"));
  const file = (...p) => path.join(dir, ...p);
  try {
    mkdirSync(file("scripts"));
    mkdirSync(file("src", "vector"), { recursive: true });
    mkdirSync(file("node_modules", "jest"), { recursive: true });
    writeFileSync(file("scripts", "vector-kit.mjs"), readFileSync(tool));
    for (const name of ["manifest.json", "tokens.json"])
      writeFileSync(file("src", "vector", name), readFileSync(path.join(root, "src", "vector", name)));
    symlinkSync(path.resolve(modules, ".."), file("node_modules", "typescript"), "dir");
    writeFileSync(file("vector.config.json"), JSON.stringify({ profile: "oxlint-jest", locales: ["en"] }));
    const pkg = (jest) => writeFileSync(file("package.json"), JSON.stringify({ scripts: {}, ...(jest ? { jest } : {}) }));
    const version = (v) => writeFileSync(file("node_modules", "jest", "package.json"), JSON.stringify({ version: v }));
    const check = () =>
      spawnSync(process.execPath, [file("scripts", "vector-kit.mjs"), "check", "--drift"], { cwd: dir, encoding: "utf8" });
    // Jest 29's default testMatch ([tj]s?(x)) skips .cjs: no warning.
    pkg(null);
    version("29.7.0");
    assert.doesNotMatch(report(check()), /collects tests\/vector\.test\.cjs/);
    // Jest 30's default (.?([mc])[jt]s?(x)) takes it.
    version("30.0.2");
    assert.match(report(check()), /jest 30's default testMatch collects tests\/vector\.test\.cjs/);
    // Ignored by path: no warning.
    pkg({ testPathIgnorePatterns: ["/node_modules/", "/tests/vector\\.test\\."] });
    assert.doesNotMatch(report(check()), /collects tests\/vector\.test\.cjs/);
    // A custom testMatch that takes .cjs, whatever the version.
    version("29.7.0");
    pkg({ testMatch: ["**/*.test.?([mc])[jt]s"] });
    assert.match(report(check()), /jest's testMatch \/ testRegex collects tests\/vector\.test\.cjs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("vector-kit sync: an oxlint + jest repo gets a generated oxlint.vector.json instead of eslint.vector.cjs; a declared profile adopts global.css", { skip: !canonical }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vector-oxlint-"));
  const file = (...p) => path.join(dir, ...p);
  try {
    writeFileSync(file("package.json"), JSON.stringify({ scripts: { test: "jest", lint: "oxlint" } }));
    mkdirSync(file("src", "app"), { recursive: true });
    writeFileSync(
      file("src", "global.css"),
      [
        "/* the app's own theme */",
        "@theme inline { --color-muted-foreground: var(--muted); }",
        ':root { --primary: #007088; --font-sans: "JetBrains Mono"; }',
        "",
      ].join("\n")
    );
    writeFileSync(
      file("src", "app", "home.tsx"),
      'export const A = () => <View className="text-muted-foreground" />;\nconst b = "border-muted-foreground/50";\n'
    );
    writeFileSync(file("vector.config.json"), JSON.stringify({ profile: "oxlint-jest", locales: ["en"] }));
    let r = run("sync", dir);
    assert.equal(r.status, 0, report(r));
    assert.match(r.stderr, /replaced {2}src\/global\.css/);
    // What the app's stylesheet defined and nothing defines now: the theme colour (its utilities emit nothing),
    // with its uses and the removedTokens line that makes check count them, and the other custom properties.
    // (--font-sans is a kit token; this repo has no HeroUI or Tailwind installed to define more.)
    assert.match(r.stderr, /dropped {3}--color-muted-foreground \(2 uses in app code\)/, report(r));
    assert.match(r.stderr, /"removedTokens": \["muted-foreground"\]/, report(r));
    assert.match(r.stderr, /1 custom property nothing defines now .*: --primary$/m, report(r));
    assert.doesNotMatch(r.stderr, /--font-sans/, report(r));
    assert.match(r.stderr, /todo .*node --test tests\/vector\.test\.cjs/);
    assert.equal(
      readFileSync(file("src", "global.css"), "utf8"),
      readFileSync(path.join(root, "src", "global.css"), "utf8")
    );
    assert.equal(existsSync(file("eslint.vector.cjs")), false);
    assert.equal(existsSync(file("tests", "vector.test.cjs")), true);
    // JSONC: oxlint rejects a $comment key, so the generated note is a // comment.
    const fragment = () =>
      JSON.parse(readFileSync(file("oxlint.vector.json"), "utf8").replace(/^\/\/.*$/gm, ""));
    assert.equal(fragment().rules["react/jsx-no-literals"], "off");
    assert.deepEqual(fragment().rules["no-restricted-imports"][1].paths[0].importNames, ["Text", "TextInput"]);
    // The repo's own check follows its config: a second language makes the fragment stale until the next sync.
    const drift = () =>
      spawnSync(process.execPath, [file("scripts", "vector-kit.mjs"), "check", "--drift"], {
        cwd: dir,
        encoding: "utf8",
      });
    r = drift();
    assert.equal(r.status, 0, report(r));
    writeFileSync(file("vector.config.json"), JSON.stringify({ profile: "oxlint-jest", locales: ["en", "de"] }));
    r = drift();
    assert.equal(r.status, 1, report(r));
    assert.match(r.stderr, /stale {5}oxlint\.vector\.json/);
    r = run("sync", dir);
    assert.equal(r.status, 0, report(r));
    assert.equal(fragment().rules["react/jsx-no-literals"][0], "error");
    assert.equal(drift().status, 0);
    // Detected without a config: an .oxlintrc.json and no eslint.config.* is the oxlint profile.
    // (A fresh repo: without the manifest, an oxlint.vector.json already there would be the app's own.)
    for (const f of ["vector.config.json", "oxlint.vector.json", "src/vector/manifest.json"]) rmSync(file(f));
    writeFileSync(file(".oxlintrc.json"), "{}\n");
    r = run("sync", dir);
    assert.equal(r.status, 0, report(r));
    assert.equal(fragment().rules["react/jsx-no-literals"][0], "error"); // no config: the 11 kit languages
    assert.equal(existsSync(file("eslint.vector.cjs")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("Editor sheet queue: an open waits for every sheet still sliding away (iOS)", async () => {
  const { leave, settle, afterLeaving } = load("sheets.ts");
  const log = [];
  afterLeaving(() => log.push("free")); // nothing leaving: runs at once
  assert.deepEqual(log, ["free"]);
  leave("a", () => log.push("a gone"), 1000);
  leave("b", () => log.push("b gone"), 5);
  const cancel = afterLeaving(() => log.push("cancelled"));
  cancel();
  afterLeaving(() => log.push("open"));
  settle("a"); // its Modal's onDismiss: early, and only once
  settle("a");
  assert.deepEqual(log, ["free", "a gone"]);
  await new Promise((resolve) => setTimeout(resolve, 30)); // b unmounted: its slide time settles it
  assert.deepEqual(log, ["free", "a gone", "b gone", "open"]);
});

void test(
  "app.json declares the app's locales (vector.config.json, else the 11 kit languages), the Android primary colour and no RTL yet",
  { skip: canonical },
  () => {
    const expo = JSON.parse(readFileSync(path.join(root, "app.json"), "utf8")).expo;
    const tokens = JSON.parse(
      readFileSync(path.join(root, "src", "vector", "tokens.json"), "utf8")
    );
    const localization = (expo.plugins ?? []).find(
      (p) => p === "expo-localization" || (Array.isArray(p) && p[0] === "expo-localization")
    );
    assert.ok(Array.isArray(localization), "expo-localization plugin needs { supportedLocales }");
    // Apple's code for Simplified Chinese; every other kit language is its own code.
    const expected = appLocales.map((l) => (l === "zh" ? "zh-Hans" : l));
    assert.deepEqual(localization[1].supportedLocales, expected);
    assert.notEqual(
      localization[1].supportsRTL,
      true,
      "supportsRTL waits for the first RTL locale"
    );
    assert.equal(expo.primaryColor, tokens.native.androidPrimary);
  }
);
