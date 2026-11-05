"""Coarse GLOBAL layer ("world overview") derived from the same global ECMWF fields we already download.

The India product keeps the native 0.25 deg grid. The world layer block-averages the global field into
K x K blocks (K = 8 -> 2 deg cells, 90 x 180) so the whole globe is only about as large as the India grid.

Scientific notes (also shown to the user in the app):
  * Every value is the MEAN over a 2 deg block. Averaging smooths extremes: a 2 deg rain cell shows far less than
    the 0.25 deg peak inside it. It is an overview, not a replacement for the India product.
  * Precipitation: the mean of the cumulative fields is computed, and intervals are differences of those means
    (the mean is linear, so this equals the mean of the intervals). Negative packing noise is floored at 0.
  * Wind: u and v are averaged separately and speed = hypot(mean u, mean v). That is the speed of the mean wind,
    which is lower than the mean of the speeds where the wind direction varies inside a block.
  * Longitudes are mapped to -180..180 and sorted BEFORE blocking (the file starts at 180 E and wraps).
  * 721 latitude rows -> the first 720 are used (90N .. 89.75S); the single south-pole row is dropped.
"""
from __future__ import annotations

import numpy as np

from .fetch import Run, raw_path

K = 8                      # block size in 0.25 deg cells -> 2 deg
SPACING_DEG = 0.25 * K


def block_mean(values: np.ndarray, lats: np.ndarray, lons: np.ndarray):
    """(nlat, nlon) native grid -> ((nlat//K, nlon//K) means, block-centre lats, block-centre lons)."""
    lons = ((np.asarray(lons, dtype=np.float64) + 180.0) % 360.0) - 180.0
    order = np.argsort(lons)
    lons, values = lons[order], values[:, order]
    if lats[0] < lats[-1]:
        raise ValueError("latitudes unexpectedly ascending")
    n_lat, n_lon = (len(lats) // K) * K, (len(lons) // K) * K
    v = values[:n_lat, :n_lon].astype(np.float64)
    means = v.reshape(n_lat // K, K, n_lon // K, K).mean(axis=(1, 3))
    return means.astype(np.float32), lats[:n_lat].reshape(-1, K).mean(axis=1), lons[:n_lon].reshape(-1, K).mean(axis=1)


def build(run: Run, read_tp, read_field, unit_factor_to_mm, convert_instant, check_field) -> dict:
    """Return {"arrays": {...}, "meta": {...}} for one run. The reader functions come from process.py (passed in to
    avoid a circular import and to keep exactly one implementation of unit handling)."""
    cum, lats, lons = [], None, None
    fields = [read_tp(raw_path(run, s)) for s in run.steps]
    units = {f.units for f in fields}
    if len(units) != 1:
        raise ValueError(f"mixed tp units across steps: {units}")
    factor = unit_factor_to_mm(units.pop())
    for f, s in zip(fields, run.steps):
        check_field(f, run, s, "tp")
        m, lats, lons = block_mean(f.values_native * factor, f.lats, f.lons)
        cum.append(m)
    cum_mm = np.stack(cum)
    interval = np.maximum(np.diff(cum_mm, axis=0), 0.0)   # floor at 0: packing noise, as for India

    def instant(param: str) -> np.ndarray:
        out = []
        for s in run.steps:
            f = read_field(raw_path(run, s, param), param, "instant")
            check_field(f, run, s, param)
            m, _, _ = block_mean(convert_instant(param, f.units, f.values_native), f.lats, f.lons)
            out.append(m)
        return np.stack(out).astype(np.float32)

    temp_c, cloud, u10, v10 = instant("2t"), instant("tcc"), instant("10u"), instant("10v")
    arrays = dict(lats=lats.astype(np.float32), lons=lons.astype(np.float32), cumulative_mm=cum_mm.astype(np.float32),
                  interval_mm=interval.astype(np.float32), temp_c=temp_c, cloud_pct=cloud, u10=u10, v10=v10)
    meta = {"spacing_deg": SPACING_DEG, "n_lat": int(lats.size), "n_lon": int(lons.size),
            "domain": {"lat_min": float(lats.min()), "lat_max": float(lats.max()),
                       "lon_min": float(lons.min()), "lon_max": float(lons.max())},
            "method": f"mean over {SPACING_DEG:g} deg blocks of the global 0.25 deg fields (overview; smooths extremes)"}
    return {"arrays": arrays, "meta": meta}
