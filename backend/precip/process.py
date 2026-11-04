"""Scientific processing: GRIB `tp` messages -> regional, interval-aware arrays.

Key scientific decisions (see docs/DATA_NOTES.md for the evidence):
  * IFS `tp` is cumulative since forecast start (stepType=accum, stepRange=0-N), in metres.
    Units are read from each message and converted explicitly; unknown units raise.
  * Interval totals are differences of consecutive cumulative fields, using the actual
    step numbers (so unequal spacing is handled; durations are stored, not assumed).
  * GRIB simple packing makes each stored value a multiple of its message's quantum q.
    A difference of two fields can therefore be negative by up to (q_prev+q_cur)/2 even
    though true accumulation never decreases. Such negatives are set to 0 and COUNTED;
    larger negatives indicate a possible accumulation reset or a misread field and raise.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import shutil
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

import eccodes as ec
import numpy as np

from . import config
from .fetch import Run, fetch_run, find_latest_complete_run, raw_path

log = logging.getLogger("precip.process")

# Multiplier from GRIB units to millimetres of water (1 mm == 1 kg m-2).
_UNIT_TO_MM = {"m": 1000.0, "kg m**-2": 1.0}


@dataclass
class TpField:
    """One decoded tp message on its native grid (lat descending, lon in file order)."""
    values_native: np.ndarray  # shape (nlat, nlon), native units
    units: str
    step: int
    quantum_native: float      # GRIB packing resolution, native units
    lats: np.ndarray           # descending, degrees north
    lons: np.ndarray           # file order, degrees east in [0, 360)
    data_date: str
    data_time: int


def read_tp(path: Path) -> TpField:
    """Decode one message and verify it is what we think it is."""
    with open(path, "rb") as fh:
        if ec.codes_count_in_file(fh) != 1:
            raise ValueError(f"{path}: expected exactly one GRIB message")
        fh.seek(0)
        g = ec.codes_grib_new_from_file(fh)
        try:
            get = lambda k: ec.codes_get(g, k)  # noqa: E731
            if get("shortName") != "tp":
                raise ValueError(f"{path}: not tp (got {get('shortName')})")
            if get("stepType") != "accum" or get("startStep") != 0:
                raise ValueError(f"{path}: tp is not accumulated from forecast start "
                                 f"(stepType={get('stepType')}, startStep={get('startStep')})")
            if get("gridType") != "regular_ll":
                raise ValueError(f"{path}: unsupported grid {get('gridType')}")
            if get("bitmapPresent"):
                raise ValueError(f"{path}: bitmap present; missing-value handling not implemented")
            nj, ni = get("Nj"), get("Ni")
            dlat, dlon = get("jDirectionIncrementInDegrees"), get("iDirectionIncrementInDegrees")
            lat0, lon0 = get("latitudeOfFirstGridPointInDegrees"), get("longitudeOfFirstGridPointInDegrees")
            if get("jScansPositively"):
                raise ValueError(f"{path}: south-to-north scan not supported")
            vals = ec.codes_get_values(g).reshape(nj, ni).astype(np.float64)
            if not np.all(np.isfinite(vals)):
                raise ValueError(f"{path}: non-finite values")
            return TpField(
                values_native=vals,
                units=get("units"),
                step=int(get("endStep")),
                quantum_native=2.0 ** get("binaryScaleFactor") / 10.0 ** get("decimalScaleFactor"),
                lats=lat0 - dlat * np.arange(nj),
                lons=(lon0 + dlon * np.arange(ni)) % 360.0,
                data_date=str(get("dataDate")),
                data_time=int(get("dataTime")),
            )
        finally:
            ec.codes_release(g)


def unit_factor_to_mm(units: str) -> float:
    try:
        return _UNIT_TO_MM[units]
    except KeyError:
        raise ValueError(f"unknown tp units {units!r}; refusing to guess a conversion") from None


def crop_region(values: np.ndarray, lats: np.ndarray, lons: np.ndarray):
    """Crop to the configured box. Longitudes are sorted first because the file starts at 180E
    and wraps; cropping without sorting would mix the two halves of the globe."""
    order = np.argsort(lons)
    lons_s, values = lons[order], values[:, order]
    rows = np.where((lats >= config.LAT_MIN) & (lats <= config.LAT_MAX))[0]
    cols = np.where((lons_s >= config.LON_MIN) & (lons_s <= config.LON_MAX))[0]
    lat_out = lats[rows]
    if lat_out[0] < lat_out[-1]:  # ensure north -> south
        raise ValueError("latitudes unexpectedly ascending")
    return values[np.ix_(rows, cols)], lat_out, lons_s[cols]


def intervals_from_cumulative(cum_mm: np.ndarray, steps: list[int], quanta_mm: list[float]):
    """Differences of consecutive cumulative fields -> interval totals (mm).

    cum_mm: (nsteps, nlat, nlon); steps[0] must be 0 and cum_mm[0] must be all zero.
    Returns (intervals (nsteps-1, nlat, nlon), durations_h, stats dict).
    """
    if steps[0] != 0 or not np.all(cum_mm[0] == 0):
        raise ValueError("first step must be 0 with zero accumulation")
    if any(b <= a for a, b in zip(steps, steps[1:])):
        raise ValueError(f"steps must be strictly increasing: {steps}")
    diff = np.diff(cum_mm, axis=0)
    out = np.empty_like(diff)
    n_noise, worst_noise = 0, 0.0
    for i in range(diff.shape[0]):
        tol = (quanta_mm[i] + quanta_mm[i + 1]) / 2.0 + 1e-9
        d = diff[i]
        neg = d < 0
        if neg.any():
            worst = float(d.min())
            if worst < -tol:
                raise ValueError(
                    f"step {steps[i]}->{steps[i+1]}: negative difference {worst:.4g} mm exceeds the "
                    f"packing tolerance {tol:.4g} mm; possible accumulation reset or bad field")
            n_noise += int(neg.sum())
            worst_noise = min(worst_noise, worst)
            d = np.where(neg, 0.0, d)
        out[i] = d
    durations = np.diff(np.asarray(steps)).astype(int)
    return out, durations, {"packing_noise_cells_zeroed": n_noise,
                            "worst_packing_noise_mm": round(worst_noise, 5)}


def process_run(run: Run, out_root: Path | None = None) -> Path:
    """Process all downloaded tp messages of `run` into data/processed/<run_id>/."""
    out_root = out_root or config.PROCESSED_DIR
    fields = [read_tp(raw_path(run, s)) for s in run.steps]
    for f, s in zip(fields, run.steps):
        if f.step != s:
            raise ValueError(f"step mismatch: file for {s} says {f.step}")
        if (f.data_date, f.data_time) != (run.date, run.hour * 100):
            raise ValueError(f"issue time mismatch in step {s}: {f.data_date} {f.data_time}")
    units = {f.units for f in fields}
    if len(units) != 1:
        raise ValueError(f"mixed units across steps: {units}")
    factor = unit_factor_to_mm(units.pop())

    cum, quanta = [], []
    for f in fields:
        reg, lats, lons = crop_region(f.values_native * factor, f.lats, f.lons)
        cum.append(reg)
        quanta.append(f.quantum_native * factor)
    cum_mm = np.stack(cum).astype(np.float32)
    intervals, durations, stats = intervals_from_cumulative(
        np.stack(cum), run.steps, quanta)

    issue = run.issue_time
    steps = run.steps
    meta = {
        "run_id": run.run_id,
        "model": "ECMWF IFS HRES (oper/fc)",
        "resolution_deg": 0.25,
        "source": config.BASE_URL,
        "issue_time_utc": issue.isoformat().replace("+00:00", "Z"),
        "processed_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "variable": "tp (total precipitation)",
        "source_units": "m (converted x1000 to mm)",
        "steps_h": steps,
        "valid_times_utc": [(issue + timedelta(hours=s)).isoformat().replace("+00:00", "Z") for s in steps],
        "interval_durations_h": durations.tolist(),
        "domain": {"lat_min": float(lats.min()), "lat_max": float(lats.max()),
                   "lon_min": float(lons.min()), "lon_max": float(lons.max())},
        "grid": {"n_lat": int(lats.size), "n_lon": int(lons.size), "spacing_deg": 0.25},
        "quality": stats,
        "max_cumulative_mm": round(float(cum_mm.max()), 2),
        "max_interval_mm": round(float(intervals.max()), 2),
        "raw_sha256": {str(s): hashlib.sha256(raw_path(run, s).read_bytes()).hexdigest() for s in steps},
    }
    final = out_root / run.run_id
    tmp = out_root / f".{run.run_id}.tmp"
    if tmp.exists():
        shutil.rmtree(tmp)
    tmp.mkdir(parents=True)
    np.savez_compressed(tmp / "arrays.npz", lats=lats.astype(np.float32), lons=lons.astype(np.float32),
                        cumulative_mm=cum_mm, interval_mm=intervals.astype(np.float32))
    (tmp / "meta.json").write_text(json.dumps(meta, indent=1))
    if final.exists():
        shutil.rmtree(final)
    tmp.replace(final)  # publish only when complete
    log.info("processed %s -> %s (%s)", run.run_id, final, stats)
    return final


def prune(keep: int = config.KEEP_RUNS) -> None:
    runs = sorted(p for p in config.PROCESSED_DIR.glob("??????????") if (p / "meta.json").exists())
    for old in runs[:-keep]:
        shutil.rmtree(old)
        log.info("pruned %s", old.name)
    raw_runs = sorted((config.RAW_DIR / config.MODEL).glob("??????????")) if (config.RAW_DIR / config.MODEL).exists() else []
    for old in raw_runs[:-keep]:
        shutil.rmtree(old)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    ap = argparse.ArgumentParser(description="Fetch (if needed) and process an IFS run.")
    ap.add_argument("--date")
    ap.add_argument("--hour", type=int, choices=[0, 6, 12, 18])
    a = ap.parse_args()
    run = Run(a.date, a.hour) if a.date and a.hour is not None else find_latest_complete_run()
    fetch_run(run)
    process_run(run)
    prune()


if __name__ == "__main__":
    main()
