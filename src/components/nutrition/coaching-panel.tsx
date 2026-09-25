import { useState } from "react";
import { SystemButton, SystemPanel, SystemText as Text } from "@/components/system";
import { Choices, ErrorText } from "@/components/ui";
import { useNutrition, useNutritionQuery } from "@/lib/nutrition-store";
import {
  currentGoal,
  currentReview,
  saveGoal,
  finishCheckIn,
  nextCheckInDay,
  checkInHistory,
} from "@/lib/coaching-store";
import type { Goal } from "@/lib/coaching";
import { localDay } from "@/lib/metrics";
import { useStore } from "@/lib/store";

export function CoachingPanel({ onTargetsChanged }: { onTargetsChanged: () => void }) {
  const { refresh } = useNutrition();
  const { date, number, units } = useStore();
  const goal = useNutritionQuery(currentGoal);
  const review = useNutritionQuery(currentReview);
  const history = useNutritionQuery(checkInHistory);
  const due = useNutritionQuery(nextCheckInDay);
  const [editing, setEditing] = useState(false);
  const [mode, setMode] = useState<Goal["mode"]>(goal?.mode ?? "maintain");
  const [pace, setPace] = useState("0.25");
  const [eligible, setEligible] = useState(false);
  const [error, setError] = useState("");
  const convert = (kg: number) =>
    `${number(kg * (units === "metric" ? 1 : 2.2046226), 2)} ${units === "metric" ? "kg" : "lb"}/week`;
  function act(action: () => void) {
    try {
      action();
      refresh();
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save your plan.");
    }
  }
  return (
    <SystemPanel>
      <SystemPanel.Body className="gap-4">
        <Text className="text-xl font-semibold">
          {goal && goal.mode !== "manual" ? "Weekly check-in" : "Your goal"}
        </Text>
        {!goal || editing ? (
          <>
            <Text className="text-muted">
              Start with the daily targets below. Coaching learns from three weeks of complete food
              logs and regular weigh-ins.
            </Text>
            <Choices
              values={["lose", "maintain", "gain", "manual"] as const}
              value={mode}
              onChange={(value) => {
                setMode(value);
                setPace("0.25");
              }}
              label={(value) =>
                ({ lose: "Lose", maintain: "Maintain", gain: "Gain", manual: "Manual" })[value]
              }
            />
            {(mode === "lose" || mode === "gain") && (
              <>
                <Text>Weekly pace (% of body weight)</Text>
                <Choices
                  values={mode === "lose" ? ["0.25", "0.5"] : ["0.1", "0.25"]}
                  value={pace}
                  onChange={setPace}
                  label={(value) => `${value}%`}
                />
              </>
            )}
            {mode !== "manual" && (
              <>
                <Text className="text-sm text-muted">
                  Coaching is for adults 18+ who are not pregnant or breastfeeding. Use manual
                  targets with professional guidance for medical nutrition needs or eating disorder
                  care.
                </Text>
                <SystemButton
                  variant="outline"
                  onPress={() => setEligible((value) => !value)}
                  accessibilityState={{ checked: eligible }}
                >
                  {eligible ? "✓ " : ""}This applies to me
                </SystemButton>
              </>
            )}
            <SystemButton
              isDisabled={mode !== "manual" && !eligible}
              onPress={() =>
                act(() => {
                  saveGoal(mode, Number(pace));
                  setEditing(false);
                })
              }
            >
              Save goal
            </SystemButton>
            {goal && (
              <SystemButton variant="ghost" onPress={() => setEditing(false)}>
                Keep current goal
              </SystemButton>
            )}
          </>
        ) : (
          <>
            <Text className="text-muted">
              {goal.mode === "manual"
                ? "Manual targets"
                : `${goal.mode === "lose" ? "Lose" : goal.mode === "gain" ? "Gain" : "Maintain"}${goal.pace ? ` · ${goal.pace}% per week` : ""}`}
            </Text>
            {goal.mode !== "manual" && review && (
              <>
                <Text className="text-2xl font-semibold">
                  {review.status === "ready"
                    ? "Ready to review"
                    : review.status === "learning"
                      ? "Getting to know your routine"
                      : "Holding steady"}
                </Text>
                <Text className="text-sm text-muted">
                  {date(review.start)} – {date(review.end)}
                </Text>
                <Text>
                  {review.completeDays}/21 complete days · {review.weightDays} weigh-in days
                </Text>
                <Text className="text-muted">{review.reason}</Text>
                {review.intake !== null && (
                  <Text>Average logged intake · {number(review.intake, 0)} kcal</Text>
                )}
                {review.weeklyKg !== null && (
                  <Text>Observed trend · {convert(review.weeklyKg)}</Text>
                )}
                {review.desiredWeeklyKg !== null && (
                  <Text>Goal pace · {convert(review.desiredWeeklyKg)}</Text>
                )}
                {review.expenditure !== null && (
                  <Text>Estimated expenditure · {number(review.expenditure, 0)} kcal/day</Text>
                )}
                {review.proposed && (
                  <>
                    <Text className="text-2xl font-semibold">
                      {number(review.proposed.calories, 0)} kcal/day
                    </Text>
                    <Text className="text-muted">
                      Suggested · {review.proposed.protein}g protein · {review.proposed.carbs}g
                      carbs · {review.proposed.fat}g fat
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
                        Accept targets starting today
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
                      Keep targets this week
                    </SystemButton>
                  </>
                )}
              </>
            )}
            <SystemButton
              variant="ghost"
              onPress={() => {
                setMode(goal.mode);
                setPace(String(goal.pace || 0.25));
                setEditing(true);
              }}
            >
              Change goal
            </SystemButton>
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
          </>
        )}
        <ErrorText message={error} />
      </SystemPanel.Body>
    </SystemPanel>
  );
}
