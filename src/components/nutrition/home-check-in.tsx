import { useRef, useState } from "react";
import { View } from "react-native";
import { SystemButton, SystemLabel, SystemPanel, SystemText as Text } from "@/components/system";
import { ErrorText } from "@/components/ui";
import type { WeightEntry } from "@/db";
import type { Review } from "@/lib/coaching";
import { coachingSnapshot, coverage, finishCheckIn } from "@/lib/coaching-store";
import { dayOf, formatPace, formatWeight, localDay, shortDay } from "@/lib/metrics";
import { useNutrition, useNutritionQuery } from "@/lib/nutrition-store";
import { useStore } from "@/lib/store";
import { deleteWeight, restoreWeight } from "@/lib/weigh-in";

/**
 * Offers to delete the weigh-in that holds the check-in, then Undo. It stays mounted as the
 * review refreshes, so Undo outlives the outlier until another reading is flagged.
 */
export function OutlierPrompt({ outlier }: { outlier?: Review["outlier"] }) {
  const { refresh } = useNutrition();
  const { number, units, language, refresh: reloadWeights } = useStore();
  const [removed, setRemoved] = useState<WeightEntry | null>(null),
    [error, setError] = useState("");
  function run(action: () => void) {
    try {
      action();
      reloadWeights();
      refresh();
      setError("");
    } catch {
      setError("Could not change that weigh-in.");
    }
  }
  const id = outlier?.id;
  const reading =
    id !== undefined
      ? outlier
      : removed && { kg: removed.weightKg, day: dayOf(removed.measuredAt) };
  if (!reading) return null;
  const label = `${formatWeight(reading.kg, units, number)} on ${shortDay(reading.day, language)}`;
  return (
    <View className="gap-1">
      <View className="flex-row items-center gap-2">
        <Text className="flex-1 text-sm tabular-nums">
          {id !== undefined ? `Delete ${label}?` : `Deleted ${label}`}
        </Text>
        {id !== undefined ? (
          <SystemButton
            variant="danger-soft"
            onPress={() =>
              run(() => {
                // A second tap finds nothing to delete and keeps the first tap's Undo.
                const row = deleteWeight(id);
                if (row) setRemoved(row);
              })
            }
          >
            Delete
          </SystemButton>
        ) : (
          <SystemButton
            variant="ghost"
            labelClassName="text-accent-soft-foreground"
            onPress={() =>
              run(() => {
                if (removed) restoreWeight(removed);
                setRemoved(null);
              })
            }
          >
            Undo
          </SystemButton>
        )}
      </View>
      <ErrorText message={error} />
    </View>
  );
}

/** The weekly decision, answerable from Home in one tap. */
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
  const { number, date, units } = useStore();
  const [details, setDetails] = useState(false),
    [error, setError] = useState("");
  const lockedDay = useRef("");
  const data = useNutritionQuery(() => {
    const { isDue, review, targets } = coachingSnapshot(localDay(), { onlyWhenDue: true });
    return isDue && review && targets ? { review, targets } : null;
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
          ? "Check-in done. Your new targets start today."
          : "Check-in done. Your targets stay the same."
      );
    } catch (e) {
      lockedDay.current = "";
      setError(e instanceof Error ? e.message : "Could not save your check-in.");
    }
  }
  return (
    <SystemPanel className="p-4">
      <SystemPanel.Body className="gap-3">
        <View className="-my-2 -mr-2 flex-row items-center">
          <SystemLabel className="flex-1 text-accent-soft-foreground">Weekly check-in</SystemLabel>
          <SystemButton
            variant="ghost"
            className="px-3"
            accessibilityState={{ expanded: details }}
            onPress={() => setDetails((value) => !value)}
          >
            {details ? "Less" : "Why?"}
          </SystemButton>
        </View>
        {review.proposed ? (
          <View className="gap-1">
            <Text className="text-xl font-semibold tabular-nums">
              {number(targets.calories, 0)} → {number(review.proposed.calories, 0)} kcal/day
            </Text>
            <Text className="text-sm text-muted tabular-nums">
              {review.proposed.protein} g protein · {review.proposed.carbs} g carbs ·{" "}
              {review.proposed.fat} g fat
            </Text>
            {review.weeklyKg !== null && review.desiredWeeklyKg !== null && (
              <Text className="text-sm text-muted tabular-nums">
                Your pace {formatPace(review.weeklyKg, units, number)} · goal{" "}
                {formatPace(review.desiredWeeklyKg, units, number)}
              </Text>
            )}
          </View>
        ) : (
          <View className="gap-1">
            <Text className="font-semibold">
              {review.status === "learning" ? "Still learning your needs" : "No change this week"}
            </Text>
            <Text className="text-sm text-muted tabular-nums">
              {`${coverage(review)} ${review.method === 2 ? "usable" : "complete"} days · ${review.weightDays} weigh-in days`}
            </Text>
          </View>
        )}
        <OutlierPrompt outlier={review.outlier} />
        {details && (
          <View className="gap-1">
            <Text className="text-sm text-muted">{review.reason}</Text>
            <Text className="text-sm text-muted">
              {date(review.start)} – {date(review.end)}
              {review.expenditure !== null
                ? ` · Expenditure about ${number(review.expenditure, 0)} kcal/day`
                : ""}
            </Text>
            <SystemButton
              variant="ghost"
              className="self-start px-0"
              labelClassName="text-accent-soft-foreground"
              onPress={() => onReviewLogs(review.end)}
            >
              Review recent logging
            </SystemButton>
          </View>
        )}
        {review.proposed ? (
          <View className="flex-row gap-2">
            <SystemButton className="flex-1" onPress={() => finish("accepted")}>
              Accept plan
            </SystemButton>
            <SystemButton variant="secondary" className="flex-1" onPress={() => finish("kept")}>
              Keep current
            </SystemButton>
          </View>
        ) : (
          <View className="flex-row flex-wrap gap-2">
            <SystemButton className="flex-1" onPress={() => finish("kept")}>
              Keep targets this week
            </SystemButton>
            <SystemButton variant="secondary" icon="scale-outline" onPress={onWeighIn}>
              Log weight
            </SystemButton>
          </View>
        )}
        <ErrorText message={error} />
      </SystemPanel.Body>
    </SystemPanel>
  );
}
