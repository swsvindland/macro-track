/** The only formatter and number parser. Replaces every `language === "zh" ? "zh-CN" : language` site. */
const defaults: Record<string, string> = {
  en: "en-US",
  es: "es-ES",
  fr: "fr-FR",
  de: "de-DE",
  it: "it-IT",
  pt: "pt-BR",
  nl: "nl-NL",
  sv: "sv-SE",
  ja: "ja-JP",
  ko: "ko-KR",
  zh: "zh-Hans-CN",
};

export type DeviceLocale = { languageCode?: string | null; regionCode?: string | null };

/** First device locale whose language matches the chosen one (en-GB stays en-GB), else the default tag. */
export function localeTag(language: string, device: readonly DeviceLocale[] = []): string {
  // The app ships Simplified Chinese only, so a zh-TW device must not pull Traditional formatting in.
  if (language === "zh") return "zh-Hans-CN";
  const match = device.find((l) => l.languageCode === language && l.regionCode);
  return match ? `${language}-${match.regionCode}` : (defaults[language] ?? language);
}

/** First Strong Isolate … Pop Directional Isolate: keeps a number or Latin unit intact inside RTL text. */
export const isolate = (s: string) => `⁨${s}⁩`;

/** Digits and numeric punctuation only → safe for IBM Plex Mono (no CJK dates, no Arabic-Indic digits). */
export const isMonoSafe = (s: string) => /^[\d\s.,:;%+\-−–/()'  ]+$/.test(s);

/** Hermes' Intl coverage is not verified offline: every newer API is feature-detected with a fallback. */
const probe = (f: () => unknown) => {
  try {
    f();
    return true;
  } catch {
    return false;
  }
};
export const intlSupport = {
  list: typeof (Intl as { ListFormat?: unknown }).ListFormat === "function",
  plural: typeof (Intl as { PluralRules?: unknown }).PluralRules === "function",
  relative: typeof (Intl as { RelativeTimeFormat?: unknown }).RelativeTimeFormat === "function",
  numberRange:
    typeof (Intl.NumberFormat.prototype as { formatRange?: unknown }).formatRange === "function",
  dateRange:
    typeof (Intl.DateTimeFormat.prototype as { formatRange?: unknown }).formatRange === "function",
  // Behavioural, not just "does not throw": Hermes on iOS formats units through NSMeasurementFormatter, whose
  // short pound is "#" (293#) and which may convert units (38 h → "136,800s"). Such an engine gets the
  // number + abbreviation fallback everywhere.
  unitStyle: probe(() => {
    const unit = (u: string, n: number) =>
      new Intl.NumberFormat("en-US", { style: "unit", unit: u, unitDisplay: "short" }).format(n);
    if (unit("pound", 2) !== "2 lb" || !/^2\s?hr?$/.test(unit("hour", 2))) {
      throw new Error("untrusted unit style");
    }
  }),
  // Hermes on iOS has no NumberFormat.formatToParts: calling it throws "undefined is not a function".
  parts:
    typeof (Intl.NumberFormat.prototype as { formatToParts?: unknown }).formatToParts === "function",
  signDisplay: probe(() => {
    if (new Intl.NumberFormat("en", { signDisplay: "exceptZero" }).format(1) !== "+1") {
      throw new Error("no signDisplay");
    }
  }),
  // An engine that ignored useGrouping would seed a Field with "2,000", read back as 2 after one backspace.
  ungrouped: probe(() => {
    if (new Intl.NumberFormat("en-US", { useGrouping: false }).format(1234) !== "1234") {
      throw new Error("useGrouping ignored");
    }
  }),
};

/** ECMA-402 sanctioned units the apps measure in. kcal, reps and "30 g protein" are templates, not units. */
export type IntlUnit =
  | "kilogram"
  | "gram"
  | "pound"
  | "stone"
  | "centimeter"
  | "inch"
  | "foot"
  | "milliliter"
  | "liter"
  | "fluid-ounce"
  | "hour"
  | "minute"
  | "second";
/** Units ECMA-402 does not sanction (Intl throws on them): a translated kit symbol with the gram's spacing. */
export type SymbolUnit = "milligram";
/** Everything `unit` and `unitParts` take. */
export type FormatUnit = IntlUnit | SymbolUnit;
const unitAbbr: Record<IntlUnit, string> = {
  kilogram: "kg",
  gram: "g",
  pound: "lb",
  stone: "st",
  centimeter: "cm",
  inch: "in",
  foot: "ft",
  milliliter: "mL",
  liter: "L",
  "fluid-ounce": "fl oz",
  hour: "h",
  minute: "min",
  second: "s",
};

/**
 * Options shared by number, percent, percentParts, unit and unitParts. Each call keeps its 1.x default; a plain
 * boolean in the third place of number / percent still means `signed`.
 */
export type NumberStyle = {
  /** "+" on positive values (deltas), through signDisplay or a fallback prefix. */
  signed?: boolean;
  /** Exactly `digits` decimals ("80.0 kg", "0.050%"). Default: true for number, false (at most) elsewhere. */
  fixed?: boolean;
  /** Thousands grouping (default true). */
  grouping?: boolean;
};

/** A formatted number split for Value: spread it in (`<Value {...format.unitParts(…)} />`). */
export type NumberParts = { value: string; unit: string; unitFirst: boolean; space: string };

/** Kit strings the formatter reads: VectorProvider passes the active language's; direct callers may omit them. */
export type FormatStrings = {
  unitGram: string;
  unitMilligram: string;
  /** "{0} and {1}": joins the last two items when Intl.ListFormat is missing. */
  listAnd: string;
  /** "{0} or {1}". */
  listOr: string;
  /** Between the other items (", ", "、"). */
  listSeparator: string;
};

export type Format = ReturnType<typeof createFormat>;

/** Latin or Arabic-Indic digits. */
const DIGIT = "0-9٠-٩۰-۹";
/** Whatever a formatted number holds besides its digits: the locale's marks. */
const marksOf = (formatted: string) => formatted.replace(new RegExp(`[${DIGIT}]`, "g"), "");
const ANY_DIGIT = new RegExp(`[${DIGIT}]`);

/**
 * Typographic minus (U+2212) where the engine wrote a hyphen-minus before a digit (Hermes and most ICU locales
 * do; sv already writes U+2212). A hyphen between digits ("1-2", a range) is left alone.
 */
const HYPHEN_MINUS = new RegExp(`(^|[^${DIGIT}])-(?=[${DIGIT}])`, "g");
const minus = (s: string) => s.replace(HYPHEN_MINUS, "$1\u2212");

/** A value that rounds to zero at `digits` is zero, so a delta never reads "−0". */
const zeroed = (n: number, digits: number) => (Math.abs(n) < 0.5 / 10 ** digits ? 0 : n);

const BIDI = /[\u061c\u200e\u200f]/g;
/** A sign directly before the digits, then digits with single separators between them. */
const NUMBER_RUN = new RegExp(`[-+\\u2212]?[${DIGIT}](?:[.,٫٬'’\\s]?[${DIGIT}])*`);

/** Value, mark (unit or percent sign), order and the literal between them, from formatToParts. */
function splitParts(parts: Intl.NumberFormatPart[], mark: "unit" | "percentSign"): NumberParts {
  const isNumber = (p: Intl.NumberFormatPart) => p.type !== mark && p.type !== "literal";
  const firstMark = parts.findIndex((p) => p.type === mark);
  const lastMark = parts.findLastIndex((p) => p.type === mark);
  const firstNumber = parts.findIndex(isNumber);
  const lastNumber = parts.findLastIndex(isNumber);
  const unitFirst = firstMark >= 0 && firstMark < firstNumber;
  // The literal between the number and the mark is the locale's spacing ("" when there is none).
  const between = unitFirst
    ? parts.slice(lastMark + 1, firstNumber)
    : parts.slice(lastNumber + 1, firstMark < 0 ? parts.length : firstMark);
  return {
    value: parts
      .filter(isNumber)
      .map((p) => p.value)
      .join(""),
    unit: parts
      .filter((p) => p.type === mark)
      .map((p) => p.value)
      .join(""),
    unitFirst,
    space: between
      .filter((p) => p.type === "literal")
      .map((p) => p.value)
      .join(""),
  };
}

/**
 * The same split read from text alone (no formatToParts): what is before or after `at` is the mark. Bidi marks
 * are dropped, as formatToParts leaves them in literal parts outside the value and the mark.
 */
function splitAround(full: string, at: number, length: number, fallback: string): NumberParts {
  const before = full.slice(0, at).replace(BIDI, "");
  const after = full.slice(at + length).replace(BIDI, "");
  const unitFirst = before.trim() !== "" && after.trim() === "";
  const side = unitFirst ? before : after;
  return {
    value: full.slice(at, at + length).replace(BIDI, ""),
    unit: side.trim() || fallback,
    unitFirst,
    // The whitespace touching the number is the locale's spacing.
    space: unitFirst ? (/\s+$/.exec(side)?.[0] ?? "") : (/^\s+/.exec(side)?.[0] ?? ""),
  };
}

/** The locale's decimal separator ("." or "," or "٫"). */
export const decimalSeparator = (tag: string) =>
  intlSupport.parts
    ? (new Intl.NumberFormat(tag).formatToParts(1.5).find((p) => p.type === "decimal")?.value ?? ".")
    : marksOf(new Intl.NumberFormat(tag).format(1.5)).charAt(0) || ".";

/** The locale's grouping separator ("," in en, "." in de; a space in fr and sv). 7 digits, since some locales
 *  (es) do not group 4-digit numbers. */
const groupSeparator = (tag: string) =>
  intlSupport.parts
    ? (new Intl.NumberFormat(tag).formatToParts(1234567).find((p) => p.type === "group")?.value ?? "")
    : marksOf(new Intl.NumberFormat(tag).format(1234567)).charAt(0);

/**
 * Parses what a person typed into a numeric Field: the locale decimal (or "."), grouping separators, Latin or
 * Arabic-Indic digits, U+2212 minus (bidi marks are ignored). Returns null when the text is not a number.
 * - One separator is the decimal ("72,5" and "72.5" are 72.5 everywhere), except the locale's own grouping mark
 *   before exactly three digits ("2,200" in en and "2.200" in de are 2200: kcal goals and mL amounts).
 * - Several separators must be grouping in threes, plus at most one decimal after them ("1.234,5" in de).
 *   Repeated decimal marks are not a number ("1.2.3", and "1.234.567" in en, where "." is the decimal).
 */
export function parseDecimal(input: string, tag: string): number | null {
  // Arabic-Indic separators are normalised below, so the locale's marks are compared in the same form.
  const decimal = decimalSeparator(tag).replace("٫", ".");
  const group = groupSeparator(tag).replace("٬", ",");
  let s = input
    .trim()
    .replace(/[\s\u00a0\u202f'\u061c\u200e\u200f]/g, "")
    .replace(/[−–]/g, "-")
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, ".")
    .replace(/٬/g, "");
  const seps = s.match(/[.,]/g) ?? [];
  if (seps.length > 1) {
    const last = s.search(/[.,][^.,]*$/);
    const mixed = new Set(seps).size > 1;
    // Every mark is the locale decimal: no grouping can be read into it.
    if (!mixed && seps[0] === decimal) return null;
    const grouped = mixed ? s.slice(0, last) : s;
    // Grouping must be in threes: "1.2.3" is not a number.
    if (!/^-?\d{1,3}([.,]\d{3})*$/.test(grouped)) return null;
    // Mixed marks: the grouping ones must all be the same mark, and differ from the final (decimal) one.
    if (mixed && (new Set(grouped.match(/[.,]/g)).size > 1 || grouped.includes(s[last])))
      return null;
    s =
      grouped === s
        ? s.replace(/[.,]/g, "")
        : `${grouped.replace(/[.,]/g, "")}.${s.slice(last + 1)}`;
  } else if (seps.length === 1) {
    const at = s.search(/[.,]/);
    const grouping = s[at] !== decimal && s[at] === group && /^-?[1-9]\d{0,2}[.,]\d{3}$/.test(s);
    s = grouping ? s.replace(/[.,]/, "") : s.replace(/[.,]/, ".");
  }
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function createFormat(
  tag: string,
  options: { uses24h?: boolean; strings?: Partial<FormatStrings> } = {}
) {
  const cache = new Map<string, Intl.NumberFormat>();
  const nf = (o: Intl.NumberFormatOptions) => {
    const key = JSON.stringify(o);
    let f = cache.get(key);
    if (!f) cache.set(key, (f = new Intl.NumberFormat(tag, o)));
    return f;
  };
  const dates = new Map<string, Intl.DateTimeFormat>();
  const df = (o: Intl.DateTimeFormatOptions) => {
    const key = JSON.stringify(o);
    let f = dates.get(key);
    if (!f) dates.set(key, (f = new Intl.DateTimeFormat(tag, o)));
    return f;
  };
  const words = options.strings ?? {};
  const styleOf = (s: boolean | NumberStyle | undefined): NumberStyle =>
    typeof s === "boolean" ? { signed: s } : (s ?? {});
  /** Intl options for `digits` decimals: exactly (`fixed`) or at most, grouped or not, signed where supported. */
  const numeric = (digits: number, s: NumberStyle, fixed: boolean) => {
    const o: Intl.NumberFormatOptions = {
      minimumFractionDigits: (s.fixed ?? fixed) ? digits : 0,
      maximumFractionDigits: digits,
    };
    if (s.grouping === false) o.useGrouping = false;
    if (s.signed && intlSupport.signDisplay) o.signDisplay = "exceptZero";
    return o;
  };
  /** The number alone, hyphen-minus as the engine wrote it; `n` is already zeroed. */
  const plainNumber = (n: number, digits: number, s: NumberStyle = {}, fixed = false) => {
    let out = nf(numeric(digits, s, fixed)).format(n);
    if (s.grouping === false && !intlSupport.ungrouped) {
      const group = groupSeparator(tag);
      if (group) out = out.split(group).join("");
    }
    return (s.signed && !intlSupport.signDisplay && n > 0 ? "+" : "") + out;
  };
  const unitFormat = (unit: IntlUnit, digits: number, s: NumberStyle) =>
    nf({ style: "unit", unit, unitDisplay: "short", ...numeric(digits, s, false) });
  const abbr = (unit: IntlUnit) =>
    unit === "gram" ? (words.unitGram ?? unitAbbr.gram) : unitAbbr[unit];
  // Hermes on iOS formats units through NSMeasurementFormatter, which may convert them to another unit
  // (38 h → "136,800s", 6 min → "360s"). Unit output is only trusted when it holds the plain number and no
  // other digit; otherwise the caller falls back to the number and the unit's abbreviation.
  const trustedUnit = (n: number, unit: IntlUnit, digits: number, s: NumberStyle) => {
    if (!intlSupport.unitStyle || (s.signed && !intlSupport.signDisplay)) return null;
    try {
      const full = unitFormat(unit, digits, s).format(n);
      const plain = plainNumber(n, digits, s);
      return full.includes(plain) && !ANY_DIGIT.test(full.replace(plain, "")) ? full : null;
    } catch {
      // An engine that rejects one unit (RangeError) gets the fallback, not a render error.
      return null;
    }
  };
  const intlUnitParts = (n: number, unit: IntlUnit, digits: number, s: NumberStyle) => {
    const num = plainNumber(n, digits, s);
    const full = trustedUnit(n, unit, digits, s);
    if (full !== null) {
      if (intlSupport.parts) {
        const parts = splitParts(unitFormat(unit, digits, s).formatToParts(n), "unit");
        // Android Hermes may return the entire unit string as one literal (or integer) part.
        // Trust a split only when it preserves the number and identifies the unit separately.
        if (parts.value === num && parts.unit) return parts;
      }
      // Missing or incomplete parts: the already-validated number sits inside the unit string.
      // Preserve the locale's unit order and spacing instead of producing a blank readout.
      return splitAround(full, full.indexOf(num), num.length, abbr(unit));
    }
    return { value: num, unit: abbr(unit), unitFirst: false, space: "\u00A0" };
  };
  const unitParts = (n: number, unit: FormatUnit, digits: number, s: NumberStyle): NumberParts => {
    const v = zeroed(n, digits);
    if (unit !== "milligram") {
      const parts = intlUnitParts(v, unit, digits, s);
      return { ...parts, value: minus(parts.value) };
    }
    // No Intl milligram: the translated symbol, in the gram's order and spacing (ko "150mg"). A CJK symbol
    // attaches to its number, as Intl's own CJK units do ("2升").
    const gram = intlUnitParts(v, "gram", digits, s);
    const symbol = words.unitMilligram ?? "mg";
    const cjk = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(symbol);
    return { ...gram, value: minus(gram.value), unit: symbol, space: cjk ? "" : gram.space };
  };
  const joined = ({ value, unit, unitFirst, space }: NumberParts) =>
    unitFirst ? `${unit}${space}${value}` : `${value}${space}${unit}`;
  // The device clock setting wins over the locale default in both directions (en-US on a 24h phone, de on 12h).
  const hourCycle = options.uses24h === undefined ? undefined : options.uses24h ? "h23" : "h12";
  const dayMonth: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  // Whether a full date opens with its year ("2026年9月22日", "2026년 9월 22일"); read once, from format() alone.
  let leadsWithYear: boolean | undefined;
  const yearFirst = () => {
    if (leadsWithYear === undefined) {
      const d = new Date(2026, 8, 22, 12);
      const full = df({ ...dayMonth, year: "numeric" }).format(d).replace(BIDI, "").trim();
      leadsWithYear = full.startsWith(df({ year: "numeric" }).format(d).replace(BIDI, "").trim());
    }
    return leadsWithYear;
  };
  return {
    tag,
    /**
     * Exactly `digits` decimals ("72.0"). `style`: `true` or `{ signed }` shows "+" on positive values (deltas);
     * `{ fixed: false }` drops trailing zeros; `{ grouping: false }` for text a person edits (see `editable`).
     * Negative values use the typographic minus (U+2212); parseDecimal reads it back.
     */
    number: (n: number, digits = 0, style: boolean | NumberStyle = false) =>
      minus(plainNumber(zeroed(n, digits), digits, styleOf(style), true)),
    /**
     * The text a numeric Field starts with: up to `digits` decimals, no grouping and a plain hyphen-minus, so
     * "2000" stays 2000 through parseDecimal after any edit ("2,000" → "2,00" would read as 2). The bidi mark
     * an RTL locale puts before the sign (he, ar) stays: it keeps the sign in place in an RTL field.
     */
    editable: (n: number, digits = 2) =>
      // sv, nb and fi write U+2212; the Field holds the hyphen-minus a keyboard types.
      plainNumber(zeroed(n, digits), digits, { grouping: false }).replace(/\u2212/g, "-"),
    /** Up to `digits` decimals; `{ fixed: true }` keeps them ("0.050%"). `style` as in number. */
    percent: (fraction: number, digits = 0, style: boolean | NumberStyle = false) => {
      const s = styleOf(style);
      const v = zeroed(fraction, digits + 2);
      const text = nf({ style: "percent", ...numeric(digits, s, false) }).format(v);
      return minus((s.signed && !intlSupport.signDisplay && v > 0 ? "+" : "") + text);
    },
    /**
     * A percentage split like unitParts, so Value sets the sign smaller and muted in the locale's order and
     * spacing ("5 %" in fr and de, "5%" in en). `.unit` alone is a Field suffix.
     */
    percentParts: (
      fraction: number,
      digits = 0,
      style: boolean | NumberStyle = false
    ): NumberParts => {
      const s = styleOf(style);
      const v = zeroed(fraction, digits + 2);
      const f = nf({ style: "percent", ...numeric(digits, s, false) });
      let parts: NumberParts;
      if (intlSupport.parts) parts = splitParts(f.formatToParts(v), "percentSign");
      else {
        const full = f.format(v);
        const run = NUMBER_RUN.exec(full);
        parts = run
          ? splitAround(full, run.index, run[0].length, "%")
          : { value: full, unit: "%", unitFirst: false, space: "" };
      }
      const plus = s.signed && !intlSupport.signDisplay && v > 0 ? "+" : "";
      return { ...parts, value: minus(plus + parts.value) };
    },
    /** `unit` of 1.x plus gram and milligram; `style` as in number (at most `digits` decimals by default). */
    unit: (n: number, unit: FormatUnit, digits = 0, style: NumberStyle = {}) => {
      if (unit === "milligram") return joined(unitParts(n, unit, digits, style));
      const v = zeroed(n, digits);
      return minus(
        trustedUnit(v, unit, digits, style) ?? `${plainNumber(v, digits, style)} ${abbr(unit)}`
      );
    },
    /**
     * { value, unit, unitFirst, space } so Value can set the unit smaller and muted while keeping the locale's
     * order and spacing ("72,5 kg" in fr, "72.5mL" in ko, "2升" in zh). Spread it into Value.
     */
    unitParts: (n: number, unit: FormatUnit, digits = 0, style: NumberStyle = {}): NumberParts =>
      unitParts(n, unit, digits, style),
    range: (a: number, b: number, digits = 0) => {
      const f = nf({ maximumFractionDigits: digits });
      const [x, y] = [zeroed(a, digits), zeroed(b, digits)];
      return minus(intlSupport.numberRange ? f.formatRange(x, y) : `${f.format(x)}–${f.format(y)}`);
    },
    date: (d: Date | number, style: "short" | "medium" | "long" | "full" = "medium") =>
      df({ dateStyle: style }).format(d),
    /** "Sep 29", "29 sept.", "9月29日". */
    monthDay: (d: Date | number) => df(dayMonth).format(d),
    /** "September 2026" (`"short"`: "Sep 2026"). */
    monthYear: (d: Date | number, month: "long" | "short" = "long") =>
      df({ month, year: "numeric" }).format(d),
    /** "2026", "2026年". */
    year: (d: Date | number) => df({ year: "numeric" }).format(d),
    /** "Sep 22 – 28"; `{ year: true }`: "Sep 22 – 28, 2026", "22–28 sept. 2026". */
    dateRange: (a: Date | number, b: Date | number, { year = false }: { year?: boolean } = {}) => {
      const f = df(year ? { ...dayMonth, year: "numeric" } : dayMonth);
      if (intlSupport.dateRange) return f.formatRange(a, b);
      const sameYear = new Date(a).getFullYear() === new Date(b).getFullYear();
      if (!year || !sameYear) return `${f.format(a)} – ${f.format(b)}`;
      // No formatRange: the year once, on the date the locale writes it next to: the start in ja, ko and zh
      // ("2026年9月22日 – 9月28日"), the end elsewhere ("Sep 22 – Sep 28, 2026").
      return yearFirst()
        ? `${f.format(a)} – ${df(dayMonth).format(b)}`
        : `${df(dayMonth).format(a)} – ${f.format(b)}`;
    },
    time: (d: Date | number) => df({ hour: "numeric", minute: "2-digit", hourCycle }).format(d),
    weekdayShort: (d: Date | number) => df({ weekday: "short" }).format(d),
    /** "Tuesday". */
    weekdayLong: (d: Date | number) => df({ weekday: "long" }).format(d),
    /** "T": week strips. */
    weekdayNarrow: (d: Date | number) => df({ weekday: "narrow" }).format(d),
    /**
     * "a, b, and c". `type: "disjunction"` gives "a, b, or c"; `type: "unit"` joins measurements with no
     * "and" ("1 hr 5 min" narrow, "80 × 8, 80 × 7" short). Without Intl.ListFormat (Hermes) the kit's
     * translated templates join the items.
     */
    list: (
      items: string[],
      {
        type = "conjunction",
        style = "long",
      }: { type?: "conjunction" | "disjunction" | "unit"; style?: "long" | "short" | "narrow" } = {}
    ) => {
      if (intlSupport.list) return new Intl.ListFormat(tag, { type, style }).format(items);
      if (type === "unit") return items.join(style === "narrow" ? " " : ", ");
      const pair = type === "disjunction" ? words.listOr : words.listAnd;
      // No templates (a direct createFormat caller): a neutral join; "/" still reads as "or".
      if (!pair || items.length < 2) return items.join(type === "disjunction" ? " / " : ", ");
      const head = items.slice(0, -1).join(words.listSeparator ?? ", ");
      const last = items[items.length - 1];
      return pair.replace(/\{([01])\}/g, (_, i: string) => (i === "0" ? head : last));
    },
    relativeDays: (days: number) =>
      intlSupport.relative
        ? new Intl.RelativeTimeFormat(tag, { numeric: "auto" }).format(days, "day")
        : null,
    plural: (n: number): Intl.LDMLPluralRule =>
      intlSupport.plural ? new Intl.PluralRules(tag).select(n) : n === 1 ? "one" : "other",
    /** m:ss or h:mm:ss, always Latin digits (mono readout). */
    duration: (seconds: number) => {
      const s = Math.max(0, Math.round(seconds));
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const pad = (x: number) => String(x).padStart(2, "0");
      return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
    },
  };
}
