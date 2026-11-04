"""Background refresh, kept OUT of request handling.

Deployment constraints (verified from Render docs, 2026-11-04): free web services have an
ephemeral filesystem, spin down after 15 min without traffic, and cannot run cron jobs. So:
  1. on start, seed an empty disk from the committed dated snapshot (instant, never blank);
  2. a daemon thread then checks ECMWF for a newer complete run and processes it;
  3. it repeats every REFRESH_INTERVAL_S while the instance is awake.
While the service sleeps nothing refreshes; the first request after wake-up shows the snapshot
(clearly dated, flagged stale) until the thread finishes (~1 min). The UI reports this state.
"""
from __future__ import annotations

import logging
import shutil
import threading
from datetime import datetime, timezone

from . import config, store
from .fetch import Run, fetch_run, find_latest_complete_run
from .process import process_run, prune

log = logging.getLogger("precip.refresh")

_lock = threading.Lock()
_stop = threading.Event()
_state: dict = {"refreshing": False, "last_attempt_utc": None, "last_result": None, "last_error": None}


def status() -> dict:
    return {**_state, "auto_refresh": config.AUTO_REFRESH, "latest_run": (store.list_run_ids() or [None])[0]}


def seed_from_snapshot() -> int:
    """Copy snapshot runs into an empty processed dir. Never overwrites existing data."""
    if store.list_run_ids() or not config.SNAPSHOT_DIR.is_dir():
        return 0
    n = 0
    config.PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    for d in sorted(config.SNAPSHOT_DIR.iterdir()):
        if store.RUN_ID_RE.match(d.name) and (d / "meta.json").exists():
            shutil.copytree(d, config.PROCESSED_DIR / d.name)
            n += 1
    log.info("seeded %d run(s) from snapshot", n)
    return n


def refresh_once() -> str:
    """Fetch+process the newest complete run if we do not have it. Returns a short result string.
    Failures leave existing data untouched (processing publishes atomically)."""
    if not _lock.acquire(blocking=False):
        return "already_running"
    _state.update(refreshing=True, last_attempt_utc=datetime.now(timezone.utc).isoformat(timespec="seconds"))
    try:
        run: Run = find_latest_complete_run()
        if run.run_id in store.list_run_ids():
            result = "up_to_date"
        else:
            fetch_run(run)
            process_run(run)
            prune()
            if not config.KEEP_RAW:
                shutil.rmtree(config.RAW_DIR / config.MODEL / run.run_id, ignore_errors=True)
            result = f"updated_to_{run.run_id}"
        _state.update(last_result=result, last_error=None)
        return result
    except Exception as e:  # noqa: BLE001 - keep serving the old data whatever went wrong
        log.exception("refresh failed")
        _state.update(last_result="failed", last_error=f"{type(e).__name__}: {e}"[:300])
        return "failed"
    finally:
        _state["refreshing"] = False
        _lock.release()


def _loop() -> None:
    while True:
        refresh_once()
        if _stop.wait(config.REFRESH_INTERVAL_S):
            return


def start() -> None:
    """Called once at app startup when PRECIP_AUTO_REFRESH=1."""
    seed_from_snapshot()
    if config.AUTO_REFRESH:
        threading.Thread(target=_loop, name="precip-refresh", daemon=True).start()


def stop() -> None:
    _stop.set()
