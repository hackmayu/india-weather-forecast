// Helpers for ECMWF ENS probability products ("chance that 24 h rain reaches X mm").
// These are ECMWF's own numbers; nothing here estimates a probability.
export interface ProbWindow { start_h: number; end_h: number; start_utc: string; end_utc: string }

const H = 3_600_000;

/**
 * Pick the probability window whose END is closest to the selected time. Windows are 24 h long and
 * end every 12 h, while the deterministic timeline has 3-hourly steps, so the match is often not exact.
 * `offsetH` is (window end - selected time) in hours, so the UI can say so instead of hiding it.
 */
export function nearestWindow(windows: ProbWindow[], targetMs: number): { window: ProbWindow; index: number; offsetH: number; exact: boolean } {
  let best = 0;
  for (let i = 1; i < windows.length; i++) {
    if (Math.abs(Date.parse(windows[i].end_utc) - targetMs) < Math.abs(Date.parse(windows[best].end_utc) - targetMs)) best = i;
  }
  const offsetH = (Date.parse(windows[best].end_utc) - targetMs) / H;
  return { window: windows[best], index: best, offsetH, exact: Math.abs(offsetH) < 0.5 };
}

/** Text colour that stays readable on a probability-shaded cell (alpha ~ probability). */
export function textOn(pct: number): "light" | "dark" {
  return pct >= 55 ? "light" : "dark";
}
