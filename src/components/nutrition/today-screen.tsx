import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { AccessibilityInfo, AppState, Pressable, View, type ScrollView } from "react-native";
import { router, useIsFocused } from "expo-router";
import { PaceBar } from "@/components/system";
import {
  ActionMenu,
  Button,
  Callout,
  ErrorText,
  Icon,
  IconButton,
  Label,
  LinkButton,
  Meta,
  Meter,
  Note,
  Panel,
  RecordRow,
  RowRule,
  Screen,
  ScreenFooter,
  Status,
  SwipeRow,
  SystemState,
  Text,
  Value,
  useKitFormat,
  useKitStrings,
  useUndo,
  type IconName,
  type MenuAction,
} from "@/vector";
import {
  HomeSheets,
  pendingAppAction,
  subscribeAppActions,
  takeAppAction,
} from "@/lib/app-actions";
import {
  copyEntries,
  countableDay,
  countLoggedDay,
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
import { modelStatus, prewarmModel, type ModelStatus } from "@/lib/local-ai";
import { localDay } from "@/lib/metrics";
import {
  meals,
  projectDay,
  roughly,
  shiftDay,
  totalNutrients,
  type DayState,
  type Meal,
  type Nutrients,
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
import type { Message } from "@/lib/translations";
import { undoWeight, weighInDue } from "@/lib/weigh-in";
import type { FoodEntry } from "@/db";
import { useMeasurementLog } from "@/components/measurements/use-measurement-log";
import { WeightForm } from "@/components/measurements/weight-form";
import { FoodEditor } from "./food-editor";
import { FastLogger } from "./fast-logger";
import { HomeCheckIn } from "./home-check-in";
import { MealEditor } from "./meal-editor";
import { DayNutrients } from "./nutrient-list";
import { PhotoLogger, photoLoggingOffered } from "./photo-logger";
import { QuickLogBar } from "./quick-log-bar";
import { CopyDay, MoveEntries } from "./copy-day";
import { WeighInCard } from "./weigh-in-card";
import { WeekStrip } from "./week-strip";

const statusLabels: Record<DayState, Message> = {
  "in-progress": "inProgress",
  complete: "statusComplete",
  partial: "statusPartial",
  fasting: "statusFasting",
};
// What marking a day says, per state, so no status word is lowercased into a sentence.
const markedMessages: Record<DayState, Message> = {
  "in-progress": "dayMarkedInProgress",
  complete: "dayMarkedComplete",
  partial: "dayMarkedPartial",
  fasting: "dayMarkedFasting",
};
type WeightSheet = { open: () => void; close: () => void };
type SelectionKey = "move" | "copy" | "meal" | "delete";
const selectionActions: {
  key: SelectionKey;
  label: Message;
  icon: IconName;
  destructive?: boolean;
}[] = [
  { key: "move", label: "moveTo", icon: "move" },
  { key: "copy", label: "copyToToday", icon: "copy" },
  { key: "meal", label: "saveAsMeal", icon: "bookmark" },
  { key: "delete", label: "delete", icon: "delete", destructive: true },
];
const macroKeys = ["protein", "carbs", "fat"] as const;
const macroLabels = { protein: "macroProtein", carbs: "macroCarbs", fat: "macroFat" } as const;

/**
 * A short hold after a tap: `take()` answers false while held, else starts the hold. Kept behind
 * a hook so menu actions built during render can check it without touching a ref there.
 */
function useHold(ms: number) {
  const until = useRef(0);
  return useMemo(
    () => ({
      take() {
        const now = Date.now();
        if (now < until.current) return false;
        until.current = now + ms;
        return true;
      },
      held: () => Date.now() < until.current,
    }),
    [ms]
  );
}

/** The Log weight sheet keeps its own state, so typing a weight doesn't re-render Home. */
function HomeWeightSheet({ ref }: { ref: Ref<WeightSheet> }) {
  const weight = useMeasurementLog("weight");
  useImperativeHandle(ref, () => ({
    open: () => weight.launch(null),
    close: () => weight.setOpen(false),
  }));
  return <WeightForm log={weight} />;
}

/** Home: how today is going, one-tap repeats and the day's food, in that order. */
export function TodayScreen() {
  const store = useStore();
  const { diaryLayout, hideEmptyHours, countLoggedDays, t } = store;
  const format = useKitFormat();
  const strings = useKitStrings();
  const locale = format.tag;
  const { refresh } = useNutrition();
  const undo = useUndo();
  // The mount effect below outlives renders; it reaches the latest Undo through this.
  const undoRef = useRef(undo);
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
    start?: "typing" | "barcode";
  } | null>(null);
  const [copying, setCopying] = useState(false);
  const [nutrientsOpen, setNutrientsOpen] = useState(false);
  const [photoLog, setPhotoLog] = useState(false);
  // On-device AI availability decides whether Home offers photo logging at all.
  const [ai, setAi] = useState<ModelStatus | null>(null);
  const [error, setError] = useState("");
  // A confirmation with nothing to undo, shown where the check-in or weigh-in was.
  const [notice, setNotice] = useState("");
  // Each log runs the signal pulse on the day's hero readout.
  const [pulse, setPulse] = useState(0);
  const [mealEditor, setMealEditor] = useState<{
    source: { day: string; meal: Meal; group?: string; ids?: number[] };
    meal: Meal;
  } | null>(null);
  // Entries chosen with a long press; null outside selection mode.
  const [selected, setSelected] = useState<number[] | null>(null);
  const [moving, setMoving] = useState<FoodEntry[] | null>(null);
  // One-tap answers: a double tap must not land on whatever moved into place.
  const tapHold = useHold(900);
  // The quick-log bar comes back where the selection bar was, under a finger that may tap again.
  const dockHold = useHold(600);
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
      undoRef.current.dismiss();
      setNotice("");
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
        undoRef.current.dismiss();
        setNotice("");
      }
    });
    // Links from Shortcuts or the Action Button (app-actions.ts), on a cold start or while
    // open: sheets can't stack, so Home's close first (other tabs' close themselves), and the
    // action starts on today.
    let opening: ReturnType<typeof setTimeout> | undefined;
    function act() {
      if (!pendingAppAction()) return;
      tick();
      setEditor(null);
      setMealEditor(null);
      setCopying(false);
      setMoving(null);
      setLogger(null);
      setPhotoLog(false);
      weightSheet.current?.close();
      setDay(localDay());
      setSelected(null);
      undoRef.current.dismiss();
      setNotice("");
      setError("");
      scrollRef.current?.scrollTo({ y: 0, animated: false });
      clearTimeout(opening);
      // Taken only once the sheets are gone, so a remount before then still finds it.
      opening = setTimeout(() => {
        const action = takeAppAction();
        if (action === "log") setLogger({});
        else if (action === "search") setLogger({ start: "typing" });
        else if (action === "scan") setLogger({ start: "barcode" });
        else if (action === "weigh-in") weightSheet.current?.open();
        else if (action === "photo")
          void modelStatus().then((status) => {
            setAi(status);
            if (photoLoggingOffered(status)) setPhotoLog(true);
            else setLogger({});
          });
      }, 0);
    }
    act();
    const unsubscribe = subscribeAppActions(act);
    return () => {
      clearTimeout(warm);
      clearTimeout(timer);
      clearTimeout(opening);
      sub.remove();
      unsubscribe();
    };
  }, []);
  useEffect(() => {
    undoRef.current = undo;
  }, [undo]);
  // The model loads before Photo is tapped; it is released after a while, so coming back
  // to the app loads it again, at most every 10 minutes.
  const warmedAt = useRef(0);
  useEffect(() => {
    if (ai?.state !== "available" || Date.now() - warmedAt.current < 10 * 60000) return;
    warmedAt.current = Date.now();
    prewarmModel();
  }, [ai]);
  // An error sits at the top of the list, so it scrolls into view from anywhere below.
  useEffect(() => {
    if (error) scrollRef.current?.scrollTo({ y: 0, animated: true });
  }, [error]);
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
  // A yesterday logged in full counts as complete without asking (below); the card
  // only asks about days that look short. Only on screen, so its Undo is seen.
  const focused = useIsFocused();
  const countable = useNutritionQuery(
    () =>
      focused && askConfirm && countLoggedDays && confirm?.day === shiftDay(day, -1)
        ? countableDay()
        : null,
    [focused, confirm, day, askConfirm, countLoggedDays]
  );
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
  )
    .filter((group) => group.entries.length || !hideEmptyHours)
    .map((group) => ({
      ...group,
      sum: totalNutrients(group.entries.map((entry) => entry.nutrients)),
    }));
  // Calories, then P · C · F as the list shows them, and the same spelled out for screen readers.
  const macros = (value: Nutrients) => [
    t("kcalValue", { value: format.number(value.calories) }),
    t("proteinShort", { value: format.number(value.protein) }),
    t("carbsShort", { value: format.number(value.carbs) }),
    t("fatShort", { value: format.number(value.fat) }),
  ];
  const spoken = (value: Nutrients) =>
    t("spokenMacros", {
      kcal: format.number(value.calories),
      protein: format.number(value.protein),
      carbs: format.number(value.carbs),
      fat: format.number(value.fat),
    });
  // The swipe actions, for screen readers.
  const rowActions = [
    { name: "delete", label: t("delete") },
    { name: "again", label: t("logAgainNow") },
    { name: "select", label: t("select") },
  ];
  const named = (rows: FoodEntry[]) =>
    rows.length === 1 ? rows[0].food.name : t("foodCount", { count: format.number(rows.length) });
  /** Opens the logger on a group: an hour at its latest food (or o'clock), a meal now. */
  function addTo(group: (typeof groups)[number]) {
    const hour = !!group.group && group.group !== "untimed";
    setLogger({
      meal: group.meal,
      time: hour ? (group.entries.at(-1)?.loggedTime ?? group.time) : currentFoodTime(),
    });
  }

  function label(value: string) {
    if (value === today) return t("today");
    if (value === shiftDay(today, -1)) return t("yesterday");
    return new Date(`${value}T12:00:00`).toLocaleDateString(locale, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  }
  function go(value: string) {
    setDay(value);
    undo.dismiss();
    setNotice("");
    setError("");
    setSelected(null);
  }
  /**
   * Undo for a write, in the dock; what Undo did is spoken, since the list itself shows it. Said
   * here, only once the revert holds: the kit's `undoneMessage` is spoken even when it fails.
   */
  function offerUndo(message: string, undoneMessage: string, revert: () => void) {
    setNotice("");
    setError("");
    undo.show({
      message,
      onUndo: () => {
        try {
          revert();
          AccessibilityInfo.announceForAccessibility(undoneMessage);
        } catch (e) {
          fail(e, t("couldNotUndo"));
        }
      },
    });
  }
  /** A confirmation with nothing to undo: said in place, and the last Undo becomes final. */
  function confirmed(message: string) {
    undo.dismiss();
    setError("");
    setNotice(message);
  }
  function fail(e: unknown, fallback: string) {
    setError(e instanceof Error ? e.message : fallback);
  }
  function undoable(receipt: DiaryReceipt, message: string, undoneMessage: string) {
    offerUndo(message, undoneMessage, () => {
      undoReceipt(receipt);
      refresh();
    });
  }
  function logged(receipt: DiaryReceipt) {
    const rows = receipt.inserted;
    if (!rows.length) return;
    setDay(rows[0].day);
    setPulse((n) => n + 1);
    const kcal = totalNutrients(rows.map((entry) => entry.nutrients)).calories;
    const left = rows[0].day === day && targets ? targets.calories - totals.calories - kcal : null;
    const values = {
      what: named(rows),
      kcal: format.number(kcal),
      rest: left === null ? "" : format.number(Math.abs(left)),
    };
    undoable(
      receipt,
      t(left === null ? "loggedKcal" : left >= 0 ? "loggedKcalLeft" : "loggedKcalOver", values),
      t("logUndone")
    );
  }
  function removed(receipt: DiaryReceipt) {
    const what = named(receipt.deleted);
    undoable(receipt, t("foodDeleted", { what }), t("foodRestored", { what }));
  }
  function moved(receipt: DiaryReceipt) {
    setSelected(null);
    const rows = receipt.moved.map((row) => row.after);
    const time = rows.every((row) => row.loggedTime === rows[0].loggedTime) && rows[0].loggedTime;
    const what = named(rows),
      when = label(rows[0].day);
    undoable(
      receipt,
      time
        ? t("movedToAt", { what, day: when, time: formatClock(time, locale) })
        : t("movedTo", { what, day: when }),
      t("moveUndone")
    );
  }
  function changed(receipt: DiaryReceipt, change: "saved" | "deleted") {
    if (change === "deleted") removed(receipt);
    else if (receipt.moved.length)
      undoable(
        receipt,
        t("foodUpdated", { name: receipt.moved[0].after.food.name }),
        t("changeUndone")
      );
    else logged(receipt);
  }
  function remove(rows: FoodEntry[]) {
    try {
      const receipt = deleteEntries(rows.map((row) => row.id));
      refresh();
      setSelected(null);
      removed(receipt);
    } catch (e) {
      fail(e, t("couldNotDeleteFood"));
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
      fail(e, t("couldNotLogAgain"));
    }
  }
  /** Selection mode: choosing foods is a new action, which makes the last one final. */
  function startSelecting(ids: number[]) {
    undo.dismiss();
    setSelected(ids);
  }
  function toggle(id: number) {
    setSelected(
      (ids) => ids && (ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id])
    );
  }
  const locked = () => !tapHold.take();
  function mark(target: string, value: DayState) {
    const before = dayStatus(target);
    try {
      setDayStatus(target, value);
      refresh();
      const message = t(markedMessages[value], { day: label(target) });
      if (before === value) confirmed(message);
      else
        offerUndo(message, t("changeUndone"), () => {
          setDayStatus(target, before);
          refresh();
        });
    } catch (e) {
      fail(e, t("couldNotUpdateDay"));
    }
  }
  function answer(target: string, value: "complete" | "partial") {
    if (!locked()) mark(target, value);
  }
  // Written just after the first paint, like the catalog warm-up; the card stays hidden
  // meanwhile, so it never flashes.
  useEffect(() => {
    if (!countable) return;
    const timer = setTimeout(() => {
      try {
        const receipt = countLoggedDay();
        refresh();
        if (receipt)
          undoRef.current.show({
            message: t("yesterdayCounted"),
            onUndo: () => {
              try {
                undoReceipt(receipt);
                refresh();
                AccessibilityInfo.announceForAccessibility(t("changeUndone"));
              } catch (e) {
                setError(e instanceof Error ? e.message : t("couldNotUndo"));
              }
            },
          });
      } catch (e) {
        setError(e instanceof Error ? e.message : t("couldNotUpdateYesterday"));
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [countable, refresh, t]);

  const over = projection.status === "over";
  const hero = over
    ? { label: t("heroOver"), value: projection.over }
    : projection.status === "no-target"
      ? { label: t("heroEaten"), value: projection.eaten }
      : { label: t("heroRemaining"), value: projection.left };
  const pace =
    projection.status === "heading-over"
      ? {
          tone: "warning" as const,
          text: t("paceHeadingOver", {
            value: format.number(roughly(projection.projected - projection.target)),
          }),
        }
      : projection.status === "on-pace"
        ? projection.projected > projection.target
          ? { tone: "default" as const, text: t("paceAtTarget") }
          : {
              tone: "success" as const,
              text: t("paceOnPace", { value: format.number(roughly(projection.projected)) }),
            }
        : null;
  const eatenOfTarget =
    targets &&
    t("kcalOfTarget", {
      eaten: format.number(totals.calories),
      target: format.number(targets.calories),
    });

  // The week strip moves between days; the rest of the day's controls live here.
  const dayActions: MenuAction[] = [
    ...(live
      ? []
      : [
          { key: "today", label: t("goToToday"), icon: "today" as const, onPress: () => go(today) },
        ]),
    {
      key: "weight",
      label: t("logWeight"),
      icon: "scale",
      onPress: () => weightSheet.current?.open(),
    },
    {
      key: "copy",
      label: live ? t("copyDayIntoToday") : t("copyDayInto", { day: label(day) }),
      icon: "copy",
      onPress: () => setCopying(true),
    },
  ];
  const dayMenu = (
    <ActionMenu
      accessibilityLabel={t("dayOptions")}
      sections={[
        { actions: dayActions },
        {
          title: t("markDayAs"),
          actions: (["in-progress", "complete", "partial", "fasting"] as const).map((value) => ({
            key: value,
            label: t(statusLabels[value]),
            selected: status === value,
            disabled:
              status === value ||
              (value === "fasting" ? !!entries.length : value !== "in-progress" && !entries.length),
            onPress: () => mark(day, value),
          })),
        },
      ]}
    />
  );

  const chosen = entries.filter((entry) => selected?.includes(entry.id));
  function selectionAction(key: SelectionKey) {
    if (key === "move") return setMoving(chosen);
    if (key === "meal") {
      setMealEditor({
        source: { day, meal: chosen[0].meal, ids: chosen.map((entry) => entry.id) },
        meal: chosen[0].meal,
      });
      return setSelected(null);
    }
    // The bar gives way to the quick-log bar, so a double tap must not repeat the action or
    // open a logger.
    if (locked()) return;
    dockHold.take();
    if (key === "copy") again(chosen);
    else remove(chosen);
  }
  // Docked above the tab bar, so logging and Undo stay in reach wherever the list is scrolled.
  const footer = selected ? (
    <ScreenFooter>
      <View className="flex-1 gap-1">
        <View className="flex-row items-center gap-3">
          <Text variant="bodyStrong" className="flex-1" accessibilityLiveRegion="polite">
            {t("selectedCount", { count: format.number(chosen.length) })}
          </Text>
          <LinkButton onPress={() => setSelected(null)}>{strings.cancel}</LinkButton>
        </View>
        <View className="flex-row">
          {selectionActions.map((action) => (
            <Pressable
              key={action.key}
              accessibilityRole="button"
              accessibilityLabel={t(action.label)}
              accessibilityState={{ disabled: !chosen.length }}
              disabled={!chosen.length}
              onPress={() => selectionAction(action.key)}
              className={`min-h-11 flex-1 items-center gap-1 rounded-control px-1 py-2 active:bg-surface-secondary ${chosen.length ? "" : "opacity-disabled"}`}
            >
              <Icon name={action.icon} tone={action.destructive ? "danger" : "tint"} />
              {/* A long translation wraps under its glyph; the dock grows to fit it. */}
              <Text
                variant="caption"
                tone={action.destructive ? "danger" : "tint"}
                className="text-center"
              >
                {t(action.label)}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
    </ScreenFooter>
  ) : (
    <QuickLogBar
      label={live ? undefined : t("logToDay", { day: label(day) })}
      ai={ai}
      onAction={(action) => {
        if (dockHold.held()) return;
        if (action === "photo") setPhotoLog(true);
        else setLogger({ start: action === "scan" ? "barcode" : "typing" });
      }}
    />
  );

  return (
    <HomeSheets value>
      <Screen
        title={t("today")}
        compact
        scrollRef={scrollRef}
        header={<WeekStrip day={day} today={today} onChange={go} />}
        footer={footer}
      >
        <ErrorText message={error} />
        <Panel>
          <Panel.Body>
            <View className="flex-row items-start gap-3">
              <View className="flex-1 gap-1">
                <Label tone={over ? "warning" : "muted"}>{hero.label}</Label>
                <Value
                  size="xl"
                  value={format.number(hero.value)}
                  unit={t("kcal")}
                  tone={over ? "warning" : "default"}
                  pulseKey={pulse}
                />
              </View>
              {dayMenu}
            </View>
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
                  description={pace?.text ?? eatenOfTarget ?? ""}
                />
                {pace ? (
                  <Note tone={pace.tone}>{pace.text}</Note>
                ) : (
                  <Note tone={over ? "warning" : "muted"}>{eatenOfTarget}</Note>
                )}
              </>
            ) : (
              live && (
                <Button
                  variant="secondary"
                  icon="flag"
                  className="self-start"
                  onPress={() => router.push("/(tabs)/plan")}
                >
                  {t("setTargets")}
                </Button>
              )
            )}
            <View className="flex-row gap-4 pt-1">
              {macroKeys.map((key) => (
                <View key={key} className="flex-1 gap-1">
                  {/* A column header that wraps rather than clips: "Kohlenhydrate" is a long word. */}
                  <Text variant="label" tone="muted">
                    {t(macroLabels[key])}
                  </Text>
                  <Value
                    value={format.number(totals[key])}
                    unit={
                      targets
                        ? t("ofTargetGrams", { target: format.number(targets[key]) })
                        : t("grams")
                    }
                  />
                  {targets && targets[key] > 0 && (
                    <Meter
                      size="sm"
                      value={totals[key]}
                      max={targets[key]}
                      accessibilityLabel={t(macroLabels[key])}
                      valueText={t("gramsOfTarget", {
                        value: format.number(totals[key]),
                        target: format.number(targets[key]),
                      })}
                    />
                  )}
                </View>
              ))}
            </View>
          </Panel.Body>
        </Panel>

        {!live && (
          <View className="flex-row flex-wrap items-center gap-2">
            <Note className="flex-1">
              {status === "complete"
                ? t("markedComplete")
                : status === "in-progress"
                  ? entries.length
                    ? t("wasDayFullyLogged")
                    : t("nothingLoggedOnDay")
                  : t(statusLabels[status])}
            </Note>
            {status !== "complete" && !!entries.length && (
              <Button variant="secondary" onPress={() => mark(day, "complete")}>
                {t("markComplete")}
              </Button>
            )}
            {status === "in-progress" && !!entries.length && (
              <Button variant="secondary" onPress={() => mark(day, "partial")}>
                {t("notAll")}
              </Button>
            )}
          </View>
        )}

        {!!notice && <Callout tone="success">{notice}</Callout>}

        {live &&
          (weighIn ? (
            <WeighInCard
              today={today}
              onSaved={(entry, message) =>
                offerUndo(message, t("weightRemoved"), () => {
                  undoWeight(entry);
                  store.refresh();
                  refresh();
                })
              }
            />
          ) : confirm ? (
            askConfirm &&
            !countable && (
              <Panel>
                <Panel.Header eyebrow={t("finishDay", { day: label(confirm.day) })} />
                <Panel.Body>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t("reviewDayLogged", {
                      day: label(confirm.day),
                      kcal: format.number(confirm.calories),
                    })}
                    onPress={() => go(confirm.day)}
                    className="min-h-11 flex-row items-center gap-3 active:opacity-60"
                  >
                    <Text variant="bodyStrong" className="flex-1">
                      {t("kcalLoggedQuestion", { kcal: format.number(confirm.calories) })}
                    </Text>
                    <Icon name="forward" size={17} tone="muted" />
                  </Pressable>
                  <View className="flex-row gap-2">
                    <Button
                      variant="secondary"
                      className="flex-1"
                      onPress={() => answer(confirm.day, "complete")}
                    >
                      {t("yesComplete")}
                    </Button>
                    <Button
                      variant="secondary"
                      className="flex-1"
                      onPress={() => answer(confirm.day, "partial")}
                    >
                      {t("notAll")}
                    </Button>
                  </View>
                </Panel.Body>
              </Panel>
            )
          ) : (
            <HomeCheckIn
              onDone={confirmed}
              onWeighIn={() => weightSheet.current?.open()}
              onReviewLogs={go}
            />
          ))}

        <View className="gap-2">
          <View className="flex-row items-center justify-between gap-2">
            <Label accessibilityRole="header">{live ? t("todaysFood") : t("food")}</Label>
            {status === "complete" && <Status state="ok" label={t("dayComplete")} />}
          </View>
          {entries.length || !hideEmptyHours ? (
            <Panel inset="none">
              {/* Group headers and foods are rows of one panel, so each rules like a list row. */}
              {groups.flatMap((group) => [
                <View key={`group:${group.key}`}>
                  <RowRule />
                  <View className="min-h-11 flex-row items-center gap-1 ps-4 pe-1">
                    <View
                      accessible
                      accessibilityRole="header"
                      accessibilityLabel={
                        group.entries.length
                          ? t("groupSpoken", { group: group.title, macros: spoken(group.sum) })
                          : group.title
                      }
                      className="flex-1 gap-0.5 py-2"
                    >
                      <Text variant="h4">{group.title}</Text>
                      {!!group.entries.length && <Meta items={macros(group.sum)} />}
                    </View>
                    {!!group.entries.length && (
                      <ActionMenu
                        accessibilityLabel={t("optionsFor", { group: group.title })}
                        sections={[
                          {
                            actions: [
                              {
                                key: "save",
                                label: t("saveOrCopyMeal"),
                                icon: "bookmark",
                                onPress: () =>
                                  setMealEditor({
                                    source: { day, meal: group.meal, group: group.group },
                                    meal: group.meal,
                                  }),
                              },
                              {
                                key: "move",
                                label: t("moveAllTo"),
                                icon: "move",
                                onPress: () => setMoving(group.entries),
                              },
                              {
                                key: "select",
                                label: t("selectTheseFoods"),
                                icon: "check",
                                onPress: () =>
                                  startSelecting(group.entries.map((entry) => entry.id)),
                              },
                            ],
                          },
                        ]}
                      />
                    )}
                    <IconButton
                      icon="add"
                      tone="tint"
                      accessibilityLabel={
                        group.group && group.group !== "untimed"
                          ? t("logFoodAt", { time: group.title })
                          : t("logFoodTo", { meal: group.meal })
                      }
                      onPress={() => addTo(group)}
                    />
                  </View>
                </View>,
                ...group.entries.map((entry) => {
                  const picked = !!selected?.includes(entry.id);
                  return (
                    <SwipeRow
                      key={`entry:${entry.id}`}
                      enabled={!selected}
                      trailingAction={{
                        label: t("delete"),
                        icon: "delete",
                        destructive: true,
                        onAction: () => remove([entry]),
                      }}
                      leadingAction={{
                        label: t("logAgain"),
                        icon: "repeat",
                        onAction: () => again([entry]),
                      }}
                    >
                      {/* A long press starts choosing several foods; the mark shows which. */}
                      <RecordRow
                        time={entry.loggedTime ? formatClock(entry.loggedTime, locale) : ""}
                        title={entry.food.name}
                        description={
                          <Meta items={[entry.portionLabel, ...macros(entry.nutrients).slice(1)]} />
                        }
                        value={
                          <Value value={format.number(entry.nutrients.calories)} unit={t("kcal")} />
                        }
                        leading={
                          selected ? (
                            <Icon
                              name={picked ? "done" : "unselected"}
                              tone={picked ? "tint" : "muted"}
                            />
                          ) : undefined
                        }
                        accessibilityLabel={
                          selected ? entry.food.name : t("editFoodNamed", { name: entry.food.name })
                        }
                        accessibilityState={selected ? { selected: picked } : undefined}
                        accessibilityActions={selected ? undefined : rowActions}
                        onAccessibilityAction={({ nativeEvent }) =>
                          nativeEvent.actionName === "delete"
                            ? remove([entry])
                            : nativeEvent.actionName === "again"
                              ? again([entry])
                              : startSelecting([entry.id])
                        }
                        onPress={() => (selected ? toggle(entry.id) : setEditor(entry))}
                        onLongPress={() =>
                          selected ? toggle(entry.id) : startSelecting([entry.id])
                        }
                      />
                    </SwipeRow>
                  );
                }),
              ])}
            </Panel>
          ) : (
            <SystemState
              kind="empty"
              message={live ? t("nothingLoggedYet") : t("nothingLoggedOnDay")}
            />
          )}
          {!!entries.length && (
            <View className="gap-1">
              <Meta
                items={[
                  totals.fiber === null
                    ? t("fiberUnknown")
                    : t("fiberGrams", { value: format.number(totals.fiber) }),
                  totals.sodium === null
                    ? t("sodiumUnknown")
                    : t("sodiumMilligrams", { value: format.number(totals.sodium) }),
                ]}
              />
              <LinkButton
                icon="forward"
                accessibilityHint={t("allNutrientsHint")}
                onPress={() => setNutrientsOpen(true)}
              >
                {t("allNutrients")}
              </LinkButton>
            </View>
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
      {nutrientsOpen && (
        <DayNutrients
          title={day === today ? t("todaysNutrients") : t("nutrientsOn", { date: store.date(day) })}
          items={entries.map((entry) => entry.nutrients)}
          open
          close={() => setNutrientsOpen(false)}
        />
      )}
    </HomeSheets>
  );
}
