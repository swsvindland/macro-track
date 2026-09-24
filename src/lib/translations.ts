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
export function translate(language: Language, key: string): string {
  return Object.hasOwn(en, key) ? dictionaries[language][key as keyof typeof en] : key;
}
