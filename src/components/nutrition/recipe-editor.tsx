import { useRef, useState } from "react";
import { Alert, View } from "react-native";
import { SystemButton } from "@/components/system";
import { Editor, ErrorText, Field } from "@/components/ui";
import { Heading, Meta, Note, Panel, Text, Value, useKitFormat } from "@/vector";
import { useCloseForAppAction } from "@/lib/app-actions";
import { deleteRecipe, saveRecipe } from "@/lib/diary";
import { parseNumber } from "@/lib/metrics";
import { recipeFood, type Recipe, type RecipeIngredient } from "@/lib/nutrition";
import { useNutrition } from "@/lib/nutrition-store";
import { useStore } from "@/lib/store";
import { FoodEditor } from "./food-editor";

export function RecipeEditor({ recipe, close }: { recipe?: Recipe; close: () => void }) {
  const { refresh } = useNutrition();
  const { number, t } = useStore();
  const format = useKitFormat();
  const [name, setName] = useState(recipe?.name ?? "");
  const [servings, setServings] = useState(String(recipe?.servings ?? 4));
  const [yieldGrams, setYieldGrams] = useState(recipe?.yieldGrams ? String(recipe.yieldGrams) : "");
  const [ingredients, setIngredients] = useState<RecipeIngredient[]>(recipe?.ingredients ?? []);
  const [picker, setPicker] = useState<{ index?: number } | null>(null);
  const [error, setError] = useState("");
  // What the form opened with; any change holds the sheet against a swipe.
  const [opened] = useState(() => JSON.stringify([name, servings, yieldGrams, ingredients]));
  const dirty = JSON.stringify([name, servings, yieldGrams, ingredients]) !== opened;
  const locked = useRef(false);
  // The ingredient picker takes this sheet's place, so a link closes the recipe with it.
  useCloseForAppAction(!!picker, close);
  const draft = {
    name,
    servings: parseNumber(servings),
    yieldGrams: yieldGrams.trim() ? parseNumber(yieldGrams) : null,
    ingredients,
  };
  let preview = null;
  try {
    preview = recipeFood({
      ...draft,
      name: name.trim() || t("recipe"),
      id: "preview",
      revision: 1,
    });
  } catch {
    /* Show validation on save, not while typing. */
  }
  if (picker) {
    const ingredient = picker.index === undefined ? undefined : ingredients[picker.index];
    return (
      <FoodEditor
        initialFood={ingredient?.food}
        initialAmount={ingredient?.amount}
        close={() => setPicker(null)}
        onPick={(food, amount) => {
          setIngredients((old) =>
            picker.index === undefined
              ? [...old, { food, amount }]
              : old.map((item, index) => (index === picker.index ? { food, amount } : item))
          );
          setError("");
        }}
      />
    );
  }
  return (
    <Editor title={t(recipe ? "editRecipe" : "createARecipe")} open close={close} dirty={dirty}>
      <Text tone="muted">{t("recipeIntro")}</Text>
      <Field
        label={t("recipeName")}
        value={name}
        onChange={setName}
        placeholder={t("recipeNamePlaceholder")}
      />
      <Field label={t("recipeServings")} value={servings} onChange={setServings} numeric />
      <Note>{t("recipeServingsNote")}</Note>
      <Field label={t("recipeBatchWeight")} value={yieldGrams} onChange={setYieldGrams} numeric />
      <Note>{t("recipeBatchWeightNote")}</Note>
      <View className="gap-3">
        <Heading level={3}>{t("ingredients")}</Heading>
        {!ingredients.length && <Note>{t("recipeIngredientsEmpty")}</Note>}
        {ingredients.map((item, index) => (
          <Panel key={index}>
            <Panel.Body className="gap-2">
              <Text variant="bodyStrong">{item.food.name}</Text>
              <Note>
                {item.food.basis === "serving"
                  ? t(format.plural(item.amount) === "one" ? "servingCountOne" : "servingCount", {
                      count: number(item.amount, 2),
                    })
                  : t("amountUnit", { count: number(item.amount, 2), unit: item.food.basis })}
              </Note>
              <View className="flex-row gap-2">
                <SystemButton
                  variant="ghost"
                  onPress={() => setPicker({ index })}
                  accessibilityLabel={t("changeQuantityNamed", { name: item.food.name })}
                >
                  {t("changeQuantity")}
                </SystemButton>
                <SystemButton
                  variant="danger-soft"
                  onPress={() => setIngredients((old) => old.filter((_, i) => i !== index))}
                  accessibilityLabel={t("removeNamed", { name: item.food.name })}
                >
                  {t("remove")}
                </SystemButton>
              </View>
            </Panel.Body>
          </Panel>
        ))}
        <SystemButton
          variant="secondary"
          isDisabled={ingredients.length >= 100}
          onPress={() => setPicker({})}
        >
          {t("addIngredient")}
        </SystemButton>
      </View>
      {preview && (
        <Panel>
          <Panel.Body className="gap-2">
            <Meta
              items={[
                t(draft.yieldGrams ? "per100g" : "perServing"),
                t(
                  format.plural(draft.servings) === "one"
                    ? "servingsInBatchOne"
                    : "servingsInBatch",
                  { count: number(draft.servings, 2) }
                ),
              ]}
            />
            <Value size="l" value={format.number(preview.nutrients.calories)} unit={t("kcal")} />
            <Meta
              items={[
                t("proteinGrams", { value: format.number(preview.nutrients.protein, 1) }),
                t("carbsGrams", { value: format.number(preview.nutrients.carbs, 1) }),
                t("fatGrams", { value: format.number(preview.nutrients.fat, 1) }),
              ]}
            />
          </Panel.Body>
        </Panel>
      )}
      <ErrorText message={error} />
      <SystemButton
        onPress={() => {
          if (locked.current) return;
          locked.current = true;
          try {
            saveRecipe({ ...draft, id: recipe?.id });
            refresh();
            close();
          } catch (e) {
            locked.current = false;
            setError(e instanceof Error ? e.message : t("couldNotSaveRecipe"));
          }
        }}
      >
        {t("saveRecipe")}
      </SystemButton>
      {recipe && (
        <>
          <Note>{t("recipeChangesNote")}</Note>
          <SystemButton
            variant="danger-soft"
            onPress={() =>
              Alert.alert(t("deleteRecipeTitle"), t("deleteRecipeBody"), [
                { text: t("cancel"), style: "cancel" },
                {
                  text: t("delete"),
                  style: "destructive",
                  onPress: () => {
                    try {
                      deleteRecipe(recipe.id);
                      refresh();
                      close();
                    } catch {
                      setError(t("couldNotDeleteRecipe"));
                    }
                  },
                },
              ])
            }
          >
            {t("deleteRecipe")}
          </SystemButton>
        </>
      )}
    </Editor>
  );
}
