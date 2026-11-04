"""Official ECMWF ensemble (ENS) precipitation PROBABILITY products ("type=ep", params tpg1..tpg100).

These are ECMWF's own numbers: each message is "Total precipitation of at least X mm" in per cent,
accumulated over a 24 h window. They are computed by ECMWF from its ensemble forecast; this project does
not estimate any probability itself. Verified on the 2026-11-04 00 UTC run (docs/DATA_NOTES.md):
  * productDefinitionTemplateNumber 9, probabilityType 3 (above the lower limit), lowerLimit = X mm,
    units "%", stepType accum, lengthOfTimeRange 24, 0.25 deg regular grid, 12 bits/value, no bitmap;
  * 24 h windows start every 12 h ("0-24", "12-36", ...), thresholds 1, 5, 10, 20, 25, 50, 100 mm;
  * published only for the 00 and 12 UTC runs (the 06/18 UTC runs have no `ep` files), about 8 h after
    issue time (Last-Modified 08:01 / 20:01 UTC on 2026-11-03/04).
Because it comes from a different (ensemble) system and only twice a day, its run can be older than the
deterministic run shown on the map; the UI always states each run's issue time.

Usage:  python -m precip.ens [--date YYYYMMDD --hour 0|12]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import shutil
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

import eccodes as ec
import numpy as np
import requests

from . import config
from .fetch import _get, _valid_grib
from .process import crop_region

log = logging.getLogger("precip.ens")

WINDOW_HOURS = 24
WINDOW_STARTS = tuple(range(0, config.ENS_MAX_END_H - WINDOW_HOURS + 1, 12))  # 0, 12, ..., 120
WINDOWS = tuple((s, s + WINDOW_HOURS) for s in WINDOW_STARTS)                  # (0,24) ... (120,144)
SCALE = 10  # stored as uint16 tenths of a per cent (source resolution is ~0.024 % at 12 bits)
# Higher thresholds can never be more likely than lower ones; allow this much packing slack (per cent).
MONOTONIC_TOLERANCE_PCT = 0.5


@dataclass(frozen=True)
class EnsRun:
    date: str  # YYYYMMDD
    hour: int  # 0 or 12

    @property
    def run_id(self) -> str:
        return f"{self.date}{self.hour:02d}"

    @property
    def issue_time(self) -> datetime:
        return datetime.strptime(self.date, "%Y%m%d").replace(hour=self.hour, tzinfo=timezone.utc)


def _url(run: EnsRun, ext: str) -> str:
    stamp = f"{run.date}{run.hour:02d}0000"
    return (f"{config.BASE_URL}/{run.date}/{run.hour:02d}z/{config.MODEL}/{config.RESOL}/{config.ENS_STREAM}/"
            f"{stamp}-{config.ENS_FILE_END_H}h-{config.ENS_STREAM}-{config.ENS_TYPE}.{ext}")


def raw_path(run: EnsRun, thr: int, window: tuple[int, int]) -> Path:
    return config.RAW_DIR / "ens" / run.run_id / f"tpg{thr}_{window[0]}-{window[1]}.grib2"


def wanted_records(run: EnsRun) -> dict[tuple[int, tuple[int, int]], dict] | None:
    """Index records for every (threshold, window) we need, or None if the file is not published yet.
    Exactly one record per pair is required; anything else is an error, not something to guess around."""
    r = _get(_url(run, "index"))
    if r.status_code == 404:
        return None
    recs = [json.loads(line) for line in r.text.splitlines() if line.strip()]
    out: dict[tuple[int, tuple[int, int]], dict] = {}
    for thr in config.ENS_THRESHOLDS_MM:
        for w in WINDOWS:
            hits = [x for x in recs if x.get("param") == f"tpg{thr}" and x.get("step") == f"{w[0]}-{w[1]}"
                    and x.get("levtype") == "sfc"]
            if len(hits) != 1:
                raise RuntimeError(f"expected one tpg{thr} record for window {w[0]}-{w[1]}, got {len(hits)}")
            out[(thr, w)] = hits[0]
    return out


def find_latest_ens_run(now: datetime | None = None) -> EnsRun | None:
    """Newest 00/12 UTC run whose probability file is published (None if none of the last 6 is)."""
    now = now or datetime.now(timezone.utc)
    t = now.replace(minute=0, second=0, microsecond=0)
    t -= timedelta(hours=t.hour % 12)
    for k in range(6):
        slot = t - timedelta(hours=12 * k)
        run = EnsRun(slot.strftime("%Y%m%d"), slot.hour)
        try:
            if wanted_records(run) is not None:
                return run
        except RuntimeError as e:
            log.warning("ENS run %s check failed: %s", run.run_id, e)
    return None


def published_at(run: EnsRun) -> datetime | None:
    try:
        r = requests.head(_url(run, "grib2"), timeout=config.HTTP_TIMEOUT_S)
        lm = r.headers.get("Last-Modified")
        return parsedate_to_datetime(lm).astimezone(timezone.utc) if r.ok and lm else None
    except (requests.RequestException, TypeError, ValueError):
        return None


def _fetch_one(run: EnsRun, thr: int, w: tuple[int, int], rec: dict) -> Path:
    off, length = int(rec["_offset"]), int(rec["_length"])
    dest = raw_path(run, thr, w)
    if dest.exists() and _valid_grib(dest.read_bytes(), length):
        return dest
    r = _get(_url(run, "grib2"), headers={"Range": f"bytes={off}-{off + length - 1}"})
    if r.status_code != 206 or not _valid_grib(r.content, length):
        raise RuntimeError(f"incomplete/invalid tpg{thr} {w[0]}-{w[1]} message (status {r.status_code}, "
                           f"{len(r.content)} of {length} bytes)")
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".part")
    tmp.write_bytes(r.content)
    tmp.replace(dest)
    return dest


def fetch_ens_run(run: EnsRun) -> list[Path]:
    recs = wanted_records(run)
    if recs is None:
        raise FileNotFoundError(f"ENS probability file for {run.run_id} is not published")
    with ThreadPoolExecutor(max_workers=6) as pool:
        paths = list(pool.map(lambda kv: _fetch_one(run, kv[0][0], kv[0][1], kv[1]), recs.items()))
    log.info("ENS run %s: %d messages, %.1f MB", run.run_id, len(paths), sum(p.stat().st_size for p in paths) / 1e6)
    return paths


def read_prob_field(path: Path, run: EnsRun, thr: int, w: tuple[int, int]):
    """Decode one probability message and verify every property we rely on."""
    with open(path, "rb") as fh:
        if ec.codes_count_in_file(fh) != 1:
            raise ValueError(f"{path}: expected exactly one GRIB message")
        fh.seek(0)
        g = ec.codes_grib_new_from_file(fh)
        try:
            get = lambda k: ec.codes_get(g, k)  # noqa: E731
            checks = {
                "shortName": (get("shortName"), f"tpg{thr}"),
                "units": (get("units"), "%"),
                "productDefinitionTemplateNumber": (get("productDefinitionTemplateNumber"), 9),  # probability forecast
                "probabilityType": (get("probabilityType"), 3),                                   # above the lower limit
                "stepRange": (get("stepRange"), f"{w[0]}-{w[1]}"),
                "lengthOfTimeRange": (get("lengthOfTimeRange"), WINDOW_HOURS),
                "gridType": (get("gridType"), "regular_ll"),
                "bitmapPresent": (get("bitmapPresent"), 0),
                "dataDate": (str(get("dataDate")), run.date),
                "dataTime": (int(get("dataTime")), run.hour * 100),
            }
            for key, (got, want) in checks.items():
                if got != want:
                    raise ValueError(f"{path}: {key} is {got!r}, expected {want!r}")
            lower = get("scaledValueOfLowerLimit") / 10.0 ** get("scaleFactorOfLowerLimit")
            if abs(lower - thr) > 1e-9:
                raise ValueError(f"{path}: lower limit {lower} mm does not match threshold {thr} mm")
            if get("jScansPositively"):
                raise ValueError(f"{path}: south-to-north scan not supported")
            nj, ni = get("Nj"), get("Ni")
            vals = ec.codes_get_values(g).reshape(nj, ni).astype(np.float64)
            lats = get("latitudeOfFirstGridPointInDegrees") - get("jDirectionIncrementInDegrees") * np.arange(nj)
            lons = (get("longitudeOfFirstGridPointInDegrees") + get("iDirectionIncrementInDegrees") * np.arange(ni)) % 360.0
        finally:
            ec.codes_release(g)
    if not np.all(np.isfinite(vals)) or vals.min() < -0.1 or vals.max() > 100.1:
        raise ValueError(f"{path}: probabilities {vals.min():.2f}..{vals.max():.2f} % outside 0..100")
    return np.clip(vals, 0.0, 100.0), lats, lons


def process_ens_run(run: EnsRun, out_root: Path | None = None) -> Path:
    out_root = out_root or config.PROCESSED_ENS_DIR
    thrs = config.ENS_THRESHOLDS_MM
    cube = None
    lats = lons = None
    for wi, w in enumerate(WINDOWS):
        for ti, thr in enumerate(thrs):
            vals, la, lo = read_prob_field(raw_path(run, thr, w), run, thr, w)
            reg, lats, lons = crop_region(vals, la, lo)
            if cube is None:
                cube = np.zeros((len(WINDOWS), len(thrs), *reg.shape), dtype=np.uint16)
            cube[wi, ti] = np.rint(reg * SCALE).astype(np.uint16)
    assert cube is not None
    # Consistency check: P(>= larger amount) can never exceed P(>= smaller amount) for the same window.
    worst = 0.0
    for ti in range(1, len(thrs)):
        diff = (cube[:, ti].astype(np.int32) - cube[:, ti - 1].astype(np.int32)) / SCALE
        worst = max(worst, float(diff.max()))
    if worst > MONOTONIC_TOLERANCE_PCT:
        raise ValueError(f"probabilities not monotonic in threshold: worst excess {worst:.2f} % > {MONOTONIC_TOLERANCE_PCT} %")

    issue = run.issue_time
    pub = published_at(run)
    iso = lambda d: d.isoformat().replace("+00:00", "Z")  # noqa: E731
    meta = {
        "run_id": run.run_id,
        "product": "ECMWF ENS probability of total precipitation >= threshold over 24 h (type=ep, tpg*)",
        "source": config.BASE_URL,
        "issue_time_utc": iso(issue),
        "published_at_utc": iso(pub) if pub else None,
        "processed_at_utc": iso(datetime.now(timezone.utc).replace(microsecond=0)),
        "thresholds_mm": list(thrs),
        "windows": [{"start_h": s, "end_h": e, "start_utc": iso(issue + timedelta(hours=s)),
                     "end_utc": iso(issue + timedelta(hours=e))} for s, e in WINDOWS],
        "units": "%",
        "scale": SCALE,
        "domain": {"lat_min": float(lats.min()), "lat_max": float(lats.max()),
                   "lon_min": float(lons.min()), "lon_max": float(lons.max())},
        "grid": {"n_lat": int(lats.size), "n_lon": int(lons.size), "spacing_deg": 0.25},
        "quality": {"worst_monotonic_excess_pct": round(worst, 3), "max_probability_pct": round(float(cube.max()) / SCALE, 1)},
        "semantics": ("Probability, computed by ECMWF from its ensemble forecast, that total precipitation over the "
                      "24 h window reaches the threshold. Not computed by this project and not a calibrated "
                      "real-world frequency."),
        "raw_sha256": {f"tpg{t}_{w[0]}-{w[1]}": hashlib.sha256(raw_path(run, t, w).read_bytes()).hexdigest()
                       for w in WINDOWS for t in thrs},
    }
    final = out_root / run.run_id
    tmp = out_root / f".{run.run_id}.tmp"
    if tmp.exists():
        shutil.rmtree(tmp)
    tmp.mkdir(parents=True)
    np.savez_compressed(tmp / "arrays.npz", lats=lats.astype(np.float32), lons=lons.astype(np.float32), prob=cube)
    (tmp / "meta.json").write_text(json.dumps(meta, indent=1))
    if final.exists():
        shutil.rmtree(final)
    tmp.replace(final)
    log.info("processed ENS %s -> %s (max %.1f %%, monotonic excess %.3f %%)", run.run_id, final,
             float(cube.max()) / SCALE, worst)
    return final


def prune_ens(keep: int = config.ENS_KEEP_RUNS) -> None:
    if config.PROCESSED_ENS_DIR.exists():
        runs = sorted(p for p in config.PROCESSED_ENS_DIR.glob("??????????") if (p / "meta.json").exists())
        for old in runs[:-keep]:
            shutil.rmtree(old)
    raw = config.RAW_DIR / "ens"
    if raw.exists():
        for old in sorted(raw.glob("??????????"))[:-keep]:
            shutil.rmtree(old)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--date")
    ap.add_argument("--hour", type=int, choices=[0, 12])
    a = ap.parse_args()
    run = EnsRun(a.date, a.hour) if a.date and a.hour is not None else find_latest_ens_run()
    if run is None:
        raise SystemExit("no ENS probability run is published yet")
    fetch_ens_run(run)
    process_ens_run(run)
    prune_ens()


if __name__ == "__main__":
    main()
