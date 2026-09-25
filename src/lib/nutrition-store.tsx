import { AppState } from "react-native";
import { localDay } from "./metrics";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

const Context = createContext<{ revision: number; refresh: () => void } | null>(null);
export function NutritionProvider({ children }: { children: ReactNode }) {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let previous = localDay();
    const check = () => {
      const day = localDay();
      if (day !== previous) {
        previous = day;
        setRevision((value) => value + 1);
      }
    };
    const timer = setInterval(check, 60000);
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") check();
    });
    return () => {
      clearInterval(timer);
      sub.remove();
    };
  }, []);
  return (
    <Context.Provider value={{ revision, refresh: () => setRevision((value) => value + 1) }}>
      {children}
    </Context.Provider>
  );
}
export function useNutrition() {
  const context = useContext(Context);
  if (!context) throw new Error("NutritionProvider is missing");
  return context;
}

// Database reads must depend on the revision, not just their query arguments:
// React Compiler otherwise caches a day's results across successful writes.
export function useNutritionQuery<T>(query: () => T): T {
  "use no memo";
  // Read on every subscribed render: weight-store updates also affect coaching.
  const { revision } = useNutrition();
  void revision;
  return query();
}
