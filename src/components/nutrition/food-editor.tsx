import { TimeField } from "./time-field";
import { currentFoodTime, formatClock, mealAtTime, validFoodTime } from "@/lib/food-time";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Linking, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { SystemButton, SystemIconButton, SystemText as Text } from "@/components/system";
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
  targetsForDay,
  toggleFavorite,
} from "@/lib/diary";
import { lookupBarcode, searchFoods } from "@/lib/food-catalog";
import { matchesQuery, rankSearch } from "@/lib/food-rank";
import { recognizeText, textRecognitionAvailable } from "@/lib/local-ai";
import { labelFound, readNutritionLabel, type LabelReading } from "@/lib/nutrition-label";
import { useNutrition, useNutritionQuery } from "@/lib/nutrition-store";
import {
  countText,
  customFood,
  defaultPortion,
  meals,
  normalizeBarcode,
  parseAmount,
  portionItem,
  portionOf,
  portionUnits,
  type Food,
  type Meal,
  type MealItem,
} from "@/lib/nutrition";
import { localDay, parseNumber } from "@/lib/metrics";
import { useStore } from "@/lib/store";
import { AmountPicker, PortionPreview, type AmountDraft } from "./amount-picker";
import { discardPhoto, PhotoCapture } from "./photo-capture";

/** The amount field for a food, starting at `portion` or the food's usual portion. */
function draftFor(food: Food, portion = defaultPortion(food)): AmountDraft {
  return { unit: portion.unit, text: countText(food, portion.unit, portion.count), fresh: true };
}

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

const macroFields = [
  ["calories", "Calories (kcal)"],
  ["protein", "Protein (g)"],
  ["carbs", "Carbs (g)"],
  ["fat", "Fat (g)"],
  ["fiber", "Fiber (g, optional)"],
  ["sodium", "Sodium (mg, optional)"],
] as const;
type LabelNote = { lines: string[]; warn: boolean };

/** Photographs a Nutrition Facts panel and reads it with on-device text recognition. */
function LabelScanner({
  onRead,
  onCancel,
}: {
  onRead: (reading: LabelReading) => void;
  onCancel: () => void;
}) {
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");
  async function read(uri: string) {
    setReading(true);
    setError("");
    try {
      const label = readNutritionLabel(await recognizeText(uri));
      if (labelFound(label)) onRead(label);
      else
        setError(
          "Couldn't find Nutrition Facts in that photo. Fill the frame with the label, hold it flat and avoid glare."
        );
    } catch {
      setError("Couldn't read that photo. Try again.");
    } finally {
      discardPhoto(uri);
      setReading(false);
    }
  }
  if (reading)
    return (
      <View className="flex-row items-center gap-3 py-6" accessibilityLiveRegion="polite">
        <ActivityIndicator />
        <Text className="font-medium">Reading the label…</Text>
      </View>
    );
  return (
    <View className="gap-3">
      <PhotoCapture
        subject="the Nutrition Facts label"
        alternative="enter the values"
        aspectRatio={3 / 4}
        onPhoto={(uri) => void read(uri)}
        onError={setError}
      />
      <ErrorText message={error} />
      <Text className="text-sm text-muted">
        Read on this phone. You can check every value before saving.
      </Text>
      <SystemButton variant="ghost" className="self-start" onPress={onCancel}>
        Enter values by hand
      </SystemButton>
    </View>
  );
}

const shown = (value: number | null) => (value === null ? "" : String(Number(value.toFixed(1))));

function CustomFoodForm({
  barcode,
  scanFirst = false,
  onSave,
}: {
  barcode: string;
  /** Opens the label camera straight away, e.g. after an unknown barcode. */
  scanFirst?: boolean;
  onSave: (food: Food) => void;
}) {
  const [name, setName] = useState("");
  const [brand, setBrand] = useState("");
  const [code, setCode] = useState(barcode);
  const [basis, setBasis] = useState<Food["basis"]>("g");
  const [values, setValues] = useState({
    calories: "",
    protein: "",
    carbs: "",
    fat: "",
    fiber: "",
    sodium: "",
  });
  const [serving, setServing] = useState({ label: "", amount: "", unit: "g" as "g" | "ml" });
  const [scanning, setScanning] = useState(scanFirst && textRecognitionAvailable());
  const [note, setNote] = useState<LabelNote | null>(null);
  const [error, setError] = useState("");
  function fill(label: LabelReading) {
    setBasis("serving");
    setValues({
      calories: shown(label.calories),
      protein: shown(label.protein),
      carbs: shown(label.carbs),
      fat: shown(label.fat),
      fiber: shown(label.fiber),
      sodium: shown(label.sodium),
    });
    setServing({
      label: label.servingLabel,
      amount: label.servingAmount === null ? "" : String(label.servingAmount),
      unit: label.servingUnit ?? "g",
    });
    const missing = (["calories", "protein", "carbs", "fat"] as const).filter(
      (key) => label[key] === null
    );
    const lines = [
      ...label.warnings,
      ...(label.estimatedCalories
        ? ["Calories weren't in the photo, so they're estimated from fat, carbs and protein."]
        : []),
      ...(missing.length ? [`Not found: ${missing.join(", ")}. Enter them from the label.`] : []),
      ...(label.servingAmount === null ? ["Add the serving weight to log by grams too."] : []),
    ];
    setNote({
      lines: ["Filled from the label. Check each value.", ...lines],
      warn: lines.length > 0,
    });
    setScanning(false);
    setError("");
  }
  function save() {
    const normalized = code.trim() ? normalizeBarcode(code) : null;
    if (code.trim() && !normalized) {
      setError("Check the barcode digits, or leave the barcode blank.");
      return;
    }
    const optional = (text: string) => (text.trim() ? parseNumber(text) : null);
    try {
      const food = customFood({
        name,
        brand,
        barcode: normalized,
        basis,
        nutrients: {
          calories: parseNumber(values.calories),
          protein: parseNumber(values.protein),
          carbs: parseNumber(values.carbs),
          fat: parseNumber(values.fat),
          fiber: optional(values.fiber),
          sodium: optional(values.sodium),
        },
        serving:
          basis === "serving"
            ? { label: serving.label, amount: optional(serving.amount), unit: serving.unit }
            : undefined,
      });
      saveCustomFood(food);
      onSave(food);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save this food.");
    }
  }
  if (scanning) return <LabelScanner onRead={fill} onCancel={() => setScanning(false)} />;
  return (
    <View className="gap-4">
      {textRecognitionAvailable() && (
        <SystemButton variant="secondary" icon="scan-outline" onPress={() => setScanning(true)}>
          {note ? "Scan the label again" : "Scan nutrition label"}
        </SystemButton>
      )}
      {note && (
        <View className="gap-1 rounded-2xl bg-surface p-3" accessibilityLiveRegion="polite">
          {note.lines.map((line, i) => (
            <Text key={i} className={`text-sm ${i && note.warn ? "text-warning" : "text-muted"}`}>
              {line}
            </Text>
          ))}
        </View>
      )}
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
      {basis === "serving" && (
        <View className="flex-row flex-wrap gap-4">
          <View style={{ flexBasis: "44%", flexGrow: 1 }}>
            <Field
              label="Serving size (optional)"
              value={serving.label}
              onChange={(label) => setServing((old) => ({ ...old, label }))}
              placeholder="e.g. 2/3 cup"
            />
          </View>
          <View style={{ flexBasis: "44%", flexGrow: 1 }}>
            <Field
              label={`Serving weight (${serving.unit}, optional)`}
              value={serving.amount}
              numeric
              onChange={(amount) => setServing((old) => ({ ...old, amount }))}
            />
          </View>
          <Choices
            values={["g", "ml"] as const}
            value={serving.unit}
            onChange={(unit) => setServing((old) => ({ ...old, unit }))}
            label={(value) => (value === "g" ? "Grams" : "Milliliters")}
          />
        </View>
      )}
      <View className="flex-row flex-wrap gap-4">
        {macroFields.map(([key, label]) => (
          <View key={key} style={{ flexBasis: "44%", flexGrow: 1 }}>
            <Field
              label={label}
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
  pickLabel,
  initialMode = "search",
  initialQuery = "",
}: {
  close: () => void;
  initialDay?: string;
  initialMeal?: Meal;
  initialTime?: string;
  entry?: FoodEntry;
  initialFood?: Food;
  initialAmount?: number;
  /** Receives the amount in the food's basis, and the item with its unit and label. */
  onPick?: (food: Food, amount: number, item: MealItem) => void;
  pickerTitle?: string;
  /** Confirm label when picking, e.g. "Log" when the pick is saved straight away. */
  pickLabel?: string;
  initialMode?: "search" | "barcode" | "custom";
  /** Prefills the search, e.g. with a food a photo showed but the catalog match missed. */
  initialQuery?: string;
}) {
  const { refresh } = useNutrition();
  const { diaryLayout } = useStore();
  const [mode, setMode] = useState<"search" | "barcode" | "custom" | "portion">(
    entry || initialFood ? "portion" : initialMode
  );
  const [food, setFood] = useState<Food | undefined>(entry?.food ?? initialFood);
  const [day, setDay] = useState(entry?.day ?? initialDay);
  const [loggedTime, setLoggedTime] = useState(
    entry ? (entry.loggedTime ?? "") : (initialTime ?? currentFoodTime())
  );
  const [meal, setMeal] = useState<Meal>(entry?.meal ?? initialMeal);
  // An entry opens at the unit and count it was logged in; left alone, its amount and label stay.
  const [start] = useState<AmountDraft>(() =>
    entry
      ? draftFor(entry.food, portionOf(entry))
      : initialFood
        ? draftFor(
            initialFood,
            initialAmount === undefined
              ? undefined
              : { unit: initialFood.basis, count: initialAmount }
          )
        : { unit: "", text: "", fresh: true }
  );
  const [amount, setAmount] = useState(start);
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<Food[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [barcode, setBarcode] = useState("");
  const [notFound, setNotFound] = useState(false);
  // An unknown barcode goes straight to photographing its label.
  const [scanLabel, setScanLabel] = useState(false);
  const [favorites, setFavorites] = useState(() => favoriteFoods());
  const saveLock = useRef(false);
  // Only the search list shows history, so typing an amount or a label doesn't read it.
  const { recent, personal } = useNutritionQuery(
    () =>
      mode === "search"
        ? { recent: recentFoods(), personal: [...personalFoods(), ...recipeFoods()] }
        : { recent: [], personal: [] },
    [mode]
  );
  useEffect(() => {
    let active = true;
    if (mode !== "search" || !query.trim()) return;
    const timer = setTimeout(() => {
      setBusy(true);
      setError("");
      // The person's own foods first, then the catalog, each ranked for the search.
      const mine = [
        ...new Map([...favorites, ...recent, ...personal].map((item) => [item.id, item])).values(),
      ];
      const known = new Set(mine.map((item) => item.id));
      const own = rankSearch(
        query,
        mine.filter((item) => matchesQuery(query, item)),
        known
      );
      const shown = new Set(own.map((item) => item.id));
      searchFoods(query, known)
        .then((foods) => {
          if (active) setResults([...own, ...foods.filter((food) => !shown.has(food.id))]);
        })
        .catch(() => {
          if (active) {
            setResults(own);
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
  }, [mode, query, favorites, recent, personal]);

  function select(selected: Food) {
    setFood(selected);
    setAmount(draftFor(selected));
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
      const kept =
        entry && food === entry.food && amount.unit === start.unit && amount.text === start.text;
      const item: MealItem = kept
        ? entry
        : portionItem(food, amount.unit, parseAmount(amount.text), { previous: entry });
      if (onPick) {
        onPick(food, item.amount, item);
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
        amount: item.amount,
        portionLabel: item.portionLabel,
        portionUnit: item.portionUnit,
        portionCount: item.portionCount,
      });
      refresh();
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save this entry.");
      saveLock.current = false;
    }
  }
  const history = [
    ...new Map([...favorites, ...recent, ...personal].map((item) => [item.id, item])).values(),
  ].slice(0, 25);
  let preview = null;
  if (food) {
    try {
      preview = portionItem(food, amount.unit, parseAmount(amount.text)).nutrients;
    } catch {
      /* Validation is shown on save. */
    }
  }
  const picking = !!onPick;
  const targets = useNutritionQuery(
    () => (mode === "portion" && !picking ? targetsForDay(day) : null),
    [mode, picking, day]
  );
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
      compact={!!onPick}
      footer={
        mode === "portion" && food ? (
          <View className="gap-2">
            <ErrorText message={error} />
            <AmountPicker
              units={portionUnits(food)}
              value={amount}
              onChange={(next) => {
                setAmount(next);
                setError("");
              }}
              actions={[
                {
                  label: onPick
                    ? (pickLabel ?? (pickerTitle ? "Add to meal" : "Use ingredient"))
                    : entry
                      ? "Save changes"
                      : diaryLayout === "timeline"
                        ? `Log at ${validFoodTime(loggedTime) ? formatClock(loggedTime) : loggedTime}`
                        : `Add to ${meal.toLowerCase()}`,
                  onPress: save,
                },
              ]}
            />
          </View>
        ) : undefined
      }
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
          {notFound && textRecognitionAvailable() && (
            <SystemButton
              icon="scan-outline"
              onPress={() => {
                setScanLabel(true);
                setMode("custom");
              }}
            >
              Scan its nutrition label
            </SystemButton>
          )}
          <SystemButton variant="outline" onPress={() => setMode("custom")}>
            {notFound ? "Enter the label by hand" : "Create this food"}
          </SystemButton>
        </>
      )}
      {mode === "custom" && (
        <CustomFoodForm
          barcode={barcode}
          scanFirst={scanLabel}
          onSave={(value) => {
            refresh();
            select(value);
          }}
        />
      )}
      {mode === "portion" && food && (
        <>
          <View className="flex-row items-start gap-1">
            <View className="flex-1 gap-1">
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
            </View>
            <SystemIconButton
              icon={favorites.some((item) => item.id === food.id) ? "heart" : "heart-outline"}
              color={
                favorites.some((item) => item.id === food.id)
                  ? "accent-soft-foreground"
                  : "foreground"
              }
              accessibilityLabel={
                favorites.some((item) => item.id === food.id)
                  ? "Remove from saved foods"
                  : "Save to my library"
              }
              onPress={() => {
                toggleFavorite(food);
                setFavorites(favoriteFoods());
                refresh();
              }}
            />
          </View>
          {/* Correcting an entry is mostly its time, so there the fields come first. */}
          {!entry && <PortionPreview nutrients={preview} targets={targets} />}
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
          {!!entry && <PortionPreview nutrients={preview} targets={targets} />}
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
