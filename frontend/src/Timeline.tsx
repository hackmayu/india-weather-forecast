import type { RunMeta } from "./api";
import { formatTime, type DayChip, type Zone } from "./time";

interface Props {
  meta: RunMeta;
  index: number;
  minIndex: number; // first selectable step (interval totals need a previous step, windows need enough run before them)
  zone: Zone;
  playing: boolean;
  onIndex: (i: number) => void;
  onPlaying: (p: boolean) => void;
  onNow: () => void;
  nowFrac: number | null; // fractional step index of the current time, null if outside the forecast horizon
  nowState: "before" | "within" | "after";
  days: DayChip[];        // one shortcut per calendar day the forecast covers
  activeDay: string;      // key (YYYY-MM-DD) of the day containing the selected time
}

export default function Timeline({ meta, index, minIndex: min, zone, playing, onIndex, onPlaying, onNow, nowFrac, nowState, days, activeDay }: Props) {
  const max = meta.steps_h.length - 1;
  const step = (d: number) => onIndex(Math.min(max, Math.max(min, index + d)));
  const when = formatTime(meta.valid_times_utc[index], zone);
  return (
    <section className="timeline" aria-label="Forecast timeline">
      <div className="tl-top">
        <div className="tl-time" aria-hidden="true"><strong>{when}</strong> <span className="muted">· +{meta.steps_h[index]} h</span></div>
        <div className="tl-btns">
          <button type="button" className="primary" onClick={() => onPlaying(!playing)} aria-pressed={playing}>
            {playing ? "⏸ Pause" : "▶ Play"}
          </button>
          <button type="button" onClick={() => step(-1)} disabled={index <= min} aria-label="Previous time step">◀</button>
          <button type="button" onClick={() => step(1)} disabled={index >= max} aria-label="Next time step">▶</button>
        </div>
      </div>

      <div className="day-chips" role="group" aria-label="Jump to a day">
        <button type="button" className="chipbtn now" onClick={onNow}
          title={nowState === "within" ? "Jump to the current time" : nowState === "after" ? "The current time is after the end of this forecast; jumps to the last step" : "The current time is before this forecast starts"}>
          ◉ Now
        </button>
        {days.map((d) => (
          <button type="button" key={d.key} className={`chipbtn ${d.key === activeDay ? "on" : ""}`} aria-pressed={d.key === activeDay} onClick={() => onIndex(d.index)}>
            {d.label}
          </button>
        ))}
      </div>

      <div className="slider-wrap">
        {nowFrac != null && nowFrac >= min && (
          <span className="now-mark" style={{ left: `${((nowFrac - min) / (max - min)) * 100}%` }} aria-hidden="true"><i />now</span>
        )}
        <input
          type="range" min={min} max={max} value={index} step={1}
          onChange={(e) => onIndex(Number(e.target.value))}
          aria-label="Forecast time"
          aria-valuetext={`+${meta.steps_h[index]} hours, ${when}`}
        />
      </div>
      <div className="tl-ends" aria-hidden="true">
        <span>{formatTime(meta.valid_times_utc[min], zone)}</span>
        <span>{formatTime(meta.valid_times_utc[max], zone)}</span>
      </div>

      <details className="tl-exact">
        <summary>Pick an exact time</summary>
        <label className="tl-select">
          <span className="sr-only">Jump to valid time</span>
          <select value={index} onChange={(e) => onIndex(Number(e.target.value))}>
            {meta.valid_times_utc.map((t, i) => i >= min && (
              <option key={t} value={i}>{formatTime(t, zone)} (+{meta.steps_h[i]} h)</option>
            ))}
          </select>
        </label>
      </details>
    </section>
  );
}
