#!/usr/bin/env python3
"""Build source-separated, indexed offline catalogs. Python standard library only.

Usage: python3 scripts/build-food-catalog.py --usda /path/usda.zip --off /path/off.jsonl.gz
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
SCHEMA_VERSION = 1
USDA_URL = "https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_json_2018-04.zip"
OFF_URL = "https://world.openfoodfacts.org/data/exports/products.random-modulo-1000.jsonl.gz"
OFF_CSV_URL = "https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz"


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def off_records(path):
    with gzip.open(path, "rt", encoding="utf-8", newline="") as source:
        if not str(path).endswith(".csv.gz"):
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
            # The CSV omits nutrition_data_per and serving_quantity_unit. Only infer a
            # basis from an explicit g/ml serving label, never from a product category.
            portions = re.findall(r"(\d+(?:[.,]\d+)?)\s*(ml|grams?|g)\b", raw.get("serving_size", ""), re.I)
            units = {"ml" if unit.lower() == "ml" else "g" for _, unit in portions}
            if len(units) == 1:
                unit = units.pop()
                raw["nutrition_data_per"] = "100ml" if unit == "ml" else "100g"
                raw["serving_quantity_unit"] = unit
                raw["serving_quantity"] = portions[-1][0].replace(",", ".")
            yield raw


def number(value):
    try:
        parsed = float(value)
        return parsed if math.isfinite(parsed) and parsed >= 0 else None
    except (TypeError, ValueError):
        return None


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


def usda_foods(path, version, stats):
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
        portions = []
        for p in raw.get("foodPortions", []):
            grams = number(p.get("gramWeight"))
            amount = number(p.get("amount"))
            label = p.get("modifier") or p.get("portionDescription")
            if grams and amount and label:
                portions.append({"label": f"{amount:g} {label}", "amount": grams})
        yield {"id": f"usda:{raw['fdcId']}", "name": raw["description"], "brand": "",
               "barcode": None, "basis": "g", "nutrients": nutrients, "portions": portions[:12],
               "source": "usda", "sourceVersion": version}


def off_foods(path, version, stats):
    for raw in off_records(path):
            stats["sourceRecords"] += 1
            if raw.get("_malformed"):
                stats["excludedMalformedRows"] += 1
                continue
            if "en:united-states" not in (raw.get("countries_tags") or []):
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
            amount = number(raw.get("serving_quantity"))
            portions = []
            if amount and unit == basis:
                portions.append({"label": raw.get("serving_size") or "1 serving", "amount": amount})
            yield {"id": f"off:{raw['code']}", "name": name, "brand": raw.get("brands") or "",
                   "barcode": code, "basis": basis, "nutrients": nutrients, "portions": portions,
                   "source": "off", "sourceVersion": version}


def build(source, path, destination):
    digest = sha256_file(path)
    recipe = sha256_file(Path(__file__))
    version = f"{source}-v{SCHEMA_VERSION}-{digest[:12]}-{recipe[:8]}"
    output = destination / f"{source}.db"
    temporary = destination / f"{source}.pending.db"
    temporary.unlink(missing_ok=True)
    connection = sqlite3.connect(temporary)
    connection.executescript("""
        CREATE TABLE foods (id TEXT PRIMARY KEY, name TEXT NOT NULL, brand TEXT NOT NULL,
                            barcode TEXT, data TEXT NOT NULL);
        CREATE INDEX foods_barcode ON foods(barcode);
        CREATE VIRTUAL TABLE food_search USING fts5(name, brand, content='foods', content_rowid='rowid',
                                                    tokenize='unicode61 remove_diacritics 2');
        CREATE TABLE catalog_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    """)
    stats = collections.Counter()
    iterator = usda_foods if source == "usda" else off_foods
    with connection:
        for food in iterator(path, version, stats):
            result = connection.execute("INSERT OR IGNORE INTO foods VALUES (?, ?, ?, ?, ?)",
                                        (food["id"], food["name"], food["brand"], food["barcode"],
                                         json.dumps(food, ensure_ascii=False, separators=(",", ":"))))
            stats["included" if result.rowcount else "duplicates"] += 1
        connection.execute("INSERT INTO food_search(food_search) VALUES ('rebuild')")
        connection.execute("INSERT INTO food_search(food_search) VALUES ('optimize')")
        connection.execute("INSERT INTO catalog_meta VALUES ('version', ?)", (version,))
        connection.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
    assert connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    connection.execute("VACUUM")
    connection.close()
    temporary.replace(output)
    sample = source == "off" and not str(path).endswith(".csv.gz")
    return {"version": version, "sourceUrl": USDA_URL if source == "usda" else OFF_URL if sample else OFF_CSV_URL,
            "recipeSha256": recipe,
            "sourceSha256": digest, "sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
            "bytes": output.stat().st_size, "license": "CC0-1.0" if source == "usda" else "ODbL-1.0",
            "developmentSample": sample, **dict(stats)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--usda", type=Path, required=True)
    parser.add_argument("--off", type=Path, required=True)
    args = parser.parse_args()
    destination = ROOT / "assets" / "food"
    destination.mkdir(parents=True, exist_ok=True)
    manifest = {"schemaVersion": SCHEMA_VERSION,
                "usda": build("usda", args.usda, destination),
                "off": build("off", args.off, destination)}
    (destination / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest, indent=2))
