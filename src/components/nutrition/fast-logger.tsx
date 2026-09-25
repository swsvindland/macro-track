import { useEffect, useRef, useState } from "react";
import { Alert, View } from "react-native";
import { SystemButton, SystemText as Text } from "@/components/system";
import { Choices, DateInput, Editor, ErrorText, Field } from "@/components/ui";
import { currentFoodTime, mealAtTime } from "@/lib/food-time";
import {
  logBatch,
  loggingChoices,
  portionFor,
  type LogChoice,
  type LogReceipt,
} from "@/lib/fast-log";
import { searchCatalog } from "@/lib/food-catalog";
import { scaleNutrients, totalNutrients, meals, type Food, type Meal } from "@/lib/nutrition";
import { parseNumber } from "@/lib/metrics";
import { useNutrition, useNutritionQuery } from "@/lib/nutrition-store";
import { useStore } from "@/lib/store";
import { FoodEditor } from "./food-editor";
import { TimeField } from "./time-field";

export function FastLogger({
  initialDay,
  initialTime,
  initialMeal,
  start = "search",
  close,
  onLogged,
}: {
  initialDay: string;
  initialTime?: string;
  initialMeal?: Meal;
  start?: "search" | "barcode" | "meals";
  close: () => void;
  onLogged: (receipt: LogReceipt) => void;
}) {
  const { number, date, diaryLayout } = useStore();
  const { refresh } = useNutrition();
  const [day, setDay] = useState(initialDay),
    [time, setTime] = useState(initialTime ?? currentFoodTime());
  const [meal, setMeal] = useState<Meal>(initialMeal ?? mealAtTime(time));
  const [when, setWhen] = useState(false),
    [complete, setComplete] = useState(false);
  const [query, setQuery] = useState(""),
    [category, setCategory] = useState<"foods" | "meals">(start === "meals" ? "meals" : "foods");
  const [results, setResults] = useState<{ query: string; foods: Food[]; error: string } | null>(
    null
  );
  const [cart, setCart] = useState<LogChoice[]>([]),
    [error, setError] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [editing, setEditing] = useState<LogChoice | null>(null),
    [amount, setAmount] = useState("");
  const [picker, setPicker] = useState<"barcode" | "custom" | null>(
    start === "barcode" ? "barcode" : null
  );
  const locked = useRef(false);
  const data = useNutritionQuery(() => loggingChoices(time));
  const trimmed = query.trim().toLowerCase();
  useEffect(() => {
    if (!trimmed || category !== "foods") return;
    let active = true;
    const timer = setTimeout(() => {
      void searchCatalog(trimmed)
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
  }, [trimmed, category]);
  const matches = (name: string) => name.toLowerCase().includes(trimmed);
  const local = data.choices.filter((choice) =>
    matches(`${choice.title} ${choice.items[0].food.brand}`)
  );
  const choices: LogChoice[] =
    category === "meals"
      ? data.meals.filter((choice) => matches(choice.title))
      : !trimmed
        ? data.choices.slice(0, 20)
        : [
            ...new Map(
              [
                ...local,
                ...(results?.query === trimmed ? results.foods : []).map((food) => {
                  const item = portionFor(
                    food,
                    data.history.find((row) => row.food.id === food.id)
                  );
                  return {
                    key: `food:${food.id}`,
                    title: food.name,
                    detail: item.portionLabel,
                    items: [item],
                  };
                }),
              ].map((choice) => [choice.key, choice])
            ).values(),
          ].slice(0, 40);
  const selected = new Set(cart.map((choice) => choice.key));
  const items = cart.flatMap((choice) => choice.items);
  const total = totalNutrients(items.map((item) => item.nutrients));
  function add(choice: LogChoice) {
    setCart((previous) => [...previous.filter((row) => row.key !== choice.key), choice]);
    setError("");
  }
  function toggle(choice: LogChoice) {
    setCart((previous) =>
      previous.some((row) => row.key === choice.key)
        ? previous.filter((row) => row.key !== choice.key)
        : [...previous, choice]
    );
  }
  function edit(choice: LogChoice) {
    const current = cart.find((row) => row.key === choice.key) ?? choice;
    setEditing(current);
    setAmount(String(current.key.startsWith("meal:") ? 1 : current.items[0].amount));
    setError("");
  }
  function cancel() {
    if (!cart.length) close();
    else
      Alert.alert("Discard this meal?", "The selected foods have not been logged yet.", [
        { text: "Keep editing", style: "cancel" },
        { text: "Discard", style: "destructive", onPress: close },
      ]);
  }
  function submit() {
    if (locked.current) return;
    locked.current = true;
    try {
      const receipt = logBatch(items, {
        day,
        time,
        meal: diaryLayout === "meals" ? meal : undefined,
        complete,
      });
      refresh();
      onLogged(receipt);
      close();
    } catch (e) {
      locked.current = false;
      setError(e instanceof Error ? e.message : "Could not save this meal.");
    }
  }
  if (picker)
    return (
      <FoodEditor
        initialMode={picker}
        pickerTitle="Add to meal"
        close={() => setPicker(null)}
        onPick={(food, value) => {
          add({
            key: `food:${food.id}`,
            title: food.name,
            detail: `${value} ${food.basis}`,
            items: [
              {
                food,
                amount: value,
                portionLabel: `${value} ${food.basis === "serving" ? "serving(s)" : food.basis}`,
                nutrients: scaleNutrients(food, value),
              },
            ],
          });
        }}
      />
    );
  return (
    <Editor
      title={editing ? "Portion" : "Log a meal"}
      open
      close={editing ? () => setEditing(null) : cancel}
      compact
      footer={
        editing ? undefined : (
          <View className="gap-2">
            <ErrorText message={error} />
            {!!items.length && (
              <View className="flex-row items-center justify-between gap-2">
                <Text className="font-semibold">
                  {number(total.calories, 0)} kcal · {number(total.protein, 0)} g protein
                </Text>
                <SystemButton
                  variant="ghost"
                  accessibilityLabel="Toggle day complete after logging"
                  accessibilityState={{ checked: complete }}
                  onPress={() => setComplete((value) => !value)}
                >
                  {complete ? "✓ Day complete" : "Finish day"}
                </SystemButton>
              </View>
            )}
            <SystemButton isDisabled={!items.length} onPress={submit}>
              {items.length
                ? `Log ${items.length} ${items.length === 1 ? "food" : "foods"}${complete ? " & finish day" : ""}`
                : "Choose foods to log"}
            </SystemButton>
          </View>
        )
      }
    >
      {editing ? (
        <>
          <Text className="text-xl font-semibold">{editing.title}</Text>
          <Field
            label={
              editing.key.startsWith("meal:")
                ? "Multiply selected portions"
                : `Quantity (${editing.items[0].food.basis})`
            }
            numeric
            autoFocus
            value={amount}
            onChange={setAmount}
          />
          {!editing.key.startsWith("meal:") &&
            editing.items[0].food.portions.slice(0, 4).map((portion, i) => (
              <SystemButton
                key={i}
                variant="secondary"
                onPress={() => setAmount(String(portion.amount))}
              >
                {portion.label} · {portion.amount} {editing.items[0].food.basis}
              </SystemButton>
            ))}
          <ErrorText message={error} />
          <SystemButton
            onPress={() => {
              try {
                const value = parseNumber(amount);
                if (
                  !Number.isFinite(value) ||
                  value <= 0 ||
                  value > (editing.key.startsWith("meal:") ? 100 : 100000)
                )
                  throw new Error("Enter a valid quantity.");
                const updated = editing.key.startsWith("meal:")
                  ? editing.items.map((item) => ({
                      ...item,
                      amount: item.amount * value,
                      portionLabel: `${Number((item.amount * value).toFixed(4))} ${item.food.basis}`,
                      nutrients: Object.fromEntries(
                        Object.entries(item.nutrients).map(([key, n]) => [
                          key,
                          n === null ? null : n * value,
                        ])
                      ) as typeof item.nutrients,
                    }))
                  : [
                      {
                        ...editing.items[0],
                        amount: value,
                        portionLabel: `${value} ${editing.items[0].food.basis}`,
                        nutrients: scaleNutrients(editing.items[0].food, value),
                      },
                    ];
                add({
                  ...editing,
                  detail: editing.key.startsWith("meal:")
                    ? `${value} × selected meal`
                    : `${value} ${editing.items[0].food.basis}`,
                  items: updated,
                });
                setEditing(null);
              } catch (e) {
                setError(e instanceof Error ? e.message : "Check this portion.");
              }
            }}
          >
            Add to meal
          </SystemButton>
        </>
      ) : (
        <>
          <SystemButton
            variant="ghost"
            className="self-start px-0"
            onPress={() => setWhen((value) => !value)}
          >
            {date(day)} · {time}
            {diaryLayout === "meals" ? ` · ${meal}` : ""} · Change
          </SystemButton>
          {when && (
            <>
              <DateInput label="Log date" value={day} onChange={setDay} />
              <TimeField value={time} onChange={setTime} />
              {diaryLayout === "meals" && (
                <Choices values={meals} value={meal} onChange={setMeal} />
              )}
            </>
          )}
          <View className="flex-row items-end gap-2">
            <View className="flex-1">
              <Field
                label={category === "foods" ? "Search foods" : "Find a saved meal"}
                autoFocus={start === "search" && !items.length}
                value={query}
                onChange={(value) => {
                  setQuery(value);
                  setResults(null);
                }}
                placeholder={category === "foods" ? "Search your local foods" : "Meal name"}
              />
            </View>
            {!!query && (
              <SystemButton
                variant="ghost"
                accessibilityLabel="Clear search"
                onPress={() => {
                  setQuery("");
                  setResults(null);
                }}
              >
                Clear
              </SystemButton>
            )}
          </View>
          <View className="flex-row flex-wrap gap-1">
            <SystemButton
              variant={category === "foods" ? "secondary" : "ghost"}
              onPress={() => setCategory("foods")}
            >
              Foods
            </SystemButton>
            <SystemButton
              variant={category === "meals" ? "secondary" : "ghost"}
              onPress={() => setCategory("meals")}
            >
              Meals
            </SystemButton>
            <SystemButton variant="ghost" onPress={() => setPicker("barcode")}>
              Scan
            </SystemButton>
            <SystemButton variant="ghost" onPress={() => setPicker("custom")}>
              Create
            </SystemButton>
          </View>
          {!!cart.length && (
            <View className="gap-1">
              <SystemButton
                variant="ghost"
                className="self-start px-0"
                onPress={() => setReviewing((value) => !value)}
              >
                {items.length} selected · {reviewing ? "Hide" : "Review"}
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
                    <SystemButton
                      variant="ghost"
                      accessibilityLabel={`Remove ${choice.title} from meal`}
                      onPress={() => toggle(choice)}
                    >
                      Remove
                    </SystemButton>
                  </View>
                ))}
            </View>
          )}
          <Text className="text-sm text-muted">
            {trimmed
              ? results?.query !== trimmed && category === "foods"
                ? "Searching on your phone…"
                : `${choices.length} matches`
              : category === "foods"
                ? "Usual portions · tap a name to adjust"
                : "Saved meals · tap a name to adjust"}
          </Text>
          {choices.map((choice) => (
            <View
              key={choice.key}
              className="flex-row items-center gap-2 rounded-2xl bg-surface px-3 py-1"
            >
              <SystemButton
                variant="ghost"
                className="flex-1 justify-start px-0"
                accessibilityLabel={`Adjust ${choice.title}`}
                onPress={() => edit(choice)}
              >
                <View className="flex-1 gap-1">
                  <Text numberOfLines={2} className="font-medium">
                    {choice.title}
                  </Text>
                  <Text className="text-sm text-muted">
                    {choice.detail} ·{" "}
                    {number(totalNutrients(choice.items.map((item) => item.nutrients)).calories, 0)}{" "}
                    kcal
                  </Text>
                </View>
              </SystemButton>
              <SystemButton
                variant={selected.has(choice.key) ? "secondary" : "ghost"}
                accessibilityLabel={`${selected.has(choice.key) ? "Remove" : "Add"} ${choice.title}`}
                accessibilityState={{ selected: selected.has(choice.key) }}
                onPress={() => toggle(choice)}
              >
                {selected.has(choice.key) ? "✓" : "+"}
              </SystemButton>
            </View>
          ))}
          {!choices.length && (
            <Text className="text-muted">
              {category === "meals"
                ? "Save a meal from your timeline to reuse it here."
                : trimmed
                  ? "Try a simpler name or create a food."
                  : "Search for a food. Your usual portions will appear here next time."}
            </Text>
          )}
          {results?.query === trimmed && <ErrorText message={results.error} />}
        </>
      )}
    </Editor>
  );
}
