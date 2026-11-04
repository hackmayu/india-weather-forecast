import type { Kind } from "./api";

// Sequential light->dark scale; lightness decreases monotonically so it stays readable in greyscale
// and for common colour-vision deficiencies. Values below the first threshold are drawn
// transparent, meaning "below 0.1 mm", not "exactly zero".
export const COLORS = ["#c6e2f5", "#9ccbec", "#6db0e0", "#4690d0", "#2f6db8", "#2d4a9e", "#4a3694", "#6c2287", "#8c1257"];

export const THRESHOLDS: Record<Kind, number[]> = {
  interval: [0.1, 0.5, 1, 2.5, 5, 10, 20, 35, 50],      // mm per interval (3 h)
  cumulative: [0.1, 1, 5, 10, 25, 50, 100, 150, 200],  // mm since issue time
};

/** Index of the class containing v, or -1 when v is below the first threshold. */
export function classOf(v: number, thresholds: number[]): number {
  let c = -1;
  for (let i = 0; i < thresholds.length; i++) if (v >= thresholds[i]) c = i;
  return c;
}

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function classLabel(i: number, thresholds: number[]): string {
  const lo = thresholds[i];
  return i === thresholds.length - 1 ? `≥ ${lo}` : `${lo} – ${thresholds[i + 1]}`;
}
