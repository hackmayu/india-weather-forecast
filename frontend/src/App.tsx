import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, fetchMap, fetchPoint, fetchRun, fetchStatus, type Status, type Kind, type MapResp, type PointResp, type RunMeta } from "./api";
import { THRESHOLDS } from "./colors";
import Legend from "./Legend";
import LocationPanel from "./LocationPanel";
import MapView from "./MapView";
import Timeline from "./Timeline";
import { formatTime, zoneName, type Zone } from "./time";

const PRESETS = [
  { name: "Mumbai", lat: 19.08, lon: 72.88 }, { name: "Delhi", lat: 28.61, lon: 77.21 },
  { name: "Kolkata", lat: 22.57, lon: 88.36 }, { name: "Chennai", lat: 13.08, lon: 80.27 },
  { name: "Bengaluru", lat: 12.97, lon: 77.59 }, { name: "Guwahati", lat: 26.14, lon: 91.74 },
];
const PLAY_MS = 900;

export default function App() {
  const [meta, setMeta] = useState<RunMeta | null>(null);
  const [metaErr, setMetaErr] = useState<string | null>(null);
  const [index, setIndex] = useState(8);
  const [kind, setKind] = useState<Kind>("interval");
  const [zone, setZone] = useState<Zone>("local");
  const [playing, setPlaying] = useState(false);

  const [mapData, setMapData] = useState<MapResp | null>(null);
  const [mapLoading, setMapLoading] = useState(false);
  const [mapErr, setMapErr] = useState<string | null>(null);
  const cache = useRef(new Map<string, MapResp>());

  const [point, setPoint] = useState<PointResp | null>(null);
  const [pointLoading, setPointLoading] = useState(false);
  const [pointErr, setPointErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [hover, setHover] = useState<{ lat: number; lon: number; value: number } | null>(null);
  const [latIn, setLatIn] = useState("");
  const [lonIn, setLonIn] = useState("");

  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => {
    // Poll the backend's refresh state. We never swap the forecast under the user: a newer run is
    // announced and loaded only on request.
    const tick = () => fetchStatus().then(setStatus).catch(() => undefined);
    tick();
    const id = window.setInterval(tick, 45_000);
    return () => window.clearInterval(id);
  }, []);

  const loadMeta = useCallback(() => {
    setMetaErr(null);
    cache.current.clear();
    fetchRun().then(setMeta).catch((e: ApiError) => setMetaErr(e.status === 503
      ? "No forecast has been processed yet. Run the data pipeline first." : e.message));
  }, []);
  useEffect(loadMeta, [loadMeta]);

  // Map data for the selected time/kind (cached; stale responses are ignored).
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!meta) return;
    const step = meta.steps_h[index];
    const key = `${meta.run_id}|${step}|${kind}`;
    const hit = cache.current.get(key);
    if (hit) { setMapData(hit); setMapErr(null); return; }
    let live = true;
    setMapLoading(true); setMapErr(null);
    fetchMap(meta.run_id, step, kind)
      .then((d) => { cache.current.set(key, d); if (live) setMapData(d); })
      .catch((e: Error) => { if (live) setMapErr(e.message); })
      .finally(() => { if (live) setMapLoading(false); });
    return () => { live = false; };
  }, [meta, index, kind, retry]);

  // Prefetch the next step so playback is smooth.
  useEffect(() => {
    if (!meta || index + 1 >= meta.steps_h.length) return;
    const step = meta.steps_h[index + 1];
    const key = `${meta.run_id}|${step}|${kind}`;
    if (!cache.current.has(key)) fetchMap(meta.run_id, step, kind).then((d) => cache.current.set(key, d)).catch(() => undefined);
  }, [meta, index, kind]);

  useEffect(() => {
    if (!playing || !meta) return;
    const id = window.setInterval(() => {
      setIndex((i) => {
        const min = kind === "interval" ? 1 : 0;
        return i + 1 >= meta.steps_h.length ? min : i + 1;
      });
    }, PLAY_MS);
    return () => window.clearInterval(id);
  }, [playing, meta, kind]);

  const choosePoint = useCallback((lat: number, lon: number) => {
    if (!meta) return;
    setNotice(null); setPointErr(null); setPointLoading(true);
    fetchPoint(meta.run_id, Number(lat.toFixed(4)), Number(lon.toFixed(4)))
      .then((p) => { setPoint(p); setLatIn(p.requested.lat.toFixed(2)); setLonIn(p.requested.lon.toFixed(2)); })
      .catch((e: Error) => { setPointErr(e.message); setPoint(null); })
      .finally(() => setPointLoading(false));
  }, [meta]);

  const outside = useCallback(() => {
    if (!meta) return;
    const d = meta.domain;
    setNotice(`That location is outside the forecast area (${d.lat_min}–${d.lat_max}°N, ${d.lon_min}–${d.lon_max}°E, shown dashed). No data is available there.`);
  }, [meta]);

  const changeKind = (k: Kind) => { setKind(k); if (k === "interval" && index === 0) setIndex(1); };

  if (metaErr) return (
    <main className="center"><h1>India Rain Forecast Explorer</h1>
      <p className="error" role="alert">{metaErr}</p><button type="button" onClick={loadMeta}>Try again</button></main>
  );
  if (!meta) return <main className="center" aria-busy="true"><h1>India Rain Forecast Explorer</h1><p>Loading forecast…</p></main>;

  const thresholds = THRESHOLDS[kind];
  const step = meta.steps_h[index];
  const durH = index > 0 ? meta.interval_durations_h[index - 1] : 0;
  const validIso = meta.valid_times_utc[index];
  const startIso = index > 0 ? meta.valid_times_utc[index - 1] : meta.valid_times_utc[0];
  const marker = point ? point.grid_point : null;

  return (
    <div className="app">
      <header>
        <div>
          <h1>India Rain Forecast Explorer</h1>
          <p className="muted">ECMWF IFS HRES (0.25°) deterministic forecast of total precipitation</p>
        </div>
        <dl className="facts">
          <div><dt>Model run issued</dt><dd>{formatTime(meta.issue_time_utc, zone)}</dd></div>
          <div><dt>Data age</dt><dd className={meta.freshness.stale ? "stale" : "fresh"}>{meta.freshness.age_hours} h{meta.freshness.stale ? " · STALE" : ""}</dd></div>
          <div><dt>Times shown in</dt><dd>
            <button type="button" className="link" onClick={() => setZone(zone === "local" ? "utc" : "local")} aria-label={`Showing ${zoneName(zone)}. Switch to ${zone === "local" ? "UTC" : "local time"}`}>
              {zoneName(zone)} ⇄
            </button></dd></div>
        </dl>
      </header>

      {meta.freshness.stale && (
        <p className="banner" role="status">
          This forecast was issued {meta.freshness.age_hours} h ago and newer runs have probably been published. Treat it as out of date.
        </p>
      )}

      {status?.latest_run && status.latest_run !== meta.run_id && (
        <p className="banner info" role="status">
          A newer forecast run ({status.latest_run} UTC) is available.{" "}
          <button type="button" onClick={() => { setPoint(null); loadMeta(); }}>Load it</button>
        </p>
      )}
      {status?.refreshing && (
        <p className="banner info" role="status">Checking ECMWF for a newer forecast run… the data shown stays as is until you load it.</p>
      )}
      {status?.last_result === "failed" && meta.freshness.stale && (
        <p className="banner" role="status">The last attempt to fetch a newer forecast failed, so this older run is still shown.</p>
      )}

      <main>
        <div className="left">
          <div className="kindbar" role="radiogroup" aria-label="What to map">
            {(["interval", "cumulative"] as Kind[]).map((k) => (
              <label key={k} className={kind === k ? "on" : ""}>
                <input type="radio" name="kind" checked={kind === k} onChange={() => changeKind(k)} />
                {k === "interval" ? "Interval total" : "Cumulative total"}
              </label>
            ))}
          </div>
          <p className="readout" aria-live="polite">
            <strong>Valid {formatTime(validIso, zone)}</strong> (+{step} h).{" "}
            {kind === "interval"
              ? <>Rain accumulated in the <strong>{durH} h</strong> from {formatTime(startIso, zone, false)} to {formatTime(validIso, zone, false)}.</>
              : <>Rain accumulated since the run was issued ({formatTime(meta.issue_time_utc, zone)}), a <strong>{step} h</strong> total.</>}
          </p>
          <div className="mapwrap">
            <MapView meta={meta} data={mapData} thresholds={thresholds} marker={marker} onPick={choosePoint} onOutside={outside} onHover={setHover} />
            {mapLoading && <div className="overlay" role="status">Loading map…</div>}
            {mapErr && <div className="overlay err" role="alert">{mapErr} <button type="button" onClick={() => setRetry((r) => r + 1)}>Retry</button></div>}
            {hover && <div className="hover" aria-hidden="true">{hover.lat.toFixed(2)}°N {hover.lon.toFixed(2)}°E · {hover.value.toFixed(1)} mm</div>}
          </div>
          <Legend kind={kind} thresholds={thresholds} hours={durH || 3} />
          <Timeline meta={meta} index={index} kind={kind} zone={zone} playing={playing} onIndex={setIndex} onPlaying={setPlaying} />
        </div>

        <aside className="right">
          <form className="locform" onSubmit={(e) => { e.preventDefault(); const la = Number(latIn), lo = Number(lonIn); if (latIn.trim() === "" || lonIn.trim() === "" || !isFinite(la) || !isFinite(lo)) { setNotice("Enter numeric latitude and longitude."); return; } choosePoint(la, lo); }}>
            <fieldset>
              <legend>Choose a location</legend>
              <div className="presets">
                {PRESETS.map((p) => <button type="button" key={p.name} onClick={() => choosePoint(p.lat, p.lon)}>{p.name}</button>)}
              </div>
              <div className="coords">
                <label>Latitude °N<input inputMode="decimal" value={latIn} onChange={(e) => setLatIn(e.target.value)} placeholder="e.g. 19.08" /></label>
                <label>Longitude °E<input inputMode="decimal" value={lonIn} onChange={(e) => setLonIn(e.target.value)} placeholder="e.g. 72.88" /></label>
                <button type="submit">Show</button>
              </div>
            </fieldset>
            {notice && <p className="error" role="alert">{notice}</p>}
          </form>
          <LocationPanel meta={meta} point={point} loading={pointLoading} error={pointErr} index={index} zone={zone} onIndex={setIndex} />
        </aside>
      </main>

      <footer>
        <p><strong>Source:</strong> Contains modified ECMWF Open Data (IFS HRES, 0.25°), licensed CC-BY-4.0. Run {meta.run_id} UTC, processed {formatTime(meta.processed_at_utc, zone)}.</p>
        <details>
          <summary>What this forecast can and cannot tell you</summary>
          <ul>
            <li>It is a <strong>single deterministic model run</strong>: no probabilities or uncertainty ranges are shown, and it can differ from later runs.</li>
            <li>Values are grid-cell averages at 0.25° (~28 km). A selected place gets the <strong>nearest cell</strong>, not an interpolated or point value.</li>
            <li>Interval totals are differences of the model's cumulative precipitation. Values are stored with limited precision, so amounts below about 0.25 mm are indistinguishable from zero and cumulative values may dip very slightly between steps.</li>
            <li>This is not observed rain, an official warning, or travel/safety advice. Use your national weather service for warnings.</li>
          </ul>
        </details>
      </footer>
    </div>
  );
}
