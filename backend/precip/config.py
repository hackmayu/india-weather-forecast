"""Central configuration. Values here are scientific/operational decisions, not secrets."""
from __future__ import annotations

import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = Path(os.environ.get("PRECIP_DATA_DIR", PROJECT_ROOT / "data"))
RAW_DIR = DATA_DIR / "raw"          # downloaded single-field GRIB messages (gitignored)
PROCESSED_DIR = DATA_DIR / "processed"  # compact artifacts served by the API

# Source: ECMWF Open Data, real-time IFS HRES ("oper"), 0.25 degree.
# Licence: CC-BY-4.0 + ECMWF Terms of Use (attribution required).
BASE_URL = os.environ.get("PRECIP_BASE_URL", "https://data.ecmwf.int/forecasts")
MODEL = "ifs"
RESOL = "0p25"
STREAM = "oper"
TYPE = "fc"

# Region: India (approximate bounding box). Decision approved by applicant 2026-11-04.
LAT_MIN, LAT_MAX = 6.0, 38.0
LON_MIN, LON_MAX = 66.0, 100.0

# Horizon: 0-144 h. IFS 00/12 UTC runs have 3-hourly steps up to 144 h.
MAX_STEP_H = 144
KEEP_RUNS = 4
HTTP_TIMEOUT_S = 60
