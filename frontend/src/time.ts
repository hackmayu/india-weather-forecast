export type Zone = "local" | "utc";

// Building an Intl.DateTimeFormat is expensive (about a millisecond); the results panel formats hundreds of times per
// click. Formatters are therefore created once per option set, and finished labels are remembered.
const formatters = new Map<string, Intl.DateTimeFormat>();
function dtf(key: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  let f = formatters.get(key);
  if (!f) { f = new Intl.DateTimeFormat("en-GB", opts); formatters.set(key, f); }
  return f;
}
const labels = new Map<string, string>();
function memoLabel(key: string, make: () => string): string {
  let v = labels.get(key);
  if (v === undefined) { if (labels.size > 5000) labels.clear(); v = make(); labels.set(key, v); }
  return v;
}

export function formatTime(iso: string, zone: Zone, withDate = true): string {
  return memoLabel(`t|${zone}|${withDate}|${iso}`, () => dtf(`t|${zone}|${withDate}`, {
    ...(withDate ? { weekday: "short" as const, day: "numeric" as const, month: "short" as const } : {}),
    hour: "2-digit", minute: "2-digit", hour12: false,
    timeZone: zone === "utc" ? "UTC" : undefined, timeZoneName: "short",
  }).format(new Date(iso)));
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

// ---------------------------------------------------------------------------------------------
// Day shortcuts for the timeline ("Today", "Tomorrow", "Fri 6" ...)
// ---------------------------------------------------------------------------------------------
export interface DayChip { key: string; label: string; index: number }

function localParts(ms: number, zone: Zone) {
  const parts = dtf(`p|${zone}`, {
    timeZone: zone === "utc" ? "UTC" : undefined, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const g = (t: string) => parts.find((p) => p.type === t)!.value;
  return { date: `${g("year")}-${g("month")}-${g("day")}`, hour: Number(g("hour")) };
}
/** Calendar date (YYYY-MM-DD) of a timestamp in the chosen zone; used to highlight the active day chip. */
export const localDate = (ms: number, zone: Zone): string => localParts(ms, zone).date;

/**
 * One chip per calendar day (in the chosen zone) that the forecast covers. Each chip jumps to the model step
 * closest to local noon of that day; "Today" jumps to the step nearest to now. Days whose nearest step is more
 * than 6 h from noon (e.g. a last day with only a midnight step) are skipped, as are steps before `minIndex`.
 */
export function dayShortcuts(valid: string[], nowMs: number, zone: Zone, minIndex = 0): DayChip[] {
  const times = valid.map((v) => Date.parse(v));
  const byDate = new Map<string, { index: number; off: number }>();
  times.forEach((t, i) => {
    if (i < minIndex) return;
    const { date, hour } = localParts(t, zone);
    const off = Math.abs(hour - 12);
    const cur = byDate.get(date);
    if (!cur || off < cur.off) byDate.set(date, { index: i, off });
  });
  const today = localDate(nowMs, zone), tomorrow = localDate(nowMs + 24 * 3_600_000, zone);
  const label = dtf(`d|${zone}`, { timeZone: zone === "utc" ? "UTC" : undefined, weekday: "short", day: "numeric" });
  const chips: DayChip[] = [];
  for (const [date, { index, off }] of byDate) {
    if (off > 6 && date !== today) continue;
    if (date === today) {
      const n = Math.max(minIndex, nearestIndex(valid, nowMs));
      chips.push({ key: date, label: "Today", index: n });
    } else chips.push({ key: date, label: date === tomorrow ? "Tomorrow" : label.format(new Date(times[index])), index });
  }
  return chips;
}

/** Compact label such as "Thu 05:30" (weekday + time, no zone name) for narrow table cells; the zone is stated once in a caption. */
export function formatShort(iso: string, zone: Zone): string {
  return memoLabel(`s|${zone}|${iso}`, () => dtf(`s|${zone}`, { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: zone === "utc" ? "UTC" : undefined }).format(new Date(iso)));
}
