import { useEffect, useState } from "react";
import { fetchMap, type MapResp, type RunMeta } from "./api";
import { CITIES } from "./cities";
import { formatTime, nearestIndex, type Zone } from "./time";

export interface OverviewStats {
  hours: number; startIso: string; endIso: string;
  maxRainMm: number; maxRainAt: { lat: number; lon: number };
  shareAbove1: number; shareAbove10: number;   // per cent of the mapped cells
  maxWindMs?: number; maxWindAt?: { lat: number; lon: number };
}

/** Nearest listed city to a point, if within `maxDeg` degrees (about 220 km at 2 degrees). */
export function nearCity(lat: number, lon: number, maxDeg = 2): { name: string; deg: number } | null {
  let best: { name: string; deg: number } | null = null;
  for (const c of CITIES) {
    const d = Math.hypot(c.lat - lat, (c.lon - lon) * Math.cos((lat * Math.PI) / 180));
    if (d <= maxDeg && (!best || d < best.deg)) best = { name: c.name, deg: d };
  }
  return best;
}

/**
 * Map-wide facts from the 24 h rain-window grid (and optionally the wind grid at the window's end):
 * the heaviest cell, and the share of the mapped area reaching 1 mm and 10 mm. Pure calculations on the
 * served grids; the "area" is the map rectangle (it includes sea), not land area.
 */
export function overviewStats(win: MapResp, wind: MapResp | null, startIso: string): OverviewStats {
  let max = -1, my = 0, mx = 0, n = 0, a1 = 0, a10 = 0;
  win.values.forEach((row, y) => row.forEach((v, x) => {
    n++;
    if (v > max) { max = v; my = y; mx = x; }
    if (v >= 1) a1++;
    if (v >= 10) a10++;
  }));
  const out: OverviewStats = {
    hours: win.accumulation_hours, startIso, endIso: win.valid_time_utc,
    maxRainMm: max, maxRainAt: { lat: win.lats[my], lon: win.lons[mx] },
    shareAbove1: (100 * a1) / n, shareAbove10: (100 * a10) / n,
  };
  if (wind) {
    let wm = -1, wy = 0, wx = 0;
    wind.values.forEach((row, y) => row.forEach((v, x) => { if (v > wm) { wm = v; wy = y; wx = x; } }));
    out.maxWindMs = wm; out.maxWindAt = { lat: wind.lats[wy], lon: wind.lons[wx] };
  }
  return out;
}

const place = (p: { lat: number; lon: number }) => {
  const c = nearCity(p.lat, p.lon);
  return c ? `near ${c.name}` : `at ${p.lat.toFixed(2)}°N, ${p.lon.toFixed(2)}°E`;
};

export default function Overview({ meta, nowMs, zone, onPick }: { meta: RunMeta; nowMs: number; zone: Zone; onPick: (lat: number, lon: number) => void }) {
  const [stats, setStats] = useState<OverviewStats | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setStats(null); setErr(null);
    const steps = meta.steps_h, valid = meta.valid_times_utc;
    const i0 = nearestIndex(valid, nowMs);
    let i1 = steps.indexOf(steps[i0] + 24);
    if (i1 < 0) i1 = steps.length - 1;
    const hours = steps[i1] - steps[i0];
    if (hours < 6) { setErr("Less than 6 h of this forecast remains after the current time."); return; }
    Promise.all([fetchMap(meta.run_id, steps[i1], "precip", "window", hours), fetchMap(meta.run_id, steps[i1], "wind", "interval")])
      .then(([w, wd]) => { if (live) setStats(overviewStats(w, wd, valid[i0])); })
      .catch((e: Error) => { if (live) setErr(e.message); });
    return () => { live = false; };
  // The window is anchored to "now"; re-evaluate when the run changes (not every clock tick).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta.run_id]);

  return (
    <section className="panel overview" aria-label="India overview">
      <h2>India: the next {stats?.hours ?? 24} hours</h2>
      {err && <p className="muted">{err}</p>}
      {!stats && !err && <p aria-busy="true">Calculating…</p>}
      {stats && (
        <>
          <ul>
            <li>Heaviest rain: <strong>{stats.maxRainMm.toFixed(0)} mm</strong>{" "}
              <button type="button" className="link" onClick={() => onPick(stats.maxRainAt.lat, stats.maxRainAt.lon)}>{place(stats.maxRainAt)}</button>.</li>
            <li>About <strong>{stats.shareAbove1.toFixed(0)} %</strong> of the mapped area is forecast to get at least 1 mm, and <strong>{stats.shareAbove10.toFixed(0)} %</strong> at least 10 mm.</li>
            {stats.maxWindMs != null && stats.maxWindAt && (
              <li>Strongest 10 m wind at the end of the period: <strong>{stats.maxWindMs.toFixed(1)} m/s</strong>{" "}
                <button type="button" className="link" onClick={() => onPick(stats.maxWindAt!.lat, stats.maxWindAt!.lon)}>{place(stats.maxWindAt)}</button>.</li>
            )}
          </ul>
          <p className="muted small">Model forecast for {formatTime(stats.startIso, zone)} → {formatTime(stats.endIso, zone)} (model steps nearest to now). The mapped area includes sea. Grid-cell values, not observations or warnings.</p>
        </>
      )}
    </section>
  );
}
