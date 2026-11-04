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

/**
 * Paint the grid into a canvas using Web-Mercator row spacing so it lines up with the base map.
 * smooth=true bilinearly interpolates between cell centres purely for DISPLAY (soft contour edges);
 * it adds no information, and hover/location readouts always report the underlying 0.25 deg cell.
 * smooth=false draws the raw 0.25 deg cells.
 */
export function renderGrid(data: MapResp, scale: Scale, smooth: boolean): { url: string; coordinates: [number, number][] } {
  const nlat = data.lats.length, nlon = data.lons.length;
  const latTop = data.lats[0] + CELL / 2, latBot = data.lats[nlat - 1] - CELL / 2;
  const lonL = data.lons[0] - CELL / 2, lonR = data.lons[nlon - 1] + CELL / 2;
  const W = nlon * (smooth ? 6 : 4);
  const xSpan = ((lonR - lonL) * Math.PI) / 180;
  const ySpan = merc(latTop) - merc(latBot);
  const H = Math.round((W * ySpan) / xSpan);
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(W, H);
  for (let py = 0; py < H; py++) {
    const m = merc(latTop) - ((py + 0.5) / H) * ySpan;
    const lat = (2 * Math.atan(Math.exp(m)) - Math.PI / 2) * (180 / Math.PI);
    const fy = (data.lats[0] - lat) / CELL; // fractional row, cell centres at integers
    for (let px = 0; px < W; px++) {
      const fx = (lonL + ((px + 0.5) / W) * (lonR - lonL) - data.lons[0]) / CELL;
      const v = smooth
        ? bilinear(data.values, fy, fx)
        : data.values[Math.min(nlat - 1, Math.max(0, Math.round(fy)))][Math.min(nlon - 1, Math.max(0, Math.round(fx)))];
      const [r, g, b, a] = colorAt(scale, v);
      if (!a) continue;
      const o = (py * W + px) * 4;
      img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = a;
    }
  }
  ctx.putImageData(img, 0, 0);
  return { url: canvas.toDataURL("image/png"), coordinates: [[lonL, latTop], [lonR, latTop], [lonR, latBot], [lonL, latBot]] };
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
