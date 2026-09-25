import { TimeField } from "./time-field";
import { currentFoodTime, mealAtTime } from "@/lib/food-time";
import { useEffect, useRef, useState } from "react";
import { Alert, Linking, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { SystemButton, SystemPanel, SystemText as Text } from "@/components/system";
import { Choices, DateInput, Editor, ErrorText, Field } from "@/components/ui";
import type { FoodEntry } from "@/db";
import {
  favoriteFoods,
  recipeFoods,
  findPersonalBarcode,
  personalFoods,
  recentFoods,
  saveCustomFood,
  saveEntry,
  deleteEntry,
  toggleFavorite,
} from "@/lib/diary";
import { lookupBarcode, searchCatalog } from "@/lib/food-catalog";
import { useNutrition, useNutritionQuery } from "@/lib/nutrition-store";
import { meals, normalizeBarcode, scaleNutrients, type Food, type Meal } from "@/lib/nutrition";
import { localDay, parseNumber } from "@/lib/metrics";
import { useStore } from "@/lib/store";

export function FoodRow({ food, onPress }: { food: Food; onPress: () => void }) {
  const { number } = useStore();
  return (
    <SystemButton
      variant="ghost"
      className="justify-start rounded-2xl bg-surface px-4 py-4"
      accessibilityLabel={`Log ${food.name}`}
      onPress={onPress}
    >
      <View className="flex-1 gap-1">
        <Text className="font-medium" numberOfLines={2}>
          {food.name}
        </Text>
        <Text className="text-sm text-muted">
          {food.brand ||
            (food.source === "usda"
              ? "USDA"
              : food.source === "off"
                ? "Open Food Facts"
                : food.source === "recipe"
                  ? "Recipe"
                  : "My food")}{" "}
          · {number(food.nutrients.calories, 0)} kcal /{" "}
          {food.basis === "serving" ? "serving" : `100 ${food.basis}`}
        </Text>
      </View>
      <Text className="text-sm text-accent-soft-foreground">Add</Text>
    </SystemButton>
  );
}

function BarcodeCamera({ onScan }: { onScan: (value: string) => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [error, setError] = useState("");
  const scanned = useRef(false);
  if (!permission) return <Text className="text-muted">Checking camera access…</Text>;
  if (!permission.granted)
    return (
      <View className="gap-3">
        <Text className="text-muted">
          Allow camera access to scan a food barcode, or enter its digits below.
        </Text>
        <SystemButton
          variant="secondary"
          onPress={() => {
            void (permission.canAskAgain ? requestPermission() : Linking.openSettings()).catch(() =>
              setError("Camera access is unavailable. You can enter the barcode below.")
            );
          }}
        >
          {permission.canAskAgain ? "Allow camera" : "Open camera settings"}
        </SystemButton>
        <ErrorText message={error} />
      </View>
    );
  return (
    <View className="gap-3">
      {!error && (
        <CameraView
          style={{ height: 220, borderRadius: 8 }}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ["ean13", "ean8", "upc_a", "itf14"] }}
          onMountError={() => setError("The camera is unavailable. Enter the barcode below.")}
          onBarcodeScanned={({ data }) => {
            if (!scanned.current) {
              scanned.current = true;
              onScan(data);
            }
          }}
        />
      )}
      <ErrorText message={error} />
      <Text className="text-sm text-muted">
        Center the barcode in the camera. Lookups stay on this phone.
      </Text>
    </View>
  );
}

function CustomFoodForm({ barcode, onSave }: { barcode: string; onSave: (food: Food) => void }) {
  const [name, setName] = useState("");
  const [brand, setBrand] = useState("");
  const [code, setCode] = useState(barcode);
  const [basis, setBasis] = useState<Food["basis"]>("g");
  const [values, setValues] = useState({ calories: "", protein: "", carbs: "", fat: "" });
  const [error, setError] = useState("");
  function save() {
    const normalized = code.trim() ? normalizeBarcode(code) : null;
    if (code.trim() && !normalized) {
      setError("Check the barcode digits, or leave the barcode blank.");
      return;
    }
    const food: Food = {
      id: `custom:${Date.now()}:${Math.random().toString(36).slice(2)}`,
      name: name.trim(),
      brand: brand.trim(),
      barcode: normalized,
      basis,
      nutrients: {
        calories: parseNumber(values.calories),
        protein: parseNumber(values.protein),
        carbs: parseNumber(values.carbs),
        fat: parseNumber(values.fat),
        fiber: null,
        sodium: null,
      },
      portions: [],
      source: "custom",
      sourceVersion: "1",
    };
    try {
      saveCustomFood(food);
      onSave(food);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save this food.");
    }
  }
  return (
    <View className="gap-4">
      <Field
        label="Food name"
        value={name}
        onChange={setName}
        placeholder="e.g. My overnight oats"
      />
      <Field label="Brand (optional)" value={brand} onChange={setBrand} />
      <Text className="font-medium">Nutrition per</Text>
      <Choices
        values={["g", "ml", "serving"] as const}
        value={basis}
        onChange={setBasis}
        label={(value) => (value === "serving" ? "1 serving" : `100 ${value}`)}
      />
      <View className="flex-row flex-wrap gap-4">
        {(["calories", "protein", "carbs", "fat"] as const).map((key) => (
          <View key={key} style={{ flexBasis: "44%", flexGrow: 1 }}>
            <Field
              label={
                key === "calories"
                  ? "Calories (kcal)"
                  : `${key[0].toUpperCase()}${key.slice(1)} (g)`
              }
              value={values[key]}
              numeric
              onChange={(value) => setValues((old) => ({ ...old, [key]: value }))}
            />
          </View>
        ))}
      </View>
      <Text className="text-sm text-muted">
        Use the label values. Enter 0 for a macro only when the food contains none.
      </Text>
      <Field label="Barcode (optional)" value={code} onChange={setCode} />
      <ErrorText message={error} />
      <SystemButton onPress={save}>Save food & choose portion</SystemButton>
    </View>
  );
}

export function FoodEditor({
  close,
  initialDay = localDay(),
  initialMeal = "Breakfast",
  initialTime,
  entry,
  initialFood,
  initialAmount,
  onPick,
  pickerTitle,
  initialMode = "search",
}: {
  close: () => void;
  initialDay?: string;
  initialMeal?: Meal;
  initialTime?: string;
  entry?: FoodEntry;
  initialFood?: Food;
  initialAmount?: number;
  onPick?: (food: Food, amount: number) => void;
  pickerTitle?: string;
  initialMode?: "search" | "barcode" | "custom";
}) {
  const { refresh } = useNutrition();
  const { number, diaryLayout } = useStore();
  const [mode, setMode] = useState<"search" | "barcode" | "custom" | "portion">(
    entry || initialFood ? "portion" : initialMode
  );
  const [food, setFood] = useState<Food | undefined>(entry?.food ?? initialFood);
  const [day, setDay] = useState(entry?.day ?? initialDay);
  const [loggedTime, setLoggedTime] = useState(
    entry ? (entry.loggedTime ?? "") : (initialTime ?? currentFoodTime())
  );
  const [meal, setMeal] = useState<Meal>(entry?.meal ?? initialMeal);
  const [amount, setAmount] = useState(
    String(entry?.amount ?? initialAmount ?? (initialFood?.basis === "serving" ? 1 : 100))
  );
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Food[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [barcode, setBarcode] = useState("");
  const [notFound, setNotFound] = useState(false);
  const [favorites, setFavorites] = useState(() => favoriteFoods());
  const saveLock = useRef(false);
  useEffect(() => {
    let active = true;
    if (mode !== "search" || !query.trim()) return;
    const timer = setTimeout(() => {
      setBusy(true);
      setError("");
      const personal = [...personalFoods(), ...recipeFoods()].filter((item) =>
        `${item.name} ${item.brand}`.toLowerCase().includes(query.toLowerCase().trim())
      );
      searchCatalog(query)
        .then((foods) => {
          if (active) setResults([...personal, ...foods]);
        })
        .catch(() => {
          if (active) {
            setResults(personal);
            setError(
              "The bundled catalog couldn't open. You can still create and log a custom food."
            );
          }
        })
        .finally(() => {
          if (active) setBusy(false);
        });
    }, 180);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [mode, query]);

  function select(selected: Food) {
    setFood(selected);
    setAmount(String(selected.portions[0]?.amount ?? (selected.basis === "serving" ? 1 : 100)));
    setMode("portion");
    setError("");
  }
  async function scan(input: string) {
    setBarcode(input);
    setBusy(true);
    setError("");
    setNotFound(false);
    if (!normalizeBarcode(input)) {
      setError("Enter a valid 8, 12, 13, or 14-digit food barcode.");
      setBusy(false);
      return;
    }
    try {
      const found = findPersonalBarcode(input) ?? (await lookupBarcode(input));
      if (found) select(found);
      else setNotFound(true);
    } catch {
      setError("The food catalog couldn't open. Try again or create a custom food.");
    } finally {
      setBusy(false);
    }
  }
  function save() {
    if (!food || saveLock.current) return;
    saveLock.current = true;
    try {
      const value = parseNumber(amount);
      if (onPick) {
        scaleNutrients(food, value);
        onPick(food, value);
        close();
        return;
      }
      if (!entry && !loggedTime) throw new Error("Choose a time for this entry.");
      saveEntry({
        id: entry?.id,
        day,
        meal: diaryLayout === "timeline" && loggedTime ? mealAtTime(loggedTime) : meal,
        loggedTime: loggedTime || null,
        food,
        amount: value,
        portionLabel: `${value} ${food.basis === "serving" ? "serving(s)" : food.basis}`,
      });
      refresh();
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save this entry.");
      saveLock.current = false;
    }
  }
  const { recent, personal } = useNutritionQuery(() => ({
    recent: recentFoods(),
    personal: [...personalFoods(), ...recipeFoods()],
  }));
  const history = [
    ...new Map([...favorites, ...recent, ...personal].map((item) => [item.id, item])).values(),
  ].slice(0, 25);
  let preview = null;
  if (food) {
    try {
      preview = scaleNutrients(food, parseNumber(amount));
    } catch {
      /* Validation is shown on save. */
    }
  }
  return (
    <Editor
      title={
        onPick
          ? (pickerTitle ?? "Add ingredient")
          : entry
            ? "Edit food"
            : mode === "custom"
              ? "Create a food"
              : mode === "portion"
                ? "Log food"
                : "Add food"
      }
      open
      close={close}
    >
      {mode !== "search" && !entry && (
        <SystemButton
          variant="ghost"
          className="self-start"
          onPress={() => {
            setMode("search");
            setError("");
            setBusy(false);
          }}
        >
          Back to search
        </SystemButton>
      )}
      {mode === "search" && (
        <>
          <Field
            label="Search foods"
            value={query}
            onChange={(value) => {
              setQuery(value);
              setResults([]);
              setBusy(false);
            }}
            placeholder="Chicken, oats, Greek yogurt…"
          />
          <View className="flex-row gap-3">
            <SystemButton
              className="flex-1"
              variant="secondary"
              onPress={() => {
                setError("");
                setMode("barcode");
              }}
            >
              Scan barcode
            </SystemButton>
            <SystemButton
              className="flex-1"
              variant="outline"
              onPress={() => {
                setError("");
                setMode("custom");
              }}
            >
              Create food
            </SystemButton>
          </View>
          <ErrorText message={error} />
          <Text className="text-sm text-muted">
            {query.trim()
              ? busy
                ? "Searching on your phone…"
                : `${results.length} matches`
              : history.length
                ? "Saved & recent foods"
                : "Search the offline catalog or create your own food."}
          </Text>
          {(query.trim() ? results : history).map((item) => (
            <FoodRow key={item.id} food={item} onPress={() => select(item)} />
          ))}
          {query.trim() && !busy && !results.length && !error && (
            <Text className="text-muted">
              Try a simpler name, or create the food from its label.
            </Text>
          )}
        </>
      )}
      {mode === "barcode" && (
        <>
          {!notFound && !busy && (
            <BarcodeCamera
              onScan={(value) => {
                void scan(value);
              }}
            />
          )}
          <Field label="Barcode digits" value={barcode} onChange={setBarcode} />
          <SystemButton
            isDisabled={busy}
            onPress={() => {
              void scan(barcode);
            }}
          >
            {busy ? "Looking up…" : "Look up barcode"}
          </SystemButton>
          <ErrorText message={error} />
          {notFound && (
            <Text className="text-muted">
              This product isn’t in your installed catalog yet. Save its label values once to find
              it by barcode next time.
            </Text>
          )}
          <SystemButton variant="outline" onPress={() => setMode("custom")}>
            Create this food
          </SystemButton>
        </>
      )}
      {mode === "custom" && (
        <CustomFoodForm
          barcode={barcode}
          onSave={(value) => {
            refresh();
            select(value);
          }}
        />
      )}
      {mode === "portion" && food && (
        <>
          <View className="gap-2">
            <Text className="text-xl font-semibold">{food.name}</Text>
            <Text className="text-sm text-muted">
              {food.brand ? `${food.brand} · ` : ""}
              {food.source === "usda"
                ? "USDA FoodData Central"
                : food.source === "off"
                  ? "Open Food Facts · check the label"
                  : food.source === "recipe"
                    ? "My recipe"
                    : "My food"}
            </Text>
            <SystemButton
              variant="ghost"
              className="self-start"
              onPress={() => {
                toggleFavorite(food);
                setFavorites(favoriteFoods());
                refresh();
              }}
            >
              {favorites.some((item) => item.id === food.id)
                ? "Remove from saved foods"
                : "Save to my library"}
            </SystemButton>
          </View>
          {!onPick && (
            <>
              <DateInput label="Date" value={day} onChange={setDay} />
              <TimeField
                value={loggedTime}
                onChange={setLoggedTime}
                allowEmpty={!!entry && !entry.loggedTime}
              />
              {diaryLayout !== "timeline" && (
                <Choices values={meals} value={meal} onChange={setMeal} label={(value) => value} />
              )}
            </>
          )}
          <Field
            label={`Quantity (${food.basis === "serving" ? "servings" : food.basis})`}
            value={amount}
            onChange={setAmount}
            numeric
          />
          {!!food.portions.length && (
            <View className="gap-2">
              <Text className="text-sm text-muted">Common portions</Text>
              {food.portions.slice(0, 6).map((portion, i) => (
                <SystemButton
                  key={i}
                  variant="secondary"
                  onPress={() => setAmount(String(portion.amount))}
                >
                  {portion.label} · {number(portion.amount)} {food.basis}
                </SystemButton>
              ))}
            </View>
          )}
          {preview && (
            <SystemPanel>
              <SystemPanel.Body className="gap-2">
                <Text className="font-semibold tabular-nums text-3xl">
                  {number(preview.calories, 0)} <Text className="text-base text-muted">kcal</Text>
                </Text>
                <Text className="text-sm text-muted">
                  Protein {number(preview.protein)} g · Carbs {number(preview.carbs)} g · Fat{" "}
                  {number(preview.fat)} g
                </Text>
              </SystemPanel.Body>
            </SystemPanel>
          )}
          <ErrorText message={error} />
          <SystemButton onPress={save}>
            {onPick
              ? pickerTitle
                ? "Add to meal"
                : "Use ingredient"
              : entry
                ? "Save changes"
                : diaryLayout === "timeline"
                  ? `Log at ${loggedTime}`
                  : `Add to ${meal.toLowerCase()}`}
          </SystemButton>
          {entry && (
            <SystemButton
              variant="danger-soft"
              onPress={() =>
                Alert.alert("Delete this entry?", "This removes it from your food diary.", [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Delete",
                    style: "destructive",
                    onPress: () => {
                      try {
                        deleteEntry(entry);
                        refresh();
                        close();
                      } catch {
                        setError("Couldn't delete this entry. Try again.");
                      }
                    },
                  },
                ])
              }
            >
              Delete entry
            </SystemButton>
          )}
        </>
      )}
    </Editor>
  );
}
