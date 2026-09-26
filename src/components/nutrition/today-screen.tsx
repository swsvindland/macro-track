import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { AccessibilityInfo, AppState, Platform, View, type ScrollView } from "react-native";
import { router } from "expo-router";
import {
  MiniBar,
  PaceBar,
  SystemButton,
  SystemIcon,
  SystemIconButton,
  SystemLabel,
  SystemPanel,
  SystemText as Text,
} from "@/components/system";
import { ActionMenu, DayPicker, Screen, SwipeRow } from "@/components/ui";
import {
  copyEntries,
  dayStatus,
  dayToConfirm,
  deleteEntries,
  entriesForDay,
  isCoached,
  setDayStatus,
  targetsForDay,
  typicalAfter,
  typicalDays,
  undoReceipt,
  type DiaryReceipt,
} from "@/lib/diary";
import { openCatalogs } from "@/lib/food-catalog";
import { modelStatus, type ModelStatus } from "@/lib/local-ai";
import { localDay } from "@/lib/metrics";
import {
  meals,
  projectDay,
  roughly,
  shiftDay,
  totalNutrients,
  type DayState,
  type Meal,
} from "@/lib/nutrition";
import {
  currentFoodTime,
  formatClock,
  mealAtTime,
  paceCutoff,
  timelineGroups,
} from "@/lib/food-time";
import { useNutrition, useNutritionQuery } from "@/lib/nutrition-store";
import { useStore } from "@/lib/store";
import { undoWeight, weighInDue } from "@/lib/weigh-in";
import type { FoodEntry } from "@/db";
import { useMeasurementLog } from "@/components/measurements/use-measurement-log";
import { WeightForm } from "@/components/measurements/weight-form";
import { FoodEditor } from "./food-editor";
import { FastLogger } from "./fast-logger";
import { HomeCheckIn } from "./home-check-in";
import { MealEditor } from "./meal-editor";
import { PhotoLogger, photoLoggingOffered } from "./photo-logger";
import { CopyDay, MoveEntries } from "./copy-day";
import { WeighInCard } from "./weigh-in-card";

const statusLabels: Record<DayState, string> = {
  "in-progress": "In progress",
  complete: "Complete",
  partial: "Not fully logged",
  fasting: "Fasted (counts as 0 kcal)",
};
type Toast = { message: string; undo?: () => string };
type WeightSheet = { open: () => void };
// The swipe actions, for screen readers.
const rowActions = [
  { name: "delete", label: "Delete" },
  { name: "again", label: "Log again now" },
  { name: "select", label: "Select" },
];
const selectionActions = [
  { key: "move", label: "Move to…", icon: "arrow-redo-outline" },
  { key: "copy", label: "Copy to today", icon: "copy-outline" },
  { key: "meal", label: "Save as meal", icon: "bookmark-outline" },
  { key: "delete", label: "Delete", icon: "trash-outline", destructive: true },
] as const;
const named = (rows: FoodEntry[]) =>
  rows.length === 1 ? rows[0].food.name : `${rows.length} foods`;

/** The Log weight sheet keeps its own state, so typing a weight doesn't re-render Home. */
function HomeWeightSheet({ ref }: { ref: Ref<WeightSheet> }) {
  const weight = useMeasurementLog("weight");
  useImperativeHandle(ref, () => ({ open: () => weight.launch(null) }));
  return <WeightForm log={weight} />;
}

/** Home: how today is going, one-tap repeats and the day's food, in that order. */
export function TodayScreen() {
  const store = useStore();
  const { number, diaryLayout, hideEmptyHours, language } = store;
  const locale = language === "zh" ? "zh-CN" : language;
  const { refresh } = useNutrition();
  const weightSheet = useRef<WeightSheet>(null);
  const [today, setToday] = useState(localDay()),
    [day, setDay] = useState(localDay()),
    [clock, setClock] = useState(currentFoodTime());
  const todayRef = useRef(today);
  const scrollRef = useRef<ScrollView>(null);
  const [editor, setEditor] = useState<FoodEntry | null>(null);
  const [logger, setLogger] = useState<{
    time?: string;
    meal?: Meal;
    start?: "search" | "barcode";
  } | null>(null);
  const [copying, setCopying] = useState(false);
  const [photoLog, setPhotoLog] = useState(false);
  // On-device AI availability decides whether Home offers photo logging at all.
  const [ai, setAi] = useState<ModelStatus | null>(null);
  const [error, setError] = useState("");
  const [toast, setToast] = useState<Toast | null>(null);
  const [mealEditor, setMealEditor] = useState<{
    source: { day: string; meal: Meal; group?: string; ids?: number[] };
    meal: Meal;
  } | null>(null);
  // Entries chosen with a long press; null outside selection mode.
  const [selected, setSelected] = useState<number[] | null>(null);
  const [moving, setMoving] = useState<FoodEntry[] | null>(null);
  // One-tap answers: a double tap must not land on whatever moved into place.
  const tapLock = useRef(false);
  // The selection bar gives way to the Undo message in the same spot.
  const undoLock = useRef(false);
  const undone = useRef(new WeakSet<Toast>());
  useEffect(() => {
    const warm = setTimeout(() => {
      void openCatalogs().catch(() => {});
      void modelStatus().then(setAi);
    }, 300);
    let hiddenAt = 0;
    function tick() {
      setClock(currentFoodTime());
      const current = localDay(),
        previous = todayRef.current;
      if (previous === current) return;
      todayRef.current = current;
      setToday(current);
      setDay((selected) => (selected === previous ? current : selected));
      setToast(null);
    }
    // On the minute, so the pace line uses the same clock as food logged "now".
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(
        () => {
          tick();
          schedule();
        },
        60000 - (Date.now() % 60000)
      );
    };
    schedule();
    // Coming back after a while should land on today, at the top, with no stale Undo.
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        tick();
        // Apple Intelligence may have been turned on, or Gemini Nano finished installing.
        void modelStatus().then(setAi);
        if (hiddenAt && Date.now() - hiddenAt > 2 * 60000) {
          setDay(localDay());
          setSelected(null);
          scrollRef.current?.scrollTo({ y: 0, animated: false });
        }
        hiddenAt = 0;
      } else if (!hiddenAt) {
        hiddenAt = Date.now();
        setToast(null);
      }
    });
    return () => {
      clearTimeout(warm);
      clearTimeout(timer);
      sub.remove();
    };
  }, []);
  useEffect(() => {
    if (!toast) return;
    if (Platform.OS === "ios") AccessibilityInfo.announceForAccessibility(toast.message);
    let active = true,
      timer: ReturnType<typeof setTimeout> | undefined;
    // Screen-reader users need time to reach Undo, so it stays until the next action.
    void AccessibilityInfo.isScreenReaderEnabled().then((reading) => {
      if (active && !reading) timer = setTimeout(() => setToast(null), 8000);
    });
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [toast]);
  const live = day === today;
  // Read once per write or day change. The minute clock only moves the pace line, which
  // is worked out below from these rows, so a tick doesn't touch the database.
  const { entries, targets, status, usualDays, confirm, coached } = useNutritionQuery(() => {
    const entries = entriesForDay(day),
      targets = targetsForDay(day);
    return {
      entries,
      targets,
      status: dayStatus(day),
      usualDays: live && targets && entries.length ? typicalDays(day) : null,
      // Check-ins and the pace estimate learn only from answered days. An unanswered
      // day holds the check-in all night; the question itself waits until 04:00 so a
      // late snack still counts toward the day it belongs to.
      confirm: live ? dayToConfirm(day) : null,
      coached: isCoached(),
    };
  }, [day, live]);
  const projection = projectDay({
    entries: entries.map((entry) => ({
      loggedTime: entry.loggedTime,
      calories: entry.nutrients.calories,
    })),
    target: targets?.calories ?? null,
    typical: usualDays && typicalAfter(usualDays, paceCutoff(entries, clock)),
    now: clock,
  });
  const askConfirm = Number(clock.slice(0, 2)) >= 4;
  const weighIn = live && weighInDue(store, today, Number(clock.slice(0, 2)), coached);
  const totals = totalNutrients(entries.map((entry) => entry.nutrients));
  const groups = (
    diaryLayout === "timeline"
      ? timelineGroups(entries, hideEmptyHours, false).map((group) => ({
          ...group,
          title: group.group === "untimed" ? group.title : formatClock(group.time, locale),
        }))
      : meals.map((meal) => ({
          key: meal,
          title: meal,
          meal,
          group: undefined,
          time: "",
          entries: entries.filter((entry) => entry.meal === meal),
        }))
  ).filter((group) => group.entries.length || !hideEmptyHours);

  function label(value: string) {
    if (value === today) return "Today";
    if (value === shiftDay(today, -1)) return "Yesterday";
    return new Date(`${value}T12:00:00`).toLocaleDateString(locale, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  }
  function go(value: string) {
    setDay(value);
    setToast(null);
    setError("");
    setSelected(null);
  }
  function show(message: string, undo?: () => string) {
    setToast({ message, undo });
    setError("");
  }
  function fail(e: unknown, fallback: string) {
    setError(e instanceof Error ? e.message : fallback);
  }
  function undoable(receipt: DiaryReceipt, message: string, undoneMessage: string) {
    show(message, () => {
      undoReceipt(receipt);
      refresh();
      return undoneMessage;
    });
  }
  function logged(receipt: DiaryReceipt) {
    const rows = receipt.inserted;
    if (!rows.length) return;
    setDay(rows[0].day);
    const kcal = totalNutrients(rows.map((entry) => entry.nutrients)).calories;
    const left = rows[0].day === day && targets ? targets.calories - totals.calories - kcal : null;
    undoable(
      receipt,
      `${named(rows)} · ${number(kcal, 0)} kcal` +
        (left === null
          ? " logged"
          : ` · ${number(Math.abs(left), 0)} ${left >= 0 ? "left" : "over"}`),
      "Log undone."
    );
  }
  function removed(receipt: DiaryReceipt) {
    const what = named(receipt.deleted);
    undoable(receipt, `${what} deleted.`, `${what} restored.`);
  }
  function moved(receipt: DiaryReceipt) {
    setSelected(null);
    const rows = receipt.moved.map((row) => row.after);
    const time = rows.every((row) => row.loggedTime === rows[0].loggedTime) && rows[0].loggedTime;
    undoable(
      receipt,
      `${named(rows)} moved to ${label(rows[0].day)}` +
        (time ? ` at ${formatClock(time, locale)}.` : "."),
      "Move undone."
    );
  }
  function changed(receipt: DiaryReceipt, change: "saved" | "deleted") {
    if (change === "deleted") removed(receipt);
    else if (receipt.moved.length)
      undoable(receipt, `${receipt.moved[0].after.food.name} updated.`, "Change undone.");
    else logged(receipt);
  }
  function remove(rows: FoodEntry[]) {
    try {
      const receipt = deleteEntries(rows.map((row) => row.id));
      refresh();
      setSelected(null);
      removed(receipt);
    } catch (e) {
      fail(e, "Could not delete this food.");
    }
  }
  /** Logs the same foods again, eaten now. */
  function again(rows: FoodEntry[]) {
    try {
      const receipt = copyEntries(
        rows.map((row) => row.id),
        today,
        currentFoodTime()
      );
      refresh();
      setSelected(null);
      logged(receipt);
    } catch (e) {
      fail(e, "Could not log this again.");
    }
  }
  function toggle(id: number) {
    setSelected(
      (ids) => ids && (ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id])
    );
  }
  function locked() {
    if (tapLock.current) return true;
    tapLock.current = true;
    setTimeout(() => {
      tapLock.current = false;
    }, 900);
    return false;
  }
  function undo() {
    if (!toast?.undo || undone.current.has(toast) || undoLock.current) return;
    undone.current.add(toast);
    try {
      show(toast.undo());
    } catch (e) {
      fail(e, "Could not undo.");
    }
  }
  function mark(target: string, value: DayState) {
    const before = dayStatus(target);
    try {
      setDayStatus(target, value);
      refresh();
      show(
        `${label(target)} marked ${value === "complete" ? "complete" : statusLabels[value].toLowerCase()}.`,
        before === value
          ? undefined
          : () => {
              setDayStatus(target, before);
              refresh();
              return "Change undone.";
            }
      );
    } catch (e) {
      fail(e, "Could not update this day.");
    }
  }
  function answer(target: string, value: "complete" | "partial") {
    if (!locked()) mark(target, value);
  }

  const hero =
    projection.status === "over"
      ? { value: projection.over, unit: " kcal over", className: "text-danger" }
      : projection.status === "no-target"
        ? { value: projection.eaten, unit: " kcal eaten", className: "" }
        : { value: projection.left, unit: " kcal left", className: "" };
  const pace =
    projection.status === "heading-over"
      ? {
          className: "text-warning",
          text: `Heading ~${number(roughly(projection.projected - projection.target), 0)} over`,
        }
      : projection.status === "on-pace"
        ? projection.projected > projection.target
          ? {
              className: "text-foreground",
              text: "Tracking right at your target",
            }
          : {
              className: "text-success",
              text: `On pace for ~${number(roughly(projection.projected), 0)}`,
            }
        : null;

  const header = (
    <View className="flex-row items-center">
      <SystemIconButton
        icon="chevron-back"
        accessibilityLabel="Previous day"
        onPress={() => go(shiftDay(day, -1))}
      />
      <DayPicker value={day} max={today} label={label(day)} onChange={go} />
      <SystemIconButton
        icon="chevron-forward"
        accessibilityLabel="Next day"
        isDisabled={live}
        color={live ? "muted" : "foreground"}
        onPress={() => go(shiftDay(day, 1))}
      />
      <View className="flex-1" />
      {!live && (
        <SystemButton
          variant="secondary"
          className="min-h-9 px-3 py-1.5"
          hitSlop={{ top: 4, bottom: 4 }}
          onPress={() => go(today)}
        >
          Today
        </SystemButton>
      )}
      <ActionMenu
        accessibilityLabel="Day options"
        sections={[
          {
            actions: [
              {
                key: "weight",
                label: "Log weight",
                icon: "scale-outline",
                onPress: () => weightSheet.current?.open(),
              },
              {
                key: "copy",
                label: live ? "Copy a day into today" : `Copy a day into ${label(day)}`,
                icon: "copy-outline",
                onPress: () => setCopying(true),
              },
            ],
          },
          {
            title: "Mark day as",
            actions: (["in-progress", "complete", "partial", "fasting"] as const).map((value) => ({
              key: value,
              label: statusLabels[value],
              selected: status === value,
              disabled:
                status === value ||
                (value === "fasting"
                  ? !!entries.length
                  : value !== "in-progress" && !entries.length),
              onPress: () => mark(day, value),
            })),
          },
        ]}
      />
    </View>
  );

  const actions = (
    <View className="gap-2">
      <View className="flex-row gap-2">
        <SystemButton
          className="min-h-12 flex-1"
          icon="search"
          labelClassName="text-base font-semibold"
          onPress={() => setLogger({})}
        >
          {live ? "Log food" : `Log to ${label(day)}`}
        </SystemButton>
        {photoLoggingOffered(ai) && (
          <SystemButton
            variant="secondary"
            className="min-h-12"
            icon={ai?.vision ? "camera-outline" : "chatbox-ellipses-outline"}
            labelClassName="text-base font-semibold"
            accessibilityLabel={
              ai?.vision ? "Log a meal from a photo" : "Describe a meal to log it"
            }
            onPress={() => setPhotoLog(true)}
          >
            {ai?.vision ? "Photo" : "Describe"}
          </SystemButton>
        )}
        <SystemButton
          variant="secondary"
          className="min-h-12"
          icon="barcode-outline"
          labelClassName="text-base font-semibold"
          accessibilityLabel="Scan barcode"
          onPress={() => setLogger({ start: "barcode" })}
        >
          Scan
        </SystemButton>
      </View>
    </View>
  );

  const chosen = entries.filter((entry) => selected?.includes(entry.id));
  function selectionAction(key: (typeof selectionActions)[number]["key"]) {
    if (key === "move") return setMoving(chosen);
    if (key === "meal") {
      setMealEditor({
        source: { day, meal: chosen[0].meal, ids: chosen.map((entry) => entry.id) },
        meal: chosen[0].meal,
      });
      return setSelected(null);
    }
    // The bar gives way to the Undo message, so a double tap must not repeat the
    // action or land on Undo.
    if (locked()) return;
    undoLock.current = true;
    setTimeout(() => {
      undoLock.current = false;
    }, 600);
    if (key === "copy") again(chosen);
    else remove(chosen);
  }
  // Pinned above the tab bar, so it stays in reach wherever the list is scrolled.
  const footer = (toast || error || selected) && (
    <View className="gap-2">
      {!!error && (
        <View className="flex-row items-center gap-2 rounded-2xl border border-border bg-overlay py-1 pl-4 pr-1 shadow-overlay">
          <Text className="flex-1 text-sm text-danger" accessibilityRole="alert">
            {error}
          </Text>
          <SystemIconButton
            icon="close"
            iconSize={18}
            color="muted"
            accessibilityLabel="Dismiss"
            onPress={() => setError("")}
          />
        </View>
      )}
      {toast && (
        <View className="flex-row items-center gap-2 rounded-2xl border border-border bg-overlay py-1 pl-4 pr-1 shadow-overlay">
          <Text className="flex-1 text-sm" numberOfLines={2} accessibilityLiveRegion="polite">
            {toast.message}
          </Text>
          {toast.undo ? (
            <SystemButton
              variant="ghost"
              labelClassName="text-accent-soft-foreground"
              onPress={undo}
            >
              Undo
            </SystemButton>
          ) : (
            <SystemIconButton
              icon="close"
              iconSize={18}
              color="muted"
              accessibilityLabel="Dismiss"
              onPress={() => setToast(null)}
            />
          )}
        </View>
      )}
      {selected && (
        <View className="gap-1 rounded-3xl border border-border bg-overlay p-2 shadow-overlay">
          <View className="flex-row items-center pl-3">
            <Text className="flex-1 font-semibold" accessibilityLiveRegion="polite">
              {chosen.length} selected
            </Text>
            <SystemButton
              variant="ghost"
              labelClassName="text-accent-soft-foreground"
              onPress={() => setSelected(null)}
            >
              Cancel
            </SystemButton>
          </View>
          <View className="flex-row">
            {selectionActions.map((action) => (
              <SystemButton
                key={action.key}
                variant="ghost"
                className="flex-1 flex-col gap-1 px-1 py-2"
                isDisabled={!chosen.length}
                accessibilityLabel={action.label}
                onPress={() => selectionAction(action.key)}
              >
                <SystemIcon
                  name={action.icon}
                  size={20}
                  color={"destructive" in action ? "danger" : "accent-soft-foreground"}
                />
                <Text
                  className={`text-xs ${"destructive" in action ? "text-danger" : "text-accent-soft-foreground"}`}
                  numberOfLines={1}
                  maxFontSizeMultiplier={1.3}
                >
                  {action.label}
                </Text>
              </SystemButton>
            ))}
          </View>
        </View>
      )}
    </View>
  );

  return (
    <>
      <Screen
        title="Today"
        compact
        scrollRef={scrollRef}
        header={header}
        footer={footer || undefined}
      >
        <SystemPanel className="p-4">
          <SystemPanel.Body className="gap-3">
            <Text
              className={`text-4xl font-semibold tabular-nums ${hero.className}`}
              maxFontSizeMultiplier={1.35}
              numberOfLines={1}
            >
              {number(hero.value, 0)}
              <Text className="text-base font-medium text-muted">{hero.unit}</Text>
            </Text>
            {targets ? (
              <>
                <PaceBar
                  eaten={totals.calories}
                  target={targets.calories}
                  projected={
                    projection.status === "on-pace" || projection.status === "heading-over"
                      ? projection.projected
                      : null
                  }
                  warn={projection.status === "heading-over"}
                  description={
                    pace?.text ?? `${Math.round(totals.calories)} of ${targets.calories} kcal`
                  }
                />
                {pace ? (
                  <Text className={`text-sm font-medium ${pace.className}`}>{pace.text}</Text>
                ) : (
                  <Text
                    className={`text-sm ${projection.status === "over" ? "text-danger" : "text-muted"}`}
                  >
                    {number(totals.calories, 0)} of {number(targets.calories, 0)} kcal
                  </Text>
                )}
              </>
            ) : (
              live && (
                <SystemButton
                  variant="secondary"
                  icon="flag-outline"
                  className="self-start"
                  onPress={() => router.push("/(tabs)/plan")}
                >
                  Set calorie & macro targets
                </SystemButton>
              )
            )}
            <View className="flex-row gap-4 pt-1">
              {(["protein", "carbs", "fat"] as const).map((key) => (
                <View key={key} className="flex-1 gap-1">
                  <SystemLabel>{key}</SystemLabel>
                  <Text
                    className="font-semibold tabular-nums"
                    maxFontSizeMultiplier={1.3}
                    numberOfLines={1}
                    adjustsFontSizeToFit
                    minimumFontScale={0.75}
                  >
                    {number(totals[key], 0)}
                    <Text className="text-sm font-normal text-muted">
                      {targets ? ` / ${number(targets[key], 0)} g` : " g"}
                    </Text>
                  </Text>
                  {targets && targets[key] > 0 && (
                    <MiniBar value={totals[key]} max={targets[key]} />
                  )}
                </View>
              ))}
            </View>
          </SystemPanel.Body>
        </SystemPanel>

        {!live && (
          <View className="flex-row flex-wrap items-center gap-2 px-1">
            <Text className="flex-1 text-sm text-muted">
              {status === "complete"
                ? "Marked complete"
                : status === "in-progress"
                  ? entries.length
                    ? "Was this day fully logged?"
                    : "Nothing logged on this day"
                  : statusLabels[status]}
            </Text>
            {status !== "complete" && !!entries.length && (
              <SystemButton variant="secondary" onPress={() => mark(day, "complete")}>
                Mark complete
              </SystemButton>
            )}
            {status === "in-progress" && !!entries.length && (
              <SystemButton variant="secondary" onPress={() => mark(day, "partial")}>
                Not all
              </SystemButton>
            )}
          </View>
        )}

        {live &&
          (weighIn ? (
            <WeighInCard
              today={today}
              onSaved={(entry, message) =>
                show(message, () => {
                  undoWeight(entry);
                  store.refresh();
                  refresh();
                  return "Weight removed.";
                })
              }
            />
          ) : confirm ? (
            askConfirm && (
              <SystemPanel className="p-4">
                <SystemPanel.Body className="gap-3">
                  <SystemLabel className="text-accent-soft-foreground">
                    Finish {label(confirm.day)}
                  </SystemLabel>
                  <SystemButton
                    variant="ghost"
                    className="-my-2 justify-start px-0"
                    accessibilityLabel={`Review ${label(confirm.day)}: ${number(confirm.calories, 0)} kcal logged. Is that everything?`}
                    onPress={() => go(confirm.day)}
                  >
                    <Text className="flex-1 font-semibold">
                      {number(confirm.calories, 0)} kcal logged. Is that everything?
                    </Text>
                    <SystemIcon name="chevron-forward" size={18} color="muted" />
                  </SystemButton>
                  <View className="flex-row gap-2">
                    <SystemButton
                      className="flex-1"
                      onPress={() => answer(confirm.day, "complete")}
                    >
                      Yes, complete
                    </SystemButton>
                    <SystemButton
                      variant="secondary"
                      className="flex-1"
                      onPress={() => answer(confirm.day, "partial")}
                    >
                      Not all
                    </SystemButton>
                  </View>
                </SystemPanel.Body>
              </SystemPanel>
            )
          ) : (
            <HomeCheckIn
              onDone={(message) => show(message)}
              onWeighIn={() => weightSheet.current?.open()}
              onReviewLogs={go}
            />
          ))}

        {actions}

        <View className="gap-2">
          <View className="flex-row items-center justify-between gap-2 px-1">
            <SystemLabel accessibilityRole="header">{live ? "Today’s food" : "Food"}</SystemLabel>
            {status === "complete" && (
              <View className="flex-row items-center gap-1">
                <SystemIcon name="checkmark-circle" size={14} color="success" />
                <Text className="text-xs text-success">Day complete</Text>
              </View>
            )}
          </View>
          {entries.length || !hideEmptyHours ? (
            <SystemPanel className="p-0">
              <SystemPanel.Body className="gap-0 pb-1">
                {groups.map((group, index) => (
                  <View key={group.key} className={index ? "border-t border-separator" : ""}>
                    <View className="flex-row items-center pl-4 pr-1">
                      <Text className="flex-1 text-sm font-semibold text-muted tabular-nums">
                        {group.title} ·{" "}
                        {number(
                          totalNutrients(group.entries.map((entry) => entry.nutrients)).calories,
                          0
                        )}{" "}
                        kcal
                      </Text>
                      <ActionMenu
                        accessibilityLabel={`Options for ${group.title}`}
                        sections={[
                          {
                            actions: [
                              {
                                key: "add",
                                label: "Add food here",
                                icon: "add",
                                onPress: () =>
                                  setLogger({
                                    meal: group.meal,
                                    time: group.time || currentFoodTime(),
                                  }),
                              },
                              ...(group.entries.length
                                ? [
                                    {
                                      key: "save",
                                      label: "Save or copy this meal",
                                      icon: "bookmark-outline" as const,
                                      onPress: () =>
                                        setMealEditor({
                                          source: { day, meal: group.meal, group: group.group },
                                          meal: group.meal,
                                        }),
                                    },
                                    {
                                      key: "move",
                                      label: "Move all to…",
                                      icon: "arrow-redo-outline" as const,
                                      onPress: () => setMoving(group.entries),
                                    },
                                    {
                                      key: "select",
                                      label: "Select these foods",
                                      icon: "checkmark-circle-outline" as const,
                                      onPress: () =>
                                        setSelected(group.entries.map((entry) => entry.id)),
                                    },
                                  ]
                                : []),
                            ],
                          },
                        ]}
                      />
                    </View>
                    {group.entries.map((entry) => {
                      const picked = !!selected?.includes(entry.id);
                      return (
                        <SwipeRow
                          key={entry.id}
                          enabled={!selected}
                          swipeLeft={{
                            label: "Delete",
                            icon: "trash-outline",
                            destructive: true,
                            onAction: () => remove([entry]),
                          }}
                          swipeRight={{
                            label: "Log again",
                            icon: "repeat",
                            onAction: () => again([entry]),
                          }}
                        >
                          <SystemButton
                            variant="ghost"
                            className="justify-start gap-3 rounded-none px-4 py-2"
                            accessibilityLabel={
                              selected ? entry.food.name : `Edit ${entry.food.name}`
                            }
                            accessibilityState={selected ? { selected: picked } : undefined}
                            accessibilityActions={selected ? undefined : rowActions}
                            onAccessibilityAction={({ nativeEvent }) =>
                              nativeEvent.actionName === "delete"
                                ? remove([entry])
                                : nativeEvent.actionName === "again"
                                  ? again([entry])
                                  : setSelected([entry.id])
                            }
                            onPress={() => (selected ? toggle(entry.id) : setEditor(entry))}
                            onLongPress={() =>
                              selected ? toggle(entry.id) : setSelected([entry.id])
                            }
                          >
                            {selected && (
                              <SystemIcon
                                name={picked ? "checkmark-circle" : "ellipse-outline"}
                                size={22}
                                color={picked ? "accent-soft-foreground" : "muted"}
                              />
                            )}
                            <View className="flex-1 gap-0.5">
                              <Text numberOfLines={1}>{entry.food.name}</Text>
                              <Text numberOfLines={1} className="text-sm text-muted">
                                {entry.loggedTime
                                  ? `${formatClock(entry.loggedTime, locale)} · `
                                  : ""}
                                {entry.portionLabel}
                              </Text>
                            </View>
                            <Text className="tabular-nums">
                              {number(entry.nutrients.calories, 0)}
                            </Text>
                          </SystemButton>
                        </SwipeRow>
                      );
                    })}
                  </View>
                ))}
              </SystemPanel.Body>
            </SystemPanel>
          ) : (
            <Text className="px-1 text-sm text-muted">
              {live ? "Nothing logged yet." : "Nothing logged on this day."}
            </Text>
          )}
          {!!entries.length && (
            <Text className="px-1 text-xs text-muted">
              Fiber {totals.fiber === null ? "—" : `${number(totals.fiber, 0)} g`} · Sodium{" "}
              {totals.sodium === null ? "—" : `${number(totals.sodium, 0)} mg`}
            </Text>
          )}
        </View>
      </Screen>
      {logger && (
        <FastLogger
          initialDay={day}
          initialTime={logger.time}
          initialMeal={logger.meal ?? mealAtTime(currentFoodTime())}
          start={logger.start}
          photoLogging={photoLoggingOffered(ai)}
          close={() => setLogger(null)}
          onLogged={logged}
        />
      )}
      {photoLog && (
        <PhotoLogger
          initialDay={day}
          initialMeal={mealAtTime(currentFoodTime())}
          close={() => setPhotoLog(false)}
          onLogged={logged}
        />
      )}
      {editor && <FoodEditor entry={editor} close={() => setEditor(null)} onChanged={changed} />}
      {copying && <CopyDay destination={day} close={() => setCopying(false)} onLogged={logged} />}
      {moving && <MoveEntries entries={moving} close={() => setMoving(null)} onMoved={moved} />}
      {mealEditor && (
        <MealEditor
          source={mealEditor.source}
          initialDay={today}
          initialMeal={mealEditor.meal}
          close={() => setMealEditor(null)}
          onLogged={logged}
        />
      )}
      <HomeWeightSheet ref={weightSheet} />
    </>
  );
}
