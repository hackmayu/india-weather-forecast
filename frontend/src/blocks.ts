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
