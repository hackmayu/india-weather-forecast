"""Unit tests on SYNTHETIC arrays (labelled fixtures, not real forecast data)."""
import numpy as np
import pytest

from precip import config
from precip.process import crop_region, intervals_from_cumulative, unit_factor_to_mm


def test_unit_conversion_m_and_kgm2():
    assert unit_factor_to_mm("m") == 1000.0           # IFS: metres of water -> mm
    assert unit_factor_to_mm("kg m**-2") == 1.0        # AIFS: already mm
    with pytest.raises(ValueError):
        unit_factor_to_mm("mm/s")                      # never guess


def test_intervals_handle_unequal_step_spacing():
    cum = np.zeros((4, 1, 1)); cum[:, 0, 0] = [0, 3, 9, 10]
    out, dur, stats = intervals_from_cumulative(cum, [0, 3, 9, 12], [1e-3] * 4)
    assert out[:, 0, 0].tolist() == [3, 6, 1]
    assert dur.tolist() == [3, 6, 3]                   # real gaps, not an assumed 3 h
    assert stats["packing_noise_cells_zeroed"] == 0


def test_small_negative_is_packing_noise_and_counted():
    cum = np.zeros((3, 1, 2)); cum[1] = [[5.0, 5.0]]; cum[2] = [[5.0 - 0.05, 6.0]]
    out, _, stats = intervals_from_cumulative(cum, [0, 3, 6], [0.1, 0.1, 0.1])
    assert out[1, 0, 0] == 0.0 and out[1, 0, 1] == 1.0
    assert stats["packing_noise_cells_zeroed"] == 1
    assert stats["worst_packing_noise_mm"] == pytest.approx(-0.05)


def test_large_negative_is_an_error_not_clipped():
    cum = np.zeros((3, 1, 1)); cum[1] = 10.0; cum[2] = 0.0   # looks like an accumulation reset
    with pytest.raises(ValueError, match="accumulation reset"):
        intervals_from_cumulative(cum, [0, 3, 6], [0.01] * 3)


def test_first_step_must_be_zero_and_steps_increasing():
    cum = np.ones((2, 1, 1))
    with pytest.raises(ValueError):
        intervals_from_cumulative(cum, [0, 3], [0.1, 0.1])
    with pytest.raises(ValueError):
        intervals_from_cumulative(np.zeros((2, 1, 1)), [3, 3], [0.1, 0.1])


def test_crop_sorts_wrapped_longitudes_before_cropping():
    # Native file order starts at 180E and wraps, like the real IFS grid (coarse 1-degree version).
    lats = np.arange(90, -91, -1.0)
    lons = (180 + np.arange(360)) % 360.0
    values = np.tile(lons, (lats.size, 1))             # each cell's value == its own longitude
    reg, lat_o, lon_o = crop_region(values, lats, lons)
    assert lon_o.min() == config.LON_MIN and lon_o.max() == config.LON_MAX
    assert np.all(np.diff(lon_o) > 0)                  # ascending
    assert np.array_equal(reg[0], lon_o)               # values still match their longitude
    assert lat_o[0] == config.LAT_MAX and lat_o[-1] == config.LAT_MIN


# ---- instantaneous variables (SYNTHETIC inputs) ----
from precip.derive import wind_from_direction_deg
from precip.process import convert_instant


def test_kelvin_to_celsius_and_cloud_fraction_to_percent():
    assert convert_instant("2t", "K", np.array([273.15, 300.0])).tolist() == pytest.approx([0.0, 26.85])
    assert convert_instant("tcc", "(0 - 1)", np.array([0.0, 0.5, 1.0])).tolist() == [0.0, 50.0, 100.0]


def test_implausible_or_unknown_units_are_rejected_not_displayed():
    with pytest.raises(ValueError, match="plausible"):
        convert_instant("2t", "K", np.array([20.0]))        # looks like degC mislabelled as K
    with pytest.raises(ValueError, match="refusing to guess"):
        convert_instant("2t", "degC", np.array([20.0]))
    with pytest.raises(ValueError, match="plausible"):
        convert_instant("tcc", "(0 - 1)", np.array([50.0]))  # already in percent


@pytest.mark.parametrize("u,v,expected", [
    (5, 0, 270),    # westerly: blows toward east, comes FROM the west
    (-5, 0, 90),    # easterly
    (0, -5, 0),     # northerly: comes FROM the north
    (0, 5, 180),    # southerly
    (3, 3, 225),    # south-westerly
])
def test_wind_from_direction_is_meteorological(u, v, expected):
    assert float(wind_from_direction_deg(u, v)) == pytest.approx(expected)
