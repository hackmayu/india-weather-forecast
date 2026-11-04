# Git history rewrite (2026-11-04)

**What happened.** After the repository had been pushed to GitHub, the applicant asked for "Claude" to be removed from the
GitHub contributors list. That list is derived from the `Co-Authored-By: Claude ...` line that was appended to the commit
messages. Claude explained the consequences (all commit IDs change, which affects the alignment between the git history and
the session log; and the line is the place where git itself records the assistance) and the applicant confirmed ("Yes, rewrite it").

**What was changed.** Only the `Co-Authored-By: Claude ...` line was deleted from the message of 21 of the 22 commits that existed.
Nothing else: the file contents of every commit are byte-identical (the tree hash of each commit is unchanged), and the author,
committer, dates and subject lines are unchanged. The history was force-pushed to `main` on GitHub.

**What was NOT changed.** The AI-assistance disclosure remains in `README.md` ("Transparency disclosure") and `docs/PROGRESS.md`,
and the session log (the raw `.jsonl`) still records every step, including this one.

**Matching the session log.** The session log contains the commit IDs from before the rewrite. Use this table to find the
corresponding ID in the rewritten history. Commits made after the rewrite (including the one that added this file) have no old ID.

| # | Old commit ID (in the session log) | New commit ID (on GitHub) | Subject |
|---|---|---|---|
| 1 | `7ca186e` | `b1d9a67` | M1: scaffold project, range-based ECMWF tp fetch, data notes |
| 2 | `cfd8089` | `72d2ecd` | M2: processing pipeline, processed store, FastAPI endpoints, tests |
| 3 | `d355a11` | `945d6a1` | M3 (WIP): React/TS frontend with map, timeline, location panel; FastAPI serves build |
| 4 | `3e0e133` | `149716c` | M3: verified map/timeline/location UI; rain story treats <0.5 mm as trace |
| 5 | `ef511c5` | `ead045c` | Fix API test that depended on static frontend mount |
| 6 | `26893ea` | `1b09010` | Deployment: in-app refresher, snapshot seeding, status endpoint, Render blueprint |
| 7 | `3a9a082` | `4b4c929` | Backend: add 2 m temperature, cloud cover and 10 m wind from the same IFS run |
| 8 | `0cd277b` | `97ff0e4` | Frontend: smooth radar-style map, basemap with labels, cross-fade, temperature/cloud/wind |
| 9 | `6f6bb5d` | `61526cc` | Accessibility: skip link to location chooser, reduced-motion respected |
| 10 | `83febef` | `312603d` | README, gzip for API responses, progress log |
| 11 | `20d0349` | `b79f20a` | Backend: record ECMWF publish time per run, poll for new runs every 10 min |
| 12 | `d62b55b` | `36891b5` | Real-time upgrade: now marker, live status bar, auto-switch to new runs, run comparison, dark theme |
| 13 | `add7e1e` | `7447bc2` | Usability: shareable links, chart hover, 24 h summary, CSV, city search, my location, shortcuts |
| 14 | `7925575` | `269c3c4` | Add deployment checklist (docs/DEPLOY.md) |
| 15 | `bdc48a0` | `c396799` | Snapshot: 2026-11-04 00 and 06 UTC runs (with publish times); render service name and python -m uvicorn |
| 16 | `c19f3e4` | `abb02c5` | Features: rain window totals, Next 24 h, cities at a glance; narrow-layout legend fix |
| 17 | `70ad98b` | `cca5479` | Add official ECMWF ENS rain probabilities (Rain chance view + per-place table) |
| 18 | `fb7b2bc` | `c718903` | Vercel static mode: browser data engine, static export, live publisher + Action, overview, manifest |
| 19 | `5c734fd` | `c243859` | Poll status every 5 s while a refresh check is running |
| 20 | `9e2a387` | `c8d4aa7` | Easier-to-use UI: compact status line, plain-language rain choices, day shortcuts, place summary tiles |
| 21 | `2f49a32` | `bbb8d40` | Stop tracking data/processed (regenerated output, already gitignored) |
| 22 | `7d493a6` | `a08cad9` | README: architecture section (7 diagrams) and screenshots; compact phone tables; weather tabs fit on phones |

Full 40-character IDs are in `git log`. A local backup of the pre-rewrite history was kept outside the repository during the rewrite.
