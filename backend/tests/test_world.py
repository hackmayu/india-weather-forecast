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


# ---- 0.5 deg layer (build50) and its per-step export -------------------------------------------------------------
from types import SimpleNamespace  # noqa: E402

from precip.fetch import Run  # noqa: E402


def _fake_readers(n_lat=8, n_lon=16):
    lats = 90 - 0.25 * np.arange(n_lat)
    lons = (180 + 0.25 * np.arange(n_lon)) % 360

    def read_tp(path):
        s = int(str(path).rsplit("_", 1)[1].split(".")[0]) if "tp" not in str(path) else 0
        return SimpleNamespace(values_native=np.full((n_lat, n_lon), 0.001 * (1 + s)), units="m", step=s, quantum_native=1e-6,
                               lats=lats, lons=lons, data_date="20260101", data_time=0)

    def read_field(path, param, kind):
        base = {"2t": 300.12, "tcc": 0.5, "10u": 3.0, "10v": 4.0}[param]
        return SimpleNamespace(values_native=np.full((n_lat, n_lon), base), units={"2t": "K", "tcc": "(0 - 1)"}.get(param, "m s**-1"),
                               step=0, quantum_native=0, lats=lats, lons=lons, data_date="20260101", data_time=0)

    convert = lambda param, units, v: {"2t": v - 273.15, "tcc": v * 100.0}.get(param, v)  # noqa: E731
    return read_tp, read_field, (lambda u: 1000.0), convert, (lambda *a, **k: None)


def test_build50_quantises_and_keeps_grid_geometry(monkeypatch):
    run = Run("20260101", 0)
    monkeypatch.setattr(type(run), "steps", property(lambda self: [0, 3, 6]), raising=False)
    w = world.build50(run, *_fake_readers())
    a, m = w["arrays"], w["meta"]
    assert a["cum"].shape == (3, 4, 8) and a["cum"].dtype == np.dtype("<u2")
    assert (a["temp"] == 270).all()      # 26.97 degC stored in tenths (a value away from a .5 tie, which float32 averaging could round either way)
    assert (a["cloud"] == 50).all() and (a["u"] == 300).all() and (a["v"] == 400).all()
    assert m["spacing_deg"] == 0.5 and m["n_lat"] == 4 and m["n_lon"] == 8 and m["steps"] == 3
    assert a["lons"].min() >= -180 and a["lats"][0] > a["lats"][-1]


def test_export_writes_one_file_per_variable_and_step(tmp_path):
    from precip import export_static
    src, out = tmp_path / "2026010100", tmp_path / "out"
    src.mkdir()
    n = 3
    z = np.zeros((n, 2, 2), dtype=np.float32)
    np.savez_compressed(src / "arrays.npz", lats=np.array([38.0, 37.75], dtype=np.float32), lons=np.array([66.0, 66.25], dtype=np.float32),
                        cumulative_mm=z, interval_mm=z[:2], temp_c=z, cloud_pct=z, u10=z, v10=z)
    np.savez_compressed(src / "world50.npz", cum=np.ones((n, 4, 6), "<u2"), temp=np.ones((n, 4, 6), "<i2"), cloud=np.ones((n, 4, 6), "u1"),
                        u=np.ones((n, 4, 6), "<i2"), v=np.ones((n, 4, 6), "<i2"), lats=np.arange(4, dtype=np.float32), lons=np.arange(6, dtype=np.float32))
    meta = {"run_id": "2026010100", "model": "S", "issue_time_utc": "2026-01-01T00:00:00Z", "steps_h": [0, 3, 6],
            "world50": {"spacing_deg": 0.5, "n_lat": 4, "n_lon": 6, "steps": 3, "lat0": 1.0, "lon0": 2.0}}
    (src / "meta.json").write_text(json.dumps(meta))
    m = export_static.export_run(src, out, w50=True)
    d = out / "runs" / "2026010100" / "w50"
    assert sorted(p.name for p in d.iterdir()) == sorted(f"{k}_{i}.bin" for k in ("cum", "temp", "cloud", "u", "v") for i in range(n))
    assert (d / "cum_0.bin").stat().st_size == 4 * 6 * 2 and (d / "cloud_2.bin").stat().st_size == 4 * 6
    assert m["world50"]["encodings"]["temp"] == {"dtype": "<i2", "scale": 10, "shape": [4, 6]}
    m2 = export_static.export_run(src, out, w50=False)          # an older run: files and metadata are dropped again
    assert "world50" not in m2 and not d.exists()


def test_to_tiles_averages_to_one_degree_and_keeps_units():
    from precip.world import W50_ENC, to_tiles
    s, h, w = 2, 360, 720
    arrays = {k: np.zeros((s, h, w), dtype=dt) for k, (dt, _) in W50_ENC.items()}
    arrays["temp"][:, :2, :2] = np.array([[100, 200], [300, 400]], dtype="<i2")     # one 1 deg block: mean 250 (25.0 degC)
    arrays["cum"][1, 2:4, 2:4] = 50                                                # 5.0 mm in the next block
    arrays["lats"] = (90 - 0.25 - 0.5 * np.arange(h)).astype("float32")
    arrays["lons"] = (-180 + 0.25 + 0.5 * np.arange(w)).astype("float32")
    tiles, meta = to_tiles(arrays)
    assert tiles["temp"].shape == (s, 180, 360) and tiles["temp"][0, 0, 0] == 250 and tiles["temp"][0, 0, 1] == 0
    assert tiles["cum"][1, 1, 1] == 50 and tiles["cum"][0, 1, 1] == 0
    assert meta["size"] == 30 and meta["n_lat"] == 180 and meta["lat0"] == pytest.approx(89.5) and meta["lon0"] == pytest.approx(-179.5)
    with pytest.raises(ValueError):
        to_tiles({**arrays, **{k: v[:, :10, :20] for k, v in arrays.items() if k in W50_ENC}})
