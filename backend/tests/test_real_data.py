"""End-to-end checks on REAL processed ECMWF data. Skipped if the pipeline has not been run
(`python -m precip.process`). Source values are re-read with eccodes' own nearest-point search,
independently of precip.process's cropping code."""
import pytest
import eccodes as ec
from fastapi.testclient import TestClient

from precip import api, config, store
from precip.fetch import Run, raw_path

ids = store.list_run_ids()
pytestmark = pytest.mark.skipif(not ids, reason="no processed real run available")

# Places spread over the domain (not tuned to rainy cells): Mumbai, Delhi, Chennai, Guwahati, Kolkata
PLACES = [(19.0, 72.75), (28.5, 77.25), (13.0, 80.25), (26.25, 91.75), (22.5, 88.25)]


def _source_cum_mm(run: Run, step: int, lat: float, lon: float) -> float:
    with open(raw_path(run, step), "rb") as fh:
        g = ec.codes_grib_new_from_file(fh)
        nearest = ec.codes_grib_find_nearest(g, lat, lon)[0]
        units = ec.codes_get(g, "units")
        ec.codes_release(g)
    assert units == "m"
    return nearest.value * 1000.0


@pytest.mark.parametrize("lat,lon", PLACES)
def test_processed_cumulative_matches_source_grib(lat, lon):
    rid = ids[0]
    run = Run(rid[:8], int(rid[8:]))
    r = TestClient(api.app).get(f"/api/runs/{rid}/point?lat={lat}&lon={lon}").json()
    for s in r["series"]:
        if s["step_h"] in (0, 12, 48, 96, 144):
            assert s["cumulative_mm"] == pytest.approx(_source_cum_mm(run, s["step_h"], lat, lon), abs=0.01)


def test_interval_sum_equals_final_cumulative():
    rid = ids[0]
    s = TestClient(api.app).get(f"/api/runs/{rid}/point?lat=26.25&lon=91.75").json()["series"]
    total = sum(x["interval_mm"] for x in s[1:])
    # Zeroed packing noise can only add; allow the documented per-interval tolerance (<=0.25 mm each).
    assert total == pytest.approx(s[-1]["cumulative_mm"], abs=0.25 * (len(s) - 1))
    assert total >= s[-1]["cumulative_mm"] - 1e-6


def test_metadata_is_consistent():
    m = TestClient(api.app).get(f"/api/runs/{ids[0]}").json()
    assert m["steps_h"][0] == 0 and m["steps_h"][-1] <= config.MAX_STEP_H
    assert len(m["valid_times_utc"]) == len(m["steps_h"])
    assert m["grid"] == {"n_lat": 129, "n_lon": 137, "spacing_deg": 0.25}
    assert m["max_interval_mm"] <= m["max_cumulative_mm"]


def test_wettest_cell_matches_source_grib():
    """Wet cells matter more than dry ones: dry cells are ~0 in both and prove little."""
    import numpy as np
    rid = ids[0]
    run_data = store.load_run(rid)
    _, y, x = np.unravel_index(run_data.interval_mm.argmax(), run_data.interval_mm.shape)
    lat, lon = float(run_data.lats[y]), float(run_data.lons[x])
    run = Run(rid[:8], int(rid[8:]))
    series = TestClient(api.app).get(f"/api/runs/{rid}/point?lat={lat}&lon={lon}").json()["series"]
    assert max(s["interval_mm"] or 0 for s in series) > 10  # genuinely a wet cell
    for s in series[::6]:
        assert s["cumulative_mm"] == pytest.approx(_source_cum_mm(run, s["step_h"], lat, lon), abs=0.01)


def test_instant_variables_match_source_grib():
    """2t, tcc, 10u/10v re-read from the raw GRIB with eccodes' own nearest-point search."""
    rid = ids[0]
    if store.load_run(rid).temp_c is None:
        pytest.skip("run processed before instantaneous variables were added")
    run = Run(rid[:8], int(rid[8:]))
    lat, lon = 26.25, 91.75
    series = TestClient(api.app).get(f"/api/runs/{rid}/point?lat={lat}&lon={lon}").json()["series"]
    def raw(param, step):
        with open(raw_path(run, step, param), "rb") as fh:
            g = ec.codes_grib_new_from_file(fh)
            val = ec.codes_grib_find_nearest(g, lat, lon)[0].value
            ec.codes_release(g)
        return val
    for s in series[::8]:
        st = s["step_h"]
        assert s["temp_c"] == pytest.approx(raw("2t", st) - 273.15, abs=0.06)
        assert s["cloud_pct"] == pytest.approx(raw("tcc", st) * 100, abs=0.6)
        assert s["wind_speed_ms"] == pytest.approx((raw("10u", st) ** 2 + raw("10v", st) ** 2) ** 0.5, abs=0.06)


def test_window_total_equals_source_cumulative_difference_at_wettest_cell():
    import numpy as np
    rid = ids[0]
    rd = store.load_run(rid)
    _, y, x = np.unravel_index(rd.interval_mm.argmax(), rd.interval_mm.shape)
    lat, lon = float(rd.lats[y]), float(rd.lons[x])
    run = Run(rid[:8], int(rid[8:]))
    steps = rd.meta["steps_h"]
    end = steps[min(len(steps) - 1, 16)]
    c = TestClient(api.app)
    w = c.get(f"/api/runs/{rid}/map?step={end}&variable=precip&kind=window&hours=24").json()
    iy = int(np.abs(np.array(w["lats"]) - lat).argmin()); ix = int(np.abs(np.array(w["lons"]) - lon).argmin())
    expected = _source_cum_mm(run, end, lat, lon) - _source_cum_mm(run, end - 24, lat, lon)
    assert w["values"][iy][ix] == pytest.approx(max(expected, 0), abs=0.11)   # API rounds to 0.1 mm
