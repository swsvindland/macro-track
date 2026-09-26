import { useRef, useState } from "react";
import { Alert, View } from "react-native";
import { weekOf } from "@/components/plan/calorie-shift";
import { CheckInRing, ProgramCard } from "@/components/plan/strategy";
import {
  SystemButton,
  SystemIconButton,
  SystemLabel,
  SystemPanel,
  SystemText as Text,
} from "@/components/system";
import { ActionMenu, ErrorText } from "@/components/ui";
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

const decisions = { accepted: "Accepted", kept: "Kept", adjusted: "Adjusted" };
const weekdayOf = (day: string, language: string) =>
  new Date(`${day}T12:00:00`).toLocaleDateString(language === "zh" ? "zh-CN" : language, {
    weekday: "long",
  });

function Stat({ title, value, note }: { title: string; value: string; note?: string }) {
  return (
    <View className="grow gap-1 rounded-2xl bg-surface-secondary p-3" style={{ flexBasis: "40%" }}>
      <SystemLabel>{title}</SystemLabel>
      <Text className="text-lg font-semibold tabular-nums">{value}</Text>
      {note && <Text className="text-sm text-muted">{note}</Text>}
    </View>
  );
}

export function CoachingPanel({ onTargetsChanged }: { onTargetsChanged: () => void }) {
  const { refresh } = useNutrition();
  const { number, units, language } = useStore();
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
  const weight = (kg: number) => formatWeight(kg, units, number);
  const pace = (kg: number | null) => (kg === null ? "—" : formatPace(kg, units, number));
  function act(action: () => void, setError: (message: string) => void) {
    try {
      action();
      refresh();
      setError("");
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update your program.");
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
    Alert.alert(
      "Switch to manual targets?",
      "Your current targets stay the same and weekly check-ins stop. You can build a program again at any time.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Switch", onPress: () => act(() => saveGoal("manual", 0), setProgramError) },
      ]
    );
  }
  const diet = program?.custom
    ? "Custom macros"
    : program?.diet === "balanced"
      ? "Balanced"
      : program?.diet === "lower-fat"
        ? "More carbs"
        : "More fat";
  const detail =
    goal && coached
      ? goal.mode === "maintain"
        ? "Maintain"
        : `${goal.mode === "gain" ? "Bulk" : "Cut"} ${number(goal.pace, Number.isInteger(goal.pace * 10) ? 1 : 2)}%/wk`
      : undefined;
  const notes = program
    ? [
        ...(shiftedWeek && targets ? [`${number(targets.calories, 0)} kcal/day on average`] : []),
        ...(program.shift && targets && !shiftedWeek
          ? ["Calorie shifting is paused: it doesn’t fit this budget."]
          : []),
        [
          review?.trendWeightKg !== undefined ? `Trend ${weight(review.trendWeightKg)}` : "",
          `Goal ${weight(program.targetWeightKg)}`,
          diet,
        ]
          .filter(Boolean)
          .join(" · "),
      ]
    : [];
  const checkIn = coached && review && (
    <SystemPanel className="p-4">
      <SystemPanel.Body className="gap-3">
        <View className="-my-2 -mr-2 flex-row items-center gap-2">
          <SystemLabel className="flex-1">
            {isDue
              ? "Weekly check-in · due today"
              : `Next check-in · ${shortDay(due, language, true)}`}
          </SystemLabel>
          <SystemButton
            variant="ghost"
            className="px-3"
            accessibilityState={{ expanded: why }}
            onPress={() => setWhy((open) => !open)}
          >
            {why ? "Less" : "Why?"}
          </SystemButton>
        </View>
        <View className="gap-1">
          <Text accessibilityRole="header" className="text-2xl font-semibold">
            {review.status === "ready"
              ? "Your next adjustment"
              : review.status === "learning"
                ? "Learning your energy needs"
                : "Holding steady"}
          </Text>
          <Text className="text-sm text-muted">
            {shortDay(review.start, language)} – {shortDay(review.end, language)}
          </Text>
        </View>
        <View className="flex-row flex-wrap gap-2">
          <Stat
            title="Expenditure"
            value={review.expenditure === null ? "—" : `≈ ${number(review.expenditure, 0)} kcal`}
            note={
              review.expenditure !== null && review.status === "learning"
                ? "Provisional"
                : undefined
            }
          />
          <Stat title="Your pace" value={pace(review.weeklyKg)} />
          <Stat title="Goal pace" value={pace(review.desiredWeeklyKg)} />
          <Stat
            title={review.method === 2 ? "Usable days" : "Complete days"}
            value={coverage(review)}
            note={`${review.weightDays} weigh-ins`}
          />
        </View>
        <OutlierPrompt outlier={review.outlier} />
        {why && <Text className="text-sm text-muted">{review.reason}</Text>}
        {review.proposed && (
          <View className="gap-1">
            <Text className="text-xl font-semibold tabular-nums">
              {targets ? `${number(targets.calories, 0)} → ` : ""}
              {number(review.proposed.calories, 0)} kcal/day
            </Text>
            <Text className="text-sm text-muted tabular-nums">
              Protein {review.proposed.protein} g · Carbs {review.proposed.carbs} g · Fat{" "}
              {review.proposed.fat} g
            </Text>
          </View>
        )}
        {maintainWeight && !adjusting && (
          <SystemButton isDisabled={isDue && !!pending} onPress={maintain}>
            {`Maintain ${maintainWeight}`}
          </SystemButton>
        )}
        {isDue && (
          <>
            {/* A check-in saved before this learns from incomplete data for a week. */}
            {pending && (
              <View className="gap-2 border-t border-separator pt-3">
                <Text className="text-sm">
                  Confirm {weekdayOf(pending.day, language)} first · {number(pending.calories, 0)}{" "}
                  kcal logged
                </Text>
                <View className="flex-row gap-2">
                  <SystemButton
                    className="flex-1"
                    onPress={() =>
                      act(() => setDayStatus(pending.day, "complete"), setCheckInError)
                    }
                  >
                    Complete
                  </SystemButton>
                  <SystemButton
                    variant="secondary"
                    className="flex-1"
                    onPress={() => act(() => setDayStatus(pending.day, "partial"), setCheckInError)}
                  >
                    Not all
                  </SystemButton>
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
                  <SystemButton
                    variant={maintainWeight ? "secondary" : "primary"}
                    className="grow"
                    isDisabled={!!pending}
                    onPress={() => finish("accepted")}
                  >
                    Accept this week’s plan
                  </SystemButton>
                )}
                <SystemButton
                  variant="secondary"
                  className="grow"
                  isDisabled={!!pending}
                  onPress={() => finish("kept")}
                >
                  Keep current plan
                </SystemButton>
                {adjustFrom && (
                  <SystemIconButton
                    icon="options-outline"
                    variant="secondary"
                    iconSize={20}
                    accessibilityLabel="Adjust targets"
                    isDisabled={!!pending}
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
            <SystemLabel>Recent check-ins</SystemLabel>
            {history.slice(0, 4).map((item) => (
              <Text key={item.day} className="text-sm text-muted tabular-nums">
                {shortDay(item.day, language)} · {decisions[item.decision]} ·{" "}
                {number(item.targets.calories, 0)} kcal
              </Text>
            ))}
          </View>
        )}
      </SystemPanel.Body>
    </SystemPanel>
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
          name={coached ? "Coached program" : "Manual"}
          since={since?.day ?? null}
          detail={detail}
          week={week}
          today={new Date(`${data.day}T12:00:00`).getDay()}
          notes={notes}
          onPress={coached ? () => setEditing(true) : undefined}
          action={
            program && (
              <ActionMenu
                accessibilityLabel="Program options"
                sections={[
                  {
                    actions: [
                      {
                        key: "manual",
                        label: "Switch to manual targets",
                        icon: "create-outline",
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
            <SystemButton variant="secondary" onPress={() => setEditing(true)}>
              Build my program
            </SystemButton>
          )}
        </ProgramCard>
      ) : (
        <SystemPanel className="p-4">
          <SystemPanel.Body className="gap-3">
            <SystemLabel>Get started</SystemLabel>
            <Text accessibilityRole="header" className="text-xl font-semibold">
              Let your plan do the math
            </Text>
            <SystemButton onPress={() => setEditing(true)}>Build my program</SystemButton>
          </SystemPanel.Body>
        </SystemPanel>
      )}
      <ErrorText message={programError} />
      {!isDue && checkIn}
      {editing && <ProgramEditor close={() => setEditing(false)} />}
    </>
  );
}
