import { useRef, useState } from "react";
import { SystemButton, SystemText as Text } from "@/components/system";
import { DateInput, Editor, ErrorText } from "@/components/ui";
import { copyDay, entriesForDay } from "@/lib/diary";
import { shiftDay } from "@/lib/nutrition";
import { useNutrition, useNutritionQuery } from "@/lib/nutrition-store";
import { useStore } from "@/lib/store";
export function CopyDay({ destination, close }: { destination: string; close: () => void }) {
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
            copyDay(source, destination);
            refresh();
            close();
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
