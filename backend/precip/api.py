"""FastAPI backend. Serves pre-processed data only; never downloads or processes on a request."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Literal

import numpy as np
from fastapi import FastAPI, HTTPException, Path, Query
from fastapi.middleware.gzip import GZipMiddleware

from contextlib import asynccontextmanager

from . import config, refresh, store
from .derive import wind_from_direction_deg

# Forecasts are issued every 6 h and appear on the server a few hours later. A run older than
# this has missed at least two newer issue times, so we label it stale (a UI hint, not a verdict).
STALE_AFTER = timedelta(hours=18)

@asynccontextmanager
async def lifespan(_: FastAPI):
    refresh.start()  # seeds from the dated snapshot; starts the refresh thread only if enabled
    yield
    refresh.stop()


app = FastAPI(
    lifespan=lifespan,
    title="Precipitation forecast explorer (ECMWF Open Data IFS)",
    version="0.1.0",
    description=("Precipitation from ECMWF IFS HRES 0.25° open data over India. "
                 "Contains modified ECMWF data, CC-BY-4.0. Deterministic forecast: no probabilities, "
                 "no observations, not an official warning."),
)

# JSON grids compress ~5-10x; without this a wind field is ~840 KB over the wire.
app.add_middleware(GZipMiddleware, minimum_size=1000)

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


@app.get("/api/status", summary="Latest run id and background-refresh state")
def status() -> dict:
    return refresh.status()


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


Variable = Literal["precip", "temp", "cloud", "wind"]
_INSTANT_UNITS = {"temp": "°C", "cloud": "%", "wind": "m/s"}


def _instant_field(r: store.RunData, variable: str) -> np.ndarray:
    arr = {"temp": r.temp_c, "cloud": r.cloud_pct,
           "wind": None if r.u10 is None else np.hypot(r.u10, r.v10)}[variable]
    if arr is None:
        raise HTTPException(404, f"Variable '{variable}' is not available in run {r.meta['run_id']} "
                                 "(processed before it was added).")
    return arr


@app.get("/api/runs/{run_id}/map", summary="Regional grid for one valid time")
def map_data(run_id: str = RunId,
             step: int = Query(..., ge=0, le=config.MAX_STEP_H, description="Forecast step in hours"),
             variable: Variable = Query("precip", description="precip (mm), temp (°C), cloud (%), wind (m/s)"),
             kind: Literal["interval", "cumulative"] = Query(
                 "interval", description="Only for variable=precip: interval total or cumulative since issue")) -> dict:
    r = _resolve(run_id)
    steps = r.meta["steps_h"]
    if step not in steps:
        raise HTTPException(422, f"step {step} is not a forecast step of this run; valid: {steps}")
    i = steps.index(step)
    out = {"run_id": r.meta["run_id"], "step_h": step, "variable": variable,
           "valid_time_utc": r.meta["valid_times_utc"][i],
           "lats": [round(float(x), 4) for x in r.lats], "lons": [round(float(x), 4) for x in r.lons]}
    if variable == "precip":
        if kind == "interval":
            if i == 0:
                raise HTTPException(422, "step 0 has no interval total; use kind=cumulative or step >= 3")
            grid, dur = r.interval_mm[i - 1], r.meta["interval_durations_h"][i - 1]
        else:
            grid, dur = r.cumulative_mm[i], step
        return {**out, "kind": kind, "accumulation_hours": dur, "units": "mm",
                "values": np.round(grid, 1).tolist()}  # 0.1 mm precision; row 0 is the northern edge
    grid = _instant_field(r, variable)[i]
    res = {**out, "kind": "instant", "accumulation_hours": 0, "units": _INSTANT_UNITS[variable],
           "values": np.round(grid, 0 if variable == "cloud" else 1).tolist()}
    if variable == "wind":  # components let the client draw direction arrows (no extra derivation)
        res["u"], res["v"] = np.round(r.u10[i], 1).tolist(), np.round(r.v10[i], 1).tolist()
    return res


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
    have_instant = r.temp_c is not None and r.u10 is not None
    series = []
    for i, s in enumerate(steps):
        row = {"step_h": s, "valid_time_utc": vt[i],
               "cumulative_mm": round(float(r.cumulative_mm[i, iy, ix]), 2),
               "interval_mm": None if i == 0 else round(float(r.interval_mm[i - 1, iy, ix]), 2),
               "interval_hours": None if i == 0 else r.meta["interval_durations_h"][i - 1]}
        if have_instant:
            u, v = float(r.u10[i, iy, ix]), float(r.v10[i, iy, ix])
            row.update(temp_c=round(float(r.temp_c[i, iy, ix]), 1), cloud_pct=round(float(r.cloud_pct[i, iy, ix])),
                       wind_speed_ms=round(float(np.hypot(u, v)), 1),
                       wind_from_deg=round(float(wind_from_direction_deg(u, v))) % 360)
        series.append(row)
    return {
        "run_id": r.meta["run_id"],
        "requested": {"lat": lat, "lon": lon},
        "grid_point": {"lat": float(r.lats[iy]), "lon": float(r.lons[ix])},
        "method": "Nearest grid point at 0.25° (~28 km); no interpolation. "
                  "Represents a grid-cell value, not a point measurement.",
        "units": "mm",
        "series": series,
    }


# --- Static frontend (production): serve the built React app from the same origin. -------------
# Mounted last so /api/* routes win. In development Vite serves the frontend and proxies /api.
_DIST = config.PROJECT_ROOT / "frontend" / "dist"
if _DIST.is_dir():
    from fastapi.staticfiles import StaticFiles

    app.mount("/", StaticFiles(directory=_DIST, html=True), name="frontend")
