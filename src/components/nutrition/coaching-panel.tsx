import { useRef, useState } from "react";
import { Alert, View } from "react-native";
import { SystemButton, SystemLabel, SystemPanel, SystemText as Text } from "@/components/system";
import { ActionMenu, ErrorText } from "@/components/ui";
import { useNutrition, useNutritionQuery } from "@/lib/nutrition-store";
import { coachingSnapshot, coverage, saveGoal, finishCheckIn } from "@/lib/coaching-store";
import { dayToConfirm, setDayStatus } from "@/lib/diary";
import { formatPace, formatWeight, localDay, shortDay } from "@/lib/metrics";
import { useStore } from "@/lib/store";
import { OutlierPrompt } from "./home-check-in";
import { ProgramEditor } from "./program-editor";

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
  const { goal, review, history, due, isDue, targets, pending } = useNutritionQuery(() => {
    const day = localDay(),
      snapshot = coachingSnapshot(day);
    return { ...snapshot, pending: snapshot.isDue ? dayToConfirm(day) : null };
  });
  const [editing, setEditing] = useState(false),
    [programError, setProgramError] = useState(""),
    [checkInError, setCheckInError] = useState(""),
    [why, setWhy] = useState(false);
  const finished = useRef("");
  const program = goal?.program;
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
  function finish(decision: "accepted" | "kept") {
    const day = localDay();
    if (finished.current === day) return;
    finished.current = day;
    const saved = act(() => {
      finishCheckIn(decision);
      if (decision === "accepted") onTargetsChanged();
    }, setCheckInError);
    if (!saved) finished.current = "";
  }
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
  const diet =
    program?.diet === "balanced"
      ? "Balanced"
      : program?.diet === "lower-fat"
        ? "More carbs"
        : "More fat";
  return (
    <>
      <SystemPanel className="p-4">
        <SystemPanel.Body className="gap-3">
          <View className={program ? "-my-3 -mr-3 flex-row items-center gap-2" : "flex-row"}>
            <SystemLabel className="flex-1">{program ? "Your program" : "Get started"}</SystemLabel>
            {program && (
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
            )}
          </View>
          {program && goal ? (
            <>
              <Text accessibilityRole="header" className="text-xl font-semibold">
                {goal.mode === "maintain"
                  ? "Maintain"
                  : `${goal.mode === "gain" ? "Bulk" : "Cut"} · ${number(goal.pace, Number.isInteger(goal.pace * 10) ? 1 : 2)}%/wk`}
              </Text>
              {targets && (
                <>
                  <Text
                    className="text-4xl font-semibold tabular-nums"
                    maxFontSizeMultiplier={1.35}
                  >
                    {number(targets.calories, 0)}
                    <Text className="text-base font-medium text-muted"> kcal/day</Text>
                  </Text>
                  <View className="flex-row gap-4">
                    {(
                      [
                        ["Protein", targets.protein],
                        ["Carbs", targets.carbs],
                        ["Fat", targets.fat],
                      ] as const
                    ).map(([label, grams]) => (
                      <View key={label} className="flex-1 gap-1">
                        <SystemLabel>{label}</SystemLabel>
                        <Text
                          className="text-base font-semibold tabular-nums"
                          maxFontSizeMultiplier={1.3}
                        >
                          {number(grams, 0)} g
                        </Text>
                      </View>
                    ))}
                  </View>
                </>
              )}
              <Text className="text-sm text-muted">
                {review?.trendWeightKg !== undefined
                  ? `Trend ${weight(review.trendWeightKg)} · `
                  : ""}
                Goal {weight(program.targetWeightKg)} · {diet}
              </Text>
            </>
          ) : (
            <>
              <Text accessibilityRole="header" className="text-xl font-semibold">
                Let your plan do the math
              </Text>
            </>
          )}
          <SystemButton
            variant={program ? "secondary" : "primary"}
            onPress={() => setEditing(true)}
          >
            {program ? "Edit goal & program" : "Build my program"}
          </SystemButton>
          <ErrorText message={programError} />
        </SystemPanel.Body>
      </SystemPanel>
      {goal && goal.mode !== "manual" && review && (
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
                value={
                  review.expenditure === null ? "—" : `≈ ${number(review.expenditure, 0)} kcal`
                }
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
            {isDue && (
              <>
                {/* A check-in saved before this learns from incomplete data for a week. */}
                {pending && (
                  <View className="gap-2 border-t border-separator pt-3">
                    <Text className="text-sm">
                      Confirm {weekdayOf(pending.day, language)} first ·{" "}
                      {number(pending.calories, 0)} kcal logged
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
                        onPress={() =>
                          act(() => setDayStatus(pending.day, "partial"), setCheckInError)
                        }
                      >
                        Not all
                      </SystemButton>
                    </View>
                  </View>
                )}
                <View className="flex-row flex-wrap gap-2">
                  {review.proposed && (
                    <SystemButton
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
                </View>
              </>
            )}
            <ErrorText message={checkInError} />
            {history.length > 0 && (
              <View className="gap-1 border-t border-separator pt-3">
                <SystemLabel>Recent check-ins</SystemLabel>
                {history.slice(0, 4).map((item) => (
                  <Text key={item.day} className="text-sm text-muted tabular-nums">
                    {shortDay(item.day, language)} ·{" "}
                    {item.decision === "accepted" ? "Accepted" : "Kept"} ·{" "}
                    {number(item.targets.calories, 0)} kcal
                  </Text>
                ))}
              </View>
            )}
          </SystemPanel.Body>
        </SystemPanel>
      )}
      {editing && <ProgramEditor close={() => setEditing(false)} />}
    </>
  );
}
