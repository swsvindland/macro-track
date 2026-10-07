import { useNutrition } from "@/lib/nutrition-store";
import { useStore } from "@/lib/store";

/**
 * Re-reads the store and bumps the nutrition revision (which also refreshes the widget) after a restore replaced the
 * database rows (spec §4.4). useNutrition() needs NutritionProvider, so <VaultRoot /> renders inside it.
 */
export function useVaultRefresh(): () => void {
  const store = useStore();
  const nutrition = useNutrition();
  return () => {
    store.refresh();
    nutrition.refresh();
  };
}
