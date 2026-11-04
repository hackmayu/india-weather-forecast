# Deployment checklist

Two independent options: **Vercel (static, recommended for a quick live link)** and **Render (FastAPI backend)**.
Sections 1-2 (GitHub) are needed for both.


Steps marked **YOU** need your own accounts or credentials; Claude cannot and will not do them.
Facts about Render were checked in its docs on 2026-11-04: free web services spin down after 15 minutes
without traffic, have an ephemeral disk, 750 free instance hours per month, and no cron jobs.
**Unverified until the first deploy:** the RAM limit and whether the `eccodes` wheel installs on Render's
Linux build. If the build fails, send the last 40 lines of the build log.

## 1. GitHub (YOU)
1. Create an **empty public** repository (no README, no licence, no .gitignore).
2. Send Claude its URL, e.g. `https://github.com/<you>/india-weather-forecast.git`.

## 2. Push (Claude prepares, YOU run)
Claude adds the remote and refreshes `data/snapshot/` to the newest run, then gives you:

```bash
cd C:/Users/jalan/ppt/quest-precip
git push -u origin main
```
Git will ask you to sign in to GitHub in your own browser or credential manager. Do not paste tokens into chat.

## 3a. Vercel (YOU) - static site, no server

Facts: Vercel's free (Hobby) plan has no background jobs and a read-only function filesystem, so the live refresh is
done by a GitHub Action instead (see below). Not verified on Vercel itself: this repo's build was rehearsed locally
(clean-clone build with the exact commands, plain file server with no backend, the Action's shell steps against a local bare repository).

**Quick live link (dated snapshot, works immediately after the push)**
1. Sign in at vercel.com (GitHub sign-in is simplest). **Stop and tell Claude if it asks for a card or a paid plan.**
2. Add New... -> Project -> import `india-weather-forecast`.
3. Vercel lists two detected apps: `backend` (FastAPI, /api) and `frontend` (Vite, /). Click **Import single project** next to **frontend**.
   Do **not** use the "Services" preset: it would try to deploy the FastAPI backend, which does not belong on Vercel (see the note below).
4. Leave the settings as they are (Root Directory = `frontend`). `frontend/vercel.json` already sets the install command, the build command
   (`npm run build:static`), the output directory (`dist`) and the cache headers.
5. Deploy. The link serves the committed snapshot, labelled **Static snapshot** (it does not update by itself).

**Live updates (recommended)**
6. GitHub -> repository -> Actions -> **Publish static site (Vercel)** -> Run workflow (tick "force" the first time).
   Wait ~3-5 minutes: it creates the `vercel-live` branch. (If the run fails, open it and send Claude the log. A permissions error means
   Settings -> Actions -> General -> Workflow permissions -> "Read and write permissions".)
7. Vercel -> your project -> Settings -> Git -> **Production Branch** = `vercel-live` -> Save. Keep Root Directory = `frontend`: the branch uses the
   same folder layout and carries its own `frontend/vercel.json` (no build, output `.`), so nothing else changes.
8. Deployments -> redeploy the latest `vercel-live` commit.
9. From now on the job runs about every 30 minutes (GitHub may delay it), downloads a new ECMWF run only when one exists,
   and Vercel redeploys automatically. The status pill shows **Auto-published**.
   GitHub disables scheduled workflows after 60 days without repository activity.

## 3b. Render (YOU) - FastAPI backend
1. Sign in at render.com (GitHub sign-in is simplest). **Stop and tell Claude if it asks for a payment method.**
2. New → **Blueprint** → select the repository → Render reads `render.yaml` (free plan).
3. Apply. The first build installs Python deps and builds the frontend (a few minutes).
4. Copy the service URL (`https://india-weather-forecast-xxxx.onrender.com`) and send it to Claude.

## 4. Claude verifies the live URL
- Vercel: the page loads with no `/api` calls, `/data/index.json` lists the runs, the map, places, probabilities work.
- Render: `/api/health` and `/api/ready` return 200; `/api/runs` lists the seeded snapshot run.
- The page loads, shows real data, the map and basemap render, click selection works.
- After a cold start the refresher fetches the newest run (about 3 minutes); `/api/status` shows it.
- Results are recorded in `README.md` ("Final deliverables") only after they are observed.

## 5. Optional keep-alive (YOU decide)
Set the repository variable `KEEPALIVE_URL` (Settings → Secrets and variables → Actions → Variables) to the
service URL to activate `.github/workflows/keepalive.yml`. It uses ~744 of the 750 free hours per month.

## 6. Final steps
- Final tests pass, snapshot refreshed, `README.md` deliverables filled in, final commit.
- Session log: copy the unedited file
  `C:\Users\jalan\.claude\projects\C--Users-jalan-ppt\aadb2182-faa2-485c-a38f-7534910abdd7.jsonl`
  after the session's last message. Do not edit or trim it.
- Deadline for the final commit: **2026-11-07 14:49 +05:30**.

### Why Vercel gets only the frontend (decisions recorded 2026-11-04)
Vercel's import screen detects two apps and suggests a "Services" layout (FastAPI backend + Vite frontend). The applicant chose the **frontend-only**
layout. Reasons: a Vercel function cannot run this project's background refresher or write its data files, so a backend service there would
serve a frozen snapshot and could not be tested without a deploy; the static site already has live updates (GitHub Action -> `vercel-live`) and parity
tests against the real API. The real FastAPI endpoints are deployed on Render (`render.yaml`).
After seeing the actual import screen, the config was moved from a root `vercel.json` in beta "Services" mode to a plain `frontend/vercel.json`
used with "Import single project", because the Services preset would auto-include the backend and the beta feature adds risk for no benefit.
Both `frontend/vercel.json` and `deploy/vercel-static.json` were validated against Vercel's published JSON schema (0 errors).
