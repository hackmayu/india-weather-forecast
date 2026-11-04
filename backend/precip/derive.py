"""Small deterministic derivations shared by the API and tests."""
from __future__ import annotations

import numpy as np


def wind_from_direction_deg(u: np.ndarray | float, v: np.ndarray | float) -> np.ndarray | float:
    """Meteorological wind direction: the compass bearing the wind blows FROM (0 = from north,
    90 = from east). u is the eastward and v the northward component.
    Check: westerly wind (u>0, v=0) blows toward the east and comes FROM 270."""
    return (270.0 - np.degrees(np.arctan2(v, u))) % 360.0


def window_total(cum_end: np.ndarray, cum_start: np.ndarray) -> np.ndarray:
    """Precipitation (mm) accumulated between two valid times: difference of the cumulative fields.

    `tp` is stored with limited packing precision (see docs/DATA_NOTES.md), so the difference can be
    slightly negative (by up to about one packing step, ~0.1-0.25 mm) where the true value is ~0.
    Such values are floored at 0. Larger negatives cannot occur here because processing already
    raised an error for them."""
    return np.maximum(cum_end - cum_start, 0.0)
