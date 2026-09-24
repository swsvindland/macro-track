import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Uniwind } from "uniwind";
import { AppState } from "react-native";
import { configureHealthSchedule, syncHealthIfDue } from "./health-schedule";
import { desc } from "drizzle-orm";
import { useLocales } from "expo-localization";
import { db, measurements, photos, preferences, weightEntries } from "@/db";
import type { Units } from "./metrics";
import { languagePreference, resolveLanguage, type Language, translate } from "./translations";

function read() {
  const prefs = Object.fromEntries(
    db
      .select()
      .from(preferences)
      .all()
      .map((p) => [p.key, p.value])
  );
  return {
    weights: db
      .select()
      .from(weightEntries)
      .orderBy(desc(weightEntries.measuredAt), desc(weightEntries.id))
      .all(),
    measurements: db
      .select()
      .from(measurements)
      .orderBy(desc(measurements.measuredAt), desc(measurements.id))
      .all(),
    photos: db.select().from(photos).orderBy(desc(photos.measuredAt), desc(photos.id)).all(),
    units: (prefs.units ?? "metric") as Units,
    formula: (prefs.formula === "female" ? "female" : "male") as "male" | "female",
    theme: (prefs.theme === "dark" || prefs.theme === "light" ? prefs.theme : "system") as
      "dark" | "light" | "system",
    healthSyncEnabled: prefs.healthSyncEnabled === "true",
    healthSyncError: prefs.healthSyncError ?? "",
    languagePreference: languagePreference(prefs.language),
    lastSync: prefs.lastSync,
  };
}
type Store = ReturnType<typeof read> & {
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
        if (active) setData(read());
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
  const refresh = () => setData(read());
  const setPreference = (key: string, value: string) => {
    db.insert(preferences)
      .values({ key, value })
      .onConflictDoUpdate({ target: preferences.key, set: { value } })
      .run();
    refresh();
  };
  const locale = language === "zh" ? "zh-CN" : language;
  return (
    <Context.Provider
      value={{
        ...data,
        language,
        refresh,
        setPreference,
        t: (key) => translate(language, key),
        number: (value, digits = 1) =>
          new Intl.NumberFormat(locale, {
            minimumFractionDigits: digits,
            maximumFractionDigits: digits,
          }).format(value),
        date: (value) =>
          new Date(value.length === 10 ? `${value}T12:00:00` : value).toLocaleDateString(locale, {
            year: "numeric",
            month: "short",
            day: "numeric",
          }),
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useStore() {
  const value = useContext(Context);
  if (!value) throw new Error("StoreProvider is required");
  return value;
}
