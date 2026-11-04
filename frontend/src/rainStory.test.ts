import { describe, expect, it } from "vitest";
import { buildStory } from "./rainStory";
import type { SeriesPoint } from "./api";
import { classOf, colorAt, getScale } from "./colors";

const mk = (cum: number[], stepH = 12): SeriesPoint[] =>
  cum.map((c, i) => ({ step_h: i * stepH, valid_time_utc: "x", cumulative_mm: c,
    interval_mm: i ? c - cum[i - 1] : null, interval_hours: i ? stepH : null }));

describe("rain story", () => {
  it("finds the wettest interval and the first wet one", () => {
    const s = buildStory(mk([0, 0.2, 0.4, 10.4, 11]));
    expect(s.wettest).toMatchObject({ startIdx: 2, endIdx: 3 });
    expect(s.wettest!.mm).toBeCloseTo(10);
    expect(s.first).toEqual({ idx: 3 });
    expect(s.total).toBe(11);
  });
  it("wettest 24 h window uses cumulative differences 24 h apart", () => {
    const s = buildStory(mk([0, 1, 2, 10, 11])); // 12 h steps
    expect(s.wettestDay).toMatchObject({ startIdx: 1, endIdx: 3 });
    expect(s.wettestDay!.mm).toBeCloseTo(9);
  });
  it("reports dry/trace when no interval reaches 0.5 mm (below data precision)", () => {
    expect(buildStory(mk([0, 0.05, 0.05])).dry).toBe(true);
    expect(buildStory(mk([0, 0.3, 0.4])).dry).toBe(true);
    expect(buildStory(mk([0, 0.6, 0.6])).dry).toBe(false);
  });
});

describe("colour classes", () => {
  it("below first threshold is transparent (-1) and boundaries are inclusive", () => {
    const t = getScale("precip", "interval", "radar");
    if (t.type !== "classes") throw new Error("expected classes");
    expect(classOf(0.09, t.thresholds)).toBe(-1);
    expect(classOf(0.1, t.thresholds)).toBe(0);
    expect(classOf(75, t.thresholds)).toBe(t.thresholds.length - 1);
    expect(colorAt(t, 0.05)[3]).toBe(0);          // transparent below the first class
    expect(colorAt(t, 3)[3]).toBeGreaterThan(0);
  });
});

import { buildFacts, compass } from "./rainStory";
describe("compass and facts", () => {
  it("names bearings (direction wind comes FROM)", () => {
    expect([0, 90, 180, 270, 225, 359].map(compass)).toEqual(["N", "E", "S", "W", "SW", "N"]);
  });
  it("finds temperature extremes and strongest wind", () => {
    const s = [10, 25, 18].map((t, i) => ({ step_h: i * 3, valid_time_utc: "x", cumulative_mm: 0, interval_mm: null, interval_hours: null,
      temp_c: t, cloud_pct: 50, wind_speed_ms: [2, 9, 4][i], wind_from_deg: [0, 270, 90][i] }));
    const f = buildFacts(s);
    expect(f.tMin).toEqual({ idx: 0, v: 10 });
    expect(f.tMax).toEqual({ idx: 1, v: 25 });
    expect(f.windMax).toEqual({ idx: 1, v: 9, from: 270 });
    expect(f.cloudMean).toBe(50);
  });
});

describe("ramp scales", () => {
  it("interpolates temperature colours linearly between stops", () => {
    const s = getScale("temp", "interval", "radar");
    const at0 = colorAt(s, 0), at10 = colorAt(s, 10), mid = colorAt(s, 5);
    expect(mid[0]).toBeCloseTo((at0[0] + at10[0]) / 2, -0.5);
  });
  it("cloud cover is transparent at 0 % and increasingly opaque", () => {
    const s = getScale("cloud", "interval", "radar");
    expect(colorAt(s, 0)[3]).toBe(0);
    expect(colorAt(s, 100)[3]).toBeGreaterThan(colorAt(s, 50)[3]);
  });
  it("clamps outside the stop range", () => {
    const s = getScale("temp", "interval", "radar");
    expect(colorAt(s, -80)).toEqual(colorAt(s, -30));
    expect(colorAt(s, 80)).toEqual(colorAt(s, 40));
  });
});

import { compareRuns } from "./rainStory";
import type { PointResp } from "./api";
describe("compareRuns", () => {
  const mkp = (times: string[], cum: number[]): PointResp => ({
    run_id: "x", requested: { lat: 0, lon: 0 }, grid_point: { lat: 0, lon: 0 }, method: "", units: "mm",
    series: times.map((t, i) => ({ step_h: i * 6, valid_time_utc: t, cumulative_mm: cum[i], interval_mm: i ? cum[i] - cum[i - 1] : null, interval_hours: i ? 6 : null })),
  });
  const T = ["2026-11-04T06:00:00Z", "2026-11-04T12:00:00Z", "2026-11-04T18:00:00Z", "2026-11-05T00:00:00Z"];
  it("compares totals over the shared period starting at the newer run's issue time", () => {
    const cur = mkp(T.slice(0, 3), [0, 4, 6]);                                  // newer run: issued 06 UTC
    const prev = mkp(["2026-11-04T00:00:00Z", ...T], [0, 1, 3, 10, 12]);        // older run issued 00 UTC
    const c = compareRuns(cur, prev)!;
    expect(c.startIso).toBe(T[0]);
    expect(c.endIso).toBe(T[2]);
    expect(c.curMm).toBe(6);
    expect(c.prevMm).toBe(9);                                                   // prev: cum(18Z)=10 minus cum(06Z)=1
    expect(c.curMax.mm).toBe(4);
    expect(c.prevMax.mm).toBe(7);
  });
  it("returns null when the runs share no period", () => {
    expect(compareRuns(mkp(T.slice(0, 2), [0, 1]), mkp(["2026-11-10T00:00:00Z"], [0]))).toBeNull();
  });
});
