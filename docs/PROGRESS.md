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
- [ ] M3: map, timeline, location view
- [ ] M4: usability + scientific explanations
- [ ] M5: verify, deploy, document
