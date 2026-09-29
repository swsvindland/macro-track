import en from "./locales/en.json";
import es from "./locales/es.json";
import fr from "./locales/fr.json";
import de from "./locales/de.json";
import it from "./locales/it.json";
import pt from "./locales/pt.json";
import nl from "./locales/nl.json";
import sv from "./locales/sv.json";
import ja from "./locales/ja.json";
import ko from "./locales/ko.json";
import zh from "./locales/zh.json";

export const languages = {
  en: "English",
  es: "Español",
  fr: "Français",
  de: "Deutsch",
  it: "Italiano",
  pt: "Português",
  nl: "Nederlands",
  sv: "Svenska",
  ja: "日本語",
  ko: "한국어",
  zh: "简体中文",
};
export type Language = keyof typeof languages;
export type LanguagePreference = Language | "system";

export function languagePreference(value: string | undefined): LanguagePreference {
  return value && Object.hasOwn(languages, value) ? (value as Language) : "system";
}

export function resolveLanguage(
  preference: LanguagePreference,
  deviceLanguage: string | null | undefined
): Language {
  if (preference !== "system") return preference;
  return deviceLanguage && Object.hasOwn(languages, deviceLanguage)
    ? (deviceLanguage as Language)
    : "en";
}

export const dictionaries = { en, es, fr, de, it, pt, nl, sv, ja, ko, zh } satisfies Record<
  Language,
  Record<keyof typeof en, string>
>;
/** Every translation key; an unknown key is a type error. */
export type Message = keyof typeof en;
/** Narrows stored or computed text to a key, for values that are keys only some of the time. */
export const isMessage = (key: string): key is Message => Object.hasOwn(en, key);
export function translate(language: Language, key: Message): string {
  return dictionaries[language][key];
}
/** Fills `{name}` placeholders in a translated template; unknown names stay as written. */
export function interpolate(text: string, values: Record<string, string | number>) {
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : match
  );
}
