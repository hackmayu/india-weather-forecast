"""Tests for the coarse global overview layer (world.py) and its API scope. Synthetic data only."""
import json

import numpy as np
import pytest
from fastapi.testclient import TestClient

from precip import api, config, store, world


def test_block_mean_sorts_longitudes_before_blocking_and_averages():
    # 16 x 16 native grid (K=8 -> 2 x 2 blocks). Longitudes start at 180 E like the real file and wrap.
    lats = 90 - 0.25 * np.arange(16)
    lons = (180 + 0.25 * np.arange(16)) % 360          # 180, 180.25, ... 183.75 (all in the western hemisphere)
    vals = np.zeros((16, 16)); vals[:8, :8] = 8.0; vals[8:, 8:] = 4.0
    m, la, lo = world.block_mean(vals, lats, lons)
    assert m.shape == (2, 2)
    assert m[0, 0] == pytest.approx(8.0) and m[1, 1] == pytest.approx(4.0) and m[0, 1] == 0.0
    assert la[0] > la[1]                                # still north -> south
    assert lo[0] < lo[1] and -180 <= lo[0] < 0          # mapped to -180..180 and ascending


def test_block_mean_uses_whole_blocks_only_and_drops_the_pole_row():
    lats = 90 - 0.25 * np.arange(721)
    lons = (180 + 0.25 * np.arange(1440)) % 360
    m, la, lo = world.block_mean(np.ones((721, 1440)), lats, lons)
    assert m.shape == (90, 180) and la.size == 90 and lo.size == 180
    assert la.min() > -90 and lo.min() >= -180 and lo.max() <= 180


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path)
    store._load.cache_clear(); store._load_world.cache_clear()
    d = tmp_path / "2026010100"
    d.mkdir()
    steps = [0, 3, 6]
    lats = np.array([38.0, 37.75], dtype=np.float32); lons = np.array([66.0, 66.25], dtype=np.float32)
    z = np.zeros((3, 2, 2), dtype=np.float32)
    np.savez_compressed(d / "arrays.npz", lats=lats, lons=lons, cumulative_mm=z, interval_mm=z[:2],
                        temp_c=z, cloud_pct=z, u10=z, v10=z)
    wl, wo = np.array([45.0, -45.0], dtype=np.float32), np.array([-90.0, 90.0], dtype=np.float32)
    cum = np.zeros((3, 2, 2), dtype=np.float32); cum[2, 0, 1] = 6.0
    np.savez_compressed(d / "world.npz", lats=wl, lons=wo, cumulative_mm=cum, interval_mm=np.diff(cum, axis=0),
                        temp_c=np.full((3, 2, 2), 10.0, dtype=np.float32), cloud_pct=z, u10=z + 3, v10=z + 4)
    meta = {"run_id": "2026010100", "model": "SYNTHETIC", "issue_time_utc": "2026-01-01T00:00:00Z",
            "steps_h": steps, "interval_durations_h": [3, 3],
            "valid_times_utc": ["2026-01-01T00:00:00Z", "2026-01-01T03:00:00Z", "2026-01-01T06:00:00Z"],
            "domain": {"lat_min": 37.75, "lat_max": 38.0, "lon_min": 66.0, "lon_max": 66.25}}
    (d / "meta.json").write_text(json.dumps(meta))
    return TestClient(api.app)


def test_world_scope_returns_the_coarse_grid(client):
    r = client.get("/api/runs/2026010100/map", params={"step": 6, "variable": "precip", "kind": "cumulative", "scope": "world"})
    assert r.status_code == 200
    j = r.json()
    assert j["lats"] == [45.0, -45.0] and j["lons"] == [-90.0, 90.0]
    assert j["values"] == [[0.0, 6.0], [0.0, 0.0]]


def test_world_wind_has_speed_and_components(client):
    j = client.get("/api/runs/2026010100/map", params={"step": 3, "variable": "wind", "scope": "world"}).json()
    assert j["values"][0][0] == 5.0 and j["u"][0][0] == 3.0 and j["v"][0][0] == 4.0


def test_default_scope_is_still_india(client):
    j = client.get("/api/runs/2026010100/map", params={"step": 3, "variable": "temp"}).json()
    assert j["lats"] == [38.0, 37.75]


def test_missing_world_layer_is_a_clear_404(client, tmp_path):
    (tmp_path / "2026010100" / "world.npz").unlink()
    store._load_world.cache_clear()
    r = client.get("/api/runs/2026010100/map", params={"step": 3, "variable": "temp", "scope": "world"})
    assert r.status_code == 404 and "global overview" in r.json()["detail"]


def test_cache_headers_only_for_explicit_runs(client):
    explicit = client.get("/api/runs/2026010100/map", params={"step": 3, "variable": "temp"})
    assert "max-age=900" in explicit.headers["cache-control"]
    assert client.get("/api/runs/latest").headers["cache-control"] == "no-cache"
    assert client.get("/api/health").headers["cache-control"] == "no-cache"
