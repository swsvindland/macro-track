import { useRef, useState } from "react";
import { View } from "react-native";
import {
  SystemButton,
  SystemIconButton,
  SystemLabel,
  SystemPanel,
  SystemText as Text,
} from "@/components/system";
import { ErrorText } from "@/components/ui";
import type { WeightEntry } from "@/db";
import type { Review } from "@/lib/coaching";
import {
  coachingSnapshot,
  coverage,
  finishCheckIn,
  maintainGoal,
  reachedGoal,
} from "@/lib/coaching-store";
import { dayOf, formatPace, formatWeight, localDay, shortDay } from "@/lib/metrics";
import { useNutrition, useNutritionQuery } from "@/lib/nutrition-store";
import { useStore } from "@/lib/store";
import { setWeightExcluded } from "@/lib/weigh-in";
import { CheckInAdjuster } from "./check-in-adjuster";

/**
 * Offers to ignore the weigh-in that holds the check-in, then Undo. It stays mounted as the
 * review refreshes, so Undo outlives the outlier until another reading is flagged.
 */
export function OutlierPrompt({ outlier }: { outlier?: Review["outlier"] }) {
  const { refresh } = useNutrition();
  const { number, units, language, refresh: reloadWeights } = useStore();
  const [ignored, setIgnored] = useState<WeightEntry | null>(null),
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
      : ignored && { kg: ignored.weightKg, day: dayOf(ignored.measuredAt) };
  if (!reading) return null;
  const label = `${formatWeight(reading.kg, units, number)} on ${shortDay(reading.day, language)}`;
  return (
    <View className="gap-1">
      <View className="flex-row items-center gap-2">
        <Text className="flex-1 text-sm tabular-nums">
          {id !== undefined ? `Ignore ${label}?` : `Ignored ${label}`}
        </Text>
        {id !== undefined ? (
          <SystemButton
            variant="secondary"
            onPress={() =>
              run(() => {
                const row = setWeightExcluded(id, true);
                if (row) setIgnored(row);
              })
            }
          >
            Ignore reading
          </SystemButton>
        ) : (
          <SystemButton
            variant="ghost"
            labelClassName="text-accent-soft-foreground"
            onPress={() =>
              run(() => {
                if (ignored) setWeightExcluded(ignored.id, false);
                setIgnored(null);
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
    [adjusting, setAdjusting] = useState(false),
    [error, setError] = useState("");
  const lockedDay = useRef("");
  const data = useNutritionQuery(() => {
    const { goal, isDue, review, targets } = coachingSnapshot(localDay(), { onlyWhenDue: true });
    return isDue && review && targets ? { goal, review, targets } : null;
  });
  if (!data) return null;
  const { goal, review, targets } = data;
  const program = goal?.program;
  const maintain =
    reachedGoal(goal, review) && program
      ? formatWeight(program.targetWeightKg, units, number)
      : null;
  function finish(action: () => void, message: string) {
    if (lockedDay.current === localDay()) return;
    lockedDay.current = localDay();
    try {
      action();
      refresh();
      onDone(message);
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
        {adjusting ? (
          <CheckInAdjuster
            start={review.proposed ?? targets}
            weight={program ? (review.trendWeightKg ?? program.weightKg) : undefined}
            program={program}
            onSave={(adjusted) =>
              finish(
                () => finishCheckIn("adjusted", adjusted),
                "Check-in done. Your adjusted targets start today."
              )
            }
            onCancel={() => {
              setAdjusting(false);
              setError("");
            }}
          />
        ) : (
          <>
            {maintain && (
              <SystemButton
                onPress={() =>
                  finish(maintainGoal, `Check-in done. You’re now maintaining ${maintain}.`)
                }
              >
                {`Maintain ${maintain}`}
              </SystemButton>
            )}
            <View className="flex-row flex-wrap gap-2">
              {review.proposed ? (
                <>
                  <SystemButton
                    variant={maintain ? "secondary" : "primary"}
                    className="flex-1"
                    onPress={() =>
                      finish(
                        () => finishCheckIn("accepted"),
                        "Check-in done. Your new targets start today."
                      )
                    }
                  >
                    Accept plan
                  </SystemButton>
                  <SystemButton
                    variant="secondary"
                    className="flex-1"
                    onPress={() =>
                      finish(
                        () => finishCheckIn("kept"),
                        "Check-in done. Your targets stay the same."
                      )
                    }
                  >
                    Keep current
                  </SystemButton>
                </>
              ) : (
                <>
                  <SystemButton
                    variant={maintain ? "secondary" : "primary"}
                    className="flex-1"
                    onPress={() =>
                      finish(
                        () => finishCheckIn("kept"),
                        "Check-in done. Your targets stay the same."
                      )
                    }
                  >
                    Keep targets this week
                  </SystemButton>
                  <SystemButton variant="secondary" icon="scale-outline" onPress={onWeighIn}>
                    Log weight
                  </SystemButton>
                </>
              )}
              <SystemIconButton
                icon="options-outline"
                variant="secondary"
                iconSize={20}
                accessibilityLabel="Adjust targets"
                onPress={() => {
                  setAdjusting(true);
                  setError("");
                }}
              />
            </View>
          </>
        )}
        <ErrorText message={error} />
      </SystemPanel.Body>
    </SystemPanel>
  );
}
