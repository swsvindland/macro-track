import { router } from "expo-router";
import { SystemButton, SystemPanel, SystemText as Text } from "@/components/system";
import { useNutritionQuery } from "@/lib/nutrition-store";
import { useStore } from "@/lib/store";
import { entriesForDay, dayStatus } from "@/lib/diary";
import { currentGoal, nextCheckInDay } from "@/lib/coaching-store";
import { localDay } from "@/lib/metrics";
import { shiftDay, totalNutrients } from "@/lib/nutrition";
export function IntakeSummary() {
  const { number, date } = useStore();
  const data = useNutritionQuery(() => {
    const today = localDay();
    const days = Array.from({ length: 7 }, (_, i) => shiftDay(today, -i - 1));
    const complete = days.filter((day) => dayStatus(day) === "complete");
    return {
      complete: complete.length,
      totals: totalNutrients(
        complete.flatMap((day) => entriesForDay(day).map((row) => row.nutrients))
      ),
      goal: currentGoal(),
      due: nextCheckInDay(),
      start: days[6],
      end: days[0],
    };
  });
  return (
    <SystemPanel>
      <SystemPanel.Body className="gap-3">
        <Text className="text-xl font-semibold">Your week in food</Text>
        <Text className="text-sm text-muted">
          {date(data.start)} – {date(data.end)} · {data.complete}/7 complete days
        </Text>
        {data.complete ? (
          <>
            <Text className="text-3xl font-semibold">
              {number(data.totals.calories / data.complete, 0)} kcal/day
            </Text>
            <Text className="text-muted">
              Average across complete days only · {number(data.totals.protein / data.complete, 0)} g
              protein · {number(data.totals.carbs / data.complete, 0)} g carbs ·{" "}
              {number(data.totals.fat / data.complete, 0)} g fat
            </Text>
          </>
        ) : (
          <Text className="text-muted">
            Complete a day in your diary to start seeing your intake averages.
          </Text>
        )}
        <SystemButton variant="secondary" onPress={() => router.push("/(tabs)/plan")}>
          {data.goal && data.goal.mode !== "manual"
            ? data.due <= localDay()
              ? "Review your weekly check-in"
              : `Next check-in · ${date(data.due)}`
            : "Set up your plan"}
        </SystemButton>
      </SystemPanel.Body>
    </SystemPanel>
  );
}
