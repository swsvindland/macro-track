import { AppState } from "react-native";
import { syncHealthFood } from "./health-schedule";
import { localDay } from "./metrics";
import { useStore } from "./store";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type DependencyList,
  type ReactNode,
} from "react";

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
  useEffect(() => {
    if (!revision) return;
    // Batches a burst of edits (multi-select, Undo) into one Health write.
    const timer = setTimeout(() => void syncHealthFood(), 3000);
    return () => clearTimeout(timer);
  }, [revision]);
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

// Reads run once per data revision, not on every render. `deps` must list every value
// the query reads besides the database. Weight writes refresh only the store, so its
// weights array is a key too. "use no memo" keeps React Compiler from caching the call
// on the query arguments alone, across successful writes.
export function useNutritionQuery<T>(query: () => T, deps: DependencyList = []): T {
  "use no memo";
  const { revision } = useNutrition();
  const { weights } = useStore();
  // eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/use-memo
  return useMemo(query, [revision, weights, ...deps]);
}
