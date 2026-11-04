import { describe, expect, it } from "vitest";
import { fracIndex, indexForNow, nearestIndex, nextRun, relTime } from "./time";

const valid = ["2026-11-04T00:00:00Z", "2026-11-04T03:00:00Z", "2026-11-04T06:00:00Z", "2026-11-04T09:00:00Z"];
const at = (s: string) => Date.parse(s);

describe("indexForNow", () => {
  it("interval totals use the interval that contains now (index = its end step)", () => {
    expect(indexForNow(valid, at("2026-11-04T04:00:00Z"), true)).toEqual({ index: 2, state: "within" });
    expect(indexForNow(valid, at("2026-11-04T03:00:00Z"), true)).toEqual({ index: 2, state: "within" }); // boundary belongs to the next interval
  });
  it("instantaneous fields use the nearest valid time", () => {
    expect(indexForNow(valid, at("2026-11-04T04:00:00Z"), false)).toEqual({ index: 1, state: "within" });
    expect(indexForNow(valid, at("2026-11-04T05:00:00Z"), false)).toEqual({ index: 2, state: "within" });
  });
  it("reports before/after the horizon", () => {
    expect(indexForNow(valid, at("2026-11-03T00:00:00Z"), true)).toEqual({ index: 1, state: "before" });
    expect(indexForNow(valid, at("2026-11-05T00:00:00Z"), true)).toEqual({ index: 3, state: "after" });
  });
});

describe("fracIndex / nearestIndex", () => {
  it("interpolates linearly in time and is null outside the horizon", () => {
    expect(fracIndex(valid, at("2026-11-04T04:30:00Z"))).toBeCloseTo(1.5);
    expect(fracIndex(valid, at("2026-11-03T23:00:00Z"))).toBeNull();
    expect(fracIndex(valid, at("2026-11-04T10:00:00Z"))).toBeNull();
  });
  it("finds the nearest step", () => { expect(nearestIndex(valid, at("2026-11-04T07:00:00Z"))).toBe(2); });
});

describe("nextRun", () => {
  it("uses the measured typical delay for the next run's hour", () => {
    const n = nextRun(at("2026-11-04T06:00:00Z"), at("2026-11-04T13:00:00Z")); // next = 12 UTC, +7.57 h
    expect(new Date(n.issueMs).toISOString()).toBe("2026-11-04T12:00:00.000Z");
    expect((n.expectedMs - n.issueMs) / 3.6e6).toBeCloseTo(7.57);
    expect(n.overdue).toBe(false);
  });
  it("is overdue when the typical time has passed", () => {
    expect(nextRun(at("2026-11-04T00:00:00Z"), at("2026-11-04T13:00:00Z")).overdue).toBe(true); // 06 UTC expected 12:27
  });
});

describe("relTime", () => {
  it("formats past and future", () => {
    expect(relTime(-(7 * 60 + 36) * 60_000)).toBe("7 h 36 min ago");
    expect(relTime(125 * 60_000)).toBe("in 2 h 5 min");
    expect(relTime(10_000)).toBe("just now");
  });
});
