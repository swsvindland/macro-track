import type { Food } from "./nutrition";

/**
 * Emoji for foods, worked out on the phone from the name. Earlier rows win, so dishes come
 * before what they're made of: "chicken pizza" is a pizza and "egg noodles" are noodles. At each
 * word the longest listed phrase is read, so "crab cakes" never counts as cake and "root beer"
 * never as beer. Words match whole, as written or as a singular: "cherries" is "cherry".
 */
const icons: [string, string][] = [
  ["🍕", "pizza|calzone|stromboli"],
  ["🍔", "burger|hamburger|cheeseburger|whopper|big mac|slider"],
  ["🌭", "hot dog|corn dog|chili dog"],
  ["🥪", "sandwich|sub|hoagie|panini|blt|grilled cheese|mcmuffin|pb and j|pbj|reuben|melt"],
  ["🌮", "taco|tostada|fajita|nacho|nachos"],
  ["🌯", "burrito|burrito bowl|wrap|quesadilla|enchilada|chimichanga"],
  ["🫔", "tamale|tamal"],
  ["🥙", "gyro|kebab|kabob|shawarma|souvlaki|doner|pita sandwich|pita pocket"],
  ["🧆", "falafel"],
  ["🍣", "sushi|sashimi|nigiri|maki|california roll|poke|poke bowl"],
  ["🍙", "onigiri|rice ball"],
  [
    "🥟",
    "dumpling|gyoza|potsticker|wonton|pierogi|pierogy|egg roll|spring roll|dim sum|bao|empanada|samosa",
  ],
  ["🍜", "noodle|ramen|pho|udon|soba|lo mein|chow mein|pad thai|yakisoba|vermicelli"],
  [
    "🍝",
    "pasta|spaghetti|macaroni|mac and cheese|penne|lasagna|lasagne|linguine|fettuccine|fettuccini|ravioli|tortellini|rigatoni|gnocchi|orzo|alfredo|carbonara|bolognese|ziti|rotini|fusilli|farfalle|cavatappi|elbow|bucatini|angel hair|capellini|pappardelle|tagliatelle|manicotti|cannelloni",
  ],
  ["🍚", "fried rice|risotto|pilaf|rice bowl|biryani"],
  ["🍛", "curry|tikka masala|korma|vindaloo|dal|dhal|daal"],
  ["🥘", "paella|jambalaya|casserole|shakshuka|stir fry|stirfry"],
  ["🍟", "fries|french fries|french fried|tater tot|fish and chips|poutine|onion ring"],
  [
    "🍲",
    "soup|noodle soup|stew|chili|chilli|chowder|broth|bisque|goulash|minestrone|gumbo|hot pot|pot roast",
  ],
  ["🥗", "salad|coleslaw|slaw|caesar"],
  ["🍳", "omelet|omelette|frittata|scrambled|fried egg|eggs benedict|quiche"],
  ["🥞", "pancake|crepe|flapjack|hotcake"],
  ["🧇", "waffle"],
  ["🍱", "bento|lunchable"],
  [
    "🥤",
    "shake|milkshake|smoothie|protein shake|frappe|frappuccino|slushie|slurpee|whey|protein powder|casein|muscle milk|premier protein|soylent|huel",
  ],
  [
    "🍨",
    "ice cream|ice cream sandwich|ice cream bar|ice cream cone|waffle cone|gelato|frozen yogurt|froyo|sundae|sorbet|sherbet|popsicle|ice pop|soft serve|halo top|frozen novelty",
  ],
  ["🍩", "donut|doughnut|munchkin|cruller|beignet|honey bun"],
  [
    "🍪",
    "cookie|biscotti|oreo|macaron|shortbread|chips ahoy|snickerdoodle|fig newton|graham cracker|gingersnap|ginger snap",
  ],
  ["🧁", "cupcake|muffin"],
  ["🍰", "cake|cheesecake|cheese cake|tiramisu|shortcake|swiss roll"],
  ["🥧", "pie|tart|cobbler|crumble|pop tart|poptart"],
  [
    "🥐",
    "croissant|pastry|danish|cinnamon roll|cinnamon bun|strudel|turnover|scone|bear claw|kolache|churro",
  ],
  ["🥯", "bagel"],
  ["🍮", "pudding|custard|flan|creme brulee|panna cotta|jello|jell o|gelatin"],
  [
    "🥣",
    "cereal|oatmeal|oat|porridge|granola|muesli|grits|cheerios|chex|kix|wheaties|corn flakes|frosted flakes|bran flakes|raisin bran|special k|mini wheats|shredded wheat|grape nuts|rice krispies|cocoa puffs|lucky charms|froot loops|cinnamon toast crunch|cream of wheat|acai|acai bowl",
  ],
  [
    "🍫",
    "chocolate|brownie|cocoa|cacao|nutella|snickers|twix|kit kat|kitkat|reeses|hersheys|m and m|milky way|butterfinger|toblerone|fudge|candy bar|bar",
  ],
  [
    "🍬",
    "candy|gummy|gummi|skittles|starburst|jelly bean|licorice|marshmallow|lollipop|sweets|twizzlers|haribo|sour patch|jolly rancher|swedish fish|fruit snacks|fruit roll up|gum",
  ],
  ["🍿", "popcorn"],
  ["🥨", "pretzel"],
  ["🍘", "cracker|rice cake|rice cracker|saltine|triscuit|wheat thins|goldfish|cheez it|ritz"],
  ["🌽", "tortilla chip|corn chip|doritos|tostitos|fritos|cheetos|takis"],
  ["🥔", "chips|crisps|potato chip|pringles|lays|ruffles"],
  [
    "☕",
    "coffee|latte|espresso|cappuccino|americano|macchiato|mocha|cold brew|flat white|cortado|hot chocolate|hot cocoa|swiss miss|nescafe|starbucks",
  ],
  ["🧋", "bubble tea|boba|milk tea|thai tea"],
  ["🍵", "tea|matcha|chai|kombucha|yerba mate"],
  ["🧃", "juice|lemonade|limeade|fruit punch|apple cider|capri sun|kool aid|sunny d"],
  [
    "🥤",
    "soda|cola|coke|pepsi|sprite|fanta|dr pepper|mountain dew|root beer|ginger ale|cream soda|soft drink|energy drink|red bull|monster energy|gatorade|powerade|bodyarmor|celsius|electrolyte|sports drink|7up|seven up",
  ],
  [
    "🍺",
    "beer|ale|lager|ipa|stout|pilsner|porter|cider|hard seltzer|white claw|bud light|coors|heineken|guinness|modelo|michelob",
  ],
  [
    "🍷",
    "wine|sangria|champagne|prosecco|mimosa|merlot|cabernet|chardonnay|pinot|sauvignon|riesling",
  ],
  [
    "🍸",
    "cocktail|margarita|martini|mojito|daiquiri|cosmopolitan|pina colada|mai tai|old fashioned|spritz|mule",
  ],
  ["🥃", "whiskey|whisky|bourbon|scotch|vodka|rum|gin|tequila|brandy|cognac|liquor|liqueur|mezcal"],
  [
    "🥓",
    "bacon|ham|prosciutto|salami|pepperoni|pancetta|capicola|mortadella|pastrami|bologna|spam",
  ],
  ["🌭", "sausage|bratwurst|brat|frankfurter|wiener|kielbasa|chorizo|andouille"],
  ["🥚", "egg|egg substitute"],
  ["🍗", "chicken|turkey|poultry|wing|nugget|tenders|drumstick|duck|rotisserie"],
  [
    "🐟",
    "fish|salmon|tuna|cod|tilapia|trout|sardine|halibut|mackerel|anchovy|haddock|pollock|mahi|swordfish|catfish|bass|herring|snapper|sole|flounder|perch|lox|fish cake|fish stick",
  ],
  ["🍤", "shrimp|prawn|scampi"],
  ["🦀", "crab|crab cake|crawfish|crayfish|surimi"],
  ["🦞", "lobster"],
  ["🦪", "oyster|clam|mussel|scallop"],
  ["🦑", "squid|calamari|octopus"],
  [
    "🥩",
    "beef|steak|sirloin|ribeye|rib eye|brisket|jerky|veal|bison|venison|filet mignon|roast beef|prime rib|short rib|tri tip|flank|t bone|porterhouse|carne asada",
  ],
  ["🍖", "pork|lamb|rib|mutton|goat|meatball|meatloaf|meat|carnitas|bbq|barbecue|bar b q"],
  ["🍚", "rice|quinoa|couscous|congee"],
  ["🥖", "baguette|french bread|ciabatta|breadstick"],
  ["🫓", "tortilla|pita|naan|flatbread|lavash|roti|chapati|arepa|paratha"],
  [
    "🍞",
    "bread|toast|sourdough|bun|roll|brioche|rye|pumpernickel|cornbread|biscuit|english muffin|french toast|garlic bread|hamburger bun|burger bun|hot dog bun|stuffing|crouton|breadcrumb|bread crumb|panko|loaf|loaves",
  ],
  ["🌾", "flour|wheat|barley|bulgur|farro|millet|buckwheat|bran"],
  [
    "🥜",
    "peanut|peanut butter|nut|almond|almond butter|nut butter|cashew|walnut|pecan|pistachio|hazelnut|macadamia|trail mix|seed|chia|flax|flaxseed|sesame|tahini|pb2",
  ],
  ["🌰", "chestnut|water chestnut"],
  [
    "🧀",
    "cheese|cheddar|mozzarella|parmesan|parmigiano|feta|brie|gouda|ricotta|provolone|swiss|cottage cheese|cream cheese|string cheese|goat cheese|pepper jack|halloumi|colby|monterey jack|havarti|gruyere|manchego|camembert|mascarpone|queso|paneer|babybel",
  ],
  ["🥣", "yogurt|yoghurt|skyr|parfait|chobani|oikos|fage|siggis|yoplait|activia|dannon"],
  ["🧈", "butter|ghee|margarine|shortening|lard"],
  [
    "🥛",
    "milk|chocolate milk|almond milk|oat milk|soy milk|rice milk|coconut milk|cashew milk|buttermilk|kefir|lactaid|fairlife|cream|creamer|half and half|eggnog",
  ],
  ["🍎", "apple|applesauce|apple sauce|apple butter|fruit"],
  ["🍐", "pear"],
  ["🍊", "orange|clementine|mandarin|tangerine|grapefruit|satsuma"],
  ["🍋", "lemon|lime"],
  ["🍌", "banana|plantain"],
  ["🍉", "watermelon"],
  ["🍈", "melon|cantaloupe|honeydew"],
  ["🍇", "grape|raisin"],
  ["🍓", "strawberry"],
  ["🫐", "blueberry|raspberry|blackberry|berry|cranberry"],
  ["🍒", "cherry|tart cherry"],
  ["🍑", "peach|nectarine|apricot|plum|prune|fruit cocktail"],
  ["🍍", "pineapple"],
  ["🥭", "mango|papaya"],
  ["🥝", "kiwi"],
  ["🥥", "coconut"],
  ["🥑", "avocado|guacamole|guac"],
  ["🍅", "tomato|cherry tomato|ketchup|catsup|salsa|marinara|pico de gallo"],
  ["🥗", "lettuce|butter lettuce|romaine|greens|spring mix|arugula|iceberg|mesclun"],
  [
    "🥬",
    "spinach|kale|cabbage|bok choy|collard|chard|swiss chard|brussels sprout|brussel sprout|sauerkraut|kimchi|leek|celery|asparagus|basil|cilantro|parsley|okra|artichoke|rhubarb|seaweed|nori|kelp|wakame|sprout|vegetable|veggie",
  ],
  ["🥦", "broccoli|broccolini|cauliflower"],
  ["🥕", "carrot|beet|radish|turnip|parsnip|rutabaga|jicama"],
  ["🌽", "corn|polenta"],
  ["🍠", "sweet potato|yam"],
  ["🥔", "potato|hash brown|home fries|tater"],
  ["🥒", "cucumber|pickle|zucchini|courgette|gherkin"],
  [
    "🌶️",
    "chili pepper|chile pepper|chilli pepper|jalapeno|habanero|serrano|chipotle|hot sauce|sriracha|chili sauce|cayenne|tabasco",
  ],
  ["🫑", "pepper|bell pepper|capsicum"],
  ["🧅", "onion|shallot|scallion|green onion|chive"],
  ["🧄", "garlic"],
  ["🫚", "ginger"],
  ["🍄", "mushroom|portobello|shiitake"],
  ["🍆", "eggplant|aubergine"],
  ["🎃", "pumpkin|squash|butternut|spaghetti squash|acorn squash"],
  ["🫛", "pea|green pea|snow pea|snap pea|sugar snap|edamame|green bean|string bean|snap bean"],
  ["🫘", "bean|lentil|chickpea|garbanzo|hummus|split pea|tofu|tempeh|seitan|soy|soybean"],
  ["🫒", "olive|oil|olive oil|avocado oil|coconut oil|vegetable oil|canola"],
  [
    "🧂",
    "salt|salt and pepper|black pepper|spice|seasoning|taco seasoning|cinnamon|paprika|cumin|oregano|turmeric|nutmeg|chili powder|garlic powder|onion powder|curry powder|baking soda|baking powder|yeast",
  ],
  [
    "🥫",
    "sauce|soy sauce|bbq sauce|barbecue sauce|mustard|mayo|mayonnaise|dressing|ranch|gravy|vinegar|apple cider vinegar|red wine vinegar|wine vinegar|balsamic|pesto|aioli|relish|teriyaki|worcestershire|tamari",
  ],
  [
    "🍯",
    "honey|syrup|jam|jelly|preserves|marmalade|sugar|agave|molasses|corn syrup|stevia|sweetener|allulose|erythritol|monk fruit",
  ],
  ["🍼", "infant formula|baby formula|enfamil|similac"],
  ["🥤", "drink|protein"],
  ["🧊", "ice"],
  [
    "💧",
    "water|sparkling water|mineral water|coconut water|seltzer|club soda|tonic|la croix|lacroix",
  ],
  [
    "💊",
    "multivitamin|vitamin|supplement|creatine|fish oil|omega 3|probiotic|capsule|collagen|gummy vitamin",
  ],
];

const ranks = new Map<string, number>();
let longest = 1;
icons.forEach(([, phrases], rank) => {
  for (const phrase of phrases.split("|")) {
    if (!ranks.has(phrase)) ranks.set(phrase, rank);
    longest = Math.max(longest, phrase.split(" ").length);
  }
});

/** "Reese's Mac & Cheese" reads as "reeses mac and cheese"; accents fall away. */
const words = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['\u2019]/g, "")
    .replace(/&/g, " and ")
    .match(/[a-z0-9]+/g) ?? [];

/** A word as written, then as a singular: "cherries", "cherry"; "potatoes", "potato". */
function forms(word: string) {
  const list = [word];
  if (word.endsWith("ies")) list.push(`${word.slice(0, -3)}y`);
  if (word.endsWith("es")) list.push(word.slice(0, -2));
  if (word.endsWith("s")) list.push(word.slice(0, -1));
  return list;
}

/** The earliest row any phrase in `text` belongs to, or Infinity. */
function rankOf(text: string) {
  const list = words(text);
  let best = Infinity;
  for (let i = 0; i < list.length;) {
    let size = 1;
    phrase: for (let n = Math.min(longest, list.length - i); n > 0; n--) {
      const head = list.slice(i, i + n - 1).join(" ");
      for (const form of forms(list[i + n - 1])) {
        const rank = ranks.get(head ? `${head} ${form}` : form);
        if (rank === undefined) continue;
        best = Math.min(best, rank);
        size = n;
        break phrase;
      }
    }
    i += size;
  }
  return best;
}

/** Catalogs name the kind first ("Milk, chocolate", "Rolls, hamburger"), so that part leads. */
function iconFor(text: string): string | undefined {
  const comma = text.indexOf(",");
  const lead = comma > 0 ? rankOf(text.slice(0, comma)) : Infinity;
  return icons[lead < Infinity ? lead : rankOf(text)]?.[0];
}

/**
 * A food's emoji: ⚡ for a quick-add estimate, else what its name (or failing that, its brand)
 * names, else 🍲 for a recipe and 🍽️ for anything else.
 */
export function foodIcon(food: Pick<Food, "id" | "name" | "brand" | "source">): string {
  if (food.id.startsWith("quick:")) return "⚡";
  return (
    iconFor(food.name) ??
    (food.brand ? iconFor(food.brand) : undefined) ??
    (food.source === "recipe" ? "🍲" : "🍽️")
  );
}

/** A saved meal's emoji, from its name. */
export function mealIcon(name: string): string {
  return iconFor(name) ?? "🍽️";
}
