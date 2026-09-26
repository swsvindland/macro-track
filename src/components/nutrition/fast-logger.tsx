import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, ScrollView, View } from "react-native";
import {
  SystemButton,
  SystemIcon,
  SystemIconButton,
  SystemLabel,
  SystemText as Text,
  type IconName,
} from "@/components/system";
import { Choices, Editor, ErrorText, SearchInput } from "@/components/ui";
import { entriesForDay, targetsForDay, toggleFavorite } from "@/lib/diary";
import { currentFoodTime, formatClock, mealAtTime, validFoodTime } from "@/lib/food-time";
import { logBatch, loggingChoices, type LogChoice, type LogReceipt } from "@/lib/fast-log";
import { searchCatalog } from "@/lib/food-catalog";
import { foodIcon, mealIcon } from "@/lib/food-icons";
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
import { AiMark } from "./ai-mark";
import { AmountPicker, DayRing, PortionPreview, type AmountDraft } from "./amount-picker";
import { FoodEditor } from "./food-editor";
import { FoodIcon } from "./food-icon";
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

/** A typed amount of one food, or a multiple of every food in a saved meal. */
function portioned(choice: LogChoice, amount: AmountDraft): LogChoice {
  const value = parseAmount(amount.text);
  if (isMeal(choice)) {
    if (!Number.isFinite(value) || value <= 0 || value > 100)
      throw new Error("Enter a valid quantity.");
    // Scaled from the meal itself, so reopening a selected meal doesn't multiply it again.
    const items = choice.multiple?.items ?? choice.items;
    return {
      ...choice,
      detail: `${formatCount(value, mealUnits[0])} × saved meal`,
      items: items.map((item) => scaleItem(item, value)),
      multiple: { items, factor: value },
    };
  }
  const item = portionItem(choice.items[0].food, amount.unit, value, {
    previous: choice.items[0],
  });
  return { ...choice, detail: item.portionLabel, items: [item] };
}
function tryPortioned(choice: LogChoice, amount: AmountDraft) {
  try {
    return portioned(choice, amount);
  } catch {
    return null;
  }
}
const calories = (items: MealItem[]) =>
  totalNutrients(items.map((item) => item.nutrients)).calories;
const actions: {
  key: "barcode" | "photo" | "quick" | "custom";
  /** "ai" is the phone's own model mark, as on Home's quick-log bar. */
  icon: IconName | "ai";
  label: string;
  spoken: string;
}[] = [
  { key: "barcode", icon: "barcode-outline", label: "Scan", spoken: "Scan barcode" },
  { key: "photo", icon: "ai", label: "Photo", spoken: "Photo or description" },
  { key: "quick", icon: "flash-outline", label: "Quick add", spoken: "Quick add" },
  // Not a plus: as an icon it sits above the results' round + buttons, which add a food.
  { key: "custom", icon: "create-outline", label: "New food", spoken: "New food" },
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
  const { number, diaryLayout } = useStore();
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
        .then(({ foods, fixes }) => {
          if (active) setResults({ query: trimmed, foods, fixes, error: "" });
        })
        .catch(() => {
          if (active)
            setResults({
              query: trimmed,
              foods: [],
              fixes: {},
              error: "Catalog unavailable. Your own foods still work.",
            });
        });
    }, 120);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [trimmed, known]);
  // Foods eaten beyond Log again's top ones are read only when a search names them, and catalog
  // results reuse the last portion of any the person has eaten.
  // Once the catalog answers, a typo it corrected ("chiken") finds the person's own foods too.
  const fixes = results?.query === trimmed ? results.fixes : undefined;
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
        { fixes }
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
  const summary = (value: LogChoice["items"]) => {
    const sum = totalNutrients(value.map((item) => item.nutrients));
    return `${number(sum.calories, 0)} kcal · ${number(sum.protein, 0)} g protein`;
  };
  const macros = (value: LogChoice["items"]) => {
    const sum = totalNutrients(value.map((item) => item.nutrients));
    return `${number(sum.calories, 0)} kcal ${number(sum.protein, 0)}P ${number(sum.fat, 0)}F ${number(sum.carbs, 0)}C`;
  };
  /** The same totals as VoiceOver reads them. */
  const spokenMacros = (value: LogChoice["items"]) => {
    const sum = totalNutrients(value.map((item) => item.nutrients));
    return `${number(sum.calories, 0)} kcal, ${number(sum.protein, 0)} g protein, ${number(sum.fat, 0)} g fat, ${number(sum.carbs, 0)} g carbs`;
  };
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
      Alert.alert("Discard this meal?", "The selected foods have not been logged yet.", [
        { text: "Keep editing", style: "cancel" },
        { text: "Discard", style: "destructive", onPress: close },
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
      setError(e instanceof Error ? e.message : "Could not save this meal.");
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
                  detail: "estimate",
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
        pickerTitle={oneStep ? "Log food" : "Add to meal"}
        pickLabel={oneStep ? "Log" : undefined}
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
      ? "Today"
      : day === data.yesterday
        ? "Yesterday"
        : new Date(`${day}T12:00:00`).toLocaleDateString(undefined, {
            weekday: "short",
            month: "short",
            day: "numeric",
          });
  const whenLabel = `${dayLabel} · ${validFoodTime(time) ? formatClock(time) : time}${diaryLayout === "meals" ? ` · ${meal}` : ""}`;
  if (editing) {
    const preview = tryPortioned(editing, amount);
    const food = isMeal(editing) ? null : editing.items[0].food;
    const subtitle = isMeal(editing)
      ? editing.items.map((item) => item.food.name).join(", ")
      : source(editing.items[0].food);
    const others = cart.filter((row) => row.key !== editing.key).flatMap((row) => row.items);
    const sum = preview ? totalNutrients(preview.items.map((item) => item.nutrients)) : null;
    const favorite = !!food && data.saved.some((choice) => choice.key === `food:${food.id}`);
    const addToMeal = () =>
      attempt(() => {
        add(portioned(editing, amount));
        setEditing(null);
        setDirect(false);
        if (trimmed) clearQuery();
      });
    // Logs everything selected, with this food at the amount on screen.
    const logNow = () =>
      attempt(() => {
        const next = portioned(editing, amount);
        commit(
          (cart.some((row) => row.key === next.key)
            ? cart.map((row) => (row.key === next.key ? next : row))
            : [...cart, next]
          ).flatMap((row) => row.items)
        );
      });
    return (
      <Editor
        title={direct ? "Log food" : "Portion"}
        open
        close={back}
        compact
        footer={
          <View className="gap-2">
            <ErrorText message={error} />
            <AmountPicker
              units={unitsFor(editing)}
              value={amount}
              onChange={(next) => {
                setAmount(next);
                setError("");
              }}
              actions={[
                { label: "Log", onPress: logNow },
                { label: "Add", onPress: addToMeal },
              ]}
            />
          </View>
        }
      >
        <View className="flex-row items-center justify-between gap-2">
          <Text numberOfLines={1} className="shrink text-sm text-muted">
            {whenLabel}
          </Text>
          <DayRing
            calories={dayTotals.eaten + calories(others) + (sum?.calories ?? 0)}
            target={dayTotals.targets?.calories ?? null}
          />
        </View>
        <View className="flex-row items-start gap-1">
          <View className="flex-1 gap-1">
            <Text accessibilityRole="header" numberOfLines={2} className="text-xl font-semibold">
              {editing.title}
            </Text>
            {!!subtitle && (
              <Text numberOfLines={2} className="text-sm text-muted">
                {subtitle}
              </Text>
            )}
          </View>
          {food && (
            <SystemIconButton
              icon={favorite ? "heart" : "heart-outline"}
              color={favorite ? "accent-soft-foreground" : "foreground"}
              accessibilityLabel={favorite ? "Remove from saved foods" : "Save food"}
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
    <View className="flex-row items-center gap-1">
      <SystemLabel accessibilityRole="header" className={`flex-1 px-1 ${tools ? "" : "pt-1"}`}>
        {label}
      </SystemLabel>
      {tools &&
        offered.map((action) => (
          <SystemIconButton
            key={action.key}
            icon={action.icon === "ai" ? <AiMark /> : action.icon}
            color="accent-soft-foreground"
            accessibilityLabel={action.spoken}
            onPress={() => setPicker(action.key)}
          />
        ))}
    </View>
  );
  return (
    <Editor
      title="Log food"
      open
      close={cancel}
      compact
      scrollRef={list}
      footer={
        items.length || error ? (
          <View className="gap-2">
            <ErrorText message={error} />
            {!!items.length && (
              <View className="flex-row items-center gap-3">
                <Text numberOfLines={1} className="flex-1 text-sm font-semibold tabular-nums">
                  {summary(items)}
                </Text>
                <SystemButton onPress={() => attempt(() => commit(items))}>
                  {`Log ${items.length} ${items.length === 1 ? "food" : "foods"}`}
                </SystemButton>
              </View>
            )}
          </View>
        ) : undefined
      }
    >
      <View className="flex-row items-center justify-between gap-2">
        <SystemButton
          variant="ghost"
          icon="time-outline"
          className="shrink px-2"
          accessibilityHint="Changes the day and time for this meal"
          accessibilityState={{ expanded: when }}
          onPress={() => setWhen((open) => !open)}
        >
          {whenLabel}
        </SystemButton>
        <DayRing
          calories={dayTotals.eaten + calories(items)}
          target={dayTotals.targets?.calories ?? null}
        />
      </View>
      {when && (
        <>
          <TimeField value={time} onChange={setTime} day={day} onDayChange={setDay} />
          {diaryLayout === "meals" && <Choices values={meals} value={meal} onChange={setMeal} />}
        </>
      )}
      <SearchInput
        value={query}
        onChange={(next) => {
          setQuery(next);
          setResults(null);
          openSearch();
        }}
        placeholder="Search foods and meals"
        accessibilityLabel="Search foods and meals"
        autoFocus={typing}
        onFocus={openSearch}
      />
      {!searched && (
        <View className="flex-row flex-wrap gap-2">
          {offered.map((action) => (
            <SystemButton
              key={action.key}
              variant="secondary"
              icon={action.icon === "ai" ? <AiMark size={18} /> : action.icon}
              className="px-3"
              accessibilityLabel={action.spoken}
              onPress={() => setPicker(action.key)}
            >
              {action.label}
            </SystemButton>
          ))}
        </View>
      )}
      {!!cart.length && !trimmed && (
        <View className="gap-1">
          <SystemButton
            variant="ghost"
            className="self-start px-0"
            accessibilityState={{ expanded: reviewing }}
            onPress={() => setReviewing((open) => !open)}
          >
            {`${items.length} selected · ${reviewing ? "Hide" : "Review"}`}
          </SystemButton>
          {reviewing &&
            cart.map((choice) => (
              <View key={choice.key} className="flex-row items-center gap-2">
                <SystemButton
                  variant="ghost"
                  className="flex-1 justify-start px-0"
                  onPress={() => edit(choice)}
                >
                  <Text className="flex-1 text-sm" numberOfLines={1}>
                    {choice.title} · {choice.detail}
                  </Text>
                </SystemButton>
                <SystemIconButton
                  icon="close"
                  color="muted"
                  iconSize={20}
                  accessibilityLabel={`Remove ${choice.title} from meal`}
                  onPress={() => toggle(choice)}
                />
              </View>
            ))}
        </View>
      )}
      {showSaved && (
        <>
          {heading("Saved foods", searched)}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            className="-mx-4"
            contentContainerClassName="gap-2 px-4"
          >
            {data.saved.map((choice) => {
              const selected = inCart.get(choice.key);
              const { calories } = totalNutrients(
                (selected ?? choice).items.map((item) => item.nutrients)
              );
              return (
                <SystemButton
                  key={choice.key}
                  variant="secondary"
                  className={`w-36 items-stretch px-3 py-2.5 ${selected ? "bg-accent-soft" : "bg-surface"}`}
                  accessibilityLabel={`${selected ? "Remove" : "Add"} ${choice.title}`}
                  accessibilityValue={{ text: `${number(calories, 0)} kcal` }}
                  accessibilityHint="Long press to adjust the portion"
                  accessibilityState={{ selected: !!selected }}
                  onPress={() => toggle(choice)}
                  onLongPress={() => edit(choice)}
                >
                  <View className="flex-1 gap-1">
                    <View className="flex-row items-center gap-1">
                      <FoodIcon icon={foodIcon(choice.items[0].food)} />
                      <Text numberOfLines={1} className="flex-1 text-xs text-muted tabular-nums">
                        {`${number(calories, 0)} kcal`}
                      </Text>
                      <SystemIcon
                        name={selected ? "checkmark-circle" : "add-circle"}
                        size={22}
                        color="accent-soft-foreground"
                      />
                    </View>
                    <Text numberOfLines={2} className="text-sm font-medium">
                      {choice.title}
                    </Text>
                  </View>
                </SystemButton>
              );
            })}
          </ScrollView>
        </>
      )}
      {heading(
        trimmed
          ? results?.query === trimmed
            ? `${choices.length} ${choices.length === 1 ? "match" : "matches"}`
            : "Searching…"
          : "Log again",
        searched && !showSaved
      )}
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
            ? `${shown.items.length} ${shown.items.length === 1 ? "food" : "foods"}`
            : shown.detail,
        ].filter(Boolean);
        // The labels name the food; the values carry what tells same-named foods apart.
        return (
          <View
            key={choice.key}
            className={`flex-row items-center gap-2 rounded-2xl py-1 pl-3 pr-1.5 ${selected ? "bg-accent-soft" : "bg-surface"}`}
          >
            <SystemButton
              variant="ghost"
              className="flex-1 justify-start gap-3 px-0 py-2"
              accessibilityLabel={`Adjust ${choice.title}`}
              accessibilityValue={{ text: [...about, spokenMacros(shown.items)].join(", ") }}
              onPress={() => edit(choice)}
            >
              <FoodIcon icon={saved ? mealIcon(choice.title) : foodIcon(food)} />
              <View className="flex-1 gap-0.5">
                <View className="flex-row items-center gap-2">
                  <Text numberOfLines={2} className="shrink font-medium">
                    {choice.title}
                  </Text>
                  {saved && (
                    <View className="rounded-full bg-surface-secondary px-2">
                      <Text className="text-xs text-muted">Meal</Text>
                    </View>
                  )}
                </View>
                {/* A long brand or portion gives way before calories and macros do. */}
                <View className="flex-row">
                  <Text className="text-sm text-muted tabular-nums">
                    {`${macros(shown.items)} · `}
                  </Text>
                  <Text numberOfLines={1} className="shrink text-sm text-muted tabular-nums">
                    {about.join(" · ")}
                  </Text>
                </View>
              </View>
            </SystemButton>
            <SystemIconButton
              variant={selected ? "primary" : "secondary"}
              icon={selected ? "checkmark" : "add"}
              color={selected ? undefined : "accent-soft-foreground"}
              accessibilityLabel={`${selected ? "Remove" : "Add"} ${choice.title}`}
              accessibilityValue={brand ? { text: brand } : undefined}
              accessibilityState={{ selected: !!selected }}
              onPress={() => toggle(choice)}
            />
          </View>
        );
      })}
      {!choices.length && (!trimmed || results?.query === trimmed) && (
        <Text className="text-sm text-muted">{trimmed ? "No matches." : "Search for a food."}</Text>
      )}
      {results?.query === trimmed && <ErrorText message={results.error} />}
    </Editor>
  );
}
