import { TimeField } from "./time-field";
import { currentFoodTime, formatClock, mealAtTime, validFoodTime } from "@/lib/food-time";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Linking,
  View,
  type AccessibilityActionEvent,
  type AccessibilityActionInfo,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { SystemButton } from "@/components/system";
import { Choices, Editor, ErrorText, Field } from "@/components/ui";
import {
  Callout,
  Heading,
  IconButton,
  ListRow,
  Meta,
  Note,
  Panel,
  Text,
  useKitFormat,
} from "@/vector";
import type { FoodEntry } from "@/db";
import {
  favoriteFoods,
  recipeFoods,
  findPersonalBarcode,
  lastEntryFor,
  personalFoods,
  recentFoods,
  saveCustomFood,
  saveEntry,
  deleteEntry,
  targetsForDay,
  toggleFavorite,
  type DiaryReceipt,
} from "@/lib/diary";
import { portionFor } from "@/lib/fast-log";
import { lookupBarcode, searchCatalog } from "@/lib/food-catalog";
import { matchesQuery, rankSearch } from "@/lib/food-rank";
import { recognizeText, textRecognitionAvailable } from "@/lib/local-ai";
import { labelFound, readNutritionLabel, type LabelReading } from "@/lib/nutrition-label";
import { useNutrition, useNutritionQuery } from "@/lib/nutrition-store";
import {
  barcodeCandidates,
  countText,
  customFood,
  defaultPortion,
  meals,
  normalizeBarcode,
  nutrientInfo,
  parseAmount,
  portionItem,
  portionOf,
  portionUnits,
  shiftDay,
  unitLabel,
  type Food,
  type Meal,
  type MealItem,
  type Micro,
} from "@/lib/nutrition";
import { dayLabel, localDay, parseNumber } from "@/lib/metrics";
import { useStore } from "@/lib/store";
import { AmountPicker, PortionPreview, type AmountDraft } from "./amount-picker";
import { discardPhoto, PhotoCapture } from "./photo-capture";

/** The amount field for a food, starting at `portion` or the food's usual portion. */
function draftFor(food: Food, portion = defaultPortion(food)): AmountDraft {
  return { unit: portion.unit, text: countText(food, portion.unit, portion.count), fresh: true };
}

// Catalog names, the same in every language.
const catalogNames = { usda: "USDA", off: "Open Food Facts" } as const;
const usdaName = "USDA FoodData Central";

/** A food in a list: its name, where it comes from and its energy, opening its portion. */
export function FoodRow({
  food,
  onPress,
  trailing,
  accessibilityActions,
  onAccessibilityAction,
}: {
  food: Food;
  onPress: () => void;
  /** Replaces the chevron, e.g. with an edit button. */
  trailing?: ReactNode;
  /** A trailing button inside the row is not its own stop, so screen readers get it here. */
  accessibilityActions?: AccessibilityActionInfo[];
  onAccessibilityAction?: (event: AccessibilityActionEvent) => void;
}) {
  const { t } = useStore();
  const format = useKitFormat();
  const kcal = format.number(food.nutrients.calories);
  return (
    <ListRow
      title={food.name}
      description={t("foodSourceEnergy", {
        source:
          food.brand ||
          (food.source === "usda" || food.source === "off"
            ? catalogNames[food.source]
            : food.source === "recipe"
              ? t("recipe")
              : t("myFood")),
        energy:
          food.basis === "serving"
            ? t("kcalPerServing", { value: kcal })
            : t("kcalPer100", { value: kcal, basis: food.basis }),
      })}
      accessibilityLabel={t("logFoodNamed", { name: food.name })}
      accessibilityActions={accessibilityActions}
      onAccessibilityAction={onAccessibilityAction}
      trailing={trailing}
      onPress={onPress}
    />
  );
}

export function BarcodeCamera({
  onScan,
  skip = "",
}: {
  onScan: (value: string, symbology: string) => Promise<void>;
  /** A code just added, still in view while the camera reopens for the next one. */
  skip?: string;
}) {
  const { t } = useStore();
  const [permission, requestPermission] = useCameraPermissions();
  const [error, setError] = useState("");
  // One lookup at a time. A code that was rejected or not found is skipped while it
  // stays in view, so the camera keeps scanning for the next one.
  const scanning = useRef(false);
  const last = useRef(skip);
  if (!permission) return <Text tone="muted">{t("checkingCamera")}</Text>;
  if (!permission.granted)
    return (
      <View className="gap-3">
        <Text tone="muted">{t("allowCameraBarcode")}</Text>
        <SystemButton
          variant="secondary"
          onPress={() => {
            void (permission.canAskAgain ? requestPermission() : Linking.openSettings()).catch(() =>
              setError(t("cameraAccessUnavailableBarcode"))
            );
          }}
        >
          {t(permission.canAskAgain ? "allowCamera" : "openCameraSettings")}
        </SystemButton>
        <ErrorText message={error} />
      </View>
    );
  return (
    <View className="gap-3">
      {!error && (
        // A 1pt keyline and the 4pt corner every panel has.
        <View className="overflow-hidden rounded-control border border-border">
          <CameraView
            style={{ height: 220 }}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["ean13", "ean8", "upc_a", "upc_e", "itf14"] }}
            onMountError={() => setError(t("cameraUnavailableBarcode"))}
            onBarcodeScanned={({ data, type }) => {
              if (scanning.current || data === last.current) return;
              scanning.current = true;
              last.current = data;
              void onScan(data, type).finally(() => {
                scanning.current = false;
              });
            }}
          />
        </View>
      )}
      <ErrorText message={error} />
      <Note>{t("barcodeCameraNote")}</Note>
    </View>
  );
}

const macroFields = [
  ["calories", "caloriesKcalField"],
  ["protein", "proteinGramsField"],
  ["carbs", "carbsGramsField"],
  ["fat", "fatGramsField"],
  ["fiber", "fiberOptionalField"],
  ["sodium", "sodiumOptionalField"],
] as const;
// The label names a scan can miss, as the note lists them.
const labelNames = {
  calories: "calories",
  protein: "macroProtein",
  carbs: "macroCarbs",
  fat: "macroFat",
} as const;
// The rest of a US Nutrition Facts panel, in its order.
const labelMicros = [
  "saturatedFat",
  "transFat",
  "cholesterol",
  "sugar",
  "addedSugar",
  "vitaminD",
  "calcium",
  "iron",
  "potassium",
] as const satisfies readonly Micro[];
const noMicros = Object.fromEntries(labelMicros.map((key) => [key, ""])) as Record<
  (typeof labelMicros)[number],
  string
>;
type LabelNote = { lines: string[]; warn: boolean };

/** Photographs a Nutrition Facts panel and reads it with on-device text recognition. */
function LabelScanner({
  onRead,
  onCancel,
}: {
  onRead: (reading: LabelReading) => void;
  onCancel: () => void;
}) {
  const { t } = useStore();
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");
  async function read(uri: string) {
    setReading(true);
    setError("");
    try {
      const label = readNutritionLabel(await recognizeText(uri));
      if (labelFound(label)) onRead(label);
      else setError(t("labelNotFound"));
    } catch {
      setError(t("labelUnreadable"));
    } finally {
      discardPhoto(uri);
      setReading(false);
    }
  }
  if (reading)
    return (
      <View className="flex-row items-center gap-3 py-6" accessibilityLiveRegion="polite">
        <ActivityIndicator />
        <Text variant="bodyStrong">{t("readingLabel")}</Text>
      </View>
    );
  return (
    <View className="gap-3">
      <PhotoCapture kind="label" onPhoto={(uri) => void read(uri)} onError={setError} />
      <ErrorText message={error} />
      <Note>{t("labelScanNote")}</Note>
      <SystemButton variant="ghost" className="self-start" onPress={onCancel}>
        {t("enterValuesByHand")}
      </SystemButton>
    </View>
  );
}

/** The unit and count last logged of a food, else its usual portion. */
const rememberedPortion = (food: Food) => portionOf(portionFor(food, lastEntryFor(food.id)));

const shown = (value: number | null) => (value === null ? "" : String(Number(value.toFixed(1))));

function CustomFoodForm({
  barcode,
  scanFirst = false,
  onSave,
  onDirty,
}: {
  barcode: string;
  /** Opens the label camera straight away, e.g. after an unknown barcode. */
  scanFirst?: boolean;
  onSave: (food: Food) => void;
  /** Hears whether anything has been typed or read from a label, so the sheet can hold. */
  onDirty: (dirty: boolean) => void;
}) {
  const { t } = useStore();
  const format = useKitFormat();
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
  const [micros, setMicros] = useState(noMicros);
  const [more, setMore] = useState(false);
  const [serving, setServing] = useState({ label: "", amount: "", unit: "g" as "g" | "ml" });
  const [scanning, setScanning] = useState(scanFirst && textRecognitionAvailable());
  const [note, setNote] = useState<LabelNote | null>(null);
  const [error, setError] = useState("");
  const dirty =
    !!name.trim() ||
    !!brand.trim() ||
    code !== barcode ||
    note !== null ||
    [...Object.values(values), ...Object.values(micros), serving.label, serving.amount].some(
      (text) => text.trim()
    );
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
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
    setMicros(
      Object.fromEntries(labelMicros.map((key) => [key, shown(label[key])])) as typeof micros
    );
    if (labelMicros.some((key) => label[key] !== null)) setMore(true);
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
      ...(label.estimatedCalories ? [t("labelCaloriesEstimated")] : []),
      ...(missing.length
        ? [
            t("labelMissingValues", {
              names: format.list(missing.map((key) => t(labelNames[key]))),
            }),
          ]
        : []),
      ...(label.servingAmount === null ? [t("labelAddServingWeight")] : []),
    ];
    setNote({
      lines: [t("labelFilled"), ...lines],
      warn: lines.length > 0,
    });
    setScanning(false);
    setError("");
  }
  function save() {
    const normalized = code.trim() ? normalizeBarcode(code) : null;
    if (code.trim() && !normalized) {
      setError(t("checkBarcodeDigits"));
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
          ...Object.fromEntries(
            labelMicros.flatMap((key) =>
              micros[key].trim() ? [[key, parseNumber(micros[key])]] : []
            )
          ),
        },
        serving:
          basis === "serving"
            ? { label: serving.label, amount: optional(serving.amount), unit: serving.unit }
            : undefined,
      });
      saveCustomFood(food);
      onSave(food);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("couldNotSaveFood"));
    }
  }
  if (scanning) return <LabelScanner onRead={fill} onCancel={() => setScanning(false)} />;
  return (
    <View className="gap-4">
      {textRecognitionAvailable() && (
        <SystemButton variant="secondary" icon="scanText" onPress={() => setScanning(true)}>
          {t(note ? "scanLabelAgain" : "scanNutritionLabel")}
        </SystemButton>
      )}
      {note && (
        <Callout tone={note.warn ? "warning" : "info"}>
          {note.lines.map((line, i) => (
            <Text key={i} variant="small" tone={i && note.warn ? "warning" : "muted"}>
              {line}
            </Text>
          ))}
        </Callout>
      )}
      <Field
        label={t("foodName")}
        value={name}
        onChange={setName}
        placeholder={t("foodNamePlaceholder")}
      />
      <Field label={t("brandOptional")} value={brand} onChange={setBrand} />
      <Text variant="fieldLabel" tone="secondary">
        {t("nutritionPer")}
      </Text>
      <Choices
        values={["g", "ml", "serving"] as const}
        value={basis}
        onChange={setBasis}
        label={(value) =>
          value === "serving"
            ? t("oneServing")
            : t("amountUnit", { count: format.number(100), unit: value })
        }
      />
      {basis === "serving" && (
        <View className="flex-row flex-wrap gap-4">
          <View style={{ flexBasis: "44%", flexGrow: 1 }}>
            <Field
              label={t("servingSizeOptional")}
              value={serving.label}
              onChange={(label) => setServing((old) => ({ ...old, label }))}
              placeholder={t("servingSizePlaceholder")}
            />
          </View>
          <View style={{ flexBasis: "44%", flexGrow: 1 }}>
            <Field
              label={t("servingWeightOptional", { unit: serving.unit })}
              value={serving.amount}
              numeric
              onChange={(amount) => setServing((old) => ({ ...old, amount }))}
            />
          </View>
          <Choices
            values={["g", "ml"] as const}
            value={serving.unit}
            onChange={(unit) => setServing((old) => ({ ...old, unit }))}
            label={(value) => t(value === "g" ? "gramsUnitName" : "millilitersUnitName")}
          />
        </View>
      )}
      <View className="flex-row flex-wrap gap-4">
        {macroFields.map(([key, label]) => (
          <View key={key} style={{ flexBasis: "44%", flexGrow: 1 }}>
            <Field
              label={t(label)}
              value={values[key]}
              numeric
              onChange={(value) => setValues((old) => ({ ...old, [key]: value }))}
            />
          </View>
        ))}
      </View>
      {more ? (
        <View className="flex-row flex-wrap gap-4">
          {labelMicros.map((key) => (
            <View key={key} style={{ flexBasis: "44%", flexGrow: 1 }}>
              <Field
                label={t("nutrientField", {
                  name: nutrientInfo[key].label,
                  unit: unitLabel(nutrientInfo[key].unit),
                })}
                value={micros[key]}
                numeric
                onChange={(value) => setMicros((old) => ({ ...old, [key]: value }))}
              />
            </View>
          ))}
        </View>
      ) : (
        <SystemButton variant="ghost" className="self-start" onPress={() => setMore(true)}>
          {t("moreNutrientsFromLabel")}
        </SystemButton>
      )}
      <Note>{t("customFoodNote", { zero: format.number(0) })}</Note>
      <Field label={t("barcodeOptional")} value={code} onChange={setCode} />
      <ErrorText message={error} />
      <SystemButton onPress={save}>{t("saveFoodChoosePortion")}</SystemButton>
    </View>
  );
}

export function FoodEditor({
  close,
  initialDay = localDay(),
  initialMeal,
  initialTime,
  entry,
  initialFood,
  initialAmount,
  onPick,
  scanAnother = false,
  pickerTitle,
  pickLabel,
  initialMode = "search",
  initialQuery = "",
  onChanged,
}: {
  close: () => void;
  initialDay?: string;
  initialMeal?: Meal;
  initialTime?: string;
  entry?: FoodEntry;
  initialFood?: Food;
  initialAmount?: number;
  /**
   * Receives the amount in the food's basis and the item with its unit and label; `keepScanning`
   * when the person chose to scan another food next, so the picker stays open.
   */
  onPick?: (food: Food, amount: number, item: MealItem, keepScanning?: boolean) => void;
  /** Offers to add a picked food and reopen the camera, for scanning several foods in a row. */
  scanAnother?: boolean;
  pickerTitle?: string;
  /** Confirm label when picking, e.g. "Log" when the pick is saved straight away. */
  pickLabel?: string;
  initialMode?: "search" | "barcode" | "custom";
  /** Prefills the search, e.g. with a food a photo showed but the catalog match missed. */
  initialQuery?: string;
  /** Hears about each diary write, so the caller can offer Undo. */
  onChanged?: (receipt: DiaryReceipt, change: "saved" | "deleted") => void;
}) {
  const { refresh } = useNutrition();
  const { diaryLayout, t } = useStore();
  const format = useKitFormat();
  const [mode, setMode] = useState<"search" | "barcode" | "custom" | "portion">(
    entry || initialFood ? "portion" : initialMode
  );
  const [food, setFood] = useState<Food | undefined>(entry?.food ?? initialFood);
  const [day, setDay] = useState(entry?.day ?? initialDay);
  const [loggedTime, setLoggedTime] = useState(
    entry ? (entry.loggedTime ?? "") : (initialTime ?? currentFoodTime())
  );
  const [meal, setMeal] = useState<Meal>(
    () => entry?.meal ?? initialMeal ?? mealAtTime(initialTime ?? currentFoodTime())
  );
  // The day and time fold into one line; tapping it opens the pickers.
  const [when, setWhen] = useState(false);
  // An entry opens at the unit and count it was logged in; left alone, its amount and label stay.
  // A new food opens at what was last logged of it.
  const [start] = useState<AmountDraft>(() =>
    entry
      ? draftFor(entry.food, portionOf(entry))
      : initialFood
        ? draftFor(
            initialFood,
            initialAmount === undefined
              ? rememberedPortion(initialFood)
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
  const [lastCode, setLastCode] = useState("");
  const [notFound, setNotFound] = useState(false);
  // An unknown barcode goes straight to photographing its label.
  const [scanLabel, setScanLabel] = useState(false);
  const [favorites, setFavorites] = useState(() => favoriteFoods());
  // A typed custom food, or a portion changed from how it opened, holds the sheet.
  const [typed, setTyped] = useState(false);
  const portionState = JSON.stringify([food?.id, amount.unit, amount.text, day, loggedTime, meal]);
  const [opened, setOpened] = useState(portionState);
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
      searchCatalog(query, known)
        .then(({ foods, fixes }) => {
          if (!active) return;
          // A typo the catalog corrected ("chiken") finds the person's own foods too.
          const matched = rankSearch(
            query,
            mine.filter((item) => matchesQuery(query, item, fixes)),
            known,
            { fixes }
          );
          const shown = new Set(matched.map((item) => item.id));
          setResults([...matched, ...foods.filter((food) => !shown.has(food.id))]);
        })
        .catch(() => {
          if (active) {
            setResults(own);
            setError(t("bundledCatalogUnavailable"));
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
  }, [mode, query, favorites, recent, personal, t]);

  function select(selected: Food) {
    const draft = draftFor(selected, rememberedPortion(selected));
    setFood(selected);
    setAmount(draft);
    setOpened(JSON.stringify([selected.id, draft.unit, draft.text, day, loggedTime, meal]));
    setMode("portion");
    setError("");
  }
  async function scan(input: string, symbology?: string) {
    setBarcode(input);
    setBusy(true);
    setError("");
    setNotFound(false);
    // An 8-digit code can be EAN-8 or UPC-E; catalogs hold products under either form.
    const codes = barcodeCandidates(input, symbology);
    if (!codes.length) {
      setError(t("invalidFoodBarcode"));
      setBusy(false);
      return;
    }
    try {
      let found = findPersonalBarcode(input, symbology);
      for (let i = 0; !found && i < codes.length; i++) found = await lookupBarcode(codes[i]);
      if (found) select(found);
      else setNotFound(true);
    } catch {
      setError(t("foodCatalogUnavailable"));
    } finally {
      setBusy(false);
    }
  }
  function save(keepScanning = false) {
    if (!food || saveLock.current) return;
    saveLock.current = true;
    try {
      const kept =
        entry && food === entry.food && amount.unit === start.unit && amount.text === start.text;
      const item: MealItem = kept
        ? entry
        : portionItem(food, amount.unit, parseAmount(amount.text), { previous: entry });
      if (onPick) {
        onPick(food, item.amount, item, keepScanning);
        if (!keepScanning) {
          close();
          return;
        }
        saveLock.current = false;
        setLastCode(barcode);
        setBarcode("");
        setFood(undefined);
        setError("");
        setNotFound(false);
        setScanLabel(false);
        setMode("barcode");
        return;
      }
      if (!entry && !loggedTime) throw new Error(t("chooseEntryTime"));
      const receipt = saveEntry({
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
      onChanged?.(receipt, "saved");
    } catch (e) {
      setError(e instanceof Error ? e.message : t("couldNotSaveEntry"));
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
          ? (pickerTitle ?? t("addIngredient"))
          : t(
              entry
                ? "editFood"
                : mode === "custom"
                  ? "createAFood"
                  : mode === "portion"
                    ? "logFood"
                    : "addFood"
            )
      }
      open
      close={close}
      dirty={(mode === "custom" && typed) || (mode === "portion" && portionState !== opened)}
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
                    ? (pickLabel ?? t(pickerTitle ? "addToMeal" : "useIngredient"))
                    : entry
                      ? t("saveChanges")
                      : diaryLayout === "timeline"
                        ? t("logAtTime", {
                            time: validFoodTime(loggedTime)
                              ? formatClock(loggedTime, format.tag)
                              : loggedTime,
                          })
                        : t("addToNamedMeal", { meal: meal.toLowerCase() }),
                  onPress: () => save(),
                },
              ]}
            />
            {/* Its own row: the actions row above has no room for a third label. */}
            {scanAnother && onPick && (
              <SystemButton variant="secondary" icon="scan" onPress={() => save(true)}>
                {t("addAndScanAnother")}
              </SystemButton>
            )}
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
          {t("backToSearch")}
        </SystemButton>
      )}
      {mode === "search" && (
        <>
          <Field
            label={t("searchFoods")}
            value={query}
            onChange={(value) => {
              setQuery(value);
              setResults([]);
              setBusy(false);
            }}
            placeholder={t("searchFoodsPlaceholder")}
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
              {t("scanBarcode")}
            </SystemButton>
            <SystemButton
              className="flex-1"
              variant="outline"
              onPress={() => {
                setError("");
                setMode("custom");
              }}
            >
              {t("createFood")}
            </SystemButton>
          </View>
          <ErrorText message={error} />
          <Note>
            {query.trim()
              ? busy
                ? t("searchingOnPhone")
                : t(format.plural(results.length) === "one" ? "matchCountOne" : "matchCount", {
                    count: format.number(results.length),
                  })
              : t(history.length ? "savedAndRecentFoods" : "searchOrCreateFood")}
          </Note>
          {!!(query.trim() ? results : history).length && (
            <Panel inset="none">
              {(query.trim() ? results : history).map((item) => (
                <FoodRow key={item.id} food={item} onPress={() => select(item)} />
              ))}
            </Panel>
          )}
          {query.trim() && !busy && !results.length && !error && (
            <Text tone="muted">{t("trySimplerFoodName")}</Text>
          )}
        </>
      )}
      {mode === "barcode" && (
        <>
          <BarcodeCamera onScan={scan} skip={lastCode} />
          <Field label={t("barcodeDigits")} value={barcode} onChange={setBarcode} />
          <SystemButton
            isDisabled={busy}
            onPress={() => {
              void scan(barcode);
            }}
          >
            {t(busy ? "lookingUp" : "lookUpBarcode")}
          </SystemButton>
          <ErrorText message={error} />
          {notFound && <Text tone="muted">{t("productNotInCatalog")}</Text>}
          {notFound && textRecognitionAvailable() && (
            <SystemButton
              icon="scanText"
              onPress={() => {
                setScanLabel(true);
                setMode("custom");
              }}
            >
              {t("scanItsNutritionLabel")}
            </SystemButton>
          )}
          <SystemButton variant="outline" onPress={() => setMode("custom")}>
            {t(notFound ? "enterLabelByHand" : "createThisFood")}
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
          onDirty={setTyped}
        />
      )}
      {mode === "portion" && food && (
        <>
          <View className="flex-row items-start gap-1">
            <View className="flex-1 gap-1">
              <Heading level={3}>{food.name}</Heading>
              <Meta
                items={[
                  food.brand,
                  food.source === "usda"
                    ? usdaName
                    : food.source === "off"
                      ? t("offCheckLabel")
                      : t(food.source === "recipe" ? "myRecipe" : "myFood"),
                ]}
              />
            </View>
            <IconButton
              icon="favorite"
              tone={favorites.some((item) => item.id === food.id) ? "tint" : "foreground"}
              accessibilityLabel={
                favorites.some((item) => item.id === food.id)
                  ? t("removeFromSavedFoods")
                  : t("saveToLibrary")
              }
              accessibilityState={{ selected: favorites.some((item) => item.id === food.id) }}
              onPress={() => {
                toggleFavorite(food);
                setFavorites(favoriteFoods());
                refresh();
              }}
            />
          </View>
          {!onPick && (
            <SystemButton
              variant="ghost"
              icon="time"
              className="self-start px-2"
              accessibilityHint={t("changeFoodTimeHint")}
              accessibilityState={{ expanded: when }}
              onPress={() => setWhen((open) => !open)}
            >
              {t(diaryLayout === "meals" ? "whenMeal" : "whenTime", {
                day:
                  day === localDay()
                    ? t("today")
                    : day === shiftDay(localDay(), -1)
                      ? t("yesterday")
                      : dayLabel(day, format.tag),
                time: validFoodTime(loggedTime) ? formatClock(loggedTime, format.tag) : t("noTime"),
                meal,
              })}
            </SystemButton>
          )}
          {!onPick && when && (
            <>
              <TimeField
                value={loggedTime}
                onChange={setLoggedTime}
                allowEmpty={!!entry && !entry.loggedTime}
                day={day}
                onDayChange={setDay}
              />
              {diaryLayout === "meals" && (
                <Choices values={meals} value={meal} onChange={setMeal} label={(value) => value} />
              )}
            </>
          )}
          <PortionPreview nutrients={preview} targets={targets} />
          {entry && (
            <SystemButton
              variant="danger-soft"
              onPress={() => {
                // No confirmation: Home offers Undo instead.
                if (saveLock.current) return;
                saveLock.current = true;
                try {
                  const receipt = deleteEntry(entry);
                  refresh();
                  close();
                  onChanged?.(receipt, "deleted");
                } catch {
                  saveLock.current = false;
                  setError(t("couldNotDeleteEntry"));
                }
              }}
            >
              {t("deleteEntry")}
            </SystemButton>
          )}
        </>
      )}
    </Editor>
  );
}
