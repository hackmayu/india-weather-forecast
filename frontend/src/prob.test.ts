import { describe, expect, it } from "vitest";
import { nearestWindow, textOn, type ProbWindow } from "./prob";
import { buildSearch, parseUrl } from "./urlState";
import { colorAt, getScale } from "./colors";

// ENS run issued 2026-11-04 00 UTC: 24 h windows start every 12 h
const issue = Date.UTC(2026, 10, 4, 0);
const windows: ProbWindow[] = [0, 12, 24].map((s) => ({
  start_h: s, end_h: s + 24,
  start_utc: new Date(issue + s * 3.6e6).toISOString().replace(".000", ""),
  end_utc: new Date(issue + (s + 24) * 3.6e6).toISOString().replace(".000", ""),
}));

describe("nearestWindow", () => {
  it("matches a window end exactly", () => {
    const m = nearestWindow(windows, issue + 36 * 3.6e6);
    expect(m.window.end_h).toBe(36);
    expect(m.exact).toBe(true);
    expect(m.offsetH).toBeCloseTo(0);
  });
  it("picks the closest end and reports how far off it is", () => {
    const m = nearestWindow(windows, issue + 30 * 3.6e6);            // between the 24 h and 36 h ends -> 6 h either side; ties go to the earlier
    expect([24, 36]).toContain(m.window.end_h);
    expect(m.exact).toBe(false);
    expect(Math.abs(m.offsetH)).toBeCloseTo(6);
    const near = nearestWindow(windows, issue + 33 * 3.6e6);         // 3 h before the 36 h end
    expect(near.window.end_h).toBe(36);
    expect(near.offsetH).toBeCloseTo(3);
  });
  it("clamps outside the covered range", () => {
    expect(nearestWindow(windows, issue).window.end_h).toBe(24);
    expect(nearestWindow(windows, issue + 500 * 3.6e6).window.end_h).toBe(48);
  });
});

describe("probability display helpers", () => {
  it("uses light text only on dark (high-probability) cells", () => {
    expect(textOn(10)).toBe("dark");
    expect(textOn(90)).toBe("light");
  });
  it("probability colours are transparent at 0 % and opaque by 100 %", () => {
    const s = getScale("prob", "interval", "radar");
    expect(colorAt(s, 0)[3]).toBe(0);
    expect(colorAt(s, 100)[3]).toBeGreaterThan(200);
    expect(colorAt(s, 60)[3]).toBeGreaterThan(colorAt(s, 5)[3]);
  });
  it("threshold URL param accepts only the published amounts", () => {
    expect(parseUrl("?v=prob&p=10")).toEqual({ v: "prob", p: 10 });
    expect(parseUrl("?v=prob&p=7")).toEqual({ v: "prob" });
    expect(buildSearch("", { v: "prob", p: 25 })).toBe("?v=prob&p=25");
    expect(buildSearch("", { v: "wind", p: 25 })).toBe("?v=wind");     // p only matters for the probability view
  });
});
