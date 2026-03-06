# fetch_aliases_fixed.py
import json
import sys
from collections import defaultdict

CITIES = "../../db/cities_db.json"
ALT = "/home/guillermo/Downloads/alternateNamesV2.txt"
OUT = "../data/cities_full.json"

cities = json.load(open(CITIES))
aliases = defaultdict(list)

print("Loading aliases...")
with open(ALT, "r", encoding="utf-8") as f:
    for line in f:
        parts = line.split("\t")
        if len(parts) < 4:
            continue
        
        geonameid = parts[1]
        alt = parts[3]

        if not alt or alt.startswith("Q") or alt.startswith("http"):
            continue

        aliases[geonameid].append(alt)

print("Merging aliases...")
for geonameid, alts in aliases.items():
    if geonameid in cities:
        cities[geonameid]["aliases"] = list(set(alts))

with open(OUT, "w", encoding="utf-8") as f:
    json.dump(cities, f, ensure_ascii=False, indent=2)

print("Done:", len(cities), "cities")
