"""API tests against a small SYNTHETIC processed run (fixture, not real data).
Real-data end-to-end checks are in test_real_data.py."""
import json

import numpy as np
import pytest
from fastapi.testclient import TestClient

from precip import api, config, store


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path)
    store._load.cache_clear()
    d = tmp_path / "2026010100"
    d.mkdir()
    steps = [0, 3, 6]
    lats = np.array([38.0, 37.75, 37.5], dtype=np.float32)
    lons = np.array([66.0, 66.25, 66.5, 66.75], dtype=np.float32)
    cum = np.zeros((3, 3, 4), dtype=np.float32); cum[1] = 2.0; cum[2] = 5.0; cum[2, 1, 2] = 9.0
    inter = np.diff(cum, axis=0)
    temp = np.full((3, 3, 4), 25.0, dtype=np.float32); temp[2] = 30.0
    cloud = np.full((3, 3, 4), 40.0, dtype=np.float32)
    u10 = np.full((3, 3, 4), 4.0, dtype=np.float32); v10 = np.full((3, 3, 4), 3.0, dtype=np.float32)  # 5 m/s from 233 deg
    np.savez_compressed(d / "arrays.npz", lats=lats, lons=lons, cumulative_mm=cum, interval_mm=inter,
                        temp_c=temp, cloud_pct=cloud, u10=u10, v10=v10)
    meta = {"run_id": "2026010100", "model": "SYNTHETIC", "issue_time_utc": "2026-01-01T00:00:00Z",
            "steps_h": steps, "interval_durations_h": [3, 3],
            "valid_times_utc": ["2026-01-01T00:00:00Z", "2026-01-01T03:00:00Z", "2026-01-01T06:00:00Z"],
            "domain": {"lat_min": 37.5, "lat_max": 38.0, "lon_min": 66.0, "lon_max": 66.75}}
    (d / "meta.json").write_text(json.dumps(meta))
    return TestClient(api.app)


def test_health_and_ready(client):
    assert client.get("/api/health").json() == {"status": "ok"}
    assert client.get("/api/ready").json()["latest_run"] == "2026010100"


def test_ready_503_without_data(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path)
    assert TestClient(api.app).get("/api/ready").status_code == 503


def test_runs_and_freshness_marks_old_run_stale(client):
    r = client.get("/api/runs").json()["runs"][0]
    assert r["run_id"] == "2026010100" and r["stale"] is True   # 2026-01-01 is long past


def test_times_report_interval_for_each_step(client):
    t = client.get("/api/runs/latest/times").json()["times"]
    assert t[0]["interval_hours"] is None and t[2]["interval_hours"] == 3
    assert t[2]["interval_start_utc"] == "2026-01-01T03:00:00Z"


def test_map_interval_vs_cumulative_differ(client):
    i = client.get("/api/runs/latest/map?step=6&kind=interval").json()
    c = client.get("/api/runs/latest/map?step=6&kind=cumulative").json()
    assert i["values"][0][0] == 3.0 and c["values"][0][0] == 5.0
    assert i["accumulation_hours"] == 3 and c["accumulation_hours"] == 6
    assert i["units"] == "mm"


@pytest.mark.parametrize("q", ["step=4", "step=-1", "step=999", "step=0&kind=interval", "step=3&kind=bogus"])
def test_map_rejects_bad_requests(client, q):
    assert client.get(f"/api/runs/latest/map?{q}").status_code == 422


def test_unknown_or_malformed_run(client):
    assert client.get("/api/runs/2020010100").status_code == 404
    # Malformed ids never reach the filesystem: the path pattern rejects them first.
    # (A literal "../.." is normalised by the HTTP client/router before routing, so it is not a
    # meaningful probe here; the regex ^(\d{10}|latest)$ plus store.RUN_ID_RE are the guards.)
    assert client.get("/api/runs/12345678901").status_code == 422
    assert client.get("/api/runs/2026010100x").status_code == 422
    assert client.get("/api/runs/abc").status_code == 422


def test_point_nearest_and_bounds(client):
    p = client.get("/api/runs/latest/point?lat=37.8&lon=66.6").json()
    assert p["grid_point"] == {"lat": 37.75, "lon": 66.5}      # nearest cell, not interpolated
    assert p["series"][2]["cumulative_mm"] == 9.0
    assert "no interpolation" in p["method"]
    for bad in ("lat=50&lon=66.5", "lat=37.8&lon=10", "lat=nan&lon=66.5", "lat=x&lon=66.5"):
        assert client.get(f"/api/runs/latest/point?{bad}").status_code == 422


def test_instant_variables_in_map_endpoint(client):
    t = client.get("/api/runs/latest/map?step=6&variable=temp").json()
    assert t["units"] == "°C" and t["kind"] == "instant" and t["values"][0][0] == 30.0
    assert client.get("/api/runs/latest/map?step=0&variable=cloud").json()["values"][0][0] == 40.0  # step 0 is valid
    w = client.get("/api/runs/latest/map?step=3&variable=wind").json()
    assert w["units"] == "m/s" and w["values"][0][0] == 5.0 and w["u"][0][0] == 4.0 and w["v"][0][0] == 3.0
    assert client.get("/api/runs/latest/map?step=3&variable=snow").status_code == 422


def test_point_includes_instant_fields_with_meteorological_wind_direction(client):
    s = client.get("/api/runs/latest/point?lat=37.8&lon=66.6").json()["series"][1]
    assert s["temp_c"] == 25.0 and s["cloud_pct"] == 40 and s["wind_speed_ms"] == 5.0
    assert s["wind_from_deg"] == 233      # u=4 (to the east), v=3 (to the north) => FROM south-west


def test_window_totals_are_cumulative_differences(client):
    # steps are [0, 3, 6]; cumulative at cell (0,0) is 0, 2, 5
    w6 = client.get("/api/runs/latest/map?step=6&variable=precip&kind=window&hours=6").json()
    assert w6["kind"] == "window" and w6["accumulation_hours"] == 6 and w6["values"][0][0] == 5.0
    w3 = client.get("/api/runs/latest/map?step=6&variable=precip&kind=window&hours=3").json()
    i3 = client.get("/api/runs/latest/map?step=6&variable=precip&kind=interval").json()
    assert w3["values"] == i3["values"]          # a window of one step equals that interval


@pytest.mark.parametrize("q", ["step=6&hours=4", "step=3&hours=6", "step=6&hours=9", "step=6&hours=2"])
def test_window_rejects_hours_that_do_not_land_on_a_step(client, q):
    r = client.get(f"/api/runs/latest/map?variable=precip&kind=window&{q}")
    assert r.status_code == 422
    if "hours=4" in q:
        assert "not a forecast step" in r.json()["detail"]
