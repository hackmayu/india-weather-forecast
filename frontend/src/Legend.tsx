import type { Kind } from "./api";
import { COLORS, classLabel } from "./colors";

export default function Legend({ kind, thresholds, hours }: { kind: Kind; thresholds: number[]; hours: number }) {
  const title = kind === "interval" ? `Precipitation in the ${hours} h interval (mm of water)` : "Cumulative precipitation since issue time (mm of water)";
  return (
    <figure className="legend" aria-label={title}>
      <figcaption>{title}</figcaption>
      <ul>
        {thresholds.map((_, i) => (
          <li key={i}><span className="swatch" style={{ background: COLORS[i] }} aria-hidden="true" />{classLabel(i, thresholds)}</li>
        ))}
        <li><span className="swatch none" aria-hidden="true" />&lt; {thresholds[0]} (not coloured)</li>
      </ul>
    </figure>
  );
}
