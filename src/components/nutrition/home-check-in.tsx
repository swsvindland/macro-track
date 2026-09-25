import { useRef, useState } from "react";
import { View } from "react-native";
import { SystemButton, SystemPanel, SystemText as Text } from "@/components/system";
import { ErrorText } from "@/components/ui";
import { currentGoal, currentReview, finishCheckIn, nextCheckInDay } from "@/lib/coaching-store";
import { targetsForDay } from "@/lib/diary";
import { localDay } from "@/lib/metrics";
import { useNutrition, useNutritionQuery } from "@/lib/nutrition-store";
import { useStore } from "@/lib/store";
export function HomeCheckIn({
  onDone,
  onWeighIn,
  onReviewLogs,
}: {
  onDone: (message: string) => void;
  onWeighIn: () => void;
  onReviewLogs: (day: string) => void;
}) {
  const { refresh } = useNutrition();
  const { number, date } = useStore();
  const [details, setDetails] = useState(false),
    [error, setError] = useState("");
  const lockedDay = useRef("");
  const data = useNutritionQuery(() => {
    const day = localDay(),
      goal = currentGoal();
    if (!goal || goal.mode === "manual" || nextCheckInDay() > day) return null;
    const review = currentReview(day),
      targets = targetsForDay(day);
    return review && targets ? { review, targets } : null;
  });
  if (!data) return null;
  const { review, targets } = data;
  function finish(decision: "accepted" | "kept") {
    if (lockedDay.current === localDay()) return;
    lockedDay.current = localDay();
    try {
      finishCheckIn(decision);
      refresh();
      onDone(
        decision === "accepted"
          ? "Check-in done. Your new targets are ready."
          : "Check-in done. Your targets stay the same."
      );
    } catch (e) {
      lockedDay.current = "";
      setError(e instanceof Error ? e.message : "Could not save your check-in.");
    }
  }
  return (
    <SystemPanel className="p-4">
      <SystemPanel.Body className="gap-2">
        <View className="flex-row items-center justify-between gap-2">
          <Text className="font-semibold">Your weekly check-in</Text>
          <SystemButton
            variant="ghost"
            className="px-2"
            onPress={() => setDetails((value) => !value)}
          >
            {details ? "Less" : "Why?"}
          </SystemButton>
        </View>
        {review.proposed ? (
          <>
            <Text className="text-xl font-semibold">
              {number(targets.calories, 0)} → {number(review.proposed.calories, 0)} kcal
            </Text>
            <Text className="text-sm text-muted">
              {review.proposed.protein} g protein · {review.proposed.carbs} g carbs ·{" "}
              {review.proposed.fat} g fat
            </Text>
            <View className="flex-row gap-2">
              <SystemButton className="flex-1" onPress={() => finish("accepted")}>
                Accept plan
              </SystemButton>
              <SystemButton variant="ghost" onPress={() => finish("kept")}>
                Keep current
              </SystemButton>
            </View>
          </>
        ) : (
          <>
            <Text className="text-sm text-muted">{review.reason}</Text>
            <View className="flex-row flex-wrap gap-2">
              <SystemButton variant="secondary" onPress={() => finish("kept")}>
                Keep targets this week
              </SystemButton>
              <SystemButton variant="ghost" onPress={onWeighIn}>
                Weigh in
              </SystemButton>
            </View>
          </>
        )}
        {details && (
          <View className="gap-2">
            <Text className="text-sm text-muted">
              {date(review.start)} – {date(review.end)} · {review.completeDays} tracked days ·{" "}
              {review.weightDays} weigh-in days
            </Text>
            {review.proposed && <Text className="text-sm text-muted">{review.reason}</Text>}
            {review.expenditure !== null && (
              <Text className="text-sm text-muted">
                Estimated expenditure · {number(review.expenditure, 0)} kcal/day
              </Text>
            )}
            <SystemButton variant="ghost" onPress={() => onReviewLogs(review.end)}>
              Review recent logging
            </SystemButton>
          </View>
        )}
        <ErrorText message={error} />
      </SystemPanel.Body>
    </SystemPanel>
  );
}
