import { useEffect, useState } from "react";
import { fetchPoint, type PointResp, type RunMeta } from "./api";
import { CITIES } from "./cities";
import { formatTime, nearestIndex, type Zone } from "./time";

// Large cities spread across the domain, for a quick national picture.
const GLANCE = ["Delhi", "Mumbai", "Kolkata", "Chennai", "Bengaluru", "Hyderabad", "Ahmedabad", "Pune", "Jaipur", "Lucknow", "Guwahati", "Thiruvananthapuram"];

interface Row { name: string; lat: number; lon: number; rain: number; tMax?: number; windMax?: number }
export interface Glance { rows: Row[]; startIso: string; endIso: string; hours: number }

/**
 * For each city's nearest grid cell: rain over the window from the model step nearest to NOW to 24 h later
 * (or to the end of the run if shorter), and the highest temperature / wind in that window.
 * Rain is a difference of cumulative values (floored at 0 for packing noise), as everywhere else.
 */
export function buildGlance(points: { name: string; lat: number; lon: number; p: PointResp }[], meta: RunMeta, nowMs: number): Glance | null {
  const valid = meta.valid_times_utc, steps = meta.steps_h;
  const i0 = nearestIndex(valid, nowMs);
  let i1 = steps.indexOf(steps[i0] + 24);
  if (i1 < 0) i1 = steps.length - 1;
  const hours = steps[i1] - steps[i0];
  if (hours < 6) return null;
  const rows = points.map(({ name, lat, lon, p }) => {
    const win = p.series.slice(i0, i1 + 1);
    const temps = win.map((s) => s.temp_c).filter((v): v is number => v != null);
    const winds = win.map((s) => s.wind_speed_ms).filter((v): v is number => v != null);
    return {
      name, lat, lon, rain: Math.max(0, p.series[i1].cumulative_mm - p.series[i0].cumulative_mm),
      tMax: temps.length ? Math.max(...temps) : undefined, windMax: winds.length ? Math.max(...winds) : undefined,
    };
  }).sort((a, b) => b.rain - a.rain);
  return { rows, startIso: valid[i0], endIso: valid[i1], hours };
}

export default function CityOverview({ meta, nowMs, zone, onPick }: { meta: RunMeta; nowMs: number; zone: Zone; onPick: (lat: number, lon: number) => void }) {
  const [points, setPoints] = useState<{ name: string; lat: number; lon: number; p: PointResp }[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setPoints(null); setErr(null);
    const cities = CITIES.filter((c) => GLANCE.includes(c.name));
    Promise.all(cities.map((c) => fetchPoint(meta.run_id, c.lat, c.lon).then((p) => ({ name: c.name, lat: c.lat, lon: c.lon, p }))))
      .then((r) => { if (live) setPoints(r); })
      .catch((e: Error) => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, [meta.run_id]);

  const g = points ? buildGlance(points, meta, nowMs) : null;
  return (
    <details className="glance panel">
      <summary>Cities at a glance</summary>
      {err && <p className="error" role="alert">{err}</p>}
      {!points && !err && <p aria-busy="true">Loading cities…</p>}
      {points && !g && <p className="muted">Less than 6 h of this forecast remains after the current time, so no summary is shown.</p>}
      {g && (
        <>
          <p className="muted small">Model forecast for the {g.hours} h from {formatTime(g.startIso, zone)} to {formatTime(g.endIso, zone)} (model steps nearest to now), nearest 0.25° cell for each city, wettest first. Choose a city to open it.</p>
          <div className="table-wrap">
            <table>
              <caption className="sr-only">Rain, highest temperature and strongest wind over the next {g.hours} hours for twelve cities</caption>
              <thead><tr><th scope="col">City</th><th scope="col">Rain (mm)</th><th scope="col">Max temp (°C)</th><th scope="col">Max wind (m/s)</th></tr></thead>
              <tbody>
                {g.rows.map((r) => (
                  <tr key={r.name}>
                    <th scope="row"><button type="button" className="link" onClick={() => onPick(r.lat, r.lon)}>{r.name}</button></th>
                    <td><span className="bar-cell" style={{ width: `${Math.min(100, (r.rain / Math.max(10, g.rows[0].rain)) * 100)}%` }} aria-hidden="true" />{r.rain < 0.05 ? "<0.1" : r.rain.toFixed(1)}</td>
                    <td>{r.tMax?.toFixed(1)}</td>
                    <td>{r.windMax?.toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </details>
  );
}
