"""Static export tests on a SYNTHETIC processed run (labelled fixture) plus a real-data round trip."""
import json

import numpy as np
import pytest

from precip import config, export_static, store


def _make_run(root, rid="2026010100", steps=(0, 3, 6)):
    d = root / rid
    d.mkdir(parents=True)
    n = len(steps)
    lats = np.array([38.0, 37.75], dtype=np.float32)
    lons = np.array([66.0, 66.25, 66.5], dtype=np.float32)
    cum = np.zeros((n, 2, 3), dtype=np.float32)
    cum[1] = 2.25; cum[2] = 5.5
    np.savez_compressed(
        d / "arrays.npz", lats=lats, lons=lons, cumulative_mm=cum, interval_mm=np.diff(cum, axis=0),
        temp_c=np.full((n, 2, 3), 21.37, dtype=np.float32), cloud_pct=np.full((n, 2, 3), 63.4, dtype=np.float32),
        u10=np.full((n, 2, 3), 3.456, dtype=np.float32), v10=np.full((n, 2, 3), -1.234, dtype=np.float32))
    meta = {"run_id": rid, "issue_time_utc": "2026-01-01T00:00:00Z", "steps_h": list(steps), "raw_sha256": {"x": "y"},
            "valid_times_utc": [f"2026-01-01T{h:02d}:00:00Z" for h in steps], "interval_durations_h": [3, 3]}
    (d / "meta.json").write_text(json.dumps(meta))
    return d


def test_export_run_encodings_round_trip(tmp_path):
    src = _make_run(tmp_path / "proc")
    out = tmp_path / "out"
    meta = export_static.export_run(src, out)
    assert "raw_sha256" not in meta and meta["lats"] == [38.0, 37.75] and meta["format"] == 1
    base = out / "runs" / "2026010100"
    cum = np.frombuffer((base / "cum.bin").read_bytes(), dtype="<f4").reshape(3, 2, 3)
    assert cum[2, 0, 0] == 5.5 and cum.shape == tuple(meta["encodings"]["cum.bin"]["shape"])
    assert np.frombuffer((base / "interval.bin").read_bytes(), dtype="<f4").size == 2 * 2 * 3
    temp = np.frombuffer((base / "temp.bin").read_bytes(), dtype="<i2") / meta["encodings"]["temp.bin"]["scale"]
    assert temp[0] == pytest.approx(21.4)                       # 21.37 -> 0.1 degC precision
    assert np.frombuffer((base / "cloud.bin").read_bytes(), dtype="u1")[0] == 63
    u = np.frombuffer((base / "u.bin").read_bytes(), dtype="<i2")[0] / 100
    v = np.frombuffer((base / "v.bin").read_bytes(), dtype="<i2")[0] / 100
    assert (u, v) == (pytest.approx(3.46), pytest.approx(-1.23))   # 0.01 m/s: direction stays accurate at low speed


def test_export_all_keeps_newest_and_prunes_old(tmp_path):
    proc = tmp_path / "proc"
    for rid in ("2026010100", "2026010106", "2026010112"):
        _make_run(proc, rid)
    out = tmp_path / "out"
    dirs = export_static._run_dirs(proc)
    assert [d.name for d in dirs] == ["2026010112", "2026010106", "2026010100"]      # newest first
    idx = export_static.export_all(dirs, [], out, keep=2, scheduled=True, refresh_minutes=30)
    assert [r["run_id"] for r in idx["runs"]] == ["2026010112", "2026010106"]
    assert idx["scheduled_refresh"] is True and idx["probability"] == []
    assert sorted(p.name for p in (out / "runs").iterdir()) == ["2026010106", "2026010112"]
    export_static.export_all(export_static._run_dirs(proc)[:1], [], out, keep=2)      # a later export with fewer runs
    assert sorted(p.name for p in (out / "runs").iterdir()) == ["2026010112"]         # stale run directory removed


def test_export_refuses_runs_without_instant_variables(tmp_path):
    d = tmp_path / "proc" / "2026010100"
    d.mkdir(parents=True)
    np.savez_compressed(d / "arrays.npz", lats=np.zeros(1), lons=np.zeros(1), cumulative_mm=np.zeros((1, 1, 1)), interval_mm=np.zeros((0, 1, 1)))
    (d / "meta.json").write_text(json.dumps({"run_id": "2026010100"}))
    with pytest.raises(ValueError, match="reprocess"):
        export_static.export_run(d, tmp_path / "out")


@pytest.mark.skipif(not store.list_run_ids(), reason="no processed real run available")
def test_real_run_exports_and_matches_api_values(tmp_path):
    rid = store.list_run_ids()[0]
    meta = export_static.export_run(config.PROCESSED_DIR / rid, tmp_path)
    r = store.load_run(rid)
    cum = np.frombuffer((tmp_path / "runs" / rid / "cum.bin").read_bytes(), dtype="<f4").reshape(r.cumulative_mm.shape)
    assert np.array_equal(cum, r.cumulative_mm.astype("<f4"))
    temp = np.frombuffer((tmp_path / "runs" / rid / "temp.bin").read_bytes(), dtype="<i2").reshape(r.temp_c.shape) / 10
    assert np.abs(temp - r.temp_c).max() <= 0.051              # half of the 0.1 degC quantum
    assert meta["grid"]["n_lat"] == r.lats.size
