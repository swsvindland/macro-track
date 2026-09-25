import { useState } from "react";
import { Linking, View } from "react-native";
import { SystemButton, SystemPanel, SystemText as Text } from "@/components/system";
import { Screen } from "@/components/ui";
import {
  favoriteFoods,
  personalFoods,
  recentFoods,
  listSavedMeals,
  listRecipes,
} from "@/lib/diary";
import { catalogManifest } from "@/lib/food-catalog";
import { useNutritionQuery } from "@/lib/nutrition-store";
import { useStore } from "@/lib/store";
import type { SavedMeal } from "@/db";
import { recipeFood, type Recipe, type Food, totalNutrients } from "@/lib/nutrition";
import { RecipeEditor } from "./recipe-editor";
import { MealEditor } from "./meal-editor";
import { FoodEditor, FoodRow } from "./food-editor";

export function LibraryScreen() {
  const sections = useNutritionQuery(
    () =>
      [
        ["Saved foods", favoriteFoods()],
        ["My foods", personalFoods()],
        ["Recently logged", recentFoods()],
      ] as [string, Food[]][]
  );
  const { number } = useStore();
  const savedMeals = useNutritionQuery(listSavedMeals);
  const recipes = useNutritionQuery(listRecipes);
  const [recipeEditor, setRecipeEditor] = useState<{ recipe?: Recipe } | null>(null);
  const [mealEditor, setMealEditor] = useState<SavedMeal | null>(null);
  const [editor, setEditor] = useState<{ food?: Food } | null>(null);
  const [sourceError, setSourceError] = useState("");
  async function openSource(url: string) {
    try {
      await Linking.openURL(url);
      setSourceError("");
    } catch {
      setSourceError("Source links require an internet connection.");
    }
  }
  return (
    <>
      <Screen title="Library" subtitle="Foods you know. Ready to log again.">
        <SystemButton onPress={() => setEditor({})}>Find or create a food</SystemButton>
        <View className="gap-3">
          <View className="flex-row items-center justify-between">
            <Text className="text-xl font-semibold">Recipes</Text>
            <SystemButton variant="secondary" onPress={() => setRecipeEditor({})}>
              Create recipe
            </SystemButton>
          </View>
          {!recipes.length && (
            <Text className="text-sm text-muted">
              Your own ingredients. Nutrition worked out per serving.
            </Text>
          )}
          {recipes.map((recipe) => (
            <View key={recipe.id} className="gap-1">
              <FoodRow
                food={recipeFood(recipe)}
                onPress={() => setEditor({ food: recipeFood(recipe) })}
              />
              <SystemButton
                variant="ghost"
                className="self-start"
                accessibilityLabel={`Edit ${recipe.name}`}
                onPress={() => setRecipeEditor({ recipe })}
              >
                Edit recipe
              </SystemButton>
            </View>
          ))}
        </View>
        <View className="gap-3">
          <Text className="text-xl font-semibold">Saved meals</Text>
          <Text className="text-sm text-muted">
            {savedMeals.length
              ? "Your usuals, ready to log again."
              : "Tap Reuse meal in your diary to save a combination you enjoy."}
          </Text>
          {savedMeals.map((meal) => (
            <SystemButton
              key={meal.id}
              variant="secondary"
              className="justify-start bg-surface p-5"
              onPress={() => setMealEditor(meal)}
            >
              <View className="flex-1 gap-1">
                <Text className="font-semibold">{meal.name}</Text>
                <Text className="text-sm text-muted">
                  {meal.items.length} foods ·{" "}
                  {number(totalNutrients(meal.items.map((item) => item.nutrients)).calories, 0)}{" "}
                  kcal
                </Text>
              </View>
              <Text className="text-sm text-accent-soft-foreground">Log meal</Text>
            </SystemButton>
          ))}
        </View>
        {sections.map(([title, foods]) => (
          <View key={title} className="gap-2">
            <Text className="text-xl font-semibold">{title}</Text>
            {foods.length ? (
              foods.map((food) => (
                <FoodRow key={food.id} food={food} onPress={() => setEditor({ food })} />
              ))
            ) : (
              <Text className="text-sm text-muted">
                {title === "Saved foods"
                  ? "Save a food while logging to keep it here."
                  : title === "My foods"
                    ? "Foods you create from a label will appear here."
                    : "Your recent foods will appear after you log a meal."}
              </Text>
            )}
          </View>
        ))}
        <SystemPanel>
          <SystemPanel.Body className="gap-3">
            <Text className="text-lg font-semibold">Your offline food catalog</Text>
            <Text className="text-muted">
              {number(catalogManifest.usda.included, 0)} USDA foods ·{" "}
              {number(catalogManifest.off.included, 0)} US packaged foods
            </Text>
            <Text className="text-sm text-muted">
              {number((catalogManifest.usda.bytes + catalogManifest.off.bytes) / 1000000, 1)} MB of
              food data. Bundled with the app; no account or connection needed for food search.
            </Text>
            <Text className="text-sm text-muted">
              Food updates arrive with app updates. Your diary keeps its original nutrition when the
              catalog changes.
            </Text>
            <Text className="text-xs text-muted">
              USDA · {catalogManifest.usda.version}
              {"\n"}Open Food Facts · {catalogManifest.off.version}
            </Text>
            {catalogManifest.off.developmentSample && (
              <Text className="text-sm text-muted">
                The packaged catalog is a development sample. Create a custom food when a barcode is
                missing.
              </Text>
            )}
            <Text className="text-sm text-muted">
              USDA FoodData Central · SR Legacy 2018 · CC0. Packaged foods from Open Food Facts ·
              ODbL 1.0. Check package labels; database records may be incomplete or outdated.
            </Text>
            <SystemButton
              variant="ghost"
              onPress={() => {
                void openSource("https://fdc.nal.usda.gov/");
              }}
            >
              USDA FoodData Central
            </SystemButton>
            <SystemButton
              variant="ghost"
              onPress={() => {
                void openSource("https://world.openfoodfacts.org");
              }}
            >
              Open Food Facts
            </SystemButton>
            <SystemButton
              variant="ghost"
              onPress={() => {
                void openSource("https://opendatacommons.org/licenses/odbl/1-0/");
              }}
            >
              Database license
            </SystemButton>
            {!!sourceError && (
              <Text accessibilityRole="alert" className="text-sm text-muted">
                {sourceError}
              </Text>
            )}
          </SystemPanel.Body>
        </SystemPanel>
      </Screen>
      {recipeEditor && (
        <RecipeEditor recipe={recipeEditor.recipe} close={() => setRecipeEditor(null)} />
      )}
      {mealEditor && <MealEditor saved={mealEditor} close={() => setMealEditor(null)} />}
      {editor && <FoodEditor initialFood={editor.food} close={() => setEditor(null)} />}
    </>
  );
}
