import type { PointResp, RunMeta } from "./api";

/** CSV of the selected cell's series with provenance in leading comment lines. Values are as served
 *  by the API (mm, degC, %, m/s); nothing is recomputed here. */
export function toCsv(point: PointResp, meta: RunMeta, generatedAtIso: string): string {
  const head = [
    "# India Weather Forecast Explorer - forecast series for one grid cell",
    `# Source: ECMWF Open Data, IFS HRES 0.25 deg, run ${meta.run_id} UTC (issued ${meta.issue_time_utc})`,
    "# Contains modified ECMWF Open Data, licensed CC-BY-4.0",
    `# Grid cell centre: ${point.grid_point.lat} N, ${point.grid_point.lon} E (requested ${point.requested.lat}, ${point.requested.lon}); nearest cell, no interpolation`,
    "# interval_mm = precipitation between the previous and this valid time; cumulative_mm = since issue time",
    "# These are model forecast values (including for past times), not observations",
    `# Generated: ${generatedAtIso}`,
  ];
  const cols = ["valid_time_utc", "step_h", "interval_hours", "interval_mm", "cumulative_mm", "temp_c", "cloud_pct", "wind_speed_ms", "wind_from_deg"];
  const f = (v: number | null | undefined) => (v === null || v === undefined ? "" : String(v));
  const rows = point.series.map((s) => [s.valid_time_utc, s.step_h, f(s.interval_hours), f(s.interval_mm), s.cumulative_mm,
    f(s.temp_c), f(s.cloud_pct), f(s.wind_speed_ms), f(s.wind_from_deg)].join(","));
  return [...head, cols.join(","), ...rows].join("\n") + "\n";
}

export function csvFilename(point: PointResp): string {
  return `forecast_${point.run_id}_${point.grid_point.lat.toFixed(2)}N_${point.grid_point.lon.toFixed(2)}E.csv`;
}
