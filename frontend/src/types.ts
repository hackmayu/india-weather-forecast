// Shared API types. Kept separate from api.ts so the browser-side data engine (staticData.ts) and the
// network client (api.ts) can both import them without a circular dependency. All values are mm of water
// unless stated.
export interface Freshness { age_hours: number; stale: boolean; stale_after_hours: number }
export interface RunMeta {
  run_id: string; model: string; issue_time_utc: string; processed_at_utc: string;
  published_at_utc?: string | null; availability_delay_h?: number | null; // when ECMWF made the run available (Last-Modified)
  steps_h: number[]; valid_times_utc: string[]; interval_durations_h: number[];
  domain: { lat_min: number; lat_max: number; lon_min: number; lon_max: number };
  grid: { n_lat: number; n_lon: number; spacing_deg: number };
  quality: { packing_noise_cells_zeroed: number; worst_packing_noise_mm: number };
  freshness: Freshness; attribution: string;
}
export type Kind = "interval" | "cumulative" | "window";
export type VariableId = "precip" | "temp" | "cloud" | "wind" | "prob";
export interface MapResp {
  run_id: string; step_h: number; variable: VariableId; kind: Kind | "instant" | "probability"; valid_time_utc: string;
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

export interface Status {
  refreshing: boolean; last_attempt_utc: string | null; last_result: string | null;
  last_error: string | null; auto_refresh: boolean; latest_run: string | null;
  probability?: { latest_run: string | null; last_result: string | null; last_error: string | null };
  /** "backend" = live FastAPI service; "static" = prebuilt files (no server code). */
  mode?: "backend" | "static";
}
export interface RunSummary { run_id: string; issue_time_utc: string; max_step_h: number }

// ---- ECMWF ENS probabilities (official `ep` products) ----
export interface ProbMeta {
  run_id: string; issue_time_utc: string; published_at_utc?: string | null; thresholds_mm: number[];
  windows: { start_h: number; end_h: number; start_utc: string; end_utc: string }[];
  freshness: { age_hours: number; stale: boolean; stale_after_hours: number }; semantics: string; attribution: string;
}
export interface ProbMapResp extends Omit<MapResp, "step_h" | "kind" | "variable"> {
  step_h?: number; variable: "prob"; kind: "probability"; threshold_mm: number;
  window: { start_h: number; end_h: number; start_utc: string; end_utc: string }; issue_time_utc: string;
}
export interface ProbPointResp {
  run_id: string; issue_time_utc: string; requested: { lat: number; lon: number }; grid_point: { lat: number; lon: number };
  method: string; units: "%"; thresholds_mm: number[]; semantics: string;
  windows: { start_h: number; end_h: number; start_utc: string; end_utc: string; probability_pct: number[] }[];
}
