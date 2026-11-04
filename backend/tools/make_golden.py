"""Generate golden outputs of the REAL FastAPI endpoints from the committed snapshot data, for the
frontend parity tests (frontend/src/staticData.test.ts). Re-run it whenever the snapshot or the API changes:

    python backend/tools/make_golden.py            # writes frontend/src/golden.json

The static (browser-side) data engine must reproduce these outputs from the exported files.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from fastapi.testclient import TestClient  # noqa: E402

from precip import api, config, store, store_ens  # noqa: E402


def main() -> None:
    config.PROCESSED_DIR = config.SNAPSHOT_DIR
    config.PROCESSED_ENS_DIR = config.SNAPSHOT_ENS_DIR
    store._load.cache_clear()
    store_ens._load_ens.cache_clear()
    c = TestClient(api.app)

    runs = c.get("/api/runs").json()["runs"]
    latest = runs[0]["run_id"]
    older = runs[1]["run_id"] if len(runs) > 1 else latest
    prob_run = c.get("/api/probability/runs").json()["runs"][0]["run_id"]

    def get(path):
        r = c.get(path)
        return r.status_code, r.json()

    golden: dict = {"latest_run": latest, "older_run": older, "prob_run": prob_run}

    _, meta = get(f"/api/runs/{latest}")
    golden["meta"] = {k: meta[k] for k in ("run_id", "issue_time_utc", "published_at_utc", "availability_delay_h", "steps_h",
                                           "valid_times_utc", "interval_durations_h", "domain", "grid")}
    _, pmeta = get(f"/api/probability/{prob_run}")
    golden["prob_meta"] = {k: pmeta[k] for k in ("run_id", "issue_time_utc", "thresholds_mm", "windows", "units", "scale")}

    # full grids for three representative maps + samples for the rest
    cases = [
        ("map_window24", f"/api/runs/{latest}/map?step=48&variable=precip&kind=window&hours=24", True),
        ("map_interval", f"/api/runs/{latest}/map?step=24&variable=precip&kind=interval", False),
        ("map_cumulative", f"/api/runs/{older}/map?step=72&variable=precip&kind=cumulative", False),
        ("map_temp", f"/api/runs/{latest}/map?step=24&variable=temp", True),
        ("map_cloud", f"/api/runs/{latest}/map?step=24&variable=cloud", False),
        ("map_wind", f"/api/runs/{latest}/map?step=24&variable=wind", False),
    ]
    golden["maps"] = {}
    for name, path, full in cases:
        s, j = get(path)
        assert s == 200, (path, s, j)
        entry = {"path": path, **{k: j[k] for k in ("run_id", "step_h", "variable", "kind", "accumulation_hours", "units", "valid_time_utc")},
                 "shape": [len(j["values"]), len(j["values"][0])]}
        entry["values" if full else "samples"] = j["values"] if full else [[y, x, j["values"][y][x]] for y in range(0, entry["shape"][0], 17) for x in range(0, entry["shape"][1], 19)]
        if "u" in j:   # wind components: samples only (the speed field is the main check)
            entry["u_samples"] = [[y, x, j["u"][y][x]] for y in range(0, entry["shape"][0], 17) for x in range(0, entry["shape"][1], 19)]
            entry["v_samples"] = [[y, x, j["v"][y][x]] for y in range(0, entry["shape"][0], 17) for x in range(0, entry["shape"][1], 19)]
        golden["maps"][name] = entry

    # places (nearest-cell time series), incl. a cell in the wettest area
    golden["points"] = {}
    for name, (lat, lon) in {"kolkata": (22.57, 88.36), "mumbai": (19.08, 72.88), "wet": (17.25, 81.5), "himalaya": (34.15, 77.58)}.items():
        s, j = get(f"/api/runs/{latest}/point?lat={lat}&lon={lon}")
        assert s == 200
        golden["points"][name] = {"lat": lat, "lon": lon, "grid_point": j["grid_point"], "method": j["method"], "series": j["series"]}

    # probabilities
    s, pm = get(f"/api/probability/{prob_run}/map?window_end=48&threshold=10")
    assert s == 200
    golden["prob_map"] = {"path": f"/api/probability/{prob_run}/map?window_end=48&threshold=10", "window": pm["window"], "valid_time_utc": pm["valid_time_utc"], "values": pm["values"]}
    s, pp = get(f"/api/probability/{prob_run}/point?lat=17.25&lon=81.5")
    assert s == 200
    golden["prob_point"] = {"lat": 17.25, "lon": 81.5, "grid_point": pp["grid_point"], "thresholds_mm": pp["thresholds_mm"], "windows": pp["windows"]}

    # error behaviour: status code and message must match
    errors = {
        "bad_step": f"/api/runs/{latest}/map?step=4&variable=precip&kind=cumulative",
        "interval_step0": f"/api/runs/{latest}/map?step=0&variable=precip&kind=interval",
        "window_bad_hours": f"/api/runs/{latest}/map?step=24&variable=precip&kind=window&hours=5",
        "window_before_start": f"/api/runs/{latest}/map?step=6&variable=precip&kind=window&hours=24",
        "unknown_run": "/api/runs/2020010100/map?step=24&variable=precip&kind=cumulative",
        "outside_domain": f"/api/runs/{latest}/point?lat=50&lon=80",
        "prob_bad_window": f"/api/probability/{prob_run}/map?window_end=30&threshold=10",
        "prob_bad_threshold": f"/api/probability/{prob_run}/map?window_end=48&threshold=3",
        "prob_outside": f"/api/probability/{prob_run}/point?lat=50&lon=80",
    }
    golden["errors"] = {}
    for name, path in errors.items():
        s, j = get(path)
        golden["errors"][name] = {"path": path, "status": s, "detail": j["detail"]}

    out = ROOT / "frontend" / "src" / "golden.json"
    out.write_text(json.dumps(golden, separators=(",", ":")))
    print(f"wrote {out} ({out.stat().st_size / 1e3:.0f} KB): maps={list(golden['maps'])} points={list(golden['points'])} errors={len(golden['errors'])}")


if __name__ == "__main__":
    main()
