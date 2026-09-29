import { useEffect, useRef, useState } from "react";
import { Image, Platform, View } from "react-native";
import { SystemButton, SystemIconButton } from "@/components/system";
import { Choices, Editor, ErrorText, Field } from "@/components/ui";
import { Heading, Label, Meta, Note, ProcessLine, Text, useKitFormat } from "@/vector";
import { favoriteFoods, personalFoods, recentFoods, recipeFoods, targetsForDay } from "@/lib/diary";
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
import { localDay } from "@/lib/metrics";
import {
  countText,
  meals,
  parseAmount,
  portionItem,
  portionOf,
  portionUnits,
  shiftDay,
  totalNutrients,
  type Food,
  type Meal,
  type MealItem,
} from "@/lib/nutrition";
import { useNutrition, useNutritionQuery } from "@/lib/nutrition-store";
import { useStore } from "@/lib/store";
import type { Message } from "@/lib/translations";
import { AmountPicker, PortionPreview, type AmountDraft } from "./amount-picker";
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

type Translate = (key: Message, values?: Record<string, string | number>) => string;

function unavailableText(status: ModelStatus, t: Translate) {
  if (status.state === "downloading") return t("aiInstalling", { engine: engineName(status) });
  switch (status.reason) {
    case "disabled":
      return t("aiDisabled");
    case "os":
      return t("aiNeedsNewerIos");
    case "missing":
      return t("aiMissing");
    default:
      return t(Platform.OS === "ios" ? "aiUnsupportedIphone" : "aiUnsupportedAndroid");
  }
}

function describeError(error: unknown, t: Translate) {
  const code = errorCode(error);
  if (code.startsWith("ERR_LOCAL_AI_") && error instanceof Error && error.message)
    return error.message;
  if (error instanceof SyntaxError || (error instanceof Error && /JSON/.test(error.message)))
    return t("aiUnreadable");
  return error instanceof Error && error.message ? error.message : t("aiFailed");
}

/** The amount field for a drafted item: the unit and count the photo was read as. */
function draftOf(item: MealItem | null): AmountDraft {
  if (!item) return { unit: "", text: "", fresh: true };
  const { unit, count } = portionOf(item);
  return { unit, text: countText(item.food, unit, count), fresh: true };
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
  const { diaryLayout, t } = useStore();
  const format = useKitFormat();
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
    [amount, setAmount] = useState<AmountDraft>(() => draftOf(null));
  const [searching, setSearching] = useState<{ key?: string; query: string } | null>(null);
  const [error, setError] = useState("");
  const [day, setDay] = useState(initialDay),
    [time, setTime] = useState(() => initialTime ?? currentFoodTime());
  const [meal, setMeal] = useState<Meal>(() => initialMeal ?? mealAtTime(time));
  const [when, setWhen] = useState(false);
  const targets = useNutritionQuery(() => targetsForDay(day), [day]);
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
      setError(describeError(e, t));
    } finally {
      setInstalling(false);
      check();
    }
  }

  async function analyze(image = photo, text = description) {
    if (!image && !text.trim()) {
      setError(t("photoNeedsInput"));
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
          t(
            drafts.length ? "noFoodForDescription" : image ? "noFoodInPhoto" : "noFoodInDescription"
          )
        );
        return;
      }
      drafted.current = text.trim();
      setDrafts(result);
      setPhase({ step: "review" });
    } catch (e) {
      if (run.current !== id) return;
      back(describeError(e, t));
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
  // A photo, a description or a draft holds the sheet, so a swipe can't lose them.
  const held = !!photo || !!description.trim() || drafts.length > 0;
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
      setError(e instanceof Error ? e.message : t("couldNotSaveMeal"));
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
        pickerTitle={t(searching.key ? "replaceFood" : "addToMeal")}
        pickLabel={t(searching.key ? "useThisFood" : "addToMeal")}
        close={() => setSearching(null)}
        onPick={(food, amount, item) => {
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
                  quantity: amount,
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
    let next: MealItem | null = null;
    try {
      if (current)
        next = portionItem(current.food, amount.unit, parseAmount(amount.text), {
          previous: current,
        });
    } catch {
      /* Shown on save. */
    }
    const seen = t("seenFood", {
      food: draft.seen.brand
        ? t("brandedFood", { brand: draft.seen.brand, name: draft.seen.name })
        : draft.seen.name,
      amount: t("amountUnit", { count: draft.seen.quantity, unit: draft.seen.unit }),
    });
    return (
      <Editor
        title={t("adjustFood")}
        open
        compact
        close={() => setEditing(null)}
        // Cancel steps back to the review.
        guarded
        footer={
          current ? (
            <View className="gap-2">
              <ErrorText message={error} />
              <AmountPicker
                units={portionUnits(current.food)}
                value={amount}
                onChange={(value) => {
                  setAmount(value);
                  setError("");
                }}
                actions={[
                  {
                    label: t("use"),
                    onPress: () => {
                      if (!next) return setError(t("enterValidQuantity"));
                      update(draft.key, (row) => ({ ...row, item: next }));
                      setEditing(null);
                    },
                  },
                ]}
              />
            </View>
          ) : undefined
        }
      >
        <Heading level={3}>{current?.food.name ?? draft.seen.name}</Heading>
        <Note>{seen}</Note>
        {current && <PortionPreview nutrients={next?.nutrients ?? null} targets={targets} />}
        {draft.options.length > (current ? 1 : 0) && (
          <View className="gap-1">
            <Label className="pt-2">{t(current ? "otherMatches" : "possibleMatches")}</Label>
            {draft.options
              .filter((food) => food.id !== current?.food.id)
              .slice(0, 7)
              .map((food) => (
                <SystemButton
                  key={food.id}
                  variant="ghost"
                  className="justify-start border border-border bg-surface px-3 py-2"
                  accessibilityLabel={t("useNamed", { name: food.name })}
                  onPress={() => {
                    const item = draftItem(draft.seen, food);
                    update(draft.key, (row) => ({ ...row, item }));
                    setAmount(draftOf(item));
                  }}
                >
                  <View className="flex-1 gap-0.5">
                    <Text>{food.name}</Text>
                    <Meta
                      items={[
                        food.brand,
                        food.basis === "serving"
                          ? t("kcalPerServing", { value: format.number(food.nutrients.calories) })
                          : t("kcalPer100", {
                              value: format.number(food.nutrients.calories),
                              basis: food.basis,
                            }),
                      ]}
                    />
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
          {t("searchAllFoods")}
        </SystemButton>
        <SystemButton
          variant="danger-soft"
          onPress={() => {
            update(draft.key, () => null);
            setEditing(null);
          }}
        >
          {t("removeFromThisMeal")}
        </SystemButton>
      </Editor>
    );
  }

  const describe = status && (
    <Field
      label={t(status.vision ? "descriptionOptional" : "whatDidYouEat")}
      multiline
      value={description}
      onChange={(next) => {
        setDescription(next);
        setError("");
      }}
      onSubmit={status.vision ? undefined : submit}
      placeholder={t("mealDescriptionPlaceholder")}
    />
  );
  const rerun = changed && (
    <SystemButton variant="secondary" icon="analysis" onPress={() => void analyze()}>
      {t("updateWithDescription")}
    </SystemButton>
  );

  if (phase.step === "review") {
    const today = localDay();
    const dayLabel =
      day === today
        ? t("today")
        : day === shiftDay(today, -1)
          ? t("yesterday")
          : new Date(`${day}T12:00:00`).toLocaleDateString(format.tag, {
              weekday: "short",
              month: "short",
              day: "numeric",
            });
    const sum = totalNutrients(items.map((item) => item.nutrients));
    const one = format.plural(items.length) === "one";
    const action = t(
      onAdd ? (one ? "addFoodsOne" : "addFoods") : one ? "logFoodsOne" : "logFoods",
      {
        count: format.number(items.length),
      }
    );
    const commitLabel = unmatched
      ? t("skipUnmatched", { action, count: format.number(unmatched) })
      : action;
    return (
      <Editor
        title={t("reviewMeal")}
        open
        compact
        close={cancel}
        dirty={held}
        footer={
          <View className="gap-2">
            <ErrorText message={error} />
            {rerun}
            {!!items.length && (
              <Meta
                tone="default"
                items={[
                  t("kcalValue", { value: format.number(sum.calories) }),
                  t("proteinGrams", { value: format.number(sum.protein) }),
                  t("carbsGrams", { value: format.number(sum.carbs) }),
                  t("fatGrams", { value: format.number(sum.fat) }),
                ]}
              />
            )}
            <SystemButton isDisabled={!items.length} onPress={commit}>
              {items.length ? commitLabel : t("nothingToLogYet")}
            </SystemButton>
          </View>
        }
      >
        {!onAdd && (
          <SystemButton
            variant="ghost"
            icon="time"
            className="self-start px-2"
            accessibilityHint={t("changeMealTimeHint")}
            accessibilityState={{ expanded: when }}
            onPress={() => setWhen((open) => !open)}
          >
            {t(diaryLayout === "meals" ? "whenMeal" : "whenTime", {
              day: dayLabel,
              time: validFoodTime(time) ? formatClock(time, format.tag) : time,
              meal,
            })}
          </SystemButton>
        )}
        {when && (
          <>
            <TimeField value={time} onChange={setTime} day={day} onDayChange={setDay} />
            {diaryLayout === "meals" && (
              <Choices
                values={meals}
                value={meal}
                onChange={setMeal}
                label={(value) => value}
                accessibilityLabel={t("meal")}
              />
            )}
          </>
        )}
        {photo && (
          <Image
            source={{ uri: photo }}
            accessibilityIgnoresInvertColors
            accessibilityLabel={t("yourMealPhoto")}
            className="rounded-control border border-border"
            style={{ width: "100%", height: 150 }}
            resizeMode="cover"
          />
        )}
        <Label accessibilityRole="header" className="pt-1">
          {t(format.plural(drafts.length) === "one" ? "foundFoodsOne" : "foundFoods", {
            count: format.number(drafts.length),
          })}
        </Label>
        {drafts.map((row) => (
          <View
            key={row.key}
            className="flex-row items-center gap-2 rounded-control border border-border bg-surface py-1 ps-3 pe-1.5"
          >
            <SystemButton
              variant="ghost"
              className="flex-1 justify-start px-0 py-2"
              accessibilityLabel={t("adjustNamed", { name: row.item?.food.name ?? row.seen.name })}
              onPress={() => {
                setEditing(row.key);
                setAmount(draftOf(row.item));
                setError("");
              }}
            >
              <View className="flex-1 gap-0.5">
                <Text variant="bodyStrong" className="shrink">
                  {row.item?.food.name ?? row.seen.name}
                </Text>
                {row.item ? (
                  <Meta
                    items={[
                      row.item.portionLabel,
                      t("kcalValue", { value: format.number(row.item.nutrients.calories) }),
                    ]}
                  />
                ) : (
                  <Note tone="warning">{t("noMatchYet")}</Note>
                )}
              </View>
            </SystemButton>
            <SystemIconButton
              icon="close"
              color="muted"
              iconSize={20}
              accessibilityLabel={t("removeNamed", { name: row.item?.food.name ?? row.seen.name })}
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
            {t("addAFood")}
          </SystemButton>
          <SystemButton variant="ghost" icon="refresh" className="px-3" onPress={startOver}>
            {t("startOver")}
          </SystemButton>
        </View>
        {describe}
        <Text variant="caption" tone="muted">
          {t("photoEstimateNote")}
        </Text>
      </Editor>
    );
  }

  const ready = status?.state === "available";
  return (
    <Editor
      title={t(status && !status.vision && ready ? "describeAMeal" : "photoLog")}
      open
      compact
      close={cancel}
      dirty={held}
      footer={
        phase.step === "analyzing" ? (
          <View className="gap-2">
            {rerun}
            <SystemButton variant="secondary" onPress={stop}>
              {t("cancel")}
            </SystemButton>
          </View>
        ) : ready ? (
          <View className="gap-2">
            <ErrorText message={error} />
            <SystemButton
              icon="analysis"
              isDisabled={!photo && !description.trim()}
              onPress={() => void analyze()}
            >
              {t(photo || description.trim() ? "findFoods" : "addPhotoOrDescription")}
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
                accessibilityLabel={t("yourMealPhoto")}
                className="rounded-control border border-border"
                style={{ width: "100%", height: 200 }}
                resizeMode="cover"
              />
            )}
            <ProcessLine
              label={
                phase.stage === "reading"
                  ? t(photo ? "lookingAtMeal" : "readingDescription")
                  : t(
                      format.plural(phase.seen.length) === "one"
                        ? "matchingFoodsOne"
                        : "matchingFoods",
                      {
                        count: format.number(phase.seen.length),
                      }
                    )
              }
            />
            {phase.seen.map((food, i) => (
              <Meta
                key={i}
                items={[
                  t("amountUnit", { count: food.quantity, unit: food.unit }),
                  food.brand,
                  food.name,
                ]}
              />
            ))}
          </View>
          {describe}
        </>
      ) : !status ? (
        <Text tone="muted">{t("checkingAi")}</Text>
      ) : status.state === "downloadable" ? (
        <View className="gap-3">
          <Text>{t("geminiDownloadIntro")}</Text>
          <SystemButton isDisabled={installing} icon="download" onPress={() => void install()}>
            {t(installing ? "downloading" : "downloadGeminiNano")}
          </SystemButton>
          <ErrorText message={error} />
        </View>
      ) : !ready ? (
        <View className="gap-3">
          <Text>{unavailableText(status, t)}</Text>
          {status.state === "downloading" && (
            <SystemButton variant="secondary" icon="refresh" onPress={check}>
              {t("checkAgain")}
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
                  accessibilityLabel={t("yourMealPhoto")}
                  className="rounded-control border border-border"
                  style={{ flex: 1, height: 160 }}
                  resizeMode="cover"
                />
                <SystemButton
                  variant="secondary"
                  icon="retake"
                  className="px-3"
                  accessibilityLabel={t("retakePhoto")}
                  onPress={() => setPhoto(null)}
                >
                  {t("retake")}
                </SystemButton>
              </View>
            ) : (
              <PhotoCapture kind="meal" onPhoto={took} onError={setError} />
            )
          ) : (
            <Note>{t("photosNeedNewerIos")}</Note>
          )}
          {describe}
          <Text variant="caption" tone="muted">
            {t(status.vision ? "aiRunsOnPhonePhotos" : "aiRunsOnPhone", {
              engine: engineName(status),
            })}
          </Text>
        </>
      )}
    </Editor>
  );
}
