"""Export processed runs as STATIC files for hosts without a backend (e.g. Vercel's free static hosting).

The browser reads these files and computes map grids / place series itself (frontend/src/staticData.ts),
using the same rules as the FastAPI endpoints (parity is tested against golden outputs of the real API).

Layout under <out>/:
  index.json                       runs (newest first), probability runs, generation time
  runs/<run_id>/meta.json          run metadata + lats/lons + file encodings
  runs/<run_id>/{cum,interval}.bin float32  (steps, nlat, nlon) mm       (interval has steps-1 entries)
  runs/<run_id>/temp.bin           int16    degC x10
  runs/<run_id>/cloud.bin          uint8    per cent
  runs/<run_id>/{u,v}.bin          int16    m/s x100
  runs/<run_id>/world/*.bin        same six files for the coarse 2 deg global overview (meta.json -> world.encodings)
  prob/<run_id>/meta.json, prob.bin  uint16 tenths of a per cent (windows, thresholds, nlat, nlon)
All binary files are little-endian, row 0 = northern edge, no header (shapes are in meta.json).

Usage: python -m precip.export_static --out frontend/static-data [--source processed|snapshot] [--keep 2]
"""
from __future__ import annotations

import argparse
import json
import logging
import shutil
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from . import config
from .store import RUN_ID_RE

log = logging.getLogger("precip.export_static")
FORMAT_VERSION = 1


def _run_dirs(root: Path) -> list[Path]:
    if not root.is_dir():
        return []
    return sorted((p for p in root.iterdir() if RUN_ID_RE.match(p.name) and (p / "meta.json").exists()), reverse=True)


def _write(path: Path, arr: np.ndarray, dtype: str) -> dict:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = np.ascontiguousarray(arr.astype(dtype))
    path.write_bytes(data.tobytes())
    return {"dtype": dtype, "shape": list(data.shape), "bytes": data.nbytes}


def export_run(src: Path, out: Path) -> dict:
    """Export one processed deterministic run directory."""
    meta = json.loads((src / "meta.json").read_text())
    with np.load(src / "arrays.npz") as z:
        if "temp_c" not in z.files:
            raise ValueError(f"{src}: run has no temperature/cloud/wind arrays; reprocess it first")
        lats, lons = z["lats"], z["lons"]
        dst = out / "runs" / meta["run_id"]
        enc = {
            "cum.bin": {**_write(dst / "cum.bin", z["cumulative_mm"], "<f4"), "scale": 1},
            "interval.bin": {**_write(dst / "interval.bin", z["interval_mm"], "<f4"), "scale": 1},
            # Quantised to display precision (API rounds the same fields to 0.1 degC, 1 %, 0.1 m/s).
            "temp.bin": {**_write(dst / "temp.bin", np.rint(z["temp_c"] * 10), "<i2"), "scale": 10},
            "cloud.bin": {**_write(dst / "cloud.bin", np.rint(z["cloud_pct"]), "u1"), "scale": 1},
            "u.bin": {**_write(dst / "u.bin", np.rint(z["u10"] * 100), "<i2"), "scale": 100},
            "v.bin": {**_write(dst / "v.bin", np.rint(z["v10"] * 100), "<i2"), "scale": 100},
        }
    meta = {k: v for k, v in meta.items() if k != "raw_sha256"}
    meta.update(lats=[round(float(x), 4) for x in lats], lons=[round(float(x), 4) for x in lons],
                encodings=enc, format=FORMAT_VERSION)
    if (src / "world.npz").exists() and "world" in meta:        # coarse 2 deg global overview (world.py)
        with np.load(src / "world.npz") as w:
            wd = dst / "world"
            wenc = {
                "cum.bin": {**_write(wd / "cum.bin", w["cumulative_mm"], "<f4"), "scale": 1},
                "interval.bin": {**_write(wd / "interval.bin", w["interval_mm"], "<f4"), "scale": 1},
                "temp.bin": {**_write(wd / "temp.bin", np.rint(w["temp_c"] * 10), "<i2"), "scale": 10},
                "cloud.bin": {**_write(wd / "cloud.bin", np.rint(w["cloud_pct"]), "u1"), "scale": 1},
                "u.bin": {**_write(wd / "u.bin", np.rint(w["u10"] * 100), "<i2"), "scale": 100},
                "v.bin": {**_write(wd / "v.bin", np.rint(w["v10"] * 100), "<i2"), "scale": 100},
            }
            meta["world"].update(lats=[round(float(x), 4) for x in w["lats"]], lons=[round(float(x), 4) for x in w["lons"]],
                                 encodings=wenc)
    (dst / "meta.json").write_text(json.dumps(meta, separators=(",", ":")))
    return meta


def export_prob(src: Path, out: Path) -> dict:
    """Export one processed ENS probability run directory."""
    meta = json.loads((src / "meta.json").read_text())
    with np.load(src / "arrays.npz") as z:
        dst = out / "prob" / meta["run_id"]
        enc = {"prob.bin": {**_write(dst / "prob.bin", z["prob"], "<u2"), "scale": meta["scale"]}}
        lats, lons = z["lats"], z["lons"]
    meta = {k: v for k, v in meta.items() if k != "raw_sha256"}
    meta.update(lats=[round(float(x), 4) for x in lats], lons=[round(float(x), 4) for x in lons],
                encodings=enc, format=FORMAT_VERSION)
    (dst / "meta.json").write_text(json.dumps(meta, separators=(",", ":")))
    return meta


def export_all(run_dirs: list[Path], prob_dirs: list[Path], out: Path, keep: int = 2, scheduled: bool = False,
               refresh_minutes: int | None = None) -> dict:
    """Export the newest `keep` runs of each kind and write index.json. Older exported runs are removed."""
    out.mkdir(parents=True, exist_ok=True)
    runs = [export_run(d, out) for d in run_dirs[:keep]]
    probs = [export_prob(d, out) for d in prob_dirs[:keep]]
    for kind, metas in (("runs", runs), ("prob", probs)):
        keep_ids = {m["run_id"] for m in metas}
        base = out / kind
        if base.is_dir():
            for d in base.iterdir():
                if d.is_dir() and d.name not in keep_ids:
                    shutil.rmtree(d)
    index = {
        "format": FORMAT_VERSION,
        "generated_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "scheduled_refresh": scheduled, "refresh_minutes": refresh_minutes,
        "runs": [{"run_id": m["run_id"], "issue_time_utc": m["issue_time_utc"], "published_at_utc": m.get("published_at_utc"),
                  "max_step_h": m["steps_h"][-1]} for m in runs],
        "probability": [{"run_id": m["run_id"], "issue_time_utc": m["issue_time_utc"], "published_at_utc": m.get("published_at_utc")} for m in probs],
    }
    (out / "index.json").write_text(json.dumps(index, indent=1))
    total = sum(f.stat().st_size for f in out.rglob("*") if f.is_file())
    log.info("exported %d run(s) + %d probability run(s) to %s (%.1f MB raw)", len(runs), len(probs), out, total / 1e6)
    return index


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--source", choices=["processed", "snapshot"], default="processed")
    ap.add_argument("--keep", type=int, default=2)
    ap.add_argument("--scheduled", action="store_true", help="mark the site as refreshed by a schedule")
    ap.add_argument("--refresh-minutes", type=int)
    a = ap.parse_args()
    if a.source == "processed":
        runs, probs = _run_dirs(config.PROCESSED_DIR), _run_dirs(config.PROCESSED_ENS_DIR)
    else:
        runs, probs = _run_dirs(config.SNAPSHOT_DIR), _run_dirs(config.SNAPSHOT_ENS_DIR)
    if not runs:
        raise SystemExit("no processed runs to export")
    export_all(runs, probs, a.out, a.keep, a.scheduled, a.refresh_minutes)


if __name__ == "__main__":
    main()
