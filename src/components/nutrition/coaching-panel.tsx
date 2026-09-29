import { useRef, useState } from "react";
import { Alert, View } from "react-native";
import { weekOf } from "@/components/plan/calorie-shift";
import { CheckInRing, ProgramCard } from "@/components/plan/strategy";
import {
  ActionMenu,
  Button,
  ErrorText,
  Heading,
  IconButton,
  Label,
  LinkButton,
  Meta,
  Note,
  Panel,
  Text,
  Value,
  useKitFormat,
} from "@/vector";
import { useNutrition, useNutritionQuery } from "@/lib/nutrition-store";
import {
  coverage,
  finishCheckIn,
  maintainGoal,
  planSnapshot,
  reachedGoal,
  saveGoal,
} from "@/lib/coaching-store";
import type { Targets } from "@/lib/nutrition";
import { dayToConfirm, setDayStatus } from "@/lib/diary";
import { formatPace, formatWeight, localDay, shortDay } from "@/lib/metrics";
import { useStore } from "@/lib/store";
import { CheckInAdjuster } from "./check-in-adjuster";
import { OutlierPrompt } from "./home-check-in";
import { ProgramEditor } from "./program-editor";

const decisions = {
  accepted: "decisionAccepted",
  kept: "decisionKept",
  adjusted: "decisionAdjusted",
} as const;
const diets = {
  balanced: "dietBalanced",
  "lower-fat": "dietMoreCarbs",
  "lower-carb": "dietMoreFat",
} as const;
/** A diary day as a local calendar date, at noon so no time zone moves it. */
const dateOf = (day: string) => new Date(`${day}T12:00:00`);

/** One figure of the review: an eyebrow, the readout and an optional note. */
function Stat({
  title,
  value,
  unit,
  note,
}: {
  title: string;
  value: string;
  unit?: string;
  note?: string;
}) {
  return (
    <View className="grow basis-2/5 gap-1">
      <Label>{title}</Label>
      <Value size="m" value={value} unit={unit} />
      {note && <Note>{note}</Note>}
    </View>
  );
}

export function CoachingPanel({ onTargetsChanged }: { onTargetsChanged: () => void }) {
  const { refresh } = useNutrition();
  const { units, t } = useStore();
  const format = useKitFormat();
  // Clock reads stay inside the query so they refresh with every revision.
  const data = useNutritionQuery(() => {
    const snapshot = planSnapshot(localDay());
    return { ...snapshot, pending: snapshot.isDue ? dayToConfirm(snapshot.day) : null };
  });
  const { goal, review, history, due, isDue, targets, pending, since, countdown } = data;
  const [editing, setEditing] = useState(false),
    [programError, setProgramError] = useState(""),
    [checkInError, setCheckInError] = useState(""),
    [why, setWhy] = useState(false),
    [adjustingFor, setAdjustingFor] = useState<string | null>(null);
  const finished = useRef(""),
    switched = useRef<number | null>(null);
  const program = goal?.program,
    coached = !!goal && goal.mode !== "manual";
  // A shift a lower budget can't fit is paused, and each day gets the budget itself.
  const shiftedWeek = program?.shift && targets ? weekOf(targets, program.shift) : null;
  const week = targets ? (shiftedWeek ?? Array.from({ length: 7 }, () => targets)) : null;
  const weight = (kg: number) => formatWeight(kg, units, format);
  const pace = (kg: number | null) => (kg === null ? "—" : formatPace(kg, units, format, t));
  function act(action: () => void, setError: (message: string) => void) {
    try {
      action();
      refresh();
      setError("");
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : t("couldNotUpdateProgram"));
      return false;
    }
  }
  function finish(decision: "accepted" | "kept" | "adjusted", override?: Targets) {
    const day = localDay();
    if (finished.current === day) return;
    finished.current = day;
    const saved = act(() => {
      finishCheckIn(decision, override);
      if (decision !== "kept") onTargetsChanged();
    }, setCheckInError);
    if (!saved) finished.current = "";
    else setAdjustingFor(null);
  }
  function maintain() {
    // Due, this answers the check-in too, so neither can repeat that day.
    if (!goal || switched.current === goal.id || (isDue && finished.current === localDay())) return;
    switched.current = goal.id;
    const saved = act(() => {
      maintainGoal();
      onTargetsChanged();
    }, setCheckInError);
    if (!saved) switched.current = null;
    else if (isDue) finished.current = localDay();
  }
  const maintainWeight =
    program && reachedGoal(goal, review) ? weight(program.targetWeightKg) : null;
  const adjustFrom = review?.proposed ?? targets,
    trendWeight = program && review ? (review.trendWeightKg ?? program.weightKg) : undefined;
  // Open only for the check-in it was opened on, even if another screen answered that one.
  const adjusting = isDue && adjustingFor === due;
  function switchToManual() {
    Alert.alert(t("switchToManualQuestion"), t("switchToManualBody"), [
      { text: t("cancel"), style: "cancel" },
      {
        text: t("switchAction"),
        onPress: () => act(() => saveGoal("manual", 0), setProgramError),
      },
    ]);
  }
  const diet = t(program?.custom ? "dietCustom" : diets[program?.diet ?? "lower-carb"]);
  const paceShown = goal ? format.percent(goal.pace / 100, 2) : "";
  const detail =
    goal && coached
      ? goal.mode === "maintain"
        ? t("modeMaintain")
        : t(goal.mode === "gain" ? "bulkPace" : "cutPace", { pace: paceShown })
      : undefined;
  const notes = program
    ? [
        ...(shiftedWeek && targets
          ? [t("kcalDayAverage", { value: format.number(targets.calories) })]
          : []),
        ...(program.shift && targets && !shiftedWeek ? [t("shiftPaused")] : []),
        [
          review?.trendWeightKg !== undefined
            ? t("trendWeightValue", { weight: weight(review.trendWeightKg) })
            : "",
          t("goalWeightValue", { weight: weight(program.targetWeightKg) }),
          diet,
        ].filter(Boolean),
      ]
    : [];
  const checkIn = coached && review && (
    <Panel>
      <Panel.Header
        eyebrow={
          isDue
            ? t("weeklyCheckInDue")
            : t("nextCheckInOn", { day: shortDay(due, format.tag, true) })
        }
        meta={
          <LinkButton
            accessibilityState={{ expanded: why }}
            onPress={() => setWhy((open) => !open)}
          >
            {why ? t("less") : t("why")}
          </LinkButton>
        }
      />
      <Panel.Body>
        <View className="gap-1">
          <Heading level={3}>
            {t(
              review.status === "ready"
                ? "nextAdjustment"
                : review.status === "learning"
                  ? "learningEnergyNeeds"
                  : "holdingSteady"
            )}
          </Heading>
          <Note>{format.dateRange(dateOf(review.start), dateOf(review.end))}</Note>
        </View>
        <View className="flex-row flex-wrap gap-x-4 gap-y-3">
          <Stat
            title={t("expenditure")}
            value={review.expenditure === null ? "—" : format.number(review.expenditure)}
            unit={review.expenditure === null ? undefined : t("kcal")}
            note={
              review.expenditure !== null && review.status === "learning"
                ? t("provisional")
                : undefined
            }
          />
          <Stat title={t("paceYours")} value={pace(review.weeklyKg)} />
          <Stat title={t("paceGoal")} value={pace(review.desiredWeeklyKg)} />
          <Stat
            title={t(review.method === 2 ? "usableDaysTitle" : "completeDaysTitle")}
            value={coverage(review)}
            note={t("weighInCount", { count: format.number(review.weightDays) })}
          />
        </View>
        <OutlierPrompt outlier={review.outlier} />
        {why && <Note>{review.reason}</Note>}
        {review.proposed && (
          <View className="gap-1">
            <Value
              size="m"
              value={format.number(review.proposed.calories)}
              unit={t("kcalPerDay")}
            />
            {targets && (
              <Note>{t("currentTarget", { value: format.number(targets.calories) })}</Note>
            )}
            <Meta
              items={[
                t("proteinGrams", { value: format.number(review.proposed.protein) }),
                t("carbsGrams", { value: format.number(review.proposed.carbs) }),
                t("fatGrams", { value: format.number(review.proposed.fat) }),
              ]}
            />
          </View>
        )}
        {/* Secondary buttons: the dock's barcode is the tab's one primary action. */}
        {maintainWeight && !adjusting && (
          <Button variant="secondary" disabled={isDue && !!pending} onPress={maintain}>
            {t("maintainWeight", { weight: maintainWeight })}
          </Button>
        )}
        {isDue && (
          <>
            {/* A check-in saved before this learns from incomplete data for a week. */}
            {pending && (
              <View className="gap-2 border-t border-separator pt-3">
                <Text variant="small">
                  {t("confirmDayFirst", {
                    day: format.weekdayLong(dateOf(pending.day)),
                    kcal: format.number(pending.calories),
                  })}
                </Text>
                <View className="flex-row gap-2">
                  <Button
                    variant="secondary"
                    className="flex-1"
                    onPress={() =>
                      act(() => setDayStatus(pending.day, "complete"), setCheckInError)
                    }
                  >
                    {t("statusComplete")}
                  </Button>
                  <Button
                    variant="secondary"
                    className="flex-1"
                    onPress={() => act(() => setDayStatus(pending.day, "partial"), setCheckInError)}
                  >
                    {t("notAll")}
                  </Button>
                </View>
              </View>
            )}
            {adjusting && adjustFrom && !pending ? (
              <CheckInAdjuster
                // Starts over when an ignored reading, a weigh-in or a program edit moves its start.
                key={JSON.stringify([adjustFrom, trendWeight, goal.id])}
                start={adjustFrom}
                weight={trendWeight}
                program={program}
                onSave={(adjusted) => finish("adjusted", adjusted)}
                onCancel={() => {
                  setAdjustingFor(null);
                  setCheckInError("");
                }}
              />
            ) : (
              <View className="flex-row flex-wrap gap-2">
                {review.proposed && (
                  <Button
                    variant="secondary"
                    className="grow"
                    disabled={!!pending}
                    onPress={() => finish("accepted")}
                  >
                    {t("acceptWeekPlan")}
                  </Button>
                )}
                <Button
                  variant="secondary"
                  className="grow"
                  disabled={!!pending}
                  onPress={() => finish("kept")}
                >
                  {t("keepCurrentPlan")}
                </Button>
                {adjustFrom && (
                  <IconButton
                    icon="options"
                    variant="secondary"
                    accessibilityLabel={t("adjustTargets")}
                    disabled={!!pending}
                    onPress={() => {
                      setAdjustingFor(due);
                      setCheckInError("");
                    }}
                  />
                )}
              </View>
            )}
          </>
        )}
        <ErrorText message={checkInError} />
        {history.length > 0 && (
          <View className="gap-1 border-t border-separator pt-3">
            <Label accessibilityRole="header">{t("recentCheckIns")}</Label>
            {history.slice(0, 4).map((item) => (
              <Meta
                key={item.day}
                items={[
                  shortDay(item.day, format.tag),
                  t(decisions[item.decision]),
                  t("kcalValue", { value: format.number(item.targets.calories) }),
                ]}
              />
            ))}
          </View>
        )}
      </Panel.Body>
    </Panel>
  );
  return (
    <>
      {countdown && (
        <CheckInRing
          days={countdown.days}
          progress={countdown.progress}
          goal={data.goalProgress}
          due={due}
        />
      )}
      {/* Due, the decision comes first; otherwise it follows the program as evidence. */}
      {isDue && checkIn}
      {coached || targets ? (
        <ProgramCard
          name={t(coached ? "coachedProgram" : "programManual")}
          since={since?.day ?? null}
          detail={detail}
          week={week}
          today={dateOf(data.day).getDay()}
          notes={notes}
          onPress={coached ? () => setEditing(true) : undefined}
          action={
            program && (
              <ActionMenu
                accessibilityLabel={t("programOptions")}
                sections={[
                  {
                    actions: [
                      {
                        key: "manual",
                        label: t("switchToManual"),
                        icon: "edit",
                        onPress: switchToManual,
                      },
                    ],
                  },
                ]}
              />
            )
          }
        >
          {!coached && (
            <Button variant="secondary" onPress={() => setEditing(true)}>
              {t("buildMyProgram")}
            </Button>
          )}
        </ProgramCard>
      ) : (
        <Panel>
          <Panel.Header eyebrow={t("getStarted")} title={t("planDoesMath")} />
          <Panel.Body>
            <Button variant="secondary" onPress={() => setEditing(true)}>
              {t("buildMyProgram")}
            </Button>
          </Panel.Body>
        </Panel>
      )}
      <ErrorText message={programError} />
      {!isDue && checkIn}
      {editing && <ProgramEditor close={() => setEditing(false)} />}
    </>
  );
}
