# enrich_cities.py
#
# Adds population, admin2 and admin2_name to an existing cities database,
# joining on the GeoNames id that keys it.
#
# Enriching in place (rather than regenerating) is deliberate: every existing
# name, alias and coordinate is left byte-identical, so this can only add
# information and never change how an already-working lookup resolves.
#
# Usage:
#   python3 enrich_cities.py cities_db.json.gz cities500.txt admin2Codes.txt out.json
import sys
import gzip
import json

if len(sys.argv) != 5:
    print("Usage: python3 enrich_cities.py in.json[.gz] cities500.txt admin2Codes.txt out.json")
    sys.exit(1)

in_file, cities500, admin2_file, out_file = sys.argv[1:]

opener = gzip.open if in_file.endswith(".gz") else open
with opener(in_file, "rt", encoding="utf-8") as f:
    cities = json.load(f)

# GB.ENG.I9 -> "Norfolk"
admin2_names = {}
with open(admin2_file, "r", encoding="utf-8") as f:
    for line in f:
        parts = line.rstrip("\n").split("\t")
        if len(parts) >= 2:
            admin2_names[parts[0]] = parts[1]

added_pop = 0
added_admin2 = 0
missing = 0

with open(cities500, "r", encoding="utf-8") as f:
    for line in f:
        fields = line.rstrip("\n").split("\t")
        if len(fields) < 19:
            continue

        row = cities.get(fields[0])
        if row is None:
            continue

        try:
            population = int(fields[14])
        except ValueError:
            population = 0

        row["population"] = population
        if population:
            added_pop += 1

        admin2 = fields[11]
        if admin2:
            key = f"{fields[8]}.{fields[10]}.{admin2}"
            name = admin2_names.get(key)
            if name:
                row["admin2"] = admin2
                row["admin2_name"] = name
                added_admin2 += 1

# Rows the dump no longer contains still need the field present
for row in cities.values():
    if "population" not in row:
        row["population"] = 0
        missing += 1

with open(out_file, "w", encoding="utf-8") as f:
    json.dump(cities, f, ensure_ascii=False, separators=(",", ":"))

print(f"rows            : {len(cities)}")
print(f"with population : {added_pop}")
print(f"with admin2     : {added_admin2}")
print(f"not in dump     : {missing}")
