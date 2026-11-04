export type Zone = "local" | "utc";

export function formatTime(iso: string, zone: Zone, withDate = true): string {
  const f = new Intl.DateTimeFormat("en-GB", {
    ...(withDate ? { weekday: "short" as const, day: "numeric" as const, month: "short" as const } : {}),
    hour: "2-digit", minute: "2-digit", hour12: false,
    timeZone: zone === "utc" ? "UTC" : undefined, timeZoneName: "short",
  });
  return f.format(new Date(iso));
}

export function zoneName(zone: Zone): string {
  if (zone === "utc") return "UTC";
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return tz === "Asia/Calcutta" || tz === "Asia/Kolkata" ? "IST (UTC+5:30)" : tz;
}

// ---------------------------------------------------------------------------------------------
// "Real-time" helpers. These use the browser clock only to locate *now* on the forecast timeline.
// ---------------------------------------------------------------------------------------------

/** Typical delay between a run's issue time and its availability on the ECMWF server.
 *  Measured from the Last-Modified headers of 9 consecutive runs (2026-11-02..04): 00/12 UTC runs
 *  appeared ~7.57 h after issue, 06/18 UTC runs ~6.45 h. A typical value, not a guarantee. */
export const TYPICAL_DELAY_H: Record<number, number> = { 0: 7.57, 6: 6.45, 12: 7.57, 18: 6.45 };
const H = 3_600_000;

export type NowState = "before" | "within" | "after";

/** Index to show for "now". Interval totals use the interval that CONTAINS now (index = its end);
 *  instantaneous fields use the nearest valid time. `state` says whether now lies inside the horizon. */
export function indexForNow(valid: string[], nowMs: number, intervals: boolean): { index: number; state: NowState } {
  const t = valid.map((v) => Date.parse(v));
  const min = intervals ? 1 : 0;
  if (nowMs < t[0]) return { index: min, state: "before" };
  if (nowMs >= t[t.length - 1]) return { index: t.length - 1, state: "after" };
  if (intervals) {
    for (let i = 1; i < t.length; i++) if (nowMs < t[i]) return { index: i, state: "within" };
  }
  let best = 0;
  for (let i = 1; i < t.length; i++) if (Math.abs(t[i] - nowMs) < Math.abs(t[best] - nowMs)) best = i;
  return { index: best, state: "within" };
}

/** Fractional step index of `nowMs` (linear in time between neighbouring valid times), or null if outside. */
export function fracIndex(valid: string[], nowMs: number): number | null {
  const t = valid.map((v) => Date.parse(v));
  if (nowMs < t[0] || nowMs > t[t.length - 1]) return null;
  for (let i = 1; i < t.length; i++) {
    if (nowMs <= t[i]) return i - 1 + (nowMs - t[i - 1]) / (t[i] - t[i - 1]);
  }
  return t.length - 1;
}

/** Nearest valid-time index to a timestamp (used to keep the same time when switching runs). */
export function nearestIndex(valid: string[], ms: number): number {
  const t = valid.map((v) => Date.parse(v));
  let best = 0;
  for (let i = 1; i < t.length; i++) if (Math.abs(t[i] - ms) < Math.abs(t[best] - ms)) best = i;
  return best;
}

/** When the next run is typically published, given the newest run we hold. */
export function nextRun(issueMs: number, nowMs: number): { issueMs: number; expectedMs: number; overdue: boolean } {
  const nextIssue = issueMs + 6 * H;
  const hour = new Date(nextIssue).getUTCHours();
  const expected = nextIssue + TYPICAL_DELAY_H[hour] * H;
  return { issueMs: nextIssue, expectedMs: expected, overdue: nowMs > expected };
}

/** "7 h 36 min ago" / "in 2 h 5 min" / "just now". */
export function relTime(deltaMs: number): string {
  const abs = Math.abs(deltaMs), mins = Math.round(abs / 60_000);
  if (mins < 1) return "just now";
  const h = Math.floor(mins / 60), m = mins % 60;
  const txt = h ? `${h} h${m ? ` ${m} min` : ""}` : `${m} min`;
  return deltaMs < 0 ? `${txt} ago` : `in ${txt}`;
}
