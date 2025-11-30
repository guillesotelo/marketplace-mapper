import sys
import json

"""
USAGE:
    python3 generate_admin1_json.py admin1CodesASCII.txt admin1.json

INPUT:
    admin1CodesASCII.txt — GeoNames file with fields:
        code (e.g., 'SE.27')
        name
        asciiName
        geonameId

OUTPUT:
    {
        "SE": {
            "27": "Skåne",
            "15": "Örebro",
            ...
        },
        "US": {
            "CA": "California",
            "TX": "Texas",
            ...
        }
    }
"""

if len(sys.argv) != 3:
    print("Usage: python3 generate_admin1_json.py <admin1CodesASCII.txt> <output.json>")
    sys.exit(1)

input_file = sys.argv[1]
output_file = sys.argv[2]

admin1 = {}

with open(input_file, "r", encoding="utf-8") as f:
    for line in f:
        fields = line.strip().split("\t")
        if len(fields) < 4:
            continue

        code = fields[0]       # e.g., "SE.27"
        name = fields[1]       # e.g., "Skåne"
        # asciiName = fields[2]
        # geonameId = fields[3]

        if "." not in code:
            continue

        country, admin_code = code.split(".")

        if country not in admin1:
            admin1[country] = {}

        admin1[country][admin_code] = name

with open(output_file, "w", encoding="utf-8") as out:
    json.dump(admin1, out, ensure_ascii=False, indent=2)

print(f"Done! Saved admin1 mapping for {len(admin1)} countries to {output_file}")
