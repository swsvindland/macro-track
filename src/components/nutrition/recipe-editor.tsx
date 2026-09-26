import { useRef, useState } from "react";
import { Alert, View } from "react-native";
import { SystemButton, SystemPanel, SystemText as Text } from "@/components/system";
import { Editor, ErrorText, Field } from "@/components/ui";
import { useCloseForAppAction } from "@/lib/app-actions";
import { deleteRecipe, saveRecipe } from "@/lib/diary";
import { parseNumber } from "@/lib/metrics";
import { recipeFood, type Recipe, type RecipeIngredient } from "@/lib/nutrition";
import { useNutrition } from "@/lib/nutrition-store";
import { useStore } from "@/lib/store";
import { FoodEditor } from "./food-editor";

export function RecipeEditor({ recipe, close }: { recipe?: Recipe; close: () => void }) {
  const { refresh } = useNutrition();
  const { number } = useStore();
  const [name, setName] = useState(recipe?.name ?? "");
  const [servings, setServings] = useState(String(recipe?.servings ?? 4));
  const [yieldGrams, setYieldGrams] = useState(recipe?.yieldGrams ? String(recipe.yieldGrams) : "");
  const [ingredients, setIngredients] = useState<RecipeIngredient[]>(recipe?.ingredients ?? []);
  const [picker, setPicker] = useState<{ index?: number } | null>(null);
  const [error, setError] = useState("");
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
    preview = recipeFood({ ...draft, name: name.trim() || "Recipe", id: "preview", revision: 1 });
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
    <Editor title={recipe ? "Edit recipe" : "Create a recipe"} open close={close}>
      <Text className="text-muted">Build the whole batch. We’ll work out each serving.</Text>
      <Field
        label="Recipe name"
        value={name}
        onChange={setName}
        placeholder="e.g. Weeknight chili"
      />
      <Field label="Servings in the whole batch" value={servings} onChange={setServings} numeric />
      <Text className="text-sm text-muted">
        A batch split into four equal portions makes 4 servings.
      </Text>
      <Field
        label="Cooked batch weight (g, optional)"
        value={yieldGrams}
        onChange={setYieldGrams}
        numeric
      />
      <Text className="text-sm text-muted">
        Weigh the finished food without its container to log portions by grams.
      </Text>
      <View className="gap-3">
        <Text className="text-lg font-semibold">Ingredients</Text>
        {!ingredients.length && (
          <Text className="text-sm text-muted">
            Add each ingredient with the quantity used in the whole batch.
          </Text>
        )}
        {ingredients.map((item, index) => (
          <SystemPanel key={index}>
            <SystemPanel.Body className="gap-2">
              <Text className="font-semibold">{item.food.name}</Text>
              <Text className="text-sm text-muted">
                {number(item.amount, 2)}{" "}
                {item.food.basis === "serving" ? "servings" : item.food.basis}
              </Text>
              <View className="flex-row gap-2">
                <SystemButton
                  variant="ghost"
                  onPress={() => setPicker({ index })}
                  accessibilityLabel={`Change ${item.food.name} quantity`}
                >
                  Change quantity
                </SystemButton>
                <SystemButton
                  variant="danger-soft"
                  onPress={() => setIngredients((old) => old.filter((_, i) => i !== index))}
                  accessibilityLabel={`Remove ${item.food.name}`}
                >
                  Remove
                </SystemButton>
              </View>
            </SystemPanel.Body>
          </SystemPanel>
        ))}
        <SystemButton
          variant="secondary"
          isDisabled={ingredients.length >= 100}
          onPress={() => setPicker({})}
        >
          Add ingredient
        </SystemButton>
      </View>
      {preview && (
        <SystemPanel>
          <SystemPanel.Body className="gap-2">
            <Text className="text-sm text-muted">
              {draft.yieldGrams ? "Per 100 g" : "Per serving"} · {number(draft.servings, 2)}{" "}
              servings in batch
            </Text>
            <Text className="text-3xl font-semibold tabular-nums">
              {number(preview.nutrients.calories, 0)}{" "}
              <Text className="text-base text-muted">kcal</Text>
            </Text>
            <Text className="text-sm text-muted">
              {number(preview.nutrients.protein)} g protein · {number(preview.nutrients.carbs)} g
              carbs · {number(preview.nutrients.fat)} g fat
            </Text>
          </SystemPanel.Body>
        </SystemPanel>
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
            setError(e instanceof Error ? e.message : "Couldn't save this recipe.");
          }
        }}
      >
        Save recipe
      </SystemButton>
      {recipe && (
        <>
          <Text className="text-sm text-muted">
            Changes apply to future portions. Previously logged food keeps its original nutrition.
          </Text>
          <SystemButton
            variant="danger-soft"
            onPress={() =>
              Alert.alert("Delete recipe?", "Food already logged will stay in your diary.", [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Delete",
                  style: "destructive",
                  onPress: () => {
                    try {
                      deleteRecipe(recipe.id);
                      refresh();
                      close();
                    } catch {
                      setError("Couldn't delete this recipe. Try again.");
                    }
                  },
                },
              ])
            }
          >
            Delete recipe
          </SystemButton>
        </>
      )}
    </Editor>
  );
}
