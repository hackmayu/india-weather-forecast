import { useState } from "react";
import type { PointResp, ProbMeta, ProbPointResp, RunMeta } from "./api";
import { dailyBlocks, placeHeadline } from "./blocks";
import { nearCity } from "./Overview";
import { colorAt, getScale } from "./colors";
import { textOn } from "./prob";
import { csvFilename, toCsv } from "./csv";
import { buildFacts, buildStory, compareRuns, compass } from "./rainStory";
import { formatShort, formatTime, type Zone } from "./time";

interface Props {
  meta: RunMeta;
  point: PointResp | null;
  loading: boolean;
  error: string | null;
  index: number;
  zone: Zone;
  onIndex: (i: number) => void;
  nowFrac: number | null;
  prev: { point: PointResp; issueIso: string } | null; // same location in the previous run, if available
  prob: ProbPointResp | null;       // ECMWF ensemble probabilities at this cell (separate system, 00/12 UTC runs)
  probMeta: ProbMeta | null;
  selectedWindowEnd: number | null; // end hour of the probability window shown on the map
  threshold: number;
  nowMs: number;
  onBack: () => void; // phone layout: scroll back up to the map
  onPickPreset: (lat: number, lon: number) => void;
}

const W = 520, PAD = { l: 44, r: 10, t: 8, b: 22 };

function Chart({ title, unit, series, values, kind, index, onIndex, zone, color, fixedMax, autoRange, nowFrac }: {
  title: string; unit: string; series: PointResp["series"]; values: (number | null)[]; kind: "bar" | "line";
  index: number; onIndex: (i: number) => void; zone: Zone; color?: string; fixedMax?: number; autoRange?: boolean; nowFrac?: number | null;
}) {
  const H = 130;
  const n = series.length;
  const nums = values.map((v) => v ?? 0);
  // Bars and accumulations start at 0. Temperature (autoRange) is not a quantity that starts at 0, so
  // its axis fits the data (with a 1 degree margin) to keep the daily cycle visible.
  const rawMin = autoRange ? Math.floor(Math.min(...nums) - 1) : kind === "line" ? Math.min(0, ...nums) : 0;
  const rawMax = fixedMax ?? (autoRange ? Math.ceil(Math.max(...nums) + 1) : Math.max(1, ...nums));
  const span = rawMax - rawMin || 1;
  const x = (i: number) => PAD.l + (i / (n - 1)) * (W - PAD.l - PAD.r);
  const y = (v: number) => H - PAD.b - ((v - rawMin) / span) * (H - PAD.b - PAD.t);
  const bw = Math.max(1.5, ((W - PAD.l - PAD.r) / (n - 1)) * 0.8);
  const ticks = [rawMin, rawMin + span / 2, rawMax];
  const dayTicks = series.map((s, i) => ({ s, i })).filter(({ s }) => s.step_h % 24 === 0);
  const peak = values.reduce<number>((b, v, i) => ((v ?? -1e9) > (values[b] ?? -1e9) ? i : b), 0);
  const fmt = (v: number) => (Math.abs(v) < 10 && v % 1 ? v.toFixed(1) : String(Math.round(v)));
  const [hov, setHov] = useState<number | null>(null);
  const idxAt = (e: React.PointerEvent<SVGSVGElement> | React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const frac = ((e.clientX - r.left) / r.width) * W;
    return Math.min(n - 1, Math.max(0, Math.round(((frac - PAD.l) / (W - PAD.l - PAD.r)) * (n - 1))));
  };
  const hv = hov != null ? values[hov] : null;
  return (
    <figure className="chart">
      <figcaption>{title}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img"
        aria-label={`${title}. Highest ${values[peak]?.toFixed(1)} ${unit} at ${formatTime(series[peak].valid_time_utc, zone)}. Full numbers are in the data table below.`}
        onPointerMove={(e) => setHov(idxAt(e))} onPointerLeave={() => setHov(null)}
        onClick={(e) => onIndex(idxAt(e))}>
        {ticks.map((tk, i) => (
          <g key={i}><line x1={PAD.l} x2={W - PAD.r} y1={y(tk)} y2={y(tk)} className="grid" />
            <text x={PAD.l - 5} y={y(tk) + 3} textAnchor="end" className="axis">{fmt(tk)}</text></g>
        ))}
        {dayTicks.map(({ s, i }) => (
          <text key={s.step_h} x={x(i)} y={H - 6} textAnchor="middle" className="axis">+{s.step_h / 24}d</text>
        ))}
        {kind === "bar"
          ? values.map((v, i) => v != null && v > 0 && <rect key={i} x={x(i) - bw / 2} y={y(v)} width={bw} height={y(0) - y(v)} className="bar" />)
          : <polyline className="line" fill="none" style={color ? { stroke: color } : undefined} points={values.map((v, i) => `${x(i)},${y(v ?? 0)}`).join(" ")} />}
        {nowFrac != null && <g><line x1={x(nowFrac)} x2={x(nowFrac)} y1={PAD.t} y2={H - PAD.b} className="nowline" /><text x={x(nowFrac) + 3} y={PAD.t + 8} className="axis nowtext">now</text></g>}
        <line x1={x(index)} x2={x(index)} y1={PAD.t} y2={H - PAD.b} className="cursor" />
        {hov != null && (
          <g pointerEvents="none">
            <line x1={x(hov)} x2={x(hov)} y1={PAD.t} y2={H - PAD.b} className="hoverline" />
            {hv != null && <circle cx={x(hov)} cy={y(hv)} r={3.5} className="hoverdot" />}
            <text x={x(hov) > W / 2 ? x(hov) - 6 : x(hov) + 6} y={PAD.t + 20} textAnchor={x(hov) > W / 2 ? "end" : "start"} className="tip">
              {formatTime(series[hov].valid_time_utc, zone)} · {hv == null ? "–" : `${fmt(hv)} ${unit}`}
            </text>
          </g>
        )}
        <text x={8} y={PAD.t + 4} className="axis unit" transform={`rotate(-90 8 ${H / 2})`} textAnchor="middle">{unit}</text>
      </svg>
    </figure>
  );
}

export default function LocationPanel({ meta, point, loading, error, index, zone, onIndex, nowFrac, prev, prob, probMeta, selectedWindowEnd, threshold, nowMs, onBack, onPickPreset }: Props) {
  if (error) return <section className="panel" aria-live="polite"><h2>Your place</h2><p className="error" role="alert">{error}</p></section>;
  if (loading && !point) return <section className="panel" aria-busy="true"><h2>Your place</h2><p className="skeleton">Loading the forecast for this place…</p></section>;
  if (!point) return (
    <section className="panel empty">
      <h2>Pick a place to see its forecast</h2>
      <p>Tap anywhere on the map, search a city, or try one of these:</p>
      <div className="presets">
        {[["Mumbai", 19.08, 72.88], ["Delhi", 28.61, 77.21], ["Chennai", 13.08, 80.27], ["Kolkata", 22.57, 88.36]].map(([n, la, lo]) => (
          <button type="button" key={n as string} onClick={() => onPickPreset(la as number, lo as number)}>{n as string}</button>
        ))}
      </div>
    </section>
  );
  const s = point.series;
  const story = buildStory(s);
  const facts = buildFacts(s);
  const hasInstant = s[0].temp_c != null;
  const cmp = prev ? compareRuns(point, prev.point) : null;
  const head = placeHeadline(s, nowMs);
  const city = nearCity(point.grid_point.lat, point.grid_point.lon, 0.5);
  const placeName = city ? `${city.name} area` : `${point.grid_point.lat.toFixed(2)}°N, ${point.grid_point.lon.toFixed(2)}°E`;
  const blocks = dailyBlocks(s);
  const download = () => {
    const blob = new Blob([toCsv(point, meta, new Date().toISOString())], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = csvFilename(point);
    document.body.appendChild(a); a.click(); a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const t = (i: number) => formatTime(s[i].valid_time_utc, zone);
  const t0 = (iso: string) => formatTime(iso, zone);
  return (
    <section className="panel" aria-live="polite" aria-busy={loading}>
      <div className="place-head">
        <h2>{placeName}</h2>
        <button type="button" className="link backtomap" onClick={onBack}>↑ Back to the map</button>
      </div>
      {head && (
        <div className="tiles" role="group" aria-label={`Next ${head.hours} hours at this place`}>
          <div className="tile rain"><span className="tile-k">Rain, next {head.hours} h</span>
            <span className="tile-v">{head.rainMm < 0.05 ? "<0.1" : head.rainMm.toFixed(1)}<small> mm</small></span></div>
          {head.tMin != null && head.tMax != null && (
            <div className="tile temp"><span className="tile-k">Temperature</span>
              <span className="tile-v">{head.tMin.toFixed(0)}–{head.tMax.toFixed(0)}<small> °C</small></span></div>
          )}
          {head.windMax != null && (
            <div className="tile wind"><span className="tile-k">Strongest wind</span>
              <span className="tile-v">{head.windMax.toFixed(1)}<small> m/s</small></span></div>
          )}
        </div>
      )}
      {head && <p className="muted small">{formatTime(s[head.startIdx].valid_time_utc, zone)} → {formatTime(s[head.endIdx].valid_time_utc, zone)} · model forecast for the nearest 0.25° cell ({point.grid_point.lat.toFixed(2)}°N, {point.grid_point.lon.toFixed(2)}°E), not an observation.</p>}
      <Chart title="Precipitation in each interval (mm per interval)" unit="mm" series={s} values={s.map((p) => p.interval_mm)} kind="bar" index={index} onIndex={onIndex} zone={zone} nowFrac={nowFrac} />
      <Chart title="Cumulative precipitation since issue time (mm)" unit="mm" series={s} values={s.map((p) => p.cumulative_mm)} kind="line" index={index} onIndex={onIndex} zone={zone} nowFrac={nowFrac} />

      <details className="blocks" open>
        <summary>24-hour summary</summary>
        <div className="table-wrap">
          <table>
            <caption>Blocks of 24 h counted from the run's issue time, in {zone === "utc" ? "UTC" : "your local time"} (they start at model steps so rain totals are exact; calendar days do not line up with 3-hourly steps)</caption>
            <thead><tr><th scope="col">Period</th><th scope="col">Rain (mm)</th>
              {hasInstant && <><th scope="col">Temp min–max (°C)</th><th scope="col">Max wind (m/s)</th><th scope="col">Cloud avg (%)</th></>}</tr></thead>
            <tbody>
              {blocks.map((b) => (
                <tr key={b.startIdx} aria-current={index > b.startIdx && index <= b.endIdx}>
                  <th scope="row" title={`${t(b.startIdx)} → ${t(b.endIdx)}`}>{formatShort(s[b.startIdx].valid_time_utc, zone)} → {formatShort(s[b.endIdx].valid_time_utc, zone)}{b.hours < 24 ? ` (${b.hours} h)` : ""}</th>
                  <td>{b.precipMm < 0.05 ? "<0.1" : b.precipMm.toFixed(1)}</td>
                  {hasInstant && <><td>{b.tMin?.toFixed(1)} – {b.tMax?.toFixed(1)}</td><td>{b.windMax?.toFixed(1)}</td><td>{b.cloudMean != null ? Math.round(b.cloudMean) : ""}</td></>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      {prob && probMeta && (
        <details className="probtable">
          <summary>Chance of rain at this cell <span className="tag">ECMWF ensemble probability</span></summary>
          <div className="table-wrap">
            <table>
              <caption>Chance (%) that rain over each 24 h window reaches the amount in the column header. Times are in {zone === "utc" ? "UTC" : "your local time zone"}. Ensemble run issued {formatTime(prob.issue_time_utc, zone)}. Windows overlap: a new one starts every 12 h.</caption>
              <thead><tr><th scope="col">24 h window</th>{prob.thresholds_mm.map((t) => <th scope="col" key={t} className={t === threshold ? "sel" : ""}>≥ {t} mm</th>)}</tr></thead>
              <tbody>
                {prob.windows.map((w) => (
                  <tr key={w.end_h} aria-current={w.end_h === selectedWindowEnd}>
                    <th scope="row" title={`${formatTime(w.start_utc, zone)} → ${formatTime(w.end_utc, zone)}`}>24 h to {formatShort(w.end_utc, zone)}</th>
                    {w.probability_pct.map((pct, i) => {
                      const [r, g, b, a] = colorAt(getScale("prob", "interval", "radar"), pct);
                      return (
                        <td key={i} className={`pcell ${prob.thresholds_mm[i] === threshold ? "sel" : ""}`}
                          style={{ background: `rgba(${r},${g},${b},${a / 255})`, color: textOn(pct) === "light" ? "#fff" : undefined }}>
                          {pct}%
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small">{probMeta.semantics} It comes from ECMWF's ensemble system, which is published only for 00 and 12 UTC runs, so it can be older than the deterministic run above. A high chance of a small amount does not mean a large amount is likely.</p>
        </details>
      )}

      {prev && cmp && (
        <div className="compare">
          <h3>Compared with the previous run <span className="tag">forecast change, not a probability</span></h3>
          <p>
            For the shared period {t0(cmp.startIso)} → {t0(cmp.endIso)}: the previous run (issued {formatTime(prev.issueIso, zone)}) forecast{" "}
            <strong>{cmp.prevMm.toFixed(1)} mm</strong>; this run forecasts <strong>{cmp.curMm.toFixed(1)} mm</strong>
            {" "}({cmp.curMm - cmp.prevMm >= 0 ? "+" : "−"}{Math.abs(cmp.curMm - cmp.prevMm).toFixed(1)} mm).
            Largest interval: {cmp.prevMax.mm.toFixed(1)} mm before, {cmp.curMax.mm.toFixed(1)} mm now.
          </p>
          <p className="muted small">Differences between runs show how sensitive the forecast is to its starting data. They are not probabilities or an error estimate, and small changes at amounts under ~0.5 mm are within data precision.</p>
        </div>
      )}

      {hasInstant && (
        <details className="more-vars">
          <summary>Temperature, cloud and wind at this cell</summary>
          <Chart title="2 m temperature (°C, value at each time)" unit="°C" series={s} values={s.map((p) => p.temp_c ?? null)} kind="line" index={index} onIndex={onIndex} zone={zone} nowFrac={nowFrac} color="#d9480f" autoRange />
          <Chart title="Total cloud cover (%, value at each time)" unit="%" series={s} values={s.map((p) => p.cloud_pct ?? null)} kind="line" index={index} onIndex={onIndex} zone={zone} nowFrac={nowFrac} color="#5b6472" fixedMax={100} />
          <Chart title="10 m wind speed (m/s, value at each time)" unit="m/s" series={s} values={s.map((p) => p.wind_speed_ms ?? null)} kind="line" index={index} onIndex={onIndex} zone={zone} nowFrac={nowFrac} color="#0b7285" />
          <p className="muted small">These are instantaneous model values at each valid time, not accumulations or daily means.</p>
        </details>
      )}

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
        {facts.tMin && facts.tMax && (
          <ul>
            <li>2 m temperature ranges from <strong>{facts.tMin.v.toFixed(1)} °C</strong> ({t(facts.tMin.idx)}) to <strong>{facts.tMax.v.toFixed(1)} °C</strong> ({t(facts.tMax.idx)}).</li>
            {facts.windMax && <li>Strongest 10 m wind: <strong>{facts.windMax.v.toFixed(1)} m/s</strong> from the {compass(facts.windMax.from)} ({facts.windMax.from}°), {t(facts.windMax.idx)}.</li>}
            {facts.cloudMean != null && <li>Average total cloud cover over the period: <strong>{Math.round(facts.cloudMean)} %</strong>.</li>}
          </ul>
        )}
        <p className="muted small">One deterministic model run for a 0.25° cell (~28 km). It is not an observation, probability, warning or advice.</p>
      </div>

      <p className="dl"><button type="button" onClick={download}>⬇ Download this series (CSV)</button></p>
      <details>
        <summary>Show data table</summary>
        <div className="table-wrap">
          <table>
            <caption>Run {meta.run_id} at grid cell {point.grid_point.lat}°N, {point.grid_point.lon}°E (precipitation in mm of water)</caption>
            <thead><tr><th scope="col">Valid time</th><th scope="col">Interval (mm)</th><th scope="col">Cumulative (mm)</th>
              {hasInstant && <><th scope="col">Temp (°C)</th><th scope="col">Cloud (%)</th><th scope="col">Wind (m/s, from)</th></>}</tr></thead>
            <tbody>
              {s.map((p, i) => (
                <tr key={p.step_h} aria-current={i === index}>
                  <th scope="row">+{p.step_h} h · {t(i)}</th>
                  <td>{p.interval_mm == null ? "–" : `${p.interval_mm.toFixed(2)} (${p.interval_hours} h)`}</td>
                  <td>{p.cumulative_mm.toFixed(2)}</td>
                  {hasInstant && <><td>{p.temp_c?.toFixed(1)}</td><td>{p.cloud_pct}</td><td>{p.wind_speed_ms?.toFixed(1)} {p.wind_from_deg != null && compass(p.wind_from_deg)}</td></>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
