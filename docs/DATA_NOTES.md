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

## Additional variables (verified 2026-11-04, same run)
Fetched per step by the same index+Range method (5 messages/step, 245 per run, ~134 MB per run).
| param | GRIB name | units in file | stepType | packing | app unit |
|-------|-----------|---------------|----------|---------|----------|
| 2t  | 2 metre temperature | K | instant | 9 bits (~0.2 K) | degC = K - 273.15 |
| tcc | Total cloud cover | (0 - 1) | instant | 7 bits (~1 %) | % = x100 |
| 10u / 10v | 10 metre U/V wind | m s**-1 | instant | 11 bits (~0.03 m/s) | m/s; speed = hypot(u,v) |
- All instantaneous: valid at the step time, never differenced, step 0 is valid.
- Wind direction is reported as the meteorological "from" bearing: `(270 - atan2(v,u)) mod 360`.
  Map arrows point the way the air moves (toward), which is the opposite bearing.
- Processing rejects values outside plausible ranges (2t -90..60 degC, tcc 0..100 %, wind |u|,|v| <= 120 m/s).
  Observed in run 2026-11-04 00 UTC over India: 2t -32.2..39.0 degC, wind max 12.9 m/s.
- Display smoothing (bilinear between cell centres) is applied only when drawing the map; the API and the
  hover/location readouts always use the 0.25 deg cell values.

## ECMWF ENS probability products (verified 2026-11-04, run 2026-11-04 00 UTC)
Source: `.../ifs/0p25/enfo/<run>-240h-enfo-ep.grib2` (+ `.index`, Range-requestable; 643 MB file, we fetch 66 messages = 23 MB).
- Parameters `tpg1, tpg5, tpg10, tpg20, tpg25, tpg50, tpg100`; we use 1, 5, 10, 25, 50, 100 mm.
- Decoded message (tpg10, 24-48): name "Total precipitation of at least 10 mm", paramId 131062, units `%`,
  productDefinitionTemplateNumber 9 (probability forecast), probabilityType 3 (above lower limit),
  lowerLimit 10 (scale factor 0), stepType accum, lengthOfTimeRange 24, regular_ll 1440x721, 12 bits/value,
  no bitmap, values 0..100.
- Windows ("0-24", "12-36", ..., "216-240"): 24 h long, a new one every 12 h; we use the 11 that end by +144 h.
- Availability: files exist for 00 and 12 UTC runs only; for 06 and 18 UTC the `enfo` `ef` files exist but there
  is no `ep` file. Last-Modified: 08:01 UTC (00 run) and 20:01 UTC (12 run), i.e. about 8 h after issue time.
- Processing verifies shortName, units, template number, probability type, step range, length, grid, bitmap,
  issue time and that the lower limit equals the threshold; values must be 0..100 (+-0.1) and the chance must be
  non-increasing with the threshold (tolerance 0.5 %; observed worst excess 0.2 %).
- Stored as uint16 tenths of a per cent (447 KB for the whole run).
- Cross-check with the deterministic run: identical lat/lon grids. 0-24 h window: mean P(>=1 mm) is 87.9 %
  where the deterministic total is >= 2 mm (4,496 cells) and 0.99 % where it is < 0.1 mm (7,732 cells);
  P(>=25 mm) averages 71.6 % where the deterministic total is >= 50 mm (24 cells).

## World overview layer (added 2026-11-05)
The World view in the app shows rain, temperature, cloud and wind for the whole globe. It is derived from the same global ECMWF Open Data
fields that are downloaded for India (no extra downloads): `backend/precip/world.py` takes the mean over 8 x 8 blocks of 0.25 deg cells, i.e. a
2 deg grid (90 x 180). Decisions and limits:
- Values are block MEANS. Averaging smooths extremes; a 2 deg rain cell shows much less than the 0.25 deg peak inside it. The India view stays at 0.25 deg.
- Precipitation: means of the cumulative fields; intervals are differences of those means (linear), negatives floored at 0 as for India.
- Wind: u and v are averaged separately; speed = hypot(mean u, mean v), the speed of the mean wind (lower than the mean speed where direction varies in a block).
- Longitudes are converted to -180..180 and sorted before blocking (the file starts at 180 E). The single south-pole row is dropped (720 of 721 rows used).
- No place forecasts or rain probabilities outside India; probabilities are India-only in the World view.
- API: `GET /api/runs/{id}/map?...&scope=world`. Static files: `runs/<id>/world/*.bin`. Parity with the real API is tested (`src/world-golden.json`).
- Data fetching (same day): run-addressed API responses carry `Cache-Control: max-age=900`; the static engine reuses `index.json` for 20 s instead of
  re-downloading it before every request; identical in-flight GETs share one request.

### Detailed 0.5 deg world (added 2026-11-05, same block-mean rules)
`world.build50` averages 2 x 2 blocks of the global 0.25 deg fields to a 360 x 720 grid and stores it quantised (rain: cumulative, 0.1 mm; temperature
0.1 degC; cloud 1 %; wind components 0.01 m/s). Exported as ONE FILE PER VARIABLE AND STEP (`runs/<id>/w50/<key>_<step index>.bin`, about 0.3-1 MB gzipped each),
so the browser downloads only the time step on screen. Rain intervals/windows are differences of the cumulative files, floored at 0.
Measured real sizes of one global 0.25 deg step (gzip): rain 0.57 MB, temperature 0.52, cloud 0.47, each wind component 1.2 MB -> about 200 MB per run
at full 0.25 deg, which is why the world layer is 0.5 deg. At 0.5 deg a newest run is about 75-120 MB raw (all steps, all variables).
- Only the NEWEST run carries these files (the Action removes them from older runs) and they are NOT committed to `main` (`.gitignore`); a build from
  `main` alone therefore falls back to the committed 2 deg world layer automatically. They appear after the first run of the publish Action, or locally with
  `python -m precip.export_static --world50 ...`.
- Consistency check (tested): the mean of every 4 x 4 block of the 0.5 deg field equals the independent 2 deg field within display rounding.
- Not verified: a real run of the GitHub Action with these files, and the size/time of the force-push of the `vercel-live` branch.
