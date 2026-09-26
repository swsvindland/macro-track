import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, ScrollView, View } from "react-native";
import {
  SystemButton,
  SystemIcon,
  SystemIconButton,
  SystemLabel,
  SystemText as Text,
} from "@/components/system";
import { Choices, DateInput, Editor, ErrorText, Field, SearchInput } from "@/components/ui";
import { currentFoodTime, formatClock, mealAtTime, validFoodTime } from "@/lib/food-time";
import { logBatch, loggingChoices, type LogChoice, type LogReceipt } from "@/lib/fast-log";
import { searchFoods } from "@/lib/food-catalog";
import { matchesQuery, rankSearch } from "@/lib/food-rank";
import {
  meals,
  scaleNutrients,
  shiftDay,
  totalNutrients,
  type Food,
  type Meal,
  type MealItem,
} from "@/lib/nutrition";
import { localDay, parseNumber } from "@/lib/metrics";
import { useNutrition } from "@/lib/nutrition-store";
import { useStore } from "@/lib/store";
import { FoodEditor } from "./food-editor";
import { PhotoLogger } from "./photo-logger";
import { QuickAdd } from "./quick-add";
import { TimeField } from "./time-field";

const isMeal = (choice: LogChoice) => choice.key.startsWith("meal:");
/** Tells apart catalog foods with the same name: "Chicken Breast · Tyson". */
const source = (food: Food) =>
  food.brand || (food.source === "usda" ? "USDA" : food.source === "off" ? "Open Food Facts" : "");
const startAmount = (choice: LogChoice) => String(isMeal(choice) ? 1 : choice.items[0].amount);

/** A typed quantity for one food, or a multiplier for every food in a saved meal. */
function portioned(choice: LogChoice, input: string): LogChoice {
  const value = parseNumber(input);
  if (!Number.isFinite(value) || value <= 0 || value > (isMeal(choice) ? 100 : 100000))
    throw new Error("Enter a valid quantity.");
  if (isMeal(choice))
    return {
      ...choice,
      detail: `${value} × saved meal`,
      items: choice.items.map((item) => ({
        ...item,
        amount: item.amount * value,
        portionLabel: `${Number((item.amount * value).toFixed(4))} ${item.food.basis}`,
        nutrients: Object.fromEntries(
          Object.entries(item.nutrients).map(([key, n]) => [key, n === null ? null : n * value])
        ) as MealItem["nutrients"],
      })),
    };
  const item = choice.items[0];
  return {
    ...choice,
    detail: `${value} ${item.food.basis}`,
    items: [
      {
        ...item,
        amount: value,
        portionLabel: `${value} ${item.food.basis}`,
        nutrients: scaleNutrients(item.food, value),
      },
    ],
  };
}
function tryPortioned(choice: LogChoice, input: string) {
  try {
    return portioned(choice, input);
  } catch {
    return null;
  }
}

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
  /** "meals" is kept for older callers; saved meals are now part of the search list. */
  start?: "search" | "barcode" | "meals";
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
  const [results, setResults] = useState<{ query: string; foods: Food[]; error: string } | null>(
    null
  );
  const [cart, setCart] = useState<LogChoice[]>([]),
    [error, setError] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [editing, setEditing] = useState<LogChoice | null>(null),
    [amount, setAmount] = useState("");
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
  const trimmed = query.trim().toLowerCase();
  const known = data.known;
  useEffect(() => {
    if (!trimmed) return;
    let active = true;
    const timer = setTimeout(() => {
      void searchFoods(trimmed, known)
        .then((foods) => {
          if (active) setResults({ query: trimmed, foods, error: "" });
        })
        .catch(() => {
          if (active)
            setResults({
              query: trimmed,
              foods: [],
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
  const recalled = useMemo(
    () => (trimmed ? data.recall((food) => matchesQuery(trimmed, food)) : []),
    [data, trimmed]
  );
  const found = useMemo(() => (results ? data.choose(results.foods) : []), [data, results]);
  // The person's own foods come first, ranked like the catalog below them, so rows already on
  // screen don't move when the catalog answers.
  const pool = [...data.choices, ...recalled];
  const byKey = new Map(pool.map((choice) => [choice.key, choice]));
  const own = trimmed
    ? rankSearch(
        trimmed,
        pool.map((choice) => choice.items[0].food).filter((food) => matchesQuery(trimmed, food)),
        known
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
        ...data.meals.filter((choice) => matchesQuery(trimmed, { name: choice.title, brand: "" })),
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
  function clearQuery() {
    setQuery("");
    setResults(null);
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
        onPick={(food, value, keepScanning) => {
          const item: MealItem = {
            food,
            amount: value,
            portionLabel: `${value} ${food.basis === "serving" ? "serving(s)" : food.basis}`,
            nutrients: scaleNutrients(food, value),
          };
          // With nothing else selected today, a scan or new food is logged in one step.
          if (oneStep && !keepScanning) commit([item]);
          else {
            keepOpen.current = true;
            setDirect(false);
            add({
              key: `food:${food.id}`,
              title: food.name,
              detail: `${value} ${food.basis}`,
              items: [item],
            });
          }
        }}
      />
    );
  if (editing) {
    const preview = tryPortioned(editing, amount);
    const basis = editing.items[0].food.basis;
    const value = parseNumber(amount);
    const unit = isMeal(editing)
      ? "×"
      : basis === "serving"
        ? value === 1
          ? " serving"
          : " servings"
        : ` ${basis}`;
    // The only item: logging it now saves a trip back through the list.
    const solo = !cart.some((row) => row.key !== editing.key);
    const subtitle = isMeal(editing)
      ? editing.items.map((item) => item.food.name).join(", ")
      : source(editing.items[0].food);
    const addToMeal = () =>
      attempt(() => {
        add(portioned(editing, amount));
        setEditing(null);
        setDirect(false);
        if (trimmed) clearQuery();
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
            {solo ? (
              <>
                <SystemButton
                  onPress={() => attempt(() => commit(portioned(editing, amount).items))}
                >
                  {preview
                    ? `Log ${value}${unit} · ${number(totalNutrients(preview.items.map((item) => item.nutrients)).calories, 0)} kcal`
                    : "Log food"}
                </SystemButton>
                <SystemButton variant="secondary" onPress={addToMeal}>
                  Add to meal
                </SystemButton>
              </>
            ) : (
              <SystemButton onPress={addToMeal}>Add to meal</SystemButton>
            )}
          </View>
        }
      >
        <Text accessibilityRole="header" numberOfLines={2} className="text-xl font-semibold">
          {editing.title}
        </Text>
        {!!subtitle && (
          <Text numberOfLines={2} className="-mt-2 text-sm text-muted">
            {subtitle}
          </Text>
        )}
        <Field
          label={isMeal(editing) ? "Multiply selected portions" : `Quantity (${basis})`}
          numeric
          autoFocus
          selectTextOnFocus
          value={amount}
          onChange={(next) => {
            setAmount(next);
            setError("");
          }}
        />
        {preview && (
          <Text className="text-sm font-semibold tabular-nums">{summary(preview.items)}</Text>
        )}
        {!isMeal(editing) && !!editing.items[0].food.portions.length && (
          <View className="flex-row flex-wrap gap-2">
            {editing.items[0].food.portions.slice(0, 6).map((portion, i) => (
              <SystemButton
                key={i}
                variant="secondary"
                className={`px-3 ${value === portion.amount ? "bg-accent-soft" : ""}`}
                accessibilityState={{ selected: value === portion.amount }}
                onPress={() => {
                  setAmount(String(portion.amount));
                  setError("");
                }}
              >
                {`${portion.label} · ${portion.amount} ${basis}`}
              </SystemButton>
            ))}
          </View>
        )}
      </Editor>
    );
  }
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
  return (
    <Editor
      title="Log food"
      open
      close={cancel}
      compact
      footer={
        <View className="gap-2">
          <ErrorText message={error} />
          {!!items.length && (
            <Text className="text-sm font-semibold tabular-nums">{summary(items)}</Text>
          )}
          <SystemButton isDisabled={!items.length} onPress={() => attempt(() => commit(items))}>
            {items.length
              ? `Log ${items.length} ${items.length === 1 ? "food" : "foods"}`
              : "Choose foods to log"}
          </SystemButton>
        </View>
      }
    >
      <SystemButton
        variant="ghost"
        icon="time-outline"
        className="self-start px-2"
        accessibilityHint="Changes the day and time for this meal"
        accessibilityState={{ expanded: when }}
        onPress={() => setWhen((open) => !open)}
      >
        {`${dayLabel} · ${validFoodTime(time) ? formatClock(time) : time}${diaryLayout === "meals" ? ` · ${meal}` : ""}`}
      </SystemButton>
      {when && (
        <>
          <DateInput label="Log date" value={day} onChange={setDay} />
          <TimeField value={time} onChange={setTime} />
          {diaryLayout === "meals" && <Choices values={meals} value={meal} onChange={setMeal} />}
        </>
      )}
      <SearchInput
        value={query}
        onChange={(next) => {
          setQuery(next);
          setResults(null);
        }}
        placeholder="Search foods and meals"
        accessibilityLabel="Search foods and meals"
      />
      <View className="flex-row flex-wrap gap-2">
        <SystemButton
          variant="secondary"
          icon="barcode-outline"
          className="px-3"
          onPress={() => setPicker("barcode")}
        >
          Scan
        </SystemButton>
        {photoLogging && (
          <SystemButton
            variant="secondary"
            icon="sparkles-outline"
            className="px-3"
            onPress={() => setPicker("photo")}
          >
            Photo
          </SystemButton>
        )}
        <SystemButton
          variant="secondary"
          icon="flash-outline"
          className="px-3"
          onPress={() => setPicker("quick")}
        >
          Quick add
        </SystemButton>
        <SystemButton
          variant="secondary"
          icon="add-circle-outline"
          className="px-3"
          onPress={() => setPicker("custom")}
        >
          New food
        </SystemButton>
      </View>
      {!!cart.length && (
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
      {!trimmed && !!data.saved.length && (
        <>
          <SystemLabel accessibilityRole="header" className="px-1 pt-1">
            Saved foods
          </SystemLabel>
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
                  className={`w-32 items-stretch px-3 py-2.5 ${selected ? "bg-accent-soft" : "bg-surface"}`}
                  accessibilityLabel={`${selected ? "Remove" : "Add"} ${choice.title}`}
                  accessibilityHint="Long press to adjust the portion"
                  accessibilityState={{ selected: !!selected }}
                  onPress={() => toggle(choice)}
                  onLongPress={() => edit(choice)}
                >
                  <View className="flex-1 gap-1">
                    <View className="flex-row items-center justify-between gap-1">
                      <Text className="text-xs text-muted tabular-nums">
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
      <SystemLabel accessibilityRole="header" className="px-1 pt-1">
        {trimmed
          ? results?.query === trimmed
            ? `${choices.length} ${choices.length === 1 ? "match" : "matches"}`
            : "Searching…"
          : "Log again"}
      </SystemLabel>
      {choices.map((choice) => {
        const selected = inCart.get(choice.key);
        const shown = selected ?? choice;
        const saved = isMeal(choice);
        // Search results name their catalog too; familiar foods only need a brand.
        const food = choice.items[0].food;
        const brand = saved ? "" : trimmed ? source(food) : food.brand;
        return (
          <View
            key={choice.key}
            className={`flex-row items-center gap-2 rounded-2xl py-1 pl-3 pr-1.5 ${selected ? "bg-accent-soft" : "bg-surface"}`}
          >
            <SystemButton
              variant="ghost"
              className="flex-1 justify-start px-0 py-2"
              accessibilityLabel={`Adjust ${choice.title}`}
              onPress={() => edit(choice)}
            >
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
                    {[
                      brand,
                      saved && !selected
                        ? `${shown.items.length} ${shown.items.length === 1 ? "food" : "foods"}`
                        : shown.detail,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </Text>
                </View>
              </View>
            </SystemButton>
            <SystemIconButton
              variant={selected ? "primary" : "secondary"}
              icon={selected ? "checkmark" : "add"}
              color={selected ? undefined : "accent-soft-foreground"}
              accessibilityLabel={`${selected ? "Remove" : "Add"} ${choice.title}`}
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
