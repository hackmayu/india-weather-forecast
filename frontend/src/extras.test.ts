import { describe, expect, it } from "vitest";
import { buildSearch, parseUrl } from "./urlState";
import { csvFilename, toCsv } from "./csv";
import { CITIES, findCity } from "./cities";
import { dailyBlocks } from "./blocks";
import type { PointResp, RunMeta, SeriesPoint } from "./api";

describe("URL state", () => {
  it("round-trips view state and preserves unrelated params", () => {
    const s = { v: "wind" as const, k: "cumulative" as const, t: "2026-11-05T06:00:00Z", lat: 22.5, lon: 88.25, z: "utc" as const };
    const search = buildSearch("?debug", s);
    expect(search).toContain("debug");
    expect(parseUrl(search)).toEqual(s);
  });
  it("omits defaults so links stay short", () => {
    expect(buildSearch("", { v: "precip", k: "interval", z: "local" })).toBe("");
  });
  it("ignores invalid or hostile values", () => {
    expect(parseUrl("?v=<script>&k=zzz&t=tomorrow&lat=abc&lon=1&z=mars")).toEqual({});
    expect(parseUrl("?lat=95&lon=88")).toEqual({});          // latitude out of range
    expect(parseUrl("?lat=22&lon=")).toEqual({});             // incomplete pair
    expect(parseUrl("?t=2026-13-45T99:99:99Z")).toEqual({});
  });
});

const mkSeries = (): SeriesPoint[] => [0, 12, 24, 36, 48, 60].map((h, i) => ({
  step_h: h, valid_time_utc: `2026-11-0${4 + Math.floor(h / 24)}T${String(h % 24).padStart(2, "0")}:00:00Z`,
  cumulative_mm: [0, 1, 4, 5, 5.5, 9][i], interval_mm: i ? [0, 1, 3, 1, 0.5, 3.5][i] : null, interval_hours: i ? 12 : null,
  temp_c: [20, 30, 22, 31, 21, 28][i], cloud_pct: 50, wind_speed_ms: [1, 2, 3, 4, 5, 6][i], wind_from_deg: 90,
}));

describe("dailyBlocks", () => {
  it("uses exact cumulative differences over 24 h blocks from issue time, with a shorter last block", () => {
    const b = dailyBlocks(mkSeries());
    expect(b.map((x) => [x.startIdx, x.endIdx, x.hours])).toEqual([[0, 2, 24], [2, 4, 24], [4, 5, 12]]);
    expect(b.map((x) => x.precipMm)).toEqual([4, 1.5, 3.5]);
    expect(b[0].tMax).toBe(30);
    expect(b[0].tMin).toBe(20);
    expect(b[1].windMax).toBe(5);
  });
});

describe("CSV", () => {
  const point: PointResp = { run_id: "2026110406", requested: { lat: 22.57, lon: 88.36 }, grid_point: { lat: 22.5, lon: 88.25 },
    method: "", units: "mm", series: mkSeries() };
  const meta = { run_id: "2026110406", issue_time_utc: "2026-11-04T06:00:00Z" } as RunMeta;
  it("has provenance comments, a header row and one row per step with blanks for missing values", () => {
    const lines = toCsv(point, meta, "2026-11-04T12:00:00Z").trim().split("\n");
    expect(lines.filter((l) => l.startsWith("#")).length).toBeGreaterThanOrEqual(6);
    const header = lines.findIndex((l) => l.startsWith("valid_time_utc"));
    expect(lines.length - header - 1).toBe(point.series.length);
    expect(lines[header + 1].split(",").slice(0, 6)).toEqual(["2026-11-04T00:00:00Z", "0", "", "", "0", "20"]); // step 0 has no interval
  });
  it("builds a safe filename", () => { expect(csvFilename(point)).toBe("forecast_2026110406_22.50N_88.25E.csv"); });
});

describe("cities", () => {
  it("all lie inside the supported domain and names are unique", () => {
    for (const c of CITIES) {
      expect(c.lat).toBeGreaterThanOrEqual(6); expect(c.lat).toBeLessThanOrEqual(38);
      expect(c.lon).toBeGreaterThanOrEqual(66); expect(c.lon).toBeLessThanOrEqual(100);
    }
    expect(new Set(CITIES.map((c) => c.name)).size).toBe(CITIES.length);
  });
  it("finds a city case-insensitively", () => {
    expect(findCity("  kolkata ")?.name).toBe("Kolkata");
    expect(findCity("Atlantis")).toBeUndefined();
  });
});

import { buildGlance } from "./CityOverview";
describe("window URL param", () => {
  it("accepts only whole 3-hour multiples within the horizon", () => {
    expect(parseUrl("?k=window&h=24")).toEqual({ k: "window", h: 24 });
    expect(parseUrl("?h=4")).toEqual({});
    expect(parseUrl("?h=500")).toEqual({});
    expect(buildSearch("", { k: "window", h: 48 })).toBe("?k=window&h=48");
    expect(buildSearch("", { k: "interval", h: 48 })).toBe("");      // h only matters for windows
  });
});

describe("cities at a glance", () => {
  const valid = [0, 6, 12, 18, 24, 30].map((h) => new Date(Date.UTC(2026, 10, 4, h)).toISOString().replace(".000", ""));
  const meta = { valid_times_utc: valid, steps_h: [0, 6, 12, 18, 24, 30] } as unknown as RunMeta;
  const mk = (cum: number[], temps: number[]) => ({ run_id: "x", requested: { lat: 0, lon: 0 }, grid_point: { lat: 0, lon: 0 }, method: "", units: "mm" as const,
    series: cum.map((c, i) => ({ step_h: i * 6, valid_time_utc: valid[i], cumulative_mm: c, interval_mm: null, interval_hours: null, temp_c: temps[i], wind_speed_ms: 2 + i })) });
  it("uses the window from the step nearest now, 24 h long, wettest first", () => {
    const now = Date.parse(valid[1]) + 3_600_000;                    // 07:00 -> nearest step is 06:00 (index 1)
    const g = buildGlance([
      { name: "Dry", lat: 1, lon: 1, p: mk([0, 0, 0, 0, 0, 0], [20, 21, 22, 23, 24, 25]) },
      { name: "Wet", lat: 2, lon: 2, p: mk([0, 1, 3, 9, 12, 30], [20, 21, 22, 23, 24, 25]) },
    ], meta, now)!;
    expect(g.hours).toBe(24);
    expect(g.startIso).toBe(valid[1]);
    expect(g.endIso).toBe(valid[5]);
    expect(g.rows.map((r) => r.name)).toEqual(["Wet", "Dry"]);
    expect(g.rows[0].rain).toBe(29);                                 // cum[30h] - cum[6h] = 30 - 1
    expect(g.rows[0].tMax).toBe(25);
  });
  it("shortens the window at the end of the run and returns null when under 6 h remain", () => {
    const late = Date.parse(valid[4]) + 1000;                        // nearest step 24 h, only 6 h left
    expect(buildGlance([{ name: "A", lat: 1, lon: 1, p: mk([0, 0, 0, 0, 1, 2], [1, 1, 1, 1, 1, 1]) }], meta, late)!.hours).toBe(6);
    expect(buildGlance([{ name: "A", lat: 1, lon: 1, p: mk([0, 0, 0, 0, 1, 2], [1, 1, 1, 1, 1, 1]) }], meta, Date.parse(valid[5]))).toBeNull();
  });
});

import { nearCity, overviewStats } from "./Overview";
describe("India overview", () => {
  const grid = (v: number[][]) => ({ run_id: "x", step_h: 24, variable: "precip" as const, kind: "window" as const, valid_time_utc: "2026-11-05T00:00:00Z",
    accumulation_hours: 24, units: "mm", lats: [30, 29.75], lons: [77, 77.25, 77.5], values: v });
  it("finds the heaviest cell and the share of cells reaching 1 and 10 mm", () => {
    const w = grid([[0, 2, 12], [0.4, 50, 0]]);
    const s = overviewStats(w, null, "2026-11-04T00:00:00Z");
    expect(s.maxRainMm).toBe(50);
    expect(s.maxRainAt).toEqual({ lat: 29.75, lon: 77.25 });
    expect(s.shareAbove1).toBeCloseTo((3 / 6) * 100);
    expect(s.shareAbove10).toBeCloseTo((2 / 6) * 100);
    expect(s.hours).toBe(24);
  });
  it("adds the strongest wind cell when a wind grid is given", () => {
    const wind = { ...grid([[1, 2, 3], [4, 9.5, 1]]), variable: "wind" as const, kind: "instant" as const };
    const s = overviewStats(grid([[0, 0, 0], [0, 0, 0]]), wind, "2026-11-04T00:00:00Z");
    expect(s.maxWindMs).toBe(9.5);
    expect(s.maxWindAt).toEqual({ lat: 29.75, lon: 77.25 });
  });
  it("names the nearest listed city within 2 degrees, otherwise nothing", () => {
    expect(nearCity(28.7, 77.3)?.name).toBe("Delhi");
    expect(nearCity(0, 0)).toBeNull();
  });
});

import { localDate, dayShortcuts } from "./time";
import { placeHeadline, rainPreset } from "./blocks";

describe("day shortcuts", () => {
  // 3-hourly valid times from 2026-11-04 06:00Z to 2026-11-07 00:00Z
  const valid: string[] = [];
  for (let t = Date.UTC(2026, 10, 4, 6); t <= Date.UTC(2026, 10, 7, 0); t += 3 * 3.6e6) valid.push(new Date(t).toISOString().replace(".000", ""));
  const now = Date.UTC(2026, 10, 4, 20, 10);
  it("one chip per day: Today jumps to now, others to the step nearest noon, a lone midnight step is skipped", () => {
    const chips = dayShortcuts(valid, now, "utc");
    expect(chips.map((c) => c.label)).toEqual(["Today", "Tomorrow", "Fri 6"]);
    expect(valid[chips[0].index]).toBe("2026-11-04T21:00:00Z");       // nearest step to 20:10
    expect(valid[chips[1].index]).toBe("2026-11-05T12:00:00Z");
    expect(valid[chips[2].index]).toBe("2026-11-06T12:00:00Z");
  });
  it("respects the first selectable step", () => {
    const chips = dayShortcuts(valid, now, "utc", valid.indexOf("2026-11-05T09:00:00Z"));
    expect(chips.every((c) => c.index >= valid.indexOf("2026-11-05T09:00:00Z"))).toBe(true);
  });
  it("localDate follows the zone", () => {
    const t = Date.UTC(2026, 10, 4, 20, 0);                           // 20:00 UTC is already the 5th in India (+5:30)
    expect(localDate(t, "utc")).toBe("2026-11-04");
  });
});

describe("place headline", () => {
  const mk = (cum: number[], temps: number[], winds: number[]) => cum.map((c, i) => ({ step_h: i * 6, valid_time_utc: new Date(Date.UTC(2026, 10, 4, i * 6)).toISOString().replace(".000", ""),
    cumulative_mm: c, interval_mm: null, interval_hours: null, temp_c: temps[i], wind_speed_ms: winds[i] }));
  it("rain, temperature range and wind for the 24 h from the step nearest now", () => {
    const s = mk([0, 1, 3, 9, 12, 30], [20, 22, 25, 30, 28, 24], [1, 2, 3, 4, 5, 6]);
    const h = placeHeadline(s, Date.UTC(2026, 10, 4, 6, 30))!;          // nearest step = index 1 (06:00)
    expect(h.startIdx).toBe(1);
    expect(h.endIdx).toBe(5);
    expect(h.hours).toBe(24);
    expect(h.rainMm).toBe(29);
    expect([h.tMin, h.tMax, h.windMax]).toEqual([22, 30, 6]);
  });
  it("is null when under 6 h of forecast remain", () => {
    expect(placeHeadline(mk([0, 1, 2], [1, 1, 1], [1, 1, 1]), Date.UTC(2026, 10, 4, 12))).toBeNull();
  });
});

describe("rain presets", () => {
  it("maps kind and window length to plain-language choices", () => {
    expect(rainPreset("window", 24)).toBe("next24");
    expect(rainPreset("window", 48)).toBe("next48");
    expect(rainPreset("window", 12)).toBe("custom");
    expect(rainPreset("interval", 24)).toBe("steps");
    expect(rainPreset("cumulative", 24)).toBe("total");
  });
});
