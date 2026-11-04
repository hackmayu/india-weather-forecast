# Deployment checklist (Render free web service)

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

## 3. Render (YOU)
1. Sign in at render.com (GitHub sign-in is simplest). **Stop and tell Claude if it asks for a payment method.**
2. New → **Blueprint** → select the repository → Render reads `render.yaml` (free plan).
3. Apply. The first build installs Python deps and builds the frontend (a few minutes).
4. Copy the service URL (`https://india-weather-forecast-xxxx.onrender.com`) and send it to Claude.

## 4. Claude verifies the live URL
- `/api/health` and `/api/ready` return 200; `/api/runs` lists the seeded snapshot run.
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
