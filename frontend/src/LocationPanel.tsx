import type { PointResp, RunMeta } from "./api";
import { buildStory } from "./rainStory";
import { formatTime, type Zone } from "./time";

interface Props {
  meta: RunMeta;
  point: PointResp | null;
  loading: boolean;
  error: string | null;
  index: number;
  zone: Zone;
  onIndex: (i: number) => void;
}

const W = 520, PAD = { l: 44, r: 10, t: 8, b: 22 };

function Chart({ title, series, values, kind, index, onIndex, zone }: {
  title: string; series: PointResp["series"]; values: (number | null)[]; kind: "bar" | "line";
  index: number; onIndex: (i: number) => void; zone: Zone;
}) {
  const H = 130;
  const n = series.length;
  const maxV = Math.max(1, ...values.map((v) => v ?? 0));
  const x = (i: number) => PAD.l + (i / (n - 1)) * (W - PAD.l - PAD.r);
  const y = (v: number) => H - PAD.b - (v / maxV) * (H - PAD.b - PAD.t);
  const bw = Math.max(1.5, ((W - PAD.l - PAD.r) / (n - 1)) * 0.8);
  const ticks = [0, maxV / 2, maxV];
  const dayTicks = series.map((s, i) => ({ s, i })).filter(({ s }) => s.step_h % 24 === 0);
  const peak = values.reduce<number>((b, v, i) => ((v ?? -1) > (values[b] ?? -1) ? i : b), 0);
  return (
    <figure className="chart">
      <figcaption>{title}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img"
        aria-label={`${title}. Peak ${values[peak]?.toFixed(1)} mm at ${formatTime(series[peak].valid_time_utc, zone)}. Full numbers are in the data table below.`}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const frac = ((e.clientX - r.left) / r.width) * W;
          onIndex(Math.min(n - 1, Math.max(0, Math.round(((frac - PAD.l) / (W - PAD.l - PAD.r)) * (n - 1)))));
        }}>
        {ticks.map((t) => (
          <g key={t}><line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} className="grid" />
            <text x={PAD.l - 5} y={y(t) + 3} textAnchor="end" className="axis">{t < 10 ? t.toFixed(1) : Math.round(t)}</text></g>
        ))}
        {dayTicks.map(({ s, i }) => (
          <text key={s.step_h} x={x(i)} y={H - 6} textAnchor="middle" className="axis">+{s.step_h / 24}d</text>
        ))}
        {kind === "bar"
          ? values.map((v, i) => v != null && v > 0 && <rect key={i} x={x(i) - bw / 2} y={y(v)} width={bw} height={y(0) - y(v)} className="bar" />)
          : <polyline className="line" fill="none" points={values.map((v, i) => `${x(i)},${y(v ?? 0)}`).join(" ")} />}
        <line x1={x(index)} x2={x(index)} y1={PAD.t} y2={H - PAD.b} className="cursor" />
        <text x={8} y={PAD.t + 4} className="axis unit" transform={`rotate(-90 8 ${H / 2})`} textAnchor="middle">mm</text>
      </svg>
    </figure>
  );
}

export default function LocationPanel({ meta, point, loading, error, index, zone, onIndex }: Props) {
  if (error) return <section className="panel" aria-live="polite"><h2>Selected location</h2><p className="error" role="alert">{error}</p></section>;
  if (loading && !point) return <section className="panel" aria-busy="true"><h2>Selected location</h2><p>Loading location forecast…</p></section>;
  if (!point) return (
    <section className="panel"><h2>Selected location</h2>
      <p>Click the map, or choose a place below, to see its forecast for the nearest 0.25° grid cell.</p></section>
  );
  const s = point.series;
  const story = buildStory(s);
  const t = (i: number) => formatTime(s[i].valid_time_utc, zone);
  return (
    <section className="panel" aria-live="polite" aria-busy={loading}>
      <h2>Selected location</h2>
      <p className="muted">
        Requested {point.requested.lat.toFixed(2)}°N, {point.requested.lon.toFixed(2)}°E → grid cell centre{" "}
        <strong>{point.grid_point.lat.toFixed(2)}°N, {point.grid_point.lon.toFixed(2)}°E</strong>. {point.method}
      </p>
      <Chart title="Precipitation in each interval (mm per interval)" series={s} values={s.map((p) => p.interval_mm)} kind="bar" index={index} onIndex={onIndex} zone={zone} />
      <Chart title="Cumulative precipitation since issue time (mm)" series={s} values={s.map((p) => p.cumulative_mm)} kind="line" index={index} onIndex={onIndex} zone={zone} />

      <div className="story">
        <h3>Rain story <span className="tag">calculated from this forecast</span></h3>
        {story.dry ? (
          <p>This run forecasts essentially no rain at this grid cell through +{s[s.length - 1].step_h} h: no interval reaches
            0.5 mm (cumulative value {story.total.toFixed(1)} mm). Amounts this small are comparable to the precision of the
            stored data, so small wiggles in the cumulative line are not meaningful.</p>
        ) : (
          <ul>
            <li>Total over the {s[s.length - 1].step_h} h horizon: <strong>{story.total.toFixed(1)} mm</strong>.</li>
            {story.wettest && <li>Largest {story.wettest.hours} h interval: <strong>{story.wettest.mm.toFixed(1)} mm</strong>, {t(story.wettest.startIdx)} → {t(story.wettest.endIdx)}.</li>}
            {story.wettestDay && <li>Largest 24 h amount: <strong>{story.wettestDay.mm.toFixed(1)} mm</strong>, {t(story.wettestDay.startIdx)} → {t(story.wettestDay.endIdx)}.</li>}
            {story.first ? <li>First interval with at least 1 mm ends {t(story.first.idx)}.</li> : <li>No interval reaches 1 mm.</li>}
          </ul>
        )}
        <p className="muted small">One deterministic model run for a 0.25° cell (~28 km). It is not an observation, probability, warning or advice.</p>
      </div>

      <details>
        <summary>Show data table</summary>
        <div className="table-wrap">
          <table>
            <caption>Run {meta.run_id} at grid cell {point.grid_point.lat}°N, {point.grid_point.lon}°E (mm of water)</caption>
            <thead><tr><th scope="col">Valid time</th><th scope="col">Interval (mm)</th><th scope="col">Cumulative (mm)</th></tr></thead>
            <tbody>
              {s.map((p, i) => (
                <tr key={p.step_h} aria-current={i === index}>
                  <th scope="row">+{p.step_h} h · {t(i)}</th>
                  <td>{p.interval_mm == null ? "–" : `${p.interval_mm.toFixed(2)} (${p.interval_hours} h)`}</td>
                  <td>{p.cumulative_mm.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
