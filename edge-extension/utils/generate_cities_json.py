# generate_cities_geonamesid.py
import sys
import json

if len(sys.argv) != 3:
    print("Usage: python3 generate_cities_json.py cities500.txt output.json")
    sys.exit(1)

input_file = sys.argv[1]
output_file = sys.argv[2]

cities = {}

with open(input_file, "r", encoding="utf-8") as f:
    for line in f:
        fields = line.strip().split("\t")
        if len(fields) < 19:
            continue

        geonameid = fields[0]
        name = fields[1]
        lat = fields[4]
        lon = fields[5]
        country = fields[8]
        admin1 = fields[10]

        try:
            lat = float(lat)
            lon = float(lon)
        except:
            continue

        cities[geonameid] = {
            "name": name,
            "lat": lat,
            "lon": lon,
            "country": country,
            "admin1": admin1,
            "aliases": []
        }

with open(output_file, "w", encoding="utf-8") as f:
    json.dump(cities, f, ensure_ascii=False, indent=2)

print("Saved", len(cities), "cities.")
