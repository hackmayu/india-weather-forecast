import type { MapResp } from "./api";
import { colorAt, type Scale } from "./colors";

const CELL = 0.25; // source grid spacing (deg)
const merc = (latDeg: number) => Math.log(Math.tan(Math.PI / 4 + (latDeg * Math.PI) / 360));

/**
 * Bilinear sample at fractional grid position (fy rows from north, fx cols from west), where
 * integer positions are cell CENTRES. Edge positions are clamped to the outermost cells.
 */
export function bilinear(values: number[][], fy: number, fx: number): number {
  const ny = values.length, nx = values[0].length;
  const y = Math.min(ny - 1, Math.max(0, fy)), x = Math.min(nx - 1, Math.max(0, fx));
  const y0 = Math.floor(y), x0 = Math.floor(x);
  const y1 = Math.min(ny - 1, y0 + 1), x1 = Math.min(nx - 1, x0 + 1);
  const ty = y - y0, tx = x - x0;
  const top = values[y0][x0] * (1 - tx) + values[y0][x1] * tx;
  const bot = values[y1][x0] * (1 - tx) + values[y1][x1] * tx;
  return top * (1 - ty) + bot * ty;
}

// ---------------------------------------------------------------------------------------------------
// Rasterising a grid for the map. Performance matters here: this runs on every time step / slider move /
// Play tick. Measured before the rewrite (CPU slowed 4x): ~1.7 s per step, dominated by per-pixel work
// (a hex-colour parse and several small allocations for each of ~700,000 pixels) plus a synchronous PNG encode.
// Now: precomputed palettes, typed arrays, interpolation positions computed once per row/column, 4x instead
// of 6x oversampling, and the PNG is encoded asynchronously (see rasterToBlob).
// ---------------------------------------------------------------------------------------------------

/** Output pixels per grid cell, per axis. 4 is visually indistinguishable from 6 at map zoom levels used here. */
const SMOOTH_PX_PER_CELL = 4;
const RAW_PX_PER_CELL = 4;
const LUT_SIZE = 1024;

/** RGBA packed for a little-endian Uint32Array view (bytes in memory: r, g, b, a). */
const pack = (c: [number, number, number, number]) => (((c[3] << 24) | (c[2] << 16) | (c[1] << 8) | c[0]) >>> 0);

/** value -> packed colour (0 = transparent). Built once per scale, not per pixel. */
export function buildColorizer(scale: Scale): (v: number) => number {
  if (scale.type === "classes") {
    const th = scale.thresholds;
    const col = th.map((t) => pack(colorAt(scale, t)));      // colour of each class, taken from the same source of truth
    const n = th.length;
    return (v) => {
      for (let c = n - 1; c >= 0; c--) if (v >= th[c]) return col[c];
      return 0;                                              // below the first threshold: not coloured
    };
  }
  const lo = scale.stops[0].v, hi = scale.stops[scale.stops.length - 1].v;
  const lut = new Uint32Array(LUT_SIZE);
  for (let i = 0; i < LUT_SIZE; i++) lut[i] = pack(colorAt(scale, lo + ((i + 0.5) / LUT_SIZE) * (hi - lo)));
  lut[0] = pack(colorAt(scale, lo));
  const k = LUT_SIZE / (hi - lo);
  return (v) => (v <= lo ? lut[0] : v >= hi ? lut[LUT_SIZE - 1] : lut[((v - lo) * k) | 0]);
}

export interface Raster { width: number; height: number; data: Uint8ClampedArray; coordinates: [number, number][] }

/**
 * Paint the grid at Web-Mercator row spacing so it lines up with the base map.
 * smooth=true bilinearly interpolates between cell centres purely for DISPLAY (soft contour edges);
 * it adds no information, and hover/location readouts always report the underlying 0.25 deg cell.
 * smooth=false draws the raw 0.25 deg cells.
 */
export function rasterize(data: MapResp, scale: Scale, smooth: boolean): Raster {
  const nlat = data.lats.length, nlon = data.lons.length;
  const latTop = data.lats[0] + CELL / 2, latBot = data.lats[nlat - 1] - CELL / 2;
  const lonL = data.lons[0] - CELL / 2, lonR = data.lons[nlon - 1] + CELL / 2;
  const W = nlon * (smooth ? SMOOTH_PX_PER_CELL : RAW_PX_PER_CELL);
  const xSpan = ((lonR - lonL) * Math.PI) / 180;
  const ySpan = merc(latTop) - merc(latBot);
  const H = Math.round((W * ySpan) / xSpan);

  const v = new Float64Array(nlat * nlon);
  for (let y = 0; y < nlat; y++) { const row = data.values[y]; for (let x = 0; x < nlon; x++) v[y * nlon + x] = row[x]; }

  // interpolation positions: computed once per column / row instead of once per pixel
  const colX0 = new Int32Array(W), colX1 = new Int32Array(W), colT = new Float64Array(W);
  for (let px = 0; px < W; px++) {
    const fx = (lonL + ((px + 0.5) / W) * (lonR - lonL) - data.lons[0]) / CELL;
    if (smooth) {
      const x = Math.min(nlon - 1, Math.max(0, fx)), x0 = Math.floor(x);
      colX0[px] = x0; colX1[px] = Math.min(nlon - 1, x0 + 1); colT[px] = x - x0;
    } else { colX0[px] = colX1[px] = Math.min(nlon - 1, Math.max(0, Math.round(fx))); colT[px] = 0; }
  }
  const rowY0 = new Int32Array(H), rowY1 = new Int32Array(H), rowT = new Float64Array(H);
  for (let py = 0; py < H; py++) {
    const m = merc(latTop) - ((py + 0.5) / H) * ySpan;
    const lat = (2 * Math.atan(Math.exp(m)) - Math.PI / 2) * (180 / Math.PI);
    const fy = (data.lats[0] - lat) / CELL; // fractional row, cell centres at integers
    if (smooth) {
      const y = Math.min(nlat - 1, Math.max(0, fy)), y0 = Math.floor(y);
      rowY0[py] = y0; rowY1[py] = Math.min(nlat - 1, y0 + 1); rowT[py] = y - y0;
    } else { rowY0[py] = rowY1[py] = Math.min(nlat - 1, Math.max(0, Math.round(fy))); rowT[py] = 0; }
  }

  const colorize = buildColorizer(scale);
  const out = new Uint32Array(W * H);                        // zero = transparent
  for (let py = 0; py < H; py++) {
    const r0 = rowY0[py] * nlon, r1 = rowY1[py] * nlon, ty = rowT[py], oy = py * W;
    for (let px = 0; px < W; px++) {
      const x0 = colX0[px], x1 = colX1[px], tx = colT[px];
      const top = v[r0 + x0] * (1 - tx) + v[r0 + x1] * tx;
      const bot = v[r1 + x0] * (1 - tx) + v[r1 + x1] * tx;
      out[oy + px] = colorize(top * (1 - ty) + bot * ty);
    }
  }
  return { width: W, height: H, data: new Uint8ClampedArray(out.buffer), coordinates: [[lonL, latTop], [lonR, latTop], [lonR, latBot], [lonL, latBot]] };
}

/** PNG-encode a raster. toBlob encodes off the main thread (the old toDataURL blocked it for ~130 ms per step at 4x CPU). */
export function rasterToBlob(r: Raster): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = r.width; canvas.height = r.height;
  const ctx = canvas.getContext("2d")!;
  ctx.putImageData(new ImageData(r.data as unknown as Uint8ClampedArray<ArrayBuffer>, r.width, r.height), 0, 0);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG encoding failed"))), "image/png"));
}

/**
 * Wind arrows as GeoJSON lines (shaft + two head strokes), one per `stride` cells. The arrow points
 * the way the air is moving (toward), length grows with speed. In Web Mercator a degree of latitude
 * is drawn 1/cos(lat) taller than a degree of longitude, so dlat is scaled by cos(lat) to keep the
 * on-screen angle equal to the wind direction.
 */
export function windArrows(data: MapResp, stride = 4): GeoJSON.Feature<GeoJSON.MultiLineString> {
  const lines: [number, number][][] = [];
  if (data.u && data.v) {
    for (let y = Math.floor(stride / 2); y < data.lats.length; y += stride) {
      for (let x = Math.floor(stride / 2); x < data.lons.length; x += stride) {
        const u = data.u[y][x], v = data.v[y][x], sp = Math.hypot(u, v);
        if (sp < 1) continue;
        const lat = data.lats[y], lon = data.lons[x];
        const len = 0.45 + (Math.min(sp, 15) / 15) * 0.55;            // 0.45-1.0 deg of longitude on screen (grid stride is 1 deg)
        const ang = Math.atan2(u, v);                                 // bearing the air moves TOWARD (rad from north)
        const tip = (a: number, l: number): [number, number] => [lon + l * Math.sin(a), lat + l * Math.cos(a) * Math.cos((lat * Math.PI) / 180)];
        const tail: [number, number] = [lon - 0.5 * len * Math.sin(ang), lat - 0.5 * len * Math.cos(ang) * Math.cos((lat * Math.PI) / 180)];
        const head = tip(ang, len / 2), hl = len * 0.35;
        const back = (da: number): [number, number] => [head[0] - hl * Math.sin(ang + da), head[1] - hl * Math.cos(ang + da) * Math.cos((lat * Math.PI) / 180)];
        lines.push([tail, head], [head, back(0.45)], [head, back(-0.45)]);
      }
    }
  }
  return { type: "Feature", properties: {}, geometry: { type: "MultiLineString", coordinates: lines } };
}
