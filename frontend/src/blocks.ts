import type { SeriesPoint } from "./api";

export interface Block {
  startIdx: number; endIdx: number; hours: number;
  precipMm: number; tMin?: number; tMax?: number; windMax?: number; cloudMean?: number;
}

/**
 * Summaries over consecutive 24 h blocks counted from the run's issue time (+0-24 h, +24-48 h, ...),
 * ending with a shorter block if the horizon is not a multiple of 24 h. Blocks start at the model's own
 * steps so the precipitation total is an exact difference of cumulative values. (Calendar days in a local
 * time zone such as IST do not line up with 3-hourly UTC steps, so they are deliberately not used.)
 */
export function dailyBlocks(series: SeriesPoint[]): Block[] {
  const blocks: Block[] = [];
  const last = series.length - 1;
  let start = 0;
  while (start < last) {
    const target = series[start].step_h + 24;
    let end = series.findIndex((s) => s.step_h === target);
    if (end < 0) end = last;
    if (end <= start) break;
    const rows = series.slice(start, end + 1);
    const temps = rows.map((r) => r.temp_c).filter((v): v is number => v != null);
    const winds = rows.map((r) => r.wind_speed_ms).filter((v): v is number => v != null);
    const clouds = rows.map((r) => r.cloud_pct).filter((v): v is number => v != null);
    blocks.push({
      startIdx: start, endIdx: end, hours: series[end].step_h - series[start].step_h,
      precipMm: series[end].cumulative_mm - series[start].cumulative_mm,
      tMin: temps.length ? Math.min(...temps) : undefined, tMax: temps.length ? Math.max(...temps) : undefined,
      windMax: winds.length ? Math.max(...winds) : undefined,
      cloudMean: clouds.length ? clouds.reduce((a, b) => a + b, 0) / clouds.length : undefined,
    });
    start = end;
  }
  return blocks;
}

// ---------------------------------------------------------------------------------------------
// Headline numbers for one place: the next 24 h from now (model steps nearest to now)
// ---------------------------------------------------------------------------------------------
export interface Headline { hours: number; startIdx: number; endIdx: number; rainMm: number; tMin?: number; tMax?: number; windMax?: number }

/**
 * Rain (exact cumulative difference, floored at 0 for packing noise), temperature range and strongest wind for the
 * window from the step nearest to `nowMs` to 24 h later (shorter at the end of the run). Null when under 6 h remain.
 */
export function placeHeadline(series: SeriesPoint[], nowMs: number): Headline | null {
  let i0 = 0;
  series.forEach((s, i) => { if (Math.abs(Date.parse(s.valid_time_utc) - nowMs) < Math.abs(Date.parse(series[i0].valid_time_utc) - nowMs)) i0 = i; });
  let i1 = series.findIndex((s) => s.step_h === series[i0].step_h + 24);
  if (i1 < 0) i1 = series.length - 1;
  const hours = series[i1].step_h - series[i0].step_h;
  if (hours < 6) return null;
  const win = series.slice(i0, i1 + 1);
  const temps = win.map((s) => s.temp_c).filter((v): v is number => v != null);
  const winds = win.map((s) => s.wind_speed_ms).filter((v): v is number => v != null);
  return {
    hours, startIdx: i0, endIdx: i1, rainMm: Math.max(0, series[i1].cumulative_mm - series[i0].cumulative_mm),
    tMin: temps.length ? Math.min(...temps) : undefined, tMax: temps.length ? Math.max(...temps) : undefined,
    windMax: winds.length ? Math.max(...winds) : undefined,
  };
}

/** Plain-language rain view chosen by the user. */
export type RainPreset = "next24" | "next48" | "steps" | "total" | "custom";
export function rainPreset(kind: "interval" | "cumulative" | "window", hours: number): RainPreset {
  if (kind === "interval") return "steps";
  if (kind === "cumulative") return "total";
  return hours === 24 ? "next24" : hours === 48 ? "next48" : "custom";
}
