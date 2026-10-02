import type { Food } from "./nutrition";

/**
 * Keyword matching shared by manual search and photo logging. The catalogs' full-text index has
 * no stemming, so words are searched as stemmed prefixes and the results are ranked here.
 */

/** What a search or the model names: "chicken breast", or "big mac" from McDonald's. */
export type Named = { name: string; brand: string };
/** The person's own foods by id, with how often they eat them when that is known. */
export type Known = ReadonlySet<string> | ReadonlyMap<string, number>;
/**
 * Catalog words a typed word probably meant, when the catalog barely knows it as typed:
 * "chiken" → ["chicken"], "peanutbutter" → ["peanut butter"]. Forms are stemmed like the word's.
 */
export type Fixes = Readonly<Record<string, readonly string[]>>;
/** What a typed search knows beyond its words: corrections and how often foods are scanned. */
export type SearchHints = {
  fixes?: Fixes;
  popularity?: ReadonlyMap<string, number>;
  /** Packaged foods sold only in other countries than the phone's. */
  away?: ReadonlySet<string>;
};

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
  oatmeal: ["oatmeal", "oat"],
  burger: ["burger", "hamburger"],
  burgers: ["burger", "hamburger"],
};

const plain = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
const tokens = (value: string): string[] => plain(value).match(/[\p{L}\p{N}]+/gu) ?? [];
const number = (word: string) => /^\d+$/.test(word);

export function words(value: string): string[] {
  return tokens(value).filter((word) => !stop.has(word));
}

// "Tomato slice" and "bacon strip" name a food plus how much of it; only the food is searched.
export const countWords =
  /^(?:slices?|pieces?|strips?|leaf|leaves|wedges?|chunks?|servings?|portions?|cups?|bowls?|plates?|sides?|orders?|small|medium|large|regular|jumbo|mini|kids?|tall|grande|venti)$/;
export function nameWords(seen: Named) {
  const list = words(seen.name);
  const food = list.filter((word) => !countWords.test(word));
  return (food.length ? food : list).slice(0, 6);
}

// A search can carry its amount: "cup of coffee", "200 g chicken", "2 eggs".
const unitWords =
  /^(?:g|grams?|gms?|kg|kgs|kilos?|oz|ounces?|lbs?|pounds?|ml|mls|l|liters?|litres?|fl|floz|tbsp|tbs|tsp|tablespoons?|teaspoons?|scoops?|cans?|bottles?|glass|glasses|mugs?|shots?|pints?|handfuls?)$/;
// A size before the food says how much of it: "large egg", "grande latte". "Mini" names products.
const sizeWords = /^(?:small|medium|large|jumbo|regular|tall|grande|venti)$/;

// "200g" and "12oz" are amounts; "7up" is a name.
const measured = (word: string) => /^\d/.test(word) && unitWords.test(word.replace(/^\d+/, ""));

/** Whether a number is written as part of a name: "2% milk", "93/7 beef", "7-up" and "v-8". */
function named(word: string, before: string, after: string) {
  if (/^(?:[.,]\d+)?\s*%/.test(after) || (/\d[.,]$/.test(before) && /^\s*%/.test(after)))
    return true;
  if (/^-\p{L}/u.test(after) || /\p{L}-$/u.test(before)) return true;
  // A lean-to-fat ratio, not a fraction like 1/2.
  const next = after.match(/^\s*\/\s*(\d+)/);
  const previous = before.match(/(\d+)\s*\/\s*$/);
  return (
    (!!next && Number(word) >= Number(next[1])) ||
    (!!previous && Number(previous[1]) >= Number(word))
  );
}

type Role = "name" | "amount" | "stop";

/**
 * What a typed search asks for. `words` must all match: amounts go ("2 eggs", "200 g", "1/2 cup",
 * "cup of coffee", "large egg"), while numbers written into a name ("2% milk") and count words
 * that name the food ("cup noodles") stay. A bare number before a food may still be part of its
 * name ("12 grain bread"), so `counts` keeps it with the word it leads, as an optional phrase.
 * Typed alone, small words stay: "or" and "to" are the start of orange and toast.
 */
export function readQuery(query: string): { words: string[]; counts: [string, string][] } {
  const text = plain(query);
  const found = [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((match) => ({
    word: match[0],
    before: text.slice(0, match.index),
    after: text.slice(match.index + match[0].length),
  }));
  const roles: Role[] = [];
  for (const [i, { word, before, after }] of found.entries()) {
    // Counted ("2 cups rice"), measured ("cup of coffee") or sized ("large egg"), it's an amount.
    const much =
      roles[i - 1] === "amount" ||
      found[i + 1]?.word === "of" ||
      (sizeWords.test(word) && found.slice(i + 1).some((next) => !stop.has(next.word)));
    if (number(word)) roles.push(named(word, before, after) ? "name" : "amount");
    else if (measured(word)) roles.push("amount");
    else if (stop.has(word)) roles.push("stop");
    else roles.push(much && (countWords.test(word) || unitWords.test(word)) ? "amount" : "name");
  }
  const pick = (role: Role) =>
    found
      .filter((token, i) => roles[i] === role && !/^\d/.test(token.word))
      .map((token) => token.word);
  const names = found.filter((_, i) => roles[i] === "name").map((token) => token.word);
  if (!names.length) {
    // Only amounts and small words: "cups" or "or" is still a search, a number alone isn't.
    const measures = pick("amount");
    return { words: (measures.length ? measures : pick("stop")).slice(0, 8), counts: [] };
  }
  const counts = found.flatMap(({ word }, i): [string, string][] =>
    roles[i] === "amount" && number(word) && roles[i + 1] === "name" && !number(found[i + 1].word)
      ? [[word, found[i + 1].word]]
      : []
  );
  return { words: names.slice(0, 8), counts };
}

export function queryWords(query: string): string[] {
  return readQuery(query).words;
}

// Plurals of words ending in "ie": "cookies" are not "cook"*.
const iePlural = /(?:cook|brown|smooth|vegg|hoag|pierog|good|calor)ies$/;

/** A prefix that matches singular and plural forms in the catalog's prefix search. */
export function stem(word: string): string {
  if (word.length <= 3) return word;
  if (iePlural.test(word)) return word.slice(0, -1);
  if (word.endsWith("ies")) return word.length > 5 ? word.slice(0, -3) : word;
  if (/(?:ches|shes|xes|oes|sses)$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("y") && word.length > 4) return word.slice(0, -1);
  // "Turkeys" and "Wendy's" end like "turkey" and "Wendy" do.
  if (word.endsWith("ys") && word.length > 5) return word.slice(0, -2);
  if (/(?:ss|us|is)$/.test(word)) return word;
  if (word.endsWith("s")) return word.slice(0, -1);
  return word;
}

/** Typos a word may have and still be recognized: none under four letters, one to six, then two. */
export const allowedTypos = (word: string) => (word.length < 4 ? 0 : word.length < 7 ? 1 : 2);

/**
 * Edits between two words, counting a swapped pair of letters as one ("protien"), or `limit + 1`
 * once they are further apart than `limit`.
 */
export function typos(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let before: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        value = Math.min(value, before[j - 2] + 1);
      current.push(value);
      best = Math.min(best, value);
    }
    if (best > limit) return limit + 1;
    before = previous;
    previous = current;
  }
  return Math.min(previous[b.length], limit + 1);
}

/**
 * How a typed word, which may still be half typed, reads a catalog word: the start of it that is
 * fewest edits away ("chikc" is one from "chick" in chicken), or null past the word's allowance.
 */
export function misread(typed: string, word: string): { edits: number; meant: string } | null {
  const limit = allowedTypos(typed);
  if (!limit || word.length < typed.length - limit) return null;
  let found: { edits: number; meant: string } | null = null;
  const lengths = new Set([word.length, typed.length - 1, typed.length, typed.length + 1]);
  // The whole word first, so "brocoli" means broccoli rather than its start "brocco".
  for (const length of [...lengths].filter((n) => n >= 3 && n <= word.length)) {
    const meant = word.slice(0, length);
    const edits = typos(typed, meant, limit);
    if (edits <= limit && (!found || edits < found.edits)) found = { edits, meant };
  }
  return found;
}

export const forms = (word: string) => alternatives[word] ?? [stem(word)];
const either = (options: string[]) =>
  options.length === 1 ? options[0] : `(${options.join(" OR ")})`;
export function term(word: string) {
  return either(forms(word).map((form) => `"${form}"*`));
}

// A typed word is searched as typed, plus the catalog's own wording for the same food. Looser
// alternatives the model needs ("fries" as fried, "pop" as carbonated) would take over a search.
const typedAlternatives = new Set("bun buns ketchup soda oatmeal".split(" "));
export const searchForms = (word: string) => [
  ...new Set([stem(word), ...(typedAlternatives.has(word) ? forms(word) : [])]),
];
/**
 * A typed word in the catalog's full-text syntax; a number matches only itself. Its fixes are
 * searched too, as prefixes or, for a word typed without its space, as a phrase.
 */
export function searchTerm(word: string, fixes: Fixes = {}) {
  // A search waits for a last word's second letter, so a letter on its own is whole: "k cup".
  if (number(word) || word.length === 1) return `"${word}"`;
  return either([...new Set([...searchForms(word), ...(fixes[word] ?? [])])].map((f) => `"${f}"*`));
}

/** The catalog's full-text expression for a search: each word as a stemmed prefix. */
export function searchExpression(query: string): string {
  return queryWords(query)
    .map((word) => searchTerm(word))
    .join(" AND ");
}

/** Restaurant and packaged foods, which suit a seen food only when its brand is known. */
export function isBranded(food: Pick<Food, "name" | "brand" | "source">) {
  if (food.source === "off" || food.brand) return true;
  // USDA prefixes restaurant items in capitals: "McDONALD'S, french fries", "T.G.I. FRIDAY'S, …".
  const first = food.name.split(/[\s,]/)[0].replace(/^Mc/, "");
  return first === first.toUpperCase() && (first.match(/[A-Z]/g)?.length ?? 0) >= 2;
}

/** The brand's words, including a restaurant USDA writes first: "McDONALD'S, BIG MAC". */
function brandWords(food: Food) {
  if (food.brand) return words(food.brand);
  const first = food.name.split(",")[0];
  const plain = first.replace(/\bMc/g, "");
  return plain === plain.toUpperCase() && (plain.match(/[A-Z]/g)?.length ?? 0) >= 2
    ? words(first)
    : [];
}

// Catalog words that describe how an ordinary food is prepared or measured, not a different food.
const neutral = new Set(
  (
    "raw cooked ripe fresh plain regular whole prepared commercial average year round all type " +
    "varieties includes baked broiled roasted grilled boiled steamed pan fried microwaved heated " +
    "cured sliced chopped diced shredded mature seeds without salt added drained solids liquid " +
    "enriched unenriched white red yellow green brewed tap water ready serve made broilers fluid " +
    "fryers meat only flesh separable fish beverages alcoholic nuts crustaceans mollusks spices"
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
    "parboiled precooked turkey stewed babyfood product brain evaporated condensed"
  )
    .split(" ")
    .map(stem)
);

// How the catalog words the fat level a search names with a number: "2%" is reduced fat.
const fatWords = new Set("fat milkfat lowfat low reduced nonfat lean".split(" ").map(stem));

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
  egg: { mark: ["whole"], others: ["white", "yolk"] },
};

// Searches for these mean the cooked food unless they say "raw": "salmon", "rice", "chicken".
const eatenCooked = new Set(
  (
    "rice pasta noodle spaghetti macaroni quinoa lentil oatmeal chicken beef pork turkey lamb " +
    "steak bacon sausage salmon fish tuna cod tilapia shrimp egg potato"
  )
    .split(" ")
    .map(stem)
);
const cookedWords = new Set(
  "cooked roasted baked boiled broiled grilled steamed poached scrambled fried braised"
    .split(" ")
    .map(stem)
);

// USDA files some foods under a group: "Fish, salmon", "Beverages, coffee", "Nuts, almonds".
const group = /^(?:fish|beverages?|alcoholic beverages?|nuts|crustaceans|mollusks|spices)$/i;

/** Both sides are stemmed, so a match may only differ by a plural-length ending; a letter can't. */
export const same = (word: string, form: string) =>
  word === form || (form.length > 1 && word.startsWith(form) && word.length - form.length <= 2);

/**
 * How well a food's name covers the words that were said. In a search the words may be half
 * typed, so a longer word also counts ("chic" finds chicken), below the word itself.
 */
export function coverage(
  seen: Named,
  food: Named,
  target = nameWords(seen),
  prefix = false,
  fixes: Fixes = {}
) {
  // "Dry heat" is how USDA says cooked.
  const name = food.name.replace(/\b(?:dry|moist) heat\b/gi, "cooked");
  const found = words(`${name} ${food.brand}`).map(stem);
  // Notes in brackets can match but barely make it a different food: "(Alaska Native)".
  const said = words(`${name.replace(/\([^)]*\)/g, " ")} ${food.brand}`).map(stem);
  const noted = words(
    [...name.matchAll(/\(([^)]*)\)/g)]
      .map((note) => note[1])
      .filter((note) => !/^includes\b/i.test(note))
      .join(" ")
  ).map(stem);
  // A number matches only itself: 2% milk is not 25%.
  const fits = (w: string, form: string) =>
    number(form) ? w === form : same(w, form) || (prefix && form.length > 1 && w.startsWith(form));
  // A typed word is whole only as typed: "chic" is as far from chicory as from chicken.
  const exact = (w: string, form: string) => (prefix || number(form) ? w === form : same(w, form));
  const options = prefix ? searchForms : forms;
  const whole = (word: string) => options(word).some((form) => found.some((w) => exact(w, form)));
  const literal = (word: string) =>
    whole(word) || (prefix && options(word).some((form) => found.some((w) => fits(w, form))));
  // A fix is a word's start ("chick") or, for a word typed without its space, a phrase.
  const fixed = (word: string) =>
    (fixes[word] ?? []).some((fix) => {
      const parts = fix.split(" ");
      return parts.every((part, i) =>
        found.some((w) => (i === parts.length - 1 ? w.startsWith(part) : same(w, part)))
      );
    });
  const has = (word: string) => literal(word) || fixed(word);
  // The last word names the food ("coffee" in "black coffee"); earlier words describe it.
  const weight = (i: number) => (i === target.length - 1 ? 2 : 1);
  const total = target.reduce((sum, _, i) => sum + weight(i), 0);
  const hits = target.reduce((sum, word, i) => sum + (has(word) ? weight(i) : 0), 0);
  const mentioned = [
    ...new Set(
      target.flatMap((word) => [
        ...options(word),
        ...(fixes[word] ?? []).flatMap((fix) => fix.split(" ")),
      ])
    ),
  ];
  const level = target.some(number);
  const extra = said.filter(
    (w) => !number(w) && !(level && fatWords.has(w)) && !mentioned.some((form) => fits(w, form))
  );
  const brand = words(seen.brand);
  const [first, second] = name.split(",");
  const lead = words(group.test(first.trim()) && second ? second : first)
    .filter((w) => !number(w))
    .map(stem);
  // A corrected word asks for the same everyday variety as the word it corrects.
  const asked = [...words(seen.name), ...Object.values(fixes).flat()];
  const usualFor = asked.map((word) => usual[stem(word)]).find(Boolean);
  return {
    name: total ? hits / total : 0,
    partial: target.filter((word) => !whole(word) && literal(word)).length,
    // Words found only as corrected: "chiken" in "Chicken breast".
    fixed: target.filter((word) => !literal(word) && fixed(word)).length,
    usual:
      !!usualFor &&
      !asked.some((word) => usualFor.others.includes(word)) &&
      found.some((w) => usualFor.mark.some((mark) => same(w, stem(mark)))) &&
      !found.some((w) => usualFor.others.some((other) => same(w, stem(other)))),
    typical: found.some((w) => typical.has(w)),
    variations: extra.filter((w) => variations.has(w)).length,
    others: extra.filter((w) => !neutral.has(w) && !variations.has(w)).length,
    notes: noted.filter((w) => !neutral.has(w) && !mentioned.some((form) => fits(w, form))).length,
    // USDA leads with the food itself: "Tomatoes, red, ripe, raw", not "Canadian bacon".
    leads: lead.length > 0 && lead.every((w) => mentioned.some((form) => fits(w, form))),
    brand: brand.length ? brand.every(has) : null,
    cooked: found.some((w) => cookedWords.has(w)) ? 1 : found.includes("raw") ? -1 : 0,
    // Frying adds fat; roasted or boiled is the plainer cooked form.
    fried: found.includes("fried") && !mentioned.includes("fried"),
  };
}

/** A brand the search names in full: "co" is not Coca-Cola, and "pizza" is not Pizzah. */
const mentions = (word: string, found: string) =>
  searchForms(word).some((form) => form.length > 2 && form === found);

/** Whether a name has a number the search put before a food: "12 grain" in "12 Grain Bread". */
function counted(food: Named, [count, next]: [string, string]) {
  const list = tokens(`${food.name} ${food.brand}`);
  return list.some((w, i) => w === count && stem(list[i + 1] ?? "").startsWith(stem(next)));
}

/** The person's own foods rank higher, and more so the more often they eat them. */
function boost(known: Known, id: string) {
  if (!known.has(id)) return 0;
  const count = known instanceof Map ? (known.get(id) ?? 0) : 0;
  return 1.5 + 0.5 * Math.log1p(Math.max(0, count));
}

/**
 * Orders candidates: name match, common form, brand agreement, the person's own foods. A search
 * has no brand of its own; a food whose brand it names ("oreo", "mcdonalds big mac") is not
 * marked down as branded.
 */
export function scoreFoods(
  seen: Named,
  foods: Food[],
  known: Known = new Set(),
  search = false,
  { fixes = {}, popularity, away }: SearchHints = {}
) {
  const read = search ? readQuery(seen.name) : null;
  const target = read ? read.words : nameWords(seen);
  const cooked =
    search &&
    !target.includes("raw") &&
    [...target, ...Object.values(fixes).flat()].some((word) => eatenCooked.has(stem(word)));
  // Catalogs repeat products; the person's own foods are each kept.
  const unique = new Map<string, Food>();
  for (const food of foods) {
    const listed = food.source === "usda" || food.source === "off";
    const key = listed ? `${food.name}|${food.brand}`.toLowerCase() : food.id;
    if (!unique.has(key) || known.has(food.id)) unique.set(key, food);
  }
  return [...unique.values()]
    .map((food, index) => {
      const match = coverage(seen, food, target, search, fixes);
      let score =
        3 * match.name +
        (match.leads ? (search ? 0.75 : 0.5) : 0) +
        (cooked ? 0.4 * match.cooked - (match.fried ? 0.2 : 0) : 0) +
        (match.usual ? 0.6 : 0) +
        (match.typical ? 0.3 : 0) -
        0.5 * match.partial -
        0.4 * match.fixed -
        0.8 * match.variations -
        0.25 * match.others -
        0.05 * match.notes;
      if (match.brand !== null) score += match.brand ? 2 : -1;
      else if (isBranded(food)) score -= 2;
      if (read) {
        const brand = brandWords(food);
        if (brand.length && brand.every((w) => target.some((word) => mentions(word, stem(w)))))
          score += 2;
        score += 2 * read.counts.filter((count) => counted(food, count)).length;
      }
      score += boost(known, food.id);
      // Among packaged foods, the ones people scan most: Coca-Cola before a store's cola.
      score += 0.12 * (popularity?.get(food.id) ?? 0);
      // Another country's product, as much as four words the search didn't ask for: it still
      // answers a search nothing sold here matches as well ("Domino's" in France or the US).
      if (away?.has(food.id)) score -= 1;
      return { food, score, index, name: match.name };
    })
    .filter((row) => row.name > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);
}

export function rankFoods(seen: Named, foods: Food[], known: Known = new Set()) {
  return scoreFoods(seen, foods, known).map((row) => row.food);
}

/** Orders foods for a typed search; foods that don't match it are left out. */
export function rankSearch(
  query: string,
  foods: Food[],
  known: Known = new Set(),
  hints: SearchHints = {}
) {
  return scoreFoods({ name: query, brand: "" }, foods, known, true, hints).map((row) => row.food);
}

/** Whether a food or saved meal answers a typed search, for the person's own lists. */
export function matchesQuery(query: string, food: Named, fixes: Fixes = {}) {
  const target = queryWords(query);
  // A number in the search is the variety asked for: "2% milk" is not whole milk.
  const found = tokens(`${food.name} ${food.brand}`);
  return (
    target.length > 0 &&
    target.filter(number).every((word) => found.includes(word)) &&
    coverage({ name: query, brand: "" }, food, target, true, fixes).name >= 0.5
  );
}
