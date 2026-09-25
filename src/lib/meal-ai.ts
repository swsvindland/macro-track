import type { JsonSchema } from "./model-json";
import { scaleNutrients, type Food, type MealItem } from "./nutrition";

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

export const MEAL_INSTRUCTIONS = `You list the foods in a meal photo and/or description for a nutrition log. Include every food and drink the person will eat. Look at every part of the plate, including toppings, spreads and sauces. List each food once; several pieces of the same food are one item with a larger quantity.

Brand: fill it only when a brand or restaurant name is readable in the photo (logo, box, cup, wrapper) or stated in the description. Never guess a brand from how food looks; otherwise leave it empty.
Branded food stays whole: a packaged product or a menu item from a named restaurant chain is one item, because its nutrition is published as a whole. Its toppings, fillings and sauces are part of it and are not listed again. For example a Domino's pizza is one item "Pepperoni pizza" counted in slices, and a McDonald's Big Mac is one item.
Unbranded food is split: a homemade or unbranded burger, sandwich, salad, bowl or plate is split into its separate components. For example an unbranded cheeseburger with fries becomes: hamburger bun, beef patty, cheddar cheese, lettuce, tomato, ketchup, french fries.
Sides, desserts and drinks are separate items.
quantity and unit describe what is shown, for example 2 slice, 1 patty, 3 strip, 1 cup, 1 tbsp. grams is your best estimate of the total edible weight for that quantity. Typical weights: burger bun 55 g, cooked burger patty 110 g, cheese slice 20 g, lettuce leaf 10 g, tomato slice 15 g, bacon strip 10 g, sausage link 50 g, ham slice 30 g, large egg 50 g, bread slice 30 g, pizza slice 110 g, tbsp of sauce 15 g, medium fries 115 g, cup of cooked rice or pasta 160 g, chicken breast 170 g.
Details in the description (brand, amount, preparation) override the photo. Do not add foods that are not shown or mentioned.`;

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

export function mealPrompt(description: string, photo: boolean) {
  const said = description.trim().replace(/\s+/g, " ").slice(0, 500);
  if (photo)
    return said
      ? `List the foods in this photo. The person says: "${said}"`
      : "List the foods in this photo.";
  return `List the foods in this meal: "${said}"`;
}

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

const isPart = (name: string) =>
  isTopping(name) || /\b(?:buns?|rolls?|bread|patty|patties|tortilla|crust)\b/i.test(name);

/** The dish a description names, without the chain or chatter: "big mac from mcdonalds" is "big mac". */
function dishFrom(description: string) {
  const said = findChain(description);
  const parts = description.replace(/[\u2018\u2019]/g, "'").split(/,|\band\b|\bwith\b|\bplus\b/i);
  const part = parts.find((text) => wholeDish.test(text)) ?? parts[0] ?? "";
  return part
    .replace(said?.pattern ?? /$^/, " ")
    .replace(/\b(?:i|had|ate|got|some|my|a|an|the|from|at|of|for|lunch|dinner|breakfast)\b/gi, " ")
    .replace(/\d+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 6)
    .join(" ");
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
    const key = `${brand}|${name}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.set(key, {
      name,
      brand,
      quantity: Number.isFinite(quantity) && quantity > 0 && quantity <= 50 ? quantity : 1,
      // "1 slice" in the unit field would otherwise double the count.
      unit: text(value.unit).replace(/^[\d./\s]+/, "") || "serving",
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
  // "big mac from mcdonalds" split into bun, patties and toppings is still one Big Mac.
  const parts = foods.filter((food) => isPart(food.name));
  const dish = said ? dishFrom(description) : "";
  if (said && dish && parts.length > 1 && !foods.some((food) => wholeDish.test(food.name)))
    foods = [
      { name: dish, brand: said.brand, quantity: 1, unit: "serving", grams: null },
      ...foods.filter((food) => !parts.includes(food)),
    ];
  // A chain's pizza or burger already includes its toppings, which small models still list.
  const whole = foods.some((food) => food.brand && wholeDish.test(food.name));
  return foods.filter((food) => !whole || food.brand || !isTopping(food.name)).slice(0, 12);
}

// --- Matching seen foods to catalog foods ---

const stop = new Set("a an and the of with in on or s to for style".split(" "));
/** Catalog wording differs from everyday names: USDA files burger buns under "Rolls, hamburger". */
const alternatives: Record<string, string[]> = {
  fries: ["fries", "fried"],
  bun: ["bun", "roll"],
  buns: ["bun", "roll"],
  ketchup: ["ketchup", "catsup"],
  soda: ["soda", "carbonated"],
  pop: ["carbonated"],
  strip: ["strip", "slice"],
  strips: ["strip", "slice"],
};

export function words(value: string): string[] {
  return (
    value
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  ).filter((word) => !stop.has(word));
}

// "Tomato slice" and "bacon strip" name a food plus how much of it; only the food is searched.
const countWords =
  /^(?:slices?|pieces?|strips?|leaf|leaves|wedges?|chunks?|servings?|portions?|cups?|bowls?|plates?|sides?|orders?|small|medium|large|regular|jumbo|mini|kids?|tall|grande|venti)$/;
function nameWords(seen: SeenFood) {
  const list = words(seen.name);
  const food = list.filter((word) => !countWords.test(word));
  return (food.length ? food : list).slice(0, 6);
}

/** A prefix that matches singular and plural forms in the catalog's prefix search. */
export function stem(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith("ies")) return word.length > 5 ? word.slice(0, -3) : word;
  if (/(?:ches|shes|xes|oes|sses)$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("y") && word.length > 4) return word.slice(0, -1);
  if (/(?:ss|us|is)$/.test(word)) return word;
  if (word.endsWith("s")) return word.slice(0, -1);
  return word;
}

const forms = (word: string) => alternatives[word] ?? [stem(word)];
function term(word: string) {
  const options = forms(word).map((form) => `"${form}"*`);
  return options.length === 1 ? options[0] : `(${options.join(" OR ")})`;
}
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

/** Restaurant and packaged foods, which suit a seen food only when its brand is known. */
export function isBranded(food: Food) {
  if (food.source === "off" || food.brand) return true;
  // USDA prefixes restaurant items in capitals: "McDONALD'S, french fries", "T.G.I. FRIDAY'S, …".
  const first = food.name.split(/[\s,]/)[0].replace(/^Mc/, "");
  return first === first.toUpperCase() && (first.match(/[A-Z]/g)?.length ?? 0) >= 2;
}

// Catalog words that describe how an ordinary food is prepared or measured, not a different food.
const neutral = new Set(
  (
    "raw cooked ripe fresh plain regular whole prepared commercial average year round all type " +
    "varieties includes baked broiled roasted grilled boiled steamed pan fried microwaved heated " +
    "cured sliced chopped diced shredded mature seeds without salt added drained solids liquid " +
    "enriched unenriched white red yellow green brewed tap water ready serve made broilers " +
    "fryers meat only flesh separable"
  )
    .split(" ")
    .map(stem)
);
// Words that mark a less common form or part; the model should name these if it means them.
const variations = new Set(
  (
    "powder dehydrated dried canned frozen unprepared imitation meatless substitute low reduced " +
    "nonfat free fortified mix flake concentrate baby infant toddler stick oil seed juice paste " +
    "puree soup dry lite light diet sugar sweetened unsweetened blend spread flavored feet " +
    "giblets liver gizzard heart neck back skin kidney tongue tripe glutinous sprouted instant " +
    "parboiled precooked turkey stewed"
  )
    .split(" ")
    .map(stem)
);

// USDA's own markers for the typical entry among varieties: "Tomatoes, red, ripe, raw, year round average".
const typical = new Set(["average", "varieties", "regular", "ripe"].map(stem));

// The everyday variety when a seen food doesn't name one ("rice" is usually long-grain).
const usual: Record<string, { mark: string[]; others: string[] }> = {
  rice: { mark: ["long"], others: ["short", "medium", "brown", "wild", "basmati", "jasmine"] },
  cheese: {
    mark: ["cheddar", "american"],
    others:
      "mozzarella parmesan swiss feta provolone cottage cream goat blue ricotta monterey brie gouda".split(
        " "
      ),
  },
  milk: {
    mark: ["whole"],
    others: "skim nonfat reduced lowfat almond soy oat chocolate buttermilk".split(" "),
  },
};

/** Both sides are stemmed, so a match may only differ by a plural-length ending. */
const same = (word: string, form: string) =>
  word === form || (word.startsWith(form) && word.length - form.length <= 2);

function coverage(seen: SeenFood, food: Food) {
  const target = nameWords(seen);
  const found = words(`${food.name} ${food.brand}`).map(stem);
  const has = (word: string) => forms(word).some((form) => found.some((w) => same(w, form)));
  // The last word names the food ("coffee" in "black coffee"); earlier words describe it.
  const weight = (i: number) => (i === target.length - 1 ? 2 : 1);
  const total = target.reduce((sum, _, i) => sum + weight(i), 0);
  const hits = target.reduce((sum, word, i) => sum + (has(word) ? weight(i) : 0), 0);
  const mentioned = [...new Set(target.flatMap(forms))];
  const extra = found.filter((w) => !/^\d+$/.test(w) && !mentioned.some((form) => same(w, form)));
  const brand = words(seen.brand);
  const lead = words(food.name.split(",")[0]).map(stem);
  const said = words(seen.name);
  const usualFor = said.map((word) => usual[word]).find(Boolean);
  return {
    name: total ? hits / total : 0,
    usual:
      !!usualFor &&
      !said.some((word) => usualFor.others.includes(word)) &&
      found.some((w) => usualFor.mark.some((mark) => same(w, stem(mark)))),
    typical: found.some((w) => typical.has(w)),
    variations: extra.filter((w) => variations.has(w)).length,
    others: extra.filter((w) => !neutral.has(w) && !variations.has(w)).length,
    // USDA leads with the food itself: "Tomatoes, red, ripe, raw", not "Canadian bacon".
    leads: lead.length > 0 && lead.every((w) => mentioned.some((form) => same(w, form))),
    brand: brand.length ? brand.every(has) : null,
  };
}

/** Orders candidates for a seen food: name match, common form, brand agreement, the person's own foods. */
export function rankFoods(seen: SeenFood, foods: Food[], known: ReadonlySet<string> = new Set()) {
  return scoreFoods(seen, foods, known).map((row) => row.food);
}

function scoreFoods(seen: SeenFood, foods: Food[], known: ReadonlySet<string>) {
  const unique = new Map<string, Food>();
  for (const food of foods) {
    const key = `${food.name}|${food.brand}`.toLowerCase();
    if (!unique.has(key) || known.has(food.id)) unique.set(key, food);
  }
  return [...unique.values()]
    .map((food, index) => {
      const match = coverage(seen, food);
      let score =
        3 * match.name +
        (match.leads ? 0.5 : 0) +
        (match.usual ? 0.6 : 0) +
        (match.typical ? 0.3 : 0) -
        0.8 * match.variations -
        0.25 * match.others;
      if (match.brand !== null) score += match.brand ? 2 : -1;
      else if (isBranded(food)) score -= 2;
      if (known.has(food.id)) score += 1.5;
      return { food, score, index, name: match.name };
    })
    .filter((row) => row.name > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);
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
    "cup tbsp tablespoon tsp teaspoon oz ounce lb pound g gram kg ml fl liter package pkg " +
    "container can bottle jar box bag scoop stick pat serving order portion cubic inch unit yield onz"
  ).split(" ")
);
const unitNames: Record<string, string> = {
  tablespoon: "tbsp",
  teaspoon: "tsp",
  ounce: "oz",
  pound: "lb",
  gram: "g",
  grams: "g",
  kilogram: "kg",
  milliliter: "ml",
  millilitre: "ml",
  liter: "l",
  litre: "l",
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
};
const weights: Record<string, number> = { g: 1, oz: 28.35, lb: 453.6, kg: 1000 };
const volumes: Record<string, number> = { ml: 1, l: 1000, cup: 240, tbsp: 15, tsp: 5, floz: 29.57 };
const sizes = new Set(["small", "medium", "large", "regular", "extra", "jumbo", "whole", "kid"]);

export function unitKey(unit: string) {
  const list = words(unit.replace(/fl\.?\s*oz/i, "floz"));
  const word = stem(list[0] ?? "piece");
  return unitNames[word] ?? unitNames[list[0] ?? ""] ?? word;
}

/** `noun` is what one portion counts: "slice" in "1 slice, medium", "serving" in "1 large serving". */
type Portion = { perUnit: number; name: string; words: string[]; noun: string };
function parsePortion(portion: Food["portions"][number]): Portion | null {
  const match = /^\s*(\d+(?:\.\d+)?|\d+\/\d+)\s+(.+)$/.exec(portion.label);
  const count = match
    ? match[1].includes("/")
      ? Number(match[1].split("/")[0]) / Number(match[1].split("/")[1])
      : Number(match[1])
    : 1;
  // "1 roll 1 serving" and "1 cup, chopped (1/2\" pieces)" are shown as "roll" and "cup".
  const name = (match?.[2] ?? portion.label)
    .split(/[,(]|\s\d/)[0]
    .trim()
    .toLowerCase();
  // Some packaged-food portions are only a weight ("1 151.0g"), which names no unit.
  if (!name || /^\d/.test(name) || !(count > 0) || !(portion.amount > 0)) return null;
  const list = words(name).map(stem);
  const noun = list.find((word) => !sizes.has(word)) ?? list[0] ?? "";
  return { perUnit: portion.amount / count, name, words: list, noun };
}

function countLabel(quantity: number, name: string) {
  const amount = Number(quantity.toFixed(2));
  const [first = "serving", ...rest] = name.toLowerCase().split(" ");
  if (amount === 1) return [1, first, ...rest].join(" ");
  const plural =
    sizes.has(first) || measures.has(first) || first.endsWith("s")
      ? first
      : first.endsWith("y") && !/[aeiou]y$/.test(first)
        ? `${first.slice(0, -1)}ies`
        : /(?:x|ch|sh)$/.test(first)
          ? `${first}es`
          : `${first}s`;
  return [amount, plural, ...rest].join(" ");
}

/**
 * Converts the seen quantity to the food's basis. Catalog portions ("1 slice = 113 g")
 * beat the model's own weight guess, which is the least reliable thing it produces.
 */
export function resolveAmount(
  seen: SeenFood,
  food: Food
): { amount: number; portionLabel: string } {
  const quantity = seen.quantity;
  const unit = unitKey(seen.unit);
  const done = (amount: number, shown: string) => {
    // No single food in a meal plausibly weighs more than 2 kg.
    const value = Math.min(Math.max(amount, food.basis === "serving" ? 0.1 : 1), 2000);
    return {
      amount: Number(value.toFixed(food.basis === "serving" ? 2 : 1)),
      portionLabel:
        food.basis === "serving" ? `≈ ${shown}` : `≈ ${shown} · ${Math.round(value)} ${food.basis}`,
    };
  };
  if (food.basis === "serving")
    return done(
      quantity,
      countLabel(quantity, food.portions[0]?.label.replace(/^1\s+/, "") || "serving")
    );
  if (food.basis === "g" && weights[unit])
    return done(quantity * weights[unit], countLabel(quantity, unit));
  if (food.basis === "ml" && volumes[unit])
    return done(quantity * volumes[unit], countLabel(quantity, unit));
  const portions = food.portions.map(parsePortion).filter((p): p is Portion => !!p);
  const pick = (list: Portion[]) =>
    list.find((p) => /\b(?:medium|regular)\b/.test(p.name)) ?? list[0];
  const named = portions.filter((p) => forms(unit).some((form) => p.noun === stem(form)));
  if (named.length) {
    const portion = pick(named);
    return done(quantity * portion.perUnit, countLabel(quantity, portion.name));
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
      return done(grams, countLabel(quantity, portion.name));
  }
  if (seen.grams)
    return done(
      quantity >= 3 ? Math.min(seen.grams, quantity * 75) : seen.grams,
      countLabel(quantity, seen.unit)
    );
  const first = portions[0];
  return first
    ? done(quantity * first.perUnit, countLabel(quantity, first.name))
    : done(100 * quantity, countLabel(quantity, seen.unit));
}

export function draftItem(seen: SeenFood, food: Food): MealItem {
  const { amount, portionLabel } = resolveAmount(seen, food);
  return { food, amount, portionLabel, nutrients: scaleNutrients(food, amount) };
}

// --- The whole analysis ---

export type AnalysisDeps = {
  generate: (request: ModelRequest) => Promise<unknown>;
  /** Runs one catalog search expression. */
  search: (expression: string) => Promise<Food[]>;
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
  for (const query of catalogQueries(seen)) {
    if (pool.size >= 40) break;
    add(await deps.search(query));
  }
  // A misread brand should cost one tap, so the plain food stays among the options.
  const plain = seen.brand ? catalogQueries({ ...seen, brand: "" })[0] : undefined;
  if (plain) add(await deps.search(plain));
  const ranked = scoreFoods(seen, [...pool.values()], known);
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
  const seen = readSeenFoods(
    await deps.generate({
      instructions: MEAL_INSTRUCTIONS,
      prompt: mealPrompt(input.description, !!input.imageUri),
      schema: MEAL_SCHEMA,
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
