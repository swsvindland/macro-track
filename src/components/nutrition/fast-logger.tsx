import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Pressable, ScrollView, View } from "react-native";
import { Editor } from "@/components/ui";
import {
  Button,
  Choices,
  ErrorText,
  Heading,
  Icon,
  IconButton,
  Label,
  Meta,
  Note,
  Panel,
  RowRule,
  SearchInput,
  Text,
  useKitFormat,
  type IconName,
} from "@/vector";
import { entriesForDay, targetsForDay, toggleFavorite } from "@/lib/diary";
import { currentFoodTime, formatClock, mealAtTime, validFoodTime } from "@/lib/food-time";
import { logBatch, loggingChoices, type LogChoice, type LogReceipt } from "@/lib/fast-log";
import { searchCatalog } from "@/lib/food-catalog";
import { matchesQuery, rankSearch, type Fixes } from "@/lib/food-rank";
import {
  countText,
  formatCount,
  meals,
  parseAmount,
  portionItem,
  portionOf,
  portionUnits,
  scaleItem,
  shiftDay,
  totalNutrients,
  type Food,
  type Meal,
  type MealItem,
  type PortionUnit,
} from "@/lib/nutrition";
import { localDay } from "@/lib/metrics";
import { useNutrition, useNutritionQuery } from "@/lib/nutrition-store";
import { useStore } from "@/lib/store";
import type { Message } from "@/lib/translations";
import { AmountPicker, DayRing, PortionPreview, type AmountDraft } from "./amount-picker";
import { FoodEditor } from "./food-editor";
import { PhotoLogger } from "./photo-logger";
import { QuickAdd } from "./quick-add";
import { TimeField } from "./time-field";

const isMeal = (choice: LogChoice) => choice.key.startsWith("meal:");
/** Tells apart catalog foods with the same name: "Chicken Breast · Tyson". */
const source = (food: Food) =>
  food.brand || (food.source === "usda" ? "USDA" : food.source === "off" ? "Open Food Facts" : "");
const mealUnits: PortionUnit[] = [{ key: "meal", label: "×", perUnit: 1, kind: "count" }];
const unitsFor = (choice: LogChoice) =>
  isMeal(choice) ? mealUnits : portionUnits(choice.items[0].food);
/** A saved meal starts at the multiple chosen for it, else 1×; a food at its unit and count. */
function startAmount(choice: LogChoice): AmountDraft {
  if (isMeal(choice))
    return {
      unit: "meal",
      text: formatCount(choice.multiple?.factor ?? 1, mealUnits[0]),
      fresh: true,
    };
  const item = choice.items[0];
  const { unit, count } = portionOf(item);
  return { unit, text: countText(item.food, unit, count), fresh: true };
}

type Translate = (key: Message, values?: Record<string, string | number>) => string;

/** A typed amount of one food, or a multiple of every food in a saved meal. */
function portioned(choice: LogChoice, amount: AmountDraft, t: Translate): LogChoice {
  const value = parseAmount(amount.text);
  if (isMeal(choice)) {
    if (!Number.isFinite(value) || value <= 0 || value > 100)
      throw new Error(t("enterValidQuantity"));
    // Scaled from the meal itself, so reopening a selected meal doesn't multiply it again.
    const items = choice.multiple?.items ?? choice.items;
    return {
      ...choice,
      detail: t("savedMealMultiple", { count: formatCount(value, mealUnits[0]) }),
      items: items.map((item) => scaleItem(item, value)),
      multiple: { items, factor: value },
    };
  }
  const item = portionItem(choice.items[0].food, amount.unit, value, {
    previous: choice.items[0],
  });
  return { ...choice, detail: item.portionLabel, items: [item] };
}
function tryPortioned(choice: LogChoice, amount: AmountDraft, t: Translate) {
  try {
    return portioned(choice, amount, t);
  } catch {
    return null;
  }
}
const calories = (items: MealItem[]) =>
  totalNutrients(items.map((item) => item.nutrients)).calories;
const actions: {
  key: "barcode" | "photo" | "quick" | "custom";
  icon: IconName;
  label: Message;
  spoken: Message;
}[] = [
  { key: "barcode", icon: "scan", label: "scan", spoken: "scanBarcode" },
  // The same analysis mark as on Home's quick-log bar.
  { key: "photo", icon: "analysis", label: "photo", spoken: "photoOrDescription" },
  { key: "quick", icon: "energy", label: "quickAdd", spoken: "quickAdd" },
  // Not a plus: as an icon it sits above the results' + buttons, which add a food.
  { key: "custom", icon: "edit", label: "newFood", spoken: "newFood" },
];

export function FastLogger({
  initialDay,
  initialTime,
  initialMeal,
  start = "search",
  photoLogging = false,
  close,
  onLogged,
}: {
  initialDay: string;
  initialTime?: string;
  initialMeal?: Meal;
  /**
   * "typing" focuses the search so the keyboard is up. "meals" is kept for older callers; saved
   * meals are now part of the search list.
   */
  start?: "search" | "typing" | "barcode" | "meals";
  /** Offers the on-device photo/description logger when this phone can run it. */
  photoLogging?: boolean;
  close: () => void;
  onLogged: (receipt: LogReceipt) => void;
}) {
  const { diaryLayout, t } = useStore();
  const format = useKitFormat();
  const { refresh, revision } = useNutrition();
  const [day, setDay] = useState(initialDay),
    [time, setTime] = useState(() => initialTime ?? currentFoodTime());
  const [meal, setMeal] = useState<Meal>(() => initialMeal ?? mealAtTime(time));
  const [when, setWhen] = useState(false);
  const [query, setQuery] = useState("");
  // Once the search is used, the shortcuts shrink to icons so results get the screen; they stay
  // that way when the keyboard hides, so the list doesn't jump under the finger.
  const [searched, setSearched] = useState(start === "typing");
  // From the search bar the keyboard is up on opening, not again each time the list comes back.
  const [typing, setTyping] = useState(start === "typing");
  const list = useRef<ScrollView>(null);
  const [results, setResults] = useState<{
    query: string;
    foods: Food[];
    fixes: Fixes;
    brand: string[];
    error: string;
  } | null>(null);
  const [cart, setCart] = useState<LogChoice[]>([]),
    [error, setError] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [editing, setEditing] = useState<LogChoice | null>(null),
    [amount, setAmount] = useState<AmountDraft>({ unit: "", text: "", fresh: true });
  const [picker, setPicker] = useState<"barcode" | "custom" | "quick" | "photo" | null>(
    start === "barcode" ? "barcode" : null
  );
  // Opened from Home's Scan button: cancelling the scan returns to Home, not the list.
  const [direct, setDirect] = useState(start === "barcode");
  const locked = useRef(false);
  // Set when a picked food joins the draft, so the picker's own close returns here.
  const keepOpen = useRef(false);
  // Clearing the search reflows the list under the finger; a quick second tap is ignored.
  const reflowed = useRef(false);
  // Ranking reads recent diary history, so it runs per write or time change, not per keystroke.
  const data = useMemo(() => {
    void revision;
    const today = localDay();
    return { ...loggingChoices(time), today, yesterday: shiftDay(today, -1) };
  }, [revision, time]);
  // The day's calories and targets, which the header ring and target rings add the selection to.
  const dayTotals = useNutritionQuery(
    () => ({
      eaten: calories(entriesForDay(day)),
      targets: targetsForDay(day),
    }),
    [day]
  );
  const trimmed = query.trim().toLowerCase();
  const known = data.known;
  // A new search starts at its first result, and clearing one brings the field back into view.
  useEffect(() => {
    list.current?.scrollTo({ y: 0, animated: false });
  }, [trimmed]);
  useEffect(() => {
    if (!trimmed) return;
    let active = true;
    const timer = setTimeout(() => {
      void searchCatalog(trimmed, known)
        .then(({ foods, fixes, brand }) => {
          if (active) setResults({ query: trimmed, foods, fixes, brand, error: "" });
        })
        .catch(() => {
          if (active)
            setResults({
              query: trimmed,
              foods: [],
              fixes: {},
              brand: [],
              error: t("catalogUnavailable"),
            });
        });
    }, 120);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [trimmed, known, t]);
  // Foods eaten beyond Log again's top ones are read only when a search names them, and catalog
  // results reuse the last portion of any the person has eaten.
  // Once the catalog answers, a typo it corrected ("chiken") finds the person's own foods too.
  const fixes = results?.query === trimmed ? results.fixes : undefined;
  const brand = results?.query === trimmed ? results.brand : undefined;
  const recalled = useMemo(
    () => (trimmed ? data.recall((food) => matchesQuery(trimmed, food, fixes)) : []),
    [data, trimmed, fixes]
  );
  const found = useMemo(() => (results ? data.choose(results.foods) : []), [data, results]);
  // The person's own foods come first, ranked like the catalog below them, so rows already on
  // screen don't move when the catalog answers.
  const pool = [...data.choices, ...recalled];
  const byKey = new Map(pool.map((choice) => [choice.key, choice]));
  const own = trimmed
    ? rankSearch(
        trimmed,
        pool
          .map((choice) => choice.items[0].food)
          .filter((food) => matchesQuery(trimmed, food, fixes)),
        known,
        { fixes, brand }
      ).map((food) => byKey.get(`food:${food.id}`)!)
    : [];
  const listed = new Set(own.map((choice) => choice.key));
  // Saved foods sit in their own row, so the list below them has room for other foods.
  const inRow = new Set(data.saved.map((choice) => choice.key));
  const choices: LogChoice[] = !trimmed
    ? [
        ...data.meals.slice(0, 2),
        ...data.choices.filter((choice) => !inRow.has(choice.key)).slice(0, 14),
      ]
    : [
        ...data.meals.filter((choice) =>
          matchesQuery(trimmed, { name: choice.title, brand: "" }, fixes)
        ),
        ...own,
        ...(results?.query === trimmed ? found : []).filter((choice) => !listed.has(choice.key)),
      ].slice(0, 40);
  const inCart = new Map(cart.map((choice) => [choice.key, choice]));
  const items = cart.flatMap((choice) => choice.items);
  /** Calories, then P · C · F, as the list rows show them. */
  const macros = (value: LogChoice["items"]) => {
    const sum = totalNutrients(value.map((item) => item.nutrients));
    return [
      t("kcalValue", { value: format.number(sum.calories) }),
      t("proteinShort", { value: format.number(sum.protein) }),
      t("carbsShort", { value: format.number(sum.carbs) }),
      t("fatShort", { value: format.number(sum.fat) }),
    ];
  };
  /** The same totals as VoiceOver reads them. */
  const spokenMacros = (value: LogChoice["items"]) => {
    const sum = totalNutrients(value.map((item) => item.nutrients));
    return t("spokenMacros", {
      kcal: format.number(sum.calories),
      protein: format.number(sum.protein),
      carbs: format.number(sum.carbs),
      fat: format.number(sum.fat),
    });
  };
  const counted = (n: number, one: Message, many: Message) =>
    t(format.plural(n) === "one" ? one : many, { count: format.number(n) });
  // Searching folds the day and time panel back into its label, so the list's top is the
  // field and the results, never the panel with the field under the keyboard.
  function openSearch() {
    setSearched(true);
    setTyping(false);
    if (!when) return;
    setWhen(false);
    list.current?.scrollTo({ y: 0, animated: false });
  }
  function clearQuery() {
    setQuery("");
    setResults(null);
    setWhen(false);
  }
  function add(choice: LogChoice) {
    setCart((previous) => [...previous.filter((row) => row.key !== choice.key), choice]);
    setError("");
  }
  function toggle(choice: LogChoice) {
    if (reflowed.current) return;
    setCart((previous) =>
      previous.some((row) => row.key === choice.key)
        ? previous.filter((row) => row.key !== choice.key)
        : [...previous, choice]
    );
    // Adding from search usually means the next food is a new search.
    if (!inCart.has(choice.key) && trimmed) {
      clearQuery();
      reflowed.current = true;
      setTimeout(() => {
        reflowed.current = false;
      }, 600);
    }
    setError("");
  }
  function edit(choice: LogChoice) {
    const current = inCart.get(choice.key) ?? choice;
    setEditing(current);
    setAmount(startAmount(current));
    setError("");
  }
  function back() {
    if (direct) close();
    else {
      setEditing(null);
      setError("");
    }
  }
  function cancel() {
    if (!cart.length) close();
    else
      Alert.alert(t("discardMealTitle"), t("discardMealMessage"), [
        { text: t("keepEditing"), style: "cancel" },
        { text: t("discard"), style: "destructive", onPress: close },
      ]);
  }
  /** Saves once; throws (with the lock released) only when nothing was written. */
  function commit(logged: MealItem[]) {
    if (locked.current) return;
    locked.current = true;
    let receipt: LogReceipt;
    try {
      receipt = logBatch(logged, { day, time, meal: diaryLayout === "meals" ? meal : undefined });
    } catch (e) {
      locked.current = false;
      throw e;
    }
    refresh();
    onLogged(receipt);
    close();
  }
  function attempt(action: () => void) {
    try {
      action();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("couldNotSaveMeal"));
    }
  }
  // One-step logging from Scan, New food and Quick add skips the list, where the
  // day is shown, so it is limited to today; other days collect into the draft.
  const oneStep = !cart.length && day === data.today;
  if (picker === "quick")
    return (
      <QuickAdd
        day={day}
        time={time}
        initialMeal={meal}
        close={() => setPicker(null)}
        onAdd={
          !oneStep
            ? (item) =>
                add({
                  key: `quick:${Date.now()}`,
                  title: item.food.name,
                  detail: t("estimated"),
                  items: [item],
                })
            : undefined
        }
        onLogged={
          !oneStep
            ? undefined
            : (receipt) => {
                onLogged(receipt);
                close();
              }
        }
      />
    );
  if (picker === "photo")
    return (
      <PhotoLogger
        initialDay={day}
        initialTime={time}
        initialMeal={meal}
        close={() => setPicker(null)}
        onLogged={
          oneStep
            ? (receipt) => {
                onLogged(receipt);
                close();
              }
            : undefined
        }
        onAdd={
          oneStep
            ? undefined
            : (found) => {
                const stamp = Date.now();
                found.forEach((item, i) =>
                  add({
                    key: `photo:${stamp}:${i}`,
                    title: item.food.name,
                    detail: item.portionLabel,
                    items: [item],
                  })
                );
              }
        }
      />
    );
  if (picker)
    return (
      <FoodEditor
        initialMode={picker}
        scanAnother={picker === "barcode"}
        pickerTitle={oneStep ? t("logFood") : t("addToMeal")}
        pickLabel={oneStep ? t("log") : undefined}
        close={() => {
          // After a direct log the logger is already closing.
          if (locked.current) return;
          if (direct && !keepOpen.current) close();
          else setPicker(null);
          keepOpen.current = false;
        }}
        onPick={(food, _, item, keepScanning) => {
          // With nothing else selected today, a scan or new food is logged in one step.
          if (oneStep && !keepScanning) commit([item]);
          else {
            keepOpen.current = true;
            setDirect(false);
            add({
              key: `food:${food.id}`,
              title: food.name,
              detail: item.portionLabel,
              items: [item],
            });
          }
        }}
      />
    );
  const dayLabel =
    day === data.today
      ? t("today")
      : day === data.yesterday
        ? t("yesterday")
        : new Date(`${day}T12:00:00`).toLocaleDateString(format.tag, {
            weekday: "short",
            month: "short",
            day: "numeric",
          });
  const whenValues = {
    day: dayLabel,
    time: validFoodTime(time) ? formatClock(time, format.tag) : time,
    meal,
  };
  const whenLabel = t(diaryLayout === "meals" ? "whenMeal" : "whenTime", whenValues);
  if (editing) {
    const preview = tryPortioned(editing, amount, t);
    const food = isMeal(editing) ? null : editing.items[0].food;
    const subtitle = isMeal(editing)
      ? format.list(editing.items.map((item) => item.food.name))
      : source(editing.items[0].food);
    const others = cart.filter((row) => row.key !== editing.key).flatMap((row) => row.items);
    const sum = preview ? totalNutrients(preview.items.map((item) => item.nutrients)) : null;
    const favorite = !!food && data.saved.some((choice) => choice.key === `food:${food.id}`);
    const addToMeal = () =>
      attempt(() => {
        add(portioned(editing, amount, t));
        setEditing(null);
        setDirect(false);
        if (trimmed) clearQuery();
      });
    // Logs everything selected, with this food at the amount on screen.
    const logNow = () =>
      attempt(() => {
        const next = portioned(editing, amount, t);
        commit(
          (cart.some((row) => row.key === next.key)
            ? cart.map((row) => (row.key === next.key ? next : row))
            : [...cart, next]
          ).flatMap((row) => row.items)
        );
      });
    return (
      <Editor
        title={direct ? t("logFood") : t("portion")}
        open
        close={back}
        // Cancel steps back to the list.
        guarded={!direct || cart.length > 0}
        compact
        footer={
          <View className="gap-2">
            <ErrorText message={error} />
            <AmountPicker
              units={unitsFor(editing)}
              // A saved meal's only unit is "×": "Amount in ×" doesn't read.
              label={isMeal(editing) ? t("mealQuantity") : undefined}
              value={amount}
              onChange={(next) => {
                setAmount(next);
                setError("");
              }}
              actions={[
                { label: t("log"), onPress: logNow },
                { label: t("add"), onPress: addToMeal },
              ]}
            />
          </View>
        }
      >
        <View className="flex-row items-center justify-between gap-2">
          <Note className="shrink">{whenLabel}</Note>
          <DayRing
            calories={dayTotals.eaten + calories(others) + (sum?.calories ?? 0)}
            target={dayTotals.targets?.calories ?? null}
          />
        </View>
        <View className="flex-row items-start gap-1">
          <View className="flex-1 gap-1">
            <Heading level={3}>{editing.title}</Heading>
            {!!subtitle && <Note>{subtitle}</Note>}
          </View>
          {food && (
            <IconButton
              icon="favorite"
              tone={favorite ? "tint" : "foreground"}
              accessibilityLabel={favorite ? t("removeFromSavedFoods") : t("saveFood")}
              accessibilityState={{ selected: favorite }}
              onPress={() =>
                attempt(() => {
                  toggleFavorite(food);
                  refresh();
                })
              }
            />
          )}
        </View>
        <PortionPreview nutrients={sum} targets={dayTotals.targets} />
      </Editor>
    );
  }
  const offered = actions.filter((action) => photoLogging || action.key !== "photo");
  const showSaved = !trimmed && !!data.saved.length;
  // While searching, the shortcuts sit as icons beside the first heading instead of above it.
  const heading = (label: string, tools: boolean) => (
    <View className="min-h-11 flex-row items-center gap-1">
      <Label accessibilityRole="header" className="flex-1">
        {label}
      </Label>
      {tools &&
        offered.map((action) => (
          <IconButton
            key={action.key}
            icon={action.icon}
            tone="tint"
            accessibilityLabel={t(action.spoken)}
            onPress={() => setPicker(action.key)}
          />
        ))}
    </View>
  );
  const itemSum = totalNutrients(items.map((item) => item.nutrients));
  return (
    <Editor
      title={t("logFood")}
      open
      close={cancel}
      // With foods selected, Cancel asks before discarding them.
      guarded={cart.length > 0}
      compact
      scrollRef={list}
      footer={
        items.length || error ? (
          <View className="gap-2">
            <ErrorText message={error} />
            {!!items.length && (
              <View className="flex-row items-center gap-3">
                <View className="flex-1">
                  <Meta
                    tone="default"
                    items={[
                      t("kcalValue", { value: format.number(itemSum.calories) }),
                      t("proteinGrams", { value: format.number(itemSum.protein) }),
                    ]}
                  />
                </View>
                <Button onPress={() => attempt(() => commit(items))}>
                  {counted(items.length, "logFoodsOne", "logFoods")}
                </Button>
              </View>
            )}
          </View>
        ) : undefined
      }
    >
      <View className="flex-row items-center justify-between gap-2">
        <Button
          variant="ghost"
          icon="time"
          className="shrink"
          accessibilityHint={t("changeMealTimeHint")}
          accessibilityState={{ expanded: when }}
          onPress={() => setWhen((open) => !open)}
        >
          {whenLabel}
        </Button>
        <DayRing
          calories={dayTotals.eaten + calories(items)}
          target={dayTotals.targets?.calories ?? null}
        />
      </View>
      {when && (
        <>
          <TimeField value={time} onChange={setTime} day={day} onDayChange={setDay} />
          {diaryLayout === "meals" && (
            <Choices
              values={meals}
              value={meal}
              onChange={setMeal}
              label={(value) => value}
              accessibilityLabel={t("meal")}
            />
          )}
        </>
      )}
      <SearchInput
        value={query}
        onChange={(next) => {
          setQuery(next);
          setResults(null);
          openSearch();
        }}
        placeholder={t("searchFoodsAndMeals")}
        accessibilityLabel={t("searchFoodsAndMeals")}
        autoFocus={typing}
        onFocus={openSearch}
      />
      {!searched && (
        <View className="flex-row flex-wrap gap-2">
          {offered.map((action) => (
            <Button
              key={action.key}
              variant="secondary"
              icon={action.icon}
              accessibilityLabel={t(action.spoken)}
              onPress={() => setPicker(action.key)}
            >
              {t(action.label)}
            </Button>
          ))}
        </View>
      )}
      {!!cart.length && !trimmed && (
        <View className="gap-1">
          <Button
            variant="ghost"
            className="self-start"
            accessibilityState={{ expanded: reviewing }}
            onPress={() => setReviewing((open) => !open)}
          >
            {t(reviewing ? "selectedHide" : "selectedReview", {
              count: format.number(items.length),
            })}
          </Button>
          {reviewing &&
            cart.map((choice) => (
              <View key={choice.key} className="flex-row items-center gap-2">
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("adjustNamed", { name: choice.title })}
                  onPress={() => edit(choice)}
                  className="min-h-11 flex-1 justify-center active:opacity-60"
                >
                  <Meta tone="default" items={[choice.title, choice.detail]} />
                </Pressable>
                <IconButton
                  icon="close"
                  accessibilityLabel={t("removeFromMeal", { name: choice.title })}
                  onPress={() => toggle(choice)}
                />
              </View>
            ))}
        </View>
      )}
      {showSaved && (
        <>
          {heading(t("savedFoods"), searched)}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            contentContainerClassName="gap-2"
          >
            {data.saved.map((choice) => {
              const selected = inCart.get(choice.key);
              const { calories } = totalNutrients(
                (selected ?? choice).items.map((item) => item.nutrients)
              );
              const kcal = t("kcalValue", { value: format.number(calories) });
              return (
                <Pressable
                  key={choice.key}
                  accessibilityRole="button"
                  accessibilityLabel={t(selected ? "removeNamed" : "addNamed", {
                    name: choice.title,
                  })}
                  accessibilityValue={{ text: kcal }}
                  accessibilityHint={t("longPressToAdjust")}
                  accessibilityState={{ selected: !!selected }}
                  onPress={() => toggle(choice)}
                  onLongPress={() => edit(choice)}
                  // A picked food takes the picker-list wash; the glyph says it too.
                  className={`min-w-36 max-w-44 gap-1 rounded-control border px-3 py-2.5 ${selected ? "border-tint bg-accent-soft" : "border-border-strong bg-surface active:bg-surface-secondary"}`}
                >
                  <View className="flex-row items-center gap-1">
                    <Text variant="readoutXS" tone="muted" className="flex-1">
                      {kcal}
                    </Text>
                    <Icon name={selected ? "done" : "add"} tone="tint" />
                  </View>
                  <Text variant="h4">{choice.title}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </>
      )}
      {heading(
        trimmed
          ? results?.query === trimmed
            ? counted(choices.length, "matchCountOne", "matchCount")
            : t("searching")
          : t("logAgain"),
        searched && !showSaved
      )}
      {!!choices.length && (
        <Panel inset="none">
          {choices.map((choice) => {
            const selected = inCart.get(choice.key);
            const shown = selected ?? choice;
            const saved = isMeal(choice);
            // Search results name their catalog too; familiar foods only need a brand.
            const food = choice.items[0].food;
            const brand = saved ? "" : trimmed ? source(food) : food.brand;
            const about = [
              brand,
              saved && !selected
                ? counted(shown.items.length, "foodCountOne", "foodCount")
                : shown.detail,
            ].filter(Boolean);
            // The labels name the food; the values carry what tells same-named foods apart.
            return (
              <View key={choice.key}>
                <RowRule />
                <View
                  className={`flex-row items-center gap-2 pe-2 ${selected ? "bg-accent-soft" : ""}`}
                >
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t("adjustNamed", { name: choice.title })}
                    accessibilityValue={{
                      text: format.list([...about, spokenMacros(shown.items)]),
                    }}
                    onPress={() => edit(choice)}
                    className="min-h-14 flex-1 gap-0.5 py-3 ps-4 active:opacity-60"
                  >
                    <View className="flex-row flex-wrap items-center gap-x-2">
                      <Text variant="bodyStrong" className="shrink">
                        {choice.title}
                      </Text>
                      {saved && <Label>{t("mealTag")}</Label>}
                    </View>
                    <Meta items={[...macros(shown.items), ...about]} />
                  </Pressable>
                  <IconButton
                    variant="secondary"
                    icon={selected ? "check" : "add"}
                    tone="tint"
                    accessibilityLabel={t(selected ? "removeNamed" : "addNamed", {
                      name: choice.title,
                    })}
                    accessibilityValue={brand ? { text: brand } : undefined}
                    accessibilityState={{ selected: !!selected }}
                    onPress={() => toggle(choice)}
                  />
                </View>
              </View>
            );
          })}
        </Panel>
      )}
      {!choices.length && (!trimmed || results?.query === trimmed) && (
        <Note>{trimmed ? t("noMatches") : t("searchForFood")}</Note>
      )}
      {results?.query === trimmed && <ErrorText message={results.error} />}
    </Editor>
  );
}
