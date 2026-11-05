"""Build the data folder of the LIVE static site (Vercel), reusing whatever the last publish already has.

Run by the scheduled GitHub Action (.github/workflows/publish-static.yml), but fully testable locally:

    PRECIP_DATA_DIR=<scratch> python -m precip.live_static --out <site-data-dir> [--previous <published-data-dir>] [--force]

Steps
  1. Ask ECMWF for the newest complete deterministic run and the newest ENS probability run.
  2. If the previously published site (--previous, a copy of its data/ folder) already has both: print
     `changed=false` and stop (nothing is downloaded, nothing needs publishing).
  3. Otherwise download/process only the new run(s), export them, and CARRY OVER the previous run(s) from the
     previously published files (so the run comparison keeps working without re-downloading ~130 MB).
  4. Write index.json with scheduled_refresh=true and print `changed=true`.
A failure to fetch one kind (e.g. probabilities not published yet) never blocks the other: the previous
files of that kind are carried over instead.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import shutil
from pathlib import Path

from . import config, ens, export_static, store, store_ens
from .fetch import fetch_run, find_latest_complete_run
from .process import process_run

log = logging.getLogger("precip.live_static")
KEEP = 2  # runs kept per kind (latest + previous, for the comparison view)


def read_index(data_dir: Path | None) -> dict:
    if data_dir and (data_dir / "index.json").exists():
        return json.loads((data_dir / "index.json").read_text())
    return {"runs": [], "probability": []}


def carry_over(prev: Path, out: Path, kind: str, wanted_ids: list[str]) -> None:
    """Copy previously published run directories (kind = 'runs' or 'prob') that the new export lacks."""
    for rid in wanted_ids:
        src, dst = prev / kind / rid, out / kind / rid
        if src.is_dir() and not dst.exists():
            shutil.copytree(src, dst)
            log.info("carried over %s/%s from the previous publish", kind, rid)


def build(out: Path, previous: Path | None, force: bool = False, scheduled_minutes: int = 30) -> bool:
    """Returns True if the site data changed (and was written to `out`)."""
    prev_index = read_index(previous)
    prev_runs = [r["run_id"] for r in prev_index.get("runs", [])]
    prev_probs = [r["run_id"] for r in prev_index.get("probability", [])]

    latest = find_latest_complete_run()
    latest_ens = None
    try:
        latest_ens = ens.find_latest_ens_run()
    except Exception:  # noqa: BLE001 - probabilities are an add-on
        log.exception("could not check for an ENS probability run")

    need_det = latest.run_id not in prev_runs
    need_ens = latest_ens is not None and latest_ens.run_id not in prev_probs
    log.info("latest deterministic run %s (%s), latest ENS run %s (%s)", latest.run_id, "NEW" if need_det else "already published",
             latest_ens.run_id if latest_ens else None, "NEW" if need_ens else "already published or none")
    if not (need_det or need_ens or force):
        return False

    # ---- process only what is new -------------------------------------------------------------
    if need_det or force:
        fetch_run(latest)
        process_run(latest)
    if (need_ens or force) and latest_ens is not None:
        try:
            ens.fetch_ens_run(latest_ens)
            ens.process_ens_run(latest_ens)
        except Exception:  # noqa: BLE001
            log.exception("ENS probability processing failed; keeping the previously published probabilities")

    run_dirs = [config.PROCESSED_DIR / latest.run_id] if (config.PROCESSED_DIR / latest.run_id / "meta.json").exists() else []
    prob_dirs: list[Path] = []
    if latest_ens is not None:  # may be None: nothing published yet, or the check failed
        d = config.PROCESSED_ENS_DIR / latest_ens.run_id
        if (d / "meta.json").exists():
            prob_dirs.append(d)
    if not run_dirs:
        raise SystemExit("deterministic run could not be processed; not publishing")

    # new exports first, then top up with the previous publish up to KEEP of each kind
    export_static.export_all(run_dirs, prob_dirs, out, keep=KEEP, scheduled=True, refresh_minutes=scheduled_minutes, world50=True)
    if previous:
        carry_over(previous, out, "runs", prev_runs[: KEEP])
        carry_over(previous, out, "prob", prev_probs[: KEEP])

    # rebuild index.json from the directories now present (newest first, at most KEEP of each kind)
    def entries(kind: str) -> list[dict]:
        found = []
        for d in (out / kind).glob("??????????") if (out / kind).is_dir() else []:
            m = json.loads((d / "meta.json").read_text())
            found.append({"run_id": m["run_id"], "issue_time_utc": m["issue_time_utc"], "published_at_utc": m.get("published_at_utc"),
                          **({"max_step_h": m["steps_h"][-1]} if "steps_h" in m else {})})
        return sorted(found, key=lambda e: e["issue_time_utc"], reverse=True)[:KEEP]

    runs, probs = entries("runs"), entries("prob")
    # keep the big 0.5 deg world files for the newest run only (carried-over older runs would double the site size)
    for e in runs[1:]:
        d = out / "runs" / e["run_id"]
        if (d / "w50").is_dir():
            shutil.rmtree(d / "w50")
            m = json.loads((d / "meta.json").read_text())
            m.pop("world50", None)
            (d / "meta.json").write_text(json.dumps(m, separators=(",", ":")))
    for kind, keep_ids in (("runs", {e["run_id"] for e in runs}), ("prob", {e["run_id"] for e in probs})):
        if (out / kind).is_dir():
            for d in (out / kind).iterdir():
                if d.is_dir() and d.name not in keep_ids:
                    shutil.rmtree(d)
    index = json.loads((out / "index.json").read_text())
    index.update(runs=runs, probability=probs)
    (out / "index.json").write_text(json.dumps(index, indent=1))
    log.info("site data written: runs=%s probability=%s", [r["run_id"] for r in runs], [p["run_id"] for p in probs])
    return True


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True, type=Path, help="directory to write the static data into")
    ap.add_argument("--previous", type=Path, help="data/ folder of the previously published site (optional)")
    ap.add_argument("--force", action="store_true", help="rebuild even if nothing is new")
    a = ap.parse_args()
    changed = build(a.out, a.previous, a.force)
    print(f"changed={'true' if changed else 'false'}")
    gh = os.environ.get("GITHUB_OUTPUT")
    if gh:
        with open(gh, "a", encoding="utf-8") as fh:
            fh.write(f"changed={'true' if changed else 'false'}\n")


if __name__ == "__main__":
    main()
