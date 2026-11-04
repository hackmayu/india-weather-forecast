import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import { feature, mesh } from "topojson-client";
import type { Topology } from "topojson-specification";
import countriesTopo from "world-atlas/countries-50m.json";
import type { MapResp, RunMeta } from "./api";
import { COLORS, classOf, hexToRgb } from "./colors";

const CELL = 0.25; // source grid spacing; each value is drawn as a 0.25 deg cell (no smoothing)
const merc = (latDeg: number) => Math.log(Math.tan(Math.PI / 4 + (latDeg * Math.PI) / 360));

/** Paint the grid into a canvas in Web-Mercator row spacing so it lines up with the base map. */
export function renderGrid(data: MapResp, thresholds: number[]): { url: string; coordinates: [number, number][] } {
  const nlat = data.lats.length, nlon = data.lons.length;
  const latTop = data.lats[0] + CELL / 2, latBot = data.lats[nlat - 1] - CELL / 2;
  const lonL = data.lons[0] - CELL / 2, lonR = data.lons[nlon - 1] + CELL / 2;
  const W = nlon * 4;
  const xSpan = ((lonR - lonL) * Math.PI) / 180;
  const ySpan = merc(latTop) - merc(latBot);
  const H = Math.round((W * ySpan) / xSpan);
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(W, H);
  const rgb = COLORS.map(hexToRgb);
  for (let py = 0; py < H; py++) {
    const m = merc(latTop) - ((py + 0.5) / H) * ySpan;
    const lat = (2 * Math.atan(Math.exp(m)) - Math.PI / 2) * (180 / Math.PI);
    const row = Math.min(nlat - 1, Math.max(0, Math.floor((data.lats[0] + CELL / 2 - lat) / CELL)));
    for (let px = 0; px < W; px++) {
      const col = Math.min(nlon - 1, Math.floor((px / W) * nlon));
      const c = classOf(data.values[row][col], thresholds);
      if (c < 0) continue;
      const o = (py * W + px) * 4;
      img.data[o] = rgb[c][0]; img.data[o + 1] = rgb[c][1]; img.data[o + 2] = rgb[c][2]; img.data[o + 3] = 235;
    }
  }
  ctx.putImageData(img, 0, 0);
  return {
    url: canvas.toDataURL("image/png"),
    coordinates: [[lonL, latTop], [lonR, latTop], [lonR, latBot], [lonL, latBot]],
  };
}

interface Props {
  meta: RunMeta;
  data: MapResp | null;
  thresholds: number[];
  marker: { lat: number; lon: number } | null;
  onPick: (lat: number, lon: number) => void;
  onOutside: (lat: number, lon: number) => void;
  onHover: (info: { lat: number; lon: number; value: number } | null) => void;
}

export default function MapView({ meta, data, thresholds, marker, onPick, onOutside, onHover }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const mk = useRef<maplibregl.Marker | null>(null);
  const ready = useRef(false);
  const latest = useRef({ data, thresholds, onPick, onOutside, onHover, meta });
  latest.current = { data, thresholds, onPick, onOutside, onHover, meta };

  const paint = () => {
    const { data: d, thresholds: t } = latest.current;
    const m = map.current;
    if (!m || !ready.current || !d) return;
    const { url, coordinates } = renderGrid(d, t);
    const src = m.getSource("precip") as maplibregl.ImageSource | undefined;
    if (src) src.updateImage({ url, coordinates: coordinates as [[number, number], [number, number], [number, number], [number, number]] });
    else {
      m.addSource("precip", { type: "image", url, coordinates: coordinates as [[number, number], [number, number], [number, number], [number, number]] });
      m.addLayer({ id: "precip", type: "raster", source: "precip", paint: { "raster-resampling": "nearest", "raster-fade-duration": 0 } }, "borders");
    }
  };

  useEffect(() => {
    if (!box.current) return;
    const topo = countriesTopo as unknown as Topology;
    const land = feature(topo, topo.objects.countries as never) as unknown as GeoJSON.FeatureCollection;
    const borders = mesh(topo, topo.objects.countries as never, (a: unknown, b: unknown) => a !== b);
    const d = latest.current.meta.domain;
    const m = new maplibregl.Map({
      container: box.current,
      style: { version: 8, sources: {}, layers: [{ id: "sea", type: "background", paint: { "background-color": "#dbe9f1" } }] },
      bounds: [[d.lon_min - 2, d.lat_min - 2], [d.lon_max + 2, d.lat_max + 2]],
      maxBounds: [[d.lon_min - 25, d.lat_min - 20], [d.lon_max + 25, d.lat_max + 20]],
      attributionControl: false, dragRotate: false, pitchWithRotate: false, touchPitch: false,
    });
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    m.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: "Boundaries: Natural Earth via world-atlas" }));
    m.on("load", () => {
      m.addSource("land", { type: "geojson", data: land });
      m.addSource("borders", { type: "geojson", data: { type: "Feature", properties: {}, geometry: borders } });
      m.addLayer({ id: "land", type: "fill", source: "land", paint: { "fill-color": "#f4f1ea" } });
      m.addLayer({ id: "borders", type: "line", source: "borders", paint: { "line-color": "#6b6b6b", "line-width": 0.8 } });
      // Domain outline: shows exactly where forecast data exists.
      m.addSource("domain", { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "LineString",
        coordinates: [[d.lon_min, d.lat_min], [d.lon_max, d.lat_min], [d.lon_max, d.lat_max], [d.lon_min, d.lat_max], [d.lon_min, d.lat_min]] } } });
      m.addLayer({ id: "domain", type: "line", source: "domain", paint: { "line-color": "#1f2937", "line-width": 1.2, "line-dasharray": [3, 2] } });
      ready.current = true;
      paint();
    });
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
    m.on("error", (e) => console.error("maplibre error", e.error?.message ?? e));
    return () => { m.remove(); map.current = null; ready.current = false; };
  }, []);

  useEffect(paint, [data, thresholds]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    if (!marker) { mk.current?.remove(); mk.current = null; return; }
    if (!mk.current) mk.current = new maplibregl.Marker({ color: "#c2410c" }).setLngLat([marker.lon, marker.lat]).addTo(m);
    else mk.current.setLngLat([marker.lon, marker.lat]);
  }, [marker]);

  return <div ref={box} className="map" role="application" aria-label="Precipitation map of India. Click to select a location, or use the location controls." />;
}
