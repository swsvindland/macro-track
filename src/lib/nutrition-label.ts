/**
 * Reads a US Nutrition Facts panel from on-device OCR. Text recognition returns boxes of text
 * in reading order; a nutrient's value is either in its own box ("Total Fat 8g") or in the
 * nearest box to its right ("Calories" … "230"). Everything read is confirmed by the person.
 */

/** One recognized text box, normalized to 0–1 with a top-left origin. */
export type TextBox = { text: string; x: number; y: number; width: number; height: number };

export type LabelValues = {
  calories: number | null;
  fat: number | null;
  carbs: number | null;
  protein: number | null;
  fiber: number | null;
  /** Milligrams. */
  sodium: number | null;
};

export type LabelReading = LabelValues & {
  /** Household measure as printed, e.g. "2/3 cup" or "1 Package". */
  servingLabel: string;
  /** The serving's weight or volume, when the label gives one that fits its own nutrients. */
  servingAmount: number | null;
  servingUnit: "g" | "ml" | null;
  /** Calories were missing and are estimated from fat, carbohydrate and protein. */
  estimatedCalories: boolean;
  /** Values that seem inconsistent and deserve a second look. */
  warnings: string[];
};

type Nutrient = keyof LabelValues;
type Field = { key: Nutrient; label: RegExp; unit: "kcal" | "g" | "mg" };

const fields: Field[] = [
  { key: "calories", label: /\bcalories\b|\bcal[oó]r[ií]as\b/i, unit: "kcal" },
  { key: "fat", label: /\btotal\s*fat\b|\bfat,?\s*total\b|\bgrasa\s*total\b|^fat\b/i, unit: "g" },
  {
    key: "carbs",
    label: /\btotal\s*carb(?:ohydrates?|s|\.)?|\bcarbohydrates?\b|\bcarbs?\b\.?/i,
    unit: "g",
  },
  { key: "protein", label: /\bprotein\b|\bprote[ií]nas?\b/i, unit: "g" },
  { key: "fiber", label: /\b(?:dietary\s*)?fib(?:er|re)\b/i, unit: "g" },
  { key: "sodium", label: /\bsodium\b/i, unit: "mg" },
];
// Lines that mention a nutrient without giving its amount for this food.
const noise =
  /per\s*gram|calorie\s*diet|calories\s*a\s*day|from\s*fat|fat\s*cal\b|daily\s*value|lowered|less\s*than\s*\d{2,}|%\s*dv/i;
const plausible: Record<Nutrient, number> = {
  calories: 2000,
  fat: 200,
  carbs: 300,
  protein: 200,
  fiber: 100,
  sodium: 10000,
};

/** OCR reads a label's 0 as O and 1 as l or I, and a trailing "g" as 9. */
function digits(text: string) {
  return text
    .replace(/(?<=\d|^|\s|<)[Oo](?=\s*(?:m?g|\d|\*|%|$))/g, "0")
    .replace(/(?<=\s|^|<)[lI|](?=\s*m?g\b)/g, "1")
    .replace(/(\d),(\d{3})\b/g, "$1$2");
}

type Amount = { value: number; unit: string; raw: string };
/** The first amount at the start of `text`, e.g. "8g", "<1 g", "160mg", "230". */
function leadingAmount(text: string): Amount | null {
  const match = /^\s*(<|less\s*than\s*)?(\d+(?:[.,]\d+)?)\s*(mg|g|kcal|mcg)?\b/i.exec(digits(text));
  if (!match) return null;
  let value = Number(match[2].replace(",", "."));
  // A "less than" amount is logged as half its bound: "<1g" is 0.5 g.
  if (match[1]) value /= 2;
  return { value, unit: (match[3] ?? "").toLowerCase(), raw: match[2] };
}

function convert(field: Field, amount: Amount, impliedUnit: boolean): number | null {
  let { value } = amount;
  const unit = amount.unit;
  if (field.unit === "kcal") return unit === "g" || unit === "mg" ? null : value;
  if (!unit) {
    if (impliedUnit) return value;
    // "Total Fat 09" is "0g" read as "09".
    if (/^\d+9$/.test(amount.raw)) value = Number(amount.raw.slice(0, -1));
    else return null;
  } else if (unit === "mcg") return null;
  if (field.unit === "mg") return unit === "g" ? value * 1000 : value;
  return unit === "mg" ? value / 1000 : value;
}

const center = (box: TextBox) => box.y + box.height / 2;

/** The box on the same printed row nearest to the right, where split labels keep their value. */
function rightOf(box: TextBox, boxes: TextBox[]) {
  const row = boxes.filter(
    (other) =>
      other !== box &&
      other.x > box.x + box.width * 0.5 &&
      Math.abs(center(other) - center(box)) < Math.max(box.height, other.height) * 0.6
  );
  return row.sort((a, b) => a.x - b.x)[0];
}

function readField(field: Field, boxes: TextBox[]): number | null {
  for (const box of boxes) {
    const text = box.text.replace(/\s+/g, " ");
    if (noise.test(text)) continue;
    const match = field.label.exec(text);
    if (!match) continue;
    // "PROTEIN, g" gives the unit once for a column of bare numbers.
    const implied = new RegExp(`^[\\s,.:]*\\(?${field.unit === "mg" ? "mg" : "g"}\\b`, "i").test(
      text.slice(match.index + match[0].length)
    );
    // The value follows the label within a short gap, which allows bilingual labels such as
    // "Total Fat / Grasa Total 0g" but not "SODIUM CONTENT … FROM 790mg".
    const after = /^[^\d<]{0,20}?(?=<|\d|[Oo]\s*m?g\b|less)/i.exec(
      text.slice(match.index + match[0].length)
    );
    if (after) {
      const rest = text.slice(match.index + match[0].length + after[0].length);
      const amount = leadingAmount(rest);
      const value = amount && convert(field, amount, implied);
      if (value !== null && value !== undefined && value <= plausible[field.key]) return value;
    }
    const next = rightOf(box, boxes);
    const amount = next && leadingAmount(next.text);
    const value =
      amount && convert(field, amount, implied || field.unit === "kcal" || !!amount.unit);
    if (value !== null && value !== undefined && value <= plausible[field.key]) return value;
  }
  return null;
}

function readServing(boxes: TextBox[], values: LabelValues) {
  // Tolerates cut-off and misread headings: "erving Size", "Serv. sie".
  const index = boxes.findIndex((box) =>
    /erv(?:ing)?\.?\s*s[i1l]z?e\b|tama[ñn]o\s*de\s*porci/i.test(box.text)
  );
  if (index < 0) return { servingLabel: "", servingAmount: null, servingUnit: null };
  const box = boxes[index];
  const own = box.text.replace(/.*?(?:s[i1l]z?e|porci[oó]n)\b\s*[:.]?/i, "").trim();
  // The measure can continue in the box to the right or on the next printed line.
  const below = boxes.find(
    (other) =>
      other !== box &&
      center(other) > center(box) + Math.min(box.height, other.height) * 0.3 &&
      other.y < box.y + box.height * 2.2 &&
      Math.abs(other.x - box.x) < 0.25
  );
  const parts = [own, rightOf(box, boxes)?.text ?? "", below?.text ?? ""].filter(
    (part) => !/per\s*cont|servings?\s*per/i.test(part)
  );
  const text = parts.join(" ");
  const plain = digits(text);
  const macros = (values.fat ?? 0) + (values.carbs ?? 0) + (values.protein ?? 0);
  // A serving can't weigh less than its own fat, carbohydrate and protein.
  const fits = (grams: number) => grams > 0 && grams <= 2000 && grams >= macros * 0.8;
  let servingAmount: number | null = null;
  let servingUnit: "g" | "ml" | null = null;
  for (const match of plain.matchAll(/(\d+(?:\.\d+)?)\s*(g|gm|grams?|ml)\b/gi)) {
    const amount = Number(match[1]);
    const unit = match[2].toLowerCase() === "ml" ? "ml" : "g";
    if (unit === "ml" || fits(amount)) {
      servingAmount = amount;
      servingUnit = unit;
      break;
    }
  }
  if (servingAmount === null) {
    const ounces = /(\d+(?:\.\d+)?)\s*(fl\.?\s*)?oz/i.exec(plain);
    if (ounces) {
      const amount = Number(ounces[1]) * (ounces[2] ? 29.57 : 28.35);
      if (ounces[2] || fits(amount)) {
        servingAmount = Number(amount.toFixed(1));
        servingUnit = ounces[2] ? "ml" : "g";
      }
    }
  }
  // The household measure, e.g. "2/3 cup" from "2/3 cup (55g)"; it always has a number.
  const servingLabel =
    parts
      .map((part) =>
        part
          .split("(")[0]
          .replace(/\d+(?:\.\d+)?\s*(?:g|gm|grams?|ml)\b.*$/i, "")
          .replace(/^[\s,;:/]+|[\s,;:/]+$/g, "")
      )
      .find((part) => /\d/.test(part))
      ?.slice(0, 40) ?? "";
  return { servingLabel, servingAmount, servingUnit };
}

/** Values found on a label photo; missing nutrients stay null rather than zero. */
export function readNutritionLabel(boxes: TextBox[]): LabelReading {
  const ordered = [...boxes].sort((a, b) => a.y - b.y || a.x - b.x);
  const values = Object.fromEntries(
    fields.map((field) => [field.key, readField(field, ordered)])
  ) as LabelValues;
  const warnings: string[] = [];
  const { fat, carbs, protein } = values;
  const energy =
    fat !== null && carbs !== null && protein !== null ? 9 * fat + 4 * carbs + 4 * protein : null;
  let estimatedCalories = false;
  if (values.calories === null && energy !== null) {
    values.calories = Math.round(energy);
    estimatedCalories = true;
  } else if (
    values.calories !== null &&
    energy !== null &&
    Math.abs(values.calories - energy) > Math.max(25, values.calories * 0.25)
  )
    warnings.push("Calories don't match the fat, carbs and protein. Check the numbers.");
  return {
    ...values,
    ...readServing(ordered, values),
    estimatedCalories,
    warnings,
  };
}

/** Enough was read to be worth filling a form: calories or at least two macros. */
export function labelFound(reading: LabelReading) {
  const macros = [reading.fat, reading.carbs, reading.protein].filter((n) => n !== null).length;
  return (reading.calories !== null && !reading.estimatedCalories) || macros >= 2;
}
