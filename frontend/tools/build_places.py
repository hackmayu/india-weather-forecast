"""Build frontend/public/places.json from GeoNames cities1000 (India rows). Source: https://download.geonames.org/export/dump/
GeoNames data is licensed CC BY 4.0 (attribution shown in the app). Usage: python build_places.py <cities1000.txt> <admin1CodesASCII.txt> <out.json>"""
import json
import sys

src, admin, out = sys.argv[1:4]
states = {}
for line in open(admin, encoding="utf-8"):
    code, name = line.split("\t")[:2]
    if code.startswith("IN."):
        states[code[3:]] = name
rows = []
for line in open(src, encoding="utf-8"):
    f = line.rstrip("\n").split("\t")
    if f[8] != "IN":
        continue
    rows.append([f[2], states.get(f[10], ""), round(float(f[4]), 3), round(float(f[5]), 3), int(f[14] or 0)])
rows.sort(key=lambda r: -r[4])
json.dump(rows, open(out, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
print(len(rows), "places")
