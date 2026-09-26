import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Uniwind } from "uniwind";
import { AppState } from "react-native";
import { configureHealthSchedule, syncHealthIfDue } from "./health-schedule";
import { useLocales } from "expo-localization";
import { and, desc, eq } from "drizzle-orm";
import {
  db,
  healthLinks,
  measurements,
  photos,
  preferences,
  weightEntries,
  type WeightEntry,
} from "@/db";
import { dayOf, localDay, type Units } from "./metrics";
import { shiftDay } from "./nutrition";
import { languagePreference, resolveLanguage, type Language, translate } from "./translations";

function read() {
  const prefs = Object.fromEntries(
    db
      .select()
      .from(preferences)
      .all()
      .map((p) => [p.key, p.value])
  );
  const weights = db
    .select()
    .from(weightEntries)
    .orderBy(desc(weightEntries.measuredAt), desc(weightEntries.id))
    .all();
  const healthSyncEnabled = prefs.healthSyncEnabled === "true";
  const healthSyncError = prefs.healthSyncError ?? "";
  // Sync can be on for someone without a smart scale; only a recent imported weight
  // means Home can skip the manual weigh-in. A one-off sync failure doesn't count.
  const imported = new Set(
    healthSyncEnabled
      ? db
          .select({ id: healthLinks.localId })
          .from(healthLinks)
          .where(and(eq(healthLinks.origin, "health"), eq(healthLinks.localKind, "weight")))
          .all()
          .map((row) => row.id)
      : []
  );
  const weekAgo = shiftDay(localDay(), -7);
  return {
    weights,
    weightsSynced: weights.some((row) => imported.has(row.id) && dayOf(row.measuredAt) >= weekAgo),
    weighInSkippedDay: prefs.weighInSkippedDay ?? "",
    measurements: db
      .select()
      .from(measurements)
      .orderBy(desc(measurements.measuredAt), desc(measurements.id))
      .all(),
    photos: db.select().from(photos).orderBy(desc(photos.measuredAt), desc(photos.id)).all(),
    diaryLayout: (prefs.diaryLayout === "meals" ? "meals" : "timeline") as "meals" | "timeline",
    hideEmptyHours: prefs.hideEmptyHours !== "false",
    countLoggedDays: prefs.countLoggedDays !== "false",
    units: (prefs.units ?? "metric") as Units,
    formula: (prefs.formula === "female" ? "female" : "male") as "male" | "female",
    theme: (prefs.theme === "dark" || prefs.theme === "light" ? prefs.theme : "system") as
      "dark" | "light" | "system",
    healthSyncEnabled,
    healthSyncError,
    languagePreference: languagePreference(prefs.language),
    lastSync: prefs.lastSync,
  };
}
type Data = ReturnType<typeof read>;
// Diary and coaching reads are keyed on the weights array, so a re-read that finds the
// same weights (a preference change, a sync with nothing new) keeps the old one.
const sameWeights = (a: WeightEntry[], b: WeightEntry[]) =>
  a.length === b.length &&
  a.every(
    (row, i) =>
      row.id === b[i].id &&
      row.weightKg === b[i].weightKg &&
      row.measuredAt === b[i].measuredAt &&
      row.updatedAt?.getTime() === b[i].updatedAt?.getTime()
  );
const reread = (previous: Data) => {
  const next = read();
  return sameWeights(previous.weights, next.weights)
    ? { ...next, weights: previous.weights }
    : next;
};
const formats = new Map<string, Intl.NumberFormat>();
function numberFormat(locale: string, digits: number) {
  const key = `${locale}:${digits}`;
  let format = formats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(locale, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
    formats.set(key, format);
  }
  return format;
}
type Store = Data & {
  language: Language;
  refresh: () => void;
  setPreference: (key: string, value: string) => void;
  t: (key: string) => string;
  number: (value: number, digits?: number) => string;
  date: (value: string) => string;
};
const Context = createContext<Store | null>(null);
export function StoreProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState(read);
  const locales = useLocales();
  const language = resolveLanguage(data.languagePreference, locales[0]?.languageCode);
  useEffect(() => {
    Uniwind.setTheme(data.theme);
  }, [data.theme]);
  useEffect(() => {
    let active = true;
    const check = async () => {
      if (AppState.currentState !== "active") return;
      try {
        await syncHealthIfDue();
      } finally {
        if (active) setData(reread);
      }
    };
    void configureHealthSchedule()
      .catch(() => {})
      .finally(check);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void check();
    });
    const timer = setInterval(() => void check(), 60 * 60 * 1000);
    return () => {
      active = false;
      subscription.remove();
      clearInterval(timer);
    };
  }, [data.healthSyncEnabled]);
  const value = useMemo<Store>(() => {
    const locale = language === "zh" ? "zh-CN" : language;
    const refresh = () => setData(reread);
    return {
      ...data,
      language,
      refresh,
      setPreference: (key, value) => {
        db.insert(preferences)
          .values({ key, value })
          .onConflictDoUpdate({ target: preferences.key, set: { value } })
          .run();
        refresh();
      },
      t: (key) => translate(language, key),
      number: (value, digits = 1) => numberFormat(locale, digits).format(value),
      date: (value) =>
        new Date(value.length === 10 ? `${value}T12:00:00` : value).toLocaleDateString(locale, {
          year: "numeric",
          month: "short",
          day: "numeric",
        }),
    };
  }, [data, language]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useStore() {
  const value = useContext(Context);
  if (!value) throw new Error("StoreProvider is required");
  return value;
}
