import sys
import json

"""
USAGE:
    python3 generate_cities_json.py cities500.txt worldCities.json

INPUT:
    cities500.txt — GeoNames tab-separated file with structure:
        geonameid, name, asciiname, alternatenames, latitude, longitude, 
        feature class, feature code, country code, cc2, admin1, admin2,
        admin3, admin4, population, elevation, dem, timezone, moddate

OUTPUT (JSON):
    {
        "<CityName>": {
            "country": "<ISO-2>",
            "admin1": "<AdminCode>",
            "lat": float,
            "lon": float
        },
        ...
    }
"""

if len(sys.argv) != 3:
    print("Usage: python3 generate_cities_json.py <input_cities500.txt> <output.json>")
    sys.exit(1)

input_file = sys.argv[1]
output_file = sys.argv[2]

cities = {}

with open(input_file, "r", encoding="utf-8") as f:
    for line in f:
        fields = line.strip().split("\t")
        if len(fields) < 19:
            continue

        name = fields[1]
        lat = fields[4]
        lon = fields[5]
        country = fields[8]
        admin1 = fields[10]

        # Skip if coordinates missing
        if lat == "" or lon == "":
            continue

        try:
            lat = float(lat)
            lon = float(lon)
        except ValueError:
            continue

        cities[name] = {
            "country": country,
            "admin1": admin1,
            "lat": lat,
            "lon": lon
        }

# Save JSON prettified but still reasonably compact
with open(output_file, "w", encoding="utf-8") as out:
    json.dump(cities, out, ensure_ascii=False, indent=2)

print(f"Done! Saved {len(cities)} cities to {output_file}")
