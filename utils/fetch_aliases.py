import json
from collections import defaultdict
import gzip

# -----------------------------
# File paths (update if needed)
# -----------------------------
MY_CITIES_JSON = "data/cities_db.json"
ADMIN1_CODES = "/home/guillermo/Downloads/admin1CodesASCII.txt"
ALTERNATE_NAMES = "/home/guillermo/Downloads/alternateNamesV2.txt"
ALL_COUNTRIES = "/home/guillermo/Downloads/allCountries.txt"
OUTPUT_JSON = "data/cities_db.json"
OUTPUT_GZ = "data/cities_db.json.gz"

# -----------------------------
# Load your city DB
# -----------------------------
print("Loading your city DB...")
with open(MY_CITIES_JSON, "r", encoding="utf-8") as f:
    my_cities = json.load(f)

# -----------------------------
# Load admin1 codes
# -----------------------------
print("Loading admin1 codes...")
admin1_map = {}
with open(ADMIN1_CODES, "r", encoding="utf-8") as f:
    for line in f:
        parts = line.strip().split("\t")
        if len(parts) < 2:
            continue
        code, name = parts[0], parts[1]
        country, admin_code = code.split(".")
        admin1_map[(country, admin_code)] = name

# -----------------------------
# Load alternate names (aliases)
# -----------------------------
print("Loading alternate names...")
aliases_map = defaultdict(set)
with open(ALTERNATE_NAMES, "r", encoding="utf-8") as f:
    for line in f:
        parts = line.strip().split("\t")
        if len(parts) < 4:
            continue
        geonameid = parts[1]
        alt_name = parts[3]
        aliases_map[geonameid].add(alt_name)

# -----------------------------
# Load GeoNames cities
# -----------------------------
print("Loading GeoNames cities...")
cities_map = {}       # key: geonameid -> city info
geo_lookup = {}       # key: (lat_rounded, lon_rounded, country, admin1) -> geonameid

for line in open(ALL_COUNTRIES, "r", encoding="utf-8"):
    parts = line.strip().split("\t")
    if len(parts) < 19:
        continue
    geonameid = parts[0]
    name = parts[1]
    lat = float(parts[4])
    lon = float(parts[5])
    country = parts[8]
    admin1_code = parts[10]

    # Clean aliases: remove Wikidata QIDs and URLs, remove duplicates
    raw_aliases = aliases_map.get(geonameid, set())
    clean_aliases = list({a for a in raw_aliases if not a.startswith("Q") and not a.startswith("http") and len(a) > 1})

    cities_map[geonameid] = {
        "name": name,
        "lat": lat,
        "lon": lon,
        "country": country,
        "admin1_code": admin1_code,
        "aliases": clean_aliases
    }

    key = (round(lat, 4), round(lon, 4), country, admin1_code)
    geo_lookup[key] = geonameid

# -----------------------------
# Merge with your DB
# -----------------------------
print("Merging DBs...")
merged = []

for entry in my_cities:
    # entry may be list or object depending on your cities_db.json
    if isinstance(entry, list):
        name, lat, lon, country, admin1_code, admin1_name = entry
    else:
        name = entry.get("name")
        lat = entry.get("lat")
        lon = entry.get("lon")
        country = entry.get("country")
        admin1_code = entry.get("admin1", "")
        admin1_name = entry.get("admin1_name", "")

    key = (round(lat, 4), round(lon, 4), country, admin1_code)
    key_match = geo_lookup.get(key)

    if key_match:
        gn = cities_map[key_match]
        merged.append({
            "name": name,
            "lat": lat,
            "lon": lon,
            "country": country,
            "admin1": admin1_code,
            "admin1_name": admin1_map.get((country, admin1_code), admin1_name),
            "aliases": gn["aliases"]
        })
    else:
        merged.append({
            "name": name,
            "lat": lat,
            "lon": lon,
            "country": country,
            "admin1": admin1_code,
            "admin1_name": admin1_name,
            "aliases": []
        })

# -----------------------------
# Save merged JSON
# -----------------------------
print(f"Saving merged JSON to {OUTPUT_JSON}...")
with open(OUTPUT_JSON, "w", encoding="utf-8") as f:
    json.dump(merged, f, ensure_ascii=False, indent=2)

# -----------------------------
# Save compressed .gz for pako
# -----------------------------
print(f"Saving compressed JSON to {OUTPUT_GZ}...")
with gzip.open(OUTPUT_GZ, "wt", encoding="utf-8") as f:
    json.dump(merged, f, ensure_ascii=False)

print("Done! Total cities merged:", len(merged))
