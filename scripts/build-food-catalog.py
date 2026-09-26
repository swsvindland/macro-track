#!/usr/bin/env python3
"""Build source-separated, indexed offline catalogs. Python standard library only.

Usage: python3 scripts/build-food-catalog.py --usda /path/usda.zip --off /path/off.csv[.gz]
Sources and hashes are recorded in assets/food/manifest.json. Never processes user data.
"""
import argparse
import collections
import csv
import gzip
import hashlib
import json
import math
import re
from pathlib import Path
import sqlite3
import zipfile

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_VERSION = 2
USDA_URL = "https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_json_2018-04.zip"
OFF_URL = "https://world.openfoodfacts.org/data/exports/products.random-modulo-1000.jsonl.gz"
OFF_CSV_URL = "https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz"
MARKETS = ("en:united-states",)
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


def serving_basis(label):
    """The basis and grams or ml of a serving label, when every amount in it agrees on one."""
    found = []
    for amount, unit in re.findall(r"(\d+(?:[.,]\d+)?)\s*(ml|fl\.?\s*oz|oz|grams?|g)\b", label, re.I):
        value = float(amount.replace(",", "."))
        unit = re.sub(r"[.\s]", "", unit.lower())
        if unit == "ml":
            found.append(("ml", value, True))
        elif unit == "floz":
            found.append(("ml", value * FL_OZ_ML, False))
        elif unit == "oz":
            found.append(("g", value * OZ_G, False))
        else:
            found.append(("g", value, True))
    if len({basis for basis, _, _ in found}) != 1:
        return None, None
    # "8 fl oz (240 ml)": the metric amount is the one printed for the metric basis.
    metric = [value for _, value, exact in found if exact]
    return found[0][0], (metric[-1] if metric else found[0][1])


def off_records(path):
    name = str(path)
    opener = gzip.open if name.endswith(".gz") else open
    with opener(path, "rt", encoding="utf-8", newline="") as source:
        if not (name.endswith(".csv.gz") or name.endswith(".csv")):
            for line in source:
                yield json.loads(line)
            return
        csv.field_size_limit(16 * 1024 * 1024)
        for raw in csv.DictReader(source, delimiter="\t"):
            if None in raw:
                yield {"_malformed": True}
                continue
            raw["countries_tags"] = raw.get("countries_tags", "").split(",")
            raw["nutriments"] = {k: v for k, v in raw.items() if k.endswith("_100g") and v}
            # The CSV omits nutrition_data_per and serving_quantity_unit. Only infer a basis
            # from the units printed in the serving label, never from a product category.
            basis, amount = serving_basis(raw.get("serving_size", ""))
            if basis:
                raw["nutrition_data_per"] = f"100{basis}"
                raw["serving_quantity_unit"] = basis
                raw["serving_quantity"] = amount
            yield raw


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
    stats["microValues"] += len(kept)
    stats["withMicros"] += bool(kept)
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
               "portions": portions[:12], "popularity": 0}


def off_foods(path, limits, stats):
    for raw in off_records(path):
        stats["sourceRecords"] += 1
        if raw.get("_malformed"):
            stats["excludedMalformedRows"] += 1
            continue
        if not any(market in (raw.get("countries_tags") or []) for market in MARKETS):
            stats["excludedMarket"] += 1
            continue
        name = (raw.get("product_name_en") or raw.get("product_name") or "").strip()
        code = barcode(raw.get("code"))
        if not name or not code:
            stats["excludedIdentity"] += 1
            continue
        v = raw.get("nutriments") or {}
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
            continue
        per = raw.get("nutrition_data_per")
        unit = raw.get("serving_quantity_unit")
        # OFF's *_100g fields also represent per-100ml for volume-based labels.
        # Require an explicit source basis; never convert volume into mass.
        if per == "100ml" or (per == "serving" and unit == "ml"):
            basis = "ml"
        elif per == "100g" and unit != "ml" or per == "serving" and unit == "g":
            basis = "g"
        else:
            stats["excludedAmbiguousBasis"] += 1
            continue
        micros = {}
        for key, _, columns, factor in MICROS:
            value = next((number(v.get(f"{c}_100g")) for c in columns if v.get(f"{c}_100g")), None)
            if value is not None and (value > 0 or key in LABELED):
                micros[key] = value * factor
        amount = number(raw.get("serving_quantity"))
        portions = []
        if amount and unit == basis:
            portions.append({"label": raw.get("serving_size") or "1 serving", "amount": amount})
        # "Coca-Cola, The Coca-Cola Company" is sold as Coca-Cola.
        brand = (raw.get("brands") or "").split(",")[0].strip()
        scans = number(raw.get("unique_scans_n")) or 0
        yield {"id": f"off:{raw['code']}", "name": name, "brand": brand, "barcode": code,
               "basis": basis, "nutrients": nutrients,
               "micros": checked_micros(nutrients, micros, limits, stats),
               "portions": portions, "popularity": round(math.log1p(scans), 2)}


def row_data(food):
    """What the app reads besides the columns: the basis, nutrients per 100 g or ml, portions."""
    nutrients = {k: rounded(v) for k, v in food["nutrients"].items()}
    nutrients.update({k: rounded(v) for k, v in food["micros"].items()})
    portions = [{"label": p["label"], "amount": rounded(p["amount"])} for p in food["portions"]]
    return json.dumps({"basis": food["basis"], "nutrients": nutrients, "portions": portions},
                      ensure_ascii=False, separators=(",", ":"))


def build(source, path, destination, limits=None):
    digest = sha256_file(path)
    recipe = sha256_file(Path(__file__))
    version = f"{source}-v{SCHEMA_VERSION}-{digest[:12]}-{recipe[:8]}"
    output = destination / f"{source}.db"
    temporary = destination / f"{source}.pending.db"
    temporary.unlink(missing_ok=True)
    connection = sqlite3.connect(temporary)
    connection.executescript("""
        CREATE TABLE foods (id TEXT PRIMARY KEY, name TEXT NOT NULL, brand TEXT NOT NULL,
                            barcode TEXT, popularity REAL NOT NULL, data TEXT NOT NULL);
        CREATE INDEX foods_barcode ON foods(barcode);
        CREATE VIRTUAL TABLE food_search USING fts5(name, brand, content='foods', content_rowid='rowid',
                                                    tokenize='unicode61 remove_diacritics 2');
        CREATE TABLE catalog_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    """)
    stats = collections.Counter()
    peaks = collections.defaultdict(float)
    foods = usda_foods(path, stats) if source == "usda" else off_foods(path, limits, stats)
    with connection:
        for food in foods:
            result = connection.execute("INSERT OR IGNORE INTO foods VALUES (?, ?, ?, ?, ?, ?)",
                                        (food["id"], food["name"], food["brand"], food["barcode"],
                                         food["popularity"], row_data(food)))
            stats["included" if result.rowcount else "duplicates"] += 1
            for key, value in food["micros"].items():
                peaks[key] = max(peaks[key], value)
        connection.execute("INSERT INTO food_search(food_search) VALUES ('rebuild')")
        connection.execute("INSERT INTO food_search(food_search) VALUES ('optimize')")
        # The words the catalog knows and how many foods use each, for correcting typos.
        connection.executescript("""
            CREATE VIRTUAL TABLE temp.vocabulary USING fts5vocab(main, food_search, row);
            CREATE TABLE terms (term TEXT PRIMARY KEY, foods INTEGER NOT NULL) WITHOUT ROWID;
            INSERT INTO terms SELECT term, doc FROM temp.vocabulary
                WHERE length(term) >= 3 AND term NOT GLOB '*[0-9]*';
            DROP TABLE temp.vocabulary;
        """)
        license_id, notice = LICENSES[source]
        connection.executemany("INSERT INTO catalog_meta VALUES (?, ?)", [
            ("version", version), ("license", license_id), ("attribution", notice),
            ("source", OFF_CSV_URL if source == "off" else USDA_URL)])
        connection.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
    stats["terms"] = connection.execute("SELECT count(*) FROM terms").fetchone()[0]
    assert connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    connection.execute("VACUUM")
    connection.close()
    temporary.replace(output)
    sample = source == "off" and str(path).endswith(".jsonl.gz")
    manifest = {"version": version,
                "sourceUrl": USDA_URL if source == "usda" else OFF_URL if sample else OFF_CSV_URL,
                "recipeSha256": recipe, "sourceSha256": digest,
                "sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
                "bytes": output.stat().st_size, "license": license_id,
                "developmentSample": sample, **dict(stats)}
    return manifest, dict(peaks)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--usda", type=Path, required=True)
    parser.add_argument("--off", type=Path, required=True)
    args = parser.parse_args()
    destination = ROOT / "assets" / "food"
    destination.mkdir(parents=True, exist_ok=True)
    usda, peaks = build("usda", args.usda, destination)
    # A packaged food holding over twice the richest USDA food's amount is a unit slip
    # (micrograms entered as grams), not food. Added sugar has no USDA value; its whole limits it.
    off, _ = build("off", args.off, destination, {key: peak * 2 for key, peak in peaks.items()})
    manifest = {"schemaVersion": SCHEMA_VERSION, "usda": usda, "off": off}
    (destination / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest, indent=2))
