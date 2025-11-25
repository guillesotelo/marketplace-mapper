import json
import sys

if len(sys.argv) != 3:
    print("Usage: python3 pack_json.py merged.json packed.json")
    sys.exit(1)

with open(sys.argv[1], "r", encoding="utf-8") as f:
    data = json.load(f)

packed = []

for city, d in data.items():
    packed.append([
        city,
        d["lat"],
        d["lon"],
        d["country"],
        d["admin1_code"],
        d["admin1_name"]
    ])

with open(sys.argv[2], "w", encoding="utf-8") as out:
    json.dump(packed, out, ensure_ascii=False, separators=(",", ":"))
