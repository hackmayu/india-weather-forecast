import type { SeriesPoint } from "./api";

// Deterministic summary of one grid cell's forecast. Every statement is a direct calculation from
// the series; there is no probability, observation, warning or advice (see README limitations).
export interface Story {
  wettest?: { startIdx: number; endIdx: number; mm: number; hours: number };
  wettestDay?: { startIdx: number; endIdx: number; mm: number };
  first?: { idx: number };
  total: number;
  dry: boolean;
}

// "Wet interval" = at least 1 mm in that interval (a presentation threshold, not a hazard level).
const WET_MM = 1;

export function buildStory(series: SeriesPoint[]): Story {
  const total = series[series.length - 1].cumulative_mm;
  let wettest: Story["wettest"];
  let first: Story["first"];
  for (let i = 1; i < series.length; i++) {
    const mm = series[i].interval_mm ?? 0;
    if (mm >= WET_MM && !first) first = { idx: i };
    if (mm > (wettest?.mm ?? 0)) wettest = { startIdx: i - 1, endIdx: i, mm, hours: series[i].interval_hours ?? 0 };
  }
  // Wettest 24 h window: difference of cumulative values exactly 24 h apart. Valid because tp is
  // cumulative from the issue time; it makes no assumption of equal step spacing.
  let wettestDay: Story["wettestDay"];
  for (let i = 0; i < series.length; i++) {
    const j = series.findIndex((s) => s.step_h === series[i].step_h + 24);
    if (j < 0) continue;
    const mm = series[j].cumulative_mm - series[i].cumulative_mm;
    if (mm > (wettestDay?.mm ?? 0)) wettestDay = { startIdx: i, endIdx: j, mm };
  }
  // Below 0.5 mm per interval the amounts are comparable to the data's packing precision
  // (~0.25 mm; docs/DATA_NOTES.md), so we call the cell "trace/dry" rather than report them as rain.
  const dry = !wettest || wettest.mm < 0.5;
  return { wettest: dry ? undefined : wettest, wettestDay: dry ? undefined : wettestDay, first, total, dry };
}

// ---- other deterministic facts (instantaneous variables) ----
const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
/** 16-point compass name for a bearing in degrees (the direction the wind comes FROM). */
export function compass(deg: number): string {
  return COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

export interface Facts {
  tMin?: { idx: number; v: number }; tMax?: { idx: number; v: number };
  windMax?: { idx: number; v: number; from: number };
  cloudMean?: number;
}

export function buildFacts(series: SeriesPoint[]): Facts {
  const f: Facts = {};
  let cloudSum = 0, cloudN = 0;
  series.forEach((s, idx) => {
    if (s.temp_c == null) return;
    if (!f.tMin || s.temp_c < f.tMin.v) f.tMin = { idx, v: s.temp_c };
    if (!f.tMax || s.temp_c > f.tMax.v) f.tMax = { idx, v: s.temp_c };
    if (s.wind_speed_ms != null && (!f.windMax || s.wind_speed_ms > f.windMax.v)) f.windMax = { idx, v: s.wind_speed_ms, from: s.wind_from_deg ?? 0 };
    if (s.cloud_pct != null) { cloudSum += s.cloud_pct; cloudN++; }
  });
  if (cloudN) f.cloudMean = cloudSum / cloudN;
  return f;
}
