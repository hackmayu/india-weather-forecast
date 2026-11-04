"""Decision logic of the live static publisher, with SYNTHETIC runs and mocked ECMWF access (no network)."""
import json

import numpy as np
import pytest

from precip import config, ens, export_static, live_static
from precip.fetch import Run


def _write_processed(root, rid, hour):
    d = root / rid
    d.mkdir(parents=True)
    steps = [0, 3]
    np.savez_compressed(
        d / "arrays.npz", lats=np.array([38.0, 37.75], dtype=np.float32), lons=np.array([66.0, 66.25], dtype=np.float32),
        cumulative_mm=np.zeros((2, 2, 2), dtype=np.float32), interval_mm=np.zeros((1, 2, 2), dtype=np.float32),
        temp_c=np.zeros((2, 2, 2), dtype=np.float32), cloud_pct=np.zeros((2, 2, 2), dtype=np.float32),
        u10=np.zeros((2, 2, 2), dtype=np.float32), v10=np.zeros((2, 2, 2), dtype=np.float32))
    issue = f"{rid[:4]}-{rid[4:6]}-{rid[6:8]}T{hour:02d}:00:00Z"
    (d / "meta.json").write_text(json.dumps({"run_id": rid, "issue_time_utc": issue, "steps_h": steps,
                                             "valid_times_utc": [issue, issue], "interval_durations_h": [3]}))
    return d


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path / "processed")
    monkeypatch.setattr(config, "PROCESSED_ENS_DIR", tmp_path / "processed_ens")
    # "previously published" site containing the 00 UTC run only
    prev_src = tmp_path / "prev_src"
    _write_processed(prev_src, "2026010100", 0)
    prev = tmp_path / "prev"
    export_static.export_all([prev_src / "2026010100"], [], prev, keep=2)
    calls = {"fetch": [], "process": []}
    monkeypatch.setattr(live_static, "fetch_run", lambda r: calls["fetch"].append(r.run_id))
    monkeypatch.setattr(live_static, "process_run", lambda r: (calls["process"].append(r.run_id), _write_processed(config.PROCESSED_DIR, r.run_id, r.hour)))
    monkeypatch.setattr(ens, "find_latest_ens_run", lambda: None)
    return tmp_path, prev, calls, monkeypatch


def test_nothing_new_changes_nothing(env):
    tmp, prev, calls, mp = env
    mp.setattr(live_static, "find_latest_complete_run", lambda: Run("20260101", 0))     # already published
    assert live_static.build(tmp / "out", prev) is False
    assert calls == {"fetch": [], "process": []} and not (tmp / "out").exists()


def test_new_run_is_processed_and_previous_is_carried_over(env):
    tmp, prev, calls, mp = env
    mp.setattr(live_static, "find_latest_complete_run", lambda: Run("20260101", 6))
    assert live_static.build(tmp / "out", prev) is True
    assert calls["fetch"] == ["2026010106"] == calls["process"]                           # only the new run was downloaded
    idx = json.loads((tmp / "out" / "index.json").read_text())
    assert [r["run_id"] for r in idx["runs"]] == ["2026010106", "2026010100"]            # newest first, previous carried over
    assert idx["scheduled_refresh"] is True and idx["refresh_minutes"] == 30
    assert (tmp / "out" / "runs" / "2026010100" / "cum.bin").exists()


def test_keeps_only_two_runs(env):
    tmp, prev, calls, mp = env
    mp.setattr(live_static, "find_latest_complete_run", lambda: Run("20260101", 6))
    live_static.build(tmp / "out1", prev)
    mp.setattr(live_static, "find_latest_complete_run", lambda: Run("20260101", 12))
    assert live_static.build(tmp / "out2", tmp / "out1") is True
    idx = json.loads((tmp / "out2" / "index.json").read_text())
    assert [r["run_id"] for r in idx["runs"]] == ["2026010112", "2026010106"]            # the oldest (00 UTC) dropped
    assert sorted(p.name for p in (tmp / "out2" / "runs").iterdir()) == ["2026010106", "2026010112"]


def test_probability_failure_does_not_block_the_forecast(env, tmp_path):
    tmp, prev, calls, mp = env
    mp.setattr(live_static, "find_latest_complete_run", lambda: Run("20260101", 6))
    mp.setattr(ens, "find_latest_ens_run", lambda: ens.EnsRun("20260101", 0))
    def boom(run):
        raise RuntimeError("ENS download failed")
    mp.setattr(ens, "fetch_ens_run", boom)
    assert live_static.build(tmp / "out", prev) is True                                   # forecast still published
    idx = json.loads((tmp / "out" / "index.json").read_text())
    assert [r["run_id"] for r in idx["runs"]] == ["2026010106", "2026010100"] and idx["probability"] == []


def test_first_ever_publish_without_previous(env):
    tmp, _, calls, mp = env
    mp.setattr(live_static, "find_latest_complete_run", lambda: Run("20260101", 6))
    assert live_static.build(tmp / "out", None) is True
    assert [r["run_id"] for r in json.loads((tmp / "out" / "index.json").read_text())["runs"]] == ["2026010106"]


def test_force_rebuilds_even_when_up_to_date(env):
    tmp, prev, calls, mp = env
    mp.setattr(live_static, "find_latest_complete_run", lambda: Run("20260101", 0))
    assert live_static.build(tmp / "out", prev, force=True) is True
    assert calls["fetch"] == ["2026010100"]
