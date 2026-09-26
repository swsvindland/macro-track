import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Image, Platform, View } from "react-native";
import {
  SystemButton,
  SystemIconButton,
  SystemLabel,
  SystemText as Text,
} from "@/components/system";
import { Choices, DateInput, Editor, ErrorText, Field } from "@/components/ui";
import { favoriteFoods, personalFoods, recentFoods, recipeFoods } from "@/lib/diary";
import { logBatch, type LogReceipt } from "@/lib/fast-log";
import { searchCatalogMatch } from "@/lib/food-catalog";
import { currentFoodTime, formatClock, mealAtTime, validFoodTime } from "@/lib/food-time";
import {
  downloadModel,
  errorCode,
  generateJson,
  modelStatus,
  prewarmModel,
  type ModelStatus,
} from "@/lib/local-ai";
import { analyzeMeal, draftItem, type DraftFood, type SeenFood } from "@/lib/meal-ai";
import { localDay, parseNumber } from "@/lib/metrics";
import {
  meals,
  scaleNutrients,
  shiftDay,
  totalNutrients,
  type Food,
  type Meal,
  type MealItem,
} from "@/lib/nutrition";
import { useNutrition } from "@/lib/nutrition-store";
import { useStore } from "@/lib/store";
import { FoodEditor } from "./food-editor";
import { discardPhoto, PhotoCapture } from "./photo-capture";
import { TimeField } from "./time-field";

type Phase =
  | { step: "capture" }
  | { step: "analyzing"; stage: "reading" | "matching"; seen: SeenFood[] }
  | { step: "review" };

const engineName = (status: ModelStatus) =>
  status.engine === "gemini-nano" ? "Gemini Nano" : "Apple Intelligence";

/** Whether the photo logger can do anything on this phone; Home hides it otherwise. */
export function photoLoggingOffered(status: ModelStatus | null) {
  return !!status && (status.state !== "unavailable" || status.reason === "disabled");
}

function unavailableText(status: ModelStatus) {
  if (status.state === "downloading")
    return `${engineName(status)} is still installing its on-device model. Try again in a few minutes.`;
  switch (status.reason) {
    case "disabled":
      return "Turn on Apple Intelligence in Settings › Apple Intelligence & Siri to log meals from photos and descriptions. It runs on this iPhone.";
    case "os":
      return "Photo logging needs iOS 26 or later with Apple Intelligence.";
    case "missing":
      return "This version of the app doesn't include on-device AI.";
    default:
      return Platform.OS === "ios"
        ? "This iPhone doesn't support Apple Intelligence, which runs the food model on the phone. Search, Scan and Quick add still work."
        : "This phone doesn't support Gemini Nano, which runs the food model on the phone. Search, Scan and Quick add still work.";
  }
}

function describeError(error: unknown) {
  const code = errorCode(error);
  if (code.startsWith("ERR_LOCAL_AI_") && error instanceof Error && error.message)
    return error.message;
  if (error instanceof SyntaxError || (error instanceof Error && /JSON/.test(error.message)))
    return "The on-device model gave an answer that couldn't be read. Try again.";
  return error instanceof Error && error.message
    ? error.message
    : "Couldn't analyze this meal. Try again.";
}

/** The person's own, saved and recently logged foods, preferred when they match. */
function knownFoods(): Food[] {
  return [
    ...new Map(
      [...personalFoods(), ...recipeFoods(), ...favoriteFoods(), ...recentFoods()]
        .filter((food) => !food.id.startsWith("quick:"))
        .map((food) => [food.id, food])
    ).values(),
  ];
}

/**
 * Photo and description logging: the phone's own model names the foods, the offline catalog
 * supplies their nutrition, and the person confirms the draft. With `onAdd`, the foods join a
 * meal being built instead of being logged here.
 */
export function PhotoLogger({
  initialDay,
  initialTime,
  initialMeal,
  close,
  onLogged,
  onAdd,
}: {
  initialDay: string;
  initialTime?: string;
  initialMeal?: Meal;
  close: () => void;
  onLogged?: (receipt: LogReceipt) => void;
  onAdd?: (items: MealItem[]) => void;
}) {
  const { number, diaryLayout } = useStore();
  const { refresh } = useNutrition();
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [installing, setInstalling] = useState(false);
  const [photo, setPhoto] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  // The description the current or last analysis was given; editing it offers a re-run.
  const [asked, setAsked] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ step: "capture" });
  const [drafts, setDrafts] = useState<DraftFood[]>([]);
  const [editing, setEditing] = useState<string | null>(null),
    [amount, setAmount] = useState("");
  const [searching, setSearching] = useState<{ key?: string; query: string } | null>(null);
  const [error, setError] = useState("");
  const [day, setDay] = useState(initialDay),
    [time, setTime] = useState(() => initialTime ?? currentFoodTime());
  const [meal, setMeal] = useState<Meal>(() => initialMeal ?? mealAtTime(time));
  const [when, setWhen] = useState(false);
  // Each analysis gets a number; a cancelled or superseded one can't overwrite the screen.
  const run = useRef(0);
  // The description the draft on screen was made from.
  const drafted = useRef<string | null>(null);
  const locked = useRef(false);

  function check() {
    void modelStatus().then((next) => {
      setStatus(next);
      if (next.state === "available") prewarmModel();
    });
  }
  useEffect(check, []);
  useEffect(() => () => discardPhoto(photo), [photo]);

  async function install() {
    setInstalling(true);
    setError("");
    try {
      await downloadModel();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setInstalling(false);
      check();
    }
  }

  async function analyze(image = photo, text = description) {
    if (!image && !text.trim()) {
      setError("Take a photo or describe what you ate.");
      return;
    }
    const id = ++run.current;
    setError("");
    setAsked(text.trim());
    setPhase({ step: "analyzing", stage: "reading", seen: [] });
    try {
      const result = await analyzeMeal(
        { description: text, imageUri: image ?? undefined },
        {
          generate: generateJson,
          search: (expression) => searchCatalogMatch(expression, { generic: 100, branded: 30 }),
          known: knownFoods(),
          onStage: (stage, seen) => {
            if (run.current === id) setPhase({ step: "analyzing", stage, seen: seen ?? [] });
          },
        }
      );
      if (run.current !== id) return;
      if (!result.length) {
        back(
          drafts.length
            ? "No food found with that description."
            : image
              ? "No food found in this photo. Try a closer photo, or describe what you ate."
              : "No food found in that description."
        );
        return;
      }
      drafted.current = text.trim();
      setDrafts(result);
      setPhase({ step: "review" });
    } catch (e) {
      if (run.current !== id) return;
      back(describeError(e));
    }
  }
  // A re-run that fails, finds nothing or is cancelled leaves the draft it would have replaced.
  function back(message = "") {
    if (drafts.length) {
      setAsked(drafted.current);
      setPhase({ step: "review" });
    } else setPhase({ step: "capture" });
    setError(message);
  }

  // A new photo is analyzed straight away, with whatever description is already typed.
  function took(uri: string) {
    setPhoto(uri);
    void analyze(uri);
  }
  function startOver() {
    run.current++;
    setPhoto(null);
    setAsked(null);
    setDrafts([]);
    setPhase({ step: "capture" });
    setError("");
  }
  function stop() {
    if (!drafts.length) return startOver();
    run.current++;
    back();
  }
  const changed =
    asked !== null && description.trim() !== asked && (!!photo || !!description.trim());
  // Describe-only: return finds the foods, or finds them again for an edited description.
  function submit() {
    if (phase.step === "capture" ? description.trim() : changed) void analyze();
  }
  const items = drafts.flatMap((draft) => (draft.item ? [draft.item] : []));
  const unmatched = drafts.length - items.length;
  function update(key: string, change: (draft: DraftFood) => DraftFood | null) {
    setDrafts((previous) =>
      previous.flatMap((draft) => {
        if (draft.key !== key) return [draft];
        const next = change(draft);
        return next ? [next] : [];
      })
    );
    setError("");
  }
  function commit() {
    if (locked.current || !items.length) return;
    locked.current = true;
    try {
      if (onAdd) onAdd(items);
      else {
        const receipt = logBatch(items, {
          day,
          time,
          meal: diaryLayout === "meals" ? meal : undefined,
        });
        refresh();
        onLogged?.(receipt);
      }
      close();
    } catch (e) {
      locked.current = false;
      setError(e instanceof Error ? e.message : "Could not save this meal.");
    }
  }
  function cancel() {
    run.current++;
    close();
  }

  // Replacing a food or adding a missed one uses the ordinary food search.
  if (searching)
    return (
      <FoodEditor
        initialMode="search"
        initialQuery={searching.query}
        pickerTitle={searching.key ? "Replace food" : "Add to meal"}
        pickLabel={searching.key ? "Use this food" : "Add to meal"}
        close={() => setSearching(null)}
        onPick={(food, value) => {
          const item: MealItem = {
            food,
            amount: value,
            portionLabel: `${value} ${food.basis === "serving" ? "serving(s)" : food.basis}`,
            nutrients: scaleNutrients(food, value),
          };
          if (searching.key)
            update(searching.key, (draft) => ({
              ...draft,
              options: [food, ...draft.options.filter((option) => option.id !== food.id)],
              item,
            }));
          else
            setDrafts((previous) => [
              ...previous,
              {
                key: `added:${Date.now()}`,
                seen: {
                  name: food.name,
                  brand: food.brand,
                  quantity: value,
                  unit: food.basis,
                  grams: null,
                },
                options: [food],
                item,
              },
            ]);
          setEditing(null);
        }}
      />
    );

  const draft = editing ? drafts.find((row) => row.key === editing) : undefined;
  if (draft) {
    const current = draft.item;
    const value = parseNumber(amount);
    let preview: MealItem["nutrients"] | null = null;
    try {
      if (current) preview = scaleNutrients(current.food, value);
    } catch {
      /* Shown on save. */
    }
    const basis = current?.food.basis;
    const unit = basis === "serving" ? (value === 1 ? " serving" : " servings") : ` ${basis}`;
    const seen = `${draft.seen.brand ? `${draft.seen.brand} ` : ""}${draft.seen.name} · ${draft.seen.quantity} ${draft.seen.unit}`;
    return (
      <Editor
        title="Adjust food"
        open
        compact
        close={() => setEditing(null)}
        footer={
          current ? (
            <View className="gap-2">
              <ErrorText message={error} />
              <SystemButton
                isDisabled={!preview}
                onPress={() => {
                  if (!preview) return setError("Enter a valid quantity.");
                  update(draft.key, (row) => ({
                    ...row,
                    item: {
                      ...current,
                      amount: value,
                      portionLabel: `${value}${unit}`,
                      nutrients: preview!,
                    },
                  }));
                  setEditing(null);
                }}
              >
                {preview
                  ? `Use ${value}${unit} · ${number(preview.calories, 0)} kcal`
                  : "Use this amount"}
              </SystemButton>
            </View>
          ) : undefined
        }
      >
        <Text accessibilityRole="header" numberOfLines={3} className="text-xl font-semibold">
          {current?.food.name ?? draft.seen.name}
        </Text>
        <Text className="-mt-2 text-sm text-muted">Seen: {seen}</Text>
        {current && (
          <>
            <Field
              label={`Quantity (${basis === "serving" ? "servings" : basis})`}
              numeric
              selectTextOnFocus
              value={amount}
              onChange={(next) => {
                setAmount(next);
                setError("");
              }}
            />
            {!!current.food.portions.length && (
              <View className="flex-row flex-wrap gap-2">
                {current.food.portions.slice(0, 6).map((portion, i) => (
                  <SystemButton
                    key={i}
                    variant="secondary"
                    className={`px-3 ${value === portion.amount ? "bg-accent-soft" : ""}`}
                    accessibilityState={{ selected: value === portion.amount }}
                    onPress={() => setAmount(String(portion.amount))}
                  >
                    {`${portion.label} · ${number(portion.amount, Number.isInteger(portion.amount) ? 0 : 1)} ${basis}`}
                  </SystemButton>
                ))}
              </View>
            )}
            {preview && (
              <Text className="text-sm font-semibold tabular-nums">
                {number(preview.calories, 0)} kcal · {number(preview.protein, 0)} g protein ·{" "}
                {number(preview.carbs, 0)} g carbs · {number(preview.fat, 0)} g fat
              </Text>
            )}
          </>
        )}
        {draft.options.length > (current ? 1 : 0) && (
          <View className="gap-1">
            <SystemLabel className="px-1 pt-2">
              {current ? "Other matches" : "Possible matches"}
            </SystemLabel>
            {draft.options
              .filter((food) => food.id !== current?.food.id)
              .slice(0, 7)
              .map((food) => (
                <SystemButton
                  key={food.id}
                  variant="ghost"
                  className="justify-start rounded-2xl bg-surface px-3 py-2"
                  accessibilityLabel={`Use ${food.name}`}
                  onPress={() => {
                    const item = draftItem(draft.seen, food);
                    update(draft.key, (row) => ({ ...row, item }));
                    setAmount(String(item.amount));
                  }}
                >
                  <View className="flex-1 gap-0.5">
                    <Text numberOfLines={2}>{food.name}</Text>
                    <Text className="text-xs text-muted">
                      {food.brand ? `${food.brand} · ` : ""}
                      {number(food.nutrients.calories, 0)} kcal /{" "}
                      {food.basis === "serving" ? "serving" : `100 ${food.basis}`}
                    </Text>
                  </View>
                </SystemButton>
              ))}
          </View>
        )}
        <SystemButton
          variant="secondary"
          icon="search"
          onPress={() => setSearching({ key: draft.key, query: draft.seen.name })}
        >
          Search all foods
        </SystemButton>
        <SystemButton
          variant="danger-soft"
          onPress={() => {
            update(draft.key, () => null);
            setEditing(null);
          }}
        >
          Remove from meal
        </SystemButton>
      </Editor>
    );
  }

  const describe = status && (
    <Field
      label={status.vision ? "Description (optional)" : "What did you eat?"}
      multiline
      value={description}
      onChange={(next) => {
        setDescription(next);
        setError("");
      }}
      onSubmit={status.vision ? undefined : submit}
      placeholder="e.g. large pepperoni from Domino's, ate 3 slices"
    />
  );
  const rerun = changed && (
    <SystemButton variant="secondary" icon="sparkles-outline" onPress={() => void analyze()}>
      Update with description
    </SystemButton>
  );

  if (phase.step === "review") {
    const today = localDay();
    const dayLabel =
      day === today
        ? "Today"
        : day === shiftDay(today, -1)
          ? "Yesterday"
          : new Date(`${day}T12:00:00`).toLocaleDateString(undefined, {
              weekday: "short",
              month: "short",
              day: "numeric",
            });
    const sum = totalNutrients(items.map((item) => item.nutrients));
    return (
      <Editor
        title="Review meal"
        open
        compact
        close={cancel}
        footer={
          <View className="gap-2">
            <ErrorText message={error} />
            {rerun}
            {!!items.length && (
              <Text className="text-sm font-semibold tabular-nums">
                {number(sum.calories, 0)} kcal · {number(sum.protein, 0)} g protein ·{" "}
                {number(sum.carbs, 0)} g carbs · {number(sum.fat, 0)} g fat
              </Text>
            )}
            <SystemButton isDisabled={!items.length} onPress={commit}>
              {items.length
                ? `${onAdd ? "Add" : "Log"} ${items.length} ${items.length === 1 ? "food" : "foods"}${unmatched ? ` · skip ${unmatched}` : ""}`
                : "Nothing to log yet"}
            </SystemButton>
          </View>
        }
      >
        {!onAdd && (
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
        )}
        {when && (
          <>
            <DateInput label="Log date" value={day} onChange={setDay} />
            <TimeField value={time} onChange={setTime} />
            {diaryLayout === "meals" && <Choices values={meals} value={meal} onChange={setMeal} />}
          </>
        )}
        {photo && (
          <Image
            source={{ uri: photo }}
            accessibilityIgnoresInvertColors
            accessibilityLabel="Your meal photo"
            style={{ width: "100%", height: 150, borderRadius: 16 }}
            resizeMode="cover"
          />
        )}
        <SystemLabel accessibilityRole="header" className="px-1 pt-1">
          {`${drafts.length} ${drafts.length === 1 ? "food" : "foods"} found · tap to adjust`}
        </SystemLabel>
        {drafts.map((row) => (
          <View
            key={row.key}
            className="flex-row items-center gap-2 rounded-2xl bg-surface py-1 pl-3 pr-1.5"
          >
            <SystemButton
              variant="ghost"
              className="flex-1 justify-start px-0 py-2"
              accessibilityLabel={`Adjust ${row.item?.food.name ?? row.seen.name}`}
              onPress={() => {
                setEditing(row.key);
                setAmount(row.item ? String(row.item.amount) : "");
                setError("");
              }}
            >
              <View className="flex-1 gap-0.5">
                <Text numberOfLines={2} className="shrink font-medium">
                  {row.item?.food.name ?? row.seen.name}
                </Text>
                <Text
                  numberOfLines={1}
                  className={`text-sm tabular-nums ${row.item ? "text-muted" : "text-warning"}`}
                >
                  {row.item
                    ? `${row.item.portionLabel} · ${number(row.item.nutrients.calories, 0)} kcal`
                    : "No match yet · tap to choose"}
                </Text>
              </View>
            </SystemButton>
            <SystemIconButton
              icon="close"
              color="muted"
              iconSize={20}
              accessibilityLabel={`Remove ${row.item?.food.name ?? row.seen.name}`}
              onPress={() => update(row.key, () => null)}
            />
          </View>
        ))}
        <View className="flex-row flex-wrap gap-2">
          <SystemButton
            variant="secondary"
            icon="add"
            className="px-3"
            onPress={() => setSearching({ query: "" })}
          >
            Add a food
          </SystemButton>
          <SystemButton variant="ghost" icon="refresh" className="px-3" onPress={startOver}>
            Start over
          </SystemButton>
        </View>
        {describe}
        <Text className="px-1 text-xs text-muted">
          Foods and amounts are estimates made on this phone. Nutrition comes from the food catalog;
          check portions before logging.
        </Text>
      </Editor>
    );
  }

  const ready = status?.state === "available";
  return (
    <Editor
      title={status && !status.vision && ready ? "Describe a meal" : "Photo log"}
      open
      compact
      close={cancel}
      footer={
        phase.step === "analyzing" ? (
          <View className="gap-2">
            {rerun}
            <SystemButton variant="secondary" onPress={stop}>
              Cancel
            </SystemButton>
          </View>
        ) : ready ? (
          <View className="gap-2">
            <ErrorText message={error} />
            <SystemButton
              icon="sparkles-outline"
              isDisabled={!photo && !description.trim()}
              onPress={() => void analyze()}
            >
              {photo || description.trim() ? "Find foods" : "Add a photo or description"}
            </SystemButton>
          </View>
        ) : undefined
      }
    >
      {phase.step === "analyzing" ? (
        <>
          <View className="gap-4 pt-2" accessibilityLiveRegion="polite">
            {photo && (
              <Image
                source={{ uri: photo }}
                accessibilityIgnoresInvertColors
                accessibilityLabel="Your meal photo"
                style={{ width: "100%", height: 200, borderRadius: 16 }}
                resizeMode="cover"
              />
            )}
            <View className="flex-row items-center gap-3">
              <ActivityIndicator />
              <Text className="font-medium">
                {phase.stage === "reading"
                  ? photo
                    ? "Looking at your meal…"
                    : "Reading your description…"
                  : `Matching ${phase.seen.length} ${phase.seen.length === 1 ? "food" : "foods"} to the food list…`}
              </Text>
            </View>
            {phase.seen.map((food, i) => (
              <Text key={i} className="px-1 text-sm text-muted">
                {`${food.quantity} ${food.unit} · ${food.brand ? `${food.brand} ` : ""}${food.name}`}
              </Text>
            ))}
          </View>
          {describe}
        </>
      ) : !status ? (
        <Text className="text-muted">Checking on-device AI…</Text>
      ) : status.state === "downloadable" ? (
        <View className="gap-3">
          <Text>
            Photo logging uses Gemini Nano, which Android installs on the phone. After a one-time
            download, analysis works offline and photos never leave the phone.
          </Text>
          <SystemButton
            isDisabled={installing}
            icon="download-outline"
            onPress={() => void install()}
          >
            {installing ? "Downloading…" : "Download Gemini Nano"}
          </SystemButton>
          <ErrorText message={error} />
        </View>
      ) : !ready ? (
        <View className="gap-3">
          <Text>{unavailableText(status)}</Text>
          {status.state === "downloading" && (
            <SystemButton variant="secondary" icon="refresh" onPress={check}>
              Check again
            </SystemButton>
          )}
        </View>
      ) : (
        <>
          {status.vision ? (
            photo ? (
              // Short enough that the description stays above the keyboard.
              <View className="flex-row items-end gap-3">
                <Image
                  source={{ uri: photo }}
                  accessibilityIgnoresInvertColors
                  accessibilityLabel="Your meal photo"
                  style={{ flex: 1, height: 160, borderRadius: 16 }}
                  resizeMode="cover"
                />
                <SystemButton
                  variant="secondary"
                  icon="camera-reverse-outline"
                  className="px-3"
                  accessibilityLabel="Retake photo"
                  onPress={() => setPhoto(null)}
                >
                  Retake
                </SystemButton>
              </View>
            ) : (
              <PhotoCapture
                subject="your meal"
                alternative="describe your meal"
                onPhoto={took}
                onError={setError}
              />
            )
          ) : (
            <Text className="text-sm text-muted">
              Photos need iOS 27. Describe what you ate and the foods will be found for you.
            </Text>
          )}
          {describe}
          <Text className="px-1 text-xs text-muted">
            {`Runs on this phone with ${engineName(status)}. Brands and amounts you mention are used as given.${status.vision ? " Photos are not saved." : ""}`}
          </Text>
        </>
      )}
    </Editor>
  );
}
