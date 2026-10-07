// Vault text for UI code (docs/vault.md, "Strings"). useVaultText() reads the kit's language and formatter and returns
// v() for a key, vp() for a counted phrase, when() for a timestamp and this platform's Health product name. Every
// visible vault string goes through v(), so the kit's jsx-no-literals and label-literal rules stay at zero hits. The
// pure core (vaultText, interpolate, plural) is exported for tests/vault/strings.cjs.
import { useMemo } from "react";
import { Platform } from "react-native";

import { useKit, type KitLanguage, type VectorKit } from "@/vector";

import { vaultIdentity } from "./app";
import { vaultStrings, type VaultStringKey } from "./strings";

/** Placeholder values: a number is formatted by the kit formatter (whole number), a string is used as given. */
export type VaultValues = Readonly<Record<string, string | number>>;

/** The text of `key` in the app's language, with {app}, {health} and `values` filled in (values win). */
export type VaultT = (key: VaultStringKey, values?: VaultValues) => string;

/** Keys that come as `<base>_one` and `<base>_other`, named by their base ("restoredRepairs"). */
export type PluralBase = {
  [K in VaultStringKey]: K extends `${infer Base}_one` ? Base : never;
}[VaultStringKey];

/** The kit formatter members vault text uses (useKitFormat()). */
export type VaultFormat = Pick<VectorKit["format"], "number" | "plural" | "date" | "time">;

export type VaultText = {
  language: KitLanguage;
  v: VaultT;
  /** A counted phrase: `<base>_one` when the language's plural rule for `n` is "one", else `<base>_other`; {count} = n. */
  vp: (base: PluralBase, n: number, values?: VaultValues) => string;
  /** Apple Health on iOS, Health Connect elsewhere: what {health} says unless a screen passes its own. */
  health: string;
  /** An ISO timestamp (or epoch ms) as the dateTime template ("Oct 4, 2026, 3:30 PM"); unparseable input as given. */
  when: (iso: string | number) => string;
};

/** Fills `{name}` placeholders (as the apps' own interpolate does); one without a value stays as written. */
export function interpolate(text: string, values: VaultValues): string {
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : match
  );
}

/**
 * The key for a count in plural category `rule` (useKitFormat().plural): "one" takes `<base>_one`; every other
 * category (zero, two, few, many, other) takes `<base>_other`. ja, ko and zh carry the same text in both.
 */
export function plural(base: PluralBase, rule: Intl.LDMLPluralRule): VaultStringKey {
  return rule === "one" ? `${base}_one` : `${base}_other`;
}

/** The text helpers for one language, formatter, brand name and platform: the pure core of useVaultText(). */
export function vaultText(options: {
  language: KitLanguage;
  format: VaultFormat;
  /** Brand name, never translated (apps.json `name`). */
  app: string;
  /** Platform.OS */
  platform: string;
}): VaultText {
  const { language, format } = options;
  const table: Record<VaultStringKey, string> = vaultStrings[language] ?? vaultStrings.en;
  // English under every language, so a key can never render empty.
  const text = (key: VaultStringKey) => table[key] || vaultStrings.en[key];
  const health = text(options.platform === "ios" ? "healthApple" : "healthAndroid");
  const fixed = { app: options.app, health };

  const v: VaultT = (key, values = {}) => {
    const filled: Record<string, string> = { ...fixed };
    for (const [name, value] of Object.entries(values))
      filled[name] = typeof value === "number" ? format.number(value) : value;
    return interpolate(text(key), filled);
  };
  const vp: VaultText["vp"] = (base, n, values = {}) =>
    v(plural(base, format.plural(n)), { count: n, ...values });
  const when: VaultText["when"] = (iso) => {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return String(iso);
    return v("dateTime", { date: format.date(date, "medium"), time: format.time(date) });
  };
  return { language, v, vp, health, when };
}

/** Vault text in the app's language (the kit's VectorProvider decides it). */
export function useVaultText(): VaultText {
  const { language, format } = useKit();
  return useMemo(
    () => vaultText({ language, format, app: vaultIdentity.name, platform: Platform.OS }),
    [language, format]
  );
}
