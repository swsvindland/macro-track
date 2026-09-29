import { useState, type ReactNode } from "react";
import { Linking, View } from "react-native";
import {
  Button,
  ErrorText,
  IconButton,
  Label,
  LinkButton,
  ListRow,
  Meta,
  Note,
  Panel,
  Screen,
  useKitFormat,
} from "@/vector";
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
import type { Message } from "@/lib/translations";
import type { SavedMeal } from "@/db";
import { recipeFood, type Recipe, type Food, totalNutrients } from "@/lib/nutrition";
import { RecipeEditor } from "./recipe-editor";
import { MealEditor } from "./meal-editor";
import { FoodEditor, FoodRow } from "./food-editor";

// The catalogs' own names are the same in every language; the license and download links are
// translated.
const catalogLinks: ({ key: string; url: string } & ({ name: string } | { label: Message }))[] = [
  { key: "usda", name: "USDA FoodData Central", url: "https://fdc.nal.usda.gov/" },
  { key: "off", name: "Open Food Facts", url: "https://world.openfoodfacts.org" },
  {
    key: "odbl",
    label: "databaseLicense",
    url: "https://opendatacommons.org/licenses/odbl/1-0/",
  },
  {
    key: "dbcl",
    label: "contentsLicense",
    url: "https://opendatacommons.org/licenses/dbcl/1-0/",
  },
  {
    key: "download",
    label: "downloadFoodDatabase",
    url: "https://github.com/swsvindland/macro-track/tree/main/assets/food",
  },
];
const catalogNames = { usda: "USDA", off: "Open Food Facts" };

/** An eyebrow over a row list, or over the sentence that says why the list is empty. */
function Section({
  eyebrow,
  action,
  note,
  empty,
  children,
}: {
  eyebrow: string;
  action?: ReactNode;
  /** Said above the rows when there are some. */
  note?: string;
  empty: string;
  children: ReactNode[];
}) {
  return (
    <View className="gap-2">
      <View className="min-h-11 flex-row items-center justify-between gap-3">
        <Label accessibilityRole="header" className="shrink">
          {eyebrow}
        </Label>
        {action}
      </View>
      {!!children.length && !!note && <Note>{note}</Note>}
      {children.length ? <Panel inset="none">{children}</Panel> : <Note>{empty}</Note>}
    </View>
  );
}

export function LibraryScreen() {
  const { t } = useStore();
  const format = useKitFormat();
  const sections = useNutritionQuery(
    () =>
      [
        ["saved", favoriteFoods()],
        ["mine", personalFoods()],
        ["recent", recentFoods()],
      ] as ["saved" | "mine" | "recent", Food[]][]
  );
  const titles = {
    saved: { eyebrow: t("savedFoods"), empty: t("savedFoodsEmpty") },
    mine: { eyebrow: t("myFoods"), empty: t("myFoodsEmpty") },
    recent: { eyebrow: t("recentlyLogged"), empty: t("recentlyLoggedEmpty") },
  };
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
      setSourceError(t("sourceLinksOffline"));
    }
  }
  return (
    <>
      <Screen title={t("library")} subtitle={t("librarySubtitle")}>
        <Button onPress={() => setEditor({})}>{t("findOrCreateFood")}</Button>
        <Section
          eyebrow={t("recipes")}
          empty={t("recipesEmpty")}
          action={<LinkButton onPress={() => setRecipeEditor({})}>{t("createRecipe")}</LinkButton>}
        >
          {recipes.map((recipe) => (
            <FoodRow
              key={recipe.id}
              food={recipeFood(recipe)}
              onPress={() => setEditor({ food: recipeFood(recipe) })}
              trailing={
                <IconButton
                  icon="edit"
                  accessibilityLabel={t("editFoodNamed", { name: recipe.name })}
                  onPress={() => setRecipeEditor({ recipe })}
                />
              }
              accessibilityActions={[
                { name: "edit", label: t("editFoodNamed", { name: recipe.name }) },
              ]}
              onAccessibilityAction={() => setRecipeEditor({ recipe })}
            />
          ))}
        </Section>
        <Section eyebrow={t("savedMeals")} empty={t("savedMealsEmpty")} note={t("savedMealsHint")}>
          {savedMeals.map((meal) => (
            <ListRow
              key={meal.id}
              title={meal.name}
              description={t("mealSummary", {
                count: format.number(meal.items.length),
                kcal: format.number(
                  totalNutrients(meal.items.map((item) => item.nutrients)).calories
                ),
              })}
              onPress={() => setMealEditor(meal)}
            />
          ))}
        </Section>
        {sections.map(([key, foods]) => (
          <Section key={key} eyebrow={titles[key].eyebrow} empty={titles[key].empty}>
            {foods.map((food) => (
              <FoodRow key={food.id} food={food} onPress={() => setEditor({ food })} />
            ))}
          </Section>
        ))}
        <Panel>
          <Panel.Title>{t("offlineCatalog")}</Panel.Title>
          <Panel.Body>
            <Meta
              tone="default"
              items={[
                t("usdaFoods", { count: format.number(catalogManifest.usda.included) }),
                t("packagedFoods", { count: format.number(catalogManifest.off.included) }),
              ]}
            />
            <Note>
              {t("catalogSize", {
                size: format.number(
                  (catalogManifest.usda.bytes + catalogManifest.off.bytes) / 1000000,
                  1
                ),
              })}
            </Note>
            <Note>{t("catalogUpdates")}</Note>
            <View className="gap-1">
              <Meta items={[catalogNames.usda, catalogManifest.usda.version]} />
              <Meta items={[catalogNames.off, catalogManifest.off.version]} />
            </View>
            {catalogManifest.off.developmentSample && <Note>{t("catalogSample")}</Note>}
            <Note>{t("usdaLicense")}</Note>
            <Note>{t("offLicense")}</Note>
            <Note>{t("checkLabels")}</Note>
            <View>
              {catalogLinks.map((link) => (
                <LinkButton
                  key={link.key}
                  icon="external"
                  accessibilityRole="link"
                  onPress={() => {
                    void openSource(link.url);
                  }}
                >
                  {"label" in link ? t(link.label) : link.name}
                </LinkButton>
              ))}
            </View>
            <ErrorText message={sourceError} />
          </Panel.Body>
        </Panel>
      </Screen>
      {recipeEditor && (
        <RecipeEditor recipe={recipeEditor.recipe} close={() => setRecipeEditor(null)} />
      )}
      {mealEditor && <MealEditor saved={mealEditor} close={() => setMealEditor(null)} />}
      {editor && <FoodEditor initialFood={editor.food} close={() => setEditor(null)} />}
    </>
  );
}
