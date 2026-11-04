"""Data retrieval: download only the `tp` GRIB message for each forecast step.

Why this works (verified against the live server on 2026-11-04):
  * every `<stamp>-<step>h-oper-fc.grib2` has a sibling `.index` file (JSON lines)
    listing `_offset` and `_length` for each field;
  * the server honours HTTP Range requests (206), so a single `tp` field (~0.4 MB)
    can be fetched instead of the whole 57-100 MB file. This is a genuine
    reduction in transferred bytes, not just post-download cropping.

Usage:  python -m precip.fetch [--date YYYYMMDD --hour 0|6|12|18]
"""
from __future__ import annotations

import argparse
import json
import logging
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

from . import config

log = logging.getLogger("precip.fetch")


@dataclass(frozen=True)
class Run:
    """A model run (forecast issue time, UTC)."""
    date: str  # YYYYMMDD
    hour: int  # 0, 6, 12, 18

    @property
    def issue_time(self) -> datetime:
        return datetime.strptime(self.date, "%Y%m%d").replace(hour=self.hour, tzinfo=timezone.utc)

    @property
    def run_id(self) -> str:
        return f"{self.date}{self.hour:02d}"

    @property
    def max_step(self) -> int:
        # 00/12 UTC: 3-hourly to 144 h (we cap at config.MAX_STEP_H).
        # 06/18 UTC: 3-hourly only to 90 h (ECMWF Open Data documentation).
        return min(config.MAX_STEP_H, 144 if self.hour in (0, 12) else 90)

    @property
    def steps(self) -> list[int]:
        return list(range(0, self.max_step + 1, 3))


def _url(run: Run, step: int, ext: str) -> str:
    stamp = f"{run.date}{run.hour:02d}0000"
    return (f"{config.BASE_URL}/{run.date}/{run.hour:02d}z/{config.MODEL}/{config.RESOL}/"
            f"{config.STREAM}/{stamp}-{step}h-{config.STREAM}-{config.TYPE}.{ext}")


def _get(url: str, headers: dict | None = None, retries: int = 4) -> requests.Response:
    """GET with exponential backoff for transient failures. 404 is returned, not retried."""
    last: Exception | None = None
    for attempt in range(retries):
        try:
            r = requests.get(url, headers=headers, timeout=config.HTTP_TIMEOUT_S)
            if r.status_code == 404 or r.ok:
                return r
            last = RuntimeError(f"HTTP {r.status_code} for {url}")
        except requests.RequestException as e:
            last = e
        time.sleep(2 ** attempt)
    raise RuntimeError(f"giving up on {url}: {last}")


def tp_record(run: Run, step: int) -> dict | None:
    """Return the index record for `tp` at `step`, or None if the step is not (yet) published."""
    r = _get(_url(run, step, "index"))
    if r.status_code == 404:
        return None
    recs = [json.loads(line) for line in r.text.splitlines() if line.strip()]
    hits = [x for x in recs if x.get("param") == "tp" and int(x.get("step", -1)) == step
            and x.get("levtype") == "sfc"]
    if len(hits) != 1:
        raise RuntimeError(f"expected exactly one tp record for step {step}, got {len(hits)}")
    return hits[0]


def run_is_complete(run: Run) -> bool:
    """A run is usable when the index of its final step exists (steps publish in order)."""
    return tp_record(run, run.max_step) is not None


def find_latest_complete_run(now: datetime | None = None) -> Run:
    """Walk back through recent runs until one is complete (handles in-progress uploads)."""
    now = now or datetime.now(timezone.utc)
    base = now.replace(minute=0, second=0, microsecond=0)
    base -= timedelta(hours=base.hour % 6)
    for k in range(12):  # server keeps ~12 runs
        t = base - timedelta(hours=6 * k)
        run = Run(t.strftime("%Y%m%d"), t.hour)
        try:
            if run_is_complete(run):
                return run
        except RuntimeError as e:
            log.warning("run %s check failed: %s", run.run_id, e)
    raise RuntimeError("no complete run found in the last 12 runs")


def raw_path(run: Run, step: int) -> Path:
    return config.RAW_DIR / config.MODEL / run.run_id / f"tp_{step:03d}.grib2"


def _valid_grib(data: bytes, expected_len: int) -> bool:
    """A single complete GRIB2 message: right length, 'GRIB' header, '7777' trailer."""
    return len(data) == expected_len and data[:4] == b"GRIB" and data[-4:] == b"7777"


def fetch_step(run: Run, step: int) -> Path:
    """Download one tp message (idempotent; atomic write; validates completeness)."""
    rec = tp_record(run, step)
    if rec is None:
        raise FileNotFoundError(f"step {step} not published for run {run.run_id}")
    off, length = int(rec["_offset"]), int(rec["_length"])
    dest = raw_path(run, step)
    if dest.exists() and _valid_grib(dest.read_bytes(), length):
        return dest
    r = _get(_url(run, step, "grib2"), headers={"Range": f"bytes={off}-{off + length - 1}"})
    if r.status_code != 206 or not _valid_grib(r.content, length):
        raise RuntimeError(f"incomplete/invalid tp message for step {step} "
                           f"(status {r.status_code}, {len(r.content)} of {length} bytes)")
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".part")
    tmp.write_bytes(r.content)
    tmp.replace(dest)  # atomic: a half-written file never carries the final name
    return dest


def fetch_run(run: Run) -> list[Path]:
    # 4 parallel requests: a sequential run took ~190 s on 2026-11-04 (2 HTTP calls per step).
    # Kept small to stay polite to the public server; map() preserves step order and re-raises errors.
    with ThreadPoolExecutor(max_workers=4) as pool:
        paths = list(pool.map(lambda s: fetch_step(run, s), run.steps))
    log.info("run %s: %d tp messages, %.1f MB", run.run_id, len(paths),
             sum(p.stat().st_size for p in paths) / 1e6)
    return paths


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--date")
    ap.add_argument("--hour", type=int, choices=[0, 6, 12, 18])
    a = ap.parse_args()
    run = Run(a.date, a.hour) if a.date and a.hour is not None else find_latest_complete_run()
    log.info("fetching run %s (%d steps)", run.run_id, len(run.steps))
    fetch_run(run)


if __name__ == "__main__":
    main()
