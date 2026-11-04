# Data notes (verified on real data, 2026-11-04)

All statements below were observed on the IFS HRES 0.25° run `2026-11-04 00 UTC`
(files fetched by `python -m precip.fetch`), not assumed from documentation.

## Source and retrieval
- Licence: CC-BY-4.0 + ECMWF Terms of Use (ECMWF open data page). Attribution required.
- URL pattern: `https://data.ecmwf.int/forecasts/{YYYYMMDD}/{HH}z/ifs/0p25/oper/{YYYYMMDD}{HH}0000-{step}h-oper-fc.grib2`
- Each file has a `.index` (JSON lines with `_offset`, `_length`). The server returns HTTP 206 for
  `Range` requests, so one `tp` message (~0.4–0.5 MB) is downloaded instead of the 57–101 MB file.
  This reduces transferred bytes (verified: 49 steps = 23.6 MB total).
- Retention on the server: latest 12 runs (~2–3 days), so historical runs cannot be re-fetched later.

## `tp` semantics
- `shortName=tp`, `paramId=228`, `units=m`, `stepType=accum`, `stepRange=0-N` for every step.
  => **cumulative since forecast start**, in **metres of water**; convert to mm with ×1000.
- AIFS Single (not used here) differs: paramId 228228, units `kg m**-2` (= mm). Units must be
  read from the GRIB, never assumed.
- Step 0 exists and is all zeros.
- 00 UTC run: steps 0..144 every 3 h are all present (49 messages). No accumulation reset observed.

## Grid
- `regular_ll`, 1440×721, 0.25°, lat 90→−90 (north to south, `jScansPositively=0`).
- **Longitude starts at 180° and wraps** (180…359.75, then 0…179.75). Columns must be reordered
  before cropping. India box 66–100°E is contiguous in the file's 0–179.75 half; 6–38°N.
- `bitmapPresent=0`: no missing values in these messages.

## Negative differences between consecutive steps (investigated, not clipped)
Differencing consecutive cumulative fields gave small negatives at steps 6, 9, 48, 111
(−0.03 to −0.12 mm). Cause: GRIB simple packing at 12 bits/value. Each message's values are exact
multiples of its own quantum `q = 2**binaryScaleFactor` (q = 3.05e-5 m at step 3 … 2.44e-4 m at
step 144; verified). Each stored value has error ≤ q/2, so a difference of two steps can be
wrong by up to (q_prev + q_cur)/2. All observed negatives are within that bound
(e.g. step 6: −3.05e-5 vs bound 4.6e-5). Rule used in processing: a negative difference no more
negative than −(q_prev+q_cur)/2 is treated as packing noise and set to 0; anything larger raises
an error. Consequence: interval totals have uncertainty up to ~0.1–0.25 mm per cell from packing alone.
