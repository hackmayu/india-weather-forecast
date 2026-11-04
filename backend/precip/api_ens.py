"""ECMWF ENS probability endpoints (official `ep` products; a separate system from the deterministic run).

Mounted into the main app by precip.api via include_router, before the static frontend mount.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import numpy as np
from fastapi import APIRouter, HTTPException, Path, Query

from . import store_ens as store

router = APIRouter(prefix="/api/probability", tags=["probability"])

STALE_ENS_AFTER = timedelta(hours=36)   # runs come every 12 h and appear ~8 h later
RunId = Path(pattern=r"^(\d{10}|latest)$", description="YYYYMMDDHH run id (00 or 12 UTC), or 'latest'")


def _resolve(run_id: str) -> store.ProbData:
    if run_id == "latest":
        ids = store.list_ens_run_ids()
        if not ids:
            raise HTTPException(503, "No ECMWF probability run is available yet (published for 00 and 12 UTC runs only).")
        run_id = ids[0]
    try:
        return store.load_ens(run_id)
    except KeyError:
        raise HTTPException(404, f"Probability run {run_id} is not available. See /api/probability/runs.") from None


def _freshness(meta: dict) -> dict:
    issue = datetime.fromisoformat(meta["issue_time_utc"].replace("Z", "+00:00"))
    age = datetime.now(timezone.utc) - issue
    return {"age_hours": round(age.total_seconds() / 3600, 1), "stale": age > STALE_ENS_AFTER,
            "stale_after_hours": STALE_ENS_AFTER.total_seconds() / 3600}


@router.get("/runs", summary="Processed ECMWF ENS probability runs (newest first)")
def runs() -> dict:
    out = []
    for rid in store.list_ens_run_ids():
        m = store.load_ens(rid).meta
        out.append({"run_id": rid, "issue_time_utc": m["issue_time_utc"], **_freshness(m)})
    return {"runs": out}


@router.get("/{run_id}", summary="Probability run metadata (thresholds, 24 h windows, semantics)")
def meta(run_id: str = RunId) -> dict:
    p = _resolve(run_id)
    m = {k: v for k, v in p.meta.items() if k != "raw_sha256"}
    return {**m, "freshness": _freshness(p.meta),
            "attribution": "Contains modified ECMWF Open Data (IFS ENS probabilities), CC-BY-4.0."}


def _window_index(p: store.ProbData, window_end: int) -> int:
    ends = [w["end_h"] for w in p.meta["windows"]]
    if window_end not in ends:
        raise HTTPException(422, f"window_end {window_end} is not an available 24 h window end; valid: {ends}")
    return ends.index(window_end)


def _threshold_index(p: store.ProbData, threshold: int) -> int:
    thr = p.meta["thresholds_mm"]
    if threshold not in thr:
        raise HTTPException(422, f"threshold {threshold} mm is not available; valid: {thr}")
    return thr.index(threshold)


@router.get("/{run_id}/map", summary="Probability (%) that 24 h rain reaches a threshold, regional grid")
def prob_map(run_id: str = RunId,
             window_end: int = Query(..., description="End of the 24 h window, in hours after the probability run's issue time"),
             threshold: int = Query(1, description="Rain amount in mm: 1, 5, 10, 25, 50 or 100")) -> dict:
    p = _resolve(run_id)
    wi, ti = _window_index(p, window_end), _threshold_index(p, threshold)
    w = p.meta["windows"][wi]
    grid = p.prob[wi, ti].astype(np.float32) / p.meta["scale"]
    return {"run_id": p.meta["run_id"], "variable": "prob", "kind": "probability", "units": "%",
            "threshold_mm": threshold, "window": w, "issue_time_utc": p.meta["issue_time_utc"],
            "valid_time_utc": w["end_utc"], "accumulation_hours": 24,
            "lats": [round(float(x), 4) for x in p.lats], "lons": [round(float(x), 4) for x in p.lons],
            "values": np.floor(grid + 0.5).tolist()}  # conventional rounding (50.5 -> 51), not numpy half-to-even


@router.get("/{run_id}/point", summary="Probabilities at the nearest grid point: every window x threshold")
def point(run_id: str = RunId,
          lat: float = Query(..., description="Latitude, degrees north"),
          lon: float = Query(..., description="Longitude, degrees east")) -> dict:
    p = _resolve(run_id)
    d = p.meta["domain"]
    if not (np.isfinite(lat) and np.isfinite(lon)) or not (
            d["lat_min"] <= lat <= d["lat_max"] and d["lon_min"] <= lon <= d["lon_max"]):
        raise HTTPException(422, f"Location is outside the supported domain "
                                 f"({d['lat_min']}–{d['lat_max']}°N, {d['lon_min']}–{d['lon_max']}°E).")
    iy, ix = store.nearest_cell_ens(p, lat, lon)
    vals = p.prob[:, :, iy, ix].astype(np.float32) / p.meta["scale"]
    return {"run_id": p.meta["run_id"], "issue_time_utc": p.meta["issue_time_utc"],
            "requested": {"lat": lat, "lon": lon}, "grid_point": {"lat": float(p.lats[iy]), "lon": float(p.lons[ix])},
            "method": "Nearest 0.25° grid point; no interpolation.", "units": "%",
            "thresholds_mm": p.meta["thresholds_mm"],
            "windows": [{**w, "probability_pct": [int(np.floor(float(v) + 0.5)) for v in vals[i]]}
                        for i, w in enumerate(p.meta["windows"])],
            "semantics": p.meta["semantics"]}
