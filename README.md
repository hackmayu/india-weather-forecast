# India Weather Forecast Explorer

An interactive explorer for **ECMWF IFS HRES open-data forecasts over India**: where and when rain is
forecast, how much falls in a clearly stated interval, plus 2 m temperature, cloud cover and 10 m wind
from the same model run. Built for the QUEST Lab Full Stack AI pre-doctoral application,
Project 1 ("Precipitation forecast app").

> **Status of this document.** It describes what exists in this repository. Items that depend on the
> deployment (live URL, final commit id) are listed in [Deployment](#deployment) as *pending* until they
> have actually been done and checked. Nothing here is a claim about results that were not observed.

## Transparency disclosure

- The initial prompt and the project scope were drafted with help in a **separate chat**. No project code
  or application was written there.
- All implementation, testing, and Git commits were done in **one Claude Code session**. The code was
  written by Claude (Claude Sonnet 5.5) at the applicant's direction; decisions and who made them are in
  [`docs/PROGRESS.md`](docs/PROGRESS.md).
- Session start: **2026-11-04 14:49:20 +05:30**. Deadline for the final commit: **2026-11-07 14:49 +05:30**.

## "Real-time": what it does and does not mean

The app shows the **newest published ECMWF model run**. It is near-real-time, not a nowcast and not a
forecast produced by this project.

- A background refresher checks ECMWF every **10 minutes** and processes a newer run as soon as it is complete.
  The browser asks the server what it has every 45 s and, with **Auto-switch** on (default), moves to the new
  run while keeping the selected time and place (a notice is shown; with it off, a banner offers the new run).
- On opening, the timeline jumps to **now** (the interval that contains the current time); a **Now** button and
  a *now* marker on the slider and charts show where the current time falls. Steps before now are labelled
  "Past model step": they are the model's values for times that have passed, **not observations**.
- A status bar shows run issue time, when ECMWF **published** it (`Last-Modified`), data age, the next run's
  expected time and the time of the last server check. The expected time uses a *typical* delay measured on
  the 9 runs of 2026-11-02..04: 00/12 UTC runs appeared 7.57 h and 06/18 UTC runs 6.45 h after issue time.
  It is an estimate, not a guarantee.
- **Run-to-run comparison:** the selected place in the previous run vs the current run over the shared period
  (a forecast change, not a probability).
- Limits: ECMWF issues a run every 6 h and it appears 6.5-7.6 h later, so the newest run always starts in the
  past. On the free host the service sleeps when idle (see Deployment); an optional workflow
  (`.github/workflows/keepalive.yml`, inert until you set `KEEPALIVE_URL`) can keep it awake.

## Problem and intended users

Raw forecast files are hard to read: precipitation is stored as an *accumulation since the start of the
forecast*, in units that differ between models, on a grid that wraps around the globe. This app does the
careful bookkeeping and shows the result so that a curious person can answer:

- Where is precipitation forecast? When? How much, **over which interval**?
- Which model run produced it, and how old is the data?
- What can and cannot this forecast tell me?

Intended users: students, researchers and the general public exploring a deterministic forecast. It is
**not** a warning service (see [Limitations](#known-limitations-and-unsupported-use)).

## Data source, model and attribution

| | |
|---|---|
| Provider | ECMWF Open Data (real-time) |
| Model | IFS HRES, deterministic (`stream=oper`, `type=fc`), 0.25° global grid |
| Licence | CC-BY-4.0 and the ECMWF Terms of Use |
| Required attribution | "Contains modified ECMWF Open Data (IFS)" (shown in the footer and map). Exact wording rules are in the ECMWF Terms of Use. |
| Server retention | Latest ~12 runs (~2–3 days), so older runs cannot be re-fetched |
| Basemap | © OpenStreetMap contributors, OpenMapTiles, served by OpenFreeMap (no key, no cookies) |

**Why IFS rather than AIFS:** IFS HRES has 3-hourly steps (AIFS Single is 6-hourly), and its `tp` semantics
were verified directly in the GRIB headers. AIFS can be added through the same pipeline; note it encodes
`tp` in `kg m**-2` (= mm) while IFS uses metres, so units are read from every message, never assumed.

### Variables, units, issue times and valid times

| Variable | GRIB | File units | Kind | Shown as |
|---|---|---|---|---|
| Total precipitation | `tp` | m | **accumulated since issue time** (`stepRange` 0–N) | mm of water; *interval* = difference of two steps, *cumulative* = as stored |
| 2 m temperature | `2t` | K | instantaneous | °C |
| Total cloud cover | `tcc` | (0–1) | instantaneous | % |
| 10 m wind | `10u`, `10v` | m s⁻¹ | instantaneous | m/s; speed = √(u²+v²) |

- **Issue time** = model run time (00/06/12/18 UTC). **Valid time** = issue time + step.
- 00 and 12 UTC runs: 3-hourly steps to +144 h (49 steps). **06 and 18 UTC runs: only to +90 h** (31 steps),
  because ECMWF publishes fewer steps for those runs. The app shows whichever run is newest, so the visible
  horizon changes between 90 h and 144 h.
- Times are shown in local time or UTC (toggle), always with the zone name.

Verified details (observed on real data, see [`docs/DATA_NOTES.md`](docs/DATA_NOTES.md)): `tp` is
cumulative with no resets over 0–144 h; the grid is 1440×721, latitude north→south, **longitude starts
at 180° and wraps**; no bitmaps/missing values in these messages.

## Processing and accumulation assumptions

1. **Source-side selection.** Each GRIB file has a `.index` with byte offsets and the server supports HTTP
   Range requests (verified: 206). Only the needed fields are downloaded (about 0.3–0.7 MB each instead of
   57–101 MB files). This reduces the bytes transferred; it is not just cropping after download.
2. **Units** are read from each message and converted explicitly; unknown units raise an error.
3. **Longitudes** are sorted before cropping to the India box (6–38°N, 66–100°E → 129×137 cells).
4. **Interval totals** = differences of consecutive cumulative fields using the *actual* step numbers.
5. **Packing noise.** Messages are stored with 12-bit packing, so every value is a multiple of a
   per-message quantum (e.g. 0.12–0.24 mm late in the run). Differences can therefore be slightly negative
   (observed −0.03 to −0.12 mm). Rule: a negative within the worst-case packing error
   `(q_prev + q_cur)/2` is set to 0 **and counted**; a larger negative raises an error (possible reset).
   Consequence: interval totals carry up to ~0.25 mm of packing uncertainty, amounts under ~0.25 mm are
   indistinguishable from zero, and the raw cumulative series can dip very slightly (kept as stored by
   decision of the applicant).
6. **Instantaneous variables** are never differenced; values outside plausible ranges (e.g. 2 m
   temperature outside −90…60 °C, cloud outside 0…100 %) raise an error instead of being displayed.
7. **Display smoothing** (bilinear interpolation between cell centres) is applied only when painting the
   map, can be switched off, and never changes the API or the hover/location values.

## Location-selection method

A location query returns the **nearest 0.25° grid cell** (about 28 km). There is **no interpolation**, and
the response states this together with the actual grid-cell centre. Coordinates outside 6–38°N, 66–100°E
are rejected (HTTP 422) and the UI explains why.

## Architecture and data flow

```
ECMWF Open Data (data.ecmwf.int)
   │  .index + HTTP Range, 6 parallel workers            backend/precip/fetch.py
   ▼
data/raw/ifs/<run>/<param>_<step>.grib2   (gitignored)
   │  decode, unit-convert, crop, difference, validate   backend/precip/process.py
   ▼
data/processed/<run>/{arrays.npz, meta.json}  (atomic publish; gitignored)
   │  read-only access                                   backend/precip/store.py
   ▼
FastAPI  (backend/precip/api.py)  ──►  /api/*  JSON      + serves frontend/dist
   ▲                                                      ▲
   │ background refresher (backend/precip/refresh.py)     │
   │ seeds from data/snapshot/ on a cold start            │
   └──────────────────────────────────────────────────────┘
React + TypeScript + MapLibre (frontend/)  ──►  map, timeline, location panel
```

User requests never download or process data. Refreshing runs in a separate thread.

## How to run

Prerequisites: Python ≥ 3.10, Node ≥ 18, git. (Developed and tested on Windows 11, Python 3.12, Node 24.)

```bash
# 1. backend environment
python -m venv .venv
. .venv/Scripts/activate            # Windows Git Bash; on Linux/macOS: . .venv/bin/activate
pip install -e "backend[dev]"

# 2. download + process the newest complete ECMWF run (~84–134 MB download, 1–4 min)
cd backend && python -m precip.process && cd ..

# 3. frontend
cd frontend && npm ci && npm run build && cd ..

# 4. serve API + built frontend on http://127.0.0.1:8000
cd backend && python -m uvicorn precip.api:app --port 8000
```

Development with hot reload: run step 4 and, in `frontend/`, `npm run dev` (Vite proxies `/api` to port 8000).
Interactive API docs: `http://127.0.0.1:8000/docs`. Optional settings are listed in
[`.env.example`](.env.example) (no secrets are required).

### Verification commands

```bash
cd backend  && python -m pytest -q          # 44 tests
cd frontend && npx vitest run && npx tsc --noEmit && npm run build
```

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | liveness |
| `GET /api/ready` | 200 when ≥1 processed run exists, else 503 |
| `GET /api/status` | latest run id and background-refresh state |
| `GET /api/runs` | processed runs with age and stale flag |
| `GET /api/runs/{run_id}` | metadata, provenance, freshness, attribution (`latest` accepted) |
| `GET /api/runs/{run_id}/times` | valid times and the interval each step closes |
| `GET /api/runs/{run_id}/map?step=&variable=&kind=` | regional grid; `variable` = precip, temp, cloud, wind; `kind` = interval or cumulative (precip only) |
| `GET /api/runs/{run_id}/point?lat=&lon=` | time series at the nearest grid cell |

Validation: run id pattern, step must be a real step of the run, `kind`/`variable` enums, finite in-domain
coordinates; failures return 404/422/503 with a readable message. Map payloads are JSON at 0.1 mm
(precip/temp/wind) or 1 % (cloud) precision. Measured for one step: 143 KB (rain), 211 KB (temperature),
84 KB (cloud), 841 KB (wind, includes u and v) uncompressed, and 7, 19, 15 and 71 KB over the wire with gzip,
which is enabled. Plain JSON was chosen for simplicity; a binary format would only matter at larger scale.

## Code walkthrough

Backend (`backend/precip/`)
- `config.py` – region, horizon, source URL, parameters and environment switches.
- `fetch.py` – finds the newest *complete* run, reads each step's `.index`, downloads single fields by
  Range, validates GRIB framing/length, writes atomically; idempotent and resumable.
- `process.py` – all scientific processing described above; publishes a run directory only when complete.
- `derive.py` – meteorological wind direction.
- `store.py` – read-only loading with a cache invalidated when a run changes.
- `refresh.py` – cold-start seeding from the snapshot and the background refresh thread.
- `api.py` – endpoints, validation, freshness logic, static frontend mount.

Frontend (`frontend/src/`)
- `App.tsx` – state: variable, kind, time, location, polling for newer runs; layout and banners.
- `MapView.tsx` – MapLibre map, hosted basemap with offline fallback (`fallbackStyle.ts`), two image layers
  for cross-fading, wind arrows, selection marker.
- `render.ts` – paints grids to a Mercator-aligned canvas (smooth or raw), builds wind arrow geometry.
- `colors.ts` – colour scales (radar, colour-blind-friendly, ramps) and value→colour mapping.
- `Legend.tsx`, `Timeline.tsx`, `LocationPanel.tsx` – legend, play/pause + slider + time list, charts/table.
- `rainStory.ts` – deterministic "rain story" calculations; `time.ts` – time zone formatting; `api.ts` – typed client.

Tests: `backend/tests/` (synthetic unit/API tests, clearly labelled; plus real-data tests that re-read the
source GRIB independently) and `frontend/src/*.test.ts`.

## The "rain story"

A short text computed only from the selected cell's series: total over the horizon, largest interval,
largest 24 h amount (difference of cumulative values 24 h apart), first interval with ≥ 1 mm, plus
temperature range, strongest wind and mean cloud cover. A cell where no interval reaches 0.5 mm is
described as essentially dry because such amounts are within the data's precision. No probabilities,
observations, alerts, accuracy claims or advice are generated, and no external AI service is used.

## Verification results

Observed during development (2026-11-04), not aspirational:

- **Backend: 44 tests pass.** Includes synthetic tests for unit conversion, unequal step spacing, packing
  noise vs. a real reset error, longitude wrapping, API validation, wind direction.
- **Real-data checks:** processed values at five places and at the wettest cell (17.25°N 81.5°E,
  75.3 mm in 3 h) match values read straight from the source GRIB with eccodes' own nearest-point search
  (to 0.01 mm for precipitation; 2 m temperature, cloud and wind within their packing precision).
- **Reproducibility:** re-downloading the 00 UTC run on an empty disk produced raw-message SHA-256
  checksums identical to the first download, and the same counts (3073 packing-noise cells zeroed).
- **Frontend:** 24 unit tests (colour scales, display interpolation, wind arrows, now/next-run time logic, run comparison), strict TypeScript, production build.
- **Browser checks (desktop and 375 px wide):** map overlay, click selection, outside-domain message,
  play/pause, variable switching, basemap fallback (simulated unreachable basemap), no horizontal overflow.
- **Newer-run path with real data:** with only the 00 UTC run served, then the 06 UTC run added, (a) with
  Auto-switch off the page announced the newer run without swapping data and loaded it on request; (b) with
  it on the page switched by itself within the 45 s poll and kept the selected valid time and place.
- **Keyboard:** radio arrow keys change variable, Enter on a place button selects it, slider arrow keys
  step time with a spoken value, a skip link jumps to the location chooser; all 26 controls have names.
  Not done: testing with an actual screen reader.
- **Cold-start refresh:** on an empty disk the refresher downloaded and processed a run in 52 s
  (precipitation only) and ~3 min 18 s for all five variables.

## Deployment

Target: one **free Render web service** (`render.yaml`) serving the API and the built frontend.
Facts checked in Render's docs on 2026-11-04: free services spin down after 15 minutes without traffic,
have an ephemeral disk, 750 free instance hours per month, and cannot run cron jobs; the native Python
runtime includes Node/npm. Not verified: the RAM limit, and that `eccodes` installs on Render's Linux build.

Refresh strategy: a dated real snapshot (`data/snapshot/`) seeds the disk on every cold start so the app is
never blank; a background thread then fetches any newer run (check every 10 min while awake). **While the
service is asleep nothing refreshes**, and the first visitor after a wake-up sees the snapshot (labelled
with its true age, flagged stale) for roughly 1–4 minutes. The UI says when a refresh is running and offers
the new run when ready. This is not a continuously updated service.

**Pending (not yet done at the time of writing):** public repository, Render service, live URL and its
verification, final commit id. See "Final deliverables" below once filled.

## Known limitations and unsupported use

- One **deterministic** model run: no probabilities or uncertainty ranges; later runs may differ a lot.
- 0.25° (~28 km) grid cells; it cannot represent street-level or convective-scale detail. Smoothing in the
  display adds no information.
- Rain amounts below ~0.25 mm are within packing precision; interval totals are uncertain by that much;
  raw cumulative values can dip slightly; cloud cover is stored to ~1 %.
- No observed rainfall, no model skill/accuracy claims, no official alerts, no safety or travel advice.
  Do not use it to make safety decisions; use your national weather service.
- 06/18 UTC runs only reach +90 h.
- The hosted basemap is an external dependency (a fallback outline map is used if it cannot be loaded), and
  its boundaries are those drawn by OpenStreetMap contributors; they may not match India's official map.
- Free hosting sleeps and has an ephemeral disk (see Deployment). Only Windows 11 was used for development.
- Only India (6–38°N, 66–100°E) is covered.

## Final deliverables

To be filled in only when each item has been done and checked:

- Live URL: **pending**
- Git repository: local repo `quest-precip`; remote **pending**
- Final commit id: **pending**
- Session log: `C:\Users\jalan\.claude\projects\C--Users-jalan-ppt\aadb2182-faa2-485c-a38f-7534910abdd7.jsonl`
  (Claude Code writes it as the session runs; submit that file unedited, after the session's final
  message. Other `.jsonl` files in the same folder belong to other sessions and must not be included.)
