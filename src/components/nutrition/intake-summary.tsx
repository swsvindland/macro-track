import { router } from "expo-router";
import { SystemButton, SystemLabel, SystemPanel, SystemText as Text } from "@/components/system";
import { useNutritionQuery } from "@/lib/nutrition-store";
import { useStore } from "@/lib/store";
import { entriesForDay, dayStatus } from "@/lib/diary";
import { currentGoal, nextCheckInDay } from "@/lib/coaching-store";
import { localDay, shortDay } from "@/lib/metrics";
import { shiftDay, totalNutrients } from "@/lib/nutrition";

export function IntakeSummary() {
  const { number, language } = useStore();
  const data = useNutritionQuery(() => {
    const today = localDay();
    const days = Array.from({ length: 7 }, (_, i) => shiftDay(today, -i - 1));
    const complete = days.filter((day) => dayStatus(day) === "complete");
    const goal = currentGoal(),
      due = nextCheckInDay(goal);
    return {
      complete: complete.length,
      totals: totalNutrients(
        complete.flatMap((day) => entriesForDay(day).map((row) => row.nutrients))
      ),
      coached: !!goal && goal.mode !== "manual",
      due,
      isDue: due <= today,
    };
  });
  const average = (value: number) => number(value / data.complete, 0);
  return (
    <SystemPanel className="p-4">
      <SystemPanel.Body className="gap-3">
        <SystemLabel>Last 7 days</SystemLabel>
        {data.complete ? (
          <>
            <Text className="text-3xl font-semibold tabular-nums" maxFontSizeMultiplier={1.35}>
              {average(data.totals.calories)}
              <Text className="text-base font-medium text-muted"> kcal/day avg</Text>
            </Text>
            <Text className="text-sm text-muted tabular-nums">
              {data.complete}/7 complete days · P {average(data.totals.protein)} g · C{" "}
              {average(data.totals.carbs)} g · F {average(data.totals.fat)} g
            </Text>
          </>
        ) : (
          <Text className="text-sm text-muted">No complete days yet.</Text>
        )}
        <SystemButton variant="secondary" onPress={() => router.push("/(tabs)/plan")}>
          {data.coached
            ? data.isDue
              ? "Review check-in"
              : `Next check-in · ${shortDay(data.due, language, true)}`
            : "Set up your plan"}
        </SystemButton>
      </SystemPanel.Body>
    </SystemPanel>
  );
}
