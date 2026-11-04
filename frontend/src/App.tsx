import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, fetchMap, fetchPoint, fetchRun, fetchRuns, fetchStatus, type Kind, type MapResp, type PointResp, type RunMeta, type Status, type VariableId } from "./api";
import { getScale, type Palette } from "./colors";
import Legend from "./Legend";
import LocationPanel from "./LocationPanel";
import MapView, { type Basemap, type Hover } from "./MapView";
import Timeline from "./Timeline";
import { formatTime, fracIndex, indexForNow, nearestIndex, nextRun, relTime, zoneName, type Zone } from "./time";

const PRESETS = [
  { name: "Mumbai", lat: 19.08, lon: 72.88 }, { name: "Delhi", lat: 28.61, lon: 77.21 },
  { name: "Kolkata", lat: 22.57, lon: 88.36 }, { name: "Chennai", lat: 13.08, lon: 80.27 },
  { name: "Bengaluru", lat: 12.97, lon: 77.59 }, { name: "Guwahati", lat: 26.14, lon: 91.74 },
];
const VARIABLES: { id: VariableId; label: string; blurb: string }[] = [
  { id: "precip", label: "Rain", blurb: "precipitation" },
  { id: "temp", label: "Temperature", blurb: "2 m air temperature" },
  { id: "cloud", label: "Cloud", blurb: "total cloud cover" },
  { id: "wind", label: "Wind", blurb: "10 m wind (speed colours, arrows show where the air moves toward)" },
];
const PLAY_MS = 900;
const HOUR = 3_600_000;
const STALE_H = 18; // a run older than this has missed at least two newer issue times
type Theme = "auto" | "light" | "dark";
const lsGet = (k: string, d: string) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

export default function App() {
  const [meta, setMeta] = useState<RunMeta | null>(null);
  const [metaErr, setMetaErr] = useState<string | null>(null);
  const [index, setIndex] = useState(8);
  const [variable, setVariable] = useState<VariableId>("precip");
  const [kind, setKind] = useState<Kind>("interval");
  const [zone, setZone] = useState<Zone>("local");
  const [playing, setPlaying] = useState(false);
  const [palette, setPalette] = useState<Palette>(lsGet("palette", "radar") as Palette);
  const [smooth, setSmooth] = useState(lsGet("smooth", "1") === "1");
  const [basemap, setBasemap] = useState<Basemap>(lsGet("basemap", "light") as Basemap);
  const [basemapFailed, setBasemapFailed] = useState(false);
  const [autoUpdate, setAutoUpdate] = useState(lsGet("autoupdate", "1") === "1");
  const [theme, setTheme] = useState<Theme>(lsGet("theme", "auto") as Theme);
  const [sysDark, setSysDark] = useState(() => typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches);

  const [mapData, setMapData] = useState<MapResp | null>(null);
  const [mapLoading, setMapLoading] = useState(false);
  const [mapErr, setMapErr] = useState<string | null>(null);
  const cache = useRef(new Map<string, MapResp>());

  const [point, setPoint] = useState<PointResp | null>(null);
  const [loc, setLoc] = useState<{ lat: number; lon: number } | null>(null);
  const [prev, setPrev] = useState<{ point: PointResp; issueIso: string } | null>(null);
  const [pointLoading, setPointLoading] = useState(false);
  const [pointErr, setPointErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [switched, setSwitched] = useState<string | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [latIn, setLatIn] = useState("");
  const [lonIn, setLonIn] = useState("");
  const [status, setStatus] = useState<Status | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const selValid = useRef<number | null>(null); // valid time currently shown, kept when switching runs
  const firstLoad = useRef(true);

  useEffect(() => { lsSet("palette", palette); }, [palette]);
  useEffect(() => { lsSet("smooth", smooth ? "1" : "0"); }, [smooth]);
  useEffect(() => { lsSet("basemap", basemap); }, [basemap]);
  useEffect(() => { lsSet("autoupdate", autoUpdate ? "1" : "0"); }, [autoUpdate]);
  useEffect(() => { document.documentElement.dataset.theme = theme; lsSet("theme", theme); }, [theme]);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const f = () => setSysDark(mq.matches);
    mq.addEventListener("change", f);
    return () => mq.removeEventListener("change", f);
  }, []);
  const dark = theme === "dark" || (theme === "auto" && sysDark);

  // Wall clock, used only to place "now" on the forecast timeline and to tick data age.
  useEffect(() => { const id = window.setInterval(() => setNowMs(Date.now()), 30_000); return () => window.clearInterval(id); }, []);

  useEffect(() => {
    // Poll the backend: its refresher checks ECMWF every 10 min; we ask it what it has every 45 s.
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

  const minIndex = variable === "precip" && kind === "interval" ? 1 : 0;
  useEffect(() => { if (index < minIndex) setIndex(minIndex); }, [index, minIndex]);

  // First load: open at the step that contains "now". Later run switches keep the same valid time.
  useEffect(() => {
    if (!meta) return;
    if (firstLoad.current) {
      firstLoad.current = false;
      const n = indexForNow(meta.valid_times_utc, Date.now(), true);
      if (n.state === "within") setIndex(n.index);
    } else if (selValid.current != null) {
      setIndex(nearestIndex(meta.valid_times_utc, selValid.current));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta?.run_id]);
  useEffect(() => { if (meta) selValid.current = Date.parse(meta.valid_times_utc[Math.min(index, meta.valid_times_utc.length - 1)]); }, [meta, index]);

  // Auto-update: when the backend has a newer run, switch to it, keeping the time and place.
  useEffect(() => {
    if (!autoUpdate || !meta || !status?.latest_run || status.latest_run === meta.run_id) return;
    setSwitched(`Updated to the newer model run ${status.latest_run} UTC (was ${meta.run_id}). Your time and place were kept.`);
    loadMeta();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoUpdate, status?.latest_run, meta?.run_id]);
  useEffect(() => {
    if (!switched) return;
    const id = window.setTimeout(() => setSwitched(null), 25_000);
    return () => window.clearTimeout(id);
  }, [switched]);

  // Map data for the selected time/variable (cached; stale responses are ignored).
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!meta || index < minIndex || index >= meta.steps_h.length) return;
    const step = meta.steps_h[index];
    const key = `${meta.run_id}|${step}|${variable}|${kind}`;
    const hit = cache.current.get(key);
    if (hit) { setMapData(hit); setMapErr(null); return; }
    let live = true;
    setMapLoading(true); setMapErr(null);
    fetchMap(meta.run_id, step, variable, kind)
      .then((d) => { cache.current.set(key, d); if (live) setMapData(d); })
      .catch((e: Error) => { if (live) setMapErr(e.message); })
      .finally(() => { if (live) setMapLoading(false); });
    return () => { live = false; };
  }, [meta, index, variable, kind, retry, minIndex]);

  // Prefetch the next step so playback is smooth.
  useEffect(() => {
    if (!meta || index + 1 >= meta.steps_h.length) return;
    const step = meta.steps_h[index + 1];
    const key = `${meta.run_id}|${step}|${variable}|${kind}`;
    if (!cache.current.has(key)) fetchMap(meta.run_id, step, variable, kind).then((d) => cache.current.set(key, d)).catch(() => undefined);
  }, [meta, index, variable, kind]);

  useEffect(() => {
    if (!playing || !meta) return;
    const id = window.setInterval(() => {
      setIndex((i) => (i + 1 >= meta.steps_h.length ? minIndex : i + 1));
    }, PLAY_MS);
    return () => window.clearInterval(id);
  }, [playing, meta, minIndex]);

  const choosePoint = useCallback((lat: number, lon: number) => {
    if (!meta) return;
    setNotice(null); setPointErr(null); setPointLoading(true);
    const la = Number(lat.toFixed(4)), lo = Number(lon.toFixed(4));
    fetchPoint(meta.run_id, la, lo)
      .then((p) => { setPoint(p); setLoc({ lat: la, lon: lo }); setLatIn(p.requested.lat.toFixed(2)); setLonIn(p.requested.lon.toFixed(2)); })
      .catch((e: Error) => { setPointErr(e.message); setPoint(null); })
      .finally(() => setPointLoading(false));
  }, [meta]);

  // After a run switch, refresh the selected place from the new run.
  useEffect(() => {
    if (meta && loc && point && point.run_id !== meta.run_id) choosePoint(loc.lat, loc.lon);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta?.run_id]);

  // Same place in the previous run, for the run-to-run comparison.
  useEffect(() => {
    setPrev(null);
    if (!meta || !point || point.run_id !== meta.run_id) return;
    let live = true;
    fetchRuns().then(async ({ runs }) => {
      const older = runs.find((r) => r.issue_time_utc < meta.issue_time_utc);
      if (!older) return;
      const p = await fetchPoint(older.run_id, point.requested.lat, point.requested.lon);
      if (live) setPrev({ point: p, issueIso: older.issue_time_utc });
    }).catch(() => undefined);
    return () => { live = false; };
  }, [meta, point]);

  const outside = useCallback(() => {
    if (!meta) return;
    const d = meta.domain;
    setNotice(`That location is outside the forecast area (${d.lat_min}–${d.lat_max}°N, ${d.lon_min}–${d.lon_max}°E, shown dashed). No data is available there.`);
  }, [meta]);

  const onBasemapFailed = useCallback(() => setBasemapFailed(true), []);

  if (metaErr) return (
    <main className="center"><h1>India Weather Forecast Explorer</h1>
      <p className="error" role="alert">{metaErr}</p><button type="button" onClick={loadMeta}>Try again</button></main>
  );
  if (!meta) return <main className="center" aria-busy="true"><h1>India Weather Forecast Explorer</h1><p>Loading forecast…</p></main>;

  const scale = getScale(variable, kind, palette);
  const safeIndex = Math.min(index, meta.steps_h.length - 1);
  const step = meta.steps_h[safeIndex];
  const durH = safeIndex > 0 ? meta.interval_durations_h[safeIndex - 1] : 0;
  const validIso = meta.valid_times_utc[safeIndex];
  const startIso = safeIndex > 0 ? meta.valid_times_utc[safeIndex - 1] : meta.valid_times_utc[0];
  const marker = point ? point.grid_point : null;
  const vInfo = VARIABLES.find((v) => v.id === variable)!;
  const legendTitle = variable === "precip" && kind === "interval" ? `Precipitation in the ${durH || 3} h interval (mm of water)` : scale.title;
  const fmtHover = (v: number) => (variable === "cloud" ? Math.round(v) : v.toFixed(1)) + " " + (mapData?.units ?? "");

  // ---- real-time context (browser clock vs forecast timeline) ----
  const issueMs = Date.parse(meta.issue_time_utc);
  const ageMs = nowMs - issueMs;
  const stale = ageMs > STALE_H * HOUR;
  const nr = nextRun(issueMs, nowMs);
  const pubMs = meta.published_at_utc ? Date.parse(meta.published_at_utc) : null;
  const nowInfo = indexForNow(meta.valid_times_utc, nowMs, minIndex === 1);
  const nowFrac = fracIndex(meta.valid_times_utc, nowMs);
  const validMs = Date.parse(validIso), startMs = Date.parse(startIso);
  const isInterval = variable === "precip" && kind === "interval";
  let when: { label: string; cls: string; title: string };
  if (isInterval && nowMs >= startMs && nowMs < validMs) when = { label: "Includes now", cls: "now", title: "The current time falls inside this interval." };
  else if (!isInterval && variable !== "precip" && Math.abs(validMs - nowMs) <= 1.5 * HOUR) when = { label: "≈ Now", cls: "now", title: "This step is the nearest model time to the current time." };
  else if (validMs <= nowMs) when = { label: "Past model step", cls: "past", title: "The model's value for a time that has already passed. It is a forecast value, not an observation." };
  else when = { label: "Future", cls: "future", title: "Forecast for a time that has not happened yet." };
  const lastCheckMs = status?.last_attempt_utc ? Date.parse(status.last_attempt_utc) : null;
  const live = !!status?.auto_refresh;

  return (
    <div className="app">
      <a className="skip" href="#locations">Skip map, go to location chooser</a>
      <header>
        <div>
          <h1>India Weather Forecast Explorer</h1>
          <p className="muted">ECMWF IFS HRES (0.25°) deterministic forecast · rain, temperature, cloud and wind</p>
        </div>
        <div className="hdr-tools">
          <button type="button" className="link" onClick={() => setZone(zone === "local" ? "utc" : "local")} aria-label={`Times are shown in ${zoneName(zone)}. Switch to ${zone === "local" ? "UTC" : "local time"}`}>
            🕒 {zoneName(zone)} ⇄
          </button>
          <button type="button" className="link" onClick={() => setTheme(theme === "auto" ? "dark" : theme === "dark" ? "light" : "auto")} aria-label={`Theme: ${theme}. Click to change.`}>
            ◐ Theme: {theme}
          </button>
        </div>
      </header>

      <section className="livebar" aria-label="Forecast status">
        <span className={`pill ${status?.refreshing ? "busy" : live ? "live" : "idle"}`} title={live ? "This server checks ECMWF for new model runs every 10 minutes." : "This server is not checking for new runs automatically."}>
          <span className="dot" aria-hidden="true" />{status?.refreshing ? "Checking for a new run…" : live ? "Live updates on" : "Static data"}
        </span>
        <span className="chip"><b>Run issued</b> {formatTime(meta.issue_time_utc, zone)}</span>
        {pubMs && <span className="chip" title="Time the run became available on the ECMWF server (Last-Modified header)."><b>Published</b> {formatTime(meta.published_at_utc!, zone, false)}{meta.availability_delay_h != null && ` (+${meta.availability_delay_h.toFixed(1)} h)`}</span>}
        <span className={`chip ${stale ? "bad" : "good"}`}><b>Data age</b> {relTime(-ageMs).replace(" ago", "")}{stale ? " · STALE" : ""}</span>
        <span className="chip" title={`Typical delay after issue time, measured from the last 9 runs: about 7.6 h for 00/12 UTC runs and 6.5 h for 06/18 UTC runs. Not guaranteed.`}>
          <b>Next run</b> {nr.overdue ? `expected ${relTime(nr.expectedMs - nowMs)} — later than usual` : `≈ ${formatTime(new Date(nr.expectedMs).toISOString(), zone, false)} (${relTime(nr.expectedMs - nowMs)})`}
        </span>
        {lastCheckMs && <span className="chip"><b>Last check</b> {relTime(lastCheckMs - nowMs)}</span>}
        <label className="chip auto"><input type="checkbox" checked={autoUpdate} onChange={(e) => setAutoUpdate(e.target.checked)} /> Auto-switch to new runs</label>
      </section>

      {stale && (
        <p className="banner" role="status">
          This forecast was issued {relTime(-ageMs).replace(" ago", "")} ago and newer runs have probably been published. Treat it as out of date.
        </p>
      )}
      {switched && <p className="banner info" role="status">{switched} <button type="button" onClick={() => setSwitched(null)}>Dismiss</button></p>}
      {!autoUpdate && status?.latest_run && status.latest_run !== meta.run_id && (
        <p className="banner info" role="status">
          A newer forecast run ({status.latest_run} UTC) is available.{" "}
          <button type="button" onClick={loadMeta}>Load it</button>
        </p>
      )}
      {status?.last_result === "failed" && stale && (
        <p className="banner" role="status">The last attempt to fetch a newer forecast failed, so this older run is still shown.</p>
      )}
      {basemapFailed && <p className="banner" role="status">The hosted basemap could not be loaded, so a simple outline map is shown. Forecast data is unaffected.</p>}

      <main>
        <div className="left">
          <div className="controls">
            <div className="seg" role="radiogroup" aria-label="Weather variable">
              {VARIABLES.map((v) => (
                <label key={v.id} className={variable === v.id ? "on" : ""}>
                  <input type="radio" name="variable" checked={variable === v.id} onChange={() => setVariable(v.id)} />
                  {v.label}
                </label>
              ))}
            </div>
            {variable === "precip" && (
              <div className="seg small" role="radiogroup" aria-label="Precipitation total">
                {(["interval", "cumulative"] as Kind[]).map((k) => (
                  <label key={k} className={kind === k ? "on" : ""}>
                    <input type="radio" name="kind" checked={kind === k} onChange={() => setKind(k)} />
                    {k === "interval" ? "Interval total" : "Cumulative"}
                  </label>
                ))}
              </div>
            )}
          </div>
          <p className="readout" aria-live="polite">
            <span className={`when ${when.cls}`} title={when.title}>{when.label}</span>{" "}
            <strong>Valid {formatTime(validIso, zone)}</strong> (+{step} h).{" "}
            {variable === "precip"
              ? (kind === "interval"
                ? <>Rain accumulated in the <strong>{durH} h</strong> from {formatTime(startIso, zone, false)} to {formatTime(validIso, zone, false)}.</>
                : <>Rain accumulated since the run was issued ({formatTime(meta.issue_time_utc, zone)}), a <strong>{step} h</strong> total.</>)
              : <>Model {vInfo.blurb} <strong>at this instant</strong> (not an accumulation or an average).</>}
            {when.cls === "past" && <> <span className="muted">Model value for a time that has passed; not an observation.</span></>}
          </p>
          <div className="mapwrap">
            <MapView meta={meta} data={mapData} variable={variable} scale={scale} smooth={smooth} basemap={basemap} dark={dark} marker={marker}
              onPick={choosePoint} onOutside={outside} onHover={setHover} onBasemapFailed={onBasemapFailed} />
            {mapLoading && <div className="overlay" role="status">Loading map…</div>}
            {mapErr && <div className="overlay err" role="alert">{mapErr} <button type="button" onClick={() => setRetry((r) => r + 1)}>Retry</button></div>}
            {hover && <div className="hover" aria-hidden="true">{hover.lat.toFixed(2)}°N {hover.lon.toFixed(2)}°E · {fmtHover(hover.value)} (grid cell)</div>}
            <Legend scale={scale} title={legendTitle}
              note={smooth ? "Display smoothed between 0.25° cells; the data are not finer than that." : "Raw 0.25° grid cells."} />
          </div>
          <div className="options">
            <label><input type="checkbox" checked={smooth} onChange={(e) => setSmooth(e.target.checked)} /> Smooth display</label>
            <label>Basemap{" "}
              <select value={basemap} onChange={(e) => { setBasemap(e.target.value as Basemap); setBasemapFailed(false); }}>
                <option value="light">Light</option><option value="detailed">Detailed</option>
              </select></label>
            {variable === "precip" && (
              <label>Rain colours{" "}
                <select value={palette} onChange={(e) => setPalette(e.target.value as Palette)}>
                  <option value="radar">Radar</option><option value="accessible">Colour-blind friendly</option>
                </select></label>
            )}
          </div>
          <Timeline meta={meta} index={safeIndex} minIndex={minIndex} zone={zone} playing={playing} onIndex={setIndex} onPlaying={setPlaying}
            onNow={() => setIndex(nowInfo.index)} nowFrac={nowFrac} nowState={nowInfo.state} />
        </div>

        <aside className="right">
          <form className="locform" id="locations" tabIndex={-1} onSubmit={(e) => { e.preventDefault(); const la = Number(latIn), lo = Number(lonIn); if (latIn.trim() === "" || lonIn.trim() === "" || !isFinite(la) || !isFinite(lo)) { setNotice("Enter numeric latitude and longitude."); return; } choosePoint(la, lo); }}>
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
          <LocationPanel meta={meta} point={point} loading={pointLoading} error={pointErr} index={safeIndex} zone={zone} onIndex={setIndex} nowFrac={nowFrac} prev={prev} />
        </aside>
      </main>

      <footer>
        <p><strong>Forecast data:</strong> Contains modified ECMWF Open Data (IFS HRES, 0.25°), licensed CC-BY-4.0. Run {meta.run_id} UTC, processed {formatTime(meta.processed_at_utc, zone)}.
          {" "}<strong>Basemap:</strong> © OpenStreetMap contributors, OpenMapTiles, served by OpenFreeMap; boundaries are as drawn by OpenStreetMap contributors.</p>
        <details>
          <summary>What this forecast can and cannot tell you</summary>
          <ul>
            <li><strong>"Live" means the newest published model run, not a nowcast.</strong> ECMWF issues a run every 6 hours and it appears several hours later, so even the newest run starts in the past. Times before "now" are model values, not observations.</li>
            <li>It is a <strong>single deterministic model run</strong>: no probabilities or uncertainty ranges are shown, and it can differ from later runs. The run comparison shows how much it changed, not how likely anything is.</li>
            <li>Values are grid-cell values at 0.25° (~28 km). A selected place gets the <strong>nearest cell</strong>, not an interpolated or point value. The smooth map display is visual only.</li>
            <li>Rain totals are differences of the model's cumulative precipitation. Values are stored with limited precision, so amounts below about 0.25 mm are indistinguishable from zero and cumulative values may dip very slightly between steps.</li>
            <li>Temperature, cloud and wind are instantaneous values at the valid time. Wind is the 10 m wind; arrows show where the air moves toward. Cloud cover is stored coarsely (about 1 %).</li>
            <li>This is not observed weather, an official warning, or travel/safety advice. Use your national weather service for warnings.</li>
          </ul>
        </details>
      </footer>
    </div>
  );
}
