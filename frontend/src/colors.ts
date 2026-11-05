import type { Kind } from "./api";

export type Variable = "precip" | "temp" | "cloud" | "wind" | "prob";
export type Palette = "radar" | "accessible";

export interface Stop { v: number; color: string; alpha?: number } // alpha 0..1, default 1

export type Scale =
  | { type: "classes"; thresholds: number[]; colors: string[]; unit: string; title: string }
  | { type: "ramp"; stops: Stop[]; unit: string; title: string };

// Rain: discrete classes so every colour in the legend maps to a stated range.
// "radar": familiar weather-radar progression (blue -> green -> yellow -> orange -> red -> magenta).
// "accessible": single-hue-to-purple ramp whose lightness changes monotonically (readable in
// greyscale and for common colour-vision deficiencies).
const RADAR = ["#b9e3f6", "#74c4ef", "#3d9be0", "#2e6fcf", "#3bb55a", "#b5d334", "#f6cf2a", "#f28a1b", "#e03a2c", "#b0197f"];
const ACCESSIBLE = ["#d6ebf7", "#c6e2f5", "#9ccbec", "#6db0e0", "#4690d0", "#2f6db8", "#2d4a9e", "#4a3694", "#6c2287", "#8c1257"];

const RAIN_INTERVAL = [0.1, 0.5, 1, 2.5, 5, 10, 20, 35, 50, 75];          // mm per interval
const RAIN_CUMULATIVE = [0.1, 1, 5, 10, 25, 50, 100, 150, 200, 300];      // mm since issue time
const RAIN_WINDOW = [0.1, 1, 2.5, 5, 10, 25, 50, 100, 150, 200];          // mm over a chosen window (e.g. 24 h)

// The scale object is compared by identity (React effects redraw the map when it changes). Returning a fresh object on every
// render made the whole map re-rasterise each time anything changed, e.g. when a place was picked. Same inputs -> same object.
const scaleCache = new Map<string, Scale>();
export function getScale(variable: Variable, kind: Kind, palette: Palette): Scale {
  const key = `${variable}|${kind}|${palette}`;
  let s = scaleCache.get(key);
  if (!s) { s = buildScale(variable, kind, palette); scaleCache.set(key, s); }
  return s;
}

function buildScale(variable: Variable, kind: Kind, palette: Palette): Scale {
  switch (variable) {
    case "precip":
      return {
        type: "classes", thresholds: kind === "interval" ? RAIN_INTERVAL : kind === "window" ? RAIN_WINDOW : RAIN_CUMULATIVE,
        colors: palette === "radar" ? RADAR : ACCESSIBLE, unit: "mm",
        title: kind === "interval" ? "Precipitation in the interval (mm of water)" : kind === "window" ? "Precipitation over the window (mm of water)" : "Cumulative precipitation since issue time (mm of water)",
      };
    case "temp":
      return {
        type: "ramp", unit: "°C", title: "2 m air temperature (°C)",
        stops: [{ v: -30, color: "#5b2a86" }, { v: -10, color: "#3b6fd0" }, { v: 0, color: "#7fc4f0" },
          { v: 10, color: "#7bd389" }, { v: 20, color: "#f2e34b" }, { v: 30, color: "#f08a24" }, { v: 40, color: "#c0272d" }],
      };
    case "cloud":
      return {
        type: "ramp", unit: "%", title: "Total cloud cover (%)",
        stops: [{ v: 0, color: "#ffffff", alpha: 0 }, { v: 30, color: "#cbd2da", alpha: 0.25 },
          { v: 70, color: "#8d97a4", alpha: 0.6 }, { v: 100, color: "#4b5563", alpha: 0.85 }],
      };
    case "prob":
      return {
        type: "ramp", unit: "%", title: "Chance of reaching the rain amount (%)",
        stops: [{ v: 0, color: "#ffffff", alpha: 0 }, { v: 5, color: "#dbe9fb", alpha: 0.35 }, { v: 20, color: "#9ccbec" },
          { v: 40, color: "#4690d0" }, { v: 60, color: "#2f6db8" }, { v: 80, color: "#4a3694" }, { v: 100, color: "#6c2287" }],
      };
    case "wind":
      return {
        type: "ramp", unit: "m/s", title: "10 m wind speed (m/s)",
        stops: [{ v: 0, color: "#e8f4fb", alpha: 0.15 }, { v: 3, color: "#9ad4f5", alpha: 0.6 }, { v: 7, color: "#4aa3df" },
          { v: 12, color: "#ffd43b" }, { v: 18, color: "#f08a24" }, { v: 25, color: "#d6336c" }],
      };
  }
}

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Index of the class containing v, or -1 when v is below the first threshold. */
export function classOf(v: number, thresholds: number[]): number {
  let c = -1;
  for (let i = 0; i < thresholds.length; i++) if (v >= thresholds[i]) c = i;
  return c;
}

export function classLabel(i: number, thresholds: number[]): string {
  const lo = thresholds[i];
  return i === thresholds.length - 1 ? `≥ ${lo}` : `${lo} – ${thresholds[i + 1]}`;
}

const CLASS_ALPHA = 235;

/** RGBA (0-255) for a value. Classes below the first threshold are fully transparent. */
export function colorAt(scale: Scale, v: number): [number, number, number, number] {
  if (scale.type === "classes") {
    const c = classOf(v, scale.thresholds);
    if (c < 0) return [0, 0, 0, 0];
    const [r, g, b] = hexToRgb(scale.colors[c]);
    return [r, g, b, CLASS_ALPHA];
  }
  const s = scale.stops;
  if (v <= s[0].v) { const [r, g, b] = hexToRgb(s[0].color); return [r, g, b, Math.round((s[0].alpha ?? 1) * 235)]; }
  for (let i = 1; i < s.length; i++) {
    if (v <= s[i].v) {
      const t = (v - s[i - 1].v) / (s[i].v - s[i - 1].v);
      const a = hexToRgb(s[i - 1].color), b = hexToRgb(s[i].color);
      const al = (s[i - 1].alpha ?? 1) * (1 - t) + (s[i].alpha ?? 1) * t;
      return [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t),
        Math.round(a[2] + (b[2] - a[2]) * t), Math.round(al * 235)];
    }
  }
  const last = s[s.length - 1]; const [r, g, b] = hexToRgb(last.color);
  return [r, g, b, Math.round((last.alpha ?? 1) * 235)];
}
