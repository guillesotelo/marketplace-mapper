import json
import sys

"""
USAGE:
    python3 merge_cities_admin1.py worldCities.json admin1.json merged.json
"""

if len(sys.argv) != 4:
    print("Usage: python3 merge_cities_admin1.py <worldCities.json> <admin1.json> <output.json>")
    sys.exit(1)

cities_file = sys.argv[1]
admin1_file = sys.argv[2]
output_file = sys.argv[3]

# Load both
with open(cities_file, "r", encoding="utf-8") as f:
    cities = json.load(f)

with open(admin1_file, "r", encoding="utf-8") as f:
    admin1 = json.load(f)

merged = {}

for city_name, data in cities.items():
    country = data.get("country")
    admin1_code = data.get("admin1")

    # Lookup admin1 name (fallback to None if missing)
    admin1_name = None
    if country in admin1 and admin1_code in admin1[country]:
        admin1_name = admin1[country][admin1_code]

    merged[city_name] = {
        "country": country,
        "admin1_code": admin1_code,
        "admin1_name": admin1_name,
        "lat": data["lat"],
        "lon": data["lon"]
    }

with open(output_file, "w", encoding="utf-8") as out:
    json.dump(merged, out, ensure_ascii=False, indent=2)

print(f"Done! Merged {len(merged)} cities → {output_file}")
