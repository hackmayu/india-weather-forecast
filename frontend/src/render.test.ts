import { describe, expect, it } from "vitest";
import type { MapResp } from "./api";
import { bilinear, windArrows } from "./render";

describe("bilinear display interpolation", () => {
  const g = [[0, 10], [20, 30]];
  it("returns the cell value exactly at cell centres", () => {
    expect(bilinear(g, 0, 0)).toBe(0);
    expect(bilinear(g, 0, 1)).toBe(10);
    expect(bilinear(g, 1, 1)).toBe(30);
  });
  it("blends linearly between centres and clamps beyond the edge", () => {
    expect(bilinear(g, 0, 0.5)).toBe(5);
    expect(bilinear(g, 0.5, 0.5)).toBe(15);
    expect(bilinear(g, -3, -3)).toBe(0);
    expect(bilinear(g, 9, 9)).toBe(30);
  });
});

describe("wind arrows", () => {
  const mk = (u: number, v: number): MapResp => ({
    run_id: "x", step_h: 0, variable: "wind", kind: "instant", valid_time_utc: "x", accumulation_hours: 0, units: "m/s",
    lats: [10, 9.75, 9.5, 9.25, 9], lons: [70, 70.25, 70.5, 70.75, 71],
    values: [], u: Array(5).fill(Array(5).fill(u)), v: Array(5).fill(Array(5).fill(v)),
  });
  const shaft = (a: MapResp) => (windArrows(a, 4).geometry.coordinates[0]);
  it("a westerly wind (u>0) draws the arrow pointing east", () => {
    const [tail, head] = shaft(mk(8, 0));
    expect(head[0]).toBeGreaterThan(tail[0]);
    expect(head[1]).toBeCloseTo(tail[1], 6);
  });
  it("a northerly wind (v<0, air moving south) points south", () => {
    const [tail, head] = shaft(mk(0, -8));
    expect(head[1]).toBeLessThan(tail[1]);
  });
  it("skips near-calm cells", () => {
    expect(windArrows(mk(0.2, 0.2), 4).geometry.coordinates.length).toBe(0);
  });
});

import { buildColorizer, rasterize } from "./render";
import { getScale } from "./colors";

describe("rasterize", () => {
  const grid = (): MapResp => ({ lats: [10.25, 10, 9.75], lons: [70, 70.25, 70.5], values: [[0, 1, 2], [3, 4, 5], [6, 7, 8]] } as unknown as MapResp);
  it("is deterministic with the right size and corners", () => {
    const sc = getScale("temp", "interval", "classic" as never);
    const a = rasterize(grid(), sc, true), b = rasterize(grid(), sc, true);
    expect(a.width).toBe(15);   // 3 columns x 5 px per cell
    expect(Array.from(a.data.slice(0, 400))).toEqual(Array.from(b.data.slice(0, 400)));
    expect(a.data.length).toBe(a.width * a.height * 4);
    expect(a.coordinates[0][0]).toBeCloseTo(69.875);
  });
  it("colorizer is monotone-defined and transparent below first class", () => {
    const sc = getScale("precip", "interval", "classic" as never);
    const f = buildColorizer(sc);
    expect(f(-5)).toBe(0);
    expect(f(1e6)).not.toBe(0);
  });
});
