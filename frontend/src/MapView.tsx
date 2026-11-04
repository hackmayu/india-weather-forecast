import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import type { MapResp, RunMeta, VariableId } from "./api";
import type { Scale } from "./colors";
import { fallbackStyle } from "./fallbackStyle";
import { renderGrid, windArrows } from "./render";

const CELL = 0.25;
// Hosted vector basemaps from OpenFreeMap (no key, no cookies; OSM data, attribution shown on the map).
export const BASEMAPS = {
  light: "https://tiles.openfreemap.org/styles/positron",
  detailed: "https://tiles.openfreemap.org/styles/liberty",
} as const;
export type Basemap = keyof typeof BASEMAPS;

type Quad = [[number, number], [number, number], [number, number], [number, number]];
const BLANK = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
const FADE_MS = 350;

export interface Hover { lat: number; lon: number; value: number }

interface Props {
  meta: RunMeta;
  data: MapResp | null;
  variable: VariableId;
  scale: Scale;
  smooth: boolean;
  basemap: Basemap;
  marker: { lat: number; lon: number } | null;
  onPick: (lat: number, lon: number) => void;
  onOutside: (lat: number, lon: number) => void;
  onHover: (h: Hover | null) => void;
  onBasemapFailed: () => void;
}

export default function MapView(props: Props) {
  const { data, scale, smooth, basemap, marker } = props;
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const mk = useRef<maplibregl.Marker | null>(null);
  const ready = useRef(false);
  const active = useRef<"A" | "B">("B");
  const latest = useRef(props);
  latest.current = props;
  const firstStyle = useRef(true);

  const paint = () => {
    const m = map.current;
    const { data: d, scale: sc, smooth: sm } = latest.current;
    if (!m || !ready.current || !d) return;
    const { url, coordinates } = renderGrid(d, sc, sm);
    const next = active.current === "A" ? "B" : "A";
    const nextSrc = m.getSource(`field${next}`) as maplibregl.ImageSource | undefined;
    const prev = active.current;
    if (!nextSrc) return;
    nextSrc.updateImage({ url, coordinates: coordinates as Quad });
    let flipped = false;
    const flip = () => {
      if (flipped || !map.current) return;
      flipped = true;
      // Cross-fade between the two image layers; this blends the DISPLAY only, no intermediate data is invented.
      m.setPaintProperty(`field${next}`, "raster-opacity", 1);
      m.setPaintProperty(`field${prev}`, "raster-opacity", 0);
      active.current = next;
    };
    m.once("idle", flip);
    window.setTimeout(flip, 250);
    const wind = m.getSource("wind") as maplibregl.GeoJSONSource | undefined;
    wind?.setData(latest.current.variable === "wind" ? windArrows(d) : { type: "FeatureCollection", features: [] });
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
      style: location.search.includes("offline") ? "https://offline.invalid/style.json" : BASEMAPS[latest.current.basemap],
      bounds: [[d.lon_min - 2, d.lat_min - 2], [d.lon_max + 2, d.lat_max + 2]],
      maxBounds: [[d.lon_min - 25, d.lat_min - 20], [d.lon_max + 25, d.lat_max + 20]],
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

  useEffect(paint, [data, scale, smooth]);

  useEffect(() => {
    if (firstStyle.current) { firstStyle.current = false; return; }
    map.current?.setStyle(BASEMAPS[basemap]); // 'style.load' re-installs our layers
  }, [basemap]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    if (!marker) { mk.current?.remove(); mk.current = null; return; }
    if (!mk.current) mk.current = new maplibregl.Marker({ color: "#c2410c" }).setLngLat([marker.lon, marker.lat]).addTo(m);
    else mk.current.setLngLat([marker.lon, marker.lat]);
  }, [marker]);

  return <div ref={box} className="map" role="application" aria-label="Weather map of India. Click to select a location, or use the location controls." />;
}
