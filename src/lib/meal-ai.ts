import {
  countWords,
  coverage,
  forms,
  isBranded,
  nameWords,
  profileFor,
  same,
  scoreFoods,
  stem,
  term,
  words,
} from "./food-rank";
import type { JsonSchema } from "./model-json";
import {
  countLabel,
  formatCount,
  parseAmount,
  parsePortion,
  portionLabelFor,
  portionUnitKey,
  portionUnits,
  scaleNutrients,
  servingSize,
  sizes,
  type Food,
  type MealItem,
} from "./nutrition";

export { isBranded, rankFoods, stem, words } from "./food-rank";

/**
 * Photo/description logging. The on-device model only names the foods and their amounts;
 * nutrients always come from catalog foods, so an entry is as good as the food it matched.
 */

/** One food the model saw or read about, before it is matched to the catalog. */
export type SeenFood = {
  name: string;
  brand: string;
  quantity: number;
  unit: string;
  grams: number | null;
};

/** A drafted diary entry: what was seen, the catalog foods it could be, and the current pick. */
export type DraftFood = {
  key: string;
  seen: SeenFood;
  options: Food[];
  item: MealItem | null;
};

export type ModelRequest = {
  instructions: string;
  prompt: string;
  schema: JsonSchema;
  imageUri?: string;
  maxTokens?: number;
};

export const MEAL_INSTRUCTIONS = `You list the foods in a meal photo and/or description for a nutrition log. A wrong food in the log is worse than a missing one, because the person can always add what you left out. List only food and drink you can clearly see or that the person names, including toppings, spreads and sauces you can see on the plate. List each food once; several pieces of the same food are one item with a larger quantity.

Brand: fill it only when a brand or restaurant name is readable in the photo (logo, box, cup, wrapper) or stated in the description. Never guess a brand from how food looks; otherwise leave it empty.
Branded food stays whole: a packaged product or a menu item from a named restaurant chain is one item, because its nutrition is published as a whole. Its toppings, fillings and sauces are part of it and are not listed again. For example a Domino's pizza is one item "Pepperoni pizza" counted in slices, and a McDonald's Big Mac is one item.
Unbranded food is split: a homemade or unbranded burger, sandwich, salad, bowl or plate is split into its separate components. For example an unbranded cheeseburger with fries becomes: hamburger bun, beef patty, cheddar cheese, lettuce, tomato, ketchup, french fries.
Sides, desserts and drinks are separate items.
quantity and unit describe what is shown, for example 2 slice, 1 patty, 3 strip, 1 cup, 1 tbsp. grams is your best estimate of the total edible weight for that quantity. Typical weights: burger bun 55 g, cooked burger patty 110 g, cheese slice 20 g, lettuce leaf 10 g, tomato slice 15 g, bacon strip 10 g, sausage link 50 g, ham slice 30 g, large egg 50 g, bread slice 30 g, pizza slice 110 g, tbsp of sauce 15 g, medium fries 115 g, cup of cooked rice or pasta 160 g, chicken breast 170 g.
Details in the description (brand, amount, preparation) override the photo. Do not add foods that are not shown or mentioned, and never guess a food from its setting (a table, a kitchen, a restaurant) or from a shape or colour that only resembles food.`;

/** Added for photos, whose reply first says what is pictured and whether it is food at all. */
export const PHOTO_INSTRUCTIONS = `Photos are often not of food, or not clearly. Before listing anything, write in scene what the photo really shows in a few plain words, e.g. "a plate of spaghetti", "a person smiling", "a dog on a couch", "an empty desk". Then set food to true only if real food or drink someone is about to eat is clearly visible and you can tell what it is. People, faces, pets, rooms, screens, menus, empty plates, closed packaging you can't read and anything blurry or too dark are not food: set food to false and leave items empty. When unsure, set food to false; the person will be asked to describe the meal instead. If the person's description names foods, list those even when the photo doesn't show them.`;

export const MEAL_SCHEMA: JsonSchema = {
  title: "MealFoods",
  type: "object",
  additionalProperties: false,
  properties: {
    items: {
      type: "array",
      maxItems: 12,
      items: {
        title: "Food",
        type: "object",
        additionalProperties: false,
        properties: {
          brand: {
            type: "string",
            description: "Restaurant chain or product brand if visible or stated, otherwise empty",
          },
          name: {
            type: "string",
            description: "Common food name, e.g. Pepperoni pizza, Hamburger bun, Beef patty",
          },
          quantity: { type: "number", minimum: 0.1, maximum: 50, description: "How many units" },
          unit: { type: "string", description: "e.g. slice, piece, patty, cup, tbsp, serving" },
          grams: {
            type: "number",
            minimum: 1,
            maximum: 3000,
            description: "Estimated total edible weight in grams",
          },
        },
        required: ["brand", "name", "quantity", "unit", "grams"],
        "x-order": ["brand", "name", "quantity", "unit", "grams"],
      },
    },
  },
  required: ["items"],
  "x-order": ["items"],
};

/**
 * A photo reply commits to what is pictured before listing foods, so a person, pet or room
 * reads as "no food" instead of the most likely meal.
 */
export const MEAL_PHOTO_SCHEMA: JsonSchema = {
  ...MEAL_SCHEMA,
  title: "MealPhoto",
  properties: {
    scene: {
      type: "string",
      description: "What the photo really shows in a few words, e.g. a plate of pasta, a person",
    },
    food: {
      type: "boolean",
      description: "true only if food or drink is clearly visible and recognizable",
    },
    ...MEAL_SCHEMA.properties,
  },
  required: ["scene", "food", "items"],
  "x-order": ["scene", "food", "items"],
};

export function mealPrompt(description: string, photo: boolean) {
  const said = description.trim().replace(/\s+/g, " ").slice(0, 500);
  if (photo)
    return said
      ? `Say what this photo shows, then list the foods in it. The person says: "${said}"`
      : "Say what this photo shows, then list the foods in it, if there are any.";
  return `List the foods in this meal: "${said}"`;
}

/** The model's own verdict that a photo holds no recognizable food. */
const noFoodPictured = (reply: unknown) =>
  !!reply && typeof reply === "object" && (reply as { food?: unknown }).food === false;

const text = (value: unknown) =>
  typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, 80) : "";
const noBrand = /^(?:none|n\/?a|unknown|generic|homemade|no brand|unbranded|-)$/i;

const wholeDish =
  /\b(?:pizza|burger|cheeseburger|sandwich|sub|burrito|taco|wrap|bowl|salad|quesadilla|hot ?dog|big mac|whopper)\b/i;
// Words that only ever describe what is on or in a dish: its toppings, fillings and sauces.
const toppingWords = new Set(
  (
    "bacon ham pepperoni salami sausage beef ground chicken turkey steak patty meatball meatballs " +
    "mushroom mushrooms onion onions pepper peppers olive olives cheese mozzarella cheddar parmesan " +
    "provolone american swiss lettuce tomato tomatoes pickle pickles jalapeno jalapenos pineapple " +
    "spinach sauce marinara pizza bbq ketchup mustard mayo mayonnaise dressing guacamole guac salsa " +
    "sour cream rice beans bean corn sliced diced chopped shredded grilled fried crispy fresh green " +
    "red black white brown pinto refried banana bell hot mild spicy crumbled extra"
  ).split(" ")
);
function isTopping(name: string) {
  const list = words(name).filter((word) => !countWords.test(word));
  return list.length > 0 && list.every((word) => toppingWords.has(word));
}
const toppingUnits = new Set(
  "slice strip leaf leave tbsp tsp pinch dash sprinkle dollop drizzle pat".split(" ")
);
/** A topping word in a topping's amount; a real side (a banana, beans and rice) weighs more. */
const isOnDish = (food: SeenFood) =>
  isTopping(food.name) &&
  ((food.grams !== null && food.grams <= 40) || toppingUnits.has(unitKey(food.unit)));

const isPart = (name: string) =>
  isTopping(name) ||
  /\b(?:buns?|rolls?|bread|patty|patties|tortilla|crust|muffins?|biscuits?|eggs?|sauces?)\b/i.test(
    name
  );

/**
 * The dish a description names, without the chain or chatter ("big mac from mcdonalds" is
 * "big mac"), and the stems of everything else it names.
 */
function dishFrom(said: { pattern: RegExp; plain: string }) {
  const clean = (text: string) =>
    text
      .replace(said.pattern, " ")
      .replace(
        /\b(?:i|had|ate|got|some|my|a|an|the|from|at|of|for|lunch|dinner|breakfast)\b/gi,
        " "
      )
      .replace(/\d+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  // Separators stay at odd indexes.
  const pieces = said.plain.split(/(,|\band\b|\bwith\b|\bplus\b)/i);
  const find = (test: (text: string) => boolean) =>
    pieces.findIndex((text, i) => i % 2 === 0 && test(text));
  // A whole dish, else the item the chain names ("a starbucks latte", not "fries from
  // mcdonalds"), else the first thing named.
  const via = new RegExp(`\\b(?:from|at|by)\\s+(?:${said.pattern.source})`, "i");
  let at = find((text) => wholeDish.test(text));
  if (at < 0) at = find((text) => said.pattern.test(text) && !via.test(text) && !!clean(text));
  if (at < 0) at = find((text) => !!clean(text));
  const start = Math.max(0, at);
  let end = start;
  // Menu items name their egg or cheese: "sausage mcmuffin with egg".
  while (
    /^with$/i.test(pieces[end + 1] ?? "") &&
    /^\s*(?:eggs?|cheese)\s*$/i.test(pieces[end + 2] ?? "")
  )
    end += 2;
  const rest = pieces.filter((_, i) => i % 2 === 0 && (i < start || i > end));
  return {
    dish: clean(pieces.slice(start, end + 1).join(" "))
      .split(" ")
      .slice(0, 6)
      .join(" "),
    others: new Set(words(rest.map(clean).join(" ")).map(stem)),
  };
}

/** Chains whose menu items are catalogued whole. Small models often write the chain into the name. */
const chains: [RegExp, string][] = [
  [/\bdomino'?s\b/i, "Domino's"],
  [/\bpizza hut\b/i, "Pizza Hut"],
  [/\bpapa john'?s\b/i, "Papa John's"],
  [/\blittle caesar'?s\b/i, "Little Caesars"],
  [/\bmc ?donald'?s\b/i, "McDonald's"],
  [/\bburger king\b/i, "Burger King"],
  [/\bwendy'?s\b/i, "Wendy's"],
  [/\btaco bell\b/i, "Taco Bell"],
  [/\bkfc\b|\bkentucky fried chicken\b/i, "KFC"],
  [/\bsubway\b/i, "Subway"],
  [/\bstarbucks\b/i, "Starbucks"],
  [/\bdunkin'?(?: donuts)?\b/i, "Dunkin'"],
  [/\bchick-?fil-?a\b/i, "Chick-fil-A"],
  [/\bpopeyes\b/i, "Popeyes"],
  [/\bpanera\b/i, "Panera"],
  [/\bfive guys\b/i, "Five Guys"],
  [/\bin-?n-?out\b/i, "In-N-Out"],
  [/\barby'?s\b/i, "Arby's"],
  [/\bjack in the box\b/i, "Jack in the Box"],
  [/\bdairy queen\b/i, "Dairy Queen"],
  [/\bwhataburger\b/i, "Whataburger"],
  [/\bpanda express\b/i, "Panda Express"],
  [/\bshake shack\b/i, "Shake Shack"],
  [/\bolive garden\b/i, "Olive Garden"],
  [/\bapplebee'?s\b/i, "Applebee's"],
  [/\bdenny'?s\b/i, "Denny's"],
  [/\bihop\b/i, "IHOP"],
  [/\bcarl'?s jr\.?/i, "Carl's Jr."],
  [/\bhardee'?s\b/i, "Hardee's"],
  [/\bjimmy john'?s\b/i, "Jimmy John's"],
  [/\bchipotle (?:mexican grill|bowl|burrito)/i, "Chipotle"],
];
function findChain(value: string) {
  const plain = value.replace(/[\u2018\u2019]/g, "'");
  for (const [pattern, brand] of chains) if (pattern.test(plain)) return { pattern, brand, plain };
  return null;
}

/**
 * Validates the model's reply; repeated entries are a generation loop, not extra food. The
 * person's description can name the chain when the model didn't.
 */
export function readSeenFoods(reply: unknown, description = ""): SeenFood[] {
  // Foods listed anyway for a photo judged not to show any are guesses; a description is not.
  if (!description.trim() && noFoodPictured(reply)) return [];
  const rows =
    reply && typeof reply === "object" && Array.isArray((reply as { items?: unknown }).items)
      ? (reply as { items: unknown[] }).items
      : [];
  const seen = new Map<string, SeenFood>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const value = row as Record<string, unknown>;
    let name = text(value.name);
    let brand = noBrand.test(text(value.brand)) ? "" : text(value.brand);
    const chain = findChain(brand || name);
    if (chain && !brand) {
      // "dominos pepperoni pizza" is Domino's "pepperoni pizza".
      const rest = chain.plain
        .replace(chain.pattern, " ")
        .replace(/^\W*(?:from|at|by)\b|\b(?:from|at|by)\W*$/gi, "")
        .replace(/\s+/g, " ")
        .trim();
      if (words(rest).length) name = rest;
    }
    if (chain) brand = chain.brand;
    if (!name) continue;
    const quantity = Number(value.quantity);
    const grams = Number(value.grams);
    // "1 slice" in the unit field would otherwise double the count.
    const unit = text(value.unit).replace(/^[\d./\s]+/, "") || "serving";
    const key = `${brand}|${name}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.set(key, {
      name,
      brand,
      quantity: Number.isFinite(quantity) && quantity > 0 && quantity <= most(unit) ? quantity : 1,
      unit,
      grams: Number.isFinite(grams) && grams >= 1 && grams <= 3000 ? grams : null,
    });
  }
  let foods = [...seen.values()];
  const said = findChain(description);
  if (said && !foods.some((food) => food.brand)) {
    const dish =
      foods.find((food) => wholeDish.test(food.name)) ?? (foods.length === 1 ? foods[0] : null);
    if (dish) dish.brand = said.brand;
  }
  // "big mac from mcdonalds" split into bun, patties and toppings is still one Big Mac. Foods the
  // description names on their own ("and a banana") are not its parts, and a dish that is
  // already listed ("blueberry muffin", "chicken nuggets" for "mcnuggets") is not rebuilt.
  if (said) {
    const { dish, others } = dishFrom(said);
    const named = words(dish)
      .filter((word) => !countWords.test(word))
      .map(stem);
    const parts = foods.filter(
      (food) => isPart(food.name) && !nameWords(food).some((word) => others.has(stem(word)))
    );
    const listed = (food: SeenFood) => {
      const own = nameWords(food).map(stem);
      return (
        wholeDish.test(food.name) ||
        named.every((word) => own.includes(word)) ||
        (!parts.includes(food) &&
          own.some((word) =>
            named.some(
              (dishWord) => dishWord === word || (word.length > 3 && dishWord.endsWith(word))
            )
          ))
      );
    };
    if (named.length && parts.length > 1 && !foods.some(listed))
      foods = [
        { name: dish, brand: said.brand, quantity: 1, unit: "serving", grams: null },
        ...foods.filter((food) => !parts.includes(food)),
      ];
  }
  // A chain's pizza or burger already includes its toppings, which small models still list.
  const whole = foods.some((food) => food.brand && wholeDish.test(food.name));
  return foods.filter((food) => !whole || food.brand || !isOnDish(food)).slice(0, 12);
}

/** Counts above 50 are a generation loop, but 200 g is an ordinary weight. */
function most(unit: string) {
  const key = unitKey(unit);
  const size = weights[key] ?? volumes[key];
  return size ? Math.max(50, 3000 / size) : 50;
}

// --- Matching seen foods to catalog foods ---

const every = (list: string[]) => list.map(term).join(" AND ");

/** Catalog searches from most to least specific. */
export function catalogQueries(seen: SeenFood): string[] {
  const name = nameWords(seen);
  const brand = words(seen.brand).slice(0, 3);
  const queries: string[] = [];
  if (brand.length && name.length) {
    queries.push(every([...brand, ...name]));
    if (name.length > 1) queries.push(every([...brand, name.at(-1)!]));
  }
  if (name.length) queries.push(every(name));
  if (name.length > 2) queries.push(every(name.slice(-2)));
  // The head noun ("cheese" of "cheddar cheese"), then the first word ("beef" of "beef patty").
  if (name.length > 1) queries.push(term(name.at(-1)!), term(name[0]));
  return [...new Set(queries)];
}

export const PICK_INSTRUCTIONS = `You match foods from a meal to entries in a nutrition database. For each food, choose the entry that is the same food in the form it is usually eaten: cooked rather than raw for meat, fish, eggs, rice and pasta; ripe, raw and plain for salad vegetables and fruit; ready to eat rather than dry, frozen or unprepared; the regular version rather than low fat, meatless or flavored; a generic entry rather than a brand-name product, unless the food names a restaurant or brand; the food itself rather than a dish that contains it. Cheese on a burger or sandwich is usually American or cheddar.`;

/**
 * A second, text-only pass lets the model apply food knowledge that keyword ranking lacks.
 * `asked` lists the seen foods whose ranking was close enough to need it.
 */
export function pickRequest(
  seen: SeenFood[],
  pools: Food[][],
  asked: number[]
): ModelRequest | null {
  if (!asked.length) return null;
  const prompt = asked
    .map((i, n) =>
      [
        `Food ${n + 1}: ${seen[i].brand ? `${seen[i].brand} ` : ""}${seen[i].name}`,
        ...pools[i].map(
          (food, j) => `  ${j + 1}. ${food.name}${food.brand ? ` (${food.brand})` : ""}`
        ),
      ].join("\n")
    )
    .join("\n\n");
  const most = Math.max(...asked.map((i) => pools[i].length));
  return {
    instructions: PICK_INSTRUCTIONS,
    prompt: `Choose one entry number for each food.\n\n${prompt}`,
    maxTokens: 40 + asked.length * 24,
    schema: {
      title: "Picks",
      type: "object",
      additionalProperties: false,
      properties: {
        picks: {
          type: "array",
          minItems: asked.length,
          maxItems: asked.length,
          items: {
            title: "Pick",
            type: "object",
            additionalProperties: false,
            properties: {
              food: { type: "integer", minimum: 1, maximum: asked.length },
              entry: { type: "integer", minimum: 1, maximum: most },
            },
            required: ["food", "entry"],
            "x-order": ["food", "entry"],
          },
        },
      },
      required: ["picks"],
      "x-order": ["picks"],
    },
  };
}

/** The chosen option per seen food (-1 when nothing was found); unanswered foods keep the ranked first choice. */
export function readPicks(reply: unknown, pools: Food[][], asked: number[]): number[] {
  const picks = pools.map((pool): number => (pool.length ? 0 : -1));
  const rows =
    reply && typeof reply === "object" && Array.isArray((reply as { picks?: unknown }).picks)
      ? (reply as { picks: unknown[] }).picks
      : [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const { food, entry } = row as { food?: unknown; entry?: unknown };
    const i = asked[Number(food) - 1];
    const choice = Number(entry);
    if (i !== undefined && Number.isInteger(choice) && choice >= 1 && choice <= pools[i].length)
      picks[i] = choice - 1;
  }
  return picks;
}

// --- Amounts ---

const measures = new Set(
  (
    "cup tbsp tablespoon tsp teaspoon oz ounce lb pound g gram kg ml fl floz l liter pint " +
    "quart gallon package pkg container can bottle jar box bag scoop stick pat serving order " +
    "portion cubic inch unit yield onz kcal"
  ).split(" ")
);
// stem() leaves words of three letters alone, so short plurals are listed too.
const unitNames: Record<string, string> = {
  tablespoon: "tbsp",
  tbs: "tbsp",
  teaspoon: "tsp",
  ounce: "oz",
  ozs: "oz",
  pound: "lb",
  lbs: "lb",
  gram: "g",
  grams: "g",
  gms: "g",
  kilogram: "kg",
  kilo: "kg",
  kgs: "kg",
  milliliter: "ml",
  mls: "ml",
  millilitre: "ml",
  liter: "l",
  litre: "l",
  qt: "quart",
  gal: "gallon",
  portion: "serving",
  order: "serving",
  plate: "serving",
  bowl: "serving",
  helping: "serving",
  pc: "piece",
  each: "piece",
  item: "piece",
  whole: "piece",
  unit: "piece",
  count: "piece",
  onz: "oz",
  cal: "kcal",
  calorie: "kcal",
};
const weights: Record<string, number> = { g: 1, oz: 28.35, lb: 453.6, kg: 1000 };
const volumes: Record<string, number> = {
  ml: 1,
  l: 1000,
  cup: 240,
  tbsp: 15,
  tsp: 5,
  floz: 29.57,
  pint: 473,
  quart: 946,
  gallon: 3785,
};
export function unitKey(unit: string) {
  const list = words(unit.replace(/\bfl(?:uid)?\.?\s*(?:oz|ounces?)\b/i, "floz"));
  const word = stem(list[0] ?? "piece");
  return unitNames[word] ?? unitNames[list[0] ?? ""] ?? word;
}

/** `noun` is what one portion counts: "slice" in "1 slice, medium", "serving" in "1 large serving". */
type Portion = { index: number; perUnit: number; name: string; noun: string };
function portionsOf(food: Food): Portion[] {
  return food.portions.flatMap((portion, index) => {
    const parsed = parsePortion(portion);
    if (!parsed) return [];
    const list = words(parsed.name).map(stem);
    const noun = list.find((word) => !sizes.has(word)) ?? list[0] ?? "";
    return [{ index, perUnit: parsed.perUnit, name: parsed.name, noun }];
  });
}

/**
 * Converts the seen quantity to the food's basis, and to the unit the portion screen offers
 * for it. Catalog portions ("1 slice = 113 g") beat the model's own weight guess, which is the
 * least reliable thing it produces.
 */
export function resolveAmount(
  seen: SeenFood,
  food: Food
): { amount: number; portionLabel: string; unit: string; count: number } {
  const quantity = seen.quantity;
  const unit = unitKey(seen.unit);
  const units = portionUnits(food);
  /** `count` is the seen quantity when it counts the `key` unit, whose label then describes it. */
  const done = (amount: number, shown: string, key?: string | null, count?: number) => {
    // No single food in a meal plausibly weighs more than 2 kg.
    const value = Number(
      Math.min(Math.max(amount, food.basis === "serving" ? 0.1 : 1), 2000).toFixed(
        food.basis === "serving" ? 2 : 1
      )
    );
    const found = units.find((row) => row.key === key);
    const unit = found ?? units.find((row) => row.key === food.basis)!;
    // The seen count, unless the cap changed the amount; shown as the amount field shows it.
    const counted =
      count !== undefined && Math.abs(count * unit.perUnit - value) <= value * 0.01
        ? count
        : value / unit.perUnit;
    const shownCount = parseAmount(formatCount(counted, unit));
    return {
      amount: value,
      portionLabel:
        found && count !== undefined
          ? portionLabelFor(food, found.key, shownCount, { estimate: true })
          : food.basis === "serving"
            ? `≈ ${shown}`
            : `≈ ${shown} · ${Math.round(value)} ${food.basis}`,
      unit: unit.key,
      count: shownCount,
    };
  };
  const shown = unit === "floz" ? "fl oz" : unit;
  const servings = (value: number) => {
    const count = Number(value.toFixed(2));
    return `${countLabel(quantity, shown)} · ${count} serving${count === 1 ? "" : "s"}`;
  };
  // Grams, cups or kcal the food converts itself.
  const direct = units.find((row) => row.key === unit && row.kind !== "count");
  if (direct) return done(quantity * direct.perUnit, "", unit, quantity);
  const measured = weights[unit] ?? volumes[unit];
  if (food.basis === "serving") {
    const serving = food.portions[0]?.label.replace(/^1\s+/, "") || "serving";
    const first = food.portions.length ? portionUnitKey(food, 0) : null;
    if (!measured) return done(quantity, countLabel(quantity, serving), first, quantity);
    // "30 g" is 30 g worth of servings, not 30 of them. Without a serving weight it is one
    // serving, which the "≈" marks as a guess.
    const size = servingSize(food)[weights[unit] ? "weight" : "volume"];
    if (!size) return done(1, countLabel(1, serving), first);
    const amount = (quantity * measured) / size;
    return done(amount, servings(amount));
  }
  if (food.basis === "g" && weights[unit])
    return done(quantity * weights[unit], countLabel(quantity, shown));
  if (food.basis === "ml" && volumes[unit])
    return done(quantity * volumes[unit], countLabel(quantity, shown));
  const portions = portionsOf(food);
  // "1 cup, dry, yields" is what a cup of the dry food makes, not a cup of this one.
  const pick = (list: Portion[]) =>
    list.find((p) => /\b(?:medium|regular)\b/.test(p.name)) ??
    list.find((p) => !/\byields?\b/i.test(food.portions[p.index].label)) ??
    list[0];
  const key = (portion: Portion) => portionUnitKey(food, portion.index);
  const named = portions.filter((p) => forms(unit).some((form) => p.noun === stem(form)));
  if (named.length) {
    const portion = pick(named);
    return done(
      quantity * portion.perUnit,
      countLabel(quantity, portion.name),
      key(portion),
      quantity
    );
  }
  // "250 ml" of milk goes through its own "1 fl oz" of 30.5 g; without one, or for a drink logged
  // by weight, the model's weight or water's density.
  const across = food.basis === "g" ? volumes[unit] : weights[unit];
  if (across) {
    const own = food.basis === "g" ? portions.find((p) => volumes[unitKey(p.name)]) : undefined;
    if (own || !seen.grams) {
      const density = own ? own.perUnit / volumes[unitKey(own.name)] : 1;
      return done(quantity * across * density, countLabel(quantity, shown));
    }
  }
  // "1 piece" of a food means its natural unit: a chicken breast's "breast", an egg's "large".
  // That guess is checked against the model's weight, so a lettuce "piece" never becomes a head.
  if (unit === "piece" || !measures.has(unit)) {
    const natural = portions.filter((p) => !measures.has(p.noun));
    const own = nameWords(seen).map(stem);
    const portion = natural.length
      ? (natural.find((p) => own.some((word) => same(p.noun, word))) ?? pick(natural))
      : null;
    const grams = portion ? quantity * portion.perUnit : 0;
    // Several of something are small pieces: ten nigiri are not ten salmon fillets.
    const small = quantity < 3 || (portion?.perUnit ?? 0) <= 150;
    if (portion && small && (!seen.grams || (grams < seen.grams * 4 && grams > seen.grams / 4)))
      return done(grams, countLabel(quantity, portion.name), key(portion), quantity);
  }
  if (seen.grams)
    return done(
      quantity >= 3 ? Math.min(seen.grams, quantity * 75) : seen.grams,
      countLabel(quantity, seen.unit)
    );
  const first = portions[0];
  return first
    ? done(quantity * first.perUnit, countLabel(quantity, first.name), key(first), quantity)
    : done(100 * quantity, countLabel(quantity, seen.unit));
}

export function draftItem(seen: SeenFood, food: Food): MealItem {
  const { amount, portionLabel, unit, count } = resolveAmount(seen, food);
  return {
    food,
    amount,
    portionLabel,
    portionUnit: unit,
    portionCount: count,
    nutrients: scaleNutrients(food, amount),
  };
}

// --- The whole analysis ---

export type AnalysisDeps = {
  generate: (request: ModelRequest) => Promise<unknown>;
  /** Runs one catalog search expression. */
  search: (expression: string) => Promise<Food[]>;
  /** The packaged foods those searches found that are sold only in other countries. */
  away?: ReadonlySet<string>;
  /** The person's own, saved and recent foods, preferred when they match. */
  known: Food[];
  /** Reports progress; the seen foods arrive before matching so they can be shown right away. */
  onStage?: (stage: "reading" | "matching", seen?: SeenFood[]) => void;
};

async function candidates(seen: SeenFood, deps: AnalysisDeps, known: ReadonlySet<string>) {
  const pool = new Map<string, Food>();
  for (const food of deps.known) if (coverage(seen, food).name >= 0.5) pool.set(food.id, food);
  const add = (foods: Food[]) => {
    for (const food of foods) if (!pool.has(food.id)) pool.set(food.id, food);
  };
  const searched = new Map<string, Food[]>();
  const search = async (query: string) => {
    const found = searched.get(query) ?? (await deps.search(query));
    searched.set(query, found);
    add(found);
    return found;
  };
  for (const query of catalogQueries(seen)) {
    if (pool.size >= 40) break;
    await search(query);
  }
  // A misread brand should cost one tap, so the plain food stays among the options. What it
  // usually is also tells the brand's own name for it from the brand's other foods: Trader Joe's
  // Mini-Wheats are its "Shredded Bite Size Wheats", not its wheat bread.
  const plain = seen.brand ? catalogQueries({ ...seen, brand: "" })[0] : undefined;
  const kind = plain ? profileFor(nameWords(seen), await search(plain)) : null;
  const ranked = scoreFoods(seen, [...pool.values()], known, false, {
    away: deps.away,
    profile: kind,
  });
  const head = ranked.slice(0, seen.brand ? 6 : 8);
  const generic = seen.brand
    ? ranked.filter((row) => !head.includes(row) && !isBranded(row.food)).slice(0, 2)
    : [];
  const top = [
    ...head,
    ...generic,
    ...ranked.filter((row) => !head.includes(row) && !generic.includes(row)),
  ].slice(0, 8);
  // The model only settles near-ties (raw or cooked, which lettuce); it can't override a far
  // better name match, and a clear winner needs no second opinion at all.
  const best = top[0]?.score ?? 0;
  const tied = top.findIndex((row) => row.score < best - 1);
  return {
    foods: top.map((row) => row.food),
    tied: Math.min(tied < 0 ? top.length : tied, 6),
    // A weak best match ("raw salmon" for "salmon nigiri") is offered, not chosen.
    sure: best >= 1.5,
  };
}

export async function analyzeMeal(
  input: { description: string; imageUri?: string },
  deps: AnalysisDeps
): Promise<DraftFood[]> {
  if (!input.description.trim() && !input.imageUri)
    throw new Error("Add a photo or describe what you ate.");
  deps.onStage?.("reading");
  const photo = !!input.imageUri;
  const seen = readSeenFoods(
    await deps.generate({
      instructions: photo ? `${MEAL_INSTRUCTIONS}\n${PHOTO_INSTRUCTIONS}` : MEAL_INSTRUCTIONS,
      prompt: mealPrompt(input.description, photo),
      schema: photo ? MEAL_PHOTO_SCHEMA : MEAL_SCHEMA,
      imageUri: input.imageUri,
      maxTokens: 900,
    }),
    input.description
  );
  if (!seen.length) return [];
  deps.onStage?.("matching", seen);
  const known = new Set(deps.known.map((food) => food.id));
  const found = await Promise.all(seen.map((food) => candidates(food, deps, known)));
  const pools = found.map((row) => row.foods);
  // Ties are a prefix of each pool, so a pick's index is the same in both.
  const ties = found.map((row) => row.foods.slice(0, row.tied));
  const asked = ties.flatMap((tie, i) => (tie.length > 1 && found[i].sure ? [i] : []));
  let picks = found.map((row): number => (row.sure && row.foods.length ? 0 : -1));
  const request = pickRequest(seen, ties, asked);
  if (request) {
    try {
      const read = readPicks(await deps.generate(request), ties, asked);
      picks = picks.map((pick, i) => (asked.includes(i) ? read[i] : pick));
    } catch {
      // The ranked first choices are a usable draft on their own.
    }
  }
  const stamp = Date.now();
  return seen.map((food, i) => {
    const pick = picks[i];
    const options =
      pick > 0 ? [pools[i][pick], ...pools[i].filter((_, j) => j !== pick)] : pools[i];
    return {
      key: `${stamp}:${i}`,
      seen: food,
      options,
      item: pick >= 0 && options.length ? draftItem(food, options[0]) : null,
    };
  });
}
