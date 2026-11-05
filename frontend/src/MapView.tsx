import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import type { MapResp, RunMeta, VariableId } from "./api";
import type { Scale } from "./colors";
import { fallbackStyle } from "./fallbackStyle";
import { arrowStride, cellOf, rasterize, rasterToBlob, windArrows } from "./render";
import { loadPlaces } from "./PlaceSearch";
import { WORLD_CITIES } from "./worldCities";

const CELL = 0.25;
// Hosted vector basemaps from OpenFreeMap (no key, no cookies; OSM data, attribution shown on the map).
export const BASEMAPS = {
  light: "https://tiles.openfreemap.org/styles/positron",
  detailed: "https://tiles.openfreemap.org/styles/liberty",
  dark: "https://tiles.openfreemap.org/styles/dark",
} as const;
export type Basemap = "light" | "detailed";
/** In dark theme the light basemap is swapped for the dark one; "detailed" stays as chosen. */
export const styleUrl = (basemap: Basemap, dark: boolean) => (dark && basemap === "light" ? BASEMAPS.dark : BASEMAPS[basemap]);

type Quad = [[number, number], [number, number], [number, number], [number, number]];
const BLANK = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
// Respect the user's reduced-motion preference: no cross-fade, just an instant swap.
const FADE_MS = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 350;

export interface Hover { lat: number; lon: number; value: number }

interface Props {
  meta: RunMeta;
  data: MapResp | null;
  variable: VariableId;
  scale: Scale;
  smooth: boolean;
  basemap: Basemap;
  dark: boolean;
  marker: { lat: number; lon: number } | null;
  onPick: (lat: number, lon: number) => void;
  onOutside: (lat: number, lon: number) => void;
  onHover: (h: Hover | null) => void;
  onBasemapFailed: () => void;
  view?: "india" | "world";   // world = zoom out to the whole globe (the forecast overlay still covers India only)
}

interface LabelPlace { name: string; lat: number; lon: number; z: number; rank: number }
/** Forecast numbers printed next to place names. A value is the model's value for the grid cell that contains the place. */
function labelFeatures(d: MapResp, india: LabelPlace[]): GeoJSON.FeatureCollection {
  const cell = cellOf(d), world = cell >= 0.5;
  const list: LabelPlace[] = world ? WORLD_CITIES.map((c, i) => ({ ...c, rank: i, z: i < 16 ? 0 : i < 40 ? 1.8 : 2.8 })) : india;
  const features: GeoJSON.Feature[] = [];
  for (const p of list) {
    const iy = Math.round((d.lats[0] - p.lat) / cell), ix = Math.round((p.lon - d.lons[0]) / cell);
    const v = d.values[iy]?.[ix];
    if (v === undefined || !Number.isFinite(v)) continue;
    const num = d.units === "°C" ? `${Math.round(v)}°` : d.units === "%" ? `${Math.round(v)}%` : d.units === "mm" ? (v < 0.05 ? "0 mm" : `${v.toFixed(1)} mm`) : `${v.toFixed(1)} m/s`;
    features.push({ type: "Feature", properties: { text: `${p.name}\n${num}`, z: p.z, rank: p.rank }, geometry: { type: "Point", coordinates: [p.lon, p.lat] } });
  }
  return { type: "FeatureCollection", features };
}

export default function MapView(props: Props) {
  const { data, scale, smooth, basemap, dark, marker } = props;
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const mk = useRef<maplibregl.Marker | null>(null);
  const ready = useRef(false);
  const active = useRef<"A" | "B">("B");
  const latest = useRef(props);
  latest.current = props;
  const firstStyle = useRef(true);

  const indiaLabels = useRef<LabelPlace[]>([]);   // biggest ~450 Indian towns, loaded after the page settles
  const paintSeq = useRef(0);                         // a newer paint supersedes an older one still encoding
  const blobUrls = useRef<{ A?: string; B?: string }>({});

  const paint = () => {
    const m = map.current;
    const { data: d, scale: sc, smooth: sm } = latest.current;
    if (!m || !ready.current || !d) return;
    const seq = ++paintSeq.current;
    const raster = rasterize(d, sc, sm);
    (m.getSource("labels") as maplibregl.GeoJSONSource | undefined)?.setData(labelFeatures(d, indiaLabels.current));
    const wind = m.getSource("wind") as maplibregl.GeoJSONSource | undefined;
    wind?.setData(latest.current.variable === "wind" ? windArrows(d, arrowStride(cellOf(d))) : { type: "FeatureCollection", features: [] });
    rasterToBlob(raster).then((blob) => {
      const mm = map.current;
      if (seq !== paintSeq.current || !mm) return;     // superseded (e.g. the slider moved on) or unmounted
      const next = active.current === "A" ? "B" : "A";
      const prev = active.current;
      const nextSrc = mm.getSource(`field${next}`) as maplibregl.ImageSource | undefined;
      if (!nextSrc) return;
      const url = URL.createObjectURL(blob);
      const old = blobUrls.current[next];
      blobUrls.current[next] = url;
      nextSrc.updateImage({ url, coordinates: raster.coordinates as Quad });
      if (old) window.setTimeout(() => URL.revokeObjectURL(old), 3000);
      let flipped = false;
      const flip = () => {
        if (flipped || !map.current) return;
        flipped = true;
        // Cross-fade between the two image layers; this blends the DISPLAY only, no intermediate data is invented.
        mm.setPaintProperty(`field${next}`, "raster-opacity", 1);
        mm.setPaintProperty(`field${prev}`, "raster-opacity", 0);
        active.current = next;
      };
      mm.once("idle", flip);
      window.setTimeout(flip, 250);
    }).catch((e) => console.error("map paint failed", e));
  };

  const install = (m: maplibregl.Map) => {
    const dm = latest.current.meta.domain;
    const quad: Quad = [[dm.lon_min, dm.lat_max], [dm.lon_max, dm.lat_max], [dm.lon_max, dm.lat_min], [dm.lon_min, dm.lat_min]];
    const firstSymbol = m.getStyle().layers.find((l) => l.type === "symbol")?.id; // keep place labels above the data
    for (const id of ["A", "B"]) {
      m.addSource(`field${id}`, { type: "image", url: BLANK, coordinates: quad });
      m.addLayer({ id: `field${id}`, type: "raster", source: `field${id}`,
        paint: { "raster-resampling": "nearest", "raster-fade-duration": 0, "raster-opacity": 0 } }, firstSymbol);
      m.setPaintProperty(`field${id}`, "raster-opacity-transition", { duration: FADE_MS, delay: 0 });
    }
    m.addSource("wind", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    m.addLayer({ id: "wind", type: "line", source: "wind", layout: { "line-cap": "round" },
      paint: { "line-color": "#111827", "line-width": 1.6, "line-opacity": 0.9 } }, firstSymbol);
    m.addSource("domain", { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "LineString",
      coordinates: [[dm.lon_min, dm.lat_min], [dm.lon_max, dm.lat_min], [dm.lon_max, dm.lat_max], [dm.lon_min, dm.lat_max], [dm.lon_min, dm.lat_min]] } } });
    m.addLayer({ id: "domain", type: "line", source: "domain", paint: { "line-color": "#1f2937", "line-width": 1.2, "line-dasharray": [3, 2] } });
    if (m.getStyle().glyphs) {   // the bundled offline fallback style has no fonts, so no number labels there
      m.addSource("labels", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      m.addLayer({ id: "labels", type: "symbol", source: "labels", filter: ["<=", ["get", "z"], ["zoom"]],
        layout: { "text-field": ["get", "text"], "text-font": ["Noto Sans Bold"], "text-size": 11, "text-anchor": "center", "symbol-sort-key": ["get", "rank"], "text-padding": 3 },
        paint: { "text-color": "#111827", "text-halo-color": "rgba(255,255,255,0.92)", "text-halo-width": 1.6 } });
    }
    active.current = "B"; // first paint goes into A
    ready.current = true;
    paint();
  };

  useEffect(() => {
    if (!box.current) return;
    const d = latest.current.meta.domain;
    const m = new maplibregl.Map({
      container: box.current,
      // ?offline simulates an unreachable hosted basemap (used to test the fallback path).
      style: location.search.includes("offline") ? "https://offline.invalid/style.json" : styleUrl(latest.current.basemap, latest.current.dark),
      bounds: [[d.lon_min - 0.5, d.lat_min - 0.5], [d.lon_max + 0.5, d.lat_max + 0.5]],
      minZoom: 0.6, renderWorldCopies: false,
      attributionControl: false, dragRotate: false, pitchWithRotate: false, touchPitch: false,
    });
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    m.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");
    m.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: "Forecast: ECMWF Open Data (IFS), CC-BY-4.0" }), "bottom-right");

    let styleOk = false;
    m.on("style.load", () => { styleOk = true; ready.current = false; install(m); });
    // If the hosted basemap cannot be reached, switch to the bundled outline map instead of showing nothing.
    const bail = async () => {
      if (styleOk || !map.current) return;
      latest.current.onBasemapFailed();
      m.setStyle(await fallbackStyle());
    };
    const timer = window.setTimeout(bail, 9000);
    m.on("error", (e) => { if (!styleOk && /fetch|load|network|style/i.test(String(e.error?.message ?? ""))) void bail(); });

    m.on("click", (e) => {
      const { lat, lng } = e.lngLat;
      const dm = latest.current.meta.domain;
      if (lat >= dm.lat_min && lat <= dm.lat_max && lng >= dm.lon_min && lng <= dm.lon_max) latest.current.onPick(lat, lng);
      else latest.current.onOutside(lat, lng);
    });
    m.on("mousemove", (e) => {
      const dd = latest.current.data;
      if (!dd) return;
      const row = Math.floor((dd.lats[0] + CELL / 2 - e.lngLat.lat) / CELL);
      const col = Math.floor((e.lngLat.lng - (dd.lons[0] - CELL / 2)) / CELL);
      if (row < 0 || col < 0 || row >= dd.lats.length || col >= dd.lons.length) return latest.current.onHover(null);
      latest.current.onHover({ lat: dd.lats[row], lon: dd.lons[col], value: dd.values[row][col] });
    });
    m.on("mouseout", () => latest.current.onHover(null));
    map.current = m;
    if (location.search.includes("debug")) (window as unknown as { __map: unknown }).__map = m; // inspection hook, opt-in only
    return () => { window.clearTimeout(timer); m.remove(); map.current = null; ready.current = false; mk.current = null; };
  }, []);

  useEffect(() => {
    let live = true;
    const id = window.setTimeout(() => void loadPlaces().then((ps) => {
      if (!live) return;
      const dm = latest.current.meta.domain;
      indiaLabels.current = ps.filter((p) => p.lat >= dm.lat_min && p.lat <= dm.lat_max && p.lon >= dm.lon_min && p.lon <= dm.lon_max).slice(0, 450)
        .map((p, i) => ({ name: p.name, lat: p.lat, lon: p.lon, rank: i, z: i < 12 ? 3.4 : i < 50 ? 4.4 : i < 160 ? 5.4 : 6.4 }));
      paint();
    }), 1500);
    return () => { live = false; window.clearTimeout(id); };
  }, []);

  useEffect(paint, [data, scale, smooth]);

  const viewInit = useRef(true);
  useEffect(() => {
    if (viewInit.current) { viewInit.current = false; return; }
    const m = map.current; if (!m) return;
    const d = latest.current.meta.domain;
    const calm = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (props.view === "world") m.easeTo({ center: [30, 18], zoom: Math.max(0.6, Math.log2(m.getContainer().clientWidth / 512) + 0.15), duration: calm ? 0 : 900 });
    else m.fitBounds([[d.lon_min - 0.5, d.lat_min - 0.5], [d.lon_max + 0.5, d.lat_max + 0.5]], { duration: calm ? 0 : 900 });
  }, [props.view]);

  useEffect(() => {
    if (firstStyle.current) { firstStyle.current = false; return; }
    map.current?.setStyle(styleUrl(basemap, dark)); // 'style.load' re-installs our layers
  }, [basemap, dark]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    if (!marker) { mk.current?.remove(); mk.current = null; return; }
    if (!mk.current) mk.current = new maplibregl.Marker({ color: "#c2410c" }).setLngLat([marker.lon, marker.lat]).addTo(m);
    else mk.current.setLngLat([marker.lon, marker.lat]);
    const d = latest.current.meta.domain;      // a place outside India: bring it into view
    if (marker.lat < d.lat_min || marker.lat > d.lat_max || marker.lon < d.lon_min || marker.lon > d.lon_max) {
      const calm = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
      m.easeTo({ center: [marker.lon, marker.lat], zoom: Math.max(m.getZoom(), 3.2), duration: calm ? 0 : 900 });
    }
  }, [marker]);

  return <div ref={box} className="map" role="application" aria-label="Weather map of India. Click to select a location, or use the location controls." />;
}
