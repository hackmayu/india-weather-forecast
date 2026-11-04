"""Small deterministic derivations shared by the API and tests."""
from __future__ import annotations

import numpy as np


def wind_from_direction_deg(u: np.ndarray | float, v: np.ndarray | float) -> np.ndarray | float:
    """Meteorological wind direction: the compass bearing the wind blows FROM (0 = from north,
    90 = from east). u is the eastward and v the northward component.
    Check: westerly wind (u>0, v=0) blows toward the east and comes FROM 270."""
    return (270.0 - np.degrees(np.arctan2(v, u))) % 360.0
