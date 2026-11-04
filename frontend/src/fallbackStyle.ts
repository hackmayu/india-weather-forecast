import type { StyleSpecification } from "maplibre-gl";

/**
 * Offline-safe base map used only when the hosted vector basemap cannot be loaded.
 * Country outlines come from the bundled world-atlas (Natural Earth) data and are loaded lazily so
 * they do not weigh on the normal page load.
 */
export async function fallbackStyle(): Promise<StyleSpecification> {
  const [{ feature, mesh }, topoMod] = await Promise.all([import("topojson-client"), import("world-atlas/countries-110m.json")]);
  const topo = (topoMod.default ?? topoMod) as unknown as import("topojson-specification").Topology;
  const land = feature(topo, topo.objects.countries as never) as unknown as GeoJSON.FeatureCollection;
  const borders = mesh(topo, topo.objects.countries as never, (a: unknown, b: unknown) => a !== b);
  return {
    version: 8,
    sources: {
      land: { type: "geojson", data: land },
      borders: { type: "geojson", data: { type: "Feature", properties: {}, geometry: borders } },
    },
    layers: [
      { id: "sea", type: "background", paint: { "background-color": "#dbe9f1" } },
      { id: "land", type: "fill", source: "land", paint: { "fill-color": "#f4f1ea" } },
      { id: "borders", type: "line", source: "borders", paint: { "line-color": "#6b6b6b", "line-width": 0.8 } },
    ],
  };
}
