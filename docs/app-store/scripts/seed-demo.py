"""Seed ONLY a fresh, isolated simulator app container, after migrations ran.
Usage: python3 docs/app-store/scripts/seed-demo.py /absolute/app/data/container
Stop the app first. Refuses any database with existing records.
"""
import datetime as dt
import json
import math
from pathlib import Path
import shutil
import sqlite3
import sys

container = Path(sys.argv[1]).resolve()
if 'CoreSimulator/Devices/' not in str(container):
    raise SystemExit('Only isolated iOS simulator containers are supported.')
database = container / 'Documents/SQLite/body_track.db'
if not database.is_file():
    raise SystemExit('Launch the app once to run migrations before seeding.')
con = sqlite3.connect(database)
for table in ('weight_entries', 'measurements', 'photos'):
    if con.execute(f'SELECT count(*) FROM {table}').fetchone()[0]:
        raise SystemExit('Refusing to overwrite existing records. Use a fresh capture simulator.')
start = dt.date(2026, 6, 13)
with con:
    for day in range(91):
        date = (start + dt.timedelta(days=day)).isoformat()
        weight = round(84 - 5.2 * day / 90 + .28 * math.sin(day * 1.7) + .12 * math.sin(day * .43), 1)
        con.execute('INSERT INTO weight_entries(weight_kg,measured_at,created_at,updated_at) VALUES(?,?,0,0)', (weight, date))
    con.execute('INSERT INTO measurements(kind,measured_at,"values",updated_at) VALUES(?,?,?,0)', ('height', start.isoformat(), json.dumps({'height': 182})))
    for day in (0, 15, 30, 45, 60, 75, 90):
        f = day / 90
        values = { 'neck': round(39 - f, 1), 'shoulders': 122, 'chest': round(106 - 2*f, 1), 'waist': round(89 - 7*f, 1), 'abdomen': round(93 - 7*f, 1), 'hips': round(101 - 3*f, 1), 'bodyFat': round(22 - 4*f, 1) }
        con.execute('INSERT INTO measurements(kind,measured_at,"values",updated_at) VALUES(?,?,?,0)', ('body', (start + dt.timedelta(days=day)).isoformat(), json.dumps(values)))
    for key, value in {'theme':'dark', 'language':'en', 'units':'metric', 'formula':'male', 'healthSyncEnabled':'false'}.items():
        con.execute('INSERT OR REPLACE INTO preferences(key,value) VALUES(?,?)', (key,value))
    source = Path(__file__).resolve().parents[1] / 'photos'
    target = container / 'Documents/progress-photos'
    for day in (0, 45, 90):
        # Insert in reverse order because the gallery sorts IDs descending.
        for pose in ('back', 'side', 'front'):
            photo = source / f'day{day}' / f'{pose}.png'
            if photo.is_file():
                target.mkdir(exist_ok=True)
                filename = f'day-{day:03}-{pose}.png'
                shutil.copyfile(photo, target / filename)
                con.execute('INSERT INTO photos(uri,pose,measured_at) VALUES(?,?,?)', (filename, pose, (start + dt.timedelta(days=day)).isoformat()))

con.close()
print('Seeded 91 fictional weigh-ins, seven body sessions and one height entry. Health sync disabled.')
