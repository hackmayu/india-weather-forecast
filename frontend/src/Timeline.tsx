import type { Kind, RunMeta } from "./api";
import { formatTime, type Zone } from "./time";

interface Props {
  meta: RunMeta;
  index: number;
  kind: Kind;
  zone: Zone;
  playing: boolean;
  onIndex: (i: number) => void;
  onPlaying: (p: boolean) => void;
}

export default function Timeline({ meta, index, kind, zone, playing, onIndex, onPlaying }: Props) {
  const min = kind === "interval" ? 1 : 0;
  const max = meta.steps_h.length - 1;
  const step = (d: number) => onIndex(Math.min(max, Math.max(min, index + d)));
  return (
    <section className="timeline" aria-label="Forecast timeline">
      <div className="tl-controls">
        <button type="button" onClick={() => onPlaying(!playing)} aria-pressed={playing}>
          {playing ? "⏸ Pause" : "▶ Play"}
        </button>
        <button type="button" onClick={() => step(-1)} disabled={index <= min} aria-label="Previous time step">◀</button>
        <button type="button" onClick={() => step(1)} disabled={index >= max} aria-label="Next time step">▶</button>
        <label className="tl-select">
          <span className="sr-only">Jump to valid time</span>
          <select value={index} onChange={(e) => onIndex(Number(e.target.value))}>
            {meta.valid_times_utc.map((t, i) => i >= min && (
              <option key={t} value={i}>
                +{meta.steps_h[i]} h · {formatTime(t, zone)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <input
        type="range" min={min} max={max} value={index} step={1}
        onChange={(e) => onIndex(Number(e.target.value))}
        aria-label="Forecast time"
        aria-valuetext={`+${meta.steps_h[index]} hours, ${formatTime(meta.valid_times_utc[index], zone)}`}
      />
      <div className="tl-ends" aria-hidden="true">
        <span>{formatTime(meta.valid_times_utc[min], zone)}</span>
        <span>{formatTime(meta.valid_times_utc[max], zone)}</span>
      </div>
    </section>
  );
}
