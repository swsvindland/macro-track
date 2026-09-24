import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

const Context = createContext<{ revision: number; refresh: () => void } | null>(null);
export function NutritionProvider({ children }: { children: ReactNode }) {
  const [revision, setRevision] = useState(0);
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
  // Keep the explicit external-data dependency; the compiler cannot infer it.
  const { revision } = useNutrition();
  return useMemo(() => {
    void revision;
    return query();
  }, [query, revision]);
}
