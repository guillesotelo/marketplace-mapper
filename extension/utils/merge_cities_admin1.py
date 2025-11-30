# merge_cities_with_admin1.py
import json
import sys

if len(sys.argv) != 4:
    print("Usage: python3 merge_cities_with_admin1.py cities.json admin1.json out.json")
    sys.exit(1)

cities_file = sys.argv[1]
admin1_file = sys.argv[2]
output = sys.argv[3]

cities = json.load(open(cities_file))
admin1 = json.load(open(admin1_file))

for geonameid, data in cities.items():
    country = data["country"]
    admin_code = data["admin1"]

    data["admin1_name"] = admin1.get(country, {}).get(admin_code, None)

with open(output, "w", encoding="utf-8") as f:
    json.dump(cities, f, ensure_ascii=False, indent=2)
