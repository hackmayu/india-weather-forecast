"""Refresh/seed logic with SYNTHETIC data and mocked network (no downloads)."""
import json

import pytest

from precip import config, refresh, store
from precip.fetch import Run


def _make_run(root, rid):
    d = root / rid
    d.mkdir(parents=True)
    (d / "meta.json").write_text(json.dumps({"run_id": rid}))
    (d / "arrays.npz").write_bytes(b"x")


@pytest.fixture()
def dirs(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path / "processed")
    monkeypatch.setattr(config, "SNAPSHOT_DIR", tmp_path / "snapshot")
    store._load.cache_clear()
    return tmp_path


def test_seed_copies_snapshot_into_empty_dir(dirs):
    _make_run(dirs / "snapshot", "2026010100")
    assert refresh.seed_from_snapshot() == 1
    assert store.list_run_ids() == ["2026010100"]


def test_seed_never_overwrites_existing_data(dirs):
    _make_run(dirs / "snapshot", "2026010100")
    _make_run(dirs / "processed", "2026020100")
    assert refresh.seed_from_snapshot() == 0
    assert store.list_run_ids() == ["2026020100"]


def test_refresh_is_noop_when_latest_run_already_present(dirs, monkeypatch):
    _make_run(dirs / "processed", "2026010100")
    monkeypatch.setattr(refresh, "find_latest_complete_run", lambda: Run("20260101", 0))
    monkeypatch.setattr(refresh, "fetch_run", lambda r: pytest.fail("must not download"))
    assert refresh.refresh_once() == "up_to_date"
    assert refresh.status()["last_result"] == "up_to_date"


def test_refresh_downloads_and_processes_newer_run(dirs, monkeypatch):
    _make_run(dirs / "processed", "2026010100")
    calls = []
    monkeypatch.setattr(refresh, "find_latest_complete_run", lambda: Run("20260101", 6))
    monkeypatch.setattr(refresh, "fetch_run", lambda r: calls.append(("fetch", r.run_id)))
    monkeypatch.setattr(refresh, "process_run", lambda r: (calls.append(("process", r.run_id)), _make_run(dirs / "processed", r.run_id)))
    monkeypatch.setattr(refresh, "prune", lambda: calls.append(("prune",)))
    monkeypatch.setattr(config, "KEEP_RAW", True)
    assert refresh.refresh_once() == "updated_to_2026010106"
    assert calls == [("fetch", "2026010106"), ("process", "2026010106"), ("prune",)]
    assert store.list_run_ids()[0] == "2026010106"


def test_failure_keeps_old_data_and_records_error(dirs, monkeypatch):
    _make_run(dirs / "processed", "2026010100")

    def boom():
        raise RuntimeError("network down")
    monkeypatch.setattr(refresh, "find_latest_complete_run", boom)
    assert refresh.refresh_once() == "failed"
    st = refresh.status()
    assert st["last_result"] == "failed" and "network down" in st["last_error"]
    assert st["refreshing"] is False and store.list_run_ids() == ["2026010100"]
