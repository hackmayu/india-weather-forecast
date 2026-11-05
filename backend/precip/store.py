"""Processed-data storage: read-only access to artifacts written by precip.process."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import numpy as np

from . import config

RUN_ID_RE = re.compile(r"^\d{10}$")  # YYYYMMDDHH


@dataclass(frozen=True)
class RunData:
    meta: dict
    lats: np.ndarray            # descending
    lons: np.ndarray            # ascending
    cumulative_mm: np.ndarray   # (nsteps, nlat, nlon), cumulative since issue time
    interval_mm: np.ndarray     # (nsteps-1, nlat, nlon), interval i spans steps[i] -> steps[i+1]
    # Instantaneous fields (valid at each step time). None for runs processed before they existed.
    temp_c: np.ndarray | None = None      # 2 m temperature, degC
    cloud_pct: np.ndarray | None = None   # total cloud cover, %
    u10: np.ndarray | None = None         # 10 m wind components, m/s (u east, v north)
    v10: np.ndarray | None = None


def processed_dir() -> Path:
    return config.PROCESSED_DIR


def list_run_ids() -> list[str]:
    """Newest first. Only complete runs (meta.json present) are listed."""
    d = processed_dir()
    if not d.exists():
        return []
    return sorted((p.name for p in d.iterdir()
                   if RUN_ID_RE.match(p.name) and (p / "meta.json").exists()), reverse=True)


def load_meta(run_id: str) -> dict:
    return json.loads((processed_dir() / run_id / "meta.json").read_text())


@lru_cache(maxsize=4)
def _load(run_id: str, mtime: float) -> RunData:  # mtime in the key invalidates the cache on refresh
    base = processed_dir() / run_id
    with np.load(base / "arrays.npz") as z:
        opt = {k: (z[k] if k in z.files else None) for k in ("temp_c", "cloud_pct", "u10", "v10")}
        return RunData(load_meta(run_id), z["lats"], z["lons"], z["cumulative_mm"], z["interval_mm"], **opt)


@lru_cache(maxsize=2)
def _load_world(run_id: str, mtime: float) -> RunData | None:
    f = processed_dir() / run_id / "world.npz"
    if not f.exists():
        return None
    with np.load(f) as z:
        return RunData(load_meta(run_id), z["lats"], z["lons"], z["cumulative_mm"], z["interval_mm"],
                       z["temp_c"], z["cloud_pct"], z["u10"], z["v10"])


def load_world(run_id: str) -> RunData | None:
    """Coarse global layer of a run (2 deg block means, see world.py), or None if the run has none."""
    if not RUN_ID_RE.match(run_id):
        raise KeyError(run_id)
    meta_path = processed_dir() / run_id / "meta.json"
    if not meta_path.exists():
        raise KeyError(run_id)
    return _load_world(run_id, meta_path.stat().st_mtime)


def load_run(run_id: str) -> RunData:
    if not RUN_ID_RE.match(run_id):
        raise KeyError(run_id)
    meta_path = processed_dir() / run_id / "meta.json"
    if not meta_path.exists():
        raise KeyError(run_id)
    return _load(run_id, meta_path.stat().st_mtime)


def nearest_cell(run: RunData, lat: float, lon: float) -> tuple[int, int]:
    """Nearest grid point (no interpolation). Source grid is 0.25 deg, so a result can be up to
    ~0.125 deg (~14 km) in each direction from the requested point."""
    return int(np.abs(run.lats - lat).argmin()), int(np.abs(run.lons - lon).argmin())
