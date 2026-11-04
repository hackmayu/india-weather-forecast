import type { Kind, VariableId } from "./api";
import type { Zone } from "./time";

// Shareable view state kept in the query string (not the hash: #locations is the skip-link target).
// Only user-chosen view state is stored; display preferences such as theme/basemap stay per-browser.
export interface UrlState { v?: VariableId; k?: Kind; h?: number; p?: number; t?: string; lat?: number; lon?: number; z?: Zone }

const VARS = ["precip", "temp", "cloud", "wind", "prob"];
const PROB_THRESHOLDS = [1, 5, 10, 25, 50, 100];
const KINDS = ["interval", "cumulative", "window"];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const KEYS = ["v", "k", "h", "p", "t", "lat", "lon", "z"];

/** Strictly validated: anything unexpected is ignored, never trusted. */
export function parseUrl(search: string): UrlState {
  const q = new URLSearchParams(search);
  const out: UrlState = {};
  const v = q.get("v"), k = q.get("k"), t = q.get("t"), z = q.get("z");
  if (v && VARS.includes(v)) out.v = v as VariableId;
  if (k && KINDS.includes(k)) out.k = k as Kind;
  const h = Number(q.get("h"));
  if (q.get("h") && Number.isInteger(h) && h >= 3 && h <= 144 && h % 3 === 0) out.h = h;
  const p = Number(q.get("p"));
  if (q.get("p") && PROB_THRESHOLDS.includes(p)) out.p = p;
  if (t && ISO.test(t) && !Number.isNaN(Date.parse(t))) out.t = t;
  if (z === "utc" || z === "local") out.z = z;
  const rawLat = q.get("lat"), rawLon = q.get("lon");
  if (rawLat && rawLon) {
    const lat = Number(rawLat), lon = Number(rawLon);
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) { out.lat = lat; out.lon = lon; }
  }
  return out;
}

/** Merge state into an existing query string, preserving unrelated params (e.g. debug). */
export function buildSearch(current: string, s: UrlState): string {
  const q = new URLSearchParams(current);
  for (const key of KEYS) q.delete(key);
  if (s.v && s.v !== "precip") q.set("v", s.v);
  if (s.k && s.k !== "interval") q.set("k", s.k);
  if (s.k === "window" && s.h) q.set("h", String(s.h));
  if (s.v === "prob" && s.p) q.set("p", String(s.p));
  if (s.t) q.set("t", s.t);
  if (s.lat !== undefined && s.lon !== undefined) { q.set("lat", s.lat.toFixed(4)); q.set("lon", s.lon.toFixed(4)); }
  if (s.z === "utc") q.set("z", "utc");
  const str = q.toString();
  return str ? `?${str}` : "";
}
