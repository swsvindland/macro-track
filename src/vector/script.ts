import { kitLanguages, type KitLanguage } from "./strings";

/** Script class of the ACTIVE APP LANGUAGE (never sniffed from strings). Drives case, tracking and line height. */
export type ScriptClass = "cased" | "cjk" | "arabic" | "hebrew";

export function scriptOf(language: string): ScriptClass {
  const code = language.toLowerCase().split(/[-_]/)[0];
  if (code === "ja" || code === "ko" || code === "zh") return "cjk";
  if (code === "ar" || code === "fa" || code === "ur") return "arabic";
  if (code === "he" || code === "iw") return "hebrew";
  return "cased";
}

export const isKitLanguage = (value: string): value is KitLanguage =>
  (kitLanguages as readonly string[]).includes(value);
