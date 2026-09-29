import { TimeField } from "./time-field";
import {
  currentFoodTime,
  formatClock,
  inFoodGroup,
  mealAtTime,
  validFoodTime,
} from "@/lib/food-time";
import { useRef, useState } from "react";
import { Alert, View } from "react-native";
import { SystemButton } from "@/components/system";
import { Choices, Editor, ErrorText, Field } from "@/components/ui";
import { ListRow, Meta, Note, Panel, Text, Value, useKitFormat } from "@/vector";
import {
  copyEntries,
  copyMeal,
  deleteSavedMeal,
  entriesForDay,
  listSavedMeals,
  logSavedMeal,
  saveMeal,
  type DiaryReceipt,
} from "@/lib/diary";
import { localDay, parseNumber } from "@/lib/metrics";
import { meals, totalNutrients, type Meal } from "@/lib/nutrition";
import { useNutrition, useNutritionQuery } from "@/lib/nutrition-store";
import { useStore } from "@/lib/store";
import type { SavedMeal } from "@/db";

/** Stands in for a total that cannot be worked out yet: never 0, which would be a claim. */
const unknownMark = "—";

export function MealEditor({
  source,
  saved,
  initialDay = localDay(),
  initialMeal,
  initialTime,
  close,
  onLogged,
}: {
  /** A meal or hour group of a day, or with `ids`, foods chosen on Home. */
  source?: { day: string; meal: Meal; group?: string; ids?: number[] };
  saved?: SavedMeal;
  initialDay?: string;
  initialMeal?: Meal;
  initialTime?: string;
  close: () => void;
  onLogged?: (receipt: DiaryReceipt) => void;
}) {
  const { refresh } = useNutrition();
  const { number, date, diaryLayout, t } = useStore();
  const format = useKitFormat();
  const available = useNutritionQuery(listSavedMeals);
  const sourceItems = useNutritionQuery(
    () =>
      source
        ? entriesForDay(source.day).filter((entry) =>
            source.ids
              ? source.ids.includes(entry.id)
              : inFoodGroup(entry, source.meal, source.group)
          )
        : [],
    [source?.day, source?.meal, source?.group, source?.ids]
  );
  const [selected, setSelected] = useState(saved);
  const [mode, setMode] = useState<"save" | "copy">("save");
  const [name, setName] = useState(source?.meal ?? "");
  const [day, setDay] = useState(initialDay);
  const [loggedTime, setLoggedTime] = useState(initialTime || currentFoodTime());
  const [meal, setMeal] = useState<Meal>(() => initialMeal ?? mealAtTime(loggedTime));
  const [quantity, setQuantity] = useState("1");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  // The choices the sheet opened with; changing any holds it until Cancel or the action.
  const [opened] = useState(() => JSON.stringify([mode, name, day, loggedTime, meal, quantity]));
  const dirty =
    !success && JSON.stringify([mode, name, day, loggedTime, meal, quantity]) !== opened;
  const locked = useRef(false);
  const items = source ? sourceItems : (selected?.items ?? []);
  const totals = totalNutrients(items.map((item) => item.nutrients));
  const factor = source ? 1 : parseNumber(quantity);
  const validFactor = Number.isFinite(factor) && factor > 0 && factor <= 100;
  function submit() {
    if (locked.current) return;
    locked.current = true;
    try {
      if (source && mode === "save") {
        const result = saveMeal(name, source.day, source.meal, source.group, source.ids);
        refresh();
        setSuccess(t("mealSavedToLibrary", { name: result.name }));
      } else {
        const destinationMeal = diaryLayout === "timeline" ? mealAtTime(loggedTime) : meal;
        let receipt: DiaryReceipt;
        if (source?.ids) receipt = copyEntries(source.ids, day, loggedTime, destinationMeal);
        else if (source)
          receipt = copyMeal(
            source.day,
            source.meal,
            day,
            destinationMeal,
            loggedTime,
            source.group
          );
        else if (selected)
          receipt = logSavedMeal(selected.id, day, destinationMeal, factor, loggedTime);
        else throw new Error(t("chooseSavedMealFirst"));
        refresh();
        onLogged?.(receipt);
        close();
      }
      setError("");
    } catch (e) {
      locked.current = false;
      setError(e instanceof Error ? e.message : t("couldNotSaveMeal"));
    }
  }
  const locale = format.tag;
  const clock = validFoodTime(loggedTime) ? formatClock(loggedTime, locale) : loggedTime;
  const destination = diaryLayout === "timeline" ? clock : meal.toLowerCase();
  return (
    <Editor
      title={
        source?.ids
          ? t(format.plural(source.ids.length) === "one" ? "reuseFoodsOne" : "reuseFoods", {
              count: format.number(source.ids.length),
            })
          : source
            ? t("reuseNamed", {
                name:
                  source.group && source.group !== "untimed"
                    ? formatClock(`${source.group}:00`, locale)
                    : source.meal.toLowerCase(),
              })
            : selected
              ? selected.name
              : t("savedMeals")
      }
      open
      close={close}
      dirty={dirty}
    >
      {success ? (
        <View className="gap-4">
          <Text tone="success" accessibilityLiveRegion="polite">
            {success}
          </Text>
          <SystemButton onPress={close}>{t("done")}</SystemButton>
        </View>
      ) : !source && !selected ? (
        <View className="gap-3">
          <Text tone="muted">{t("savedMealsIntro")}</Text>
          {!available.length && <Text tone="muted">{t("savedMealsEmpty")}</Text>}
          {!!available.length && (
            <Panel inset="none">
              {available.map((item) => (
                <ListRow
                  key={item.id}
                  title={item.name}
                  description={t("mealSummary", {
                    count: format.number(item.items.length),
                    kcal: format.number(
                      totalNutrients(item.items.map((food) => food.nutrients)).calories
                    ),
                  })}
                  onPress={() => setSelected(item)}
                />
              ))}
            </Panel>
          )}
        </View>
      ) : (
        <>
          {source && (
            <Choices
              values={["save", "copy"] as const}
              value={mode}
              onChange={(value) => {
                setMode(value);
                setError("");
              }}
              label={(value) => t(value === "save" ? "saveMeal" : "copyMeal")}
            />
          )}
          {!source && !saved && (
            <SystemButton
              variant="ghost"
              className="self-start"
              onPress={() => {
                setSelected(undefined);
                setError("");
              }}
            >
              {t("allSavedMeals")}
            </SystemButton>
          )}
          <Panel>
            <Panel.Body className="gap-4">
              <View className="gap-1">
                {source ? (
                  <Meta items={source.ids ? [date(source.day)] : [source.meal, date(source.day)]} />
                ) : (
                  <Note>{t("mealPreview")}</Note>
                )}
                <Value
                  size="l"
                  value={validFactor ? format.number(totals.calories * factor) : unknownMark}
                  unit={t("kcal")}
                />
                {validFactor && (
                  <Meta
                    items={[
                      t("proteinGrams", { value: format.number(totals.protein * factor, 1) }),
                      t("carbsGrams", { value: format.number(totals.carbs * factor, 1) }),
                      t("fatGrams", { value: format.number(totals.fat * factor, 1) }),
                    ]}
                  />
                )}
              </View>
              {items.map((item, index) => (
                <View key={index} className="gap-1">
                  <Text>{item.food.name}</Text>
                  <Note>
                    {factor !== 1 && validFactor
                      ? t("portionTimes", { portion: item.portionLabel, factor: number(factor, 2) })
                      : item.portionLabel}
                  </Note>
                </View>
              ))}
            </Panel.Body>
          </Panel>
          {source && mode === "save" ? (
            <>
              <Field
                label={t("mealName")}
                value={name}
                onChange={setName}
                placeholder={t("mealNamePlaceholder")}
              />
              <Note>{t("saveMealNote")}</Note>
            </>
          ) : (
            <>
              {!source && (
                <Field
                  label={t("mealQuantity")}
                  value={quantity}
                  onChange={setQuantity}
                  numeric
                  placeholder={format.number(1)}
                />
              )}
              {!source && (
                <Note>
                  {t("mealQuantityNote", { half: format.number(0.5, 1), double: format.number(2) })}
                </Note>
              )}
              <TimeField
                value={loggedTime}
                onChange={setLoggedTime}
                day={day}
                onDayChange={setDay}
              />
              {diaryLayout !== "timeline" && (
                <Choices values={meals} value={meal} onChange={setMeal} label={(value) => value} />
              )}
              <Note>
                {t(format.plural(items.length) === "one" ? "copyMealNoteOne" : "copyMealNote", {
                  count: format.number(items.length),
                  destination,
                  date: date(day),
                })}
              </Note>
            </>
          )}
          <ErrorText message={error} />
          <SystemButton onPress={submit}>
            {source && mode === "save"
              ? t("saveToLibraryAction")
              : diaryLayout === "timeline"
                ? t("logAtTime", { time: clock })
                : t("addToNamedMeal", { meal: destination })}
          </SystemButton>
          {!source && selected && (
            <SystemButton
              variant="danger-soft"
              onPress={() =>
                Alert.alert(t("removeSavedMealTitle"), t("removeSavedMealBody"), [
                  { text: t("cancel"), style: "cancel" },
                  {
                    text: t("remove"),
                    style: "destructive",
                    onPress: () => {
                      try {
                        deleteSavedMeal(selected.id);
                        refresh();
                        close();
                      } catch {
                        setError(t("couldNotRemoveMeal"));
                      }
                    },
                  },
                ])
              }
            >
              {t("removeFromLibrary")}
            </SystemButton>
          )}
        </>
      )}
    </Editor>
  );
}
