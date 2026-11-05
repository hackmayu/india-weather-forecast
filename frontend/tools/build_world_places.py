"""Build frontend/public/worldplaces.json from GeoNames cities15000 (largest non-Indian cities).
Source: https://download.geonames.org/export/dump/ (CC BY 4.0; credited in the app footer).
Usage: python build_world_places.py <cities15000.txt> <countryInfo.txt> <out.json> [max_places]"""
import json
import sys

src, info, out = sys.argv[1:4]
limit = int(sys.argv[4]) if len(sys.argv) > 4 else 6000
country = {}
for line in open(info, encoding="utf-8"):
    if line.startswith("#"):
        continue
    f = line.rstrip("\n").split("\t")
    country[f[0]] = f[4]
rows = []
for line in open(src, encoding="utf-8"):
    f = line.rstrip("\n").split("\t")
    if any(ch.isdigit() for ch in f[2]):   # skip numbered districts such as "Paris 15 Vaugirard"
        continue
    if f[8] == "IN":          # India has its own, denser list (places.json)
        continue
    rows.append([f[2], country.get(f[8], f[8]), round(float(f[4]), 3), round(float(f[5]), 3), int(f[14] or 0)])
rows.sort(key=lambda r: -r[4])
rows = rows[:limit]
json.dump(rows, open(out, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
print(len(rows), "places; smallest population", rows[-1][4])
