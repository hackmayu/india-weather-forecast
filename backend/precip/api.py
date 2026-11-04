"""FastAPI backend. Serves pre-processed data only; never downloads or processes on a request."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Literal

import numpy as np
from fastapi import FastAPI, HTTPException, Path, Query

from . import config, store

# Forecasts are issued every 6 h and appear on the server a few hours later. A run older than
# this has missed at least two newer issue times, so we label it stale (a UI hint, not a verdict).
STALE_AFTER = timedelta(hours=18)

app = FastAPI(
    title="Precipitation forecast explorer (ECMWF Open Data IFS)",
    version="0.1.0",
    description=("Precipitation from ECMWF IFS HRES 0.25° open data over India. "
                 "Contains modified ECMWF data, CC-BY-4.0. Deterministic forecast: no probabilities, "
                 "no observations, not an official warning."),
)

RunId = Path(pattern=r"^(\d{10}|latest)$", description="YYYYMMDDHH run id, or 'latest'")


def _resolve(run_id: str) -> store.RunData:
    if run_id == "latest":
        ids = store.list_run_ids()
        if not ids:
            raise HTTPException(503, "No processed forecast run is available yet.")
        run_id = ids[0]
    try:
        return store.load_run(run_id)
    except KeyError:
        raise HTTPException(404, f"Run {run_id} is not available. See /api/runs.") from None


def _freshness(meta: dict) -> dict:
    issue = datetime.fromisoformat(meta["issue_time_utc"].replace("Z", "+00:00"))
    age = datetime.now(timezone.utc) - issue
    return {"age_hours": round(age.total_seconds() / 3600, 1), "stale": age > STALE_AFTER,
            "stale_after_hours": STALE_AFTER.total_seconds() / 3600}


@app.get("/api/health", summary="Liveness")
def health() -> dict:
    return {"status": "ok"}


@app.get("/api/ready", summary="Readiness: true when at least one processed run exists")
def ready() -> dict:
    ids = store.list_run_ids()
    if not ids:
        raise HTTPException(503, "No processed forecast run is available yet.")
    return {"status": "ready", "latest_run": ids[0]}


@app.get("/api/runs", summary="Available processed runs (newest first)")
def runs() -> dict:
    out = []
    for rid in store.list_run_ids():
        m = store.load_meta(rid)
        out.append({"run_id": rid, "issue_time_utc": m["issue_time_utc"], "model": m["model"],
                    "max_step_h": m["steps_h"][-1], **_freshness(m)})
    return {"runs": out}


@app.get("/api/runs/{run_id}", summary="Run metadata, provenance and freshness")
def run_meta(run_id: str = RunId) -> dict:
    r = _resolve(run_id)
    meta = {k: v for k, v in r.meta.items() if k != "raw_sha256"}
    return {**meta, "freshness": _freshness(r.meta),
            "attribution": "Contains modified ECMWF Open Data (IFS), CC-BY-4.0.",
            "semantics": {"cumulative": "mm of water accumulated from the issue time to the valid time",
                          "interval": "mm accumulated between the previous and the selected valid time "
                                      "(duration in interval_durations_h)"}}


@app.get("/api/runs/{run_id}/times", summary="Valid times and the interval each step closes")
def times(run_id: str = RunId) -> dict:
    m = _resolve(run_id).meta
    steps = m["steps_h"]
    return {"run_id": m["run_id"], "times": [
        {"step_h": s, "valid_time_utc": t,
         "interval_hours": None if i == 0 else m["interval_durations_h"][i - 1],
         "interval_start_utc": None if i == 0 else m["valid_times_utc"][i - 1]}
        for i, (s, t) in enumerate(zip(steps, m["valid_times_utc"]))]}


@app.get("/api/runs/{run_id}/map", summary="Regional precipitation grid for one valid time")
def map_data(run_id: str = RunId,
             step: int = Query(..., ge=0, le=config.MAX_STEP_H, description="Forecast step in hours"),
             kind: Literal["interval", "cumulative"] = "interval") -> dict:
    r = _resolve(run_id)
    steps = r.meta["steps_h"]
    if step not in steps:
        raise HTTPException(422, f"step {step} is not a forecast step of this run; valid: {steps}")
    i = steps.index(step)
    if kind == "interval":
        if i == 0:
            raise HTTPException(422, "step 0 has no interval total; use kind=cumulative or step >= 3")
        grid = r.interval_mm[i - 1]
        dur = r.meta["interval_durations_h"][i - 1]
    else:
        grid, dur = r.cumulative_mm[i], step
    return {"run_id": r.meta["run_id"], "step_h": step, "kind": kind,
            "valid_time_utc": r.meta["valid_times_utc"][i], "accumulation_hours": dur, "units": "mm",
            "lats": [round(float(x), 4) for x in r.lats], "lons": [round(float(x), 4) for x in r.lons],
            "values": np.round(grid, 1).tolist()}  # 0.1 mm precision; row 0 is the northern edge


@app.get("/api/runs/{run_id}/point", summary="Time series at the nearest grid point")
def point(run_id: str = RunId,
          lat: float = Query(..., description="Latitude, degrees north"),
          lon: float = Query(..., description="Longitude, degrees east")) -> dict:
    r = _resolve(run_id)
    d = r.meta["domain"]
    if not (np.isfinite(lat) and np.isfinite(lon)) or not (
            d["lat_min"] <= lat <= d["lat_max"] and d["lon_min"] <= lon <= d["lon_max"]):
        raise HTTPException(422, f"Location is outside the supported domain "
                                 f"({d['lat_min']}–{d['lat_max']}°N, {d['lon_min']}–{d['lon_max']}°E).")
    iy, ix = store.nearest_cell(r, lat, lon)
    steps, vt = r.meta["steps_h"], r.meta["valid_times_utc"]
    return {
        "run_id": r.meta["run_id"],
        "requested": {"lat": lat, "lon": lon},
        "grid_point": {"lat": float(r.lats[iy]), "lon": float(r.lons[ix])},
        "method": "nearest grid point at 0.25° (~28 km); no interpolation. "
                  "Represents a grid-cell value, not a point measurement.",
        "units": "mm",
        "series": [{"step_h": s, "valid_time_utc": vt[i],
                    "cumulative_mm": round(float(r.cumulative_mm[i, iy, ix]), 2),
                    "interval_mm": None if i == 0 else round(float(r.interval_mm[i - 1, iy, ix]), 2),
                    "interval_hours": None if i == 0 else r.meta["interval_durations_h"][i - 1]}
                   for i, s in enumerate(steps)],
    }


# --- Static frontend (production): serve the built React app from the same origin. -------------
# Mounted last so /api/* routes win. In development Vite serves the frontend and proxies /api.
_DIST = config.PROJECT_ROOT / "frontend" / "dist"
if _DIST.is_dir():
    from fastapi.staticfiles import StaticFiles

    app.mount("/", StaticFiles(directory=_DIST, html=True), name="frontend")
