"""Write frontend/src/world-golden.json: real API answers (scope=world) for a few cells, from data/processed.
The browser engine (staticData.ts) must reproduce them exactly from the exported static files.
Usage (from backend/): python tools/make_world_golden.py"""
import json
from pathlib import Path

from fastapi.testclient import TestClient

from precip import api, store

ROOT = Path(__file__).resolve().parents[2]
rid = store.list_run_ids()[0]
c = TestClient(api.app)
cells = [(10, 20), (30, 100), (45, 150), (60, 40), (75, 170)]   # (row, col) on the 90 x 180 grid
out = {"run_id": rid, "cells": cells, "cases": []}
for params in ({"variable": "precip", "kind": "cumulative", "step": 24}, {"variable": "precip", "kind": "interval", "step": 12},
               {"variable": "precip", "kind": "window", "step": 48, "hours": 24}, {"variable": "temp", "step": 24},
               {"variable": "cloud", "step": 24}, {"variable": "wind", "step": 24}):
    j = c.get(f"/api/runs/{rid}/map", params={**params, "scope": "world"}).json()
    out["cases"].append({"params": params, "lats": [j["lats"][0], j["lats"][-1], len(j["lats"])], "lons": [j["lons"][0], j["lons"][-1], len(j["lons"])],
                         "units": j["units"], "values": [j["values"][r][k] for r, k in cells],
                         "u": [j["u"][r][k] for r, k in cells] if "u" in j else None})
(ROOT / "frontend" / "src" / "world-golden.json").write_text(json.dumps(out, indent=1))
print("wrote", len(out["cases"]), "cases for run", rid)
