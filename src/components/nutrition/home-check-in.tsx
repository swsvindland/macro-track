import { useRef, useState } from "react";
import { View } from "react-native";
import {
  Button,
  ErrorText,
  IconButton,
  LinkButton,
  Meta,
  Note,
  Panel,
  Text,
  Value,
  useKitFormat,
  useKitStrings,
} from "@/vector";
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

/** A diary day as a local calendar date, at noon so no time zone moves it. */
const dateOf = (day: string) => new Date(`${day}T12:00:00`);

/**
 * Offers to ignore the weigh-in that holds the check-in, then Undo. It stays mounted as the
 * review refreshes, so Undo outlives the outlier until another reading is flagged.
 */
export function OutlierPrompt({ outlier }: { outlier?: Review["outlier"] }) {
  const { refresh } = useNutrition();
  const { units, refresh: reloadWeights, t } = useStore();
  const format = useKitFormat();
  const strings = useKitStrings();
  const [ignored, setIgnored] = useState<WeightEntry | null>(null),
    [error, setError] = useState("");
  function run(action: () => void) {
    try {
      action();
      reloadWeights();
      refresh();
      setError("");
    } catch {
      setError(t("couldNotChangeWeighIn"));
    }
  }
  const id = outlier?.id;
  const reading =
    id !== undefined
      ? outlier
      : ignored && { kg: ignored.weightKg, day: dayOf(ignored.measuredAt) };
  if (!reading) return null;
  const values = {
    weight: formatWeight(reading.kg, units, format),
    day: shortDay(reading.day, format.tag),
  };
  return (
    <View className="gap-1">
      <View className="flex-row items-center gap-2">
        <Text variant="small" className="flex-1">
          {id !== undefined ? t("ignoreReadingQuestion", values) : t("ignoredReading", values)}
        </Text>
        {id !== undefined ? (
          <Button
            variant="secondary"
            onPress={() =>
              run(() => {
                const row = setWeightExcluded(id, true);
                if (row) setIgnored(row);
              })
            }
          >
            {t("ignoreReading")}
          </Button>
        ) : (
          <Button
            variant="ghost"
            onPress={() =>
              run(() => {
                if (ignored) setWeightExcluded(ignored.id, false);
                setIgnored(null);
              })
            }
          >
            {strings.undo}
          </Button>
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
  const { units, t } = useStore();
  const format = useKitFormat();
  const [details, setDetails] = useState(false),
    [adjustingFor, setAdjustingFor] = useState<string | null>(null),
    [error, setError] = useState("");
  const lockedDay = useRef("");
  const data = useNutritionQuery(() => {
    const { goal, isDue, review, targets, due } = coachingSnapshot(localDay(), {
      onlyWhenDue: true,
    });
    return isDue && review && targets ? { goal, review, targets, due } : null;
  });
  if (!data) return null;
  const { goal, review, targets, due } = data;
  // Open only for the check-in it was opened on, even if another screen answered that one.
  const adjusting = adjustingFor === due;
  const program = goal?.program;
  const maintain =
    reachedGoal(goal, review) && program
      ? formatWeight(program.targetWeightKg, units, format)
      : null;
  const start = review.proposed ?? targets,
    weight = program ? (review.trendWeightKg ?? program.weightKg) : undefined;
  function finish(action: () => void, message: string) {
    if (lockedDay.current === localDay()) return;
    lockedDay.current = localDay();
    try {
      action();
      refresh();
      onDone(message);
    } catch (e) {
      lockedDay.current = "";
      setError(e instanceof Error ? e.message : t("couldNotSaveCheckIn"));
    }
  }
  const range = format.dateRange(dateOf(review.start), dateOf(review.end));
  return (
    <Panel>
      <Panel.Header
        eyebrow={t("weeklyCheckIn")}
        meta={
          <LinkButton
            accessibilityState={{ expanded: details }}
            onPress={() => setDetails((value) => !value)}
          >
            {details ? t("less") : t("why")}
          </LinkButton>
        }
      />
      <Panel.Body>
        {review.proposed ? (
          <View className="gap-1">
            <Value
              size="m"
              value={format.number(review.proposed.calories)}
              unit={t("kcalPerDay")}
            />
            <Note>{t("currentTarget", { value: format.number(targets.calories) })}</Note>
            <Meta
              items={[
                t("proteinGrams", { value: format.number(review.proposed.protein) }),
                t("carbsGrams", { value: format.number(review.proposed.carbs) }),
                t("fatGrams", { value: format.number(review.proposed.fat) }),
              ]}
            />
            {review.weeklyKg !== null && review.desiredWeeklyKg !== null && (
              <Meta
                items={[
                  t("yourPace", { pace: formatPace(review.weeklyKg, units, format, t) }),
                  t("goalPace", { pace: formatPace(review.desiredWeeklyKg, units, format, t) }),
                ]}
              />
            )}
          </View>
        ) : (
          <View className="gap-1">
            <Text variant="bodyStrong">
              {review.status === "learning" ? t("stillLearning") : t("noChangeThisWeek")}
            </Text>
            <Meta
              items={[
                t(review.method === 2 ? "usableDays" : "completeDays", {
                  coverage: coverage(review),
                }),
                t("weighInDays", { count: format.number(review.weightDays) }),
              ]}
            />
          </View>
        )}
        <OutlierPrompt outlier={review.outlier} />
        {details && (
          <View className="gap-1">
            <Note>{review.reason}</Note>
            <Meta
              items={[
                range,
                review.expenditure !== null
                  ? t("expenditureAbout", { value: format.number(review.expenditure) })
                  : "",
              ]}
            />
            <LinkButton onPress={() => onReviewLogs(review.end)}>
              {t("reviewRecentLogging")}
            </LinkButton>
          </View>
        )}
        {adjusting ? (
          <CheckInAdjuster
            // Starts over when an ignored reading, a weigh-in or a program edit moves its start.
            key={JSON.stringify([start, weight, goal?.id])}
            start={start}
            weight={weight}
            program={program}
            onSave={(adjusted) =>
              finish(() => finishCheckIn("adjusted", adjusted), t("checkInAdjusted"))
            }
            onCancel={() => {
              setAdjustingFor(null);
              setError("");
            }}
          />
        ) : (
          <>
            {/* Secondary buttons: the dock's barcode is Home's one primary action. */}
            {maintain && (
              <Button
                variant="secondary"
                onPress={() => finish(maintainGoal, t("checkInMaintaining", { weight: maintain }))}
              >
                {t("maintainWeight", { weight: maintain })}
              </Button>
            )}
            <View className="flex-row flex-wrap gap-2">
              {review.proposed ? (
                <>
                  <Button
                    variant="secondary"
                    className="flex-1"
                    onPress={() => finish(() => finishCheckIn("accepted"), t("checkInAccepted"))}
                  >
                    {t("acceptPlan")}
                  </Button>
                  <Button
                    variant="secondary"
                    className="flex-1"
                    onPress={() => finish(() => finishCheckIn("kept"), t("checkInKept"))}
                  >
                    {t("keepCurrent")}
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    variant="secondary"
                    className="flex-1"
                    onPress={() => finish(() => finishCheckIn("kept"), t("checkInKept"))}
                  >
                    {t("keepTargetsThisWeek")}
                  </Button>
                  <Button variant="secondary" icon="scale" onPress={onWeighIn}>
                    {t("logWeight")}
                  </Button>
                </>
              )}
              <IconButton
                icon="options"
                variant="secondary"
                accessibilityLabel={t("adjustTargets")}
                onPress={() => {
                  setAdjustingFor(due);
                  setError("");
                }}
              />
            </View>
          </>
        )}
        <ErrorText message={error} />
      </Panel.Body>
    </Panel>
  );
}
