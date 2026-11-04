import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, fetchMap, fetchPoint, fetchProbMap, fetchProbMeta, fetchProbPoint, fetchRun, fetchRuns, fetchStatus, type Kind, type MapResp, type PointResp, type ProbMeta, type ProbPointResp, type RunMeta, type Status, type VariableId } from "./api";
import { getScale, type Palette } from "./colors";
import CityOverview from "./CityOverview";
import Overview from "./Overview";
import Legend from "./Legend";
import LocationPanel from "./LocationPanel";
import type { Basemap, Hover } from "./MapView";
const MapView = lazy(() => import("./MapView"));
import Timeline from "./Timeline";
import PlaceSearch from "./PlaceSearch";
import { nearestWindow } from "./prob";
import { rainPreset } from "./blocks";
import { dayShortcuts, formatTime, fracIndex, indexForNow, localDate, nearestIndex, nextRun, relTime, zoneName, type Zone } from "./time";
import { buildSearch, parseUrl } from "./urlState";

const PRESETS = [
  { name: "Mumbai", lat: 19.08, lon: 72.88 }, { name: "Delhi", lat: 28.61, lon: 77.21 },
  { name: "Kolkata", lat: 22.57, lon: 88.36 }, { name: "Chennai", lat: 13.08, lon: 80.27 },
  { name: "Bengaluru", lat: 12.97, lon: 77.59 }, { name: "Guwahati", lat: 26.14, lon: 91.74 },
];
const VARIABLES: { id: VariableId; label: string; icon: string; blurb: string }[] = [
  { id: "precip", label: "Rain", icon: "🌧", blurb: "precipitation" },
  { id: "temp", label: "Temperature", icon: "🌡", blurb: "2 m air temperature" },
  { id: "cloud", label: "Cloud", icon: "☁", blurb: "total cloud cover" },
  { id: "prob", label: "Rain chance", icon: "☂", blurb: "chance (ECMWF ensemble probability) that 24 h rain reaches the chosen amount" },
  { id: "wind", label: "Wind", icon: "💨", blurb: "10 m wind (speed colours, arrows show where the air moves toward)" },
];
const PLAY_MS = 900;
const WINDOW_OPTIONS = [6, 12, 24, 48, 72];
const PROB_THRESHOLDS = [1, 5, 10, 25, 50, 100]; // mm; the amounts ECMWF publishes probabilities for

/** First selectable step index: interval totals need a previous step; a window needs `hours` of run before it. */
function minIndexFor(steps: number[] | undefined, variable: VariableId, kind: Kind, hours: number): number {
  if (variable !== "precip") return 0;
  if (kind === "interval") return 1;
  if (kind === "window") {
    if (!steps) return 1;
    const i = steps.findIndex((s) => s >= hours);
    return i < 0 ? steps.length - 1 : Math.max(1, i);
  }
  return 0;
}
const HOUR = 3_600_000;
const STALE_H = 18; // a run older than this has missed at least two newer issue times
type Theme = "auto" | "light" | "dark";
const lsGet = (k: string, d: string) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

export default function App() {
  const [meta, setMeta] = useState<RunMeta | null>(null);
  const [metaErr, setMetaErr] = useState<string | null>(null);
  const [index, setIndex] = useState(8);
  const [urlInit] = useState(() => parseUrl(location.search)); // shared-link state, read once
  const [variable, setVariable] = useState<VariableId>(urlInit.v ?? "precip");
  const [kind, setKind] = useState<Kind>(urlInit.k ?? "interval");
  const [windowHours, setWindowHours] = useState<number>(urlInit.h ?? 24);
  const [threshold, setThreshold] = useState<number>(urlInit.p ?? 1);
  const [probMeta, setProbMeta] = useState<ProbMeta | null>(null);
  const [probErr, setProbErr] = useState<string | null>(null);
  const [probPoint, setProbPoint] = useState<ProbPointResp | null>(null);
  const [zone, setZone] = useState<Zone>(urlInit.z ?? "local");
  const [copied, setCopied] = useState(false);
  const [guide, setGuide] = useState(lsGet("guide", "") !== "seen" && new URLSearchParams(location.search).get("guide") !== "0"); // ?guide=0 hides it (for embedding/screenshots)
  const dismissGuide = () => { setGuide(false); lsSet("guide", "seen"); };
  const [playing, setPlaying] = useState(false);
  const [palette, setPalette] = useState<Palette>(lsGet("palette", "radar") as Palette);
  const [smooth, setSmooth] = useState(lsGet("smooth", "1") === "1");
  const [basemap, setBasemap] = useState<Basemap>(lsGet("basemap", "light") as Basemap);
  const [basemapFailed, setBasemapFailed] = useState(false);
  const [autoUpdate, setAutoUpdate] = useState(lsGet("autoupdate", "1") === "1");
  const [theme, setTheme] = useState<Theme>(lsGet("theme", "auto") as Theme);
  const [sysDark, setSysDark] = useState(() => typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches);

  const [mapView, setMapView] = useState<"india" | "world">("india");
  const [placeLabel, setPlaceLabel] = useState("");   // name chosen in the search box; cleared when a place is picked on the map or by coordinates
  const [mapData, setMapData] = useState<MapResp | null>(null);
  // Secondary panels (all-cities overview, previous-run comparison) download many data files; wait until the map is drawn and the page has been quiet for a moment.
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    if (!mapData || idle) return;
    const id = window.setTimeout(() => setIdle(true), 1500);
    return () => window.clearTimeout(id);
  }, [mapData, idle]);
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
    // Poll the backend: its refresher checks ECMWF every 10 min; we ask it what it has every 45 s,
    // or every 5 s while it reports that a check is running (so "Checking…" clears promptly).
    const tick = () => fetchStatus().then(setStatus).catch(() => undefined);
    tick();
    const id = window.setInterval(tick, status?.refreshing ? 5_000 : 45_000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.refreshing]);

  // ECMWF ENS probability run (a separate system: 00/12 UTC only). Its absence must never break the app.
  const probLatest = status?.probability?.latest_run ?? null;
  useEffect(() => {
    let live = true;
    fetchProbMeta()
      .then((m) => { if (live) { setProbMeta(m); setProbErr(null); } })
      .catch((e: Error) => { if (live) { setProbMeta(null); setProbErr(e.message); } });
    return () => { live = false; };
  }, [probLatest]);

  const loadMeta = useCallback(() => {
    setMetaErr(null);
    cache.current.clear();
    fetchRun().then(setMeta).catch((e: ApiError) => setMetaErr(e.status === 503
      ? "No forecast has been processed yet. Run the data pipeline first." : e.message));
  }, []);
  useEffect(loadMeta, [loadMeta]);

  const minIndex = minIndexFor(meta?.steps_h, variable, kind, windowHours);
  // A shared link or a shorter run (06/18 UTC) may not support the chosen window length: fall back to the longest that fits.
  useEffect(() => {
    if (!meta) return;
    const last = meta.steps_h[meta.steps_h.length - 1];
    if (windowHours > last) setWindowHours(Math.max(...WINDOW_OPTIONS.filter((h) => h <= last), 6));
  }, [meta, windowHours]);
  useEffect(() => { if (index < minIndex) setIndex(minIndex); }, [index, minIndex]);

  // First load: open at the step that contains "now". Later run switches keep the same valid time.
  useEffect(() => {
    if (!meta) return;
    if (firstLoad.current) {
      firstLoad.current = false;
      const tMs = urlInit.t ? Date.parse(urlInit.t) : NaN;
      const vt = meta.valid_times_utc.map((v) => Date.parse(v));
      if (!Number.isNaN(tMs) && tMs >= vt[0] && tMs <= vt[vt.length - 1]) {
        setIndex(nearestIndex(meta.valid_times_utc, tMs)); // a shared link keeps its time while inside this run
      } else {
        const n = indexForNow(meta.valid_times_utc, Date.now(), true);
        if (n.state === "within") setIndex(n.index);
      }
      if (urlInit.lat !== undefined && urlInit.lon !== undefined) choosePoint(urlInit.lat, urlInit.lon, false);
      else {
        // No place in the link: reopen the place used last time on this device (if any).
        try {
          const last = JSON.parse(lsGet("lastPlace", "null")) as { lat: number; lon: number } | null;
          if (last && Number.isFinite(last.lat) && Number.isFinite(last.lon)) choosePoint(last.lat, last.lon, false);
        } catch { /* ignore a corrupt value */ }
      }
    } else if (selValid.current != null) {
      setIndex(nearestIndex(meta.valid_times_utc, selValid.current));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta?.run_id]);
  useEffect(() => { if (meta) selValid.current = Date.parse(meta.valid_times_utc[Math.min(index, meta.valid_times_utc.length - 1)]); }, [meta, index]);

  // Keep the address bar in sync so the current view can be shared (replaceState: no history spam).
  useEffect(() => {
    if (!meta || firstLoad.current) return;
    const t = meta.valid_times_utc[Math.min(index, meta.valid_times_utc.length - 1)];
    const next = buildSearch(location.search, { v: variable, k: kind, h: windowHours, p: threshold, t, lat: loc?.lat, lon: loc?.lon, z: zone }) + location.hash;
    if (next !== location.search + location.hash) history.replaceState(null, "", location.pathname + next);
  }, [meta, index, variable, kind, windowHours, threshold, loc, zone]);

  // Keyboard shortcuts (only when focus is not on a control or the map): Space play/pause, arrows step, N = now.
  useEffect(() => {
    if (!meta) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (["INPUT", "SELECT", "TEXTAREA", "BUTTON", "A", "SUMMARY"].includes(el.tagName) || el.isContentEditable || el.closest?.(".map"))) return;
      const min = minIndexFor(meta.steps_h, variable, kind, windowHours);
      if (e.key === " ") { e.preventDefault(); setPlaying((p) => !p); }
      else if (e.key === "ArrowRight") setIndex((i) => Math.min(meta.steps_h.length - 1, i + 1));
      else if (e.key === "ArrowLeft") setIndex((i) => Math.max(min, i - 1));
      else if (e.key === "n" || e.key === "N") setIndex(Math.max(min, indexForNow(meta.valid_times_utc, Date.now(), variable === "precip" && kind === "interval").index));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [meta, variable, kind, windowHours]);

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
    if (variable === "prob") {
      if (!probMeta) { setMapData(null); setMapErr(probErr ?? "Loading probabilities…"); return; }
      const w = nearestWindow(probMeta.windows, Date.parse(meta.valid_times_utc[index])).window;
      const pkey = `prob|${probMeta.run_id}|${w.end_h}|${threshold}`;
      const phit = cache.current.get(pkey);
      if (phit) { setMapData(phit); setMapErr(null); return; }
      let alive = true;
      setMapLoading(true); setMapErr(null);
      fetchProbMap(probMeta.run_id, w.end_h, threshold)
        .then((d) => { const m = { ...d, step_h: w.end_h } as unknown as MapResp; cache.current.set(pkey, m); if (alive) setMapData(m); })
        .catch((e: Error) => { if (alive) setMapErr(e.message); })
        .finally(() => { if (alive) setMapLoading(false); });
      return () => { alive = false; };
    }
    const key = `${meta.run_id}|${step}|${variable}|${kind}|${kind === "window" ? windowHours : 0}`;
    const hit = cache.current.get(key);
    if (hit) { setMapData(hit); setMapErr(null); return; }
    let live = true;
    setMapLoading(true); setMapErr(null);
    fetchMap(meta.run_id, step, variable, kind, windowHours)
      .then((d) => { cache.current.set(key, d); if (live) setMapData(d); })
      .catch((e: Error) => { if (live) setMapErr(e.message); })
      .finally(() => { if (live) setMapLoading(false); });
    return () => { live = false; };
  }, [meta, index, variable, kind, windowHours, retry, minIndex, probMeta, probErr, threshold]);

  // Prefetch the next step so playback is smooth.
  useEffect(() => {
    if (!meta || variable === "prob" || index + 1 >= meta.steps_h.length) return;
    const step = meta.steps_h[index + 1];
    const key = `${meta.run_id}|${step}|${variable}|${kind}|${kind === "window" ? windowHours : 0}`;
    if (!cache.current.has(key)) fetchMap(meta.run_id, step, variable, kind, windowHours).then((d) => cache.current.set(key, d)).catch(() => undefined);
  }, [meta, index, variable, kind, windowHours]);

  useEffect(() => {
    if (!playing || !meta) return;
    const id = window.setInterval(() => {
      setIndex((i) => (i + 1 >= meta.steps_h.length ? minIndex : i + 1));
    }, PLAY_MS);
    return () => window.clearInterval(id);
  }, [playing, meta, minIndex]);

  const choosePoint = useCallback((lat: number, lon: number, scroll = true, label = "") => {
    if (!meta) return;
    setPlaceLabel(label);
    setNotice(null); setPointErr(null); setPointLoading(true);
    // On a phone the results sit below the map: bring them into view so the tap visibly does something.
    if (scroll && typeof matchMedia === "function" && matchMedia("(max-width: 860px)").matches) {
      const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
      window.setTimeout(() => document.getElementById("place-results")?.scrollIntoView({ behavior: calm ? "auto" : "smooth", block: "start" }), 120);
    }
    const la = Number(lat.toFixed(4)), lo = Number(lon.toFixed(4));
    fetchPoint(meta.run_id, la, lo)
      .then((p) => { setPoint(p); setLoc({ lat: la, lon: lo }); lsSet("lastPlace", JSON.stringify({ lat: la, lon: lo })); setLatIn(p.requested.lat.toFixed(2)); setLonIn(p.requested.lon.toFixed(2)); })
      .catch((e: Error) => { setPointErr(e.message); setPoint(null); })
      .finally(() => setPointLoading(false));
  }, [meta]);

  // After a run switch, refresh the selected place from the new run.
  useEffect(() => {
    if (meta && loc && point && point.run_id !== meta.run_id) choosePoint(loc.lat, loc.lon, false, placeLabel);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta?.run_id]);

  // Chance-of-rain table for the selected place (same ENS run as the probability map).
  useEffect(() => {
    setProbPoint(null);
    if (!point || !probMeta) return;
    let alive = true;
    fetchProbPoint(probMeta.run_id, point.requested.lat, point.requested.lon).then((p) => { if (alive) setProbPoint(p); }).catch(() => undefined);
    return () => { alive = false; };
  }, [point, probMeta]);

  // Same place in the previous run, for the run-to-run comparison.
  useEffect(() => {
    setPrev(null);
    if (!idle || !meta || !point || point.run_id !== meta.run_id) return;
    let live = true;
    fetchRuns().then(async ({ runs }) => {
      const older = runs.find((r) => r.issue_time_utc < meta.issue_time_utc);
      if (!older) return;
      const p = await fetchPoint(older.run_id, point.requested.lat, point.requested.lon, { light: true });
      if (live) setPrev({ point: p, issueIso: older.issue_time_utc });
    }).catch(() => undefined);
    return () => { live = false; };
  }, [meta, point, idle]);

  const copyLink = async () => {
    try { await navigator.clipboard.writeText(location.href); setCopied(true); window.setTimeout(() => setCopied(false), 2500); }
    catch { window.prompt("Copy this link", location.href); }
  };

  const useMyLocation = () => {
    if (!meta) return;
    if (!navigator.geolocation) { setNotice("Your browser does not support location lookup. Pick a place on the map or by name."); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude: la, longitude: lo } = pos.coords;
        const d = meta.domain;
        if (la >= d.lat_min && la <= d.lat_max && lo >= d.lon_min && lo <= d.lon_max) choosePoint(la, lo);
        else setNotice(`Your location is outside the forecast area (${d.lat_min}–${d.lat_max}°N, ${d.lon_min}–${d.lon_max}°E).`);
      },
      (err) => setNotice(err.code === 1 ? "Location permission was denied. You can still pick a place on the map or by name." : "Could not determine your location."),
      { timeout: 10_000, maximumAge: 60_000 },
    );
  };

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
  const lastStep = meta.steps_h[meta.steps_h.length - 1];
  // "Next h hours": a window total ending h hours from now (nearest model step; clamped to the run's end).
  const nextHours = (h: number) => {
    setVariable("precip"); setKind("window"); setWindowHours(h);
    setIndex(nearestIndex(meta.valid_times_utc, nowMs + h * HOUR));
  };
  const legendTitle = variable === "precip" && kind === "interval" ? `Precipitation in the ${durH || 3} h interval (mm of water)`
    : variable === "prob" ? `Chance that 24 h rain reaches ${threshold} mm (%) — ECMWF ensemble`
    : variable === "precip" && kind === "window" ? `Precipitation over the ${windowHours} h ending at the valid time (mm of water)` : scale.title;
  const fmtHover = (v: number) => (variable === "cloud" || variable === "prob" ? Math.round(v) : v.toFixed(1)) + " " + (mapData?.units ?? "");
  const probWin = variable === "prob" && probMeta ? nearestWindow(probMeta.windows, Date.parse(meta.valid_times_utc[safeIndex])) : null;

  // ---- real-time context (browser clock vs forecast timeline) ----
  const issueMs = Date.parse(meta.issue_time_utc);
  const ageMs = nowMs - issueMs;
  const stale = ageMs > STALE_H * HOUR;
  const nr = nextRun(issueMs, nowMs);
  const pubMs = meta.published_at_utc ? Date.parse(meta.published_at_utc) : null;
  const nowInfo = indexForNow(meta.valid_times_utc, nowMs, variable === "precip" && kind === "interval");
  const nowFrac = fracIndex(meta.valid_times_utc, nowMs);
  const validMs = Date.parse(validIso), startMs = Date.parse(startIso);
  const isInterval = variable === "precip" && kind === "interval";
  const isWindow = variable === "precip" && kind === "window";
  let when: { label: string; cls: string; title: string };
  if (variable === "prob" && probWin) {
    const ws = Date.parse(probWin.window.start_utc), we = Date.parse(probWin.window.end_utc);
    when = nowMs >= ws && nowMs < we ? { label: "Includes now", cls: "now", title: "The current time falls inside this 24 h window." }
      : we <= nowMs ? { label: "Past window", cls: "past", title: "A 24 h window that has already ended. It is still a forecast, not an observation." }
      : { label: "Future", cls: "future", title: "Forecast for a window that has not started yet." };
  } else if (isWindow && nowMs >= validMs - windowHours * HOUR && nowMs < validMs) when = { label: "Includes now", cls: "now", title: "The current time falls inside this window." };
  else if (isInterval && nowMs >= startMs && nowMs < validMs) when = { label: "Includes now", cls: "now", title: "The current time falls inside this interval." };
  else if (!isInterval && variable !== "precip" && Math.abs(validMs - nowMs) <= 1.5 * HOUR) when = { label: "≈ Now", cls: "now", title: "This step is the nearest model time to the current time." };
  else if (validMs <= nowMs) when = { label: "Past model step", cls: "past", title: "The model's value for a time that has already passed. It is a forecast value, not an observation." };
  else when = { label: "Future", cls: "future", title: "Forecast for a time that has not happened yet." };
  const days = dayShortcuts(meta.valid_times_utc, nowMs, zone, minIndex);
  const activeDay = localDate(validMs, zone);
  const preset = rainPreset(kind, windowHours);
  const backToMap = () => document.querySelector(".mapwrap")?.scrollIntoView({ behavior: "smooth", block: "start" });
  const lastCheckMs = status?.last_attempt_utc ? Date.parse(status.last_attempt_utc) : null;
  const live = !!status?.auto_refresh;
  const isStatic = status?.mode === "static";

  return (
    <div className="app">
      <a className="skip" href="#locations">Skip map, go to location chooser</a>
      <header>
        <div className="brand">
          <h1>India Weather Forecast</h1>
          <p className="muted">Rain, temperature, cloud and wind for the coming days. Tap the map to pick a place.</p>
        </div>
        <div className="hdr-tools">
          <button type="button" className="link" onClick={() => setZone(zone === "local" ? "utc" : "local")} aria-label={`Times are shown in ${zoneName(zone)}. Switch to ${zone === "local" ? "UTC" : "local time"}`}>
            🕒 {zoneName(zone)} ⇄
          </button>
          <button type="button" className="link" onClick={copyLink} aria-label="Copy a link to this exact view">🔗 {copied ? "Link copied" : "Copy link"}</button>
          <button type="button" className="link" onClick={() => setTheme(theme === "auto" ? "dark" : theme === "dark" ? "light" : "auto")} aria-label={`Theme: ${theme}. Click to change.`}>
            ◐ Theme: {theme}
          </button>
          <button type="button" className="link" onClick={() => setGuide(true)} aria-expanded={guide}>❓ How to use</button>
        </div>
      </header>

      {guide && (
        <section className="guide" aria-label="How to use this page">
          <strong>New here?</strong>
          <ol>
            <li><b>Pick a place:</b> tap the map or search a city.</li>
            <li><b>Pick a time:</b> use the day buttons or the slider under the map (<b>Now</b> jumps to the present).</li>
            <li><b>Pick what to see:</b> Rain, Temperature, Cloud, Wind or the chance of rain.</li>
          </ol>
          <p className="muted small">Everything shown is a computer-model forecast (ECMWF), not an observation or a warning.</p>
          <button type="button" className="primary" onClick={dismissGuide}>Got it</button>
        </section>
      )}

      <details className="statusline">
        <summary>
          <span className={`pill ${status?.refreshing ? "busy" : live ? "live" : "idle"}`} title={isStatic ? (live ? "Static site: a scheduled job republishes it when ECMWF releases a new run (checked about every 30 minutes); this page notices new data automatically." : "Static snapshot: the data does not change until the site is rebuilt.")
            : live ? "This server checks ECMWF for new model runs every 10 minutes." : "This server is not checking for new runs automatically."}>
            <span className="dot" aria-hidden="true" />{status?.refreshing ? "Checking for a new run…" : live ? (isStatic ? "Auto-published" : "Live updates on") : (isStatic ? "Static snapshot" : "Static data")}
          </span>
          <span className={`s-text ${stale ? "bad" : ""}`}>Forecast from {formatTime(meta.issue_time_utc, zone)} · {relTime(-ageMs).replace(" ago", "")} old{stale ? " · OUT OF DATE" : ""}</span>
          <span className="s-more">Details</span>
        </summary>
        <div className="livebar" aria-label="Forecast status details">
          {pubMs && <span className="chip" title="Time the run became available on the ECMWF server (Last-Modified header)."><b>Published</b> {formatTime(meta.published_at_utc!, zone, false)}{meta.availability_delay_h != null && ` (+${meta.availability_delay_h.toFixed(1)} h)`}</span>}
          <span className="chip" title={`Typical delay after issue time, measured from the last 9 runs: about 7.6 h for 00/12 UTC runs and 6.5 h for 06/18 UTC runs. Not guaranteed.`}>
            <b>Next run</b> {nr.overdue ? `expected ${relTime(nr.expectedMs - nowMs)} — later than usual` : `≈ ${formatTime(new Date(nr.expectedMs).toISOString(), zone, false)} (${relTime(nr.expectedMs - nowMs)})`}
          </span>
          {lastCheckMs && <span className="chip" title={isStatic ? "When the site files were generated." : undefined}><b>{isStatic ? "Site built" : "Last check"}</b> {relTime(lastCheckMs - nowMs)}</span>}
          <label className="chip auto"><input type="checkbox" checked={autoUpdate} onChange={(e) => setAutoUpdate(e.target.checked)} /> Switch to new forecasts automatically</label>
        </div>
      </details>

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
            <div className="seg" role="radiogroup" aria-label="What to show">
              {VARIABLES.map((v) => (
                <label key={v.id} className={variable === v.id ? "on" : ""}>
                  <input type="radio" name="variable" checked={variable === v.id} onChange={() => setVariable(v.id)} />
                  <span aria-hidden="true">{v.icon}</span> {v.label}
                </label>
              ))}
            </div>
            {variable === "precip" && (
              <div className="chips-row" role="group" aria-label="Which rain figure to show">
                <button type="button" className={`chipbtn ${preset === "next24" ? "on" : ""}`} aria-pressed={preset === "next24"} onClick={() => nextHours(24)}
                  title="Rain accumulated over the 24 hours from now">Next 24 h</button>
                <button type="button" className={`chipbtn ${preset === "next48" ? "on" : ""}`} aria-pressed={preset === "next48"} onClick={() => nextHours(48)} disabled={lastStep < 48}
                  title="Rain accumulated over the 48 hours from now">Next 48 h</button>
                <button type="button" className={`chipbtn ${preset === "steps" ? "on" : ""}`} aria-pressed={preset === "steps"} onClick={() => setKind("interval")}
                  title="Rain in each 3-hour step; move the time to see it change">Every 3 h</button>
                <button type="button" className={`chipbtn ${preset === "total" ? "on" : ""}`} aria-pressed={preset === "total"} onClick={() => setKind("cumulative")}
                  title="Rain added up since the forecast started">Total so far</button>
                {preset === "custom" && (
                  <label className="winsel">Window{" "}
                    <select value={windowHours} onChange={(e) => setWindowHours(Number(e.target.value))}>
                      {WINDOW_OPTIONS.filter((h) => h <= lastStep).map((h) => <option key={h} value={h}>{h} h</option>)}
                    </select></label>
                )}
              </div>
            )}
            {variable === "prob" && (
              <label className="winsel">Chance of at least{" "}
                <select value={threshold} onChange={(e) => setThreshold(Number(e.target.value))}>
                  {(probMeta?.thresholds_mm ?? PROB_THRESHOLDS).map((x) => <option key={x} value={x}>{x} mm of rain</option>)}
                </select></label>
            )}
          </div>
          <p className="readout" aria-live="polite">
            <span className={`when ${when.cls}`} title={when.title}>{when.label}</span>{" "}
            {variable === "precip"
              ? (kind === "window"
                ? <><strong>{windowHours} hours of rain</strong>, {formatTime(meta.valid_times_utc[Math.max(0, meta.steps_h.indexOf(step - windowHours))], zone)} → {formatTime(validIso, zone)}.</>
                : kind === "interval"
                ? <><strong>Rain in {durH} hours</strong>, {formatTime(startIso, zone, false)} → {formatTime(validIso, zone)}.</>
                : <><strong>Total rain so far</strong> (since {formatTime(meta.issue_time_utc, zone)}), up to {formatTime(validIso, zone)}.</>)
              : variable === "prob"
              ? (probWin && probMeta
                ? <>ECMWF ensemble: chance that rain reaches <strong>{threshold} mm</strong> in the <strong>24 hours</strong> from {formatTime(probWin.window.start_utc, zone)} to {formatTime(probWin.window.end_utc, zone)} (ensemble run issued {formatTime(probMeta.issue_time_utc, zone)}).
                  {!probWin.exact && <> Nearest available window to the selected time (windows end every 12 h; this one ends {Math.abs(probWin.offsetH).toFixed(1)} h {probWin.offsetH >= 0 ? "after" : "before"} it).</>}</>
                : <>Rain probabilities are not available: {probErr ?? "loading…"}</>)
              : <><strong>{vInfo.label} at {formatTime(validIso, zone)}</strong> <span className="muted">(the model's value at that moment)</span>.</>}
            {" "}<span className="muted">+{step} h.</span>
            {when.cls === "past" && <> <span className="muted">Model value for a time that has passed; not an observation.</span></>}
          </p>
          <div className="mapwrap">
            <Suspense fallback={<div className="map map-skeleton" aria-hidden="true" />}>
            <MapView view={mapView} meta={meta} data={mapData} variable={variable} scale={scale} smooth={smooth} basemap={basemap} dark={dark} marker={marker}
              onPick={choosePoint} onOutside={outside} onHover={setHover} onBasemapFailed={onBasemapFailed} />
            </Suspense>
            {mapLoading && <div className="overlay" role="status">Loading map…</div>}
            {mapErr && <div className="overlay err" role="alert">{mapErr} <button type="button" onClick={() => setRetry((r) => r + 1)}>Retry</button></div>}
            {hover && <div className="hover" aria-hidden="true">{hover.lat.toFixed(2)}°N {hover.lon.toFixed(2)}°E · {fmtHover(hover.value)} (grid cell)</div>}
            <Legend scale={scale} title={legendTitle}
              note={smooth ? "Display smoothed between 0.25° cells; the data are not finer than that." : "Raw 0.25° grid cells."} />
          </div>
          <div className="options">
            <span className="seg small" role="group" aria-label="Map view" title="World view shows the whole globe; the forecast data still covers India only (dashed box)">
              <label className={mapView === "india" ? "on" : ""}><input type="radio" name="mapview" checked={mapView === "india"} onChange={() => setMapView("india")} /> 🇮🇳 India</label>
              <label className={mapView === "world" ? "on" : ""}><input type="radio" name="mapview" checked={mapView === "world"} onChange={() => setMapView("world")} /> 🌍 World</label>
            </span>
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
            onNow={() => setIndex(Math.max(minIndex, nowInfo.index))} nowFrac={nowFrac} nowState={nowInfo.state} days={days} activeDay={activeDay} />
          {idle ? <>
            <Overview meta={meta} nowMs={nowMs} zone={zone} onPick={choosePoint} />
            <CityOverview meta={meta} nowMs={nowMs} zone={zone} onPick={choosePoint} />
          </> : <div className="panel-skeleton" aria-hidden="true" />}
        </div>

        <aside className="right">
          <form className="locform" id="locations" tabIndex={-1} onSubmit={(e) => { e.preventDefault(); const la = Number(latIn), lo = Number(lonIn); if (latIn.trim() === "" || lonIn.trim() === "" || !isFinite(la) || !isFinite(lo)) { setNotice("Enter numeric latitude and longitude."); return; } choosePoint(la, lo); }}>
            <fieldset>
              <legend>Choose a place</legend>
              <div className="citysearch">
                <PlaceSearch onPick={(pl) => choosePoint(pl.lat, pl.lon, true, pl.state ? `${pl.name}, ${pl.state}` : pl.name)} />
                <button type="button" onClick={useMyLocation} title="Uses your browser's location once; it is only used to look up the nearest forecast grid cell.">📍 Use my location</button>
              </div>
              <div className="presets">
                {PRESETS.map((p) => <button type="button" key={p.name} onClick={() => choosePoint(p.lat, p.lon)}>{p.name}</button>)}
              </div>
              <details className="coords-details">
                <summary>Enter coordinates</summary>
                <div className="coords">
                  <label>Latitude °N<input inputMode="decimal" value={latIn} onChange={(e) => setLatIn(e.target.value)} placeholder="e.g. 19.08" /></label>
                  <label>Longitude °E<input inputMode="decimal" value={lonIn} onChange={(e) => setLonIn(e.target.value)} placeholder="e.g. 72.88" /></label>
                  <button type="submit">Show</button>
                </div>
              </details>
            </fieldset>
            {notice && <p className="error" role="alert">{notice}</p>}
          </form>
          <div id="place-results">
            <LocationPanel meta={meta} point={point} loading={pointLoading} error={pointErr} index={safeIndex} zone={zone} onIndex={setIndex} nowFrac={nowFrac} prev={prev} prob={probPoint} probMeta={probMeta} selectedWindowEnd={probWin?.window.end_h ?? null} threshold={threshold}
              nowMs={nowMs} onBack={backToMap} onPickPreset={choosePoint} label={placeLabel} />
          </div>
        </aside>
      </main>

      <footer>
        <p><strong>Forecast data:</strong> Contains modified ECMWF Open Data (IFS HRES, 0.25°), licensed CC-BY-4.0. Run {meta.run_id} UTC, processed {formatTime(meta.processed_at_utc, zone)}.
          {" "}<strong>Basemap:</strong> © OpenStreetMap contributors, OpenMapTiles, served by OpenFreeMap; boundaries are as drawn by OpenStreetMap contributors.
          {" "}<strong>Place names:</strong> <a href="https://www.geonames.org/" target="_blank" rel="noreferrer">GeoNames</a> (CC-BY 4.0), towns of 1,000+ people.</p>
        <details>
          <summary>What this forecast can and cannot tell you</summary>
          <ul>
            <li><strong>"Live" means the newest published model run, not a nowcast.</strong> ECMWF issues a run every 6 hours and it appears several hours later, so even the newest run starts in the past. Times before "now" are model values, not observations.</li>
            <li>The map, charts and totals come from a <strong>single deterministic model run</strong>: no uncertainty is attached, and it can differ from later runs. The run comparison shows how much it changed, not how likely anything is. The separate <strong>Rain chance</strong> view shows <strong>ECMWF's own ensemble probabilities</strong> (from a different, 00/12 UTC-only forecast system, so its run can be older). This project does not compute any probability.</li>
            <li>Values are grid-cell values at 0.25° (~28 km). A selected place gets the <strong>nearest cell</strong>, not an interpolated or point value. The smooth map display is visual only.</li>
            <li>Rain totals are differences of the model's cumulative precipitation. Values are stored with limited precision, so amounts below about 0.25 mm are indistinguishable from zero and cumulative values may dip very slightly between steps.</li>
            <li>Temperature, cloud and wind are instantaneous values at the valid time. Wind is the 10 m wind; arrows show where the air moves toward. Cloud cover is stored coarsely (about 1 %).</li>
            <li className="shortcuts">Keyboard: <kbd>Space</kbd> play/pause, <kbd>←</kbd> <kbd>→</kbd> step time, <kbd>N</kbd> jump to now (when no control or the map has focus). Hover or tap a chart to read values.</li>
            <li>This is not observed weather, an official warning, or travel/safety advice. Use your national weather service for warnings.</li>
          </ul>
        </details>
      </footer>
    </div>
  );
}
