"""ENS probability tests. Synthetic fixtures are labelled; the real-data test re-reads the source GRIB
independently (eccodes nearest-point search) and is skipped if no ENS run has been processed."""
import json
from datetime import datetime, timezone

import numpy as np
import pytest
from fastapi.testclient import TestClient

from precip import api, config, ens, store_ens


# ------------------------------------------------------------------ synthetic API fixture
@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "PROCESSED_ENS_DIR", tmp_path)
    store_ens._load_ens.cache_clear()
    d = tmp_path / "2026010100"
    d.mkdir()
    lats = np.array([38.0, 37.75, 37.5], dtype=np.float32)
    lons = np.array([66.0, 66.25, 66.5, 66.75], dtype=np.float32)
    prob = np.zeros((2, 2, 3, 4), dtype=np.uint16)          # (window, threshold, lat, lon), tenths of %
    prob[0, 0] = 800; prob[0, 1] = 300; prob[1, 0] = 505; prob[1, 1] = 100
    prob[0, 0, 1, 2] = 995                                   # one distinctive cell
    np.savez_compressed(d / "arrays.npz", lats=lats, lons=lons, prob=prob)
    meta = {"run_id": "2026010100", "issue_time_utc": "2026-01-01T00:00:00Z", "thresholds_mm": [1, 5], "scale": 10,
            "windows": [{"start_h": 0, "end_h": 24, "start_utc": "2026-01-01T00:00:00Z", "end_utc": "2026-01-02T00:00:00Z"},
                        {"start_h": 12, "end_h": 36, "start_utc": "2026-01-01T12:00:00Z", "end_utc": "2026-01-02T12:00:00Z"}],
            "domain": {"lat_min": 37.5, "lat_max": 38.0, "lon_min": 66.0, "lon_max": 66.75}, "units": "%",
            "semantics": "SYNTHETIC"}
    (d / "meta.json").write_text(json.dumps(meta))
    return TestClient(api.app)


def test_no_probability_run_gives_503(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "PROCESSED_ENS_DIR", tmp_path)
    store_ens._load_ens.cache_clear()
    c = TestClient(api.app)
    assert c.get("/api/probability/latest").status_code == 503
    assert c.get("/api/probability/runs").json() == {"runs": []}


def test_probability_map_values_and_metadata(client):
    m = client.get("/api/probability/latest/map?window_end=24&threshold=1").json()
    assert m["units"] == "%" and m["threshold_mm"] == 1 and m["window"]["end_h"] == 24
    assert m["values"][0][0] == 80.0
    assert m["values"][1][2] == 100.0          # stored 99.5 % rounds to 100, not half-to-even 99
    assert m["valid_time_utc"] == "2026-01-02T00:00:00Z" and m["accumulation_hours"] == 24
    m2 = client.get("/api/probability/latest/map?window_end=36&threshold=5").json()
    assert m2["values"][0][0] == 10.0


@pytest.mark.parametrize("q", ["window_end=30&threshold=1", "window_end=24&threshold=3", "window_end=24&threshold=abc", "threshold=1"])
def test_probability_map_rejects_bad_requests(client, q):
    assert client.get(f"/api/probability/latest/map?{q}").status_code == 422


def test_probability_unknown_and_malformed_runs(client):
    assert client.get("/api/probability/2020010100").status_code == 404
    assert client.get("/api/probability/abc").status_code == 422


def test_probability_point_table(client):
    p = client.get("/api/probability/latest/point?lat=37.8&lon=66.6").json()
    assert p["grid_point"] == {"lat": 37.75, "lon": 66.5}
    assert p["thresholds_mm"] == [1, 5]
    assert [w["probability_pct"] for w in p["windows"]] == [[100, 30], [51, 10]]   # 99.5 -> 100 and 50.5 -> 51
    assert "no interpolation" in p["method"]
    for bad in ("lat=50&lon=66.5", "lat=37.8&lon=10", "lat=nan&lon=66.5"):
        assert client.get(f"/api/probability/latest/point?{bad}").status_code == 422


def test_status_reports_probability_run(client):
    s = client.get("/api/status").json()
    assert s["probability"]["latest_run"] == "2026010100"


# ------------------------------------------------------------------ index selection / run discovery (mocked HTTP)
class _R:
    def __init__(self, status, text=""):
        self.status_code, self.text = status, text


def _index_text(missing=None):
    lines = []
    for thr in config.ENS_THRESHOLDS_MM:
        for s, e in ens.WINDOWS:
            if missing == (thr, (s, e)):
                continue
            lines.append(json.dumps({"param": f"tpg{thr}", "step": f"{s}-{e}", "levtype": "sfc", "_offset": 1, "_length": 10}))
    lines.append(json.dumps({"param": "msl", "step": "0", "levtype": "sfc", "_offset": 0, "_length": 1}))  # unrelated record
    return "\n".join(lines)


def test_wanted_records_selects_every_threshold_window_pair(monkeypatch):
    monkeypatch.setattr(ens, "_get", lambda *a, **k: _R(200, _index_text()))
    recs = ens.wanted_records(ens.EnsRun("20261104", 0))
    assert len(recs) == len(config.ENS_THRESHOLDS_MM) * len(ens.WINDOWS) == 66


def test_wanted_records_none_when_unpublished_and_error_when_incomplete(monkeypatch):
    monkeypatch.setattr(ens, "_get", lambda *a, **k: _R(404))
    assert ens.wanted_records(ens.EnsRun("20261104", 12)) is None
    monkeypatch.setattr(ens, "_get", lambda *a, **k: _R(200, _index_text(missing=(10, (24, 48)))))
    with pytest.raises(RuntimeError, match="tpg10"):
        ens.wanted_records(ens.EnsRun("20261104", 0))


def test_find_latest_ens_run_skips_unpublished_and_only_uses_00_12(monkeypatch):
    seen = []

    def fake(run):
        seen.append(run.run_id)
        return {} if run.run_id == "2026110400" else None       # 12 UTC not published yet
    monkeypatch.setattr(ens, "wanted_records", fake)
    run = ens.find_latest_ens_run(datetime(2026, 11, 4, 15, 0, tzinfo=timezone.utc))
    assert run.run_id == "2026110400" and seen == ["2026110412", "2026110400"]
    assert all(h in (0, 12) for h in (int(s[8:]) for s in seen))   # never 06/18 UTC: no ep files exist for them


def test_find_latest_ens_run_none_when_nothing_published(monkeypatch):
    monkeypatch.setattr(ens, "wanted_records", lambda run: None)
    assert ens.find_latest_ens_run(datetime(2026, 11, 4, 15, 0, tzinfo=timezone.utc)) is None


def test_windows_cover_24h_every_12h_up_to_144():
    assert ens.WINDOWS[0] == (0, 24) and ens.WINDOWS[-1] == (120, 144) and len(ens.WINDOWS) == 11
    assert all(e - s == 24 for s, e in ens.WINDOWS)


# ------------------------------------------------------------------ real data
real_ids = store_ens.list_ens_run_ids()


@pytest.mark.skipif(not real_ids, reason="no processed ENS probability run available")
def test_real_probabilities_match_source_grib():
    import eccodes as ec
    rid = real_ids[0]
    run = ens.EnsRun(rid[:8], int(rid[8:]))
    p = store_ens.load_ens(rid)
    thrs = p.meta["thresholds_mm"]
    # five places spread over the domain (not tuned to wet cells) + the wettest cell of the 10 mm / 24-48 h field
    cells = [(19.0, 72.75), (28.5, 77.25), (13.0, 80.25), (26.25, 91.75), (22.5, 88.25)]
    wi, ti = 1, thrs.index(10)
    iy, ix = np.unravel_index(p.prob[wi, ti].argmax(), p.prob[wi, ti].shape)
    cells.append((float(p.lats[iy]), float(p.lons[ix])))
    checked = 0
    for lat, lon in cells:
        iy, ix = store_ens.nearest_cell_ens(p, lat, lon)
        for wi2 in (0, 1, 5, 10):
            for ti2, thr in enumerate(thrs):
                w = ens.WINDOWS[wi2]
                with open(ens.raw_path(run, thr, w), "rb") as fh:
                    g = ec.codes_grib_new_from_file(fh)
                    src = ec.codes_grib_find_nearest(g, float(p.lats[iy]), float(p.lons[ix]))[0].value
                    ec.codes_release(g)
                assert p.prob[wi2, ti2, iy, ix] / 10.0 == pytest.approx(src, abs=0.06)   # stored at 0.1 % resolution
                checked += 1
    assert checked == len(cells) * 4 * len(thrs)


@pytest.mark.skipif(not real_ids, reason="no processed ENS probability run available")
def test_real_probabilities_are_monotonic_in_threshold_and_bounded():
    p = store_ens.load_ens(real_ids[0])
    assert p.prob.max() <= 1000
    for ti in range(1, p.prob.shape[1]):
        excess = (p.prob[:, ti].astype(np.int32) - p.prob[:, ti - 1].astype(np.int32)).max() / 10.0
        assert excess <= ens.MONOTONIC_TOLERANCE_PCT
    assert p.meta["quality"]["max_probability_pct"] == pytest.approx(p.prob.max() / 10.0, abs=0.1)
