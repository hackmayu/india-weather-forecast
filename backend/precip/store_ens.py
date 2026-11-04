"""Read-only access to ECMWF ENS probability artifacts written by precip.ens.

Kept separate from store.py because it is a different forecast system (ensemble), published only for
00/12 UTC runs, so its run can be older than the deterministic run.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import numpy as np

from . import config
from .store import RUN_ID_RE


@dataclass(frozen=True)
class ProbData:
    meta: dict
    lats: np.ndarray
    lons: np.ndarray
    prob: np.ndarray   # (n_windows, n_thresholds, nlat, nlon) uint16, tenths of a per cent


def ens_dir() -> Path:
    return config.PROCESSED_ENS_DIR


def list_ens_run_ids() -> list[str]:
    """Newest first; only complete runs (meta.json present)."""
    d = ens_dir()
    if not d.exists():
        return []
    return sorted((p.name for p in d.iterdir() if RUN_ID_RE.match(p.name) and (p / "meta.json").exists()), reverse=True)


@lru_cache(maxsize=3)
def _load_ens(run_id: str, mtime: float) -> ProbData:  # mtime in the key invalidates the cache on refresh
    base = ens_dir() / run_id
    meta = json.loads((base / "meta.json").read_text())
    with np.load(base / "arrays.npz") as z:
        return ProbData(meta, z["lats"], z["lons"], z["prob"])


def load_ens(run_id: str) -> ProbData:
    if not RUN_ID_RE.match(run_id):
        raise KeyError(run_id)
    meta_path = ens_dir() / run_id / "meta.json"
    if not meta_path.exists():
        raise KeyError(run_id)
    return _load_ens(run_id, meta_path.stat().st_mtime)


def nearest_cell_ens(p: ProbData, lat: float, lon: float) -> tuple[int, int]:
    return int(np.abs(p.lats - lat).argmin()), int(np.abs(p.lons - lon).argmin())
