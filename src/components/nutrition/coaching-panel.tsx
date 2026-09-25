import { useState } from "react";
import { SystemButton, SystemPanel, SystemText as Text } from "@/components/system";
import { ErrorText } from "@/components/ui";
import { useNutrition, useNutritionQuery } from "@/lib/nutrition-store";
import {
  currentGoal,
  currentReview,
  saveGoal,
  finishCheckIn,
  nextCheckInDay,
  checkInHistory,
} from "@/lib/coaching-store";
import { targetsForDay } from "@/lib/diary";
import { localDay } from "@/lib/metrics";
import { useStore } from "@/lib/store";
import { ProgramEditor } from "./program-editor";

export function CoachingPanel({ onTargetsChanged }: { onTargetsChanged: () => void }) {
  const { refresh } = useNutrition();
  const { date, number, units } = useStore();
  const goal = useNutritionQuery(currentGoal),
    review = useNutritionQuery(currentReview),
    history = useNutritionQuery(checkInHistory),
    due = useNutritionQuery(nextCheckInDay);
  const targets = useNutritionQuery(() => targetsForDay(localDay()));
  const [editing, setEditing] = useState(false),
    [error, setError] = useState("");
  const kg = (value: number) =>
    `${number(value * (units === "metric" ? 1 : 2.2046226), 1)} ${units === "metric" ? "kg" : "lb"}`;
  function act(action: () => void) {
    try {
      action();
      refresh();
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update your program.");
    }
  }
  return (
    <>
      <SystemPanel>
        <SystemPanel.Body className="gap-4">
          <Text className="text-xl font-semibold">
            {goal?.program
              ? `${goal.mode === "lose" ? "Cut" : goal.mode === "gain" ? "Bulk" : "Maintain"} · Your program`
              : "Let your plan do the math"}
          </Text>
          {goal?.program ? (
            <>
              <Text className="text-muted">
                {goal.pace ? `${goal.pace}% per week · ` : ""}Goal {kg(goal.program.targetWeightKg)}{" "}
                ·{" "}
                {goal.program.diet === "balanced"
                  ? "Balanced"
                  : goal.program.diet === "lower-fat"
                    ? "More carbs"
                    : "More fat"}
              </Text>
              {targets && (
                <>
                  <Text className="text-4xl font-semibold">
                    {number(targets.calories, 0)} kcal/day
                  </Text>
                  <Text>
                    {targets.protein} g protein · {targets.carbs} g carbs · {targets.fat} g fat
                  </Text>
                </>
              )}
              {review?.trendWeightKg !== undefined && (
                <Text>Normalized weight · {kg(review.trendWeightKg)}</Text>
              )}
            </>
          ) : (
            <Text className="text-muted">
              Choose Cut, Bulk or Maintain. We’ll generate your starting calories and macros, then
              adapt the program using food intake and normalized weight. Manual targets are also
              available below.
            </Text>
          )}
          <SystemButton onPress={() => setEditing(true)}>
            {goal?.program ? "Edit goal & program" : "Build my program"}
          </SystemButton>
          {goal?.program && (
            <SystemButton variant="ghost" onPress={() => act(() => saveGoal("manual", 0))}>
              Switch to manual targets
            </SystemButton>
          )}
          <ErrorText message={error} />
        </SystemPanel.Body>
      </SystemPanel>
      {goal && goal.mode !== "manual" && review && (
        <SystemPanel>
          <SystemPanel.Body className="gap-4">
            <Text className="text-xl font-semibold">Weekly check-in</Text>
            <Text className="text-2xl font-semibold">
              {review.status === "ready"
                ? "Your next adjustment"
                : review.status === "learning"
                  ? "Learning your energy needs"
                  : "Holding steady"}
            </Text>
            <Text className="text-sm text-muted">
              {date(review.start)} – {date(review.end)} · {review.completeDays} tracked days ·{" "}
              {review.weightDays} weigh-in days
            </Text>
            <Text className="text-muted">{review.reason}</Text>
            {review.expenditure !== null && (
              <Text>
                Estimated expenditure · {number(review.expenditure, 0)} kcal/day
                {review.status === "learning" ? " (provisional)" : ""}
              </Text>
            )}
            {review.weeklyKg !== null && <Text>Observed pace · {kg(review.weeklyKg)}/week</Text>}
            {review.desiredWeeklyKg !== null && (
              <Text>Goal pace · {kg(review.desiredWeeklyKg)}/week</Text>
            )}
            {review.proposed && (
              <>
                <Text className="text-3xl font-semibold">
                  {number(review.proposed.calories, 0)} kcal/day
                </Text>
                <Text className="text-muted">
                  Suggested · {review.proposed.protein}g protein · {review.proposed.carbs}g carbs ·{" "}
                  {review.proposed.fat}g fat
                </Text>
              </>
            )}
            {due > localDay() ? (
              <Text className="text-muted">Next check-in · {date(due)}</Text>
            ) : (
              <>
                {review.proposed && (
                  <SystemButton
                    onPress={() =>
                      act(() => {
                        finishCheckIn("accepted");
                        onTargetsChanged();
                      })
                    }
                  >
                    Accept this week’s plan
                  </SystemButton>
                )}
                <SystemButton
                  variant="outline"
                  onPress={() =>
                    act(() => {
                      finishCheckIn("kept");
                    })
                  }
                >
                  Keep current plan
                </SystemButton>
              </>
            )}
            {history.length > 0 && (
              <>
                <Text className="font-semibold">Recent check-ins</Text>
                {history.slice(0, 4).map((item) => (
                  <Text key={item.day} className="text-sm text-muted">
                    {date(item.day)} · {item.decision === "accepted" ? "Accepted" : "Kept"} ·{" "}
                    {number(item.targets.calories, 0)} kcal
                  </Text>
                ))}
              </>
            )}
          </SystemPanel.Body>
        </SystemPanel>
      )}
      {editing && <ProgramEditor close={() => setEditing(false)} />}
    </>
  );
}
