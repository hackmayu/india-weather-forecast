// Typed client for the FastAPI backend. All values are mm of water unless stated.
export interface Freshness { age_hours: number; stale: boolean; stale_after_hours: number }
export interface RunMeta {
  run_id: string; model: string; issue_time_utc: string; processed_at_utc: string;
  steps_h: number[]; valid_times_utc: string[]; interval_durations_h: number[];
  domain: { lat_min: number; lat_max: number; lon_min: number; lon_max: number };
  grid: { n_lat: number; n_lon: number; spacing_deg: number };
  quality: { packing_noise_cells_zeroed: number; worst_packing_noise_mm: number };
  freshness: Freshness; attribution: string;
}
export type Kind = "interval" | "cumulative";
export type VariableId = "precip" | "temp" | "cloud" | "wind";
export interface MapResp {
  run_id: string; step_h: number; variable: VariableId; kind: Kind | "instant"; valid_time_utc: string;
  accumulation_hours: number; units: string; lats: number[]; lons: number[]; values: number[][];
  u?: number[][]; v?: number[][]; // wind components (m/s), present for variable=wind
}
export interface SeriesPoint {
  step_h: number; valid_time_utc: string; cumulative_mm: number;
  interval_mm: number | null; interval_hours: number | null;
  // instantaneous fields; absent for runs processed before they were added
  temp_c?: number; cloud_pct?: number; wind_speed_ms?: number; wind_from_deg?: number;
}
export interface PointResp {
  run_id: string; requested: { lat: number; lon: number }; grid_point: { lat: number; lon: number };
  method: string; units: "mm"; series: SeriesPoint[];
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

async function get<T>(path: string): Promise<T> {
  let r: Response;
  try { r = await fetch(path); } catch { throw new ApiError(0, "Cannot reach the forecast service."); }
  if (!r.ok) {
    let detail = `Request failed (${r.status}).`;
    try {
      const j = await r.json();
      if (typeof j.detail === "string") detail = j.detail;
      else if (Array.isArray(j.detail) && j.detail[0]?.msg) detail = String(j.detail[0].msg);
    } catch { /* keep default */ }
    throw new ApiError(r.status, detail);
  }
  return r.json() as Promise<T>;
}

export interface Status {
  refreshing: boolean; last_attempt_utc: string | null; last_result: string | null;
  last_error: string | null; auto_refresh: boolean; latest_run: string | null;
}
export const fetchStatus = () => get<Status>("/api/status");
export const fetchRun = () => get<RunMeta>("/api/runs/latest");
export const fetchMap = (runId: string, step: number, variable: VariableId, kind: Kind) =>
  get<MapResp>(`/api/runs/${runId}/map?step=${step}&variable=${variable}&kind=${kind}`);
export const fetchPoint = (runId: string, lat: number, lon: number) =>
  get<PointResp>(`/api/runs/${runId}/point?lat=${lat}&lon=${lon}`);
