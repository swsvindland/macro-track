import { useRef, useState } from "react";
import { View } from "react-native";
import { SystemButton, SystemText as Text } from "@/components/system";
import { Choices, DateInput, Editor, ErrorText } from "@/components/ui";
import type { FoodEntry } from "@/db";
import { copyDay, entriesForDay, moveEntries, type DiaryReceipt } from "@/lib/diary";
import { currentFoodTime } from "@/lib/food-time";
import { meals, shiftDay, type Meal } from "@/lib/nutrition";
import { useNutrition, useNutritionQuery } from "@/lib/nutrition-store";
import { useStore } from "@/lib/store";
import { TimeField } from "./time-field";

export function CopyDay({
  destination,
  close,
  onLogged,
}: {
  destination: string;
  close: () => void;
  onLogged?: (receipt: DiaryReceipt) => void;
}) {
  const [source, setSource] = useState(shiftDay(destination, -1));
  const [error, setError] = useState("");
  const locked = useRef(false);
  const { refresh } = useNutrition();
  const { date } = useStore();
  const entries = useNutritionQuery(() => entriesForDay(source), [source]);
  return (
    <Editor title="Copy a day" open close={close}>
      <DateInput label="Copy food from" value={source} onChange={setSource} />
      <Text>
        {entries.length} foods will be added to {date(destination)}, keeping their times, meals and
        quantities. Existing food stays in place.
      </Text>
      <ErrorText message={error} />
      <SystemButton
        isDisabled={!entries.length || source === destination}
        onPress={() => {
          if (locked.current) return;
          locked.current = true;
          try {
            const receipt = copyDay(source, destination);
            refresh();
            close();
            onLogged?.(receipt);
          } catch (e) {
            locked.current = false;
            setError(e instanceof Error ? e.message : "Could not copy this day.");
          }
        }}
      >
        Add {entries.length} foods
      </SystemButton>
    </Editor>
  );
}

/** Moves diary entries to another day, time or meal in one step. */
export function MoveEntries({
  entries,
  close,
  onMoved,
}: {
  entries: FoodEntry[];
  close: () => void;
  onMoved: (receipt: DiaryReceipt) => void;
}) {
  const { refresh } = useNutrition();
  const { diaryLayout } = useStore();
  const times = new Set(entries.map((entry) => entry.loggedTime));
  // Foods eaten at different times, or older foods without one, can keep them,
  // e.g. when only the day was wrong.
  const mixed = times.size > 1 || times.has(null);
  // Likewise foods from different meals keep theirs unless one meal is chosen.
  const mixedMeals = new Set(entries.map((entry) => entry.meal)).size > 1;
  const mealChoices: readonly (Meal | "keep")[] = mixedMeals ? ["keep", ...meals] : meals;
  const [day, setDay] = useState(entries[0].day);
  const [keep, setKeep] = useState<"keep" | "one">(mixed ? "keep" : "one");
  const [time, setTime] = useState(entries[0].loggedTime ?? currentFoodTime());
  const [meal, setMeal] = useState<Meal | "keep">(mixedMeals ? "keep" : entries[0].meal);
  const [error, setError] = useState("");
  const locked = useRef(false);
  const count = entries.length === 1 ? entries[0].food.name : `${entries.length} foods`;
  function move() {
    if (locked.current) return;
    locked.current = true;
    try {
      const receipt = moveEntries(
        entries.map((entry) => entry.id),
        day,
        keep === "keep" ? null : time,
        diaryLayout === "timeline" ? undefined : meal === "keep" ? null : meal
      );
      refresh();
      close();
      onMoved(receipt);
    } catch (e) {
      locked.current = false;
      setError(e instanceof Error ? e.message : "Could not move these foods.");
    }
  }
  return (
    <Editor
      title={`Move ${count}`}
      open
      close={close}
      compact
      footer={
        <View className="gap-2">
          <ErrorText message={error} />
          <SystemButton onPress={move}>Move</SystemButton>
        </View>
      }
    >
      <DateInput label="Date" value={day} onChange={setDay} />
      {mixed && (
        <Choices
          values={["keep", "one"] as const}
          value={keep}
          onChange={setKeep}
          label={(value) =>
            value === "one"
              ? "Set a time"
              : entries.length === 1
                ? "Keep its time"
                : "Keep their times"
          }
        />
      )}
      {keep === "one" && <TimeField value={time} onChange={setTime} />}
      {diaryLayout !== "timeline" && (
        <Choices
          values={mealChoices}
          value={meal}
          onChange={setMeal}
          label={(value) => (value === "keep" ? "Keep their meals" : value)}
        />
      )}
    </Editor>
  );
}
