# Progress and transparency log

## Application context
QUEST Lab Full Stack AI Pre-doctoral application, Mayur Jalan, 2026-11-04 14:49 IST (+05:30).

- Session start: **2026-11-04 14:49:20 +05:30** (09:19:20 UTC), taken from the system clock.
- 72-hour deadline: **2026-11-07 14:49:20 +05:30** (09:19:20 UTC).

## Disclosure (written by the applicant's instruction)
The initial prompt and project scope were drafted with help in a separate chat. No project code
or application was developed there. Implementation, testing, deployment and commits happen in
this single Claude Code session. Code in this repository is written by Claude in this session
at the applicant's direction; decisions are recorded below with who made them.

## Decisions
| When | Decision | Made by |
|------|----------|---------|
| 2026-11-04 | IFS HRES 0.25°, India box 6–38°N / 66–100°E, 0–144 h at 3 h, keep 4 runs | Applicant approved Claude's proposal |
| 2026-11-04 | Negative cumulative differences within packing quantum treated as noise; larger → error | Claude proposed, applicant accepted |
| 2026-11-04 | API serves source cumulative values as-is (can dip by <=1 quantum between steps; 3073 of 848304 cell-steps in run 2026110400) | Claude, OPEN for applicant review |

## Checklist
- [x] Environment inspected, start time recorded
- [x] ECMWF docs + live server checked (see `DATA_NOTES.md`)
- [x] M1: real tp series fetched (49 steps, 23.6 MB) and interpreted
- [x] M2: processing + minimal backend (26 tests pass; wet-cell values match source GRIB)
- [x] M3: map, timeline, location view (checked in browser at desktop and 375px mobile: map, click select, outside-domain message, play/pause; keyboard & screen-reader pass still TODO)
- [x] M4: usability + scientific explanations (keyboard checks done; screen reader NOT tested)
- [ ] M5: verify, deploy, document (deploy config + in-app refresh written; refresh path verified on cold disk: 52 s, checksums match; live Render deploy pending applicant signup)

## Deployment decision (2026-11-04)
Applicant chose a free host with the applicant doing the signup. Claude proposed Render free web
service (Render docs, checked 2026-11-04: spins down after 15 min idle, ephemeral disk, 750 free
instance hours/month, no free cron jobs; native Python runtime includes Node/npm; RAM figure NOT
verified). Refresh therefore runs inside the app (`precip/refresh.py`) seeded by a dated snapshot.
Hugging Face Spaces was rejected: community posts conflict on whether free Docker Spaces still exist.

## Realism upgrade (2026-11-04, requested by applicant)
Applicant asked for a more realistic UI and forecast presentation and selected all four options:
smooth radar-style map, richer basemap/labels, animation polish, more ECMWF variables.
- Done: smooth radar-style rendering (toggle to raw cells), OpenFreeMap basemap (Light/Detailed) with
  an offline fallback, cross-fade between time steps, 2 m temperature / cloud cover / 10 m wind with arrows.
- Not done on purpose: synthetic "rain motion" particles. They would show movement that is not in the data;
  the cross-fade only blends the display of two real time steps.
- This cannot make the underlying forecast more accurate; it changes how it is shown and what is shown.
- Cost: run payload grew from ~24 MB to ~134 MB per refresh (about 3 min cold fetch).

## 2026-11-04 evening (resumed 19:20 IST, 67.5 h before deadline)
- Live check of the newer-run path with real data (00 UTC served, 06 UTC added): banner appeared, data not swapped, loaded on request.
- README written; gzip added to the API (wind field 841 KB -> 71 KB over the wire).
- Waiting on applicant: GitHub repository URL and Render account (applicant's own steps).

## Real-time upgrade (2026-11-04 evening, requested by applicant: "improve the ui more and real time forecasting")
- Interpretation (Claude's, stated to applicant): "real time" = near-real-time pickup and presentation of the newest
  ECMWF run, not a self-made forecast or nowcast, and no non-ECMWF data (observations would break the brief).
- Measured ECMWF publish delay from Last-Modified on 9 runs: 00/12 UTC +7.57 h, 06/18 UTC +6.45 h.
- Added: 10-min refresh polling, published time in meta, Now button/marker, past/now/future labels, status bar,
  auto-switch to new runs (keeps time and place), previous-run comparison, dark theme (auto/light/dark),
  optional inert keep-alive workflow.
- Verified with real data: auto-switch 00 UTC -> 06 UTC kept place and valid time.

## Usability round (2026-11-04 evening, requested by applicant: "more improve the app")
Claude chose: shareable URL state, chart hover values, 24 h block summary, CSV download, city search +
use-my-location, keyboard shortcuts, error boundary. Verified in browser with real data except the geolocation
success path (permission denied in the test browser).

## Features round 3 (2026-11-04 night, applicant: "make the project more good and add more features")
- Added rain window totals (API `kind=window&hours=`) with a Next 24 h button and a cities-at-a-glance table.
- Found officially published ECMWF ENS probability products (`tpg1..tpg100`, 00/12 UTC runs only, 24 h windows).
  NOT implemented: it changes the project's "no probabilities" position and adds data/validation work, so it is
  offered to the applicant as a decision.
- Clean-clone deployment rehearsal (fresh venv, npm ci, build, cold start): API, frontend and snapshot seeding
  work; one first attempt showed only one of two snapshot runs seeded and could not be reproduced in two further
  cold starts (cause unknown; seeding code reviewed and unit-tested).

## ECMWF probabilities added (2026-11-04 night; applicant answered "Yes, add them")
- Decision (applicant): add official ECMWF ENS probabilities, which changes the earlier "no probabilities" position.
  Constraint kept: no probability is computed by this project; only ECMWF's published `ep` products are shown.
- Built: precip/ens.py (fetch+validate+process), store_ens.py, api_ens.py, refresher integration (never breaks the
  deterministic refresh), snapshot data/snapshot/ens/, frontend Rain chance tab + per-place table, tests.
- Verified against source GRIB (144 comparisons) and against the deterministic run (see DATA_NOTES.md).
- Claude judgement calls for the applicant to review: thresholds 1/5/10/25/50/100 mm (20 mm skipped as close to 25);
  integer-% display with conventional rounding; nearest-window-end mapping from the 3-hourly timeline.

## Vercel / static mode (2026-11-04 night; applicant: "add more features and make it like we can publish it ... vercel ... as live link")
- Interpretation (Claude): add Vercel as an additional publishing target, usable without Render.
- Constraint found: Vercel free has no background threads, read-only filesystem, daily-only cron. So: static export +
  browser data engine + GitHub Action publishing to `vercel-live`. Rejected: serverless FastAPI (file inclusion and
  build-order behaviour not verifiable without a Vercel account) and committing data to `main` from a bot (would
  break the rule that the project's Git history is the session's own commits).
- Verified locally: parity tests (25) vs real API outputs; mutation checks; static site served by a plain file
  server with zero API calls; publisher run with real downloads (1 m 42 s, carried over previous run); Action shell
  steps replayed against a local bare repo. NOT verified: an actual Vercel deploy and an actual GitHub Actions run.
- Bug found by tests during this work: publisher crashed when no ENS run was available (fixed, tested).
- New features: India overview card, installable manifest/icon.

## Easier-to-use / nicer UI round (2026-11-04 night; applicant: "make the interface more easy to use" and "more good ui")
- Claude's diagnosis (from watching the app used): technical status chips crowded the top, the map sat far down, rain options
  used jargon, the place results were hidden below other cards (and off-screen on phones), there was no guidance for a new visitor.
- Changes: compact status line, plain-language rain chips, day shortcuts, place summary tiles first, auto-scroll on phones, last place
  remembered, first-visit guide, bigger touch targets, stray blank gap removed. Helpers (day shortcuts, place headline, rain presets) have unit tests.
- Process note: one browser navigation of mine overwrote the applicant's open GitHub tab; it was restored to github.com/hackmayu and later tests used a separate tab.

## Git history rewrite to remove Claude from the contributors list (2026-11-04)
- Request (applicant): "in contributors please remove claude"; Claude first stopped adding the co-author line to new commits and
  asked before touching existing history, listing the consequences; applicant answered "Yes, rewrite it".
- Done: only the Claude co-author line was removed from 21 commit messages; all 22 trees, authors, dates and subjects verified
  identical; force-pushed with a lease. Old-to-new commit IDs are in `docs/history-rewrite-map.md` so the session log can be matched.
- The assistance disclosure in README.md and this file is unchanged.

## Vercel configuration (2026-11-04)
- Vercel's import screen suggested a two-service layout. Applicant decision: option A (frontend-only service `web`, no backend, no bindings);
  Vercel showed only the suggestion, no error. Config validated against Vercel's JSON schema; not run on Vercel yet.
