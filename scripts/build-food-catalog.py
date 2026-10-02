#!/usr/bin/env python3
"""Build source-separated, indexed offline catalogs. Python standard library only.

Usage: python3 scripts/build-food-catalog.py [--usda /path/usda.zip] --off /path/off.jsonl[.gz]
The older CSV export (--off /path/off.csv[.gz]) is still read, but it leaves out the nutrition of
every product kept in Open Food Facts' newer format. Sources and hashes are recorded in assets/food/manifest.json. Never processes user data.
"""
import argparse
import collections
import csv
import functools
import gzip
import hashlib
import html
import json
import math
import multiprocessing
import re
from pathlib import Path
import sqlite3
import zipfile

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_VERSION = 3
USDA_URL = "https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_json_2018-04.zip"
OFF_URL = "https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz"
OFF_SAMPLE_URL = "https://world.openfoodfacts.org/data/exports/products.random-modulo-1000.jsonl.gz"
OFF_CSV_URL = "https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz"
# Where shoppers read English, a product is named in English when Open Food Facts has that name;
# elsewhere it keeps the name printed in the package's own language.
ENGLISH_MARKETS = {"en:united-states", "en:united-kingdom", "en:canada", "en:australia",
                   "en:new-zealand", "en:ireland"}
# Open Food Facts' country tags as the ISO 3166 codes a phone names its region by, for every
# country with more than a few dozen catalog foods; "world" is sold everywhere. A search ranks
# packaged foods sold in the phone's region above the same products sold only elsewhere.
COUNTRIES = dict(pair.split(":") for pair in """
    france:fr united-states:us spain:es germany:de italy:it united-kingdom:gb scotland:gb
    canada:ca switzerland:ch belgium:be australia:au ireland:ie netherlands:nl japan:jp brazil:br
    sweden:se poland:pl finland:fi norway:no denmark:dk austria:at portugal:pt czech-republic:cz
    new-zealand:nz romania:ro mexico:mx bulgaria:bg russia:ru luxembourg:lu morocco:ma hungary:hu
    india:in greece:gr thailand:th israel:il lithuania:lt argentina:ar singapore:sg south-africa:za
    estonia:ee croatia:hr turkey:tr turkiye:tr türkiye:tr slovakia:sk saudi-arabia:sa colombia:co
    ukraine:ua united-arab-emirates:ae chile:cl philippines:ph latvia:lv hong-kong:hk slovenia:si
    serbia:rs reunion:re algeria:dz iceland:is taiwan:tw bolivia:bo south-korea:kr puerto-rico:pr
    malaysia:my tunisia:tn egypt:eg costa-rica:cr kuwait:kw cyprus:cy qatar:qa indonesia:id peru:pe
    lebanon:lb new-caledonia:nc ecuador:ec uruguay:uy french-polynesia:pf malta:mt guadeloupe:gp
    panama:pa georgia:ge dominican-republic:do bosnia-and-herzegovina:ba cuba:cu north-macedonia:mk
    republic-of-macedonia:mk vietnam:vn paraguay:py china:cn belarus:by iraq:iq venezuela:ve
    martinique:mq el-salvador:sv mauritius:mu moldova:md andorra:ad guatemala:gt albania:al
    jordan:jo pakistan:pk bahrain:bh montenegro:me senegal:sn honduras:hn kazakhstan:kz
    faroe-islands:fo kenya:ke cote-d-ivoire:ci jamaica:jm trinidad-and-tobago:tt armenia:am oman:om
    cambodia:kh libya:ly french-guiana:gf nicaragua:ni monaco:mc madagascar:mg gibraltar:gi guam:gu
    nigeria:ng jersey:je iran:ir bangladesh:bd sri-lanka:lk cameroon:cm barbados:bb uzbekistan:uz
    virgin-islands-of-the-united-states:vi palestinian-territories:ps ethiopia:et brunei:bn
    ghana:gh macau:mo aland-islands:ax gabon:ga seychelles:sc azerbaijan:az myanmar:mm
    afghanistan:af mongolia:mn guernsey:gg saint-pierre-and-miquelon:pm suriname:sr maldives:mv
    isle-of-man:im democratic-republic-of-the-congo:cd nepal:np the-bahamas:bs kosovo:xk
    liechtenstein:li syria:sy kyrgyzstan:kg haiti:ht san-marino:sm burkina-faso:bf zambia:zm
    aruba:aw bermuda:bm greenland:gl curacao:cw benin:bj mozambique:mz mali:ml guinea:gn togo:tg
    guyana:gy namibia:na saint-lucia:lc fiji:fj republic-of-the-congo:cg mauritania:mr tanzania:tz
    cayman-islands:ky mayotte:yt zimbabwe:zw djibouti:dj rwanda:rw niger:ne botswana:bw somalia:so
    belize:bz sierra-leone:sl angola:ao yemen:ye cape-verde:cv sint-maarten:sx laos:la world:world
""".split())
LICENSES = {
    "usda": ("CC0-1.0", "USDA FoodData Central, SR Legacy (April 2018). Public domain (CC0 1.0)."),
    "off": ("ODbL-1.0",
            "Contains information from Open Food Facts (https://world.openfoodfacts.org), which is "
            "made available here under the Open Database License (ODbL) 1.0 "
            "(https://opendatacommons.org/licenses/odbl/1-0/). Individual contents are available "
            "under the Database Contents License (https://opendatacommons.org/licenses/dbcl/1-0/). "
            "This derived database and the recipe that builds it are published at "
            "https://github.com/swsvindland/macro-track/tree/main/assets/food."),
}

# The same keys and units as src/lib/nutrients.ts. USDA reports each in that unit; Open Food
# Facts reports grams per 100 g or ml, so its values are multiplied by the factor.
MICROS = [
    # key, USDA nutrient ids (summed; the first must be present), OFF columns (first present), factor
    ("sugar", [2000], ["sugars"], 1),
    ("addedSugar", [], ["added-sugars"], 1),
    ("saturatedFat", [1258], ["saturated-fat"], 1),
    ("transFat", [1257], ["trans-fat"], 1),
    ("monounsaturatedFat", [1292], ["monounsaturated-fat"], 1),
    ("polyunsaturatedFat", [1293], ["polyunsaturated-fat"], 1),
    # ALA (or undifferentiated 18:3), EPA, DPA and DHA; linoleic and arachidonic acid.
    ("omega3", [(1404, 1270), 1278, 1280, 1272], ["omega-3-fat"], 1),
    ("omega6", [(1316, 1269), 1271], ["omega-6-fat"], 1),
    ("cholesterol", [1253], ["cholesterol"], 1e3),
    ("potassium", [1092], ["potassium"], 1e3),
    ("calcium", [1087], ["calcium"], 1e3),
    ("iron", [1089], ["iron"], 1e3),
    ("magnesium", [1090], ["magnesium"], 1e3),
    ("phosphorus", [1091], ["phosphorus"], 1e3),
    ("zinc", [1095], ["zinc"], 1e3),
    ("copper", [1098], ["copper"], 1e3),
    ("manganese", [1101], ["manganese"], 1e3),
    ("selenium", [1103], ["selenium"], 1e6),
    ("vitaminA", [1106], ["vitamin-a"], 1e6),
    ("vitaminC", [1162], ["vitamin-c"], 1e3),
    ("vitaminD", [1114], ["vitamin-d"], 1e6),
    ("vitaminE", [1109], ["vitamin-e"], 1e3),
    ("vitaminK", [1185], ["vitamin-k", "phylloquinone"], 1e6),
    ("thiamin", [1165], ["vitamin-b1"], 1e3),
    ("riboflavin", [1166], ["vitamin-b2"], 1e3),
    ("niacin", [1167], ["vitamin-pp"], 1e3),
    ("pantothenicAcid", [1170], ["pantothenic-acid"], 1e3),
    ("vitaminB6", [1175], ["vitamin-b6"], 1e3),
    ("folate", [1190], ["vitamin-b9", "folates"], 1e6),
    ("vitaminB12", [1178], ["vitamin-b12"], 1e6),
    ("choline", [1180], ["choline"], 1e3),
    ("caffeine", [1057], ["caffeine"], 1e3),
]
FAT_PARTS = {"saturatedFat", "transFat", "monounsaturatedFat", "polyunsaturatedFat", "omega3", "omega6"}
# A US Nutrition Facts panel always lists these, so a zero was printed. Imported records fill the
# voluntary ones with zeros nobody measured (bread with no magnesium), so those zeros are unknown.
LABELED = {"sugar", "addedSugar", "saturatedFat", "transFat", "cholesterol", "potassium", "calcium",
           "iron", "vitaminD"}
FL_OZ_ML = 29.5735
OZ_G = 28.3495


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


LB_G = 453.592
# unit: basis, grams or ml in one, and whether the label prints the basis' own metric amount.
UNITS = {"ml": ("ml", 1, True), "cl": ("ml", 10, True), "l": ("ml", 1000, True),
         "floz": ("ml", FL_OZ_ML, False), "g": ("g", 1, True), "gram": ("g", 1, True),
         "grams": ("g", 1, True), "kg": ("g", 1000, True), "oz": ("g", OZ_G, False),
         "lb": ("g", LB_G, False), "lbs": ("g", LB_G, False)}
SERVING_UNITS = r"ml|fl\.?\s*oz|oz|grams?|g"
# A package's net quantity is also printed in litres, centilitres, kilos and pounds ("1.89L").
PACKAGE_UNITS = r"ml|cl|l|fl\.?\s*oz|oz|kg|lbs?|grams?|g"


def label_amounts(label, units=SERVING_UNITS):
    """Each amount in a label as (basis, grams or ml, printed in that metric unit)."""
    found = []
    for amount, unit in re.findall(rf"(\d+(?:[.,]\d+)?)\s*({units})\b", label, re.I):
        basis, factor, exact = UNITS[re.sub(r"[.\s]", "", unit.lower())]
        found.append((basis, float(amount.replace(",", ".")) * factor, exact))
    return found


def amount_in(found, basis):
    """The amount a label prints for `basis`: "8 fl oz (240 ml)" is 240 ml, not 236.6."""
    values = [(value, exact) for unit, value, exact in found if unit == basis]
    metric = [value for value, exact in values if exact]
    return metric[-1] if metric else values[0][0] if values else None


def serving_basis(label):
    """The basis and grams or ml of a serving label, when every amount in it agrees on one."""
    found = label_amounts(label)
    if len({basis for basis, _, _ in found}) != 1:
        return None, None
    return found[0][0], amount_in(found, found[0][0])


def label_basis(raw):
    """
    The basis of a product's per-100 values and its serving's amount in it, and how they were read.
    Records from before 2025 don't state it reliably (and the CSV omits it), so only units printed
    on the product are read, never its category: the serving label's one unit; where that label prints
    both ("1/4 cup (60 ml) (80.1 g)"), the one whose amount is OFF's serving_quantity, which OFF
    computed its per-100 values from; else the unit the package is sold in ("1.89L" is per 100 ml).
    """
    label = raw.get("serving_size", "") or ""
    basis, amount = serving_basis(label)
    if basis:
        return basis, amount, "serving"
    found = label_amounts(label)
    served = number(raw.get("serving_quantity"))
    matched = {unit for unit, value, _ in found
               if served and abs(value - served) <= max(0.5, served * 0.01)}
    if len(matched) == 1:
        return matched.pop(), served, "servingQuantity"
    sold = {unit for unit, _, _ in label_amounts(raw.get("quantity", "") or "", PACKAGE_UNITS)}
    if len(sold) == 1:
        basis = sold.pop()
        return basis, amount_in(found, basis), "package"
    return None, None, None


def csv_records(path):
    opener = gzip.open if str(path).endswith(".gz") else open
    with opener(path, "rt", encoding="utf-8", newline="") as source:
        csv.field_size_limit(16 * 1024 * 1024)
        for raw in csv.DictReader(source, delimiter="\t"):
            if None in raw:
                yield {"_malformed": True}
                continue
            raw["countries_tags"] = raw.get("countries_tags", "").split(",")
            raw["nutriments"] = {k: v for k, v in raw.items() if k.endswith("_100g") and v}
            yield raw


def jsonl_parts(path, size=32 * 1024 * 1024):
    """
    The export in pieces of whole lines for the worker processes: byte ranges they read themselves
    from a plain file, or the lines, from a compressed one that can only be read in order.
    """
    if str(path).endswith(".gz"):
        with gzip.open(path, "rb") as source:
            while lines := source.readlines(size):
                yield lines
        return
    total = path.stat().st_size
    with path.open("rb") as source:
        start = 0
        while start < total:
            source.seek(min(start + size, total))
            source.readline()
            end = source.tell()
            yield (str(path), start, end)
            start = end


def jsonl_part(part, limits):
    """The foods in one piece of the export, in order, and what was left out."""
    if isinstance(part, tuple):
        name, start, end = part
        with open(name, "rb") as source:
            source.seek(start)
            lines = source.read(end - start).split(b"\n")
    else:
        lines = part
    stats = collections.Counter()
    foods = [food for line in lines if line.strip()
             if (food := off_food(json.loads(line), limits, stats))]
    return foods, stats


# A nutrient's amount in grams per 100, from the unit Open Food Facts gives it in.
GRAMS = {"g": 1, "mg": 1e-3, "µg": 1e-6, "mcg": 1e-6}


def serving_unit(quantity, unit, label):
    """
    Whether a serving's amount is grams or ml: the unit the label prints that amount in
    ("1 cup (55 g)" is 55 g where OFF read 55 ml), else OFF's own unit when the label prints none.
    """
    found = label_amounts(label)
    matched = {basis for basis, value, _ in found
               if quantity and abs(value - quantity) <= max(0.5, quantity * 0.01)}
    if matched:
        return matched.pop() if len(matched) == 1 else None
    return unit if unit in ("g", "ml") and {basis for basis, _, _ in found} <= {unit} else None


def label_nutrition(raw):
    """
    Values per 100 g or ml from the nutrition object of Open Food Facts' newer records, as the
    *_100g fields it replaced, and their basis. Only label values count: not ones estimated from
    the ingredients, nor ones for the product once prepared. OFF puts every value on one basis and
    may name the wrong one (a smoothie's per-100 ml label as per 100 g), so each value's basis is
    read from what it was entered as: per 100 g, per 100 ml, or per serving, in the serving's unit.
    """
    nutrition = raw.get("nutrition") or {}
    entered = nutrition.get("input_sets") or []
    label = raw.get("serving_size") or ""
    nutriments, bases = {}, {}
    for key, entry in ((nutrition.get("aggregated_set") or {}).get("nutrients") or {}).items():
        index = entry.get("source_index")
        given = entered[index] if isinstance(index, int) and 0 <= index < len(entered) else {}
        value = number(entry.get("value"))
        if (entry.get("source") == "estimate" or given.get("preparation") != "as_sold"
                or value is None):
            continue
        per = entry.get("source_per")
        basis = ("g" if per == "100g" else "ml" if per == "100ml"
                 else serving_unit(number(given.get("per_quantity")), given.get("per_unit"), label)
                 if per == "serving" else None)
        unit = entry.get("unit")
        if unit == "kcal" and key in ("energy", "energy-kcal"):
            key = "energy-kcal"
        elif unit == "kJ" and key in ("energy", "energy-kj"):
            key = "energy-kj"
        elif unit in GRAMS:
            value *= GRAMS[unit]
        else:
            continue
        nutriments[f"{key}_100g"] = value
        bases[key] = basis
    energy = "energy-kcal" if "energy-kcal" in bases else "energy-kj"
    core = {bases.get(key) for key in (energy, "proteins", "carbohydrates", "fat")}
    basis = core.pop() if len(core) == 1 else None
    if not basis:
        return None, nutriments
    # A value entered on another basis than the label's core can't join it.
    return basis, {f"{key}_100g": nutriments[f"{key}_100g"] for key, b in bases.items() if b == basis}


def product_name(raw):
    english = raw.get("product_name_en") or ""
    if english.strip() and ENGLISH_MARKETS.intersection(raw.get("countries_tags") or []):
        name = english
    else:
        name = raw.get("product_name") or english or next(
            (raw[key] for key in sorted(raw) if key.startswith("product_name_")
             and isinstance(raw[key], str) and raw[key].strip()), "")
    return " ".join(html.unescape(name).split())


def serving_portion(raw, basis):
    """The serving the label prints, in the basis: "8 fl oz (240 ml)" is 240 ml."""
    label = (raw.get("serving_size") or "").strip()
    found = label_amounts(label)
    amount = amount_in(found, basis)
    # OFF's own reading only for a label that prints no amount it could contradict ("1 bar").
    if amount is None and not found and raw.get("serving_quantity_unit") == basis:
        amount = number(raw.get("serving_quantity"))
    return [{"label": label or "1 serving", "amount": amount}] if amount else []


def number(value):
    try:
        parsed = float(value)
        return parsed if math.isfinite(parsed) and parsed >= 0 else None
    except (TypeError, ValueError):
        return None


def rounded(value):
    """Four significant figures: more than any label prints, and a third of the bytes."""
    return None if value is None else float(f"{value:.4g}")


def barcode(value):
    code = str(value or "").strip()
    if not code.isascii() or not code.isdigit() or len(code) not in (8, 12, 13, 14):
        return None
    total = sum(int(d) * (3 if i % 2 == 0 else 1) for i, d in enumerate(reversed(code[:-1])))
    return code.zfill(14) if (10 - total % 10) % 10 == int(code[-1]) else None


def valid_nutrients(n):
    return (n["calories"] is not None and n["calories"] <= 1000
            and all(n[k] is not None and n[k] <= 100 for k in ("protein", "carbs", "fat"))
            and sum(n[k] for k in ("protein", "carbs", "fat")) <= 105
            and (n["fiber"] is None or n["fiber"] <= 100)
            and (n["sodium"] is None or n["sodium"] <= 100000))


def checked_micros(nutrients, micros, limits, stats):
    """Drops values above what any food holds, and parts larger than their whole."""
    kept = {}
    for key, value in micros.items():
        whole = (nutrients["fat"] if key in FAT_PARTS
                 else nutrients["carbs"] if key == "sugar"
                 else micros.get("sugar", nutrients["carbs"]) if key == "addedSugar"
                 else None)
        if value > limits.get(key, math.inf) or (whole is not None and value > whole * 1.05 + 0.5):
            stats["excludedMicroValues"] += 1
            continue
        kept[key] = value
    return kept


def usda_foods(path, stats):
    with zipfile.ZipFile(path) as archive:
        with archive.open(next(n for n in archive.namelist() if n.endswith(".json"))) as src:
            records = json.load(src)["SRLegacyFoods"]
    for raw in records:
        stats["sourceRecords"] += 1
        values = {n["nutrient"]["id"]: number(n.get("amount")) for n in raw["foodNutrients"]}
        nutrients = dict(zip(("calories", "protein", "carbs", "fat", "fiber", "sodium"),
                             (values.get(i) for i in (1008, 1003, 1005, 1004, 1079, 1093))))
        if not valid_nutrients(nutrients):
            stats["excludedNutrition"] += 1
            continue
        micros = {}
        for key, ids, _, _ in MICROS:
            parts = [next((values[i] for i in (part if isinstance(part, tuple) else (part,))
                           if values.get(i) is not None), None) for part in ids]
            if parts and parts[0] is not None:
                micros[key] = sum(part or 0 for part in parts)
        portions = []
        for p in raw.get("foodPortions", []):
            grams = number(p.get("gramWeight"))
            amount = number(p.get("amount"))
            label = p.get("modifier") or p.get("portionDescription")
            if grams and amount and label:
                portions.append({"label": f"{amount:g} {label}", "amount": grams})
        yield {"id": f"usda:{raw['fdcId']}", "name": raw["description"], "brand": "",
               "barcode": None, "basis": "g", "nutrients": nutrients,
               "micros": checked_micros(nutrients, micros, {}, stats),
               "portions": portions[:12], "popularity": 0, "markets": ""}


def off_food(raw, limits, stats):
    """One Open Food Facts product as a catalog food, or None and the reason in `stats`."""
    stats["sourceRecords"] += 1
    if raw.get("_malformed"):
        stats["excludedMalformedRows"] += 1
        return None
    name = product_name(raw)
    code = barcode(raw.get("code"))
    if not name or not code:
        stats["excludedIdentity"] += 1
        return None
    source = None
    if "nutrition" in raw:
        basis, v = label_nutrition(raw)
    else:
        v = raw.get("nutriments") or {}
        # Older records' *_100g fields held per-100 ml values too, under a per that defaulted to
        # 100g (the CSV omits it), so only a per-100 ml one is taken as given. Otherwise the
        # basis is a unit printed on the product, and 100g only where none is. Never convert
        # volume into mass.
        per = raw.get("nutrition_data_per")
        basis, _, source = ("ml", None, None) if per == "100ml" else label_basis(raw)
        if not basis and per == "100g" and raw.get("serving_quantity_unit") != "ml":
            basis = "g"
    energy = number(v.get("energy-kcal_100g"))
    if energy is None:
        kj = number(v.get("energy-kj_100g"))
        if kj is None and v.get("energy_unit") == "kJ":
            kj = number(v.get("energy_100g"))
        energy = kj / 4.184 if kj is not None else None
    sodium = number(v.get("sodium_100g"))
    nutrients = {"calories": energy, "protein": number(v.get("proteins_100g")),
                 "carbs": number(v.get("carbohydrates_100g")), "fat": number(v.get("fat_100g")),
                 "fiber": number(v.get("fiber_100g")), "sodium": sodium * 1000 if sodium is not None else None}
    if not valid_nutrients(nutrients):
        stats["excludedNutrition"] += 1
        return None
    # A per-100 g label on a product served only in ml is a drink entered under the old default.
    served = ({unit for unit, _, _ in label_amounts(raw.get("serving_size") or "")}
              or {raw.get("serving_quantity_unit")})
    if not basis or basis == "g" and served == {"ml"}:
        stats["excludedAmbiguousBasis"] += 1
        return None
    # How many were read past the serving label's own unit (see label_basis).
    if source == "servingQuantity":
        stats["basisFromServingQuantity"] += 1
    elif source == "package":
        stats["basisFromPackage"] += 1
    micros = {}
    for key, _, columns, factor in MICROS:
        value = next((number(v.get(f"{c}_100g")) for c in columns
                      if v.get(f"{c}_100g") not in (None, "")), None)
        if value is not None and (value > 0 or key in LABELED):
            micros[key] = value * factor
    # "Coca-Cola, The Coca-Cola Company" is sold as Coca-Cola.
    brand = " ".join(html.unescape((raw.get("brands") or "").split(",")[0]).split())
    scans = number(raw.get("unique_scans_n")) or 0
    markets = {COUNTRIES.get(tag.split(":", 1)[-1].lower())
               for tag in raw.get("countries_tags") or []}
    return {"id": f"off:{raw['code']}", "name": name, "brand": brand, "barcode": code,
            "markets": " ".join(sorted(markets - {None})),
            "basis": basis, "nutrients": nutrients,
            "micros": checked_micros(nutrients, micros, limits, stats),
            "portions": serving_portion(raw, basis), "popularity": round(math.log1p(scans), 2)}


def off_foods(path, limits, stats):
    """Each product of an export, in its order; JSONL is read across every core."""
    if ".csv" in path.name:
        for raw in csv_records(path):
            if food := off_food(raw, limits, stats):
                yield food
        return
    read = functools.partial(jsonl_part, limits=limits)
    with multiprocessing.Pool() as pool:
        for foods, counts in pool.imap(read, jsonl_parts(path)):
            stats.update(counts)
            yield from foods


CORE = ("calories", "protein", "carbs", "fat", "fiber", "sodium")
# A row's values by position, the commonest first so that most rows end early. The order is
# stored in catalog_meta, so the app reads it from the catalog rather than assuming it.
ORDER = CORE + ("sugar", "saturatedFat", "cholesterol", "calcium", "iron", "transFat",
                "potassium", "addedSugar", "vitaminD", "vitaminC", "vitaminA")
ORDER += tuple(key for key, *_ in MICROS if key not in ORDER)


def compact(value):
    value = rounded(value)
    return int(value) if value is not None and value.is_integer() else value


def row_data(food):
    """
    What the app reads besides the columns, as compact as JSON allows, since it is most of a
    catalog's size: [basis, values per 100 g or ml in ORDER (null where unknown, trailing ones
    left off), portions as [label, amount] when there are any].
    """
    values = {**food["nutrients"], **food["micros"]}
    row = [compact(values.get(key)) for key in ORDER]
    while row[-1] is None:
        row.pop()
    data = [food["basis"], row]
    if food["portions"]:
        data.append([[p["label"], compact(p["amount"])] for p in food["portions"]])
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"))


def food_values(data, order):
    """A row's values by key, from either the compact data or the object earlier versions kept."""
    data = json.loads(data)
    return dict(zip(order, data[1])) if order else data["nutrients"]


def build(source, path, destination, limits=None):
    digest = sha256_file(path)
    recipe = sha256_file(Path(__file__))
    version = f"{source}-v{SCHEMA_VERSION}-{digest[:12]}-{recipe[:8]}"
    output = destination / f"{source}.db"
    temporary = destination / f"{source}.pending.db"
    temporary.unlink(missing_ok=True)
    connection = sqlite3.connect(temporary)
    # Every typed word is searched as a prefix, and across millions of foods "ch" or "chi" has
    # thousands of words to merge: the prefix indexes keep a keystroke near 10 ms on a laptop for
    # a sixth more size. Without column sizes, bm25 measures the few rows a search ranks itself.
    connection.executescript("""
        CREATE TABLE staged (id TEXT PRIMARY KEY, name TEXT NOT NULL, brand TEXT NOT NULL,
                             barcode TEXT, popularity REAL NOT NULL, markets TEXT NOT NULL,
                             data TEXT NOT NULL) WITHOUT ROWID;
        CREATE TABLE foods (id TEXT, name TEXT NOT NULL, brand TEXT NOT NULL, barcode INTEGER,
                            popularity REAL NOT NULL, markets TEXT NOT NULL, data TEXT NOT NULL);
        CREATE VIRTUAL TABLE food_search USING fts5(name, brand, content='foods', content_rowid='rowid',
                                                    tokenize='unicode61 remove_diacritics 2',
                                                    prefix='2 3', columnsize=0);
        CREATE TABLE catalog_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    """)
    stats = collections.Counter()
    peaks = collections.defaultdict(float)
    foods = usda_foods(path, stats) if source == "usda" else off_foods(path, limits, stats)
    with connection:
        for food in foods:
            result = connection.execute("INSERT OR IGNORE INTO staged VALUES (?, ?, ?, ?, ?, ?, ?)",
                                        (food["id"], food["name"], food["brand"], food["barcode"],
                                         food["popularity"], food["markets"], row_data(food)))
            if not result.rowcount:
                stats["duplicates"] += 1
                continue
            stats["included"] += 1
            stats["microValues"] += len(food["micros"])
            stats["withMicros"] += bool(food["micros"])
            for key, value in food["micros"].items():
                peaks[key] = max(peaks[key], value)
        # A search ranks the first matches in row order, so the most scanned foods come first.
        # The 14-digit barcode is kept as a number, and an id that is "off:" and the barcode's
        # 13-digit form, as nearly all are, is left out for the app to derive: together a sixth
        # of the catalog. The id has no index: the app never looks a food up by it.
        connection.executescript("""
            INSERT INTO foods (id, name, brand, barcode, popularity, markets, data)
                SELECT CASE WHEN id = 'off:' || substr(barcode, 2) THEN NULL ELSE id END,
                       name, brand, CAST(barcode AS INTEGER), popularity, markets, data FROM staged
                ORDER BY popularity DESC, id;
            DROP TABLE staged;
            CREATE INDEX foods_barcode ON foods(barcode);
        """)
        connection.execute("INSERT INTO food_search(food_search) VALUES ('rebuild')")
        connection.execute("INSERT INTO food_search(food_search) VALUES ('optimize')")
        # The words the catalog knows and how many foods use each, for correcting typos.
        connection.executescript("""
            CREATE VIRTUAL TABLE temp.vocabulary USING fts5vocab(main, food_search, row);
            CREATE TABLE terms (term TEXT PRIMARY KEY, foods INTEGER NOT NULL) WITHOUT ROWID;
            INSERT INTO terms SELECT term, doc FROM temp.vocabulary
                WHERE length(term) >= 3 AND term NOT GLOB '*[0-9]*';
            DROP TABLE temp.vocabulary;
            -- A misspelled word is checked against the words in many foods, not all of them.
            CREATE INDEX terms_foods ON terms(foods);
        """)
        license_id, notice = LICENSES[source]
        url = source_url(source, path)
        connection.executemany("INSERT INTO catalog_meta VALUES (?, ?)", [
            ("version", version), ("license", license_id), ("attribution", notice),
            ("source", url), ("nutrients", json.dumps(ORDER, separators=(",", ":")))])
        connection.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
    stats["terms"] = connection.execute("SELECT count(*) FROM terms").fetchone()[0]
    assert connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    connection.execute("VACUUM")
    connection.close()
    temporary.replace(output)
    manifest = {"version": version, "sourceUrl": url,
                "recipeSha256": recipe, "sourceSha256": digest,
                "sha256": sha256_file(output), "bytes": output.stat().st_size,
                "license": license_id, "developmentSample": url == OFF_SAMPLE_URL, **dict(stats)}
    return manifest, dict(peaks)


def source_url(source, path):
    if source == "usda":
        return USDA_URL
    return (OFF_SAMPLE_URL if "random-modulo" in path.name
            else OFF_CSV_URL if ".csv" in path.name else OFF_URL)


def catalog_peaks(path):
    """The richest food's amount of each micronutrient in a built catalog."""
    keys = {key for key, *_ in MICROS}
    peaks = collections.defaultdict(float)
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    order = connection.execute("SELECT value FROM catalog_meta WHERE key = 'nutrients'").fetchone()
    order = order and json.loads(order[0])
    for (data,) in connection.execute("SELECT data FROM foods"):
        for key, value in food_values(data, order).items():
            if key in keys and value is not None:
                peaks[key] = max(peaks[key], value)
    connection.close()
    return dict(peaks)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--usda", type=Path,
                        help="USDA SR Legacy JSON zip. Without it the bundled USDA catalog is kept, "
                             "since SR Legacy no longer changes, and only Open Food Facts is rebuilt.")
    parser.add_argument("--off", type=Path, required=True)
    args = parser.parse_args()
    destination = ROOT / "assets" / "food"
    destination.mkdir(parents=True, exist_ok=True)
    if args.usda:
        usda, peaks = build("usda", args.usda, destination)
    else:
        usda = json.loads((destination / "manifest.json").read_text())["usda"]
        kept = destination / "usda.db"
        if hashlib.sha256(kept.read_bytes()).hexdigest() != usda["sha256"]:
            raise SystemExit(f"{kept} doesn't match its manifest entry; rebuild it with --usda.")
        peaks = catalog_peaks(kept)
    # A packaged food holding over twice the richest USDA food's amount is a unit slip
    # (micrograms entered as grams), not food. Added sugar has no USDA value; its whole limits it.
    off, _ = build("off", args.off, destination, {key: peak * 2 for key, peak in peaks.items()})
    manifest = {"schemaVersion": SCHEMA_VERSION, "usda": usda, "off": off}
    (destination / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest, indent=2))
