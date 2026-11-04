import { describe, expect, it } from "vitest";
import { buildStory } from "./rainStory";
import type { SeriesPoint } from "./api";
import { classOf, THRESHOLDS } from "./colors";

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
  it("reports dry when nothing reaches 0.1 mm", () => {
    expect(buildStory(mk([0, 0.05, 0.05])).dry).toBe(true);
  });
});

describe("colour classes", () => {
  it("below first threshold is transparent (-1) and boundaries are inclusive", () => {
    const t = THRESHOLDS.interval;
    expect(classOf(0.09, t)).toBe(-1);
    expect(classOf(0.1, t)).toBe(0);
    expect(classOf(50, t)).toBe(t.length - 1);
  });
});
